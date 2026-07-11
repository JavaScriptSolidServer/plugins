# bluesky — an AT-Protocol (Bluesky) XRPC shim over your own pod (#211)

Point an AT-Protocol client (or `@atproto/api`) at a JavaScript Solid Server,
log in with your pod credentials, post an `app.bsky.feed.post`, and read your
posts back. This is **Phase 1 of
[#211](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/211)**
— "a personal AT-Protocol client over your own pod." No relay, no federation,
no other people's feeds: your **author feed is the posts you wrote**, stored
as AT records in your own pod.

It is the same shim shape as [`mastodon/`](../mastodon/): fixed absolute API
roots, a loopback token bridge to `/idp/credentials`, records stored in the
pod under the caller's own bearer.

```
plugins: [{
  module: 'bluesky/plugin.js',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (service DID + loopback)
    loopbackUrl: 'http://127.0.0.1:3000',  // optional: where the shim reaches the host
  },
}]
```

…**and** — the load-bearing caveat — the operator must WAC-exempt the fixed
`/xrpc` root, because a plugin cannot do it itself (see [Findings](#findings)):

```
createServer({
  appPaths: ['/xrpc'],   // REQUIRED: or WAC 401s every client call
  plugins: [ … ],
})
```

## The vertical slice

AT-Protocol clients speak XRPC over HTTP at fixed `/xrpc/<nsid>` endpoints.
The minimum a client does to log in, post, and read:

```bash
# 1. server metadata (public)
curl -s localhost:3000/xrpc/com.atproto.server.describeServer

# 2. log in (identifier + password → pod bearer as accessJwt)
JWT=$(curl -s localhost:3000/xrpc/com.atproto.server.createSession \
  -H 'content-type: application/json' \
  -d '{"identifier":"alice","password":"…"}' | jq -r .accessJwt)

# 3. who am I
curl -s localhost:3000/xrpc/com.atproto.server.getSession -H "Authorization: Bearer $JWT"

# 4. post
curl -s localhost:3000/xrpc/com.atproto.repo.createRecord -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"repo":"<did>","collection":"app.bsky.feed.post","record":{"text":"hello bluesky","createdAt":"2026-07-11T00:00:00Z"}}'

# 5. read it back
curl -s "localhost:3000/xrpc/com.atproto.repo.listRecords?repo=<did>&collection=app.bsky.feed.post" \
  -H "Authorization: Bearer $JWT"
curl -s "localhost:3000/xrpc/app.bsky.feed.getAuthorFeed?actor=<did>" -H "Authorization: Bearer $JWT"
```

## XRPC endpoint coverage

| Endpoint | Status | Notes |
|---|---|---|
| `GET com.atproto.server.describeServer` | ✅ done | public metadata + service DID |
| `POST com.atproto.server.createSession` | ✅ done | `{identifier,password}` → `{accessJwt,refreshJwt,handle,did}` via `/idp/credentials` |
| `GET com.atproto.server.getSession` | ✅ done | `{did,handle}` from `getAgent()` |
| `POST com.atproto.repo.createRecord` | ✅ done | `app.bsky.feed.post` → `<pod>/public/bsky/<rkey>.json`, returns `at://…` + cid |
| `GET com.atproto.repo.listRecords` | ✅ done | your posts as `{records:[{uri,cid,value}]}` |
| `GET app.bsky.feed.getAuthorFeed` | ✅ done | your posts as `{feed:[{post:{…}}]}`, newest first |
| `OPTIONS /xrpc/*` | ✅ done | wide-open CORS preflight |
| `com.atproto.server.refreshSession` / `deleteSession` | ⛔ not yet | no refresh cycle — `refreshJwt` re-presents the pod bearer |
| `com.atproto.repo.getRecord` / `deleteRecord` / `putRecord` | ⛔ not yet | read-one / mutations beyond the create slice |
| `app.bsky.feed.getTimeline` / `getPostThread`, actor/graph, notifications | ⛔ not yet | need federation / a social graph (Phase 2+) |
| blobs / images / embeds, facets, langs | ⛔ not yet | text-only records for now |
| `com.atproto.identity.resolveHandle`, real DID docs, signed commits/MST | ⛔ not yet | synthetic DIDs, unsigned records — not a real PDS repo (Phase 4) |

Every response carries wide-open CORS (`access-control-allow-origin: *`) and
`OPTIONS /xrpc/*` is answered locally, so browser clients can talk to the
shim cross-origin.

## The createSession → pod-credentials bridge

AT-Protocol's `accessJwt` is just a bearer the client resends. A Solid pod's
access token is *also* just a bearer. So the bridge is direct — the shim
mints no token of its own, keeps no session store:

| AT-Protocol step | What the shim does |
|---|---|
| `POST createSession` `{identifier,password}` | loopback `POST /idp/credentials` with the username+password → return the pod bearer verbatim as `accessJwt` (and `refreshJwt`) |
| every later `Authorization: Bearer <accessJwt>` | forwarded verbatim: `getAgent()` resolves it to the WebID; record writes are loopback LDP PUTs under that same bearer, so **real WAC**, not this shim, decides what lands |
| `refreshJwt` | there is no refresh cycle — it re-presents the same pod bearer; `refreshSession` is not yet implemented |

## Object mapping (AT ↔ pod)

- `POST createRecord` writes the AT record
  `{ $type:'app.bsky.feed.post', text, createdAt }` to
  `<pod>/public/bsky/<rkey>.json`.
- **`rkey`** is a **TID** (timestamp id, 13-char sortable base32) minted at
  write time and used as the filename, so `listRecords`/`getAuthorFeed`
  round-trip in chronological order (newest first) purely by sorting keys.
- **`uri`** is `at://<did>/app.bsky.feed.post/<rkey>`.
- **`cid`** is a `sha256` content hash of the record, base32-encoded into a
  `bafyrei…`-shaped string. It is **not** a real dag-cbor CIDv1 — clients
  treat cids as opaque, and the shim stores no signed MST — but it is stable
  across reads of the same record, which is all a client checks.
- **`did`** derivation (`didFromWebid`): a synthetic **`did:web`** from the
  WebID's origin + first path segment —
  `http://host:port/alice/…` → `did:web:host%3Aport:alice` (the `:` in the
  authority is `%3A`-encoded per did:web). Single-user pods derive
  `did:web:host%3Aport`. The shim can decode its own did:web back to a pod
  path (`podFromDid`) for anonymous public reads. It is **not** a real,
  globally-resolvable DID (no did:plc, no `/.well-known/atproto-did`, no DID
  document) — resolution is the shim's convention, not a network fact.
- **`handle`** is the pod name (first WebID path segment, `/alice/…` →
  `alice`). Real AT handles are domain names that resolve to a DID; a bare
  pod name is close enough for a client to display but would not resolve on
  the real network (Phase 3 identity bridge territory).

## Findings

### 1. SECOND independent confirmation of the reserved-path / multi-prefix seam

**Headline.** This is the same wall [`mastodon/`](../mastodon/) hit, reached
from a completely different external protocol — which is exactly what makes it
a *confirmation* rather than a repeat. An AT-Protocol client hits **fixed
absolute paths** under one root, `/xrpc/<nsid>`, that no client will let you
relocate under a plugin `prefix`. Two things follow, identically to mastodon:

- **Routing works.** Like mastodon's `/api` + `/oauth` and nip05's
  `/.well-known/nostr.json`, the loader does not confine a plugin's routes to
  its prefix (`api.fastify` is the real scoped instance), and each
  `/xrpc/<nsid>` static route outranks core's LDP `GET /*` wildcard on
  Fastify's specificity ordering. Registration is fine.
- **Authorization does not.** `/xrpc` is an ordinary pod path as far as WAC is
  concerned. The WAC hook skips only paths in `appPaths` (`server.js`), and
  the loader pushes a plugin's **single `prefix`** there (`plugins.js` — `if
  (prefix) ctx.appPaths.push(prefix)`). This shim's surface lives at a **fixed
  protocol root that is not its prefix**, and a plugin has no
  `api.appPaths.add()` / `api.reservePath()` to push it. So the plugin
  **cannot self-exempt its own surface**, and every unexempted `/xrpc` call is
  401'd by WAC before the handler runs.

The honest consequence, verbatim from mastodon: this shim is only usable if
the **operator** widens `appPaths` by hand (`appPaths: ['/xrpc']`). Note the
sharpening over mastodon: mastodon needed *two* roots and blamed the
"one-prefix" model; bluesky needs only *one* root and **still can't reach it**,
because the exempt path is tied to the plugin's *own* prefix, not to the paths
it actually serves. The seam is not "a plugin should get more than one
prefix" — it is "**a plugin must be able to declare the paths it owns**,
independently of its mount prefix" (`paths: ['/xrpc']` on the entry, or an
`api.reservePath()` surface, with collision detection). This is the seam **all
API-shim plugins** (mastodon, bluesky, and any future ActivityPub / gateway)
structurally require; it now has **two independent consumers** and belongs
above mastodon-alone in NOTES.md's ranking of the reserved-path seam.

### 2. The loopback → `/idp/credentials` token bridge generalizes cleanly

The mastodon finding held with zero changes: two OAuth-shaped worlds (AT's
`accessJwt`, Solid's bearer) are both "a value resent in `Authorization`," so
`createSession` is a thin translation over the host's own programmatic
credentials endpoint and the shim never decides identity — `getAgent` does.
That the *same* bridge served a *different* protocol's login is evidence the
pattern is protocol-agnostic, not a mastodon accident.

### 3. LDP ↔ AT-record mapping is awkward, and DID derivation is the sharpest gap

- **No native repo, no signatures, synthetic identity.** A real AT PDS holds a
  signed Merkle Search Tree (an authenticated repo) and a globally-resolvable
  DID with a DID document. A pod holds LDP resources under WAC. The shim
  bridges the *data* (records in, feeds out) but not the *cryptography*: `cid`
  is a plain content hash, not a dag-cbor CIDv1 over a signed commit, and
  `did` is a synthetic `did:web` the shim invents and resolves by convention.
  Good enough that a client round-trips its own posts; **not** something the
  real Bluesky network would federate or verify. Faithful federation (Phase 4)
  needs real repo/commit machinery that has no LDP analogue — the deepest gap
  #211 will hit.
- **IDs are synthesized, not native.** AT sorts by TID rkey; LDP names
  resources by URL. The shim mints a sortable TID at write time and uses it as
  the filename, so ordering round-trips — but a record written to
  `public/bsky/` by any other tool (not matching `<rkey>.json`) is simply
  skipped by the feed. Same shape as mastodon's snowflake-id finding.
- **N+1 reads for a feed.** LDP lists a container's members but not their
  bodies, so a feed is one `GET` for the container plus one per record — the
  same `api.events` write-index seam `sparql/` documents.
- **Write auth is honest, though.** Because the record write is a loopback LDP
  `PUT` carrying the caller's own bearer, real WAC governs it: a client can
  only post to a pod it actually controls, and a 401/403 from WAC surfaces as
  an XRPC `Forbidden` — the shim adds no authority of its own.

## Tests

`node --test --test-concurrency=1 bluesky/test.js` — **11 tests, all green**.
Drives the full slice end-to-end: `describeServer` (public 200) → bad-baseUrl
boot rejection → `createSession` (pod creds → accessJwt, bad password → 401) →
`getSession` (did/handle; anon → 401) → `createRecord` "hello bluesky" (at://
uri, and the JSON record verified in the pod) → anon write refused →
`listRecords` / `getAuthorFeed` contain the post → second post sorts first.
