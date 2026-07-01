import crypto from 'node:crypto';
import { configuredFeeUsd, meterUsd, PINNED_FEE_ADDRESSES, requiresFeeLeg, round6Usd, usdToAtomic } from './protocol.mjs';

const CHUNK_FLOOR = 0.10; // must stay in sync with DEFAULT_REP_KNOBS.chunkFloorUsd
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
  signChunkAuth,
  feeBps = 250,
} = {}) {
  const _relayFetch = relayFetch ?? client.relayFetch ?? (async (params) => {
    const url = offer.relayEndpoint.replace(/\/$/, '') + '/chunk';
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    return r.json();
  });

  const _signChunkAuth = signChunkAuth ?? client.signChunkAuth ?? (async (params) => {
    if (!client.account) throw new Error('drawFromSeller: no EVM account; pass signChunkAuth or call Mtok.create()');
    const built = await client._buildAuth(params.to, usdToAtomic(params.amountUsd), params.nonce);
    return client._submitAuthSelf(built);
  });

  const _api = client._stubApi ?? {
    reputation: async (sid) => {
      const r = await client._req('GET', `/agents/${encodeURIComponent(sid)}/reputation`);
      if (r.status !== 200) throw new Error('reputation lookup failed: ' + JSON.stringify(r.body));
      return r.body.reputation ?? r.body;
    },
    affirm: async (id) => {
      const r = await client._req('POST', `/bookings/${encodeURIComponent(id)}/affirm`, {});
      if (r.status !== 200 && r.status !== 204) throw new Error('affirm failed: ' + JSON.stringify(r.body));
    },
    dispute: async (id) => {
      const r = await client._req('POST', `/bookings/${encodeURIComponent(id)}/dispute`, {});
      if (r.status !== 200 && r.status !== 204) throw new Error('dispute failed: ' + JSON.stringify(r.body));
    },
    config: async () => {
      const r = await client._req('GET', '/config', null, false);
      if (r.status !== 200) throw new Error('config fetch failed: ' + JSON.stringify(r.body));
      return r.body;
    },
  };

  const reqList = Array.isArray(requests) && requests.length ? requests : [request ?? null];
  const rep = await _api.reputation(sellerId);
  const recommendedMaxChunkUsd = rep.recommendedMaxChunkUsd ?? CHUNK_FLOOR;
  const config = await _api.config();

  const pinnedFee = PINNED_FEE_ADDRESSES[client.chainId];
  if (pinnedFee && String(config.feeAddress || '').toLowerCase() !== pinnedFee.toLowerCase()) {
    throw new Error(`fee_address_mismatch: /api/config returned ${config.feeAddress} for chain ${client.chainId} but the pinned platform fee address is ${pinnedFee}. Refusing to pay a possibly-tampered fee address.`);
  }
  const feeRateBps = Number(config.feeBps ?? feeBps) || 0;
  const dustThresholdUsd = Number(config.dustThresholdUsd) || 0.001;
  const dripContractAddress = config.dripContractAddress || null;
  const _payDraw = client.payDraw ?? client._payDraw?.bind(client);
  const _drawIdFor = client.drawIdFor ?? client._drawIdFor?.bind(client);
  const _affirmDraw = client.affirmDraw ?? client._affirmDraw?.bind(client);
  const _disputeDraw = client.disputeDraw ?? client._disputeDraw?.bind(client);
  const _ensureAgentBound = client.pub ? client.ensureAgentBound?.bind(client) : null;

  const outPrice = Number(offer.outputPricePerMTok) || 0;
  const estimateCost = (r) => {
    const maxOut = Number(r?.max_tokens) || 0;
    if (outPrice > 0 && maxOut > 0) return (maxOut / 1e6) * outPrice;
    return CHUNK_FLOOR;
  };

  let remainingBudget = totalNeedUsd;
  let remainingUsd = 0;
  let fundN = 0;
  let drawN = 0;
  let fundedUsd = 0;
  let drawnUsd = 0;
  const chunks = [];
  const outputParts = [];
  let activeBookingId = bookingId ?? null;
  let checkedContractBinding = false;

  const doFund = async (targetUsd) => {
    const chunkUsd = fundN === 0
      ? Math.min(CHUNK_FLOOR, remainingBudget)
      : Math.min(remainingBudget, Math.max(targetUsd, recommendedMaxChunkUsd));
    if (!(chunkUsd > 0.0001)) return { ok: false, error: new Error('funding budget exhausted; cannot top up') };

    let sellerTxHash, feeTxHash;
    try {
      sellerTxHash = await Promise.resolve(_signChunkAuth({
        leg: 'seller', to: offer.settlementPubkey, amountUsd: chunkUsd,
        nonce: '0x' + crypto.randomBytes(32).toString('hex'), offerId: offer.id, n: fundN,
      }));
      if (requiresFeeLeg({ amountUsd: chunkUsd, feeAddress: config.feeAddress, feeBps: feeRateBps, dustThresholdUsd })) {
        feeTxHash = await Promise.resolve(_signChunkAuth({
          leg: 'fee', to: config.feeAddress, amountUsd: chunkUsd * feeRateBps / 10000,
          nonce: '0x' + crypto.randomBytes(32).toString('hex'), offerId: offer.id, n: fundN,
        }));
      }
    } catch (e) {
      return { ok: false, error: e };
    }

    let booking;
    try {
      booking = await _relayFetch({
        bookingId: activeBookingId, n: fundN, sellerTxHash, feeTxHash,
        priceUsd: chunkUsd, model: offer.model, buyerId: client.agentId,
      });
    } catch (e) {
      return { ok: false, error: e };
    }
    if (!booking || booking.error || booking.remainingUsd == null) {
      return { ok: false, error: new Error('FUND failed: ' + JSON.stringify(booking ?? null)) };
    }

    activeBookingId = activeBookingId ?? booking._bookingId ?? null;
    remainingUsd = Number(booking.remainingUsd) || 0;
    fundedUsd += chunkUsd;
    remainingBudget -= chunkUsd;
    chunks.push({ kind: 'fund', n: fundN, usd: chunkUsd, remainingUsd, sellerTxHash, feeTxHash });
    fundN++;
    return { ok: true };
  };

  for (const reqItem of reqList) {
    const est = estimateCost(reqItem);

    if (dripContractAddress) {
      if (!_payDraw || !_drawIdFor || !_affirmDraw || !_disputeDraw) throw new Error('drawFromSeller: contract mode requires payDraw/drawIdFor/affirmDraw/disputeDraw support');
      if (!checkedContractBinding && _ensureAgentBound) {
        await _ensureAgentBound({ contractAddress: dripContractAddress });
        checkedContractBinding = true;
      }
      activeBookingId = activeBookingId ?? contractBookingId();
      const chunkUsd = Math.min(remainingBudget, Math.max(CHUNK_FLOOR, Math.min(est || CHUNK_FLOOR, recommendedMaxChunkUsd)));
      if (!(chunkUsd > 0.0001)) break;
      const feeUsd = configuredFeeUsd({ amountUsd: chunkUsd, feeAddress: config.feeAddress, feeBps: feeRateBps });
      const usagePrice = (v) => usdToAtomic(v ?? 0);
      const payment = {
        buyerAgentId: client.agentId,
        sellerAgentId: sellerId,
        bookingId: activeBookingId,
        offerId: offer.id,
        model: offer.model,
        n: drawN,
        sellerUsdAtomic: usdToAtomic(chunkUsd),
        feeUsdAtomic: usdToAtomic(feeUsd),
        inputPricePerMTokAtomic: usagePrice(offer.inputPricePerMTok),
        outputPricePerMTokAtomic: usagePrice(offer.outputPricePerMTok),
        requestHash: hash32(reqItem),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };

      let drawPaidTxHash, drawId, completion, drawError;
      try {
        drawId = await _drawIdFor(dripContractAddress, payment);
        drawPaidTxHash = await _payDraw(dripContractAddress, payment);
        completion = await _relayFetch({ bookingId: activeBookingId, n: drawN, drawPaidTxHash, model: offer.model, buyerId: client.agentId, request: reqItem });
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
        if (activeBookingId) await _api.dispute(activeBookingId).catch(() => {});
        chunks.push({ kind: 'draw', n: drawN, drawPaidTxHash, completion: null, usedUsd: 0, remainingUsd: 0, error: drawError?.message ?? completion?.error ?? null });
        return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: true, affirmed: false };
      }

      const responseHash = hash32(completion);
      const affirmTxHash = await _affirmDraw(dripContractAddress, drawId, {
        inputTokens,
        outputTokens,
        deliveredUsdAtomic: usdToAtomic(usedThisDraw),
        responseHash,
      });
      remainingUsd = Number(completion.remainingUsd) || 0;
      fundedUsd += chunkUsd;
      remainingBudget -= chunkUsd;
      drawnUsd += usedThisDraw;
      outputParts.push(completion.choices[0].message.content ?? '');
      chunks.push({ kind: 'draw', n: drawN, drawPaidTxHash, drawId, completion, paidUsd: chunkUsd, usedUsd: usedThisDraw, remainingUsd, affirmTxHash });
      drawN++;
      continue;
    }

    while (remainingUsd < est && remainingBudget > 0.0001) {
      const f = await doFund(est);
      if (!f.ok) {
        if (activeBookingId) await _api.dispute(activeBookingId).catch(() => {});
        return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: true, affirmed: false };
      }
    }

    if (remainingUsd <= 1e-6) break;

    let completion, drawError;
    try {
      completion = await _relayFetch({ bookingId: activeBookingId, n: drawN, model: offer.model, buyerId: client.agentId, request: reqItem });
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
    chunks.push({ kind: 'draw', n: drawN, completion: isGood ? completion : null, usedUsd: usedThisDraw, remainingUsd: completion?.remainingUsd ?? remainingUsd, error: drawError?.message ?? completion?.error ?? null });

    if (!isGood) {
      if (activeBookingId) await _api.dispute(activeBookingId).catch(() => {});
      return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: true, affirmed: false };
    }

    activeBookingId = activeBookingId ?? completion._bookingId ?? null;
    if (completion.remainingUsd != null) remainingUsd = Number(completion.remainingUsd) || 0;
    else remainingUsd = Math.max(0, remainingUsd - usedThisDraw);
    drawnUsd += usedThisDraw;
    outputParts.push(completion.choices[0].message.content ?? '');
    drawN++;
  }

  if (activeBookingId) await _api.affirm(activeBookingId).catch(() => {});
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
      const funds = (res.chunks || []).filter((c) => c.kind === 'fund');
      return {
        status: 'ok', sellerId: o.agentId, offerId: o.id,
        completions: draws.map((c) => c.completion),
        fundedUsd: res.fundedUsd, spentUsd: res.drawnUsd, remainingUsd: last.remainingUsd,
        txHashes: funds.flatMap((f) => [f.sellerTxHash, f.feeTxHash].filter(Boolean)),
      };
    }
    tried.push({ sellerId: o.agentId, offerId: o.id, disputed: !!res.disputed });
  }
  return { status: 'all_disputed', model, tried };
}
