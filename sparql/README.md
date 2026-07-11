# sparql/ — SPARQL SELECT over a pod, read-time only

Exploration of [issue #509](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/509)
("SPARQL endpoint + write-time index — make pods queryable") as a #206
loader plugin. It ships the **read-time half** of that issue honestly —
`POST /sparql` over a pod's JSON-LD, WAC-filtered by construction — and
documents why the **write-time index half cannot be built as a plugin
today** (see Findings).

No npm dependencies: the SPARQL tokenizer/parser, the JSON-LD → triples
flattener, and the BGP evaluator are hand-rolled on node builtins.

## Usage

```js
plugins: [{
  module: 'sparql/plugin.js',
  prefix: '/sparql',
  config: {
    baseUrl: 'http://localhost:3000',   // required: the server's public origin
    // loopbackUrl: 'http://127.0.0.1:3000',  // where the plugin reaches its host
    // defaultContainer: '/alice/',     // scope when the query names none
    // maxDepth: 3,                     // container recursion below the scope
    // maxResources: 200,               // loopback fetches per query
    // resultCap: 1000,                 // bindings cap even without LIMIT
  },
}]
```

```bash
curl -X POST http://localhost:3000/sparql \
  -H 'Content-Type: application/sparql-query' \
  -H "Authorization: Bearer $TOKEN" \
  --data '
PREFIX schema: <https://schema.org/>
SELECT ?s ?d
FROM <http://localhost:3000/alice/photos/>
WHERE {
  ?s a schema:Photo .
  ?s schema:dateCreated ?d .
  FILTER(?d > "2025-01-01")
}
LIMIT 10'
```

Returns the SPARQL 1.1 JSON results format:
`{ "head": { "vars": [...] }, "results": { "bindings": [...] } }` as
`application/sparql-results+json`. `GET /sparql` returns a small JSON
description of the endpoint and its limits.

**Scope** — the caller names which container subtree to query, one of:
`FROM <iri>` in the query (must be this server's origin — no federation),
`?container=/path/` on the URL, or `config.defaultContainer`. The plugin
walks it recursively over loopback: containers via their `ldp:contains`
listing, other resources parsed only when the server serves them as JSON
(`.acl`/`.meta` sidecars skipped), bounded by `maxDepth`/`maxResources`.
When the walk is cut short the response carries
`X-SPARQL-Scope-Truncated: true`; `X-SPARQL-Scope-Resources` always counts
the resources visited.

**Authorization** — every loopback fetch carries the caller's own
`Authorization` header, so the dataset is exactly what the caller could
`GET` themselves. Anonymous callers query only public data; WAC can never
disagree with the server because the server itself answers every fetch
(the notifications plugin's loopback pattern, applied to a whole dataset).

## Supported SPARQL subset

Deliberately small and exactly this — a documented subset beats a broken
full parser:

| Feature | Supported |
|---|---|
| Query form | `SELECT` only (no `ASK`/`CONSTRUCT`/`DESCRIBE`/`UPDATE`) |
| Projection | `SELECT ?a ?b`, `SELECT *`, `SELECT DISTINCT` |
| Prologue | `PREFIX ns: <iri>` (with `rdf:`/`xsd:` predefined) |
| Dataset | one optional `FROM <iri>` (same-origin scope container) |
| Patterns | Basic Graph Patterns: any mix of variables, `<iri>`s, prefixed names, literals; joined by conjunction |
| Abbreviations | `a` for `rdf:type`; predicate lists with `;`; object lists with `,` |
| Literals | `"strings"` (`\"`, `\\`, `\n`, `\t` escapes), integers/decimals, `true`/`false`, `"…"^^dt`, `"…"@lang` (datatype/lang stored, ignored by matching) |
| FILTER | `FILTER(expr op expr)` with `=` `!=` `<` `>` `<=` `>=` (numeric when both sides look numeric, else string comparison); `FILTER(CONTAINS(?v, "str"))`; `FILTER(REGEX(?v, "pat", "flags"))`; operands are variables or constants; multiple FILTERs conjoin |
| Modifiers | `LIMIT n` |
| Comments | `# to end of line` |

**Not supported** (parse error, by design): `OPTIONAL`, `UNION`, `GRAPH`,
`ORDER BY`, `OFFSET`, `GROUP BY`/aggregates, property paths, subqueries,
`BIND`/`VALUES`, blank-node syntax (`[]`) in patterns, `&&`/`||` inside a
FILTER (write two FILTERs for AND), functions beyond CONTAINS/REGEX, and
`SERVICE` federation. Matching is datatype-insensitive: `"5"` matches
`"5"^^xsd:integer`.

### JSON-LD flattening (also a documented subset)

Hand-rolled expansion of each fetched document into triples: `@context` as
an object (prefix maps, term maps, `{"@id": …, "@type": "@id"}` defs,
`@vocab`) or an array; a **string** `@context` is treated as `@vocab` — the
schema.org heuristic, since a plugin fetching remote contexts would be a
new network dependency; `@id` resolved against the resource URL (subject =
resource IRI, or a blank node when absent); `@type` → `rdf:type`; arrays;
nested objects (named or blank) recursed; `@value`/`@type`/`@language`
literal objects; `@list` flattened to repeated triples (order lost);
`@graph`. Not handled: remote context fetching, `@reverse`, `@container`
maps, `@nest`, `@index`. Terms that no context maps (and no `@vocab`
catches) are dropped rather than guessed.

## Test

```bash
node --test --test-concurrency=1 sparql/test.js
```

Boots a real JSS from npm with `idp: true`, registers two pods, seeds
`schema:Photo` JSON-LD resources over authenticated `PUT`, then exercises
BGP joins, `FILTER` comparison/`CONTAINS`/`REGEX`, projection, `LIMIT`,
`DISTINCT`, nested `@id` objects, and the WAC property (owner sees 3
photos; anonymous and a second registered agent see 0).

## Findings

1. **Read-time query works as a plugin; write-time indexing does not — and
   the index is #509's real ask.** The issue wants a `/.index/` maintained
   on every `PUT`/`POST`/`PATCH`/`DELETE` so queries are O(1). A plugin has
   no way to see writes: there is no `api.events.onResourceChange` — this
   is exactly the **top candidate seam already in
   [NOTES.md](../NOTES.md)** ("the seam any future 'react to pod writes'
   app (webhooks, indexing, sync) wants"). This port is that seam's second
   concrete consumer after notifications/, and the stronger one: an index
   that misses a write doesn't just fire a late notification, it returns
   *wrong query results*. `fs.watch` on a config-supplied path (the
   notifications workaround) is not good enough here — a watcher can drop
   or debounce events, and a stale index silently lies. Until the seam
   exists, the honest plugin answer is what this is: crawl at read time.
2. **Performance is O(N) per query, without the index.** Every query
   re-walks the scope container over loopback — one HTTP round-trip per
   resource, bounded by `maxDepth`/`maxResources` and surfaced via the
   `X-SPARQL-Scope-*` headers. `api.storage.pluginDir()` could cache the
   crawl, but without change events, invalidation is guesswork (finding 1
   again). Fine for a few hundred resources; the thousand-resource pod the
   issue opens with is exactly where the write-time index becomes the
   feature.
3. **Loopback answers #509's ACL open question for free.** The issue asks
   how to filter results by the requesting agent's read access without
   leaking private resources. Forwarding the caller's `Authorization` on
   every loopback fetch makes the dataset *definitionally* WAC-correct —
   the server itself decides every resource, per caller, per query. Cost:
   it's per-resource HTTP, which is finding 2's latency. A core
   implementation with an index would need real per-agent filtering; the
   plugin gets correctness now and slowness with it.
4. **`config.baseUrl` again** — same `api.serverInfo` finding as
   notifications/: the plugin needs its host's public origin (FROM origin
   check, loopback target, IRI normalization) and must be told it in
   config; the test does the probe-port-then-boot dance.
5. **Process-global `DATA_ROOT` bites multi-boot tests** (host-side quirk,
   not a plugin-api gap): JSS resolves IdP keys through the `DATA_ROOT`
   env var, which every `createServer` call repoints — so a test that
   boots a second server (even one that fails activation on purpose)
   silently redirects the first server's key lookups. The suite orders the
   failing boot first; notifications/ happens to do the same.
