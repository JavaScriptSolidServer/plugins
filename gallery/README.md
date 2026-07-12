# gallery — a pod photo/media gallery (the first `api.mountApp` consumer)

A demo-facing media gallery as a #206 loader plugin, and the first consumer
of **`api.mountApp` (#583, JSS ≥ 0.0.219)**: the whole plugin is ONE raw
node `(req, res)` handler mounted under its prefix — no Fastify routes at
all. Uploads are **streamed**, not buffered: the un-drained request stream
(the thing #583 exists to provide) is piped straight into a loopback `PUT`
carrying the caller's own `Authorization`, so real WAC decides whether the
bytes land and the plugin holds O(1) memory per upload regardless of file
size.

```
plugins: [{ module: 'gallery/plugin.js', prefix: '/gallery' }]
```

That is the **entire** required configuration — the first plugin in this
repo with none: the server origin comes from `api.serverInfo()` (#601) and
the target container defaults to the authenticated caller's own
`<pod>/public/gallery/` (public-read, owner-write under the seeded ACLs —
exactly what a shareable gallery wants). Optional config:

| key | default | what |
|---|---|---|
| `container` | caller's `<pod>/public/gallery/` | fixed pod container (absolute, trailing `/`) |
| `maxItems` | `200` | most-recent cap on the grid (read-time walk, no index — no `api.events`) |
| `baseUrl` | `api.serverInfo().baseUrl` | public origin override for links |
| `loopbackUrl` | live bind from `api.serverInfo()` | where the plugin reaches the host |

Surface:

```
GET  /gallery[?container=/alice/public/gallery/]   self-contained HTML grid
                                                   (inline CSS/JS, dark-mode,
                                                   built-in uploader)
POST /gallery/upload/<filename>[?container=…]      stream the raw body into
PUT  /gallery/upload/<filename>[?container=…]      the pod; 201 + Location
```

Container precedence: `?container=` → `config.container` → the
authenticated caller's own gallery. Playback and download links point
**straight at the pod resources** — core's LDP serves Range natively, so
`<video>` seeking works with no plugin lane in the middle (Finding 3).

## A curl session

```bash
# 1. a pod bearer (WAC will judge every write as this agent)
TOKEN=$(curl -s localhost:3000/idp/credentials \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"…"}' | jq -r .access_token)

# 2. upload a photo — raw body, streamed end-to-end, no multipart
curl -si localhost:3000/gallery/upload/sunset.jpg \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: image/jpeg' \
  --data-binary @sunset.jpg | grep -i location
# → Location: http://localhost:3000/alice/public/gallery/sunset.jpg

# 3. the gallery — a public page anyone can open (or curl)
open 'http://localhost:3000/gallery?container=/alice/public/gallery/'
curl -s 'localhost:3000/gallery?container=/alice/public/gallery/' | grep sunset

# 4. the photo is a plain pod resource; core serves byte ranges itself
curl -si localhost:3000/alice/public/gallery/sunset.jpg \
  -H 'Range: bytes=0-1023' | head -4
# → HTTP/1.1 206 Partial Content
# → Content-Range: bytes 0-1023/482113

# 5. a private gallery is just a different container — WAC does the rest
curl -s localhost:3000/gallery/upload/secret.png?container=/alice/private/gallery/ \
  -H "Authorization: Bearer $TOKEN" --data-binary @secret.png
curl -s -o /dev/null -w '%{http_code}\n' \
  'localhost:3000/gallery?container=/alice/private/gallery/'   # → 401
```

The page's built-in uploader drives the same lane: pick files, paste a
bearer for protected containers, and each file goes up as one streamed POST.

## What maps / what doesn't

| feature | status | notes |
|---|---|---|
| streaming raw-body upload (image/audio/video/anything) | ✅ | piped, O(1) plugin memory; WAC decides via forwarded auth |
| gallery grid with inline `<img>`/`<video>`/`<audio>` | ✅ | server-rendered, curl-testable; sizes from the listing's `stat:size` |
| byte-range playback / seeking | ✅ via core | LDP GET answers 206 natively — links go straight to the pod |
| per-caller default container | ✅ | `<pod>/public/gallery/` derived from the WebID (Bearer) |
| multipart upload | ⛔ deliberate | one file = one PUT keeps the stream; see Finding 4 |
| >`bodyLimit` uploads (20 MiB default) | ⛔ core | the mounted lane streams fine; core's LDP buffers the PUT — Finding 2 |
| thumbnails / transcoding | ⛔ out of scope | would need image deps; the browser scales |
| write-time index / cached grid | ⛔ no `api.events` | read-time container walk per request, O(N) |

## Findings

### 1. `api.mountApp` delivers exactly what #583 promised — first-consumer verdict

The seam bundles four chores (the appPaths WAC exemption, a scoped
pass-through content parser, `reply.hijack()`, registration on the prefix
and its subtree) and **all four held**. The load-bearing one is real: the
handler receives the request stream **un-drained**, and a 6 MB body piped
through `Readable.toWeb(req)` into a loopback `PUT` round-trips
byte-identical with no plugin-side buffering. Combined with
`api.serverInfo()` (#601) this is the repo's first plugin with **zero
required config** — no `baseUrl`, no `loopbackUrl`, no container. The
handler bugs are contained as documented (a thrown handler → logged 500,
not a hung client).

### 2. Streaming ends at core's front door — the seam's other half is still open

The mounted lane is now truly streaming — in fact **uncapped**: the
pass-through parser sidesteps the host's body buffering *and therefore its
`bodyLimit`* (a 21 MiB body crosses the lane untouched; test-proven by the
passthrough 413 body). But the loopback `PUT` then hits core's wildcard
`parseAs: 'buffer'` parser, which buffers the whole body in memory and
caps it at `bodyLimit` (20 MiB default). So today the pipeline is
stream → stream → **buffer** → disk. Two consequences, both seams:

- **A streaming LDP write path** is the missing other half of #583: until
  core can stream a raw `PUT` body to storage, every media plugin pays one
  full-body buffering inside core and inherits its limit. (Raise
  `bodyLimit` for bigger media meanwhile.)
- **Flip-side warning for mountApp consumers**: a mounted app that does
  *not* forward to core has NO body limit at all unless it imposes its
  own. The seam hands you the firehose; core is no longer between you and
  it.

### 3. Core LDP GET honors Range natively — playback needs no plugin lane

Probed in the test suite: `GET` on a stored media resource with
`Range: bytes=1048576-1049599` answers **206** with the correct
`Content-Range` and the exact byte slice, and plain GETs advertise
`Accept-Ranges: bytes`. Single ranges only (multi-range falls back to a
full 200 — fine for browsers) and non-RDF resources only. So the gallery
links media **directly at the pod URLs** and `<video>`/`<audio>` seeking
works with zero plugin involvement — no Range reimplementation, contrary
to what this plugin's spec braced for. Plugins only need their own Range
lane if they serve bytes core doesn't store.

### 4. Raw-body upload over multipart, deliberately — micropub's finding stays open

One file = one `PUT` preserves the stream end-to-end with zero parsing and
matches how pods store things anyway (a resource per file). Multipart
would add boundary scanning on the raw stream for no gain *here*. But the
IndieWeb media endpoint (micropub Finding 2) genuinely requires
`multipart/form-data`, and that finding **remains open there** — with a
sharpened shape: #583 now provides the raw stream multipart parsing needs,
so the remaining gap is only a parser (a vendored boundary scanner or a
blessed dep), no longer a missing seam.

### 5. A bare `(req, res)` is the price of the stream

mountApp hands you nothing but node primitives: routing, query parsing,
HEAD handling, error pages, content-length — all hand-rolled here (~40
lines of helpers). That's the right trade for a self-contained app and
precisely why mountApp shouldn't become the default lane; `api.fastify`
remains the ergonomic path for everything that doesn't need the raw
stream. One subtlety: the two lanes can't share a prefix (Fastify would
see duplicate routes), so a plugin is either mounted or route-based under
its prefix, not both — this one went all-in on mounted.

### 6. `getAgent` has an impedance mismatch in the raw lane

`api.auth.getAgent(request)` wants a Fastify request; a raw `req` lacks
`protocol`/`hostname`. Bearer verification (headers-only) works through a
small shim, which is how the per-caller default container is derived —
but DPoP / NIP-98 signatures are verified *over* those fields and can't
succeed from the raw lane. Mild seam: `getAgent` accepting a raw
`IncomingMessage` (deriving protocol/host from the socket + Host header)
would make mounted apps first-class auth citizens.

### 7. The dot-guard outranks appPaths — even inside a mounted prefix

`POST /gallery/upload/.htaccess` never reaches the handler: core 403s any
dotted path segment before the mounted app runs, WAC-exempt prefix or not.
Free traversal protection for every mounted app (this plugin's own
filename guard is a second layer), but also a hard rule: **a mounted app
can never serve a dotted path**, which is the WS-upgrade footgun from
AGENT.md generalized to all methods.

### 8. Content-Type is extension-derived on GET — the upload header is cosmetic

Core stores the raw bytes and re-derives `Content-Type` from the filename
extension when serving. Uploading `photo.png` as `application/octet-stream`
still serves back as `image/png`. No sniffing needed anywhere — but the
extension is **load-bearing**, which is why the upload lane requires a
real filename and the gallery classifies media by extension too.

### 9. Small mercies

- **Deep PUT creates the gallery**: the first upload materializes
  `/alice/public/gallery/` with no container dance (same mercy micropub
  recorded); the page renders a friendly "first upload creates it" for a
  404 container.
- **The container listing is enough for a grid**: `ldp:contains` carries
  `stat:size` and `dcterms:modified`, so the page needs ONE loopback GET —
  no per-member requests (contrast rss/, which must GET every member for
  its content).
