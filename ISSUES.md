# Plugin-tagged issues — disposition

A pass over JSS's `plugin`-labelled backlog, asking of each: *can the public
plugin api do this today, and if not, what's missing?* This repo is the
evidence. Legend:

- ✅ **built here** — a working plugin in this repo, tested
- 🧩 **plugin-able, not yet built** — no blocker, just unbuilt
- 🔩 **needs a seam** — a plugin *can't* do it until the api grows (the seam
  is named; a consumer here proves the need)
- 🏛️ **core, not a plugin** — pipeline-modifying or infrastructural; belongs
  in `src/` (this is a *finding*, not a gap)
- 🗺️ **product/design** — a large feature or an open design question, beyond
  a single plugin

## Built as plugins here ✅

| Issue | Plugin | Note |
|---|---|---|
| #445 | `nip05/` | NIP-05 discovery from pods' public keys |
| #382 / #379 | `corsproxy/` | CORS forward proxy, fail-closed SSRF defense |
| #506 | `capability/` | scoped, time-bound, revocable capability URLs |
| #507 | `webdav/` | mount a pod in Finder/Nautilus/Windows |
| #509 | `sparql/` | read-time SPARQL over pod JSON-LD (write-index → 🔩 `api.events`) |
| #322 | `gitscratch/` | ephemeral Solid-authed git remotes (git-http-backend CGI) |
| #515 / #516 | `mastodon/` | Mastodon-API shim — a client can log into its own pod (needs `appPaths` widened → 🔩) |
| #505 | `otp/` | one-time-password session flow (account *recovery* → 🔩 core auth) |
| #157 | `carddav/` | CardDAV contact sync (iOS/macOS/Thunderbird/DAVx5) |
| #211 | `bluesky/` | AT-Protocol XRPC shim — a client logs into its own pod (needs `appPaths` widened → 🔩) |
| #157-sib | `caldav/` | CalDAV calendar sync — completes the DAV family |
| #164 | `webfinger/` | `/.well-known/webfinger` — the WebFinger half of #164 |
| #51/#164 | `activitypub/` | federate a pod as an AS2 actor (needs `appPaths` widened → 🔩) |
| — | `rss/` | any pod container as an Atom/RSS feed |

Plus six **ports of bundled features** proving the migration path for #564 /
#164: `relay/` `webrtc/` `terminal/` `tunnel/` `notifications/`, and `pay/`
(the wall-report — it can't be a plugin, which is the point).

## Shipped upstream this line of work 🚢

| Issue | Where |
|---|---|
| #206 | the loader — `createServer({ plugins })`, merged, v0.0.215 |
| #582 | `appPaths` WAC exemption, v0.0.213 |
| #584 | `api.auth.getAgent`, v0.0.214 |
| #588 | `api.ws.route` WebSocket routing, v0.0.215 |
| #564 | the core/plugin line — answered empirically in [NOTES.md](./NOTES.md) |

## Plugin-able, not yet built 🧩

| Issue | Shape |
|---|---|
| #527 | Tunnel client mode — extends `tunnel/` to dial *out* to a relay |
| #277 | MongoDB-backed relay — `relay/` with a Mongo store (needs the infra) |

## Needs a seam the api doesn't have yet 🔩

Each names the seam and the consumer that proves it. Ranked in
[NOTES.md](./NOTES.md).

| Issue(s) | Missing seam |
|---|---|
| #509 (write-index), #501 | `api.events.onResourceChange` — react to pod writes |
| #382 (per-pod ACL), #506 (pod grants) | `api.authorize(request, path, mode)` — ask the host's WAC |
| #515/#516, #211 (both built, but need operator `appPaths`) | `api.reservePath()` — an API-shim owns fixed roots outside its prefix and can't self-exempt them from WAC; **two independent confirmations** |
| #505 (recovery) | `api.auth.mintSession` / `api.identity.addAuthKey` — turn a proven channel into pod authority |
| #495 #496 #500 #501 | `api.mcp.registerTool` — MCP has no plugin-tool seam; all four MCP issues want new tools a plugin can't add today |
| #463 #464 | app-registry primitive — surfacing installed plugins as Solid resources |

## Core, not a plugin 🏛️ (a finding, not a gap)

Pipeline-modifying or infrastructural — they *are* the pod, or they change
every request:

| Issue | Why core |
|---|---|
| #185 | token-based storage quota — gates the LDP write path |
| #476, #271 | git auto-init header, git-mark post-receive — inside the core git handler |
| #236 | SFTP/SSH — a separate server protocol, not a Fastify route |
| #154 | SQLite `db` backend — a storage driver |
| #133 | OIDC-provider replacement — the auth core itself |

## Product / design 🗺️

Large features or open questions beyond one plugin: #200 (marketplace),
#199 #198 (agent containers), #194 #184 (pane store), #183 (skill
provenance), #163 (remoteStorage follow-ups), #134 (WebID/AP URI unification),
#164 (WebFinger/OAuth extraction — partially met by `mastodon/`'s OAuth
bridge). Several become tractable *on top of* the plugin system now that it
exists.

## Tally

Of ~40 plugin-tagged issues: **13 built as plugins here** (plus `rss/`, no
issue), **6 ported**, **5 shipped upstream**, **2 more plugin-able with no
blocker**, **6 clusters blocked on a named seam** (each with a proof-of-need
consumer), the rest core-by-nature or product-scale. 20 plugins total, ~200
tests. The plugin api reaches most of the backlog today; ranked by demand,
the seams that would unlock the most next are `api.authorize` (3 blocking
consumers), `api.reservePath` (3 API-shims can't self-exempt), `api.events`
(2, one where a miss means *wrong* answers), and `api.serverInfo` (broadest:
~10 plugins hand-roll their own origin).
