# backup — download a pod container as a .tar.gz

Data portability in one request: `GET /backup/<container>/` walks the
container recursively and streams everything the caller can read as a
gzipped POSIX ustar archive. Read-only, no external fetches, no writes —
built on the [#206 plugin loader](https://jss.live/docs/features/plugins)
with the loopback container-walk that `rss/`, `sparql/`, `search/` and
`webdav/` established.

```js
plugins: [{
  module: 'backup/plugin.js',
  prefix: '/backup',
  config: {
    loopbackUrl: 'http://127.0.0.1:3000', // where the plugin reaches its own host (required)
    // maxResources: 10000,               // loopback fetches per archive (walk cap)
    // maxDepth: 32,                      // container nesting cap
  },
}]
```

```sh
# Everything under /alice/ you can read, as alice.tar.gz:
curl -H "Authorization: Bearer $TOKEN" -OJ http://localhost:3000/backup/alice/

# A sub-container:
curl -H "Authorization: Bearer $TOKEN" -OJ http://localhost:3000/backup/alice/photos/

# Restore is just tar:
tar -xzf alice.tar.gz
```

## Routes

| Route | Returns |
|---|---|
| `GET /backup/<pod-path>/` | `application/gzip` tar of the container tree, `Content-Disposition: attachment` |
| `GET /backup/<pod-path>` | same — a missing trailing slash is treated as the container |
| `GET /backup/`, `GET /backup` | `400` with usage — whole-server export is deliberately not offered |

An unreadable or missing **root** container is the caller's error status
(`401`/`403`/`404`), decided *before* the `200` is committed. Everything
below the root is best-effort: a member the caller cannot GET is **skipped,
not fatal**.

## What's in the archive

- A **directory entry** (typeflag `5`) per container, a **file entry** per
  readable resource, byte-for-byte as the pod serves it, `mtime` from the
  listing's `dcterms:modified` when present.
- **`MANIFEST.json` at the archive root** (written last, once the walk is
  complete): the requested container, generation time, `included` (path,
  entry name, size, content-type), `skipped` (path + reason
  `unauthorized` / `error` / `name-too-long` / `max-depth`, plus HTTP status
  where there was one), counts, and a `truncated` flag if `maxResources` /
  `maxDepth` cut the walk short.
- Names longer than tar's 100-byte field ride the ustar **prefix field**
  (155 more bytes, split at a `/`); a name that still doesn't fit is skipped
  and counted. Percent-encoded segments are decoded for readability unless
  decoding would change the path shape (`.`, `..`, a `/` or NUL) — a hostile
  resource name cannot traverse out of the extraction directory.
- `.acl` / `.meta` companions are **not** exported (see Findings).

## Auth

The walk happens over loopback HTTP **forwarding the caller's
`Authorization` header verbatim**, so the host's real WAC decides every
single GET. The plugin has no authority of its own:

- with a pod bearer you get everything that token can read;
- **with no credentials the request still works** — you get an archive of
  exactly the publicly-readable subset, and every private resource shows up
  in `MANIFEST.json` as `{ "reason": "unauthorized" }`.

## What maps / what doesn't

| Solid | tar | note |
|---|---|---|
| container | directory entry | typeflag `5`, mode 755 |
| resource bytes + `Content-Type` | file entry + manifest `contentType` | tar has no MIME field; the manifest carries it |
| `dcterms:modified` | entry `mtime` | best-effort from the container listing |
| WAC (`.acl`) | — | not exported; permissions don't round-trip |
| resource metadata (`.meta`) | — | not exported |
| a consistent snapshot | — | the walk is not atomic; see Findings |

## Findings

- **No `api.events` → pull-on-demand only.** There is no
  `onResourceChange` hook, so incremental backup ("archive what changed
  since last time") and scheduled/server-initiated backup are impossible to
  build well: the plugin can't observe writes, and it has no credentials of
  its own to walk with anyway. Every backup is a full read-time crawl,
  initiated and authorized by the caller. Same wall as `sparql/`, `rss/`,
  `search/`, `matrix/` — the #2 seam in NOTES.md, now with a
  backup-flavoured consumer.

- **No `api.authorize` / no direct read API → O(N) loopback round-trips.**
  Confirmed in the shape of the code: one HTTP GET per container listing
  plus one HTTP GET per resource, each carrying the requester's own
  credentials so WAC is answered correctly by construction. For a
  data-exfiltration-safe *export* feature this is definitionally right —
  but it means an N-resource pod costs N+containers loopback requests where
  a host-side seam (an authorized read API, or `api.authorize` + direct
  storage access) would make this a filesystem walk with one WAC check per
  entry. The dominant cost of a backup is HTTP overhead to yourself.

- **Memory profile: streamed archive, one buffered resource at a time —
  and the buffering is structural.** The gzip stream goes to the client as
  the walk runs (backpressure respected), so the whole archive is never in
  memory; but each resource *is* fully buffered before its tar entry is
  written, because a tar header must state the byte size **before** the
  data. Trusting a HEAD `Content-Length` instead would corrupt the archive
  if the resource changed between HEAD and GET — there is no ETag-pinned
  read to prevent that race. Fine for pod-sized resources; a multi-GB single
  resource would hurt. (ustar's 11-octal-digit size field caps an entry at
  8 GiB regardless.)

- **No snapshot semantics.** The walk is not atomic: a pod written during
  the walk yields a mixed-state archive (old bytes for already-archived
  resources, new for later ones), and nothing in the api offers a lock,
  snapshot, or even a conditional multi-read. A backup of a quiet pod is
  exact; a backup of a busy pod is honest but fuzzy. Worth knowing for
  anyone treating this as disaster recovery.

- **Skip counts can't go in a response header.** Streaming means the
  headers are committed before the walk starts, and fetch/Node expose no
  HTTP trailers usefully — so the bookkeeping *must* travel in-band. That's
  why `MANIFEST.json` is a tar entry (the last one) rather than an
  `X-Backup-Skipped` header.

- **Permissions don't survive export — and can't, cleanly.** `.acl`/`.meta`
  are filtered from the walk (the same member filter `rss/`/`s3/` use).
  Including them would only need the caller to hold `acl:Control` per
  resource (the loopback GET would enforce that for free), but a tarball of
  `.acl` files full of absolute URLs doesn't restore meaningfully onto
  another server anyway. Real portability of *policy*, not just bytes, is a
  spec-level gap, not a plugin-api gap.

- **`config.loopbackUrl` repetition — the `api.serverInfo` seam again.**
  The plugin must be told where its own host lives to make loopback calls;
  it fails loudly at `activate` when the config is missing. Same finding as
  ~10 other plugins in this repo.
