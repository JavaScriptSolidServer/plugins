# sparql/ — SPARQL SELECT + UPDATE (ground data) over a pod

Exploration of [issue #509](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/509)
("SPARQL endpoint + write-time index — make pods queryable") as a #206
loader plugin. It ships the **read-time half** of that issue honestly —
`POST /sparql` over a pod's JSON-LD, WAC-filtered by construction — plus
**SPARQL UPDATE for the ground-data forms** (`INSERT DATA` / `DELETE DATA`,
one resource per update, applied over loopback with the caller's own
credentials and the host's own `If-Match`), and documents why the
**write-time index half still cannot be built as a plugin today** (see
Findings — owning a write endpoint does not change that).

No npm dependencies: the SPARQL tokenizer/parser, the JSON-LD ⇄ triples
mapping (both directions), and the BGP evaluator are hand-rolled on node
builtins.

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

## SPARQL UPDATE

```bash
curl -X POST "http://localhost:3000/sparql" \
  -H 'Content-Type: application/sparql-update' \
  -H "Authorization: Bearer $TOKEN" \
  --data '
PREFIX schema: <https://schema.org/>
INSERT DATA { GRAPH <http://localhost:3000/alice/photos/photo-1.jsonld> {
  <http://localhost:3000/alice/photos/photo-1.jsonld> schema:keywords "vintage" .
} }'
```

`POST <prefix>` with `Content-Type: application/sparql-update` accepts
exactly two forms — **`INSERT DATA`** and **`DELETE DATA`** with ground
triples (no variables, no blank nodes). Success is `200` with a small JSON
summary (matching the endpoint's JSON-body style):
`{ "ok": true, "op": "INSERT DATA", "resource": …, "inserted": n,
"removed": n, "triples": total, "retried": bool }`.

**Target** — an update names exactly ONE resource (the read side's
"a JSON-LD resource is a graph" model, inverted): a `GRAPH <iri> { … }`
block in the data block (same-origin, no federation) or `?resource=/path`
on the URL; 400 without one, 400 if both are given and disagree, 400 for a
container path or an `.acl`/`.meta` sidecar (the read side skips those
too).

**How a write happens** — the exact inverse of the read lens:
`GET` the target over loopback with the caller's own `Authorization`
(capturing the host's ETag) → flatten with the same JSON-LD subset the
SELECT side reads → merge (`INSERT DATA`, deduplicated) or filter
(`DELETE DATA`, same datatype/lang-insensitive term matching the evaluator
uses) → serialize back (`@graph` of nodes with absolute-IRI keys,
`@type`, `{"@id"}` / `{"@value","@type","@language"}` objects) → `PUT`
with `If-Match` (or `If-None-Match: *` when creating). On `412` the whole
read-transform-write is retried once, then `409` to the caller. WAC
decides both legs: a caller who can't read the target gets the host's
401/403 back verbatim; one who can read but not write gets the PUT's.

Semantics that follow (all deliberate, all tested):

- `INSERT DATA` into a missing resource **creates** it
  (`PUT If-None-Match: *`); `DELETE DATA` against a missing resource is
  `404`.
- `DELETE DATA` removing the last triple leaves an **empty resource**
  (`{"@graph":[]}`), not a 404 — LDP resource existence and graph
  emptiness are different things; `DELETE` the resource itself to remove
  it.
- Inserting a triple that's already present / deleting one that isn't is a
  no-op (`inserted`/`removed` say so) and issues **no write at all**.
- **An update REWRITES the target through the plugin's triple lens.**
  Anything the documented flattening subset drops — terms no `@context`
  maps (and no `@vocab` catches), `@list` order, the original `@context`
  and formatting — does **not survive** an update. Data invisible to
  SELECT does not survive an UPDATE; don't point this endpoint at JSON-LD
  that leans on the unhandled features.

**Refused honestly, not half-implemented**: the pattern forms
(`DELETE`/`INSERT … WHERE`, `WITH`, `USING`), graph management (`LOAD`,
`CLEAR`, `CREATE`, `DROP`, `COPY`, `MOVE`, `ADD`) and multi-operation
requests (`;`) are **501** with a clear error. A faithful `… WHERE` needs
bnode-safe template instantiation against the store, which the read
engine's per-document bnode relabelling cannot round-trip — a documented
wall, not a parser gap. Variables or blank nodes inside a `DATA` block are
400.

## Supported SPARQL subset

Deliberately small and exactly this — a documented subset beats a broken
full parser:

| Feature | Supported |
|---|---|
| Query form | `SELECT` (queries); `INSERT DATA`/`DELETE DATA` (updates — see above); no `ASK`/`CONSTRUCT`/`DESCRIBE` |
| Projection | `SELECT ?a ?b`, `SELECT *`, `SELECT DISTINCT` |
| Prologue | `PREFIX ns: <iri>` (with `rdf:`/`xsd:` predefined) |
| Dataset | one optional `FROM <iri>` (same-origin scope container) |
| Patterns | Basic Graph Patterns: any mix of variables, `<iri>`s, prefixed names, literals; joined by conjunction |
| Abbreviations | `a` for `rdf:type`; predicate lists with `;`; object lists with `,` |
| Literals | `"strings"` (`\"`, `\\`, `\n`, `\t` escapes), integers/decimals, `true`/`false`, `"…"^^dt`, `"…"@lang` (datatype/lang stored, ignored by matching) |
| FILTER | `FILTER(expr op expr)` with `=` `!=` `<` `>` `<=` `>=` (numeric when both sides look numeric, else string comparison); `FILTER(CONTAINS(?v, "str"))`; `FILTER(REGEX(?v, "pat", "flags"))`; operands are variables or constants; multiple FILTERs conjoin |
| Modifiers | `LIMIT n` |
| Comments | `# to end of line` |

**Not supported in queries** (parse error, by design): `OPTIONAL`, `UNION`,
`GRAPH` (update data blocks use it to name their target; queries don't),
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

The update tests cover: `INSERT DATA` then `SELECT` sees the triple (and
the pre-existing triples survive the rewrite, and re-inserting is a
no-op); create-on-insert via `?resource=`; `DELETE DATA` then `SELECT` no
longer sees it; deleting every triple leaves an empty resource; the WAC
401/403 passthrough (and that a refused update does not land); the 400 and
501 families; the **412 retry path, deterministically** — the plugin runs
in-process and reaches the host through global `fetch`, so the test wraps
`globalThis.fetch` to slip an interfering external write into the window
between the plugin's GET and its `If-Match` PUT, then asserts the update
retried and merged against the *new* state; and a concurrent-writers test
that asserts exactly the invariants the host guarantees (see Findings 7).

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

   **Sharpened by the update surface: owning a write endpoint does not
   buy the index either.** The plugin now *has* a write path — every
   `INSERT DATA`/`DELETE DATA` flows through code that could update an
   index synchronously, transactionally, for free. And it still can't
   maintain one, because writes through plain LDP (`PUT`/`POST`/`PATCH`/
   `DELETE` on the pod, which every Solid app uses) bypass this endpoint
   entirely: the plugin would index its own writes and silently miss
   everyone else's — a *wrong-results* index, worse than none.
   Partial-write-path visibility is not enough; the index needs the
   HOST's event stream, because only the host sees all writes. This is a
   new sharpening of the `api.events` finding: **a plugin that owns a
   write endpoint still can't see sibling writes.**
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
6. **Optimistic concurrency via `If-Match` over loopback WORKS for the
   stale-writer case (measured)** — this plugin is the **second consumer**
   of the conditional-write pass-through remotestorage/ measured. Every
   update is GET (capture the host's ETag) → transform → `PUT If-Match`
   (or `If-None-Match: *` on create); the headers pass through loopback
   verbatim and the host honors them. The retry path is proven end-to-end
   and *deterministically*: the test injects a real external write between
   the plugin's GET and PUT, the host answers the now-stale `If-Match` PUT
   with **412**, and the plugin's single re-read-and-retry merges against
   the new state — the interfering write's triple and the update's triple
   both survive. A second consecutive 412 becomes a 409 to the caller.
   Loopback WAC also composes with it for free: the GET leg bounces
   readers the pod refuses, the PUT leg bounces writers, both as the
   host's own 401/403 passed through verbatim.
7. **…but the host's conditional write is check-then-write, NOT atomic
   under overlap (measured — sharpens remotestorage/ finding 2).**
   remotestorage/ measured sequential staleness ("stale `If-Match` PUT →
   412 … atomic at the host") and this repo has been citing it as such.
   Driving it *concurrently* says otherwise: two overlapping PUTs carrying
   the SAME currently-valid `If-Match` both return **2xx** — the handler
   `stat`s (ETag check) and writes with awaits in between, so both checks
   can pass before either write lands, and the loser is silently
   overwritten (measured against the npm host: `204`/`204`, second body
   wins; the same PUTs issued sequentially 412 correctly). For this
   plugin that means two simultaneous updates to one resource can lose
   one update with both callers told 200 — the suite's concurrency test
   asserts exactly the invariants that DO hold (both 200, no torn state,
   seeded triples survive, result ⊆ union). No plugin can fix this:
   the race is inside the host's PUT handler, between requests the plugin
   has already sent. The host-side fix is making the ETag check and the
   write atomic (serialize per path, or compare-and-swap at the storage
   layer).
8. **The rewrite lens is honest but lossy, by construction.** The write
   side is the exact inverse of the read side's documented JSON-LD subset,
   so an update round-trips every triple SELECT can see — and rewrites the
   stored document into normalized form (`@graph` + absolute IRIs),
   dropping exactly what the read side already ignored: unmapped terms,
   `@list` order, the original `@context`. "Data invisible to the query
   engine does not survive its updates" is the sharpest way to say it;
   the alternative (surgical JSON edits preserving unknown structure)
   would mean updates whose effects SELECT couldn't confirm. Documented
   loudly above instead. (Also mildly convenient: the loader's wildcard
   `parseAs: 'buffer'` content-type parser passed `application/
   sparql-update` bodies through untouched — no parser gap this time.)
