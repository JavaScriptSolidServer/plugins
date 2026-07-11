# oembed — an oEmbed provider for pod resources

An [oEmbed](https://oembed.com/) endpoint as a #206 loader plugin: third-party
sites (and anything else that speaks oEmbed) can unfurl links to pod resources
into structured previews. One GET, one JSON (or XML) document describing the
resource — resolved over loopback **as the caller**, so real WAC decides what
unfurls, and anonymous consumers (the normal case) see only public resources.

```
plugins: [{
  module: 'oembed/plugin.js',
  prefix: '/oembed',
  config: {
    baseUrl: 'http://localhost:3000',      // public origin (provider_url + "is this ours?" guard)
    loopbackUrl: 'http://127.0.0.1:3000',  // where the plugin reaches the host
    providerName: 'My Pod',                // optional; default "Solid Pod"
  },
}]
```

## A curl session

```bash
# unfurl a public image — a photo response with REAL dimensions,
# parsed from the image bytes (PNG IHDR / JPEG SOF / GIF header)
curl -s 'localhost:3000/oembed?url=http://localhost:3000/alice/pics/photo.png'
# → {"version":"1.0","type":"photo",
#    "url":"http://localhost:3000/alice/pics/photo.png","width":40,"height":30,
#    "title":"photo","provider_name":"Solid Pod","provider_url":"http://localhost:3000"}

# a consumer with a size budget: declared dimensions are scaled to fit
curl -s 'localhost:3000/oembed?url=…/photo.png&maxwidth=20'
# → …"width":20,"height":15…  (url still serves the original image)

# an HTML page or a Micropub post unfurls as a link (see Findings on why not "rich")
curl -s 'localhost:3000/oembed?url=http://localhost:3000/alice/posts/note.json'
# → {"version":"1.0","type":"link","title":"Hello oEmbed",…}

# XML if you insist
curl -s 'localhost:3000/oembed?url=…/photo.png&format=xml'
# → <?xml version="1.0" …?><oembed><version>1.0</version><type>photo</type>…

# a private (or nonexistent) resource, anonymously → oEmbed 404
curl -si 'localhost:3000/oembed?url=http://localhost:3000/alice/private.txt' | head -1
# → HTTP/1.1 404 Not Found          ({"error":"not found"})

# the discovery tags a pod owner should paste into their page's <head>
curl -s 'localhost:3000/oembed/discover?url=http://localhost:3000/alice/page.html'
# → <link rel="alternate" type="application/json+oembed" href="…/oembed?url=…&amp;format=json" …>
```

## What maps / what doesn't

| oEmbed feature | Status | Notes |
|---|---|---|
| `GET ?url=…` for resources under this server | ✅ done | loopback GET forwarding the caller's `Authorization`; real WAC decides |
| external URLs | ⛔ 400 by design | micropub's local-URL guard; this endpoint **never** fetches off-server |
| `format=json` (default) | ✅ done | `application/json` |
| `format=xml` | ✅ done | hand-rolled, escaped `<oembed>` document, `text/xml` |
| any other `format` | ⛔ 501 | per the spec's allowance |
| `image/*` → `photo` | ✅ done | width/height parsed from the bytes (PNG/JPEG/GIF, first 64 KiB); unparseable image → `link`, never a spec-violating photo without dimensions |
| `maxwidth` / `maxheight` | ✅ done | declared dimensions scaled proportionally; the `url` still serves the original bytes (no image resizing without deps — see Findings) |
| `text/html` → `rich` | ⛔ **by design** | maps to `link` instead — embedding pod-authored HTML is a stored-XSS vector (see Findings) |
| Micropub h-entry `.json` → `link` | ✅ done | title from `properties.name`, else `properties.content` |
| everything else → `link` | ✅ done | title = filename |
| `video` type | ⛔ out of scope | same dimension problem as photo but needs container parsing; a video resource unfurls as `link` |
| private resources | 404 | pod 401/403/404 all collapse to oEmbed 404 — the consumer falls back to a plain link and existence isn't leaked |
| discovery (`<link rel="alternate" …+oembed>`) | ⚠️ helper only | `GET /oembed/discover?url=…` renders the tags as text for the pod owner to paste — a plugin cannot inject them into resources it doesn't own (see Findings) |

Stateless: no `pluginDir`, nothing returned from `activate`. Error bodies are
always JSON `{"error":…}` regardless of `format`, for simplicity.

## Findings

### 1. Discovery needs content/header injection on core routes (seam #8, third consumer)

oEmbed discovery is defined as a `<link rel="alternate"
type="application/json+oembed" href="…">` in the **HEAD of the resource's own
HTML** (or an equivalent `Link:` header on its response). Those responses are
served by LDP core — routes this plugin does not own and cannot decorate. This
is exactly the response-header/content-injection seam NOTES.md #8 records,
with notifications/ (`Updates-Via`) and micropub/ (`rel=micropub` on the
homepage) as its first two consumers; oEmbed discovery is the **third**, and
the sharpest yet: notifications and micropub each need one header on one
well-known page, but oEmbed wants the tag on *every* HTML resource a pod
serves — per-resource, with a per-resource `href`. Even a
`capabilities: ['hooks']` header grant would only cover the `Link:`-header
variant; the in-HTML variant is content rewriting, which is firmly core's
side of the #564 line. Workaround shipped: `GET /oembed/discover?url=…`
renders the exact tags for the pod owner to paste into their own HTML —
discovery by hand, which is honest about who owns the bytes.

### 2. No `rich` type for pod HTML — a deliberate XSS refusal

The obvious mapping for `text/html` is oEmbed's `rich` type, whose `html`
field consumers inject verbatim into their pages. But pod HTML is
**user-authored content**: echoing it through the oEmbed endpoint would turn
every pod writer into a stored-XSS author on every consuming site that trusts
the `html` field (many do — that's the field's contract). A provider that
manufactures its own sanitized embed markup could offer `rich` safely; a
plugin that would have to *sanitize arbitrary HTML on node builtins alone*
cannot, honestly. So `text/html` maps to `link` and the response never
contains an `html` field. The test suite pins this (a seeded `<script>` must
not appear anywhere in the oEmbed document).

### 3. `config.baseUrl`/`loopbackUrl` again (the `api.serverInfo` finding, Nth consumer)

Needed for `provider_url`, the discovery hrefs, and the "is this URL ours?"
guard — and forcing the same probe-port-then-boot test dance as ~10 siblings.
Nothing new to add beyond one more tally mark on NOTES.md #3; it remains the
cheapest, most broadly wanted seam.

### 4. `photo` requires width/height, and nothing in the api (or HTTP) provides them

oEmbed's photo type REQUIRES `width`/`height`, but a loopback GET only
reveals Content-Type and Content-Length. Omitting the fields would violate
the spec; inventing them would lie. The honest fix was to parse dimensions
from the image bytes themselves — PNG IHDR, JPEG SOF-marker walk, GIF logical
screen descriptor, ~40 lines on node buffers, reading at most the first
64 KiB and cancelling the rest of the stream. It works, but it's per-request
work that a write-time hook (`api.events.onResourceChange`, NOTES.md #2)
would let a plugin do **once per write** into a metadata cache instead of
once per unfurl. Same O(N)-read-time shape as rss/ and sparql/, one level
smaller. Relatedly: `maxwidth`/`maxheight` are honored by scaling the
*declared* dimensions only — actually resizing image bytes needs an image
library, which the import rule (rightly) forbids, so `url` always names the
original resource.

### 5. Private→404 is the right collapse, and loopback makes it free

The oEmbed spec offers 401 for "the URL contains a private resource", but
answering 401-vs-404 truthfully *reveals which private resources exist*.
Because resolution is a loopback GET as the caller, the plugin never learns
more than the caller could learn anyway — collapsing every pod 401/403/404
to an oEmbed 404 costs one `if` and leaks nothing. The forwarded-Authorization
path still works (an authenticated consumer can unfurl its own private
resources), it just isn't the normal oEmbed case.
