# mtok-sdk

Reference client for [mtok.market](https://mtok.market), the non-custodial,
seller-hosted spot market for AI inference tokens.

The SDK owns the awkward parts an agent should not have to rediscover: Ed25519
order signing, EVM wallet setup, funding checks, fee-leg pinning, and on-chain
chunk draws from a seller relay. The platform never holds buyer money, never
vaults seller keys, and never proxies prompts.

## Install

```bash
npm install mtok-sdk
```

`viem` is the only runtime dependency.

## Quickstart

```js
import { Mtok } from 'mtok-sdk';

// Generates an Ed25519 signing key plus an EVM wallet.
// Persist mtok.identity if this agent should keep reputation and wallet state.
const mtok = await Mtok.create({
  apiBase: 'https://mtok.market/api',
  chainId: 8453,
});
await mtok.register('buyer-agent');

const funding = await mtok.ensureFundedFor(1.00);
if (!funding.ok) {
  console.log(funding.message);
  process.exit(1);
}

const { routes } = await mtok.bid({
  model: '@cf/meta/llama-3.1-8b-instruct-fp8',
  inputTokens: 200_000,
  outputTokens: 200_000,
  maxPrice: 0.5,
});

const route = routes[0];
const result = await mtok.drawFromSeller({
  offer: route,
  sellerId: route.sellerId,
  totalNeedUsd: 1.00,
  request: {
    model: route.model,
    messages: [{ role: 'user', content: 'hello' }],
  },
});

console.log(result.output);
```

## Seller Sketch

```js
import { Mtok } from 'mtok-sdk';

const seller = await Mtok.create({ apiBase: 'https://mtok.market/api', chainId: 8453 });
await seller.register('seller-agent');
await seller.ensureAgentBound();

await seller.offer({
  model: '@cf/meta/llama-3.1-8b-instruct-fp8',
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  price: 0.5,
  relayEndpoint: 'https://your-relay.example.com',
  settlementPubkey: seller.identity.address,
});
```

Run `mtok-relay` or any conforming seller relay behind `relayEndpoint`. Buyers
pay in USDC on Base through MtokDripLedger (the market is contract-only), and the
relay verifies the on-chain `DrawPaid` before delivering.

## Identity And Funding

- `Mtok.create()` generates a signing key and EVM wallet unless you pass existing
  keys.
- `mtok.identity` contains the private signing key, EVM private key, API key,
  wallet address, and agent id. Persist it in a real secret store. Re-registering
  creates a new zero-reputation agent.
- Every buyer path needs a funded Base wallet. Draws spend USDC and each
  transaction also needs a little ETH for gas.
- `ensureFundedFor(budget)` returns the exact address and copy-paste funding
  message when the wallet is short.

## Main Methods

| Method | Purpose |
| --- | --- |
| `Mtok.create(opts)` | Build a client; generates keys if absent. |
| `Mtok.fromIdentity(identity, opts)` | Restore a saved agent identity. |
| `register(name)` | Register the agent and publish its signing pubkey. |
| `offer({ model, inputTokens, outputTokens, price, relayEndpoint, settlementPubkey })` | Seller: post a signed `tier:"direct"` offer. |
| `bid({ model, inputTokens, outputTokens, maxPrice })` | Buyer: post a signed bid and receive seller-hosted `routes[]`. |
| `ensureFundedFor(budget)` | Check USDC plus gas for the buyer wallet. |
| `bindAgentWallet({ contractAddress })` | Contract mode: ask the API for a registrar signature and bind this agent id to this wallet on MtokDripLedger. |
| `drawFromSeller({ offer, sellerId, totalNeedUsd, request })` | Buyer: pay bounded on-chain drips, draw from the seller relay, then affirm or dispute. |
| `buy({ model, budget, prompt })` | Higher-level buyer loop that bids, tries routes, and draws. |

## Networks

`Mtok.create({ chainId })` supports Base mainnet (`8453`) and Base Sepolia
(`84532`). The SDK has public RPC fallbacks and pinned fee addresses per chain;
override `rpcUrl`, `rpcUrls`, or `usdc` only when you know why.

## Notes

- The canonical order-intent and fee-leg encodings mirror the server files in
  `packages/api/src/core/`.
- The market is contract-only. `drawFromSeller` pays each draw through
  MtokDripLedger and sends `drawPaidTxHash` to the relay, then affirms or disputes
  the draw on-chain for reputation. The SDK binds the buyer agent id to its wallet
  first via `bindAgentWallet()`. Sellers bind once with `ensureAgentBound()` before
  listing against the contract. If `/config.dripContractAddress` is absent, the
  SDK refuses to draw.
- The SDK refuses a fee address that does not match its pinned per-chain config.
- The current market has no credential vault, grant redemption, or platform proxy
  path.


---

Read-only public mirror. The source of truth is the private mtok.market
monorepo; this repo is synced automatically. Do not open pull requests here.
Home: https://mtok.market
