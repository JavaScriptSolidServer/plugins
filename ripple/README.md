# ripple — Fugger-classic trustlines as a JSS plugin

Ryan Fugger's **original Ripple (2004)** — the pre-XRP design: a web of
bilateral credit between real identities, payments routed through chains of
trust. No blockchain, no native token, no consensus. Spec/issue:
[webcontracts#4 — trustline.v1 profile](https://github.com/webcontracts/webcontracts.github.io/issues/4);
background: [classic.ripplepay.com](https://classic.ripplepay.com/), Fugger,
*"Money as IOUs in Social Trust Networks"*.

```js
plugins: [{ module: 'ripple/plugin.js', prefix: '/ripple' }]   // zero config
```

Open `/ripple` for the UI (trust graph, pay/settle forms, live hash-chained
log); everything it does rides the JSON API below.

## The model

| Concept | Here |
|---|---|
| **Trustline** | unilateral: creditor extends debtor up to `limit` of `currency`. Only the creditor creates/resizes/removes it — it's their risk. The authenticated agent **is** the creditor, never a parameter. |
| **Balance** | ONE signed number per unordered pair+currency ("lo owes hi"). Never two mirrored entries — the two directions are the same number, so the books *cannot* desync. |
| **Payment** | BFS shortest path where every hop carries the full amount; `capacity(x→y) = limit(y→x) − debt(x→y)`. Balances shift atomically along the path. |
| **Settle** | the creditor records out-of-band repayment ("peer paid me"), shrinking only a claim they hold. |
| **Log** | every transition hash-chained (`seq`, `prev`, sha256 of the RFC 8785-canonical entry) — trustline.v1's contract-state framing. `GET /api/log/verify` recomputes the chain. |

The two properties that make Fugger's design sing, both asserted in tests:

- **Intermediaries need no per-payment consent.** Alice→Carol via Bob only
  consumes credit Bob and Carol *already granted* (Bob trusts Alice, Carol
  trusts Bob). Pre-authorization is the routing permission; the only
  per-request auth is the sender's — which is exactly `getAgent`.
- **Signed debt gives clearing for free.** If Bob owes Carol, Carol can "pay"
  Bob with **zero trustline** from Bob — the payment forgives existing debt
  first. Reverse capacity falls out of the sign, not special-casing.

Amounts cross the API as decimals (≤ 6 dp); all arithmetic is integer
micro-units (bigint) — no float drift in anyone's ledger.

## Endpoints

```
GET  /ripple                      UI
GET  /ripple/api/whoami           caller's agent id
GET  /ripple/api/graph            trustlines + IOUs (public — see Findings)
GET  /ripple/api/balances?agent=  net + per-peer positions
GET  /ripple/api/path?from&to&currency&amount     dry-run pathfind
POST /ripple/api/trustlines           { peer, currency, limit }   [creditor]
POST /ripple/api/trustlines/remove    { peer, currency }          [creditor]
POST /ripple/api/payments             { to, currency, amount }    [sender]
POST /ripple/api/settle               { peer, currency, amount }  [creditor]
GET  /ripple/api/log?limit=N          hash-chained transition log
GET  /ripple/api/log/verify           recompute + check the chain
```

## Findings

- **Another whole protocol with zero seam gaps** — like recordweb/, this needs
  none of the open seams: `getAgent` + `pluginDir` + plain routes carry
  trustlines, routing, and the chained log end to end. The single-server
  framing is what makes that true (see the federation finding).

- **Single-server atomicity is the honest MVP, and it's free.** Node's
  single-threaded handlers make a multi-hop payment atomic by construction:
  the balance shifts and the chained log append happen with no `await`
  between them. The HARD problem in 2004 Ripple — atomic commit of a payment
  crossing *hosts* — is exactly what this sidesteps, and exactly where the
  federation flavour begins. A cross-server hop needs a two-phase
  hold/commit between nodes (or an in-protocol hashlock, LN-style); nothing
  in the plugin api blocks trying it over loopback-style HTTP between two
  JSS instances (the `federation-demo/` scaffold), but the protocol design —
  holds, timeouts, unwind — is the real work, not the plumbing.

- **Credit-graph privacy is the one real tension with Fugger's design.**
  Classic RipplePay showed a user only their *own* lines; this MVP serves
  the whole graph publicly (`/api/graph`), which the routing engine needs
  and which a demo wants — but a production posture wants per-agent
  visibility ("my lines, my balances, paths that touch me"). That is an
  authorization question the plugin api can't yet delegate (`api.authorize`,
  #604): WAC governs *pod resources*, and this state isn't pod resources.
  A later wave could mirror each agent's lines into their pod (the recordweb
  pod-delivery pattern) and let WAC govern the copies.

- **The trustline is unilateral; the IOU is bilateral.** A subtle modelling
  point: removing a trustline doesn't erase the balance (the claim lives in
  the pair's signed number, keyed independently). Removal is refused (409)
  only while the peer still owes on that line — freeze at `limit: 0` first,
  settle, then remove. This keeps "you can always withdraw unused credit"
  and "you can never vaporize a debt record" simultaneously true.

- **State-file growth**: every transition rewrites `state.json` including the
  full log — the same O(n) append cost class as plugins#6 (relay). Fine for
  the MVP scale; an NDJSON append-log is the obvious fix when it matters.

## Flavours (the sequence)

1. **Fugger classic** — this plugin.
2. **Web-contract flavour** — the chained log *is* trustline.v1 contract
   state; anchor its `tip` via the forge/ Blocktrails path (Bitcoin
   timestamp over the whole credit history).
3. **Federated flavour** — cross-pod routing between JSS instances
   (two-phase hold/commit or hashlocks; the real 2004 dream).
4. An XRPL API shim would fit the mastodon/bluesky pattern but inherits the
   post-Fugger design this plugin exists to predate — skipped on purpose.

## Test

```bash
node --test --test-concurrency=1 ripple/test.js
```

14 tests: micro-unit + signed-balance + clearing units; the canonical
scenario (bob trusts alice 1000, carol trusts bob 500, alice pays carol 300
through bob); capacity refusal with untouched books; currency isolation;
debt-clearing reverse payments; creditor-only settle bounded by the debt;
removal semantics; the chain verifying end-to-end; the UI page.
