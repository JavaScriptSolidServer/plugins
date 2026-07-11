# NEXT.md — handoff for the next LLM

You are continuing an in-progress effort to build out **out-of-tree plugins
for JavaScript Solid Server (JSS)** and, through them, discover what the
#206 plugin api is missing. Read this first, then `AGENT.md` (how to build a
plugin), `NOTES.md` (the findings/seams — the real deliverable), and
`ISSUES.md` (the plugin-tagged backlog triaged).

## Where things stand

- **32 plugins, 363 tests, all green** (`npm test`), all pushed to
  `github.com/JavaScriptSolidServer/plugins` (branch `gh-pages`).
- `compose.test.js` boots all 32 on **one** JSS from pure config; `serve.js`
  is the runnable demo. Both must be updated when you add a plugin.
- Built so far: 7 ports (relay, webrtc, terminal, tunnel, notifications,
  remotestorage, pay) + 25 features (nip05, corsproxy, capability, webdav,
  sparql — now with UPDATE, gitscratch, otp, carddav, mastodon, bluesky,
  caldav — now with free-busy, webfinger,
  activitypub, rss, matrix, search, didweb, s3, micropub, backup,
  metrics, dashboard, oembed, jmap, shortlink).
- Capability classes covered: realtime, WebDAV family, fediverse/social/chat
  (5 shims), IndieWeb publishing, identity, data/query/search, object
  storage, proxy, dev, pay, data portability, ops/observability, mail,
  link-embeds, remoteStorage.
- **REPORT.md exists** — the maintainer-facing summary (ranked seams, each
  fileable nearly verbatim). Keep its consumer counts current as plugins
  land.

## The hard rule (don't break it)

1. A plugin's `plugin.js` imports **only** node builtins, this repo's deps
   (`@noble/curves`, `ws`), and `javascript-solid-server/auth.js`. **Never
   `javascript-solid-server/src/...`.** A wall you can't cross without an
   internal *is a finding* — document it, approximate honestly, move on.
2. **Do NOT modify the JavaScriptSolidServer core repo** (no commits,
   branches, or PRs there). Everything goes in *this* repo. (The maintainer
   set this explicitly. Two core PRs — #590 `api.mountApp`, #591
   `/idp/refresh` — are already open and awaiting their call; leave them.)
3. Core is at `~/remote/github.com/JavaScriptSolidServer/JavaScriptSolidServer`,
   pinned to 0.0.215 on `gh-pages`. You may **read** it for reference; keep
   it clean.

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
   `serve.js` (give each an explicit `id`; add any fixed roots to their
   `appPaths`), add a liveness probe to `compose.test.js`, run `npm test`,
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
  these are blocked on `api.events` + `api.reservePath`; good once those
  seams exist, otherwise document the wall.

Prefer plugins that open a **new capability class** or add a **new
independent consumer of an already-named seam** (that strengthens the
finding). Avoid re-proving something already witnessed many times unless
it sharpens the case.

## The findings are the deliverable — keep them sharp

`NOTES.md` ranks candidate seams by how many independent plugins demanded
each. Current top four (keep this current as you add consumers):

1. **`api.authorize(request, path, mode)`** — 4 consumers (caldav
   scheduling joined); the top
   *blocking* seam (authority the requester doesn't drive).
2. **`api.events.onResourceChange`** — 7 consumers (backup, jmap,
   remotestorage joined); matrix `/sync` needs
   live push, and sparql/'s UPDATE proved owning a write endpoint does
   not buy a write-time index. Every "react to writes" plugin (webhooks,
   WebSub, indexing) will want it.
3. **`api.reservePath`** — every API-shim owns fixed roots outside its one
   prefix and can't self-exempt; didweb needs a *parameterized* form.
   (micropub/ is the counter-witness: client-discovered endpoints need no
   reservation — the seam is about protocol-fixed paths.)
4. **`api.serverInfo`** — broadest (~12 plugins hand-roll their origin).

Plus: the unconsumed-body-**stream** primitive (#583), `api.mcp.registerTool`
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

## Open items for the human (don't act without a nudge)

- The repo exists and is public; keep pushing to it.
- Core PRs #590 / #591 are unmerged — the maintainer's call.
- Whether to ever file the seam issues upstream — ask first.
