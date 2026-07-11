# rss — a pod container as an RSS/Atom feed

Turn any LDP container into a subscribable syndication feed. A new feature
built straight onto the [#206 plugin loader](https://jss.live/docs/features/plugins),
not a port — but it reuses the loopback container-walk that `notifications/`,
`sparql/` and `webdav/` established.

```js
plugins: [{
  module: 'rss/plugin.js',
  prefix: '/feed',
  config: {
    baseUrl: 'http://localhost:3000',   // the server's public origin (required)
    // loopbackUrl: 'http://127.0.0.1:3000', // where the plugin reaches the host
    defaultContainer: '/alice/blog/',   // used when ?container= is omitted
    title: "Alice's blog",              // feed title
    maxItems: 50,                       // cap on entries (default 50)
  },
}]
```

## Endpoints

| Route | Returns |
|---|---|
| `GET /feed/atom?container=/path/` | Atom 1.0 (`application/atom+xml`) |
| `GET /feed/rss?container=/path/`  | RSS 2.0 (`application/rss+xml`) |
| `GET /feed?container=/path/`      | content-negotiated on `Accept` (Atom default) |

`?container=` takes an absolute path (`/alice/blog/`) or a full URL on this
server; omit it to fall back to `config.defaultContainer`. Both the same
data, one as `<feed><entry>…`, the other as `<rss><channel><item>…`.

## Subscribe

Point any feed reader at the feed URL:

```
http://localhost:3000/feed/atom?container=/alice/blog/
```

For a **public** container that is the whole story — no credentials, the
common feed-reader case. For a **private** feed the reader must authenticate:
the plugin forwards the caller's `Authorization` header to the pod over
loopback, so whatever the reader sends is what WAC sees. Most feed readers
speak **HTTP Basic**, not Bearer; this plugin does not yet bridge Basic→Bearer
(the `webdav/` plugin does — `Basic <anything>:<pod-token>` → `Bearer
<pod-token>`), so today private feeds work with a reader that can send a raw
`Authorization: Bearer <token>` header, or behind the `webdav/`-style bridge.
Adding the same Basic→Bearer bridge here is a small, obvious extension.

## Property mapping

Each member resource maps to one entry. Properties are matched by the **local
name** of each JSON-LD key (everything after the last `#`, `/` or `:`), so any
vocabulary works with no configuration — `schema:name`, `dcterms:title`, a
bare `title`, or `https://schema.org/name` all match `title`. `@graph` and
top-level arrays are searched; `{"@value":…}` / `{"@id":…}` objects are
unwrapped.

| Entry field | Source (first local-name that matches, in order) |
|---|---|
| **title** | `title`, `name`, `headline`, `label` — else the filename (extension stripped) |
| **id / link** | the resource URL (always) |
| **updated / pubDate** | `published`/`datePublished`, `modified`/`updated`/`dateModified`, `created`/`dateCreated`, `issued`, `date` — else the container listing's `dcterms:modified`, else now |
| **content / description** | `content`, `articleBody`, `text`, `description`, `body`, `summary`, `abstract` — escaped |

A **plain text / HTML** member (no JSON to parse) uses its filename as the
title and its body as the content. Sub-containers, `.acl` and `.meta` are
skipped. Entries are sorted newest-first by the resolved date; the feed's own
`<updated>` is the newest entry's date (or now for an empty feed).

## Findings

- **The loopback container-walk is the shared spine.** GET the container as
  `application/ld+json`, read `ldp:contains` (the compact `contains` key JSS
  emits), resolve each child `@id` against the container URL, GET the members.
  Identical in shape to `sparql/`'s dataset crawl and `webdav/`'s `PROPFIND`
  listing — three plugins, one pattern, because the plugin api gives no
  in-process handle on pod storage.

- **Forwarded auth = WAC-respecting feeds, for free.** Every loopback GET
  carries the caller's own `Authorization`. The plugin has no authority of its
  own: a private container returns 401/403 to the walk, so the feed is refused
  (or empty) exactly when the caller couldn't read it anyway. Public
  containers need no credentials. WAC by construction, never by re-derivation
  — the same property `notifications/` and `sparql/` rely on.

- **O(N) member fetches per request — the api.events gap, again.** Building a
  feed means one GET for the container plus one GET per member, on every
  request, with no caching. There is no write-hook in the plugin api (no
  `api.events.onResourceChange`), so a plugin cannot maintain a cached feed
  that invalidates on writes — the same wall `sparql/` hits for its write-time
  index. With that seam, this plugin would keep a per-container feed document
  and rebuild only the changed entry; until then every subscriber poll is a
  full bounded crawl. The listing's inline `dcterms:modified` lets us
  pre-sort and cap to `maxItems` *before* fetching, which bounds the cost, but
  correct global newest-first still wants every candidate member fetched.

- **config.baseUrl / api.serverInfo repetition.** Like `notifications/`,
  `sparql/` and `webdav/`, the plugin must be *told* its own public origin
  (`config.baseUrl`) because the api exposes no `serverInfo` — it needs the
  origin both to reach the host over loopback and to emit absolute entry
  IDs/links. The fourth plugin to hand-roll this; the `api.serverInfo` seam is
  well past earning its place in NOTES.md.

- **Basic→Bearer belongs in a shared helper.** `webdav/` and (eventually)
  this plugin both want to bridge a feed reader's / OS client's HTTP Basic
  credential to a pod Bearer token. That bridge is copy-pasteable today; a
  shared auth helper on the api surface would remove the duplication.
