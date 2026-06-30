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
// Self-contained: node:crypto (order signing) + viem (EVM). The canonicalIntent +
// legNonce below MUST match the server's packages/api/src/core/{signed-orders,settlement}.js.
import crypto from 'node:crypto';
import { createWalletClient, createPublicClient, http, fallback, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, base } from 'viem/chains';

// ---- canonical encoding (must match signed-orders.js) ----
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => ((o[k] = stable(v[k])), o), {});
  return v;
}
const canonicalIntent = (intent) => JSON.stringify(stable(intent));
const signIntent = (intent, privKey) => crypto.sign(null, Buffer.from(canonicalIntent(intent)), privKey).toString('base64url');
// per-leg settlement nonce (must match settlement.js legNonce)
const legNonce = (base, label) => '0x' + crypto.createHash('sha256').update(Buffer.from(String(base).replace(/^0x/, ''), 'hex')).update(String(label)).digest('hex');
const usdToAtomic = (u) => BigInt(Math.round(Number(u) * 1e6));
const requiresFeeLeg = ({ amountUsd, feeAddress, feeBps, dustThresholdUsd = 0.001 }) => {
  const amount = Number(amountUsd) || 0;
  const bps = Number(feeBps) || 0;
  const dust = Number(dustThresholdUsd) || 0.001;
  return Boolean(feeAddress) && bps > 0 && amount >= dust && amount * bps / 10000 > 0;
};
const ETH_GAS_RESERVE = 0.0005; // ~enough native gas for several Base txns

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function version() view returns (string)',
]);
const TWA = parseAbi(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
const META = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)', 'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)']);
// #64: canonical platform fee addresses, pinned per chain so a tampered /api/config
// cannot redirect the fee leg. Public, stable platform treasury addresses (also in
// apps/site/static/llms.txt + the buying guide so non-SDK agents can pin them too).
export const PINNED_FEE_ADDRESSES = {
  8453: '0x6B5FED4aca54Ca89d95b822fD64c8545D34B673b',  // Base mainnet (mtok.market)
  84532: '0x25EFcbfD32C3f769690aA1181d48565f69c855E1', // Base Sepolia (staging/testnet)
};

export class Mtok {
  constructor(cfg) { Object.assign(this, cfg); }

  // Create a client. Generates a signing key + EVM wallet if not supplied. Persist
  // `mtok.identity` (the two private keys + apiKey) to reuse the same agent.
  static async create({
    apiBase = 'https://mtok.market/api',
    chainId = 84532,                                  // 84532 Base Sepolia | 8453 Base mainnet
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
  // > 0 — price-0 is banned (dust = gas-only/free, a real price above dust = paid).
  // payoutAddress is REQUIRED by the non-custodial server (where buyers pay you); it
  // is signed INTO the intent params (the router rebuilds the order from intent.params).
  // For a direct offer it is the same wallet as settlementPubkey, so it defaults to it.
  async offer({ model, inputTokens, outputTokens, price, relayEndpoint, settlementPubkey, payoutAddress, usableForSeconds = 3600, recurring = false }) {
    if (!(Number(price) > 0)) throw new Error('offer: price must be > 0 (price-0 is banned; use a tiny dust price for gas-only/free)');
    const params = { inputTokens, outputTokens, inputPricePerMTok: price, outputPricePerMTok: price, tier: 'direct', relayEndpoint, settlementPubkey, payoutAddress: payoutAddress ?? settlementPubkey, usableForSeconds, recurring };
    const r = await this._req('POST', '/offers', this._sign('offer', model, params));
    if (r.status !== 201) throw new Error('offer failed: ' + JSON.stringify(r.body));
    return r.body.order;
  }
  async bid({ model, inputTokens, outputTokens, maxPrice = 0 }) {
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
  async _write(opts) {
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
  // Has this EIP-3009 nonce already been spent on-chain? (a prior, possibly-stranded attempt)
  async _authUsed(nonce) {
    try { return await this.pub.readContract({ address: this.usdc, abi: META, functionName: 'authorizationState', args: [this.account.address, nonce] }); } catch { return false; }
  }
  // Recover the tx hash of an already-spent authorization by its nonce, so a half-paid
  // grant can be redeemed on retry instead of re-submitting (which would revert/reject).
  async _findAuthTx(nonce) {
    try {
      const latest = await this.pub.getBlockNumber();
      // ~1h of Base 2s blocks; EIP-3009 auths expire in 1h so the tx is within this window,
      // and the range stays small enough for public RPCs that cap getLogs spans.
      const logs = await this.pub.getLogs({ address: this.usdc, event: META[1], args: { authorizer: this.account.address, nonce }, fromBlock: latest > 2000n ? latest - 2000n : 0n, toBlock: 'latest' });
      return logs.length ? logs[logs.length - 1].transactionHash : null;
    } catch { return null; }
  }

  // ---- buyer fund-relay (self-fund / "option B") ----
  // Read the buyer wallet's on-chain USDC + ETH balances. Returns atomic bigints.
  async _walletBalances() {
    const [usdc, eth] = await Promise.all([
      this.pub.readContract({ address: this.usdc, abi: ERC20, functionName: 'balanceOf', args: [this.account.address] }),
      this.pub.getBalance({ address: this.account.address }),
    ]);
    return { usdc, eth };
  }

  // The one human step: fund the buyer wallet. Reads on-chain balances and returns a
  // structured ask the agent both acts on and relays to its human verbatim. usdc need =
  // budget + the platform fee leg (feeBps); eth need = a small gas reserve. Estimates;
  // documented in the buying guide.
  async ensureFundedFor(budget, { feeBps = 250 } = {}) {
    const usdcNeed = round6Usd(Number(budget) * (1 + (Number(feeBps) || 0) / 10000));
    const ethNeed = ETH_GAS_RESERVE;
    const bal = await this._walletBalances();
    const haveUsdc = Number(bal.usdc) / 1e6;
    const haveEth = Number(bal.eth) / 1e18;
    const shortUsdc = round6Usd(Math.max(0, usdcNeed - haveUsdc));
    const shortEth = Math.max(0, ethNeed - haveEth);
    const ok = shortUsdc <= 0 && shortEth <= 1e-9; // sub-gwei float dust counts as funded
    const address = this.account.address;
    const explorerBase = this.chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org';
    const message = ok ? null
      : `Send ${shortUsdc} USDC + ~${shortEth.toFixed(4)} ETH to ${address} on Base (chain ${this.chainId}).`;
    return {
      ok, address, chainId: this.chainId,
      need: { usdc: usdcNeed, eth: ethNeed },
      have: { usdc: round6Usd(haveUsdc), eth: haveEth },
      shortfall: { usdc: shortUsdc, eth: shortEth },
      message, explorerUrl: `${explorerBase}/address/${address}`,
    };
  }

  // ---- direct-tier buyer: prepaid-balance draws from a seller's relay (#129) ----
  //
  // The booking is a STANDING PREPAID BALANCE. The flow is fund-then-draw:
  //   • FUND (on-chain): pay the seller's settlement address + the fee leg, prove it
  //     on-chain, and POST a FUND /chunk. This ADDS to the booking balance (paidUsd).
  //     One payment funds many draws; gas is amortized. Validation-first sizing:
  //       fund 0: min(CHUNK_FLOOR, totalNeedUsd) — tiny first top-up regardless of rep
  //       fund N>0: min(remaining budget, recommendedMaxChunkUsd) — scale toward rep cap
  //   • DRAW (off-chain): POST a DRAW /chunk with { bookingId, request }. The relay
  //     meters ACTUAL usage and deducts it (usedUsd); the response carries the new
  //     remainingUsd. The buyer pays only for what it uses.
  // Before each request we ensure remainingUsd covers an estimate; if not (and budget
  // remains) we FUND first. totalNeedUsd is the HARD CAP on funding — the buyer's max
  // loss is the funded balance, which stays small.
  //
  // On a bad/missing completion (wrong model / empty choices / missing usage / relay
  // error / signer error): DISPUTE + stop. On all requests delivered: AFFIRM.
  //
  // Settlement model (#114): the BUYER submits each FUND's EIP-3009
  // transferWithAuthorization via their own wallet and gets back a CONFIRMED txHash;
  // the relay only VERIFIES those tx hashes on-chain (read-only). DRAWs carry no payment.
  //
  // Injectables (for testing without network/chain):
  //   relayFetch(params) — async fn that POSTs to the relay; default: real fetch
  //   signChunkAuth(params) — async fn that signs+submits a FUND payment leg and
  //     returns the confirmed txHash; default: real EIP-3009 via _buildAuth+_submitAuthSelf
  //   _stubApi — { reputation, affirm, dispute, config } — default: real platform API calls
  //
  // CHUNK_FLOOR = 0.10 (matches DEFAULT_REP_KNOBS.chunkFloorUsd in packages/api/src/core/reputation.js)
  async drawFromSeller({
    offer,          // { id, tier, relayEndpoint, model, inputPricePerMTok, outputPricePerMTok, agentId, settlementPubkey }
    totalNeedUsd,   // HARD CAP on total USD to FUND across the run
    sellerId,       // seller's agentId (for reputation lookup)
    bookingId,      // existing booking id to reuse (optional; else established by first FUND)
    request,        // a single inference request, OR pass `requests` for several
    requests,       // optional array of inference requests to deliver, each a DRAW
    relayFetch,     // injectable relay POST fn; default: this.relayFetch or real fetch
    signChunkAuth,  // injectable signer; default: this.signChunkAuth or real EIP-3009
    feeBps = 250,   // platform fee in basis points (must stay in sync with server-side default)
  } = {}) {
    const CHUNK_FLOOR = 0.10; // must stay in sync with DEFAULT_REP_KNOBS.chunkFloorUsd

    // Resolve injectables — prefer call-site overrides, then instance-level overrides, then real defaults.
    const _relayFetch = relayFetch ?? this.relayFetch ?? (async (params) => {
      const url = offer.relayEndpoint.replace(/\/$/, '') + '/chunk';
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
      return r.json();
    });

    // Default signer: build the EIP-3009 authorization AND submit it from the buyer's
    // wallet (we pay the gas), returning the CONFIRMED txHash the relay will verify.
    const _signChunkAuth = signChunkAuth ?? this.signChunkAuth ?? (async (params) => {
      if (!this.account) throw new Error('drawFromSeller: no EVM account; pass signChunkAuth or call Mtok.create()');
      const built = await this._buildAuth(params.to, usdToAtomic(params.amountUsd), params.nonce);
      return this._submitAuthSelf(built);
    });

    const _api = this._stubApi ?? {
      reputation: async (sid) => {
        const r = await this._req('GET', `/agents/${encodeURIComponent(sid)}/reputation`);
        if (r.status !== 200) throw new Error('reputation lookup failed: ' + JSON.stringify(r.body));
        return r.body.reputation ?? r.body;
      },
      affirm: async (id) => {
        const r = await this._req('POST', `/bookings/${encodeURIComponent(id)}/affirm`, {});
        if (r.status !== 200 && r.status !== 204) throw new Error('affirm failed: ' + JSON.stringify(r.body));
      },
      dispute: async (id) => {
        const r = await this._req('POST', `/bookings/${encodeURIComponent(id)}/dispute`, {});
        if (r.status !== 200 && r.status !== 204) throw new Error('dispute failed: ' + JSON.stringify(r.body));
      },
      config: async () => {
        const r = await this._req('GET', '/config', null, false);
        if (r.status !== 200) throw new Error('config fetch failed: ' + JSON.stringify(r.body));
        return r.body;
      },
    };

    // The requests to deliver (each a DRAW). `requests` wins; else a single `request`;
    // else a single null request (lets a caller fund+probe without a payload).
    const reqList = Array.isArray(requests) && requests.length ? requests : [request ?? null];

    // 1. Fetch seller reputation and platform config (once, before the loop).
    const rep = await _api.reputation(sellerId);
    const recommendedMaxChunkUsd = rep.recommendedMaxChunkUsd ?? CHUNK_FLOOR;
    const config = await _api.config();
    // #64: the platform fee address is a fixed per-chain constant. PIN it and refuse a
    // /api/config that disagrees, so a tampered or MITM'd config cannot redirect the
    // buyer's 2.5% fee leg to an attacker. (The platform also verifies the fee leg
    // server-side against its own address, so a mismatch would fail the trade anyway;
    // this stops the buyer paying the wrong address in the first place.) Unknown chains
    // have no pin and fall back to the fetched value.
    const pinnedFee = PINNED_FEE_ADDRESSES[this.chainId];
    if (pinnedFee && String(config.feeAddress || '').toLowerCase() !== pinnedFee.toLowerCase()) {
      throw new Error(`fee_address_mismatch: /api/config returned ${config.feeAddress} for chain ${this.chainId} but the pinned platform fee address is ${pinnedFee}. Refusing to pay a possibly-tampered fee address.`);
    }
    // #320: pin the fee RATE too, not just the address. The fee leg amount used to trust
    // config.feeBps from the unauthenticated /api/config -- a tampered/compromised config could set
    // feeBps huge and the buyer would sign a giant fee leg to the (correctly pinned) treasury (the
    // platform verifies only a MINIMUM fee, so over-payment passes). On a pinned chain, use our
    // expected feeBps and ignore the fetched rate; unknown chains fall back to config (same caveat
    // as the address). This also keeps the fee bounded so it can't blow past totalNeedUsd.
    const feeRateBps = pinnedFee ? feeBps : (Number(config.feeBps) || feeBps);
    const dustThresholdUsd = Number(config.dustThresholdUsd) || 0.001;

    // Estimate a draw's cost (USD) so we know when to top up. Use the offer's output
    // price against the request's max_tokens (a generous upper bound; actual metered
    // usage is what gets deducted). Falls back to the floor when no hint is available.
    const outPrice = Number(offer.outputPricePerMTok) || 0;
    const estimateCost = (r) => {
      const maxOut = Number(r?.max_tokens) || 0;
      if (outPrice > 0 && maxOut > 0) return (maxOut / 1e6) * outPrice;
      return CHUNK_FLOOR; // unknown size → assume a floor-sized draw
    };

    let remainingBudget = totalNeedUsd;      // funding budget left (hard cap)
    let remainingUsd = 0;                     // current booking balance (off-chain)
    let fundN = 0;                            // FUND chunk counter (sizing + idempotency n)
    let drawN = 0;                            // DRAW counter (idempotency n)
    let fundedUsd = 0;                        // total on-chain funded (chunk USD)
    let drawnUsd = 0;                         // total metered usage actually drawn
    const chunks = [];
    const outputParts = [];
    let activeBookingId = bookingId ?? null;

    // FUND one on-chain top-up: sign both legs, POST a FUND /chunk, update balance.
    // Returns { ok, error? }. On a signer/packages/relay/report failure, ok=false (caller disputes).
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
          priceUsd: chunkUsd, model: offer.model, buyerId: this.agentId,
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

    // 2. Deliver each request, funding first whenever the balance is short.
    for (const reqItem of reqList) {
      const est = estimateCost(reqItem);

      // Ensure the balance can fund this draw; top up if short and budget remains.
      while (remainingUsd < est && remainingBudget > 0.0001) {
        const f = await doFund(est);
        if (!f.ok) {
          if (activeBookingId) await _api.dispute(activeBookingId).catch(() => {});
          return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: true, affirmed: false };
        }
      }

      // If we still can't fund a draw (budget cap hit), stop cleanly: affirm what we got.
      if (remainingUsd <= 1e-6) break;

      // DRAW: no payment, just the booking + the request. The relay meters actual
      // usage and returns the post-draw remainingUsd.
      let completion, drawError;
      try {
        completion = await _relayFetch({ bookingId: activeBookingId, n: drawN, model: offer.model, buyerId: this.agentId, request: reqItem });
      } catch (e) {
        drawError = e;
      }

      const isGood = !drawError
        && completion
        && Array.isArray(completion.choices)
        && completion.choices.length > 0
        && (completion.choices[0]?.message?.content ?? '').trim().length > 0 // #320: '' != null is true; an EMPTY completion is non-delivery -> dispute, don't affirm
        && completion.model === offer.model
        && completion.usage != null;

      const usedThisDraw = isGood ? round6Usd(meterUsd(completion.usage, offer)) : 0;
      chunks.push({ kind: 'draw', n: drawN, completion: isGood ? completion : null, usedUsd: usedThisDraw, remainingUsd: completion?.remainingUsd ?? remainingUsd, error: drawError?.message ?? completion?.error ?? null });

      if (!isGood) {
        // Bad draw — dispute and stop. Max loss = the funded balance (kept small).
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

    // 3. All requests delivered — affirm and return the summary.
    if (activeBookingId) await _api.affirm(activeBookingId).catch(() => {});
    return { output: outputParts.join(''), chunks, drawnUsd, fundedUsd, disputed: false, affirmed: true };
  }

  // Send structured feedback (write-only telemetry; NEVER affects your reputation).
  // payload: { phase, ok, code?, expected?, note?, role?, ref?, sdk? }
  async feedback(payload) {
    const r = await this._req('POST', '/feedback', payload ?? {});
    return r.body;
  }

  // One-call buyer convenience over the explicit steps. Discovers via the book (a free
  // read), gates on funding, then tries crossing tier:direct offers cheapest-first,
  // drawing against each via drawFromSeller (which funds the floor first, tops up toward
  // the seller's recommendedMaxChunkUsd within budget, meters usage, and affirms/disputes).
  // Returns a STATUS OBJECT (never throws on an expected outcome) so an agent can branch
  // without try/catch: { status: 'ok' | 'funding_required' | 'no_offers' | 'all_disputed' }.
  //   buy({ model, budget, prompt | messages | requests, maxPrice?, sellerId? })
  //   budget is the hard funding cap (== drawFromSeller totalNeedUsd) and your max loss.
  async buy({ model, budget, prompt, messages, requests, maxPrice = 0, sellerId } = {}) {
    if (!model || !(Number(budget) > 0)) throw new Error('buy: model and a positive budget are required');
    const reqList = Array.isArray(requests) && requests.length
      ? requests
      : [{ model, messages: messages ?? [{ role: 'user', content: String(prompt ?? '') }], max_tokens: 256 }];

    // 1. Fund gate — surface the human ask if short, do nothing on-chain.
    const funding = await this.ensureFundedFor(budget);
    if (!funding.ok) return { status: 'funding_required', funding };

    // 2. Discover via the book (free read). Filter to open direct offers within maxPrice.
    const book = await this._req('GET', `/book?model=${encodeURIComponent(model)}`);
    let offers = (book.body?.offers || []).filter((o) =>
      o.tier === 'direct' && o.status === 'open'
      && (!sellerId || o.agentId === sellerId)
      && (!(maxPrice > 0) || (Number(o.outputPricePerMTok) <= maxPrice && Number(o.inputPricePerMTok) <= maxPrice)));
    offers.sort((a, b) => (Number(a.outputPricePerMTok) || 0) - (Number(b.outputPricePerMTok) || 0));
    if (!offers.length) return { status: 'no_offers', model, maxPrice };

    // 3. Try cheapest-first; a bad/disputed draw moves to the next route.
    const tried = [];
    for (const o of offers) {
      const offer = { id: o.id, tier: 'direct', relayEndpoint: o.relayEndpoint, model, inputPricePerMTok: o.inputPricePerMTok, outputPricePerMTok: o.outputPricePerMTok, settlementPubkey: o.settlementPubkey, agentId: o.agentId };
      const res = await this.drawFromSeller({ offer, totalNeedUsd: budget, sellerId: o.agentId, requests: reqList });
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
}

// Metered USD of an OpenAI-shaped usage block at the offer's per-MTok prices.
function meterUsd(usage, offer) {
  const inTok = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outTok = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  return (inTok * (Number(offer.inputPricePerMTok) || 0) + outTok * (Number(offer.outputPricePerMTok) || 0)) / 1e6;
}
const round6Usd = (n) => Math.round(n * 1e6) / 1e6;

// Lowercase alias so the served sdk.mjs is importable as `mtok` (matching client.mjs's
// `mtok` export and the house style), e.g. `const { mtok } = await import('.../sdk.mjs')`.
// Both `Mtok` and `mtok` name the same class.
export { Mtok as mtok };
