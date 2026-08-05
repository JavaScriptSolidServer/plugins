# markets/ — prediction markets with an LMSR market maker

Multi-outcome prediction markets (1X2 is the home case) traded against
Hanson's Logarithmic Market Scoring Rule: a paper-credit ledger on an
append-only journal, a settlement state machine with disputes, live
WebSocket prices, and a stake-first trading UI. The FanDuel *shape* —
markets, moving odds, positions, cash-out, settlement — with play money.

```js
plugins: [{ module: 'markets/plugin.js', prefix: '/predict',
            config: { baseUrl: 'https://pod.example', grantCredits: 1000,
                      feeBps: 100, admins: ['https://you.example/#me'] } }]
```

Open `{prefix}/` for the UI; the JSON API is under `{prefix}/api`.

| | |
|---|---|
| `POST /api/session` | exchange a pod bearer for a scoped HttpOnly cookie |
| `GET /api/me` | balance, positions with P&L, settlement receipts |
| `GET/POST /api/markets` | list (cursor + filters + search) / create |
| `GET /api/markets/:id` | detail, price history, your position |
| `GET /api/markets/:id/quote` | `?spend=10` (stake-first) or `?shares=50` |
| `POST /api/markets/:id/trade` | buy/sell, slippage guards, idempotency keys |
| `.../close .../resolve .../dispute .../settle .../void` | lifecycle |
| `GET /api/stats` | public conservation figures + journal seq |
| `POST /api/admin/adjudicate` | uphold / re-resolve / void a disputed market |
| `GET /api/admin/disputes` | the operator's dispute queue, soonest deadline first |
| `GET /api/admin/agent` | one agent's journal history (support / adjudication) |
| `POST /api/admin/{freeze,adjust,hide}` | operator plane (journalled) |
| `WS {prefix}/ws` | `{market,trade,settle}` events |

## The economics, in six lines

- Money is integer micro-credits; **costs round up, payouts round down**,
  so float drift always favours the pool, never breaks it.
- The creator escrows `b·ln n` — LMSR's worst-case maker loss — so the
  book is always solvent: settlement provably fits in escrow + collected.
- A share of the winning outcome redeems for 1 credit. No shorting, so
  outstanding shares never go negative.
- **Void redeems at a TWAP over the window before close**, not at spot
  (see Findings — this is what makes voids non-exploitable).
- **The creator's settlement claim is capped at their own escrow**;
  residual beyond it goes to the house, so resolving to an outcome nobody
  holds wins the oracle nothing.
- Conservation is asserted end-to-end after every settlement path:
  `GET /api/stats → creditsInSystem` equals the sum of all grants, exactly.

## Trust model

The oracle is a named agent, and three separate mechanisms bound what a
dishonest one can do: they **may not trade in their own market**; their
payout is **capped at their escrow**; and a resolution sits in a
**dispute window** during which any holder can park it for an operator.
A market whose oracle never acts is **auto-voided at TWAP** after the
settlement window — anyone can trigger it, so funds are never stuck.

Disputes cost a **bond** — `max(disputeBondCredits, disputeBondBps` of the
disputed position`)`, default 25 credits or 20% — returned only if an
operator **sustains** the dispute, forfeited otherwise, including when
nobody adjudicates in time. Every holder posts their own bond, and an
unadjudicated dispute falls through to the **oracle's resolution, not a
void**. Each of those is load-bearing: refunding on any void, latching on
the first disputer, or defaulting to void made disputing a free refund
option on any lost bet — paid for out of the winner's payout — so every
rational loser disputes and correct resolutions never stand.

An operator works the queue at `GET /api/admin/disputes` →
`POST /api/admin/adjudicate`, which has three verbs: **uphold** (the
resolution stands), **re-resolve** (`uphold:false` with an `outcome` —
the oracle was wrong and we know the right answer), and **void**.
Re-resolution matters because voiding an incorrect resolution refunds the
loser and wipes out whoever actually backed the correct outcome.

**A void never pays a holder more than they paid.** Redemption is
`min(TWAP value, cost basis)` per outcome. The TWAP alone defeats a
last-second pump but not one *held across the whole window*; the cap
makes pumping-to-be-voided unprofitable at any hold duration, and since
it only ever pays less than the TWAP, conservation is untouched.

## What this is not (deliberately)

**Not real money.** A real-money book is a gambling licence, KYC/AML,
segregated customer funds, and mandated responsible-gambling tooling — an
organisation, not a plugin. The boundary here is honest: everything above
the ledger is the code a licensed operator would need; the ledger is
where regulated custody would mount. **Not an orderbook** — LMSR quotes
every size at every moment, which is what long-tail markets need.
**Not sybil-resistant**: pods are self-serve, so the faucet is mintable
by registration. Set `grantCredits: 0` and fund via `POST
/api/admin/adjust` for any competitive deployment.

## Findings

The deliverable of this repo. What the api gave, what it didn't, and what
the walls point at.

- **`api.ws.route()` must be `await`ed inside `activate`.** Calling it
  fire-and-forget deadlocks the entire server boot — `listen()` never
  resolves, with no error and no log line. relay/ and webrtc/ both happen
  to await it, so nothing had exposed that it is load-bearing; AGENT.md
  documents the signature but not the requirement. Cost an afternoon of
  bisecting. Either the contract should be documented, or a non-awaited
  call should be safe.
- **Hooks added via `api.fastify` are NOT scoped to the plugin's routes.**
  `api.fastify.addHook('onRequest', …)` runs for *every* request the
  server handles — core's and other plugins'. An unguarded rate-limit hook
  here returned 429 to the metrics and dashboard plugins in the compose
  suite; an unguarded `onSend` was rewriting CORS headers server-wide.
  Every hook must gate on its own prefix by hand. `api.prefix` exists, so
  the loader has everything it needs to scope this. Second consumer of
  this edge (metrics/ noted it from the other side).
- **The host's CORS defaults are wrong for money routes.** The server
  reflects the request Origin with `Access-Control-Allow-Credentials:
  true`, and `getAgent` honours ambient WebID-TLS certificates — so any
  origin could drive an authenticated state change and read the reply.
  Sensible for LDP, dangerous for a plugin holding balances. A plugin
  cannot set server-level CORS, so it must override per-response and
  enforce same-origin itself for ambient credentials. `api.cors` (or a
  documented per-prefix override) is the missing seam.
- **A pod bearer is the wrong credential for a browser app, and the api
  offers no alternative.** The obvious UI flow ("paste your token") puts a
  pod-wide credential in `localStorage` on an origin that also serves
  user-uploaded HTML — one stored XSS anywhere on the host and the
  attacker owns the pod. This plugin mints its own scoped, expiring
  session (capability/'s HMAC shape) behind an HttpOnly cookie, which
  every browser-facing plugin will have to reinvent. `api.auth.mintScoped
  ({ agent, scope, ttl })` would be the shared primitive.
- **No `api.rateLimit`.** The host's limiter is `global: false`, so plugin
  routes get none, and unauthenticated bodies are parsed before the 401.
  Every plugin exposing an anonymous endpoint needs its own bucket
  (guard.js here). Route-level `bodyLimit` at least *is* reachable.
- **Event sourcing had to be hand-rolled, and was worth it.** The
  repo-standard "one JSON blob, atomic temp+rename" (shortlink/, otp/,
  relay/) rewrites all state per mutation — O(entire state) per trade —
  keeps no audit trail, and turns a torn write into a silent total reset.
  Balances need all three fixed, so store.js is a journal (append +
  fsync, the durable record) plus a periodic snapshot, with corruption a
  boot failure rather than a wipe. This is the fourth stateful plugin to
  outgrow the blob; a documented `api.storage.journal()` would stop
  everyone rediscovering fsync-and-rename semantics.
- **Stake-refund voids are impossible under an AMM**, and voiding at spot
  is exploitable. Refunding stakes over-draws the pool, because early
  sellers already left with pool money. But redeeming at the *final*
  price is a guaranteed arbitrage: by strict convexity, buying x shares
  costs strictly less than `x·p_final` (measured: 1930.69 for shares that
  redeem at 2000.00), so buy-then-void extracts `b·ln n` risk-free, partly
  out of other holders' redemptions. The fix is to redeem at a
  **time-weighted average** over the window before close: still conserving
  — the bound `Σqᵢrᵢ ≤ C(q)` holds for *any* probability vector `r`, by
  the Gibbs variational principle, not just the spot one — but a
  last-second pump barely moves it, so the pump is a pure loss. There is a
  regression test for exactly this attack, and it caught a real bug: the
  price path was seeded with `m.history || [seed]`, and an empty array is
  truthy, so the TWAP degenerated to the post-pump spot price.
- **A self-verifying credential needs an epoch, and the type of what
  `verify()` returns is a money bug.** Widening the session verifier from
  "returns the agent id" to "returns the claims" without updating its two
  callers made every cookie session authenticate as the string
  `[object Object]`: one shared ledger row for every browser user, a
  phantom grant minted against that key, a rate limiter keyed on a fresh
  object per request (so, disabled), and a conservation invariant that
  was silently false and would have replayed that way forever. Sixty-two
  green tests missed it because they asserted status codes and never once
  asserted *which agent* a cookie resolved to. Test the identity, not the
  200.
- **Dropping a torn journal tail is only half of crash recovery.** The
  fragment must also be TRUNCATED before reopening for append —
  otherwise the next acknowledged, fsync'd event is welded onto the
  partial line, and the boot after that silently drops a real credit
  movement and reuses its sequence number. A durability design can pass
  every "does it survive a restart" test and still fail the one crash it
  exists to survive; the regression test now crashes, writes, and
  restarts again.
- **Atomicity by construction is fragile and undocumented.** Every
  mutating handler awaits auth first, then validates and commits with no
  `await` in between, so the event loop makes each trade a transaction.
  One innocent `await` inside that window reintroduces TOCTOU. It holds
  today (audited per handler, and a concurrent-trade test pins it) but
  it is a comment, not a mechanism — a real store wants transactions.
- **No `api.events.onResourceChange`** bites here as it does in sparql/ and
  rss/: match results already live in pods, but the oracle cannot be "this
  pod resource says 2-1" — a human agent must post the resolution.
  Auto-settlement from pod data is the natural next seam.

## Tests

`node --test --test-concurrency=1 markets/test.js` — 64 tests: LMSR and
TWAP math, session/CSRF/rate-limit units, hardened headers, cookie
scoping, prototype-key ids, grants, escrow, stake-first quotes,
quote↔trade parity, slippage guards (including the NaN-fails-closed case),
no-shorting, idempotent retries, 12 concurrent trades, ws privacy,
pagination and search, the full settlement state machine (resolve →
dispute → settle, void, early close, dead-oracle rescue), the
self-dealing and pump-and-void attacks, 12-outcome and no-trade markets,
the admin plane (hide-makes-untradable, freeze, journalled adjust, agent
history), both adjudication paths, the sustained-pump void, reboot with
an open market mid-flight, journal integrity, journal-gap and
corrupt-snapshot boot refusal, and torn-tail crash recovery — with
micro-credit-exact conservation asserted after every single one.
