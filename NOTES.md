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

## Candidate seams (ranked by how many independent plugins demanded them)

Twelve plugins in, the ranking is now empirical — a seam's rank is how many
ports reached for it without coordinating.

1. **`api.authorize(request, path, mode)`** — "would the host's WAC allow
   this?" **Three independent consumers: notifications/, corsproxy/,
   capability/.** The loopback trick (below) covers the case where the
   *requester's own* credentials should decide (notifications, webdav,
   sparql all use it), but it can't cover authorization the requester
   doesn't drive: a proxy governed by a *pod owner's* `.acl` (corsproxy
   #382), or a capability exercising the *issuer's* authority
   (capability #506). This is the most-requested seam and the one that
   moves the most backlog issues from "plugin-approximation" to "faithful".
2. **`api.events.onResourceChange(cb)`** — **two consumers: notifications/,
   sparql/**, and sparql is the *stronger* one: without a write hook a
   plugin index returns **wrong** query results, not merely late
   notifications, and `pluginDir` caching is uninvalidatable. Core already
   has the emitter internally (`src/notifications/events.js`). The seam
   every "react to pod writes" app (webhooks, indexing, sync, full-text)
   will want.
3. **`api.serverInfo` (`{ baseUrl, port }` at listen)** — **eight+
   consumers: notifications/, webdav/, carddav/, caldav/, sparql/, rss/,
   nip05/, webfinger/, mastodon/, bluesky/, activitypub/** — essentially
   every plugin that mints absolute URLs or reaches the host over loopback.
   All repeat the origin in config today; a wrong value fails quietly (nip05
   serves an empty identity map). The single most *broadly* needed seam
   (vs. api.authorize being the most *blocking*); trivially cheap to provide.
4. **The unconsumed-body-**stream** primitive (#583)** — consumer:
   gitscratch/ sharpened it. tunnel/ needed the raw *buffer*; git needs the
   raw *stream* piped to a subprocess gzip-and-all. Whatever `api.mountApp`
   / raw-body mode ships must hand back the un-drained stream, not just a
   buffered body. (This is exactly what the merged loader's scoped
   pass-through parser does — the finding is to keep it that way.)
5. **Routes/WAC-exemption outside the single prefix** — **the most-hit
   finding: seven+ consumers.** A plugin can *register* absolute/exact
   routes outside its prefix (the loader doesn't confine `api.fastify`), but
   the loader WAC-exempts only its **one** `prefix`. Consequences, in
   increasing severity:
   - **`/.well-known/*` served by luck** — nip05/ (`nostr.json`),
     webfinger/ (`webfinger`), webdav/carddav/caldav (`caldav`/`carddav`).
     Core *happens* to blanket-exempt `/.well-known/*`, so they work but by
     coincidence, not contract. Notably nip05 and webfinger are the **two
     most-wanted `.well-known` docs a deployment serves**, both riding the
     same undocumented luck.
   - **fixed roots core does NOT exempt** — mastodon/ (`/api`,`/oauth`),
     bluesky/ (`/xrpc`), activitypub/ (`/ap`). Here the plugin **cannot
     serve its own surface**: every call 401s at the WAC hook until the
     operator hand-passes `appPaths`. **Three independent protocol-shim
     confirmations**, each built separately. bluesky sharpened it (one root,
     still unreachable → the ask is "declare owned paths," not "more
     prefixes"); activitypub sharpened it further — its natural layout wants
     paths **interleaved with** the pod's own `/<user>/` namespace, which no
     single mount prefix can carve out at all.
   - none of it has conflict detection: a future core route at a
     plugin-claimed path throws `FST_ERR_DUPLICATED_ROUTE` at boot (and a
     link registry — `api.webfinger.addLink` — is missing, so two plugins
     contributing `.well-known/webfinger` links would collide silently).
   The seam: `api.reservePath('/xrpc')` (or `paths: [...]` in the entry) —
   the loader exempts *and* claims each deliberately and reports collisions.
   The seam **every API-shim plugin** structurally requires; third
   most-demanded after `api.authorize` and `api.events`.
6. **Can't set fastify server options** — consumer: capability/ hit
   `maxParamLength` (100) silently 404ing long tokens in named params;
   workaround is a wildcard route. A plugin has no way to raise per-route
   limits. Minor, but sharp when it bites.
7. **Internal utility modules plugins re-vendor** — consumer: relay/
   (`src/nostr/event.js` NIP-01 verify), pay/ (`src/mrc20.js`). Pure crypto.
   Export like auth.js (`javascript-solid-server/nostr.js`) or bless
   vendoring.
8. **Response-header injection on core routes** — consumer: notifications/
   (`Updates-Via` discovery). A plugin can't add headers to routes it
   doesn't own. NOT a default-on hook (bigger grant than route ownership);
   gate behind `capabilities: ['hooks']` if ever.

## Test-harness footguns (host quirks, not plugin api)

Every multi-boot suite independently rediscovered these; worth a line in
the plugin-author docs.

- **Module-global `DATA_ROOT`**: JSS keeps the storage root (and IdP key
  resolution) in a process-global env var that *every* `createServer`
  repoints — a second boot in one process, **even a deliberately-failing
  one**, poisons the first. Order validation-failure tests *before* the
  long-lived boot. (notifications/, webdav/, sparql/ all hit this.)
- **Ambient `~/.gitconfig`**: git-shelling plugins inherit the operator's
  config — `init.defaultBranch = gh-pages` leaked dangling HEADs into
  server-created bare repos (empty clones). Spawn git with
  `GIT_CONFIG_NOSYSTEM=1` and no `HOME`. (gitscratch/.)

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
