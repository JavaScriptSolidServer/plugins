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
| #509 | `sparql/` | SPARQL SELECT + UPDATE over pod JSON-LD (write-index → 🔩 `api.events`) |
| #322 | `gitscratch/` | ephemeral Solid-authed git remotes (git-http-backend CGI) |
| — | `markets/` | prediction markets/AMM (no issue; built to probe money-shaped state: journal, CSRF, scoped creds) |
| #515 / #516 | `mastodon/` | Mastodon-API shim — a client can log into its own pod (self-reserves `/api`+`/oauth` — #602 consumed) |
| #505 | `otp/` | one-time-password session flow (account *recovery* → 🔩 core auth) |
| #157 | `carddav/` | CardDAV contact sync (iOS/macOS/Thunderbird/DAVx5) |
| #211 | `bluesky/` | AT-Protocol XRPC shim — a client logs into its own pod (self-reserves `/xrpc` — #602 consumed) |
| #157-sib | `caldav/` | CalDAV calendar sync — completes the DAV family |
| #164 | `webfinger/` | `/.well-known/webfinger` — the WebFinger half of #164 |
| #51/#164 | `activitypub/` | federate a pod as an AS2 actor (self-reserves `/ap` — #602 consumed) |
| — | `rss/` | any pod container as an Atom/RSS feed |
| — | `matrix/` | Matrix Client-Server API shim (chat) |
| — | `search/` | full-text search over pod resources |
| — | `didweb/` | `did:web` DID-document resolver |
| — | `s3/` | S3-compatible object-storage gateway |
| — | `micropub/` | IndieWeb Micropub endpoint (media upload: #583 landed as api.mountApp — parser work remains, see gallery/) |
| — | `backup/` | pod → `.tar.gz` export (incremental backup → 🔩 `api.events`) |
| — | `metrics/` | `/healthz` + Prometheus exporter (core-pipeline metrics → 🔩 gated hooks) |
| — | `dashboard/` | plugin status page (sibling discovery via api.plugins #610 — consumed) |
| — | `oembed/` | oEmbed provider (discovery injection → 🔩 header/content hooks) |
| — | `jmap/` | JMAP mail over the pod (push/delta → 🔩 `api.events`; blobs: #583 landed as api.mountApp — retrofit pending) |
| #163 | `remotestorage/` | remoteStorage server — 7th port; witnessed the webfinger collision |
| — | `shortlink/` | link shortener for pod URLs (pluginDir persistence, 11th witness) |
| #463/#464-adj | `admin/` | operator home — the wp-admin gap analysis; every missing pillar names a seam |
| #583-adj | `gallery/` | pod photo/media gallery — first `api.mountApp` consumer; zero required config |
| #322-next | `forge/` | personal git forge — persistent push-to-create hosting, GitHub-light UI, JSON API |

Plus seven **ports of bundled features** proving the migration path for
#564 / #164: `relay/` `webrtc/` `terminal/` `tunnel/` `notifications/`
`remotestorage/`, and `pay/`
(the wall-report — it can't be a plugin, which is the point).

## Shipped upstream this line of work 🚢

| Issue | Where |
|---|---|
| #206 | the loader — `createServer({ plugins })`, merged, v0.0.215 |
| #582 | `appPaths` WAC exemption, v0.0.213 |
| #584 | `api.auth.getAgent`, v0.0.214 |
| #588 | `api.ws.route` WebSocket routing, v0.0.215 |
| #601 | `api.serverInfo` — the server's own origin, v0.0.218; consumed by webfinger/didweb/dashboard/admin/gallery |
| #602 | `api.reservePath` — literal + parameterized, v0.0.218; consumed by the four shims + didweb |
| #583 | `api.mountApp` — raw handler, un-drained stream, v0.0.218; consumed by gallery/ |
| #610 | `api.plugins` — the loaded-plugin roster, v0.0.218; consumed by dashboard/ + admin/ |
| #596 | generic-basename id derivation fix, v0.0.219 — the explicit-id workaround deleted repo-wide |
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
| #505 (recovery) | `api.auth.mintSession` / `api.identity.addAuthKey` — turn a proven channel into pod authority |
| #495 #496 #500 #501 | `api.mcp.registerTool` — MCP has no plugin-tool seam; all four MCP issues want new tools a plugin can't add today |
| #463 #464 | app-registry primitive — surfacing installed plugins as *Solid resources*; the in-process half landed as `api.plugins` (#610, consumed by dashboard/+admin/), the as-pod-resources half is still open |

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

Of ~40 plugin-tagged issues: **14 built as plugins here** (plus `rss/`,
`matrix/`, `search/`, `didweb/`, `s3/`, `micropub/`, `backup/`, `metrics/`,
`dashboard/`, `oembed/`, `jmap/`, `shortlink/`, `admin/`, `gallery/` —
capability demonstrations with no single issue), **7 ported**, **10
shipped upstream** (the loader plus four seams and the id fix in JSS
0.0.218/0.0.219, each consumed here), **2 more plugin-able with no
blocker**, **4 clusters blocked on a named seam** (each with a
proof-of-need consumer), the rest core-by-nature or product-scale.
**35 plugins total, 527 tests** (plus the two-server `federation-demo/`
scenario). The plugin api reaches most of the backlog today; ranked by
demand, the seams that would unlock the most next are `api.authorize`
(4 consumers, 3 hard-blocked) and `api.events` (7 consumers — matrix
`/sync` needs live push, jmap can't do push or delta sync, backup can
only pull-on-demand). `api.reservePath` and `api.serverInfo` — the
former #3 and #4 — are **landed and consumed**; what remains of them is
the JRD/link registry for shared discovery documents and the ~18
mechanical serverInfo retrofits.
