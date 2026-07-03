// Buy-side bid watcher (#419): poll the market for an ask that crosses a
// posted bid's ceilings, draw through the EXISTING spot flow the moment one
// does, then call fillBid to link the bid to the draw that satisfied it.
//
// Like everything else in this SDK, this is ADVICE, NOT A GATE. Nothing forces
// a bidder to watch this way (or at all): the bid is a public chain event and
// anyone can match against it however they like. This is just the safest loop
// we know: bounded draws, ceiling-checked asks, and the honesty breadcrumb
// (fillBid) that builds your wallet's public fill score.
import { round6Usd } from './protocol.mjs';

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export async function watchAndFill(client, {
  bid,                    // the object postBid returned (bidId, model, ceilings, sizes, expiresAt)
  pollMs = 15_000,
  drawFn,                 // optional override: async ({ offer, bid, budgetUsd }) => drawFromSeller-shaped result
  request,                // the inference request(s) the bid exists to run (used by the default drawFn)
  requests,
  maxPolls = Infinity,    // give up after this many polls (the bid is cancelled so the board stays honest)
  sleep = sleepMs,
} = {}) {
  if (!bid?.bidId || !bid?.model) throw new Error('watchAndFill: bid with bidId + model is required');
  if (!drawFn && !request && !(Array.isArray(requests) && requests.length)) {
    throw new Error('watchAndFill: pass drawFn or request/requests so a crossing ask can actually be drawn');
  }

  // Ceilings in USD/MTok. A missing/zero ceiling means that dimension is
  // unconstrained (the contract requires at least one to be set).
  const maxIn = Number(bid.maxInputPricePerMTok) || 0;
  const maxOut = Number(bid.maxOutputPricePerMTok) || 0;
  const wantIn = Number(bid.inputTokens) || 0;
  const wantOut = Number(bid.outputTokens) || 0;
  const expiresAtMs = Number(bid.expiresAt) > 0 ? Number(bid.expiresAt) * 1000 : Infinity;
  const crosses = (inPrice, outPrice) =>
    (maxIn <= 0 || (Number(inPrice) || 0) <= maxIn) && (maxOut <= 0 || (Number(outPrice) || 0) <= maxOut);

  let gotIn = 0, gotOut = 0;
  const draws = [];
  const result = (status, extra = {}) => ({
    status, draws, deliveredInputTokens: gotIn, deliveredOutputTokens: gotOut, ...extra,
  });

  for (let polls = 0; ; polls++) {
    if (Date.now() >= expiresAtMs) return result('expired');
    if (polls >= maxPolls) {
      // Giving up on a still-live bid: cancel it so the board stops advertising
      // demand nobody is watching (a stale bid someone lists against and then
      // gets ghosted on scores against this wallet's public bid reputation).
      let cancelTxHash = null;
      try { cancelTxHash = await client.cancelBid(bid.bidId); } catch { /* best-effort */ }
      return result('cancelled', { cancelTxHash });
    }
    if (polls > 0) await sleep(pollMs);

    // Cheap signal off /spot: the server shape carries the indicative best ask;
    // the chain shape prices delivered draws only, so it can't rule a cross out
    // and we fall through to the book read.
    const spot = await client._req('GET', '/spot', null, false);
    const entry = spot.body?.models?.[bid.model];
    if (entry && entry.indicativeAskOutput != null && !crosses(entry.indicativeAskInput, entry.indicativeAskOutput)) continue;

    // The real check: open tier:direct asks for the model, at-or-under the ceilings.
    const book = await client._req('GET', `/book?model=${encodeURIComponent(bid.model)}`);
    const offers = (book.body?.offers ?? [])
      .filter((o) => o.tier === 'direct' && o.status === 'open' && crosses(o.inputPricePerMTok, o.outputPricePerMTok))
      .sort((a, b) => (Number(a.outputPricePerMTok) || 0) - (Number(b.outputPricePerMTok) || 0));
    if (!offers.length) continue;

    const o = offers[0];
    const offer = {
      id: o.id, tier: 'direct', relayEndpoint: o.relayEndpoint, model: bid.model,
      inputPricePerMTok: o.inputPricePerMTok, outputPricePerMTok: o.outputPricePerMTok,
      settlementPubkey: o.settlementPubkey, agentId: o.agentId,
    };
    // Budget the UNSATISFIED remainder of the bid at the crossing offer's
    // prices: the most this draw should cost if the seller delivers it all.
    const budgetUsd = round6Usd(
      (Math.max(0, wantIn - gotIn) / 1e6) * (Number(o.inputPricePerMTok) || 0)
      + (Math.max(0, wantOut - gotOut) / 1e6) * (Number(o.outputPricePerMTok) || 0),
    );
    const _draw = drawFn ?? (async () => client.drawFromSeller({
      offer, totalNeedUsd: budgetUsd, sellerId: offer.agentId,
      ...(Array.isArray(requests) && requests.length ? { requests } : { request }),
    }));

    const res = await _draw({ offer, bid, budgetUsd });
    draws.push(res);
    for (const c of res?.chunks ?? []) {
      if (c.kind !== 'draw' || !c.completion?.usage) continue;
      const u = c.completion.usage;
      gotIn += Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
      gotOut += Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    }
    const lastDrawId = [...(res?.chunks ?? [])].reverse().find((c) => c.kind === 'draw' && c.drawId)?.drawId ?? null;

    // Fully satisfied: link the bid to the draw that closed it out. In stage A
    // fillBid retires the WHOLE bid (there are no partial fills on chain), so
    // this call is also what takes the remainder off the board; no separate
    // cancel is needed. Calling it is optional protocol-wise, but it is the
    // breadcrumb that builds this wallet's public fill score.
    if (gotIn >= wantIn && gotOut >= wantOut && lastDrawId) {
      const fillTxHash = await client.fillBid(bid.bidId, lastDrawId);
      return result('filled', { drawId: lastDrawId, fillTxHash });
    }
    // Partial (or disputed) draw: keep watching; the next crossing ask covers
    // what is still owed.
  }
}
