# search/ — full-text search over a pod

A new feature built straight onto the #206 loader plugin api: full-text
search over the resources under a pod container.

```
GET /search?q=<terms>&container=/path/
  → { "query": "...", "hits": [ { "url", "title", "snippet", "score } ] }
```

The container subtree is walked over **loopback HTTP** carrying the caller's
own `Authorization` header (the pattern notifications/, sparql/, rss/ and
webdav/ established), each member's text is extracted, tokenised, and ranked
by TF-IDF over the query terms. No npm dependencies: the tokeniser, the
text extractor, and the ranker are hand-rolled on node builtins.

## Usage

```js
plugins: [{
  module: 'search/plugin.js',
  prefix: '/search',
  config: {
    baseUrl: 'http://localhost:3000',   // required: the server's public origin
    // loopbackUrl: 'http://127.0.0.1:3000', // where the plugin reaches its host
    // defaultContainer: '/alice/',      // scope when the request names none
    // maxHits: 20,                      // result cap
    // maxResources: 200,                // loopback fetches per crawl
    // maxDepth: 3,                      // container recursion below the scope
    // snippetRadius: 80,                // chars either side of the first match
    // index: false,                     // cached-index mode (see Findings)
    // podsRoot: './data',               // OPTIONAL fs.watch refresh (index mode)
    // reindexMs: 60000,                 // cached-index TTL
  },
}]
```

```bash
curl "http://localhost:3000/search?q=fishing%20boat&container=/alice/notes/" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "query": "fishing boat",
  "hits": [
    { "url": "http://localhost:3000/alice/notes/boats.jsonld",
      "title": "The old fishing boat",
      "snippet": "An old fishing boat rests in the harbor. The fishing crew …",
      "score": 0.7421 }
  ]
}
```

**Scope** — the caller names which container subtree to search:
`?container=/path/` (this server's origin) or `config.defaultContainer`. The
plugin walks it recursively over loopback: containers via their `ldp:contains`
listing, leaf members fetched and scanned (`.acl`/`.meta` sidecars and
non-text bodies skipped), bounded by `maxDepth`/`maxResources`. When the walk
is cut short the response carries `X-Search-Scope-Truncated: true`;
`X-Search-Scope-Resources` always counts the resources visited, and
`X-Search-Mode` reports `read-time` or `cached-index`.

**Authorization** — every loopback fetch carries the caller's own
`Authorization`, so the searchable set is exactly what the caller could `GET`
themselves. Anonymous callers search only public data; WAC can never disagree
with the server, because the server itself answers every fetch.

**CORS** — the endpoint sets `Access-Control-Allow-Origin: *` and answers the
`OPTIONS` preflight (allowing the `Authorization` header), so a browser search
UI on another origin can call it. A bearer token is an explicit request
header, not a cookie, so the wildcard origin is safe here.

## Ranking

Deliberately small and exactly this:

- **Tokenising** — Unicode-aware, lowercased, split on non-alphanumerics.
  `?q=` is parsed into terms: a `"quoted run"` is a **phrase** term (matched
  as a normalised-whitespace substring), bare words are single terms.
- **AND semantics** — a document is a hit only when it contains **every**
  query term; a term absent from a doc drops it.
- **TF-IDF** — per term, `idf = ln((N+1)/(df+1)) + 1` (smoothed, always
  positive) over the `N` crawled docs; per doc, a sublinear, length-normalised
  term frequency `(1 + ln(tf)) / sqrt(docLength)`. Score is the sum across
  terms. Hits sort by score descending (ties broken by URL for stability).
- **Snippet** — a window of `snippetRadius` chars either side of the first
  matching term in the original text, whitespace-collapsed, elided with `…`.

**Text extraction** — from JSON/JSON-LD, the text-ish props matched by *local
name* so any vocabulary works (`schema:`, `dcterms:`, a bare term): `title`,
`name`, `headline`, `label`, `content`, `articleBody`, `text`, `description`,
`body`, `summary`, `abstract` (arrays, `@value`, `@graph` and one level of
nested objects unwrapped); title from the first title-ish of those. From
`text/html`, tags are crudely stripped (`<script>`/`<style>`/comments dropped
first, a few entities decoded) and the title taken from `<title>`. From
`text/plain` (and markdown/xml) the body *is* the text; the title falls back
to the filename.

## Read-time vs cached-index

| | **read-time** (default) | **cached-index** (`config.index: true`) |
|---|---|---|
| how | walk + scan the container per query | in-memory inverted index (persisted under `pluginDir`), rebuilt on TTL / `fs.watch` |
| correctness | always fresh, WAC-correct by construction | **can be stale or wrong** — see Findings |
| cost | O(N) loopback fetches per query | O(1) after the first crawl, + a per-hit HEAD recheck |
| default | ✅ (deterministic; what the tests exercise) | off |

Cached mode restores WAC on its *output* with a per-hit loopback `HEAD`
against the current caller (the index is a cross-agent store, so it can't be
WAC-correct by itself). Staleness of the *content* it cannot fix — that is
the finding below.

## Test

```bash
node --test --test-concurrency=1 search/test.js
```

Boots a real JSS from npm with `idp: true`, registers two pods, seeds
`/alice/notes/` with JSON-LD articles, a plaintext file and an HTML page over
authenticated `PUT`, then exercises: relevance ranking (the densest doc ranks
first) and snippets, single-term recall, a non-matching term (empty), phrase
queries (adjacent-only), multi-term AND, HTML title + tag stripping (script
text not indexed), the WAC property (owner sees her notes; anonymous and a
second registered agent see nothing), the `400`s and CORS preflight, and
**cached-index mode on the same server** (a second plugin entry at `/isearch`
with `index: true`) proving cached ranking matches read-time and does not leak
private docs across agents. **11 tests.** Both index modes run on ONE server
(a second entry, not a second boot) to sidestep the process-global
`DATA_ROOT` footgun; the misconfiguration test is ordered first for the same
reason.

## Findings

1. **Search is the THIRD — and sharpest — consumer of the missing
   `api.events.onResourceChange` seam.** After notifications/ (late
   notifications) and sparql/ (wrong query results), search makes the seam
   *most user-visible*: freshness is the one property users expect of search
   above all else, and it is exactly what a plugin cannot guarantee. The
   read-time path is correct because it re-crawls every query; the cached
   index — the mode users would actually turn on for a large pod — goes
   **stale** (a write the OS coalesces past `fs.watch`, or a non-filesystem
   storage backend the watcher can't see at all) or **wrong** (a shared
   in-memory index holds one agent's text and would serve it to another). See
   [sparql/'s finding 1](../sparql/README.md#findings) — this is its
   write-index sibling; the two ports together make the seam's rank in
   [NOTES §2](../NOTES.md) empirical, not speculative: two independent
   read-over-pod features both hit the same wall, and search is the one whose
   failure a user notices first.
2. **`fs.watch` on a config-supplied `podsRoot` is a workaround, not a
   fix** — the same one notifications/ uses. It can drop or coalesce events,
   fires only for the filesystem backend, and gives no per-resource ACL
   context, so cache invalidation is guesswork. This plugin therefore keeps
   read-time as the default and treats the watcher as *optional* best-effort
   refresh on top of a TTL; the honest answer to "is my search fresh?" is
   "only in read-time mode."
3. **A cross-agent cache cannot be WAC-correct without help.** The index is
   built under whichever caller first triggered it, so its contents span
   whatever *that* agent could read. Serving it to a second agent would leak
   private text. The plugin patches the *output* with a per-hit loopback
   `HEAD` recheck against the current caller — correct, but it re-introduces
   per-request HTTP (partly defeating the cache) and still leaves the *stored*
   text as a cross-tenant blob. A faithful cached search wants either
   per-agent indexes keyed by identity, or `api.events` carrying the ACL
   context to invalidate precisely — neither is expressible today. Read-time's
   forward-the-Authorization crawl gets this right for free (same property
   sparql/ and rss/ rely on).
4. **`config.baseUrl` again** — same `api.serverInfo` finding as
   notifications/sparql/rss: the plugin needs its host's public origin (the
   `?container=` origin check, the loopback target, absolute hit URLs) and
   must be told it in config; the test does the probe-port-then-boot dance.
   `config.serverInfo` repetition now spans a dozen ports (see
   [NOTES §3](../NOTES.md)).
5. **Process-global `DATA_ROOT` bites multi-boot tests** (host-side quirk,
   not a plugin-api gap): the misconfiguration test boots a second, failing
   `createServer`, which repoints the env var every `createServer` shares, so
   it must be ordered *before* the long-lived boot or the main server's token
   verification silently reads the wrong keys directory (this port learned it
   the hard way — a `before()` hook runs first and poisoned every authed
   query until the boot was moved into an ordered `it`). Both index modes are
   proven on one server precisely to avoid a second long-lived boot.
