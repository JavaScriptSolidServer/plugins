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

## The core/plugin line — answering #564 empirically

#564 asks: which of JSS's bundled features become plugins, and where's the
line? This repo answers it by *trying* — porting each feature onto the
public api and seeing what survives. The line that fell out:

**A feature is plugin-able iff it OWNS its routes. It stays core iff it
MODIFIES the request pipeline of routes it doesn't own.**

| Feature | Shape | Verdict | Evidence |
|---|---|---|---|
| nostr relay | owns `/relay` ws | ✅ plugin | relay/ — parity + persistence |
| webrtc | owns `/webrtc` ws | ✅ plugin | webrtc/ — full parity, zero imports |
| terminal | owns a ws | ✅ plugin | terminal/ — hardened beyond core |
| tunnel | owns a prefix | ✅ plugin | tunnel/ — parity, one prefix deviation |
| notifications | owns a ws + watches storage | ✅ plugin | notifications/ — WAC via loopback |
| NIP-05, cors-proxy, webdav, capabilities | own routes | ✅ plugin | this repo's later ports |
| **pay** | 402s *LDP* routes from the WAC hook | ❌ **core** | pay/ — the wall-report |
| conneg, quotas, WAC, LDP, the auth chain | modify every request | ❌ core | — they ARE the pod |

So #564's migration list is right for the route-owning features (relay, AP,
webrtc, terminal, tunnel, remoteStorage, the IdP's own endpoints) — each can
move out-of-tree behind the loader with no core change, exactly as this repo
demonstrates for six of them. Pay is the one on that list that CAN'T, and
it's instructive: its essence is intercepting the LDP pipeline, which is the
definition of core. The bundled features that look like plugins ARE plugins;
the ones that look like middleware stay middleware.

**Corollary for the loader:** the only thing that would move a
pipeline-modifying feature across the line is a `capabilities: ['hooks']`
grant (an explicit, separately-gated `onRequest`/`onSend`), which several
findings above independently ask for. Until then, the line is clean and
this repo is its proof.

## Bugs the composition surfaced (this repo's own dogfooding)

- **Generic-basename id collision** — every port follows `<name>/plugin.js`,
  so all six modules derive the id `plugin` and the loader's duplicate-id
  guard (added in PR #589 review) refuses to boot until each entry gets an
  explicit `id`. The guard is correct; the *derivation* is weak. Fix
  candidate: when the basename is generic (`plugin`, `index`), derive from
  the parent directory (`relay/plugin.js` → `relay`). Small, backward-
  compatible, removes the most common footgun. **Filed-worthy.**
- **Dotted prefixes fail the ws upgrade** — a plugin mounted at
  `/.terminal` cannot accept WebSocket connections (immediate upgrade
  error), while `/terminal` and even `/.notifications` HTTP work. Core
  reserves specific dotted paths (`/.terminal`, `/.webrtc`) for its own
  built-ins in the WAC-skip list; a plugin claiming a dotted prefix
  collides with host-level dotfile/route handling in a way plain prefixes
  don't. Consequence: plugins should avoid dotted prefixes, or the loader
  should validate/reserve them explicitly. (The composition uses
  `/terminal`; `/.notifications` HTTP happens to work but wasn't stressed
  for upgrades.)

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
