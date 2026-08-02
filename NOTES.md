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
- **Conditional writes pass through loopback intact** (remotestorage/,
  measured; sparql/ is the second consumer): `If-Match`/`If-None-Match`
  forwarded verbatim are honored by
  the host end-to-end — stale `If-Match` PUT/DELETE → 412,
  `If-None-Match: *` on an existing resource → 412 with the body proven
  not to land, `If-None-Match` GET → 304. No plugin-side conditional
  logic needed for the stale-writer case. **Caveat measured by sparql/:**
  the host's check is check-then-write, not atomic — see the bugs section.

## Candidate seams (ranked by how many independent plugins demanded them)

**New (2026-07-12, found standing up Phanpy against serve.js): agent
resolution is Host-sensitive.** A WebID minted under the idpIssuer host
(`localhost:<port>`) fails core's ownership check when the same request
arrives via `127.0.0.1:<port>` — same server, same valid token, 403.
Every loopback-forwarding plugin is exposed: the loopback bind MUST use
the issuer's host (serve.js now does), and a reverse-proxied deployment
whose loopback carries a different Host header would hit the same wall.
Test suites never see it because helpers.js uses 127.0.0.1 for both.
Seam-shaped ask: either core matches agents host-insensitively for
loopback binds, or `api.serverInfo` should bless one canonical loopback
URL that is guaranteed ownership-safe.

Twelve plugins in, the ranking is now empirical — a seam's rank is how many
ports reached for it without coordinating.

1. **`api.authorize(request, path, mode)`** — "would the host's WAC allow
   this?" **Four independent consumers: corsproxy/, capability/, pay/,
   caldav/.** The loopback trick (below) covers the case where
   the *requester's own* credentials should decide (notifications, webdav,
   sparql all use it), but it can't cover authorization the requester
   doesn't drive: a proxy governed by a *pod owner's* `.acl` (corsproxy
   #382), a capability exercising the *issuer's* authority
   (capability #506), pay/'s 402 gate (which wants to *compose with* WAC
   rather than replace it), or CalDAV scheduling (RFC 6638), where Outbox→Inbox
   delivery is a write into the *recipient's* pod the sender has no WAC
   right to make — loopback structurally cannot express it (a
   server-mediated deliver-to-inbox primitive is the narrower
   alternative). This is the most-requested seam and the one that
   moves the most backlog issues from "plugin-approximation" to "faithful".
2. **`api.events.onResourceChange(cb)`** — **seven consumers now:
   notifications/, sparql/, search/, matrix/, backup/, jmap/,
   remotestorage/** (plus oembed/ as a soft eighth: a write-time image-
   dimension cache would replace per-unfurl byte parsing), in rising
   sharpness: notifications (a miss is a *late* notification), sparql (a
   miss is a *wrong* query result), search (a miss is *stale results*, the
   property users most expect to be fresh — the most user-visible
   instance), matrix (its `/sync?since=` long-poll needs server-side sync
   cursors + **live push on writes** — an event hook feeding `api.ws.route`
   — so a stateless bridge can only do full-state `/sync` at all), and
   backup (with no change hook *and* no plugin-owned read authority,
   incremental and scheduled/server-initiated backup are both unbuildable —
   every backup is a caller-driven full crawl), jmap (JMAP push
   (`eventSourceUrl`) and delta sync (`*/changes`, `Email/queryChanges`)
   are omitted/refused in-protocol), and remotestorage (rS's
   descendant-version propagation at depth ≥ 2 needs a write-time index).
   sparql/'s UPDATE work sharpened the whole entry: **owning a write
   endpoint does not buy the write-time index** — a plugin could index
   its own writes synchronously, but plain-LDP writes bypass it, yielding
   a silently-wrong index (worse than none); only the host's event stream
   sees all writes. caldav/'s free-busy added a wrinkle: a shared
   write-time index must answer "indexed under whose authority?" or it
   leaks WAC-hidden data.
   Core already has the
   emitter internally (`src/notifications/events.js`); this is the seam
   every "react to pod writes" app (webhooks, indexing, sync, search, live
   chat) will want, and it's now clearly the #2 most-demanded after
   `api.authorize`.
3. **`api.serverInfo` (`{ baseUrl, port }` at listen)** — **23
   consumers: notifications/, webdav/, carddav/, caldav/, sparql/, rss/,
   webfinger/, mastodon/, bluesky/, activitypub/, matrix/, micropub/,
   backup/, metrics/, dashboard/, oembed/, jmap/, remotestorage/, s3/,
   search/, shortlink/, didweb/, admin/** — essentially
   every plugin that mints absolute URLs or reaches the host over loopback.
   All repeat the origin in config today; a wrong value fails quietly
   (webfinger mints WebIDs on the wrong origin; didweb serves a `did.json`
   whose `id` doesn't match its URL). (nip05/ was once listed here —
   wrongly: its README finding is that NIP-05 documents carry no absolute
   self-URLs; its config repetition is the *data-root* class, `podsRoot`,
   which serverInfo doesn't cover.) **LANDED — #601, JSS 0.0.218 —**
   **and consumed** by webfinger/, didweb/, dashboard/, admin/, gallery/
   (resolve at request time; `config.baseUrl` stays as the reverse-proxy
   override); ~18 mechanical retrofits remain. Was the single most
   *broadly* needed seam
   (vs. api.authorize being the most *blocking*); trivially cheap to provide.
4. **The unconsumed-body-**stream** primitive (#583)** — consumers:
   gitscratch/ sharpened it; micropub/ adds a blocked one. tunnel/ needed
   the raw *buffer*; git needs the raw *stream* piped to a subprocess
   gzip-and-all; micropub's **media endpoint** (multipart file upload) is
   simply not implemented until a plugin can pipe an un-drained body;
   jmap/ likewise omits blobs/attachments (`uploadUrl` absent,
   `maxSizeUpload: 0` advertised honestly).
   **LANDED — as `api.mountApp`, JSS 0.0.219 — and consumed** by
   gallery/ (streaming upload → loopback PUT, O(1) plugin memory).
   gallery/'s measurements sharpen what remains: the mounted lane
   sidesteps the host `bodyLimit` (a mounted app that does NOT forward
   to core has no cap unless it adds one); streaming still ends at
   core's front door (the loopback PUT buffers — the missing half is a
   streaming LDP write path); core's LDP GET honors Range natively, so
   playback needed nothing; and `getAgent` wants a raw-req form (Bearer
   works via a shim, DPoP/NIP-98 can't verify in the raw lane).
   Whatever `api.mountApp` / raw-body mode ships must hand back the
   un-drained stream, not just a buffered body. (This is exactly what the
   merged loader's scoped pass-through parser does — the finding is to
   keep it that way.)
5. **Routes/WAC-exemption outside the single prefix** — **the most-hit
   finding: seven+ consumers. LANDED — as `api.reservePath` (#602),
   JSS 0.0.219 — and consumed**: mastodon/bluesky/activitypub/matrix
   self-reserve their literal roots (widened to exactly the verbs their
   routes implement — the read-only default is the right trap-guard),
   didweb/ consumes the parameterized form (`/:user/did.json`, the
   previously-inexpressible case). Still open from this cluster: the
   shared-discovery-document case (webfinger↔remotestorage both own
   parts of one JRD — a reservation can't split a document; the ask is
   a link registry), and didweb/'s new edge: the reservation matcher is
   length-unbounded while `:user` routes cap at `maxParamLength` 100,
   so an over-long name falls through to LDP `GET /*` with the
   exemption applied (harmless read-only, but a real mismatch). The
   history, kept because the sharpenings still teach: A plugin can *register* absolute/exact
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
     bluesky/ (`/xrpc`), activitypub/ (`/ap`), matrix/ (`/_matrix`). Here
     the plugin **cannot
     serve its own surface**: every call 401s at the WAC hook until the
     operator hand-passes `appPaths`. **Four independent protocol-shim
     confirmations**, each built separately. bluesky sharpened it (one root,
     still unreachable → the ask is "declare owned paths," not "more
     prefixes"); activitypub sharpened it further — its natural layout wants
     paths **interleaved with** the pod's own `/<user>/` namespace, which no
     single mount prefix can carve out at all.
   - **parameterized paths can't be exempted at all** — didweb/ serves
     `/<user>/did.json`, which lives *inside* the pod's own WAC-governed
     `/<user>/` namespace. `appPaths` matches literal prefixes, so it can't
     carve out a parameterized route interleaved with pod paths; and unlike
     an API shim, did:web can't escape to a fake root (the DID id is fixed
     by the method). It works only where the pod grants public Read. This is
     the sharpest form and needs a **parameterized** `api.reservePath`.
   - conflict detection: **the collision is now WITNESSED, both ways**
     (remotestorage/ + webfinger/ both own `/.well-known/webfinger`).
     Unguarded claim second → boot fails: `plugin remotestorage:
     activate() failed: Method 'GET' already declared for route
     '/.well-known/webfinger'` (Fastify's `FST_ERR_DUPLICATED_ROUTE`, but
     the loader's error wrap **drops `err.code`** — only the message
     identifies it). Reverse order → boot *succeeds* and webfinger/'s
     try/catch-guarded claim **silently loses**: its profile/actor/issuer
     links vanish with no error. Loud failure or silent loss — both wrong,
     because both plugins legitimately own *parts* of one discovery
     document. The missing seam is a link/JRD registry
     (`api.webfinger.addLink`).
   The seam: `api.reservePath('/xrpc')` / `api.reservePath('/:user/did.json')`
   (or `paths: [...]` in the entry) — the loader exempts *and* claims each
   deliberately and reports collisions. The seam **every API-shim plugin**
   structurally requires; third most-demanded after `api.authorize` and
   `api.events`. **Counter-witness that sharpens it:** micropub/ is a
   protocol shim that needed *no* reservation at all, because Micropub
   endpoints are client-discovered rather than protocol-fixed — the seam
   is specifically about protocols that pin absolute paths, not API shims
   per se.
6. **Can't set fastify server options** — consumers: capability/ hit
   `maxParamLength` (100) silently 404ing long tokens in named params;
   shortlink/ dodged it pre-emptively the same way. Workaround is a
   wildcard route. A plugin has no way to raise per-route
   limits. Minor, but sharp when it bites.
7. **Internal utility modules plugins re-vendor** — consumer: relay/
   (`src/nostr/event.js` NIP-01 verify), pay/ (`src/mrc20.js`). Pure crypto.
   Export like auth.js (`javascript-solid-server/nostr.js`) or bless
   vendoring.
8. **Response-header injection on core routes** — **three consumers:
   notifications/** (`Updates-Via` discovery), **micropub/** (clients
   find the endpoint via `<link rel="micropub">` on the user's homepage —
   a core-owned resource the plugin can't decorate; the operator must
   advertise it by hand), and **oembed/** — the sharpest form: oEmbed
   discovery wants a per-resource `<link>` in *every HTML resource's
   head*, which even a gated header hook couldn't provide (in-HTML
   injection is content rewriting — core's side of the #564 line; the
   `Link:` header variant would cover the rest). A plugin can't add
   headers to routes it doesn't
   own. NOT a default-on hook (bigger grant than route ownership); gate
   behind `capabilities: ['hooks']` if ever.
9. **Plugin-to-plugin isolation is ZERO (measured — metrics/).** All
   loader entries are activated against **one shared Fastify register
   scope**: a hook added on `api.fastify` (`onRequest`, `preHandler`,
   `onResponse`, `onSend`) fires for **every plugin's routes, whichever
   order the entries load** — and **never** for core routes (`/`, LDP,
   `/.well-known/*`), which live on the parent instance behind Fastify
   encapsulation. So the #564 line holds against *core* (a plugin cannot
   observe or modify core's pipeline), but plugins can already observe
   *and intercept* each other with no capability gate. Design tension for
   any future `capabilities: ['hooks']`: per-plugin encapsulation would be
   the safer default, but it would break the one legitimate consumer found
   (metrics/' cross-plugin request counters) — a scoped-vs-shared choice
   the loader should make deliberately, not inherit from `register`.
10. **`api.plugins` (the #463/#464 app-registry) — two consumers:
    dashboard/ and admin/.** The plugins whose job is describing the
    deployment cannot enumerate their co-loaded siblings; the operator
    hands each a
    hand-copied duplicate of the `createServer` plugins list, and the
    copies silently drift (an added plugin never appears; a removed one
    keeps probing). serve.js now maintains ONE shared `INVENTORY` array
    beside the real plugins array — the workaround that proves the
    seam. The loader already holds exactly the needed data:
    `api.plugins → [{ id, prefix, module }]`, read-only, plus optional
    probe/health hints per entry.
11. **No operator concept — `api.isOperator` (admin/).** Three plugins
    now hold three incompatible answers to "who is the operator?":
    terminal/ (shared token), metrics/ (optional bearer token), admin/
    (`adminAgents` WebID allowlist). The host itself knows nothing of
    operators, so every ops-facing plugin invents its own gate. A tiny
    seam (`api.isOperator(agentId)` or an `operators: []` server option)
    would unify them.
12. **The admin-surface gaps, named (admin/).** The wp-admin pillars the
    api cannot express, each measured by building the operator home:
    runtime **enable/disable** (`deactivate()` exists but nothing calls
    it after boot), **install** (#200 marketplace + post-boot loading),
    **settings panels** (no contribute-a-panel affordance — the
    `adminPage` link convention is the workaround), **log viewing**
    (`api.log` is write-only), and **storage introspection** (pods/disk
    stats need an operator-repeated `podsRoot` path — a filesystem
    cousin of `api.serverInfo`). Full gap table in admin/README.md.

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
| remoteStorage | owns `/storage/:user/*` | ✅ plugin | remotestorage/ — 7th port; core's bundled copy could move out-of-tree |
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
- **The host's conditional write is check-then-write, not atomic**
  (sparql/, measured live): two *concurrent* PUTs carrying the same
  currently-valid `If-Match` both return 2xx and the loser is silently
  overwritten; the same two PUTs run sequentially 412 correctly. Two
  simultaneous writers can lose one with both told success — unfixable
  plugin-side; the host needs an atomic stat+write. **Filed-worthy.**
- **The loader's activate-failure wrap drops `err.code`**
  (remotestorage/): a route collision inside `activate` surfaces as
  `plugin <id>: activate() failed: <message>` with the original
  `FST_ERR_DUPLICATED_ROUTE` code stripped — callers can only string-match
  the message. Preserve `code` (or `cause`) when re-wrapping.
- **`logger: false` silently kills every plugin `onResponse` hook**
  (metrics/): core's access-log hook calls
  `request.log.isLevelEnabled('info')`, which doesn't exist on Fastify's
  null logger under `logger: false` — the hook throws per-request and the
  aborted chain means downstream *plugin* `onResponse` hooks never run
  (earlier stages are unaffected). Workaround: boot with `logger: true,
  logLevel: 'silent'`. One-line core fix; **filed-worthy.** (helpers.js
  defaults to `logger: false`, so any plugin using `onResponse` in tests
  hits this.)
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
- **No snapshot semantics** (backup/): a multi-resource read is never
  atomic — the api offers no lock, snapshot, or conditional multi-read, so
  an archive of a busy pod is an honest but mixed-state export. Related:
  a streaming response can't report post-walk results (skip counts) in
  headers — they're committed before the walk starts and there are no
  usable trailers — so backup/ writes an in-band `MANIFEST.json` as the
  last archive entry.
- **Permissions don't round-trip** (backup/): `.acl`/`.meta` could be
  exported (loopback enforces Control for free) but absolute-URL ACLs
  don't restore elsewhere — policy portability is a spec-level gap, not a
  plugin-api gap.
- **pluginDir vs pod resources — no doctrine** (shortlink/): stateful
  plugins choose between `pluginDir` (fast, private, invisible to WAC,
  backup, and portability) and pod resources (WAC-governed, portable,
  but a loopback round-trip per operation). The api offers one primitive
  and no guidance; a design note in the plugin docs would spare every
  author the same deliberation. Eleven plugins now persist in
  `pluginDir` — the most settled seam in the api.

- **Cross-engine float determinism** (globs/): `Math.hypot`, `Math.pow`,
  and library trig are implementation-defined precision; node 24 and
  headless Chromium disagreed on 4/20 knife-edge bot-mirror matches when a
  game sim was replayed on both. Fix in the sim itself: `sqrt(x*x+y*y)`,
  a pinned pow literal, and range-reduced Taylor trig — then 40/40 matches
  bit-identical. Any plugin acting as physics authority for a browser
  client will hit this; not an api seam, but worth knowing before trusting
  "same JS everywhere".
- **In-band WS bearer** (globs/): browsers can't set upgrade headers, so
  the plugin lifts `hello{token}` to an agent via `getAgent` with a
  synthetic headers-only request — valid for bearers per the auth.js
  contract, not for DPoP-bound tokens. Third WS plugin to want this;
  a documented `api.auth.getAgentFromToken(token)` would make it official.
