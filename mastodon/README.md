# mastodon — a Mastodon-API shim over your own pod (#515 / #516)

Point a real Mastodon client at a JavaScript Solid Server and log in with
your pod credentials, post, and read your posts back. This is **Phase 1 of
[#515](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/515)**
— "a personal client over your own pod." No federation, no other people's
timelines: your **home timeline is the posts you wrote**, stored as
ActivityStreams `Note` resources in your own pod.

```
plugins: [{
  module: 'mastodon/plugin.js',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (status URIs + loopback)
    loopbackUrl: 'http://127.0.0.1:3000',  // optional: where the shim reaches the host
    title: 'My JSS',                        // optional: instance title
  },
}]
```

No `appPaths` needed: since JSS 0.0.219 the plugin claims and WAC-exempts
its two fixed roots itself at activate time via `api.reservePath('/api')` /
`api.reservePath('/oauth')` (#602) — see [Findings](#findings) for the gap
this closed.

## Pointing a client at it

Mastodon clients ask for a **server URL** and then run OAuth. Give the client
your JSS origin (`http://localhost:3000`). It will:

1. `POST /api/v1/apps` to register itself,
2. run the OAuth flow, and
3. resend the resulting bearer on every call.

Web clients like **[Phanpy](https://phanpy.social)** / **Elk** and the
password-grant path both work. For the password grant the client (or you,
by hand) posts your pod username + password to `/oauth/token`; that bridges
to the pod's own IdP and the bearer you get back **is** your pod token.

```bash
# 1. register an app
curl -s localhost:3000/api/v1/apps -d client_name=cli -d redirect_uris=urn:ietf:wg:oauth:2.0:oob

# 2. log in (password grant → pod bearer)
TOKEN=$(curl -s localhost:3000/oauth/token \
  -d grant_type=password -d username=alice -d password='…' | jq -r .access_token)

# 3. who am I
curl -s localhost:3000/api/v1/accounts/verify_credentials -H "Authorization: Bearer $TOKEN"

# 4. post
curl -s localhost:3000/api/v1/statuses -H "Authorization: Bearer $TOKEN" -d status='hello fediverse'

# 5. read it back
curl -s localhost:3000/api/v1/timelines/home -H "Authorization: Bearer $TOKEN"
```

## Endpoint coverage

| Endpoint | Status | Notes |
|---|---|---|
| `GET /api/v1/instance` | ✅ done | public metadata (v1 shape) |
| `GET /api/v2/instance` | ✅ done | public metadata (v2 shape) |
| `POST /api/v1/apps` | ✅ done | persists to `pluginDir/apps.json` |
| `GET/POST /oauth/authorize` | ✅ done | login page + headless shortcut; issues a one-time code |
| `POST /oauth/token` | ✅ done | `password`, `authorization_code`; `client_credentials` = app-only |
| `GET /api/v1/accounts/verify_credentials` | ✅ done | account from `getAgent()` |
| `POST /api/v1/statuses` | ✅ done | stores a Note in `<pod>/public/statuses/<id>.jsonld` |
| `GET /api/v1/statuses/:id` | ✅ done | reads one Note back |
| `GET /api/v1/timelines/home` | ✅ done | your own posts, newest first |
| media upload, polls, cards | ⛔ not yet | `configuration.statuses.max_media_attachments = 0` |
| `GET /api/v1/timelines/public`, notifications, follows, search | ⛔ not yet | need federation / a social graph (Phase 2+) |
| status delete / edit / favourite / reblog | ⛔ not yet | write-mutations beyond the create slice |

Every response carries wide-open CORS (`access-control-allow-origin: *`) and
`OPTIONS /api/*` + `/oauth/*` are answered locally, so browser clients
(Phanpy) can talk to the shim cross-origin.

## The OAuth → pod-credentials mapping

Mastodon's `access_token` is just a bearer the client resends. A Solid pod's
access token is *also* just a bearer. So the bridge is direct — no token of
our own, no session store:

| Mastodon step | What the shim does |
|---|---|
| `POST /oauth/token` `grant_type=password` | loopback `POST /idp/credentials` with the username+password → return the pod bearer as `access_token` |
| `GET/POST /oauth/authorize` | mint a pod bearer the same way, stash it under a one-time `code`, redirect `?code=…` |
| `POST /oauth/token` `grant_type=authorization_code` | look the `code` up, return the stashed pod bearer (one-time) |
| `grant_type=client_credentials` | an app-only token that carries **no** pod identity — `getAgent()` resolves it to nobody, so any write is refused |
| every later `Authorization: Bearer <token>` | forwarded verbatim: `getAgent()` resolves it to the WebID; status writes are loopback LDP PUTs under that same bearer, so **real WAC**, not this shim, decides what lands |

A Status maps onto one pod resource:

- `POST /api/v1/statuses` writes an ActivityStreams `Note`
  (`{@context, id, type:'Note', attributedTo:<webid>, content, published, to:[as:Public]}`)
  to `<pod>/public/statuses/<id>.jsonld`.
- The Mastodon `Status.id` is a sortable numeric snowflake and also the
  filename; `created_at` is the Note's `published`.
- The Mastodon `Account.id` is a short SHA-256 hash of the WebID; `username`
  / `acct` are the first pod path segment (`/alice/…` → `alice`).
- The home timeline `GET`s the `public/statuses/` container, reads each
  `ldp:contains` child, and maps the Notes newest-first.

## Findings

### 1. Mastodon's fixed absolute API paths don't fit the one-prefix plugin model

The headline seam, and a sharper version of nip05/'s well-known-path
finding. A Mastodon client hits **fixed absolute paths** — `/api/v1/…`,
`/api/v2/…`, `/oauth/…` — that no client will let you relocate under a
plugin `prefix`. Two things follow:

- **Routing works.** Like nip05/ registering `/.well-known/nostr.json`, the
  loader does not confine a plugin's routes to its prefix (`api.fastify` is
  the real scoped instance), and these static/param routes outrank core's
  LDP `GET /*` wildcard on Fastify's specificity ordering. Registration is
  fine.
- **Authorization does not.** Unlike `/.well-known/*`, which core's auth
  layer blanket-exempts, `/api` and `/oauth` are ordinary pod paths. The WAC
  hook skips only paths in `appPaths` (`server.js`), and the loader pushes a
  plugin's **single `prefix`** there (`plugins.js` — `if (prefix)
  ctx.appPaths.push(prefix)`). Mastodon needs **two** fixed roots, and a
  plugin has no way to push more than its one prefix — there is no
  `api.appPaths.add(...)`. So the plugin **cannot self-exempt its own
  surface**, and every unexempted client call is 401'd by WAC before the
  handler runs.

The honest consequence *was*: this shim was only usable if the **operator**
widened `appPaths` by hand (`appPaths: ['/api', '/oauth']`). That was the
finding — the one-prefix model can't express an app whose routes are
dictated by an external protocol at more than one absolute root. A plugin
api that let a plugin declare *several* exempt path roots (an
`api.reservePath()` surface) would close it; this is the same shape as
nip05's reserved-path finding, but where nip05 got lucky (core already
exempts `/.well-known/*`), Mastodon did not, so the gap was visible instead
of accidental.

**Closed — JSS 0.0.219 shipped `api.reservePath(path, opts)` (#602) and
this plugin consumes it.** At activate time it reserves the literal roots
`/api` and `/oauth`; a literal reservation WAC-exempts the whole subtree,
and a second plugin claiming the same root fails the boot loudly instead of
silently losing. Reservations are **read-only by default** (GET/HEAD/
OPTIONS), so both roots are widened with
`{ methods: ['GET', 'HEAD', 'OPTIONS', 'POST'] }` — POST is the only write
verb the shim implements (`POST /api/v1/apps`, `POST /api/v1/statuses`,
`POST /oauth/authorize`, `POST /oauth/token`). PUT/DELETE/PATCH are
deliberately **not** exempted: no route implements them, and an exemption
on an unimplemented verb would fall through to core's LDP write wildcards
as an unauthenticated storage write. Registering the routes is still the
plugin's job; the reservation only settles claim + WAC. The operator config
shrinks to just `plugins:` — the test suite passing without any `appPaths`
is the proof.

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
server does.

### 3. Mapping LDP containers ↔ Mastodon objects is lossy in both directions

- **No account metadata.** A Mastodon `Account` wants `created_at`,
  `followers_count`, a display name, an avatar. A WebID gives us a username
  and a URL and nothing else without fetching and parsing the profile
  document, so those fields are stubbed (`created_at` is a fixed placeholder,
  counts are `0`). Good enough that clients render; not a real profile.
- **N+1 reads for a timeline.** LDP lists a container's members but not their
  bodies, so building a timeline is one `GET` for the container plus one per
  status. Fine at Phase-1 volumes; a real deployment would want a server-side
  index (the same `api.events` write-index seam sparql/ documents).
- **IDs are synthesized, not native.** Mastodon sorts timelines by a numeric
  snowflake id; LDP resources are named by URL. The shim generates a sortable
  numeric id at post time and uses it as the filename, so ordering round-trips
  — but it's the shim's convention, not a property of the pod. A Note written
  by any other tool (not matching `<digits>.jsonld`) is simply skipped by the
  timeline.
- **Write auth is honest, though.** Because the status write is a loopback
  LDP `PUT` carrying the caller's own bearer, real WAC governs it: a client
  can only post to a pod it actually controls, and a 401/403 from WAC surfaces
  as a Mastodon "not allowed" — the shim adds no authority of its own.
