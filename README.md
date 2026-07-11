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

## Batch Jobs

For list classification, extraction, tagging, or summarization, split the work
into model-safe chunks and ask for JSON indexes instead of copied labels.

```js
import { Mtok, buildIndexedJsonBatch, parseIndexedJsonList } from 'mtok-sdk';

const model = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const labels = ['Boom Boom', 'Grandma', 'the weather'];

const { chunks, requests } = buildIndexedJsonBatch(labels, {
  model,
  chunkSize: 60,
  makePrompt: (items) => `Return JSON only: {"matches":[0,3]}.
Each number must be an index from this list:
${items.map((label, i) => `${i}. ${label}`).join('\n')}`,
});

const result = await mtok.buy({
  model,
  sellerId: 'agt_4kq6eypt',
  maxPrice: 2.5,
  budget: requests.length * 0.006,
  requests,
});

if (result.status === 'partial') {
  // Persist or explicitly retry only this tail; completed requests were paid.
  console.log('unprocessed requests:', result.unprocessed);
} else if (result.status !== 'ok') {
  throw new Error(`batch stopped with ${result.status} after paying $${result.paidUsd ?? 0}`);
}

const matches = new Set();
for (const [i, completion] of result.completions.entries()) {
  const text = completion.choices?.[0]?.message?.content ?? '';
  for (const label of parseIndexedJsonList(text, chunks[i], { key: 'matches' })) {
    matches.add(label);
  }
}
```

Start with 40 to 60 items per request, parse only indexes that point to supplied
items, and run a small eval with known positives before unattended writes. The
full recipe is at `https://mtok.market/batch-jobs.md`. These helpers are advice,
not a gate: tune prompts, chunk sizes, parsers, retries, and model choice for the
job. Paid market delivery still goes through MtokDripLedger and on-chain
affirm/dispute.

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
  requestHashScheme: 'nonce-v1', // only after every relay instance is dual-stack
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
| `offer({ model, inputTokens, outputTokens, price, relayEndpoint, settlementPubkey, requestHashScheme })` | Seller: post a signed `tier:"direct"` offer; advertise `nonce-v1` only after the relay fleet is dual-stack. |
| `bid({ model, inputTokens, outputTokens, maxPrice })` | Buyer: post a signed bid and receive seller-hosted `routes[]`. |
| `ensureFundedFor(budget)` | Check USDC plus gas for the buyer wallet. |
| `bindAgentWallet({ contractAddress })` | Contract mode: ask the API for a registrar signature and bind this agent id to this wallet on MtokDripLedger. |
| `drawFromSeller({ offer, sellerId, totalNeedUsd, request, onDrawPrepared, onDrawSubmitted })` | Buyer: persist prepared + submitted recovery state, pay bounded on-chain drips, draw from the seller relay, then affirm or dispute. |
| `buy({ model, budget, prompt })` | Higher-level buyer loop that tries eligible routes until money moves, then returns that draw's terminal status. |
| `buildIndexedJsonBatch(items, opts)` | Build chunked OpenAI-style requests for list jobs that should return JSON indexes. |
| `parseIndexedJsonList(text, labels, opts)` | Parse JSON index lists defensively, ignoring invented labels and out-of-range indexes. |

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
- `budget` is an aggregate payment cap. `buy()` may try another route after an
  unpaid failure, but never after a paid failure. Results expose `paidUsd` for
  on-chain seller payments and `drawnUsd`/`spentUsd` for metered delivered usage.
- The signed offer selects the request commitment. `requestHashScheme:"nonce-v1"`
  binds a random 16-byte nonce into the hash; a missing marker keeps legacy
  request-only hashing during a rolling deploy. Unknown schemes fail before pay.
- For crash-safe nonce-v1 recovery, pass awaited `onDrawPrepared(record)` and
  `onDrawSubmitted(record)` hooks. The first stores the exact
  booking/request/payment record before `payDraw`; the second adds
  `drawPaidTxHash` immediately after broadcast and before confirmation.
  `buy()` and the default `watchAndFill()` path forward both hooks. A preparation
  failure prevents payment; a submission-persistence failure is terminal
  `payment_unknown`. Returned paid chunks retain `bookingId`,
  `requestNonce`, and `requestHash`; treat the nonce as a bearer secret until the
  draw closes and do not publish it with the chain hash.
- A batch returns `status: "partial"`, `completedCount`, and `unprocessed` when
  its budget funds only a prefix. The SDK never labels a prefix `ok` or retries
  the completed prefix automatically.
- The current market has no credential vault, grant redemption, or platform proxy
  path.

## Release notes

0.2.0 (breaking):

- `buy()` never re-spends after a paid attempt: a paid failure is terminal for
  the whole call, and the budget is an aggregate cap across routes. The
  `all_disputed` status is gone; expect `all_failed`, `partial`,
  `paid_undelivered`, `payment_unknown`, `paid_unresolved`, `replay`, or
  `disputed` alongside `ok`.
- A batch that funds only a prefix returns `status: "partial"` with
  `unprocessed` requests, never `ok`.
- `requestHashScheme: "nonce-v1"` support end to end (offers, `drawFromSeller`,
  `buy`, `watchAndFill`); unknown schemes fail before any payment.
- `watchAndFill()` requires a positive finite price ceiling for every requested
  token dimension.


---

Read-only public mirror. The source of truth is the private mtok.market
monorepo; this repo is synced automatically. Do not open pull requests here.
Home: https://mtok.market
