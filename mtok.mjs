// mtok — reference client for the non-custodial seller-hosted market (#74, #119).
//
// Hides the whole non-custodial flow behind a few calls: it manages the agent's
// Ed25519 signing key + EVM wallet, signs every order, and draws inference from a
// seller's own relay in prepaid on-chain chunks (drawFromSeller). Delivery is always
// seller-hosted (tier:"direct") — the platform never proxies inference or holds money.
//
//   import { Mtok } from './mtok.mjs';
//   const mtok = await Mtok.create();            // generates keys; persist mtok.identity
//   await mtok.register('my-agent');
//   const { routes } = await mtok.bid({ model: 'gpt-5.2', inputTokens: 200_000, outputTokens: 200_000, maxPrice: 0.5 });
//   const r = await mtok.drawFromSeller({ offer: routes[0], totalNeedUsd: 1, sellerId: routes[0].sellerId });
//
// Source is split for maintainability; build:sdk bundles it back into one
// downloadable sdk.mjs for agents that want a single file.
import crypto from 'node:crypto';
import { createWalletClient, createPublicClient, http, fallback } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';
import { BID_BOARD, BID_MAX_TTL_SECONDS, BID_POSTED_TOPIC, DRIP_LEDGER, DRAW_STATUS, ERC20, PINNED_BID_BOARD_ADDRESSES, signIntent, TWA, usdToAtomic } from './src/protocol.mjs';
export { PINNED_FEE_ADDRESSES, PINNED_BID_BOARD_ADDRESSES } from './src/protocol.mjs';
import { ensureFundedFor as ensureFundedForClient, walletBalances } from './src/funding.mjs';
import { buy as buyClient, drawFromSeller as drawFromSellerClient } from './src/draw.mjs';
import { watchAndFill as watchAndFillClient } from './src/bids.mjs';
export { buildIndexedJsonBatch, chunkItems, parseIndexedJsonList } from './src/batch.mjs';

export class Mtok {
  constructor(cfg) { Object.assign(this, cfg); }

  // Create a client. Generates a signing key + EVM wallet if not supplied. Persist
  // `mtok.identity` (the two private keys + apiKey) to reuse the same agent.
  static async create({
    apiBase = 'https://mtok.market/api',
    chainId = 8453,                                   // 8453 Base mainnet | 84532 Base Sepolia
    rpcUrl,                                            // single RPC override (back-compat)
    rpcUrls,                                           // OR a list → viem fallback (resilient)
    usdc = chainId === 8453 ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    signingKeyPem,                                    // Ed25519 PKCS8 PEM; generated if absent
    evmPrivateKey,                                    // 0x… hex; generated if absent
    apiKey,
    agentId,
  } = {}) {
    const signPriv = signingKeyPem ? crypto.createPrivateKey(signingKeyPem) : crypto.generateKeyPairSync('ed25519').privateKey;
    const pubkey = crypto.createPublicKey(signPriv).export({ type: 'spki', format: 'pem' });
    const pk = evmPrivateKey || ('0x' + crypto.randomBytes(32).toString('hex'));
    const account = privateKeyToAccount(pk);
    const chain = chainId === 8453 ? base : baseSepolia;
    // Resilient transport: rotate across several RPCs with retries so one
    // rate-limited or down endpoint can't strand a payment mid-flow. A single
    // rpcUrl still works; otherwise default to public endpoints for the chain.
    const urls = rpcUrls?.length ? rpcUrls : rpcUrl ? [rpcUrl]
      : chainId === 8453
        ? ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']
        : ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
    const transport = urls.length > 1 ? fallback(urls.map((u) => http(u, { retryCount: 3 }))) : http(urls[0], { retryCount: 3 });
    return new Mtok({
      apiBase, chainId, usdc, apiKey, agentId,
      signPriv, pubkey, account, pk,
      wallet: createWalletClient({ account, chain, transport }),
      pub: createPublicClient({ chain, transport }),
    });
  }

  get identity() { return { signingKeyPem: this.signPriv.export({ type: 'pkcs8', format: 'pem' }), evmPrivateKey: this.pk, address: this.account.address, pubkey: this.pubkey, apiKey: this.apiKey, agentId: this.agentId }; }

  // Restore a persisted identity (no re-register; reuses the same agentId + reputation
  // + funded wallet). Pass the object returned by `mtok.identity`.
  static async fromIdentity(identity, opts = {}) {
    return Mtok.create({
      ...opts,
      signingKeyPem: identity.signingKeyPem,
      evmPrivateKey: identity.evmPrivateKey,
      apiKey: identity.apiKey,
      agentId: identity.agentId,
    });
  }

  async _req(method, path, body, auth = true) {
    const headers = { 'content-type': 'application/json', ...(auth && this.apiKey ? { 'x-api-key': this.apiKey } : {}) };
    const r = await fetch(this.apiBase + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let b; try { b = await r.json(); } catch { b = {}; }
    return { status: r.status, body: b };
  }
  _sign(action, model, params) {
    const intent = { v: 1, action, model, nonce: crypto.randomUUID(), expiry: Date.now() + 3600_000, chainId: this.chainId, params };
    return { intent, sig: signIntent(intent, this.signPriv) };
  }

  async register(name) {
    const r = await this._req('POST', '/agents/register', { name, pubkey: this.pubkey }, false);
    if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r.body));
    this.apiKey = r.body.apiKey;
    this.agentId = r.body.agentId;   // our own platform agent id (buyerId on chunk reports)
    return r.body;
  }
  // Post a SELLER-HOSTED (tier:direct) offer: the seller runs their own relay
  // (relayEndpoint, public HTTPS) and buyers prepay per chunk on-chain to
  // settlementPubkey (the seller's Base wallet). price is USD/MTok and must be
  // > 0 — price-0 is banned.
  // payoutAddress is REQUIRED by the non-custodial server (where buyers pay you); it
  // is signed INTO the intent params (the router rebuilds the order from intent.params).
  // For a direct offer it is the same wallet as settlementPubkey, so it defaults to it.
  async offer({ model, inputTokens, outputTokens, price, relayEndpoint, settlementPubkey, payoutAddress, requestHashScheme, usableForSeconds = 3600, recurring = false }) {
    if (!(Number(price) > 0)) throw new Error('offer: price must be > 0 (price-0 is banned)');
    if (requestHashScheme != null && requestHashScheme !== 'nonce-v1') {
      throw new Error('offer: requestHashScheme must be "nonce-v1" or omitted for legacy relays');
    }
    const params = {
      inputTokens, outputTokens, inputPricePerMTok: price, outputPricePerMTok: price,
      tier: 'direct', relayEndpoint, settlementPubkey,
      payoutAddress: payoutAddress ?? settlementPubkey,
      ...(requestHashScheme ? { requestHashScheme } : {}),
      usableForSeconds, recurring,
    };
    const r = await this._req('POST', '/offers', this._sign('offer', model, params));
    if (r.status !== 201) throw new Error('offer failed: ' + JSON.stringify(r.body));
    return r.body.order;
  }
  async bid({ model, inputTokens, outputTokens, maxPrice }) {
    if (!(Number(maxPrice) > 0)) throw new Error('bid: maxPrice must be > 0 (price-0 is banned)');
    if (!this.account?.address) throw new Error('bid: no EVM account; call Mtok.create() or provide an account');
    const params = { inputTokens, outputTokens, maxInputPricePerMTok: maxPrice, maxOutputPricePerMTok: maxPrice, payerAddress: this.account.address };
    const r = await this._req('POST', '/bids', this._sign('bid', model, params));
    if (r.status !== 201) throw new Error('bid failed: ' + JSON.stringify(r.body));
    // routes[] = crossing seller-hosted (tier:direct) offers to draw chunks from.
    return { routes: r.body.routes ?? [], fills: r.body.fills ?? [], order: r.body.order };
  }
  // ---- on-chain payment primitives ----
  // Wait for the receipt AND require success — a reverted tx must never be returned (and
  // thus never cached) as a payment proof; throwing leaves the nonce free for a real retry.
  async _confirm(hash) { const r = await this.pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('tx reverted: ' + hash); return hash; }
  // Submit a write with an EXPLICITLY managed nonce. With a fallback() transport viem's
  // auto nonce-fetch can hit a lagging node and read a STALE nonce, so two back-to-back
  // legs (seller + fee) collide ("nonce too low") and a paid leg is orphaned
  // (mtok-market#128). We read the pending nonce once and increment locally; a failed
  // SUBMISSION resets it so the next write re-syncs from chain (a mined-but-reverted tx
  // still consumed its nonce, so we reset ONLY when writeContract itself throws).
  //
  // SERIALIZED (mtok-market#419): the read-submit-increment was a check-then-act race on
  // ONE client. Two concurrent _writes (e.g. a watchAndFill payDraw in flight while another
  // watcher cancelBids) both read this._nonce = N, both submit N, and the loser's catch set
  // this._nonce = null, clobbering the winner's N+1. We chain every _write onto a single
  // in-process promise so the whole read + submit + increment runs atomically per write, one
  // at a time. Concurrent callers queue instead of colliding: each gets a distinct nonce, and
  // a failed write's reset can no longer stomp a concurrent winner (there is never a
  // concurrent winner mid-flight). The chain never rejects (we swallow the tail so one
  // failed write does not poison the queue); the real error still propagates to its caller.
  async _write(opts) {
    const run = (this._writeChain ?? Promise.resolve()).then(() => this.#writeNow(opts));
    // Keep the chain alive regardless of THIS write's outcome so the next queued write runs.
    this._writeChain = run.then(() => {}, () => {});
    return run;
  }
  async #writeNow(opts) {
    if (this._nonce == null) this._nonce = await this.pub.getTransactionCount({ address: this.account.address, blockTag: 'pending' });
    const nonce = this._nonce;
    try { const hash = await this.wallet.writeContract({ ...opts, nonce }); this._nonce = nonce + 1; return hash; }
    catch (e) { this._nonce = null; throw e; }
  }
  async _transfer(to, atomic) { return this._confirm(await this._write({ address: this.usdc, abi: ERC20, functionName: 'transfer', args: [to, atomic] })); }
  async _approveAndWait(spender, atomic) {
    await this._confirm(await this._write({ address: this.usdc, abi: ERC20, functionName: 'approve', args: [spender, atomic] }));
    for (let i = 0; i < 12; i++) { if ((await this.pub.readContract({ address: this.usdc, abi: ERC20, functionName: 'allowance', args: [this.account.address, spender] })) >= atomic) break; await new Promise((r) => setTimeout(r, 1500)); }
  }
  // Build (but don't submit) a signed EIP-3009 authorization. Returns a JSON-safe
  // authorization (bigints as strings) + the 65-byte signature.
  async _buildAuth(to, atomic, nonce) {
    const name = await this.pub.readContract({ address: this.usdc, abi: ERC20, functionName: 'name' });
    let version = '2'; try { version = await this.pub.readContract({ address: this.usdc, abi: ERC20, functionName: 'version' }); } catch {}
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const message = { from: this.account.address, to, value: atomic, validAfter: 0n, validBefore, nonce };
    const signature = await this.account.signTypedData({
      domain: { name, version, chainId: this.chainId, verifyingContract: this.usdc },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
      primaryType: 'TransferWithAuthorization', message,
    });
    return { authorization: { from: this.account.address, to, value: atomic.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce }, signature };
  }
  // Submit a built authorization ourselves (we pay the gas).
  async _submitAuthSelf({ authorization: a, signature }) {
    const r = signature.slice(0, 66), s = '0x' + signature.slice(66, 130), v = parseInt(signature.slice(130, 132), 16);
    return this._confirm(await this._write({ address: this.usdc, abi: TWA, functionName: 'transferWithAuthorization', args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, r, s] }));
  }
  // Contract-mode recovery read. After payDraw errors, callers distinguish a confirmed
  // on-chain draw from confirmed None and from an unavailable/lagging RPC. payDraw itself is
  // idempotent by drawId (it reverts DrawAlreadyExists once status != None).
  // Returns one of DRAW_STATUS (None=unpaid, Paid, Affirmed, Disputed), or null when the
  // read itself failed. Conflating an unavailable RPC with confirmed None can authorize a
  // second payment after an ambiguous first submission.
  async _drawStatus(contractAddress, drawId) {
    try {
      const rec = await this.pub.readContract({ address: contractAddress, abi: DRIP_LEDGER, functionName: 'draws', args: [drawId] });
      // DrawRecord is (buyerAgentKey, sellerAgentKey, buyer, sellerUsdAtomic, feeUsdAtomic,
      // paidAt, status): status is index 6. #543 added `address buyer` at index 2; the ABI +
      // this index MUST track it or the replay/terminal-idempotency guard reads paidAt as status.
      return Number(rec?.[6] ?? DRAW_STATUS.None);
    } catch { return null; }
  }

  async _payDraw(contractAddress, payment, { onSubmitted } = {}) {
    // #451: USDC approve is an absolute SET, not an increment, and this
    // approve-then-payDraw sequence has awaits between the legs. Two concurrent
    // draws on ONE client (blessed: a watchAndFill payDraw while another watcher
    // acts) would clobber each other's allowance -- B's approve lands between A's
    // approve and A's payDraw, so A pulls against B's smaller allowance and
    // reverts. The per-_write nonce chain (#419) only orders individual txs, not
    // this logical PAIR. Serialize the whole approve+payDraw so concurrent callers
    // queue and each draw's allowance is intact when its payDraw runs.
    const run = (this._drawChain ?? Promise.resolve()).then(async () => {
      const total = BigInt(payment.sellerUsdAtomic) + BigInt(payment.feeUsdAtomic || 0n);
      try {
        await this._approveAndWait(contractAddress, total);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.paymentUnpaid = true;
        error.paymentStage = 'approve';
        throw error;
      }
      let hash;
      try {
        hash = await this._write({ address: contractAddress, abi: DRIP_LEDGER, functionName: 'payDraw', args: [payment] });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.paymentStage = 'submit';
        throw error;
      }
      if (onSubmitted) {
        try {
          await onSubmitted(hash);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          error.txHash = hash;
          error.paymentSubmitted = true;
          error.paymentStage = 'persist_submission';
          throw error;
        }
      }
      try {
        return await this._confirm(hash);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.txHash = hash;
        error.paymentStage = 'confirm';
        if (/tx reverted/i.test(String(error?.message ?? error))) error.paymentUnpaid = true;
        else error.paymentSubmitted = true;
        throw error;
      }
    });
    // Keep the chain alive regardless of THIS draw's outcome so the next queued
    // draw still runs (mirrors _write's tail-swallow).
    this._drawChain = run.then(() => {}, () => {});
    return run;
  }
  async bindAgentWallet({ contractAddress, deadline } = {}) {
    const target = contractAddress ?? (await this._req('GET', '/config', null, false)).body?.dripContractAddress;
    if (!target) throw new Error('bindAgentWallet: no dripContractAddress configured');
    if (!this.agentId || !this.apiKey) throw new Error('bindAgentWallet: register first');
    const agentKey = await this.pub.readContract({ address: target, abi: DRIP_LEDGER, functionName: 'agentKeyFor', args: [this.agentId] });
    const nonce = await this.pub.readContract({ address: target, abi: DRIP_LEDGER, functionName: 'bindNonces', args: [agentKey] });
    const r = await this._req('POST', '/agents/bind-wallet', {
      wallet: this.account.address,
      contractAddress: target,
      nonce: nonce.toString(),
      deadline: String(deadline ?? Math.floor(Date.now() / 1000) + 3600),
    });
    if (r.status !== 200) throw new Error('bindAgentWallet failed: ' + JSON.stringify(r.body));
    const b = r.body.binding;
    const hash = await this._write({
      address: target,
      abi: DRIP_LEDGER,
      functionName: 'bindAgent',
      args: [b.agentId, b.wallet, BigInt(b.deadline), b.signature],
    });
    return this._confirm(hash);
  }
  async ensureAgentBound({ contractAddress } = {}) {
    const target = contractAddress ?? (await this._req('GET', '/config', null, false)).body?.dripContractAddress;
    if (!target) throw new Error('ensureAgentBound: no dripContractAddress configured');
    if (!this.agentId) throw new Error('ensureAgentBound: register first');
    const agentKey = await this.pub.readContract({ address: target, abi: DRIP_LEDGER, functionName: 'agentKeyFor', args: [this.agentId] });
    const bound = await this.pub.readContract({ address: target, abi: DRIP_LEDGER, functionName: 'agentWallet', args: [agentKey] });
    if (String(bound).toLowerCase() === String(this.account.address).toLowerCase()) return null;
    return this.bindAgentWallet({ contractAddress: target });
  }
  async _drawIdFor(contractAddress, payment) {
    return this.pub.readContract({ address: contractAddress, abi: DRIP_LEDGER, functionName: 'drawIdFor', args: [payment] });
  }
  // Read-your-write guard for the affirm/dispute-after-pay race (mtok-market#419). We just
  // confirmed payDraw, but viem's fallback transport can route the very next call to a Base
  // node that has not yet indexed that block, so affirmDraw/disputeDraw revert DrawNotPaid
  // against a lagging node and strand a paid draw. Two lines of defense: (1) poll the draw
  // status until at least one node reports it past None (the pay is propagating), then (2)
  // retry the WRITE itself on a DrawNotPaid revert with backoff, since the write can still land
  // on a node behind the one we polled. A draw already Affirmed/Disputed short-circuits to done.
  async _submitTerminalDraw(fnName, contractAddress, drawId, args, terminalStatus) {
    for (let i = 0; i < 8; i++) {
      const status = await this._drawStatus(contractAddress, drawId);
      if (status === terminalStatus) return null; // already in the target terminal state (a prior attempt landed)
      if (status != null && status !== DRAW_STATUS.None) break; // Paid and visible on at least one node: safe to submit
      await new Promise((r) => setTimeout(r, 1500));
    }
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      // Re-check status before EVERY attempt, not just the first. A prior attempt's write can
      // land on-chain and then have its RESPONSE lost (a fallback-node blip makes writeContract
      // throw after the tx was already mined). Without this, the retry fires a second terminal
      // call that reverts "already terminal" with a non-retryable error and strands the draw.
      if (attempt > 0 && (await this._drawStatus(contractAddress, drawId)) === terminalStatus) return null;
      try {
        return await this._confirm(await this._write({ address: contractAddress, abi: DRIP_LEDGER, functionName: fnName, args }));
      } catch (e) {
        lastErr = e;
        // Only the read-your-write races are retryable: a node behind on the payDraw
        // (DrawNotPaid), or a submit that raced a still-mining pay. A real revert (over-affirm,
        // wrong caller, already terminal) is not, so rethrow anything else immediately. Match
        // BOTH the decoded custom-error name AND its raw 4-byte selector 0x53ebc06d: viem
        // usually decodes DrawNotPaid from the ABI, but some fallback-transport error paths
        // surface only the undecoded revert data, and missing that would strand the draw.
        const msg = String(e?.message ?? e);
        if (!/DrawNotPaid|0x53ebc06d|nonce|replacement|already known/i.test(msg)) throw e;
        this._nonce = null; // resync the local nonce before the retry
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
  async _affirmDraw(contractAddress, drawId, { inputTokens, outputTokens, deliveredUsdAtomic, responseHash }) {
    return this._submitTerminalDraw('affirmDraw', contractAddress, drawId, [drawId, BigInt(inputTokens), BigInt(outputTokens), BigInt(deliveredUsdAtomic), responseHash], DRAW_STATUS.Affirmed);
  }
  async _disputeDraw(contractAddress, drawId, reasonHash) {
    return this._submitTerminalDraw('disputeDraw', contractAddress, drawId, [drawId, reasonHash], DRAW_STATUS.Disputed);
  }

  // ---- on-chain buy-side bids (MtokBidBoard, #419) ----
  // Bidding is wallet-keyed: no platform registration, no API key. You pay gas
  // to advertise a commitment on the public board; that gas IS the spam filter.
  _bidBoardAddress(contractAddress, fn) {
    const target = contractAddress ?? PINNED_BID_BOARD_ADDRESSES[this.chainId];
    if (!target) throw new Error(`${fn}: no bid board pinned for chain ${this.chainId}; pass contractAddress`);
    return target;
  }
  // Post a bid: "I will buy <tokens> of <model> at or under these USD/MTok
  // ceilings, until expiresAt". Prices are plain USD/MTok (converted to the
  // contract's atomic 1e6 units here). TTL is capped at 24h ON CHAIN
  // (ExpiryTooFar); the clamp below just saves you the reverted gas.
  async postBid({ model, maxInputPricePerMTok = 0, maxOutputPricePerMTok = 0, inputTokens = 0, outputTokens = 0, ttlSeconds = 3600, contractAddress } = {}) {
    if (!model) throw new Error('postBid: model is required');
    const target = this._bidBoardAddress(contractAddress, 'postBid');
    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.min(Math.max(1, Math.trunc(Number(ttlSeconds) || 0)), BID_MAX_TTL_SECONDS));
    const txHash = await this._confirm(await this._write({
      address: target, abi: BID_BOARD, functionName: 'postBid',
      args: [model, usdToAtomic(maxInputPricePerMTok), usdToAtomic(maxOutputPricePerMTok), BigInt(inputTokens), BigInt(outputTokens), expiresAt],
    }));
    // The bidId rides in the receipt as BidPosted's first indexed topic.
    const receipt = await this.pub.getTransactionReceipt({ hash: txHash });
    const posted = (receipt?.logs ?? []).find((l) => String(l.address).toLowerCase() === target.toLowerCase() && l.topics?.[0] === BID_POSTED_TOPIC);
    return {
      txHash, bidId: posted?.topics?.[1] ?? null,
      model, maxInputPricePerMTok, maxOutputPricePerMTok, inputTokens, outputTokens,
      expiresAt: Number(expiresAt),
    };
  }
  // Cancel a live bid (poster only). Cancelling when you stop watching keeps
  // the public board honest and protects your wallet's bid reputation.
  async cancelBid(bidId, { contractAddress } = {}) {
    return this._confirm(await this._write({ address: this._bidBoardAddress(contractAddress, 'cancelBid'), abi: BID_BOARD, functionName: 'cancelBid', args: [bidId] }));
  }
  // The honesty breadcrumb: link a bid to the MtokDripLedger draw that
  // satisfied it. Optional to call, but calling it is what builds your
  // wallet's public fill score (posted vs filled vs walked-away, all
  // chain-derived, recomputable by anyone).
  async fillBid(bidId, drawId, { contractAddress } = {}) {
    return this._confirm(await this._write({ address: this._bidBoardAddress(contractAddress, 'fillBid'), abi: BID_BOARD, functionName: 'fillBid', args: [bidId, drawId] }));
  }
  // Watch the market for an ask that crosses the bid's ceilings, draw through
  // the existing spot flow, fillBid the satisfying draw. See src/bids.mjs.
  async watchAndFill(opts = {}) { return watchAndFillClient(this, opts); }

  async _walletBalances() { return walletBalances(this); }

  async ensureFundedFor(budget, opts = {}) { return ensureFundedForClient(this, budget, opts); }

  async drawFromSeller(opts = {}) { return drawFromSellerClient(this, opts); }

  // Send structured feedback (write-only telemetry; NEVER affects your reputation).
  // payload: { phase, ok, code?, expected?, note?, role?, ref?, sdk? }
  async feedback(payload) {
    const r = await this._req('POST', '/feedback', payload ?? {});
    return r.body;
  }

  async buy(opts = {}) { return buyClient(this, opts); }
}

// Lowercase alias so the served sdk.mjs is importable as `mtok` (matching client.mjs's
// `mtok` export and the house style), e.g. `const { mtok } = await import('.../sdk.mjs')`.
// Both `Mtok` and `mtok` name the same class.
export { Mtok as mtok };
