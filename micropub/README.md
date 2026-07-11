# micropub — an IndieWeb Micropub server over your own pod

A [Micropub](https://micropub.spec.indieweb.org/) endpoint as a #206 loader
plugin: IndieWeb clients (Quill, Indigenous, Micropublish, plain curl) POST
h-entries to one URL and the posts land as JSON resources **in the author's
own pod**, at `<pod>/public/posts/<yyyy>/<mm>/<slug>.json`. The permalink
returned in `Location:` *is* the pod resource URL, and every read/write goes
over loopback with the client's own bearer, so real WAC governs everything.

```
plugins: [{
  module: 'micropub/plugin.js',
  prefix: '/micropub',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (permalinks + q=source guard)
    loopbackUrl: 'http://127.0.0.1:3000',  // where the plugin reaches the host
  },
}]
```

No `appPaths` needed — unlike mastodon/ and bluesky/, the whole Micropub
surface is one client-discovered URL, which fits the plugin's single
WAC-exempt `prefix` exactly.

## A curl session

Micropub says clients send `Authorization: Bearer <token>`. On JSS, **a pod
bearer IS a Micropub token** — mint one from the IdP and use it directly:

```bash
# 1. a pod token (this IS your micropub token — see Findings)
TOKEN=$(curl -s localhost:3000/idp/credentials \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"…"}' | jq -r .access_token)

# 2. what does the endpoint support?
curl -s 'localhost:3000/micropub?q=config'
# → {"syndicate-to":[]}

# 3. post a note (form-encoded, like every Micropub client's simplest path)
curl -si localhost:3000/micropub -H "Authorization: Bearer $TOKEN" \
  -d h=entry -d 'content=hello indieweb' \
  -d 'category[]=indieweb' -d 'category[]=solid' | grep -i location
# → Location: http://localhost:3000/alice/public/posts/2026/07/1760…-a1b2c3d4.json

# 4. it's a plain pod resource — read it back like any other
curl -s "$LOCATION" -H "Authorization: Bearer $TOKEN"
# → {"type":["h-entry"],"properties":{"content":["hello indieweb"],…}}

# 5. or ask the endpoint for the source
curl -s "localhost:3000/micropub?q=source&url=$LOCATION" -H "Authorization: Bearer $TOKEN"

# 6. edit and delete
curl -s localhost:3000/micropub -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"update","url":"'$LOCATION'","replace":{"content":["edited"]}}'
curl -s localhost:3000/micropub -H "Authorization: Bearer $TOKEN" \
  -d action=delete -d "url=$LOCATION"
```

## What maps / what doesn't

| Micropub feature | Status | Notes |
|---|---|---|
| `POST` create, form-encoded (`h=entry`, `category[]=…`) | ✅ done | arrays preserved; `mp-slug` honored |
| `POST` create, JSON (`{"type":["h-entry"],"properties":{…}}`) | ✅ done | properties stored verbatim, values normalized to arrays |
| `201` + `Location:` permalink | ✅ done | the permalink is the pod resource URL |
| `GET ?q=config` / `?q=syndicate-to` | ✅ done | `{"syndicate-to":[]}`, no `media-endpoint` |
| `GET ?q=source&url=…` (+ `properties[]` filter) | ✅ done | only for URLs under this server — no external fetching |
| `action=delete` | ✅ done | loopback DELETE → 204 |
| `action=update` with `replace` | ✅ done | GET-merge-PUT → 204 |
| `action=update` with `add` / `delete` ops | ⛔ not implemented | replace covers the editing slice; same GET-merge-PUT shape if wanted |
| post types other than h-entry | ⛔ 400 | h-entry only |
| **media endpoint** (file upload) | ⛔ not implemented | needs multipart/streaming bodies — see Findings; `photo` as a URL value works |
| syndication, webmention sending | ⛔ by design | this plugin makes **no** external network calls |
| IndieAuth server / endpoint discovery | ⛔ out of scope | any pod bearer works (see Findings on discovery) |

Storage shape: the Micropub JSON is stored as-is —
`{"type":["h-entry"],"properties":{…}}` with `published` added when absent —
so `q=source` is a passthrough read and any other pod tool sees honest data.
Slugs come from `mp-slug`, then the post `name`, then
timestamp+random (`node:crypto`); an existing resource at the same slug gets
a random suffix rather than being overwritten (checked with a loopback HEAD).

## Findings

### 1. The token bridge, fourth witness — and the purest one

mastodon/ and bluesky/ established that an OAuth/ATProto access token and a
Solid pod bearer are the same kind of thing (a value resent in
`Authorization`), and bridged them with a `/oauth/token`-style endpoint
calling `/idp/credentials` over loopback. Micropub is the next consumer of
that insight, and the degenerate case that proves it: **no token endpoint is
needed at all**. Micropub's spec just says "Bearer token in Authorization",
so a pod bearer is presented directly, `api.auth.getAgent(request)` resolves
it, and every pod operation forwards it over loopback for real WAC to judge.
The bridge collapsed to the identity function. (Where a client insists on a
real IndieAuth flow, the mastodon/ `/oauth/*` pattern shows exactly how a
token endpoint would wrap `/idp/credentials`.)

### 2. Media endpoint blocked on the streaming-body primitive (#583)

Micropub's media endpoint takes `multipart/form-data` file uploads. JSS's
wildcard parser hands a plugin the body as a **buffered** Buffer, which is
the wrong primitive twice over: multipart parsing wants the raw stream (or a
parser hook), and a photo upload should be *piped* to the pod, not held in
memory. This is the same unconsumed-body-**stream** seam gitscratch/ and
tunnel/ sharpened (NOTES.md #4, issue #583): whatever raw-body mode ships
must hand back the un-drained stream. Until then, `photo` is supported as a
URL value only and `q=config` deliberately advertises no `media-endpoint`.
Micropub media is a new, very concrete consumer for that seam.

### 3. Endpoint discovery needs headers on routes the plugin doesn't own

Micropub clients find the endpoint by fetching the user's homepage and
looking for `<link rel="micropub" href="…">` (or a `Link:` header). The
user's homepage on JSS is a pod resource — owned by the LDP core, not this
plugin — and a plugin cannot inject a header or a link into responses for
routes it doesn't own. That's the response-header-injection seam NOTES.md #8
records with notifications/ (`Updates-Via`) as its first consumer; Micropub
discovery is the second, with the same shape (a *discovery* header on core
responses, the mildest form of a pipeline hook). Workarounds today: the pod
owner adds the `<link>` to their own homepage HTML by hand, or the operator
documents the endpoint out of band. Both work — the test suite simply talks
to `/micropub` directly — but a `rel=micropub` on the profile is what real
clients expect.

### 4. Counter-witness: the one-prefix model fits Micropub exactly

Worth recording because it sharpens the reservePath finding by contrast:
mastodon/ (2 fixed roots), bluesky/ (1), and activitypub/ (interleaved)
all fought the single-prefix model, but Micropub — whose endpoint URL is
*client-discovered*, not protocol-fixed — fits it perfectly. No `appPaths`,
no `.well-known` luck, no operator hand-widening; the protocol's own
discovery indirection (finding 3) is what buys that freedom. The seam story
is therefore about protocols with **fixed absolute paths**, not API shims
per se.

### 5. Small mercies that just worked

- **Deep PUT creates intermediate containers**: `PUT
  /alice/public/posts/2026/07/x.json` materializes `posts/2026/07/` without
  any container dance — the date-sharded layout cost nothing.
- **`config.baseUrl`/`loopbackUrl` again** (the `api.serverInfo` finding,
  Nth consumer): needed for permalinks and the q=source "is this URL ours?"
  guard, forcing the probe-port-then-boot test dance like ~10 siblings.
- **No existence-check primitive** — slug-collision avoidance is a loopback
  `HEAD` with the caller's own bearer; the loopback pattern absorbs yet
  another would-be api surface.
