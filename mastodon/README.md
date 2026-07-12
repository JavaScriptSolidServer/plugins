# mastodon — a Mastodon-API shim over your own pod (#515 / #516)

Point a real Mastodon client at a JavaScript Solid Server and log in with
your pod credentials, post (with photos), reply, favourite, boost, and read
your notifications. This is **Phase 2 of
[#515](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/515)**
— Phanpy-grade parity, **local-only**: the target flow is *point
[Phanpy](https://phanpy.social) at this server → log in → home timeline
renders → post a photo → favourite/boost → the notifications tab shows
follows/likes/mentions*. No federation happens in this plugin; everything
moves over loopback, and delivering Like/Announce/Follow to remote servers
is Wave B (see [Findings](#findings)).

```
plugins: [{
  module: 'mastodon/plugin.js',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (status URIs + loopback)
    loopbackUrl: 'http://127.0.0.1:3000',  // optional: where the shim reaches the host
    title: 'My JSS',                        // optional: instance title
    podsRoot: './data',                     // optional: local-user discovery (public timeline)
    apRoot: '/ap',                          // optional: where activitypub/ is mounted
  },
}]
```

No `appPaths` needed: since JSS 0.0.219 the plugin claims and WAC-exempts
its two fixed roots itself at activate time via `api.reservePath('/api')` /
`api.reservePath('/oauth')` (#602) — see [Findings](#findings) for the gap
this closed, and for how the Phase-2 PUT/DELETE widening avoids the
fall-through trap.

## Pointing a client at it

Mastodon clients ask for a **server URL** and then run OAuth. Give the client
your JSS origin (`http://localhost:3000`). It will:

1. `POST /api/v1/apps` to register itself,
2. run the auth-code flow (`/oauth/authorize` renders a minimal login form;
   PKCE S256 is verified when sent), and
3. resend the resulting bearer on every call.

Web clients like **Phanpy** / **Elk** and the password-grant path both work.
For the password grant the client (or you, by hand) posts your pod username
+ password to `/oauth/token`; that bridges to the pod's own IdP and the
bearer you get back **is** your pod token.

```bash
# 1. register an app
curl -s localhost:3000/api/v1/apps -d client_name=cli -d redirect_uris=urn:ietf:wg:oauth:2.0:oob

# 2. log in (password grant → pod bearer)
TOKEN=$(curl -s localhost:3000/oauth/token \
  -d grant_type=password -d username=alice -d password='…' | jq -r .access_token)

# 3. post a photo
MEDIA=$(curl -s localhost:3000/api/v2/media -H "Authorization: Bearer $TOKEN" \
  -F file=@cat.jpg | jq -r .id)
curl -s localhost:3000/api/v1/statuses -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"status\":\"cat\",\"media_ids\":[\"$MEDIA\"]}"

# 4. read it back (Link headers drive pagination)
curl -si localhost:3000/api/v1/timelines/home -H "Authorization: Bearer $TOKEN" | grep -i '^link:'
```

## Endpoint coverage

| Endpoint | Status | Notes |
|---|---|---|
| `GET /api/v1|v2/instance` | ✅ done | public metadata; media enabled (4 attachments) |
| `POST /api/v1/apps`, `GET /api/v1/apps/verify_credentials` | ✅ done | persists to `pluginDir/apps.json`; vapid_key stub |
| `GET/POST /oauth/authorize` | ✅ done | login page + headless shortcut; PKCE challenge stashed |
| `POST /oauth/token` | ✅ done | `password`, `authorization_code` (+PKCE S256/plain verify), `refresh_token`, `client_credentials` |
| `POST /oauth/revoke` | ✅ done | acknowledges; pod bearer stays the IdP's concern |
| `GET /api/v1/accounts/verify_credentials` | ✅ done | CredentialAccount with `source` |
| `GET /api/v1/accounts/:id`, `lookup`, `relationships`, `:id/statuses` | ✅ done | Account.id == username; statuses paginate with Link |
| `POST /api/v1/accounts/:id/{follow,unfollow}` | ✅ local | recorded in pluginDir state; **delivery is Wave B** |
| `POST /api/v1/statuses` | ✅ done | + `in_reply_to_id` → Note.inReplyTo, `media_ids` → Note.attachment |
| `GET /api/v1/statuses/:id`, `:id/context` | ✅ done | context = inReplyTo chains over local statuses |
| `DELETE /api/v1/statuses/:id` | ✅ done | owner-only; loopback DELETE, WAC decides |
| `POST /api/v1/statuses/:id/{favourite,unfavourite,reblog,unreblog}` | ✅ local | pluginDir state; counts/flags in entities; **Like/Announce delivery is Wave B** |
| `GET /api/v1/statuses/:id/{favourited_by,reblogged_by}`, `/api/v1/favourites` | ✅ done | from the same state |
| `POST /api/v2/media` (+ `/api/v1/media`) | ✅ done | hand-rolled bounded multipart; loopback PUT to `<pod>/public/media/` |
| `GET/PUT /api/v1/media/:id` | ✅ done | PUT updates the description (alt text) |
| `GET /api/v1/timelines/home` | ✅ done | own posts + followed local users; `?limit/max_id/since_id` + Link |
| `GET /api/v1/timelines/public` | ✅ done | all local users **when `podsRoot` is set**; else degrades to own posts |
| `GET /api/v1/notifications` | ✅ done | maps the AP inbox (activitypub/ plugin) — Follow→follow, Like→favourite, Announce→reblog, Create(reply/Mention)→mention |
| stubs (custom_emojis, filters v1+v2, lists, bookmarks, follow_requests, conversations, scheduled_statuses, announcements, mutes, blocks, trends, peers, directory, markers, preferences, search v1+v2, tag timelines) | ✅ empty shapes | 200 + CORS so Phanpy renders instead of erroring |
| `GET /api/v1/streaming/health` | ✅ done | `OK`; **no ws streaming** — Phanpy falls back to polling |
| status edit, polls, bookmarks (real), account update | ⛔ not yet | see Findings |

Every `/api` + `/oauth` response — including 401s and preflights — carries
wide-open CORS (`access-control-allow-origin: *`, expose-headers `Link`),
because a 401 without CORS looks like a *network error* to a browser client.

## The OAuth → pod-credentials mapping

Mastodon's `access_token` is just a bearer the client resends. A Solid pod's
access token is *also* just a bearer. So the bridge is direct — no token of
our own, no session store:

| Mastodon step | What the shim does |
|---|---|
| `POST /oauth/token` `grant_type=password` | loopback `POST /idp/credentials` with the username+password → return the pod bearer as `access_token` |
| `GET/POST /oauth/authorize` | mint a pod bearer the same way, stash it (with the PKCE challenge) under a one-time `code`, redirect `?code=…` |
| `POST /oauth/token` `grant_type=authorization_code` | look the `code` up, verify PKCE if a verifier arrives, return the stashed pod bearer (one-time) |
| `grant_type=refresh_token` | in-memory map back to the same pod bearer |
| `grant_type=client_credentials` | an app-only token that carries **no** pod identity — `getAgent()` resolves it to nobody, so any write is refused |
| every later `Authorization: Bearer <token>` | forwarded verbatim: `getAgent()` resolves it to the WebID; pod writes are loopback LDP PUT/DELETE under that same bearer, so **real WAC**, not this shim, decides what lands |

## Object mapping

- A Status is one ActivityStreams `Note` at
  `<pod>/public/statuses/<snowflake>.jsonld` — the **same layout
  activitypub/ serves as the AP outbox**, which is why posts made here
  federate-read for free. Replies carry `inReplyTo` (the parent Note URL);
  photos carry an AS2 `attachment` array.
- `Status.id` = **base64url of the Note's AS2 `id` URL** (opaque to
  clients, decodable both ways; malformed ids are 404, never 500).
  `Account.id` = the username. `MediaAttachment.id` = base64url of the
  media URL. The snowflake filename stays the *sort key* for timelines and
  `max_id`/`since_id` filtering.
- favourites / reblogs / follows / media alt-text live in
  `pluginDir/state.json` (atomic writes) and are reflected into
  `favourited`/`reblogged`/counts on every status entity.
- Media uploads land at `<pod>/public/media/<uuid>.<ext>` via loopback PUT
  under the caller's bearer.

## Findings

### 1. Mastodon's fixed absolute API paths don't fit the one-prefix plugin model

The headline seam, and a sharper version of nip05/'s well-known-path
finding. A Mastodon client hits **fixed absolute paths** — `/api/v1/…`,
`/api/v2/…`, `/oauth/…` — that no client will let you relocate under a
plugin `prefix`. Two things follow:

- **Routing works.** Like nip05/ registering `/.well-known/nostr.json`, the
  loader does not confine a plugin's routes to its prefix (`api.fastify` is
  the real scoped instance), and these static/param routes outrank core's
  LDP `GET /*` wildcard on Fastify's route-specificity ordering.
- **Authorization did not** — until JSS 0.0.219 shipped
  `api.reservePath(path, opts)` (#602). At activate time this plugin
  reserves the literal roots `/api` and `/oauth`; a literal reservation
  WAC-exempts the whole subtree, and a second plugin claiming the same root
  fails the boot loudly.

**Phase 2 widened `/api` to PUT + DELETE** (media description update,
status delete) — and that walks straight at core's documented trap: *an
exempted verb with no matching route falls through to LDP's write wildcards
as an unauthenticated storage write*. The mitigation is structural:
catch-all `PUT /api/*` and `DELETE /api/*` routes answer 404 (with CORS)
for every path the plugin does not implement, so nothing under `/api` can
reach LDP's `PUT /*`/`DELETE /*`. The test suite asserts exactly this
(`PUT /api/v1/no-such-surface/xyz` → the shim's JSON 404, nothing written).
`/oauth` stays POST-only.

### 2. The loopback-to-`/idp/credentials` token bridge

Same loopback pattern notifications/ and webdav/ established, put to a new
use: **authentication translation**. The shim has no user store and mints no
token of its own — `POST /oauth/token` calls the host's own programmatic
credentials endpoint (`/idp/credentials`, the CTH-compat endpoint) over
loopback and returns the pod bearer verbatim as the Mastodon `access_token`.
Because Mastodon's token and a Solid bearer are the same kind of thing (a
value resent in `Authorization`), the two OAuth worlds join with zero
impedance. Every subsequent call re-presents that bearer and is resolved by
`api.auth.getAgent(request)` — so the shim never decides identity, the
server does. PKCE rides on top for free: the challenge is stashed with the
one-time code and checked in-plugin with `node:crypto`.

### 3. base64url-of-URL ids collide with find-my-way's `maxParamLength`

New Phase-2 finding. `Status.id` is base64url of the Note URL; on a
`127.0.0.1:<port>` origin with a uuid filename that is **> 100
characters** — and find-my-way (Fastify's router) silently stops matching
a `:id` param longer than `maxParamLength` (default 100). The symptom is
nasty: the route *exists*, short ids match, long ids 404 at the router
before any handler runs. Plugins cannot raise `maxParamLength` (it is a
`createServer`-time Fastify option). **Wildcard segments are exempt from
the limit**, so every id-addressed route here is a small dispatcher on
`GET|POST /api/v1/statuses/*` and `GET|PUT /api/v1/media/*` instead of
`:id` params. Anyone building URL-derived ids on this plugin api will hit
the same wall.

### 4. Pod discovery for the local public timeline needs `config.podsRoot`

`GET /api/v1/timelines/public?local=true` wants "all local users". The LDP
root does **not** enumerate pods — `GET /` serves an HTML landing page, not
a container listing (probed) — and the plugin api exposes no user
enumeration. So the plugin takes the same optional `config.podsRoot`
filesystem hint webfinger/ and nip05/ already take (a directory is a pod if
it contains `profile/`). Without it the public timeline **degrades to the
caller's own posts** and single-user deployments lose nothing. The same
knob bounds context-thread descendant walks. (A future `api.pods()` seam
would close this for all three plugins at once.)

### 5. Notifications = a read-time projection of the AP inbox

The notifications tab is built by fetching
`GET {apRoot}/<user>/inbox?page=true` over loopback **with the caller's own
Bearer** (the activitypub/ plugin's owner-authed inbox collection) and
mapping raw AS2 activities to Mastodon Notification entities:
Follow→`follow`, Like→`favourite` (liked status resolved locally),
Announce→`reblog`, Create{Note} with a Mention tag or an `inReplyTo`
pointing at the user's statuses→`mention`. Unresolvable items are skipped,
never 500s. Remote actors are rendered **from the actor URL alone**
(`user@host` parsed out of it) — no outbound fetch. Two plugins compose
over loopback + a shared pod layout with zero direct coupling.

### 6. Honestly stubbed / Wave B

- **Stubs**: custom_emojis, filters, lists, bookmarks, conversations,
  scheduled_statuses, announcements, mutes/blocks, trends, directory,
  search, markers, follow_requests all return empty-but-well-formed shapes
  so Phanpy renders. `followers_count`/avatars on accounts are placeholders.
- **Wave B (needs outbound federation)**: delivering Like/Announce upstream
  when you favourite/boost, delivering Follow/Undo on follow/unfollow,
  resolving remote actor profiles (avatars, display names) for
  notifications, and remote statuses in timelines. The local state file is
  written so a Wave B delivery loop can replay it.
- **Streaming**: no websocket — `/api` is an HTTP reservation and a ws
  upgrade under it could fight the reservation model; Phanpy polls when
  streaming is absent. `GET /api/v1/streaming/health` answers `OK`. A real
  implementation wants the `api.events` seam plus a ws route outside /api.
- **Remaining Phanpy gaps**: `PATCH /api/v1/accounts/update_credentials`
  (profile editing) is unimplemented **and PATCH is deliberately not
  WAC-exempted** — it would 401 without CORS headers; status editing
  (`PUT /api/v1/statuses/:id`) and `GET /api/v1/statuses/:id/source`
  likewise. Editing fails visibly but nothing else breaks.

### 7. Mapping LDP containers ↔ Mastodon objects stays lossy

Unchanged from Phase 1: no account metadata without fetching profiles
(placeholders), N+1 loopback reads per timeline page (bounded by
`limit ≤ 40`; a server-side index via `api.events` is the scale answer),
and ids are the shim's convention (a Note not named `<digits>.jsonld` is
skipped). Write auth stays honest: every pod mutation is a loopback
PUT/DELETE under the caller's own bearer, so WAC — not the shim — decides.
