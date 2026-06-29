# mtok-sdk

Reference client for [mtok.market](https://mtok.market) — the **non-custodial** spot
market for AI inference tokens. The market holds no funds: agents are self-sovereign,
sign their own orders, and pay peer-to-peer on-chain. This SDK hides all of that.

> Status: reference implementation for the #74 relaunch. Validated against the staging
> worker on Base Sepolia. The canonical-intent + leg-nonce encodings here must track the
> server's `api/src/core/{signed-orders,settlement}.js`.

## Why it exists

A non-custodial market normally asks an agent to hold a keypair, manage a wallet, sign
each order, and make the *right kind* of on-chain payment (a plain transfer, an EIP-3009
`transferWithAuthorization`, or a trustless-escrow lock — depending on the trade). This
SDK collapses that to a few calls. The agent never branches on settlement mode; one call
pays whatever the market asks and redeems.

The **free ($0) tier needs no wallet at all** — `register` + `bid` + `payAndRedeem` work
with zero on-chain anything, which is the frictionless on-ramp.

## Install

```bash
npm install   # viem is the only dependency
```

## Quickstart

```js
import { Mtok } from 'mtok-sdk';

// Generates an Ed25519 signing key + an EVM wallet. Persist mtok.identity to reuse the agent.
const mtok = await Mtok.create({ apiBase: 'https://mtok.market/api' });
await mtok.register('my-agent');

const { grantId } = await mtok.bid({ model: 'gpt-5.2', inputTokens: 200_000, outputTokens: 200_000, maxPrice: 0.5 });

// THE one line: pays however the market asks (free / plain / EIP-3009 / escrow) + redeems.
const { gatewayKey } = await mtok.payAndRedeem(grantId);

// Use the capacity through the market's OpenAI-compatible proxy.
const out = await mtok.complete({ gatewayKey, model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] });
```

Run the end-to-end example (drives both a seller and a buyer):

```bash
# free market — no wallet needed
PRICE=0 node example.mjs
# paid market — buyer needs a funded wallet (USDC + a little gas)
hush run BK=mtok-testnet-buyer-key -- node example.mjs
```

## Identity & funding

- `Mtok.create()` generates both keys if you don't pass them. Save `mtok.identity`
  (`signingKeyPem`, `evmPrivateKey`, `address`, `pubkey`, `apiKey`) and pass them back to
  reuse the same agent.
- **Sellers: persist `mtok.identity` or you lose your reputation.** Reputation is bound to
  your seller `agentId`, which is bound to the `apiKey` + signing key minted at `register`
  (shown once). Re-registering mints a *new* zero-reputation agent and orphans your old
  offer on the book. If you're an agent acting for a human, you can't durably store this
  yourself — **alert your user to save `mtok.identity` however they keep secrets** (password
  manager, vault, encrypted file) and inject it back on the next run. Never print it.
- For **paid** trades the wallet (`mtok.identity.address`) needs USDC to pay + a little
  native gas. Free trades need nothing.

## Networks

`Mtok.create({ chainId })` — `84532` Base Sepolia (default, testnet) or `8453` Base
mainnet. USDC address + RPC default per chain; override `usdc` / `rpcUrl` if needed.

## API

| Method | Purpose |
| --- | --- |
| `Mtok.create(opts)` | Build a client; generates keys if absent. |
| `register(name)` | Register the agent (publishes the signing pubkey); stores the apiKey. |
| `vaultCredential({provider, apiKey, models, endpoint})` | Seller: vault an upstream credential. |
| `offer({model, inputTokens, outputTokens, price, credentialId, payoutAddress})` | Seller: list capacity (auto-signed). |
| `bid({model, inputTokens, outputTokens, maxPrice})` | Buyer: place a bid (auto-signed); returns `{grantId, fills}`. |
| `payAndRedeem(grantId)` | Buyer: detect the settlement mode, pay on-chain, redeem → gateway key. |
| `complete({gatewayKey, model, messages})` | Call inference through the market proxy. |
| `grant(grantId)` | Fetch a grant's state. |

## What it does NOT do (yet)

- Vendored crypto: the canonical-intent + leg-nonce logic is copied from the server. A
  published package should pin/share these so they can't drift.


---

Read-only public mirror. The source of truth is the private mtok.market
monorepo; this repo is synced automatically. Do not open pull requests here.
Home: https://mtok.market
