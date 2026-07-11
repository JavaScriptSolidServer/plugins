# webdav — mount a pod as a network drive

WebDAV → LDP bridge for [#507](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/507)
as a #206 loader plugin. WebDAV clients (Finder, Nautilus/gvfs, Windows
Explorer, cadaver, rclone, davfs2…) talk to `/webdav/<path>` and every
operation is replayed as a Solid/LDP request against the host itself over
loopback HTTP, carrying the client's own credentials. The bridge holds no
authority: the host's real auth + WAC decide every call, so the bridge
*cannot* disagree with the server's policy (the loopback pattern from
`notifications/`, promoted from one HEAD check to the whole data plane).

```js
plugins: [{ module: 'webdav/plugin.js', prefix: '/webdav',
            config: {
              baseUrl: 'https://pod.example',        // REQUIRED (finding 1)
              loopbackUrl: 'http://127.0.0.1:3000',  // optional (defaults to baseUrl)
            } }]
```

## Mounting

Get a pod Bearer token first (pod creation returns one: `POST /.pods` →
`{ token }`). Then, because OS mount dialogs only speak HTTP Basic, the
bridge maps **Basic → Bearer: any username, the token as the password.**

- **Nautilus / GNOME**: `gio mount dav://pod.example/webdav/alice/` (or
  `davs://` over TLS) — enter any username, paste the token as password.
  Or Files → Other Locations → Connect to Server.
- **Finder (macOS)**: Go → Connect to Server → `https://pod.example/webdav/alice/`
  — any name, token as password.
- **Windows Explorer**: Map network drive → `https://pod.example/webdav/alice/`.
  Note: Windows' redirector wants class 2 (LOCK) for read-write; without it
  Windows may mount read-only. Locks are not implemented (below).
- **cadaver / rclone / davfs2**: same deal; e.g.
  `rclone lsd :webdav:,url=https://pod.example/webdav/,user=x,pass=$TOKEN:`

A raw `Authorization: Bearer <token>` header is forwarded verbatim for
clients that can send one.

## What maps

| WebDAV | LDP over loopback | status mapping |
|---|---|---|
| `OPTIONS` | answered locally | 200, `DAV: 1`, `Allow`, `MS-Author-Via: DAV` |
| `PROPFIND` Depth 0/1 | `GET` with `Accept: application/ld+json`; `ldp:contains` → multistatus | 207; host 401/403/404 pass through |
| `GET`/`HEAD` | `GET`/`HEAD`, body streamed, `Range`/conditional headers forwarded | pass through |
| `PUT` | `PUT` (body + `Content-Type` forwarded) | 201 created / 204 overwrote, pass through |
| `DELETE` | `DELETE` | 204 |
| `MKCOL` | `PUT` to the trailing-slash URL (how JSS creates a BasicContainer) | 201; host 409 "exists" → 405 |

Properties served (hand-rolled XML, no dependencies): `displayname`,
`resourcetype` (`<D:collection/>` vs empty), `getcontentlength`,
`getcontenttype`, `getlastmodified` (RFC 1123, from the container listing's
`dcterms:modified`). PROPFIND request bodies are ignored — every response
carries this fixed live-prop set (allprop behaviour; clients pick what they
asked for). `Depth: infinity` is served as depth 1, which RFC 4918 lets a
server refuse anyway.

## What doesn't map

- **LOCK / UNLOCK** — no LDP counterpart; `501`, and `DAV: 1` (class 1)
  honestly doesn't advertise them. Finder/gvfs cope; Windows may go
  read-only without class 2.
- **COPY / MOVE / PROPPATCH** — `501`. Copy/rename means GET+PUT(+DELETE),
  recursive for containers — a sensible follow-up, not "minimum usable".
- **Dead properties** — nowhere to put them (could go in `.meta` later).
- **ACLs, notifications, JSON-LD types** — deliberately invisible; that's
  the FUSE companion issue (#508).
- **Containers with `index.html`** — JSS serves the HTML instead of the
  JSON-LD listing (conneg off), so such a collection lists as empty over
  WebDAV.
- **Subdomain-mode pods** — loopback requests carry the loopback `Host`, so
  only path-mode pods resolve; subdomain mode would need a forwarded Host
  header the bridge doesn't send yet.

## Findings

1. **The loopback bridge generalizes from control to data plane.**
   `notifications/` used one loopback HEAD to ask "may this agent read X?".
   Here *every* byte crosses loopback with the client's own Authorization,
   and WAC held on every test (401 without token, full CRUD with it). The
   cost is an extra local HTTP hop per operation and the same two config
   seams as notifications: **`config.baseUrl` is required** because a plugin
   still can't learn its host's origin (`api.serverInfo` would erase this),
   and `loopbackUrl` exists because the public origin isn't always
   dialable from the host itself.
2. **LDP ↔ WebDAV is a close fit — JSS's container JSON-LD made PROPFIND
   almost free.** `ldp:contains` entries already carry `stat:size` and
   `dcterms:modified`, exactly the live props a directory listing needs, so
   Depth 1 is a single loopback GET. Two awkward spots: (a) JSS sends **no
   `Last-Modified` header on resources**, so a Depth 0 PROPFIND on a file
   needs a second loopback GET of the *parent* listing to fill
   `getlastmodified` (best-effort — omitted if the parent isn't readable);
   (b) collection identity is spelled differently — WebDAV clients PROPFIND
   `/a/b` while LDP containers are `/a/b/`, so the bridge sniffs the host's
   `Link: …ldp#Container; rel="type"` header on a HEAD and re-targets with
   the trailing slash.
3. **MKCOL is a one-liner against JSS but not portable.** JSS creates a
   BasicContainer for a PUT on any `/`-terminated path (tested; 409 when it
   exists, which is exactly WebDAV's 405 case). A pod-agnostic bridge (the
   issue's standalone-command shape) should POST to the parent with
   `Link: <…#BasicContainer>; rel="type"` + `Slug` instead — that's also
   what JSS's own POST handler accepts.
4. **Auth forwarding is the whole security story, and Basic→Bearer was the
   only bridging needed.** OS mount dialogs can't send Bearer, so
   `Basic any:token` becomes `Bearer token` (tested). The 401 path returns a
   `WWW-Authenticate: Basic` challenge, without which no file manager ever
   shows a password prompt. Full Solid-OIDC/DPoP for foreign pods remains
   follow-up work (needs the token-refresh lifecycle the issue mentions).
5. **Fastify 4 already routes WebDAV verbs** (`PROPFIND`, `MKCOL`, `LOCK`…
   are in its `supportedMethods`), so `api.fastify.route()` needed no new
   seam — but bodies for those verbs go through the host's catch-all
   `'*'` content-type parser, which the plugin scope happens to inherit
   from `createServer`. A plugin api guarantee about body parsing (or a raw
   body seam) would make this less incidental.
6. **Test-harness footgun, documented for the next port:** JSS keeps a
   module-level storage root, so booting a *second* `createServer` in the
   same process (even one that fails config validation) re-points storage
   for the server that's already listening — every WAC check then 403s.
   Validation-failure tests must run before the real boot
   (notifications/test.js already ordered them that way; now it's written
   down).
