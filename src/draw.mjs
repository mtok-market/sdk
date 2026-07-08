import crypto from 'node:crypto';
import { DRAW_STATUS, meterUsd, PINNED_FEE_ADDRESSES, round6Usd, usdToAtomic } from './protocol.mjs';
import { DEFAULT_FEE_BPS, MIN_DRAW_USD, RECOMMENDED_FIRST_DRAW_USD } from './constants.mjs';

const hash32 = (v) => '0x' + crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');
const contractBookingId = () => 'bkgc_' + crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9_-]/g, '');

export async function drawFromSeller(client, {
  offer,
  totalNeedUsd,
  sellerId,
  bookingId,
  request,
  requests,
  relayFetch,
  feeBps = DEFAULT_FEE_BPS,
} = {}) {
  const _relayFetch = relayFetch ?? client.relayFetch ?? (async (params) => {
    const url = offer.relayEndpoint.replace(/\/$/, '') + '/chunk';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    return r.json();
  });

  const _api = client._stubApi ?? {
    reputation: async (sid) => {
      const r = await client._req('GET', `/agents/${encodeURIComponent(sid)}/reputation`);
      if (r.status !== 200) throw new Error('reputation lookup failed: ' + JSON.stringify(r.body));
      return r.body.reputation ?? r.body;
    },
    config: async () => {
      const r = await client._req('GET', '/config', null, false);
      if (r.status !== 200) throw new Error('config fetch failed: ' + JSON.stringify(r.body));
      return r.body;
    },
  };

  const reqList = Array.isArray(requests) && requests.length ? requests : [request ?? null];

  // #580: bid() returns routes shaped {offerId, ...} with NO `id` and NO `model`; book()
  // and the internal buy()/watchAndFill callers pass {id, model, ...}. Normalize both here
  // so the payDraw struct always carries a real offerId + model. Without this the struct
  // gets offerId=""/model="" (viem encodes undefined strings as ""), payDraw SUCCEEDS on
  // chain (real USDC leaves the wallet) and the relay can then only reject the blank draw.
  // The model on a route is the model the buyer bid for, i.e. the request's model.
  const _offerId = offer?.offerId ?? offer?.id;
  const _model = offer?.model ?? reqList.find((r) => r?.model)?.model;
  if (!_offerId) throw new Error('drawFromSeller: offer has no offerId/id; pass a route from bid() or an offer from book()');
  if (!_model) throw new Error('drawFromSeller: offer has no model and no request names one; refusing to pay a blank-model draw');
  offer = { ...offer, id: _offerId, offerId: _offerId, model: _model };

  const rep = await _api.reputation(sellerId);
  const recommendedMaxChunkUsd = Number(rep.recommendedMaxChunkUsd ?? RECOMMENDED_FIRST_DRAW_USD);
  const config = await _api.config();

  const pinnedFee = PINNED_FEE_ADDRESSES[client.chainId];
  if (pinnedFee && String(config.feeAddress || '').toLowerCase() !== pinnedFee.toLowerCase()) {
    throw new Error(`fee_address_mismatch: /api/config returned ${config.feeAddress} for chain ${client.chainId} but the pinned platform fee address is ${pinnedFee}. Refusing to pay a possibly-tampered fee address.`);
  }
  const feeRateBps = Number(config.feeBps ?? feeBps) || 0;
  const dripContractAddress = config.dripContractAddress || null;
  if (!dripContractAddress) {
    throw new Error('drawFromSeller: this market is contract-only; no dripContractAddress in /config. The legacy direct-transfer draw lane has been removed (mtok-market#487).');
  }
  const _payDraw = client.payDraw ?? client._payDraw?.bind(client);
  const _drawIdFor = client.drawIdFor ?? client._drawIdFor?.bind(client);
  const _affirmDraw = client.affirmDraw ?? client._affirmDraw?.bind(client);
  const _disputeDraw = client.disputeDraw ?? client._disputeDraw?.bind(client);
  const _drawStatus = client.drawStatus ?? client._drawStatus?.bind(client);
  const _ensureAgentBound = client.pub ? client.ensureAgentBound?.bind(client) : null;

  const outPrice = Number(offer.outputPricePerMTok) || 0;
  const estimateCost = (r) => {
    const maxOut = Number(r?.max_tokens) || 0;
    if (outPrice > 0 && maxOut > 0) return (maxOut / 1e6) * outPrice;
    return 0;
  };

  let remainingBudget = totalNeedUsd;
  let remainingUsd = 0;
  let drawN = 0;
  let fundedUsd = 0;
  let drawnUsd = 0;
  const chunks = [];
  const outputParts = [];
  let activeBookingId = bookingId ?? null;
  let checkedContractBinding = false;

  for (const reqItem of reqList) {
    const est = estimateCost(reqItem);

    if (!_payDraw || !_drawIdFor || !_affirmDraw || !_disputeDraw) throw new Error('drawFromSeller: contract mode requires payDraw/drawIdFor/affirmDraw/disputeDraw support');
    if (!checkedContractBinding && _ensureAgentBound) {
      await _ensureAgentBound({ contractAddress: dripContractAddress });
      checkedContractBinding = true;
    }
    activeBookingId = activeBookingId ?? contractBookingId();
    const recommendedCapUsd = Number.isFinite(recommendedMaxChunkUsd) && recommendedMaxChunkUsd > 0
      ? recommendedMaxChunkUsd
      : RECOMMENDED_FIRST_DRAW_USD;
    const drawCapUsd = Math.min(Number(remainingBudget) || 0, recommendedCapUsd);
    if (drawCapUsd < MIN_DRAW_USD) break;
    const defaultProbeUsd = Math.min(RECOMMENDED_FIRST_DRAW_USD, drawCapUsd);
    const estimatedUsd = est > 0 ? Math.min(est, drawCapUsd) : 0;
    const targetUsd = Math.max(MIN_DRAW_USD, defaultProbeUsd, estimatedUsd);
    const chunkUsd = round6Usd(Math.min(drawCapUsd, targetUsd));
    if (chunkUsd < MIN_DRAW_USD) break;
    const sellerUsdAtomic = usdToAtomic(chunkUsd);
    // #9: the platform/relay floor rounds the fee UP -- ceil via the +5000
    // (=10000/2) round-half-up on integer division, exactly
    // packages/relay/lib.mjs configuredFeeAtomic. The old path computed
    // configuredFeeUsd (round6Usd, then usdToAtomic) which TRUNCATED and, for
    // ~13k sub-cent atomic amounts, paid exactly 1 atomic short => the relay
    // rejected fee_amount_too_low AFTER we already paid on-chain. Compute the
    // fee atomic with the SAME ceil expression so the SDK never under-pays the
    // floor. (feeAddress unset / bps<=0 => no fee, matching configuredFeeUsd.)
    const feeUsdAtomic = (config.feeAddress && feeRateBps > 0)
      ? (sellerUsdAtomic * BigInt(Math.trunc(feeRateBps)) + 5000n) / 10000n
      : 0n;
    const usagePrice = (v) => usdToAtomic(v ?? 0);
    // #545 + #(codex review): pin the seller wallet we intend to pay (the offer's advertised
    // settlement wallet), so payDraw reverts SellerMismatch if a registrar rebound the seller's
    // agent-id to a different wallet between this offer and our pay. THROW on a present-but-
    // malformed settlementPubkey rather than silently zero-pinning (which would drop the
    // redirect protection without any signal). An absent wallet zero-skips explicitly.
    const isEvmAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? '');
    const settle = offer.settlementPubkey;
    if (settle != null && settle !== '' && !isEvmAddr(settle)) {
      throw new Error(`drawFromSeller: offer ${offer.id} has a malformed settlementPubkey (${JSON.stringify(settle)}); refusing to pay because the seller wallet cannot be pinned`);
    }
    const expectedSeller = isEvmAddr(settle) ? settle : '0x0000000000000000000000000000000000000000';
    const payment = {
      buyerAgentId: client.agentId,
      sellerAgentId: sellerId,
      bookingId: activeBookingId,
      offerId: offer.id,
      model: offer.model,
      n: drawN,
      sellerUsdAtomic,
      feeUsdAtomic,
      inputPricePerMTokAtomic: usagePrice(offer.inputPricePerMTok),
      outputPricePerMTokAtomic: usagePrice(offer.outputPricePerMTok),
      requestHash: hash32(reqItem),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      expectedSeller,
    };

    let drawPaidTxHash, drawId, completion, drawError, replayed = false, priorStatus;
    try {
      drawId = await _drawIdFor(dripContractAddress, payment);
      // Double-spend protection lives ON-CHAIN: payDraw reverts with DrawAlreadyExists once a
      // draw for this bookingId+n exists, so money physically cannot move twice. We do NOT read
      // status before paying — that would cost an extra RPC on every happy-path draw. Pay
      // directly; the revert is the guard.
      //
      // The recovery below is ADVISORY convenience only (mtok-market#128): if a prior attempt
      // paid but stranded before we recorded the hash, the retry's payDraw reverts DrawAlreadyExists.
      // Rather than surface a raw failed transaction, we read status to confirm the draw really
      // exists and hand the agent a clean `replay: true` signal. An agent rolling their own buyer
      // can skip all of this and just rely on the on-chain revert. See packages/api/src/core/guides.js
      // for the fuller rationale.
      try {
        drawPaidTxHash = await _payDraw(dripContractAddress, payment);
      } catch (payErr) {
        if (_drawStatus && /DrawAlreadyExists|already exists/i.test(payErr?.message ?? '')) {
          priorStatus = await _drawStatus(dripContractAddress, drawId);
          // Status None means the revert was NOT actually a replay — a real failure. Rethrow.
          if (priorStatus === DRAW_STATUS.None) throw payErr;
          replayed = true;
        } else {
          throw payErr;
        }
      }
      if (replayed) {
        // The draw already exists on-chain (and may already have delivered). Do NOT pay again,
        // do NOT dispute a possibly-good draw, and do NOT re-fetch. Hand control back with a
        // clear replay signal instead of guessing whether the earlier attempt delivered.
        chunks.push({ kind: 'draw', n: drawN, drawId, replay: true, priorStatus, completion: null, usedUsd: 0, remainingUsd });
        return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: false, affirmed: false, replay: true };
      }
      // requestHash rides along so the relay can verify the request against the
      // DrawPaid event without recomputing trust itself (request_hash_required
      // from the reference relay otherwise; found live seeding spot 2026-07-02).
      completion = await _relayFetch({ bookingId: activeBookingId, n: drawN, drawPaidTxHash, requestHash: payment.requestHash, model: offer.model, buyerId: client.agentId, request: reqItem });
    } catch (e) {
      drawError = e;
    }

    const isGood = !drawError
      && completion
      && Array.isArray(completion.choices)
      && completion.choices.length > 0
      && (completion.choices[0]?.message?.content ?? '').trim().length > 0
      && completion.model === offer.model
      && completion.usage != null;
    const usedThisDraw = isGood ? round6Usd(meterUsd(completion.usage, offer)) : 0;
    const usage = completion?.usage ?? {};
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;

    if (!isGood) {
      if (drawId) await _disputeDraw(dripContractAddress, drawId, hash32(drawError?.message ?? completion?.error ?? 'bad_draw')).catch(() => {});
      chunks.push({ kind: 'draw', n: drawN, drawPaidTxHash, completion: null, usedUsd: 0, remainingUsd: 0, error: drawError?.message ?? completion?.error ?? null });
      return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: true, affirmed: false };
    }

    // Over-affirm guard: never affirm more delivered value than was paid for this draw.
    // The contract also enforces this, but catching it SDK-side avoids burning gas on a
    // guaranteed revert and surfaces a clear error.
    const deliveredUsdAtomic = usdToAtomic(usedThisDraw);
    if (deliveredUsdAtomic > BigInt(payment.sellerUsdAtomic)) {
      throw new Error(`over_affirm: deliveredUsdAtomic ${deliveredUsdAtomic} exceeds paid sellerUsdAtomic ${payment.sellerUsdAtomic} for draw ${drawId}`);
    }
    const responseHash = hash32(completion);
    // Reaching here means we paid this draw fresh in this call (a replay returns early above),
    // so the draw is Paid-and-open and affirm always proceeds — no prior-status skip needed.
    const affirmTxHash = await _affirmDraw(dripContractAddress, drawId, {
      inputTokens,
      outputTokens,
      deliveredUsdAtomic,
      responseHash,
    });
    remainingUsd = Number(completion.remainingUsd) || 0;
    fundedUsd += chunkUsd;
    remainingBudget -= chunkUsd;
    drawnUsd += usedThisDraw;
    outputParts.push(completion.choices[0].message.content ?? '');
    chunks.push({ kind: 'draw', n: drawN, drawPaidTxHash, drawId, completion, paidUsd: chunkUsd, usedUsd: usedThisDraw, remainingUsd, affirmTxHash });
    drawN++;
  }

  return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: false, affirmed: true };
}

export async function buy(client, { model, budget, prompt, messages, requests, maxPrice = 0, sellerId } = {}) {
  if (!model || !(Number(budget) > 0)) throw new Error('buy: model and a positive budget are required');
  const reqList = Array.isArray(requests) && requests.length
    ? requests
    : [{ model, messages: messages ?? [{ role: 'user', content: String(prompt ?? '') }], max_tokens: 256 }];

  const funding = await client.ensureFundedFor(budget);
  if (!funding.ok) return { status: 'funding_required', funding };

  const book = await client._req('GET', `/book?model=${encodeURIComponent(model)}`);
  let offers = (book.body?.offers || []).filter((o) =>
    o.tier === 'direct' && o.status === 'open'
    && (!sellerId || o.agentId === sellerId)
    && (!(maxPrice > 0) || (Number(o.outputPricePerMTok) <= maxPrice && Number(o.inputPricePerMTok) <= maxPrice)));
  offers.sort((a, b) => (Number(a.outputPricePerMTok) || 0) - (Number(b.outputPricePerMTok) || 0));
  if (!offers.length) return { status: 'no_offers', model, maxPrice };

  const tried = [];
  for (const o of offers) {
    const offer = { id: o.id, tier: 'direct', relayEndpoint: o.relayEndpoint, model, inputPricePerMTok: o.inputPricePerMTok, outputPricePerMTok: o.outputPricePerMTok, settlementPubkey: o.settlementPubkey, agentId: o.agentId };
    const res = await client.drawFromSeller({ offer, totalNeedUsd: budget, sellerId: o.agentId, requests: reqList });
    const draws = (res.chunks || []).filter((c) => c.kind === 'draw' && c.completion);
    if (res.affirmed && !res.disputed && draws.length) {
      const last = draws[draws.length - 1];
      const txHashes = (res.chunks || []).flatMap((c) => c.kind === 'draw'
        ? [c.drawPaidTxHash, c.affirmTxHash].filter(Boolean)
        : [c.sellerTxHash, c.feeTxHash].filter(Boolean));
      return {
        status: 'ok', sellerId: o.agentId, offerId: o.id,
        completions: draws.map((c) => c.completion),
        fundedUsd: res.fundedUsd, spentUsd: res.drawnUsd, remainingUsd: last.remainingUsd,
        txHashes,
      };
    }
    tried.push({ sellerId: o.agentId, offerId: o.id, disputed: !!res.disputed });
  }
  return { status: 'all_disputed', model, tried };
}
