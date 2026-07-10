# Findings log

What the 0.0.215 plugin api gave us, what it didn't, and what that implies
upstream. One section per theme; port-specific detail lives in each port's
README. **Nothing here has been filed as an issue yet** — proposals below
are candidates, each with a consumer in this repo attached.

## What just worked (no changes wanted)

- **`api.ws.route` carried every realtime port** — relay, webrtc, terminal,
  tunnel control, notifications — with zero upgrade-handling code and no
  `@fastify/websocket` dependency in any plugin. The decision to build it
  on the host's websocket stack (PR #589) rather than raw `'upgrade'`
  listeners meant five websocket features coexist in one process without a
  single conflict.
- **`api.storage.pluginDir()`** — relay grew persistence core never had, in
  ~15 lines.
- **Fail-loudly activation** — several test suites rely on
  `assert.rejects(listen)` for misconfiguration; the contract reads well
  from the consumer side.
- **The loopback pattern** (notifications): a plugin that needs "would the
  server allow X?" can ask the server itself — HTTP to the host with the
  client's own credentials. Slower than an internal check but definitionally
  correct. This removes a whole class of would-be seams (`api.wac.check`)
  from the *necessary* list, leaving them merely *nice*.

## Candidate seams (in value order, consumers attached)

1. **`api.events.onResourceChange(cb)`** — consumer: notifications/.
   Core has the emitter internally (`src/notifications/events.js`); today a
   plugin must fs.watch a config-supplied path, which drifts and misses
   non-fs backends. This is also the seam any future "react to pod writes"
   app (webhooks, indexing, sync) wants — likely the most demanded seam of
   the next wave of real apps.
2. **`api.serverInfo` (`{ baseUrl, port }` resolved at listen)** — consumers:
   notifications/ (pub URLs, origin checks, loopback), any plugin minting
   absolute URLs. Today the operator repeats the origin in every plugin's
   config.
3. **Internal utility modules plugins re-vendor** — consumers: relay/
   (`src/nostr/event.js` NIP-01 verify) and potentially pay/ (`src/mrc20.js`).
   Both are pure, dependency-light crypto. Candidate: export like auth.js
   (`javascript-solid-server/nostr.js`), or bless vendoring as the answer.
4. **Response-header injection on core routes** — consumer: notifications/
   (`Updates-Via` discovery). Explicitly NOT proposing a default-on hook:
   a plugin rewriting every response is a bigger grant than route ownership.
   If it ships, gate it (`capabilities: ['hooks']`).

## The wall (by design): pipeline-modifying features

pay/ documents it fully. Core's pay feature turns *LDP routes* into paid
resources from inside the WAC hook — a plugin cannot touch routes it
doesn't own, so pay/conneg/quotas/WAC are **core, not plugins**. That's the
crisp line #564 needed:

- route-owning features → plugins (proven here: relay, webrtc, terminal,
  tunnel, notifications endpoint)
- pipeline-modifying features → core (or a future, separately-gated hooks
  capability)

## Smaller notes

- A plugin owns exactly one prefix. Features with scattered paths (core
  notifications' `/.well-known/solid/notifications` status endpoint,
  tunnel's split control/traffic paths, ActivityPub's webfinger) must
  consolidate under one prefix or deviate from core's URLs. Candidate:
  `prefixes: []` (plural) if a real consumer is blocked; consolidation was
  fine for everything here.
- Test harness dance: a plugin whose config references the server's own
  origin forces the port-probe-then-boot pattern (helpers.js `port` option)
  — same finding as api.serverInfo, visible in test setup.
