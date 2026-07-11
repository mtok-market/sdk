import crypto from 'node:crypto';
import { DRAW_STATUS, meterUsd, PINNED_FEE_ADDRESSES, round6Usd, usdToAtomic } from './protocol.mjs';
import { DEFAULT_FEE_BPS, MIN_DRAW_USD, RECOMMENDED_FIRST_DRAW_USD } from './constants.mjs';

const hash32 = (v) => '0x' + crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');
const contractBookingId = () => 'bkgc_' + crypto.randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9_-]/g, '');
const floorUsdAtomic = (value) => Math.floor((Math.max(0, Number(value) || 0) + Number.EPSILON) * 1e6) / 1e6;
const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'temperature', 'response_format', 'stream', 'n']);
const MESSAGE_ROLES = new Set(['developer', 'system', 'user', 'assistant']);
const estimateInputTokens = (messages) => 3 + messages.reduce((tokens, message) =>
  tokens + 4 + Buffer.byteLength(message.role, 'utf8') + Buffer.byteLength(message.content, 'utf8'), 0);

function normalizeRelayRequest(request) {
  let normalized;
  try {
    const json = JSON.stringify(request);
    normalized = json == null ? null : JSON.parse(json);
  } catch (error) {
    throw new Error(`drawFromSeller: request_shape_invalid: request must be JSON-serializable (${error.message})`);
  }
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    for (const key of ['model', 'max_tokens', 'temperature', 'response_format', 'stream', 'n']) {
      if (normalized[key] == null) delete normalized[key];
    }
  }
  return normalized;
}

const isExistingDrawError = (error) => /DrawAlreadyExists|already exists/i.test(String(error?.message ?? error ?? ''));
function isDefinitelyUnpaid(error) {
  if (error?.paymentSubmitted === true && error?.paymentUnpaid !== true) return false;
  if (error?.paymentUnpaid === true || error?.code === 4001 || error?.code === 'ACTION_REJECTED') return true;
  const message = String(error?.message ?? error ?? '');
  if (isExistingDrawError(error)) return false;
  return /(?:user|wallet).{0,30}(?:reject|deni)|(?:reject|deni).{0,30}(?:signature|transaction)|execution reverted|tx reverted|insufficient (?:funds|allowance)/i.test(message);
}

function validateRelayRequest(request, model) {
  const fail = (reason) => { throw new Error(`drawFromSeller: request_shape_invalid: ${reason}`); };
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  const has = (key) => Object.hasOwn(request, key);
  const unknown = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unknown) fail(`unsupported field ${unknown}`);
  if (has('model') && request.model !== model) fail(`model must be ${model}`);
  if (!Array.isArray(request.messages) || request.messages.length === 0) fail('messages must be nonempty');
  for (const message of request.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) fail('each message must be an object');
    const keys = Object.keys(message);
    if (keys.length !== 2 || !keys.includes('role') || !keys.includes('content')) fail('messages allow only role and content');
    if (!MESSAGE_ROLES.has(message.role) || typeof message.content !== 'string') fail('messages require a supported role and plain-text content');
  }
  if (has('max_tokens') && (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0)) fail('max_tokens must be a positive integer');
  if (has('temperature') && (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)
    || request.temperature < 0 || request.temperature > 2)) fail('temperature must be between 0 and 2');
  if (has('stream') && request.stream !== false) fail('stream must be false');
  if (has('n') && request.n !== 1) fail('n must be 1');
  if (has('response_format')) {
    const format = request.response_format;
    if (!format || typeof format !== 'object' || Array.isArray(format)
      || Object.keys(format).length !== 1 || !['text', 'json_object'].includes(format.type)) {
      fail('response_format must be exactly { type: "text" | "json_object" }');
    }
  }
}

export async function drawFromSeller(client, {
  offer,
  totalNeedUsd,
  sellerId,
  bookingId,
  request,
  requests,
  relayFetch,
  onDrawPrepared,
  onDrawSubmitted,
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

  const rawReqList = Array.isArray(requests) && requests.length ? requests : [request ?? null];
  const reqList = rawReqList.map(normalizeRelayRequest);

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
  if (offer?.requestHashScheme != null && offer.requestHashScheme !== 'nonce-v1') {
    throw new Error(`drawFromSeller: unsupported requestHashScheme ${JSON.stringify(offer.requestHashScheme)}; expected "nonce-v1" or an omitted legacy marker`);
  }
  offer = { ...offer, id: _offerId, offerId: _offerId, model: _model };
  for (const reqItem of reqList) validateRelayRequest(reqItem, offer.model);

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
  const _onDrawPrepared = onDrawPrepared ?? client.onDrawPrepared?.bind(client);
  const _onDrawSubmitted = onDrawSubmitted ?? client.onDrawSubmitted?.bind(client);
  const _ensureAgentBound = client.pub ? client.ensureAgentBound?.bind(client) : null;
  const readDrawStatus = async (drawId) => {
    if (!_drawStatus || !drawId) return null;
    try {
      const rawStatus = await _drawStatus(dripContractAddress, drawId);
      if (rawStatus == null) return null;
      const status = Number(rawStatus);
      return Object.values(DRAW_STATUS).includes(status) ? status : null;
    } catch {
      return null;
    }
  };

  const inPrice = Number(offer.inputPricePerMTok) || 0;
  const outPrice = Number(offer.outputPricePerMTok) || 0;
  if (!(Number.isFinite(inPrice) && inPrice > 0) || !(Number.isFinite(outPrice) && outPrice > 0)) {
    throw new Error('drawFromSeller: offer prices must be positive finite USD/MTok values');
  }
  const inPriceAtomic = usdToAtomic(inPrice);
  const outPriceAtomic = usdToAtomic(outPrice);
  const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;
  const estimateCost = (r) => {
    const estimatedInputTokens = estimateInputTokens(r.messages);
    const inputUsd = estimatedInputTokens / 1e6 * inPrice;
    const maxOut = Number(r?.max_tokens) || 0;
    const outputUsd = outPrice > 0 && maxOut > 0 ? (maxOut / 1e6) * outPrice : 0;
    const minServeAtomic = ceilDiv(BigInt(estimatedInputTokens) * inPriceAtomic + outPriceAtomic, 1_000_000n);
    return { inputUsd, totalUsd: inputUsd + outputUsd, minServeUsd: Number(minServeAtomic) / 1e6 };
  };
  const estimates = reqList.map(estimateCost);

  let remainingBudget = floorUsdAtomic(totalNeedUsd);
  let remainingUsd = 0;
  let drawN = 0;
  let attemptedCount = 0;
  let fundedUsd = 0;
  let drawnUsd = 0;
  const chunks = [];
  const outputParts = [];
  let activeBookingId = bookingId ?? null;
  let checkedContractBinding = false;
  const result = (status, extra = {}) => ({
    status,
    output: outputParts.join(''),
    chunks,
    drawnUsd,
    fundedUsd,
    paidUsd: fundedUsd,
    requestedCount: reqList.length,
    attemptedCount,
    completedCount: drawN,
    unprocessedCount: Math.max(0, reqList.length - attemptedCount),
    unprocessed: reqList.slice(attemptedCount),
    partial: status === 'partial' || (drawN > 0 && drawN < reqList.length),
    ...extra,
  });

  for (const [requestIndex, reqItem] of reqList.entries()) {
    const est = estimates[requestIndex];

    if (!_payDraw || !_drawIdFor || !_affirmDraw || !_disputeDraw) throw new Error('drawFromSeller: contract mode requires payDraw/drawIdFor/affirmDraw/disputeDraw support');
    if (!checkedContractBinding && _ensureAgentBound) {
      await _ensureAgentBound({ contractAddress: dripContractAddress });
      checkedContractBinding = true;
    }
    activeBookingId = activeBookingId ?? contractBookingId();
    const recommendedCapUsd = Number.isFinite(recommendedMaxChunkUsd) && recommendedMaxChunkUsd > 0
      ? recommendedMaxChunkUsd
      : RECOMMENDED_FIRST_DRAW_USD;
    const futureReserveUsd = estimates.slice(requestIndex + 1)
      .reduce((sum, future) => sum + Math.max(MIN_DRAW_USD, future.totalUsd, future.minServeUsd), 0);
    const drawCapUsd = Math.min(Math.max(0, (Number(remainingBudget) || 0) - futureReserveUsd), recommendedCapUsd);
    if (drawCapUsd < MIN_DRAW_USD) break;
    if (est.minServeUsd > drawCapUsd) {
      return result(drawN > 0 ? 'partial' : 'insufficient_budget', {
        disputed: false,
        affirmed: false,
        error: `input prompt plus one output token requires at least $${est.minServeUsd}`,
      });
    }
    const defaultProbeUsd = Math.min(RECOMMENDED_FIRST_DRAW_USD, drawCapUsd);
    const estimatedUsd = est.totalUsd > 0 ? Math.min(est.totalUsd, drawCapUsd) : 0;
    const targetUsd = Math.max(MIN_DRAW_USD, defaultProbeUsd, estimatedUsd);
    const chunkUsd = floorUsdAtomic(Math.min(drawCapUsd, targetUsd));
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
    const requestNonce = offer.requestHashScheme === 'nonce-v1'
      ? '0x' + crypto.randomBytes(16).toString('hex')
      : undefined;
    const payment = {
      buyerAgentId: client.agentId,
      sellerAgentId: sellerId,
      bookingId: activeBookingId,
      offerId: offer.id,
      model: offer.model,
      n: drawN,
      sellerUsdAtomic,
      feeUsdAtomic,
      inputPricePerMTokAtomic: inPriceAtomic,
      outputPricePerMTokAtomic: outPriceAtomic,
      requestHash: requestNonce ? hash32({ request: reqItem, requestNonce }) : hash32(reqItem),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      expectedSeller,
    };

    attemptedCount++;
    let drawPaidTxHash, drawId, completion, drawError, replayed = false, paidFresh = false, priorStatus;
    try {
      drawId = await _drawIdFor(dripContractAddress, payment);
      const recoveryPayment = Object.fromEntries(Object.entries(payment)
        .map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
      const recoveryRecord = {
        relayEndpoint: offer.relayEndpoint,
        model: offer.model,
        buyerId: client.agentId,
        requestHashScheme: offer.requestHashScheme ?? null,
        bookingId: activeBookingId,
        n: drawN,
        request: reqItem,
        requestNonce,
        requestHash: payment.requestHash,
        drawId,
        payment: recoveryPayment,
      };
      if (_onDrawPrepared) {
        await _onDrawPrepared(recoveryRecord);
      }
      // Double-spend protection lives ON-CHAIN: payDraw reverts with DrawAlreadyExists once a
      // draw for this bookingId+n exists, so money physically cannot move twice. We do NOT read
      // status before paying — that would cost an extra RPC on every happy-path draw. Pay
      // directly; the revert is the guard.
      //
      // Recovery reads status only after an error. A confirmed existing draw becomes a replay;
      // an authoritative wallet/revert error remains unpaid; an RPC-ambiguous outcome is terminal
      // `payment_unknown`. This keeps the happy path cheap without treating a timeout as permission
      // to pay another seller. See packages/api/src/core/guides.js for the fuller rationale.
      try {
        let submissionPersisted = false;
        const persistSubmission = _onDrawSubmitted ? async (hash) => {
          submissionPersisted = true;
          try {
            await _onDrawSubmitted({ ...recoveryRecord, drawPaidTxHash: hash });
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            error.txHash = hash;
            error.paymentSubmitted = true;
            error.paymentStage = 'persist_submission';
            throw error;
          }
        } : undefined;
        drawPaidTxHash = await _payDraw(dripContractAddress, payment, { onSubmitted: persistSubmission });
        // A custom payDraw override may ignore the third argument. Persist the
        // confirmed hash here as a compatibility fallback; the built-in _payDraw
        // invokes it immediately after broadcast and before confirmation.
        if (persistSubmission && !submissionPersisted) {
          try {
            await persistSubmission(drawPaidTxHash);
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause));
            error.txHash = drawPaidTxHash;
            error.paymentSubmitted = true;
            error.paymentStage = 'persist_submission';
            throw error;
          }
        }
        paidFresh = true;
        fundedUsd = round6Usd(fundedUsd + chunkUsd);
        remainingBudget = floorUsdAtomic(remainingBudget - chunkUsd);
      } catch (payErr) {
        drawPaidTxHash = payErr?.txHash ?? drawPaidTxHash;
        priorStatus = await readDrawStatus(drawId);
        if ([DRAW_STATUS.Paid, DRAW_STATUS.Affirmed, DRAW_STATUS.Disputed].includes(priorStatus)) {
          replayed = true;
        } else if (isDefinitelyUnpaid(payErr)) {
          throw payErr;
        } else {
          // A timeout, nonce/RPC error, or contradictory DrawAlreadyExists/None read may have
          // submitted successfully even though this client never received a hash. Never pay a
          // second seller while that outcome is unknown; the stable drawId is the recovery key.
          drawPaidTxHash = drawPaidTxHash ?? null;
          chunks.push({
            kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce,
            requestHash: payment.requestHash, completion: null, paymentUnknown: true,
            atRiskUsd: chunkUsd, paidUsd: 0, usedUsd: 0,
            remainingUsd: round6Usd(remainingBudget), error: String(payErr?.message ?? payErr),
          });
          return result('payment_unknown', {
            disputed: false, affirmed: false, paymentUnknown: true,
            failedRequest: reqItem,
            unprocessedCount: reqList.length - attemptedCount,
            unprocessed: reqList.slice(attemptedCount),
          });
        }
      }
      if (replayed) {
        // The draw already exists on-chain (and may already have delivered). Do NOT pay again,
        // do NOT dispute a possibly-good draw, and do NOT re-fetch. Hand control back with a
        // clear replay signal instead of guessing whether the earlier attempt delivered.
        chunks.push({ kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce, requestHash: payment.requestHash, replay: true, priorStatus, completion: null, usedUsd: 0, remainingUsd });
        return result('replay', { disputed: false, affirmed: false, replay: true });
      }
      // requestHash rides along so the relay can verify the request against the
      // DrawPaid event without recomputing trust itself (request_hash_required
      // from the reference relay otherwise; found live seeding spot 2026-07-02).
      completion = await _relayFetch({
        bookingId: activeBookingId, n: drawN, drawPaidTxHash, requestHash: payment.requestHash,
        ...(requestNonce ? { requestNonce } : {}),
        model: offer.model, buyerId: client.agentId, request: reqItem,
      });
    } catch (e) {
      drawError = e;
    }

    const usage = completion?.usage ?? {};
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const usageIsValid = Number.isSafeInteger(inputTokens) && inputTokens >= 0
      && Number.isSafeInteger(outputTokens) && outputTokens >= 0;
    const isGood = !drawError
      && completion
      && Array.isArray(completion.choices)
      && completion.choices.length > 0
      && typeof completion.choices[0]?.message?.content === 'string'
      && completion.choices[0].message.content.trim().length > 0
      && completion.model === offer.model
      && completion.usage != null
      && usageIsValid;
    const usedThisDraw = isGood ? round6Usd(meterUsd(completion.usage, offer)) : 0;

    const disputePaidDraw = async (reason) => {
      let disputeTxHash = null;
      let disputeError = null;
      try {
        disputeTxHash = await _disputeDraw(dripContractAddress, drawId, hash32(reason));
      } catch (error) {
        disputeError = error;
      }
      const chainStatus = await readDrawStatus(drawId);
      return {
        disputeTxHash,
        disputeError,
        chainStatus,
        disputed: !!disputeTxHash || chainStatus === DRAW_STATUS.Disputed,
      };
    };

    if (!isGood) {
      const dispute = paidFresh && drawId
        ? await disputePaidDraw(drawError?.message ?? completion?.error ?? 'bad_draw')
        : { disputeTxHash: null, disputeError: null, chainStatus: null, disputed: false };
      chunks.push({
        kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce, requestHash: payment.requestHash,
        completion: null, paidUsd: paidFresh ? chunkUsd : 0, usedUsd: 0,
        remainingUsd: round6Usd(remainingBudget), disputeTxHash: dispute.disputeTxHash,
        chainStatus: dispute.chainStatus,
        error: drawError?.message ?? completion?.error ?? dispute.disputeError?.message ?? null,
      });
      const unprocessedFrom = paidFresh ? attemptedCount : attemptedCount - 1;
      return result(dispute.disputed ? 'disputed' : paidFresh ? 'paid_unresolved' : 'failed', {
        disputed: dispute.disputed,
        affirmed: false,
        failedRequest: reqItem,
        unprocessedCount: reqList.length - unprocessedFrom,
        unprocessed: reqList.slice(unprocessedFrom),
      });
    }

    // Over-affirm guard: never affirm more delivered value than was paid for this draw.
    // The contract also enforces this, but catching it SDK-side avoids burning gas on a
    // guaranteed revert and surfaces a clear error.
    const deliveredUsdAtomic = usdToAtomic(usedThisDraw);
    const disputeAfterDeliveredFailure = async (error) => {
      const dispute = await disputePaidDraw(error.message);
      chunks.push({
        kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce, requestHash: payment.requestHash, completion,
        paidUsd: chunkUsd, usedUsd: 0, meteredUsd: usedThisDraw,
        remainingUsd: round6Usd(remainingBudget), disputeTxHash: dispute.disputeTxHash,
        chainStatus: dispute.chainStatus, error: error.message,
      });
      return result(dispute.disputed ? 'disputed' : 'paid_unresolved', {
        disputed: dispute.disputed, affirmed: false, failedRequest: reqItem,
        unprocessedCount: reqList.length - attemptedCount,
        unprocessed: reqList.slice(attemptedCount),
      });
    };
    if (deliveredUsdAtomic > BigInt(payment.sellerUsdAtomic)) {
      return disputeAfterDeliveredFailure(new Error(`over_affirm: deliveredUsdAtomic ${deliveredUsdAtomic} exceeds paid sellerUsdAtomic ${payment.sellerUsdAtomic} for draw ${drawId}`));
    }
    const responseHash = hash32(completion);
    // Reaching here means we paid this draw fresh in this call (a replay returns early above),
    // so the draw is Paid-and-open and affirm always proceeds — no prior-status skip needed.
    let affirmTxHash;
    try {
      affirmTxHash = await _affirmDraw(dripContractAddress, drawId, {
        inputTokens,
        outputTokens,
        deliveredUsdAtomic,
        responseHash,
      });
    } catch (error) {
      // Delivery is valid. A transient/lost-response affirmation error is not evidence of
      // seller fault, so never turn it into a dispute. Reconcile from chain; only a confirmed
      // Affirmed status is success, and every other state remains terminal for this buyer.
      const chainStatus = await readDrawStatus(drawId);
      if (chainStatus !== DRAW_STATUS.Affirmed) {
        const disputed = chainStatus === DRAW_STATUS.Disputed;
        chunks.push({
          kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce,
          requestHash: payment.requestHash, completion, paidUsd: chunkUsd,
          usedUsd: 0, meteredUsd: usedThisDraw, remainingUsd: round6Usd(remainingBudget),
          affirmTxHash: error?.txHash ?? null, chainStatus, error: error.message,
        });
        return result(disputed ? 'disputed' : 'paid_unresolved', {
          disputed, affirmed: false, failedRequest: reqItem,
          unprocessedCount: reqList.length - attemptedCount,
          unprocessed: reqList.slice(attemptedCount),
        });
      }
      affirmTxHash = error?.txHash ?? null;
    }
    remainingUsd = Number(completion.remainingUsd) || 0;
    drawnUsd += usedThisDraw;
    outputParts.push(completion.choices[0].message.content ?? '');
    chunks.push({ kind: 'draw', bookingId: activeBookingId, n: drawN, drawPaidTxHash, drawId, requestNonce, requestHash: payment.requestHash, completion, paidUsd: chunkUsd, usedUsd: usedThisDraw, remainingUsd, affirmTxHash });
    drawN++;
  }

  const complete = drawN === reqList.length;
  return result(complete ? 'ok' : 'partial', { disputed: false, affirmed: complete });
}

export async function buy(client, { model, budget, prompt, messages, requests, maxPrice = 0, sellerId, onDrawPrepared, onDrawSubmitted } = {}) {
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
  let paidUsd = 0;
  for (const o of offers) {
    const offer = {
      id: o.id, tier: 'direct', relayEndpoint: o.relayEndpoint, model,
      inputPricePerMTok: o.inputPricePerMTok, outputPricePerMTok: o.outputPricePerMTok,
      settlementPubkey: o.settlementPubkey, requestHashScheme: o.requestHashScheme,
      agentId: o.agentId,
    };
    const res = await client.drawFromSeller({ offer, totalNeedUsd: round6Usd(Number(budget) - paidUsd), sellerId: o.agentId, requests: reqList, onDrawPrepared, onDrawSubmitted });
    const draws = (res.chunks || []).filter((c) => c.kind === 'draw' && c.completion);
    const paidThisDraw = Number(res.paidUsd ?? res.fundedUsd ?? 0) || 0;
    paidUsd = round6Usd(paidUsd + paidThisDraw);
    const txHashes = (res.chunks || []).flatMap((c) => c.kind === 'draw'
      ? [c.drawPaidTxHash, c.affirmTxHash].filter(Boolean)
      : [c.sellerTxHash, c.feeTxHash].filter(Boolean));
    const requestedCount = Number(res.requestedCount ?? reqList.length);
    const completedCount = Number(res.completedCount ?? draws.length);
    const attemptedCount = Number(res.attemptedCount ?? (res.chunks || []).filter((c) => c.kind === 'draw').length);
    const unprocessed = Array.isArray(res.unprocessed) ? res.unprocessed : reqList.slice(attemptedCount);
    const unprocessedCount = Number(res.unprocessedCount ?? Math.max(0, requestedCount - attemptedCount));
    const partial = !!res.partial || (draws.length > 0 && completedCount < requestedCount);
    if (res.affirmed && !res.disputed && !partial && draws.length === requestedCount) {
      return {
        status: 'ok', sellerId: o.agentId, offerId: o.id,
        completions: draws.map((c) => c.completion),
        fundedUsd: paidUsd, paidUsd, spentUsd: res.drawnUsd, remainingUsd: round6Usd(Math.max(0, Number(budget) - paidUsd)),
        requestedCount, completedCount, unprocessedCount: 0, unprocessed: [],
        txHashes,
      };
    }
    tried.push({ sellerId: o.agentId, offerId: o.id, disputed: !!res.disputed, paidUsd: paidThisDraw });
    const terminalUnknown = res.status === 'payment_unknown' || res.status === 'paid_unresolved';
    if (paidThisDraw > 0 || res.replay || partial || terminalUnknown) {
      return {
        status: res.disputed ? 'disputed'
          : res.status === 'payment_unknown' ? 'payment_unknown'
          : res.status === 'paid_unresolved' ? 'paid_unresolved'
          : res.replay ? 'replay'
          : partial ? 'partial'
          : 'paid_undelivered',
        model, sellerId: o.agentId, offerId: o.id,
        completions: draws.map((c) => c.completion),
        fundedUsd: paidUsd, paidUsd, spentUsd: Number(res.drawnUsd) || 0,
        remainingUsd: round6Usd(Math.max(0, Number(budget) - paidUsd)),
        requestedCount, attemptedCount, completedCount, failedRequest: res.failedRequest,
        unprocessedCount, unprocessed,
        disputed: !!res.disputed, tried, txHashes, chunks: res.chunks ?? [],
      };
    }
  }
  return { status: 'all_failed', model, paidUsd, tried };
}
