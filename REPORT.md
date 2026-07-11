# The plugin api, 32 plugins later — a report for the maintainer

This document is the actionable summary of the whole experiment: what the
#206 plugin api can already do, what it can't, and — ranked with evidence —
what to add next. Everything asserted here has a working consumer in this
repo; nothing is speculative. Detail lives in [NOTES.md](./NOTES.md)
(findings), [ISSUES.md](./ISSUES.md) (per-issue disposition), and each
plugin's `README.md ## Findings`.

**Nothing has been filed upstream from this work** (per your rule); each
proposal below is drafted so it *could* be filed nearly verbatim if you
want it.

## Executive summary

- The api as shipped in 0.0.215 (`createServer({ plugins })` + `prefix` +
  `getAgent` + `pluginDir` + `ws.route`) is **sufficient for 32 real
  plugins across fifteen capability classes** — realtime, DAV,
  fediverse/chat shims, IndieWeb publishing, identity, query/search,
  object storage, proxy, dev tooling, pay, data portability,
  ops/observability, mail (JMAP), link-embeds (oEmbed), remoteStorage —
  with zero core changes. Seven of those are ports of bundled features;
  remoteStorage in particular still ships always-on in core and could
  move out-of-tree behind the loader.
- Of the ~40 `plugin`-tagged backlog issues, **13 are built here**, 6
  bundled features are ported, 5 shipped upstream during this line of work,
  2 more are unblocked, and **6 clusters are blocked on exactly four
  missing seams**. The rest are core-by-nature (a finding, not a gap).
- The four seams, ranked by independent demand, are `api.authorize`,
  `api.events.onResourceChange`, `api.reservePath`, and `api.serverInfo`.
  Adding the first three moves essentially every remaining plugin-shaped
  issue from "honest approximation" to "faithful implementation".
- Five small loader/core bugs are worth fixing regardless
  (generic-basename id derivation; dotted-prefix WS validation;
  `logger: false` breaking every plugin `onResponse` hook; the loader's
  error wrap dropping `err.code`; the host's conditional write being
  check-then-write rather than atomic).
- One measured surprise: **plugins are not isolated from each other** —
  all entries share one Fastify register scope, so any plugin can hook
  every other plugin's routes (never core's). Worth a deliberate
  decision, not an inherited one.

## What already works — decisions worth keeping

Validated by use, not opinion:

1. **`api.ws.route` on the host's upgrade stack** (PR #589's design): five
   WebSocket plugins coexist in one process with zero upgrade code and no
   `@fastify/websocket` dependency anywhere. Keep it.
2. **The scoped pass-through body parser**: `gitscratch/` pipes a raw
   request stream into `git-http-backend` gzip-and-all; `tunnel/` needs raw
   buffers; `micropub/`'s media endpoint (multipart upload) is *waiting*
   on exactly this. Whatever raw-body mode ships for #583 must keep
   handing back the **un-drained stream**, exactly as today.
3. **`pluginDir` as the only persistence** — every stateful plugin (relay
   events, capability secrets, OTP table, AP keypairs, git repos) fit in it.
4. **Fail-loudly activation** — `throw` in `activate` → boot failure is the
   right contract; test suites lean on it.
5. **The loopback pattern removes a class of seams.** A plugin that needs
   "would WAC allow this *for the requester*?" asks the server itself over
   HTTP with the client's own credentials. A dozen plugins run a whole
   data plane this way. This is why `api.wac.check(agent, path, mode)` is
   *not* on the ask list — only the cases loopback structurally can't
   cover are.
6. **Conditional writes survive loopback intact** (measured by
   `remotestorage/`; `sparql/`'s UPDATE is the second consumer):
   forwarded `If-Match`/`If-None-Match` are honored by the host
   end-to-end (412 on stale, 304 on match). A protocol that needs
   optimistic concurrency gets the stale-writer case for free — but see
   bug 5: under true concurrency the check is not atomic.

## The seams to add, ranked by independent demand

Rank = how many plugins reached for the seam *without coordinating*. Each
entry is written as a fileable issue: motivation, consumers, sketch, cost.

### 1. `api.authorize(request, path, mode)` — the most *blocking*

**Ask:** let a plugin ask the host's WAC engine for a decision the
*requester's credentials don't drive*.

**Why loopback can't cover it:** loopback answers "may *this caller* read
X?". Four plugins need "may *someone else* — a pod owner, a token issuer,
a message recipient —
authorize this?":

- `corsproxy/` (#382): per-pod proxy ACLs — the *pod owner's* `.acl`
  should govern what the proxy fetches, whatever the caller presents.
- `capability/` (#506): a capability URL exercises the **issuer's**
  authority; the bearer has no Solid credentials at all. Today the plugin
  can only enforce its own token scopes, not re-check the issuer's current
  WAC rights (revocation by ACL edit doesn't propagate).
- `pay/`: the 402 gate wants to compose with WAC instead of replacing it.
- `caldav/` (RFC 6638 scheduling): Outbox→Inbox delivery is a write into
  the *recipient's* pod the sender has no WAC right to make — loopback
  structurally cannot express it. (A narrower server-mediated
  deliver-to-inbox primitive would also cover this one.)

**Sketch:** `api.authorize({ agent, path, mode }) → Promise<boolean>` —
agent id (not request) in, decision out, same engine the LDP path uses.

**Cost:** medium — the WAC engine exists; this is plumbing an entry point
into the loader's `api` object.

### 2. `api.events.onResourceChange(cb)` — every "react to writes" app

**Consumers (seven, rising sharpness):** `notifications/` (a miss = late
notification), `sparql/` (a miss = wrong query result), `search/` (stale
results — the most user-visible), `matrix/` (its `/sync` long-poll needs
live push; a stateless bridge can only do full-state sync without it),
`backup/` (no change hook + no plugin-owned read authority means
incremental and scheduled backup are both unbuildable — every backup is a
caller-driven full crawl), `jmap/` (push and delta sync refused
in-protocol: no `eventSourceUrl`, `cannotCalculateChanges`), and
`remotestorage/` (descendant-version propagation needs a write-time
index). Every unbuilt "react to writes" idea —
webhooks, WebSub, write-time indexing — joins this list on day one.

A sharpening from `jmap/` worth keeping: what makes a protocol bridgeable
is not its domain but the absence of server push — JMAP (email redesigned
stateless by the IETF) bridges with zero approximation where IMAP never
could. This seam is exactly what turns the "stateless slice" of matrix,
jmap, and remotestorage into full implementations.

**Sketch:** `api.events.onResourceChange(({ path, method }) => {})`,
fired post-commit on PUT/PATCH/DELETE. Core already has the emitter
internally (`src/notifications/events.js`) — the seam is exposure, not
construction.

**Cost:** small — the event stream exists; scope it and pass it through.

### 3. `api.reservePath(pattern)` — what every API shim structurally needs

**The most-hit finding: seven+ consumers.** A plugin can *register* routes
outside its prefix, but only its one `prefix` is WAC-exempt:

- `/.well-known/*` (nip05, webfinger, the DAV family) works **by luck** —
  core happens to blanket-exempt it. The two most-wanted `.well-known`
  docs a deployment serves ride an undocumented coincidence.
- Fixed protocol roots (`/api`, `/oauth`, `/xrpc`, `/ap`, `/_matrix`) do
  **not** work: mastodon/bluesky/activitypub/matrix all 401 until the
  operator hand-passes `appPaths` — the plugin cannot self-exempt the
  paths the protocol fixes.
- The sharpest case can't be expressed at all: `didweb/` must serve
  `/<user>/did.json` *inside* the pod's WAC-governed namespace —
  `appPaths` matches literal prefixes, so a **parameterized** reservation
  is the only fix (the DID method pins the URL; there's no fake root to
  escape to).
- Collision behavior is now **witnessed, both ways**: `webfinger/` and
  `remotestorage/` both legitimately own parts of
  `/.well-known/webfinger`. Load one order → boot fails with a wrapped
  duplicate-route error (the loader drops `err.code`, bug 4 below); the
  other order → the try/catch-guarded claimant **silently loses** its
  links. Loud failure or silent loss — both wrong. For shared discovery
  documents the reservation primitive isn't enough; a link/JRD registry
  (`api.webfinger.addLink`) is the real fix.
- The counter-witnesses that sharpen the scope: `micropub/` and `jmap/`
  are protocol shims that needed *no* reservation, because their
  endpoints are client-/session-discovered rather than protocol-fixed
  (jmap's `/.well-known/jmap` rides the blanket exemption). The seam is
  for protocols that pin absolute paths — not API shims per se.

**Sketch:** `api.reservePath('/xrpc')`, `api.reservePath('/:user/did.json')`
(or `paths: [...]` on the entry): loader WAC-exempts *and* claims each,
reporting collisions at boot.

**Cost:** small-medium — generalizes the `appPaths` mechanism that already
exists, moving it from operator config to plugin declaration.

### 4. `api.serverInfo` — the broadest, and the cheapest

**~16 consumers** — every plugin that mints absolute URLs or loopbacks
(the DAV family, the shims, rss, sparql, nip05, webfinger, notifications,
micropub, backup, metrics, dashboard, oembed, jmap, remotestorage…)
repeats `baseUrl`/`loopbackUrl` in config today. A wrong value fails
*quietly* (nip05 serves an empty map). Test suites all need a
probe-port-then-boot dance for the same reason.

**Sketch:** `{ baseUrl, port }` available by `activate`-time or via an
`onListen` hook.

**Cost:** trivial. Best effort-to-value ratio on this list.

### Smaller, real, lower-priority

- **Raw-stream guarantee for #583** (see "worth keeping" above) — a
  property to preserve, not new work.
- **`api.mcp.registerTool`** — blocks the four MCP-tool issues
  (#495/#496/#500/#501); no consumer here because it's impossible today.
- **`api.plugins` (the #463/#464 app-registry)** — first live consumer:
  `dashboard/`, the plugin whose whole job is describing the deployment,
  must be handed a hand-copied duplicate of the `createServer` plugins
  list (drift is silent). The loader already holds the needed data:
  `api.plugins → [{ id, prefix, module }]`, read-only.
- **Export pure utility modules** the way `auth.js` is blessed —
  `relay/` re-vendors NIP-01 verify, `pay/` re-vendors mrc20. A
  `javascript-solid-server/nostr.js` export (or explicit vendoring
  blessing) ends the drift risk.
- **Per-route Fastify options** — `capability/` found `maxParamLength`
  (100) silently 404s long tokens in named params; wildcard routes are
  the workaround. Sharp when it bites.
- **Response-header injection on core routes** — wanted twice
  (notifications' `Updates-Via` discovery; micropub's
  `<link rel="micropub">` endpoint discovery on the user's homepage).
  Deliberately *not* asked for as a default-on hook: it's a bigger grant
  than route ownership. If ever, gate it: `capabilities: ['hooks']`.

## Five loader/core bugs worth fixing regardless

1. **Generic-basename id derivation.** Every plugin follows
   `<name>/plugin.js`, so every derived id is `plugin` and the (correct)
   duplicate-id guard refuses to boot until each entry carries an explicit
   `id`. Fix: when the basename is generic (`plugin`, `index`), derive
   from the parent directory (`relay/plugin.js` → `relay`).
   Backward-compatible; removes the most common footgun.
2. **Dotted prefixes break the WS upgrade.** A plugin at `/.terminal`
   can't accept WebSocket connections (host-reserved dotted paths), while
   `/terminal` works. Either validate/refuse dotted prefixes at load or
   document the reservation.
3. **`logger: false` silently disables every plugin `onResponse` hook.**
   Core's access-log hook calls `request.log.isLevelEnabled('info')`,
   which doesn't exist on Fastify's null logger; the per-request throw
   aborts the downstream hook chain, so plugin `onResponse` hooks never
   fire (found by `metrics/`). One-line guard fixes it.
4. **The loader's activate-failure wrap drops `err.code`.** A route
   collision inside `activate` surfaces as `plugin <id>: activate()
   failed: <message>` with `FST_ERR_DUPLICATED_ROUTE` stripped — callers
   can only string-match. Preserve `code` (or use `cause`) when
   re-wrapping (found by `remotestorage/`).
5. **The conditional write is check-then-write, not atomic** (found live
   by `sparql/`): two *concurrent* PUTs carrying the same currently-valid
   `If-Match` both return 2xx and one is silently overwritten; the same
   PUTs run sequentially 412 correctly. Both callers are told success but
   one write is gone. Unfixable from a plugin; the LDP write path needs
   an atomic stat+write.

## A measured surprise: plugins are not isolated from each other

`metrics/` needed request counters, so it added an `onResponse` hook on
`api.fastify` and measured what the hook can see (both entry orders,
core routes probed too). Result: **the hook fires for every plugin's
routes and never for core's.** All loader entries are activated against
one shared `fastify.register` scope, while core routes live on the
parent instance behind Fastify encapsulation.

Two readings, both true:

- The #564 line **holds against core** — a plugin cannot observe or
  modify the pipeline of core routes, exactly as intended.
- Plugins can already observe **and intercept** each other, ungated. A
  hostile or buggy plugin can shadow-log or rewrite a sibling's traffic
  today.

This is worth a deliberate decision rather than an inherited one:
per-plugin encapsulation (each entry in its own `register` scope) is the
safer default, but note it would break the one legitimate cross-plugin
consumer found (a metrics exporter counting all plugin traffic) — if
hooks are ever capability-gated (`capabilities: ['hooks']` /
`['observe']`), the shared scope could become the *granted* behavior and
isolation the default.

## The core/plugin line (#564, answered empirically)

**A feature is plugin-able iff it OWNS its routes; it stays core iff it
MODIFIES the pipeline of routes it doesn't own.** Six bundled features
ported cleanly (relay, webrtc, terminal, tunnel, notifications — plus
`pay/` as the deliberate counter-example: 402-gating LDP routes is
pipeline modification, which is the definition of core). The migration
list in #564 is right for every route-owning feature; the
middleware-shaped ones (conneg, quotas, WAC, LDP, auth) *are* the pod.
The only thing that would move that line is an explicit, separately-gated
hooks capability.

## For plugin-author docs (footguns every suite rediscovered)

- Module-global `DATA_ROOT`: a second `createServer` in one process —
  even a deliberately failing one — poisons the first. Order
  validation-failure tests before the long-lived boot.
- Git-shelling plugins must spawn with `GIT_CONFIG_NOSYSTEM=1` and no
  `HOME`, or operator gitconfig leaks into server-created repos.
- Explicit `id` per entry (until bug 1 above is fixed).
- Plain (non-dotted) prefixes for anything with a socket.

## Suggested order of work

If effort is scarce, this order maximizes unblocked value per unit cost:

1. `api.serverInfo` (trivial; tidies ~10 plugins' config and every test
   harness),
2. `api.reservePath` (small-medium; makes four existing shims
   self-contained and didweb *possible*),
3. `api.events.onResourceChange` (small; unlocks webhooks/WebSub/indexing
   and makes search/sparql/matrix faithful),
4. `api.authorize` (medium; the blocking seam for proxy ACLs and
   capability semantics),
5. the two loader bug fixes (anytime; small).

Everything else can wait until a real consumer shows up — this repo is the
mechanism for finding those.
