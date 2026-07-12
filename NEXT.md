# NEXT.md — handoff for the next LLM

You are continuing an in-progress effort to build out **out-of-tree plugins
for JavaScript Solid Server (JSS)** and, through them, discover what the
#206 plugin api is missing. Read this first, then `AGENT.md` (how to build a
plugin), `NOTES.md` (the findings/seams — the real deliverable), and
`ISSUES.md` (the plugin-tagged backlog triaged).

## Where things stand

- **35 plugins, 515 tests, all green** (`npm test`; the three
  `notifications/` fs.watch tests need a free inotify instance — see
  Footguns), all pushed to
  `github.com/JavaScriptSolidServer/plugins` (branch `gh-pages`).
- **Four seams are LANDED and CONSUMED (2026-07-12).** JSS 0.0.219 is
  published and pinned; `api.serverInfo` (#601), `api.reservePath` (#602 —
  including the parameterized form), `api.mountApp` (#583) and
  `api.plugins` (#610) all shipped. Consumed so far: webfinger+didweb
  (serverInfo), the four shims mastodon/bluesky/activitypub/matrix
  (reservePath — no more operator appPaths anywhere), didweb
  (`/:user/did.json`, the previously-impossible parameterized case),
  gallery (mountApp), dashboard+admin (api.plugins + serverInfo). The
  explicit-id footgun is gone too (0.0.219 derives ids from parent dirs).
  Still open upstream: `api.events` (#603), `api.authorize` (#604).
- `compose.test.js` boots all 34 on **one** JSS from pure config; `serve.js`
  is the runnable demo — its front door is `admin/` (`/admin/`), the
  capstone wp-admin-style operator home (both consoles auto-discover via
  api.plugins). All three must be updated when you add a plugin.
- Built so far: 7 ports (relay, webrtc, terminal, tunnel, notifications,
  remotestorage, pay) + 27 features (nip05, corsproxy, capability, webdav,
  sparql — now with UPDATE, gitscratch, otp, carddav, mastodon, bluesky,
  caldav — now with free-busy, webfinger,
  activitypub, rss, matrix, search, didweb, s3, micropub, backup,
  metrics, dashboard, oembed, jmap, shortlink, admin, gallery) — plus
  `federation-demo/`, a two-server loopback federation scenario (not a
  plugin; `node federation-demo/demo.js` narrates it).
- Capability classes covered: realtime, WebDAV family, fediverse/social/chat
  (5 shims), IndieWeb publishing, identity, data/query/search, object
  storage, proxy, dev, pay, data portability, ops/observability, mail,
  link-embeds, remoteStorage, media/streaming-upload.
- **REPORT.md exists** — the maintainer-facing summary (ranked seams, each
  fileable nearly verbatim). Keep its consumer counts current as plugins
  land.

## The hard rule (don't break it)

1. A plugin's `plugin.js` imports **only** node builtins, this repo's deps
   (`@noble/curves`, `ws`), and `javascript-solid-server/auth.js`. **Never
   `javascript-solid-server/src/...`.** A wall you can't cross without an
   internal *is a finding* — document it, approximate honestly, move on.
2. **The core-freeze is LIFTED (2026-07-11).** Core changes are now on the
   table — the four seams from REPORT.md are filed (core #601–#604) and
   #601 `api.serverInfo` is **merged** (core #605). Still: one seam per PR,
   each independently evidenced, following core's convention (feature
   branch → squash PR to `gh-pages` → version bump). Don't bundle; the
   value of this experiment is that every seam is separately proven.
   (Earlier waves ran under a strict no-core rule — that's why the plugins
   are honest approximations; keep them that way until a seam actually
   lands and is *published*.)
3. Core is at `~/remote/github.com/JavaScriptSolidServer/JavaScriptSolidServer`,
   at 0.0.219 on `gh-pages`, published to npm, and this repo pins
   `^0.0.219`. REMEMBER the trap for the next bump: caret on a `0.0.x`
   version locks to the exact patch (`^0.0.219` = only 0.0.219), so
   consuming a future release means editing the dependency string itself,
   then `npm install`.

## Stage 3: consuming the merged seams (the upstream loop)

The point of filing the seams was never the issues — it's closing the
loop: **seam lands in core → plugins get simpler/faithful, proven**.
**STATUS 2026-07-12: the loop is CLOSED for four seams.** 0.0.219 is
published + pinned; webfinger/didweb consume serverInfo, the four shims
self-reserve their roots, didweb reserves the parameterized
`/:user/did.json`, gallery consumes mountApp, dashboard/admin consume
api.plugins. What follows is the how-to, kept because ~18 plugins still
carry the old baseUrl/loopbackUrl config pair and retrofit the same way
(mechanical now; the strongest-story pairs are done).

### What `serverInfo` gives you

`api.serverInfo() → { baseUrl, protocol, host, port, listening }`. A
**function**, called lazily (per-request or in an `onListen` hook via
`api.fastify`) — *not* cached at activate, because with an ephemeral port
the real port only exists after listen. `idpIssuer` wins as the canonical
public `baseUrl`. One call collapses **both** config values most plugins
carry: `.baseUrl` replaces the public-origin config, and
`http://${host}:${port}` replaces `loopbackUrl` (the callable bind).

### The retrofit is NOT a find-replace

Plugins that capture `baseUrl`/`loopbackUrl` at activate and `throw` if
missing (the fail-loud pattern) must **move the `serverInfo()` call to
request time** — at activate the port may be unresolved. Keep
`config.baseUrl` as an *optional override* where a plugin genuinely needs
a public origin different from the server's (reverse-proxy edge cases),
rather than deleting it everywhere.

### What's done, what remains

**DONE**: `webfinger/` + `didweb/` (the silent-failure pair — webfinger
minted WebIDs/JRD links on the wrong origin; didweb's `did.json` `id`
wouldn't match its URL), plus dashboard/, admin/, gallery/. (nip05/ was
once slated here — wrongly: its own README finding says NIP-05 documents
contain no absolute self-URLs; its silent-empty-map failure is the
*data-root* class, `config.podsRoot`, which serverInfo does not cover.)
**REMAINING (~18, mechanical)**: the DAV family, the four shims, rss,
sparql, notifications, micropub, backup, metrics, oembed, jmap,
remotestorage, s3, search, shortlink — same shape each time: resolve at
request time, keep `config.baseUrl` as the reverse-proxy override, drop
the throw-on-missing. Then the next seams upstream:
`events` (#603) → `authorize` (#604).

## Phase 1: a blessed read-only status console (`dashboard/`)

The strategic goal beyond simplifying plugins: get one **blessed official
plugin** upstream. `dashboard/` is the phase-1 target — read-only, probes
anonymously (a 401 = "alive", so **no operator/auth seam needed**), and
gated on exactly **one** seam: `api.plugins` (**filed core #610**), so its
inventory stops being a hand-copied `config.plugins` list that silently
drifts.

Steps: (1) land core #610 ✅ → (2) bump+publish core ✅ (0.0.219) → (3)
flip this repo's pin ✅ → (4) retrofit `dashboard/` ✅ (api.plugins +
serverInfo, committed) → (5) finalize README/screenshot → (6) bless via
core docs + the `--plugin` CLI opt-in (#595 — note 0.0.219's parent-dir
id fix was exactly what made multi-`--plugin` work) → (7) announce.
**Next actionable step: (5)–(7), the blessing itself.**

The richer `admin/` console (pod stats + an operator gate) is **phase 2** —
it additionally needs an operator-identity seam (`api.isOperator`; three
plugins answer "who's the operator?" three ways today), which is a real
design decision, not a quick seam. Ship the status console first.

## Wave 7 status

`micropub/` and `backup/` are **built and integrated**. Two remain
*deliberately deferred*, not forgotten:

| Plugin | What | Why deferred |
|---|---|---|
| `webhooks/` | change-notification webhooks; **must poll** (no `api.events`) → a 6th consumer of that seam | POSTs to arbitrary operator-supplied URLs — build with corsproxy/-grade SSRF gates and a careful review, in a session focused on it |
| `webmention/` | IndieWeb Webmention receiver — store incoming mentions in the pod | spec requires fetching the (arbitrary) source URL to verify the link — same outbound-fetch caution as webhooks |

If you build them, copy notifications/ (fs.watch) + rss/sparql (walk) for
webhooks, activitypub/ inbox + corsproxy/'s SSRF gates for webmention.
Dispatch each as its own worker into its own directory (they don't conflict
— separate subdirs, shared files touched only by you at integration time).
Verify each with `node --test --test-concurrency=1 <name>/test.js`, then:

## The per-plugin loop (do this for every plugin)

1. Build `<name>/{plugin.js,test.js,README.md}` per `AGENT.md`. README must
   have a `## Findings` section — the findings are the point.
2. `node --test --test-concurrency=1 <name>/test.js` → green.
3. `git add <name>/ && git commit && git push` (commit message: what it
   does + its headline finding; **no AI-generated footer/trailer** — the
   maintainer's global rule).
4. After a wave lands, integrate: add entries to `compose.test.js` and
   `serve.js` (no explicit `id` and no `appPaths` needed since JSS
   0.0.219 — ids derive from the parent dir, fixed roots self-reserve),
   add a liveness probe to `compose.test.js`, run `npm test`,
   update `README.md` (table + count), `ISSUES.md` (tally), `NOTES.md`
   (fold in new findings, re-rank seams by consumer count), and `AGENT.md`
   (copy-map + count). Commit + push the integration.

## Wave 8+ backlog (unbuilt ideas, roughly by value)

Still genuinely plugin-shaped and distinct:
- **feed ingest** — subscribe to external RSS/Atom, store items in the pod
  (the inverse of `rss/`; uses a corsproxy-style fetch — outbound fetches:
  same careful-session caveat as webhooks/webmention).
- **WebSub/PubSubHubbub** (needs `api.events` + outbound POSTs — deferred).
- **CalDAV scheduling (RFC 6638)** — blocked on cross-user delivery
  (api.authorize's issuer-authority case, or a deliver-to-inbox
  primitive); free-busy is done.
- **Bluesky/Mastodon/Matrix Phase-2** (federation, `/sync` live push) —
  the `api.reservePath` half is now consumed; still blocked on
  `api.events` for live push. Good once that seam exists.
- **More fun demos in the federation-demo/ vein** — a QR share page
  (capability + shortlink composition), a music/podcast pod (gallery's
  Range finding makes byte-range playback free), a turn-based game over
  relay + pod state. Demos compose existing plugins; loopback only.
- **forge/ tier 2** (tier 1 SHIPPED 2026-07-12: push-to-create hosting,
  GitHub-light UI, JSON API — see forge/README Findings). Tier 2 =
  issues + comments **as pod resources** (WAC-governed, portable — the
  thing Gitea structurally can't offer), repo settings, profile pages.
  Tier 3 = PRs/forks (git CLI can merge; the UI is the work). Wants:
  api.authorize for collaborators, api.events for webhooks.
- **Phanpy Wave B — real federation** (Wave A is DONE, 2026-07-12: the
  mastodon/ shim is Phanpy-grade for local use — timelines, threads,
  media, notifications from the AP inbox, PKCE; serve a Phanpy dist at
  any origin and point it at the server). Wave B = inbound HTTP-Signature
  verification (SECURITY.md accepted-risk #1), remote actor resolution,
  Like/Announce/Follow delivery, ingest of followed actors' posts —
  outbound-fetch class, activitypub/'s SSRF gates are the pattern; use
  federation-demo/ as the regression harness. Streaming stays blocked on
  api.events (#603); Phanpy polls fine.

Prefer plugins that open a **new capability class** or add a **new
independent consumer of an already-named seam** (that strengthens the
finding). Avoid re-proving something already witnessed many times unless
it sharpens the case.

## The findings are the deliverable — keep them sharp

`NOTES.md` ranks candidate seams by how many independent plugins demanded
each. Current top four (keep this current as you add consumers):

1. **`api.authorize(request, path, mode)`** — 4 consumers (corsproxy,
   capability, pay, caldav — caldav scheduling joined); the top
   *blocking* seam (authority the requester doesn't drive).
2. **`api.events.onResourceChange`** — 7 consumers (backup, jmap,
   remotestorage joined); matrix `/sync` needs
   live push, and sparql/'s UPDATE proved owning a write endpoint does
   not buy a write-time index. Every "react to writes" plugin (webhooks,
   WebSub, indexing) will want it.
3. **`api.reservePath`** — **LANDED (#602, JSS 0.0.219) and consumed**:
   the four shims self-reserve their literal roots; didweb consumes the
   parameterized form (`/:user/did.json`). Remaining asks recorded in
   NOTES: a JRD/link registry for shared discovery docs (the webfinger↔
   remotestorage collision), and the matcher-vs-maxParamLength edge
   didweb documented. (micropub/ stays the counter-witness:
   client-discovered endpoints need no reservation.)
4. **`api.serverInfo`** — broadest (~23 plugins hand-rolled their origin).
   **LANDED (#601, JSS 0.0.218) and consumed** by webfinger, didweb,
   dashboard, admin, gallery; ~18 mechanical retrofits remain (see
   Stage 3).

Plus: the body-**stream** primitive **(#583 — LANDED as api.mountApp,
JSS 0.0.219; gallery/ is the first consumer**; micropub's multipart media
endpoint is now parser-work, not seam-work), `api.mcp.registerTool`
(blocks the MCP-tool issues #495/#496/#500/#501), can't-set-server-options,
and response-header hooks. `#564` (the core/plugin line) is answered
empirically in NOTES: **route-owning → plugin, pipeline-modifying → core**.

## Meta-work worth doing (beyond more plugins)

- **The summary write-up is DONE — `REPORT.md`.** Keep it current (counts,
  consumers) whenever a wave lands; it's written so each seam could be
  filed nearly verbatim.
- **Filing the seams as upstream issues** — but only if the maintainer asks
  (core-repo interaction is currently off; see the hard rule). REPORT.md
  is the draft.

## Footguns (every multi-boot test suite rediscovered these)

- Module-global `DATA_ROOT`: a second `createServer` in one process (even a
  failing one) poisons the first — order validation-failure tests *before*
  the long-lived boot.
- Ambient `~/.gitconfig` for git-shelling plugins: spawn with
  `GIT_CONFIG_NOSYSTEM=1`, no `HOME`.
- Generic-basename id: `<name>/plugin.js` all reduce to `plugin` — always
  pass an explicit `id` in compose/serve entries.
- Dotted prefixes (`/.foo`) fail the WS upgrade — use plain prefixes for
  anything with a socket. (`/.well-known/*` HTTP works, by core's blanket
  exemption — but that's the reserved-path finding, not a guarantee.)
- `fs.watch` needs a free inotify instance: when the machine is at
  `fs.inotify.max_user_instances`, watch creation fails (EMFILE) and the
  three `notifications/` fan-out tests time out. An environment failure,
  not a regression — check `sysctl fs.inotify.max_user_instances` before
  debugging the plugin.

## Issue tracker (new — 2026-07)

The repo now uses GitHub issues, not just these docs:
- **#1–#6** — security accepted-risk from SECURITY.md (activitypub sig
  verification, DNS-rebind TOCTOU, per-resource size cap, pluginDir
  read-modify-write TOCTOU, s3 md5, relay rewrite).
- **#7–#10** — `plugin-idea` contributor entry points (webhooks,
  webmention, feed-ingest, WebSub — all need SSRF-gated outbound fetch).
- **#11** — the roadmap/tracking umbrella (state of the repo + doc index).
Keep new deferrals/ideas as issues going forward; these docs stay the
narrative, issues are the actionable subset.

## Open items for the human (don't act without a nudge)

- The repo exists and is public; keep pushing to it.
- Core PRs #590 / #591 are unmerged — the maintainer's call.
- **Bugs AND seams are FILED upstream** (2026-07-11): five bugs as core
  #596–#600, four seams as core **#601 (serverInfo), #602 (reservePath),
  #603 (events), #604 (authorize)**. Next upstream step (Stage 3, needs
  the core-freeze lifted): ship `serverInfo` (#601) end-to-end as the
  reference PR — cheapest seam, ~23 consumers — then retrofit the plugins
  that hand-roll their origin. Secondary asks (api.plugins, api.isOperator)
  not filed yet; raise when a design discussion on the four opens.
