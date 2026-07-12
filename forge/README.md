# forge — a personal git forge (tier 1: hosting + browsing; tier 2: issues)

The useful slice of Gogs/Gitea as a JSS plugin: push a repo over smart
HTTP, get a GitHub-style (light theme) web UI for it — repo list, file
table, rendered README, tree/blob/raw views, commit log with pagination,
green/red unified diffs, branches and tags — plus a clean JSON API over
the same model. Tier 2 adds **issues and comments whose bodies live in
the author's pod** (the forge keeps only a pointer index — see the
architecture below). Zero npm dependencies, zero build step, no
framework: every page is server-rendered HTML with inline CSS, all git
work is done by the system `git` binary, and the wire protocol is
delegated to the stock `git-http-backend` CGI (gitscratch's proven
plumbing, re-rooted).

```js
plugins: [{ id: 'forge', module: 'forge/plugin.js', prefix: '/forge',
            config: {
              privateRepos: false,      // true: ALL reads become owner-only
              gitHttpBackend: '/usr/lib/git-core/git-http-backend', // optional
            } }]
```

## Using it

```sh
# push-to-create: your pod username is your namespace
git remote add forge http://localhost:3000/forge/casey/demo.git
git -c http.extraHeader="Authorization: Bearer <token>" push forge main

# then browse http://localhost:3000/forge/casey/demo
```

- **Ownership**: owner = pod username derived from the pusher's WebID
  (first path segment, mastodon/'s `podFromWebid` rule). Pushing into
  your own namespace materializes the bare repo under
  `pluginDir/repos/<owner>/<name>.git` — persistent, no TTL. Pushing into
  someone else's namespace is 403; anonymous push is 401 +
  `WWW-Authenticate`. Clone/fetch and the UI are public by default;
  `privateRepos: true` flips every read (git, HTML, JSON) to owner-only.
- **`api` is a reserved owner name** (the JSON surface lives at
  `<prefix>/api`); a pod user literally named `api` cannot have a forge
  namespace.

## Routes

| route | page |
|---|---|
| `<prefix>/` | repo list across owners (description, last-push time) |
| `<prefix>/<owner>` | that owner's repos |
| `<prefix>/<owner>/<name>` | repo home: branch selector, file table, latest-commit bar, README card, clone box |
| `.../tree/<ref>/<path>` | directory listing (folders first, per-entry last commit) |
| `.../blob/<ref>/<path>` | file view: line numbers, monospace; binary/too-large fall back to a raw link |
| `.../raw/<ref>/<path>` | raw bytes — `text/plain` or `application/octet-stream`+attachment, **never** `text/html` |
| `.../commits/<ref>?page=N` | log, 30/page: message, short sha, author, relative time, identicon |
| `.../commit/<sha>` | full commit with GitHub-style unified diff (collapsible per-file sections, +N/−M counts) |
| `.../branches`, `.../tags` | ref lists |
| `.../issues?state=open\|closed&page=N` | issue list: GitHub-style filter tabs, green open / purple closed icons, relative times, comment counts |
| `.../issues/<n>` | thread: issue body then comments in comment boxes (identicon, author → WebID link, relative time, `owner` badge), markdown bodies |
| `.../issues/new` | new-issue form (vanilla-JS client, see below) |
| `<prefix>/<owner>/<name>.git/...` | git smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`) |

Refs may contain `/` (`feature/x`): the tree/blob/raw/commits routes
resolve the ref greedily against the real ref list (longest match wins),
so `tree/feature/x/src` is unambiguous.

## JSON API (the Gitea-parity surface)

All under `GET <prefix>/api`, `application/json`, strings raw (JSON is
the escape) — except `readme.html`, which is the server-side markdown
renderer's already-escaped HTML, safe to inject as markup. Shapes:

- `api/repos` and `api/repos/<owner>` →
  `{ repos: [{ owner, name, description, lastPush, cloneUrl, url }] }`
- `api/repos/<owner>/<name>` →
  `{ owner, name, description, lastPush, empty, defaultBranch,
     branches: [{ name, sha, when, subject }], tags: [...],
     cloneUrl, readme: { name, html } | null }`
- `.../tree/<ref>/<path>` →
  `{ ref, path, entries: [{ mode, type: 'tree'|'blob', sha, size, name,
     lastCommit: { sha, short, author, email, at, subject } | null }] }`
- `.../blob/<ref>/<path>` →
  `{ ref, path, size, binary, tooLarge, content | null }`
- `.../commits/<ref>?page=N` →
  `{ ref, page, perPage: 30, hasMore, commits: [{ sha, short, author,
     email, at, subject }] }`
- `.../commit/<sha>` →
  `{ sha, short, author, email, at, parents, message,
     files: [{ name, binary, adds, dels, hunks: [{ header,
       lines: [{ type: 'add'|'del'|'ctx'|'meta', oldLine, newLine, text }] }] }] }`

Errors are `{ error }` with 4xx. `cloneUrl` is absolute: the origin comes
from `api.serverInfo` (#601) at request time, with `config.baseUrl` as
the reverse-proxy override.

## Issues (tier 2): pods hold the words, pluginDir holds the spine

```
  the AUTHOR's pod (WAC-governed, author-owned)      pluginDir/issues/<owner>/<repo>.json
  /casey/public/forge/o--r/issue-<uuid>.jsonld       { next: 4, issues: { 1: {
  /dana/public/forge/o--r/comment-<uuid>.jsonld          number, title, state: open|closed,
    { type: ForgeIssue|ForgeComment, repo,               author, createdAt,
      issue, title?, body, published, author }           thread: [{ author, resourceUrl, at }, …] } } }
```

- **Content in the author's pod.** When casey opens an issue on
  `melvin/plugins`, the forge loopback-PUTs the JSON-LD document to
  `<casey's pod>/public/forge/<owner>--<repo>/issue-<uuid>.jsonld` —
  **with casey's own forwarded Bearer**, so real WAC governs the write
  and the resource is casey's property, not the forge's. Comments work
  identically into the *commenter's* pod (`comment-<uuid>.jsonld`).
- **Index + state in pluginDir** (atomic tmp+rename writes, one writer
  per repo): next issue number, denormalized title, open/closed state,
  author WebID, createdAt, and the thread as an ordered list of
  `{author, resourceUrl, at}` pointers. The index **never** copies body
  text — bodies are re-fetched from the pods at read time over loopback
  (public read; 8-way bounded parallelism, 8 s per-fetch timeout,
  500-entry thread cap, 64 KiB body cap).
- **The honest consequence (feature, not bug):** if an author deletes
  the resource from their own pod, the thread renders that slot as a
  muted *"content removed by its author"* placeholder — the pointer
  (who/when) remains, the words are gone everywhere. Test-proven.
- **State transitions** (close/reopen, title edit) are index operations,
  allowed for the repo owner OR the issue author, via Bearer-authed
  routes (`getAgent`). Anonymous writes are 401; a third party closing
  someone else's issue is 403.

### Issue JSON API

- `GET api/repos/<o>/<n>/issues?state=open|closed&page=N` →
  `{ state, page, perPage: 25, hasMore, openCount, closedCount,
     issues: [{ number, title, state, author, createdAt, comments }] }`
- `GET api/repos/<o>/<n>/issues/<num>` →
  `{ number, title, state, author, createdAt, thread: [{ author, at,
     resourceUrl, body|null, removed, html|null }] }` — `html` is the
  server-side markdown renderer's already-escaped output; `body` is the
  raw markdown straight from the pod (JSON is the escape); `removed` is
  true when the author has deleted the pod resource.
- `POST api/repos/<o>/<n>/issues` `{title, body}` → 201
  `{ number, url, resourceUrl }` (Bearer required)
- `POST .../issues/<num>/comments` `{body}` → 201
  `{ number, comments, resourceUrl }`
- `POST .../issues/<num>/close` / `.../reopen` → `{ number, state }`
  (repo owner or issue author)
- `PATCH .../issues/<num>` `{title}` → `{ number, title }` (owner or author)
- `PATCH api/repos/<o>/<n>` `{description}` → writes the bare repo's
  `description` file (repo owner only); shown on the repo home and list.

### The vanilla-JS client (deliberately tiny)

Every issues page embeds one dependency-free inline
`<script type="module">` (no build, no framework) that:

- offers a login box — username/password → `POST /idp/credentials`,
  token kept in localStorage, "Signed in as X" + sign-out;
- drives new-issue/comment/close/reopen through `fetch` + Bearer against
  the JSON API, then **reloads — the server always renders the truth**;
- touches the DOM only via `textContent`/`createElement`; fetched
  strings never meet `innerHTML`.

With JS off the pages stay fully readable and a `<noscript>` note says
interactive actions need JavaScript and sign-in.

## The markdown subset (hand-rolled, bounded)

Escape **first**, then transform — the renderer is structurally
XSS-proof (test-proven: a README containing `<script>alert(1)</script>`
renders it as visible escaped text). Grammar:

- blocks: `#`–`######` headings, ``` fenced code, `>` blockquotes,
  `-`/`*` unordered and `1.` ordered lists (no nesting), blank-line
  paragraphs. No tables, no HTML passthrough.
- inline: `` `code` ``, `**bold**`, `*em*`/`_em_`, `[text](href)`,
  `![alt](src)`. hrefs are allowlisted to `http(s)://`, `#anchor`, or
  relative (no other schemes, no `//`, no `..`); relative images route
  through the raw endpoint, relative links through blob view.

READMEs and blobs over 512 KiB are not rendered ("view raw"); binary
detection is a NUL sniff over the first 8 KB.

## Security decisions

- **Raw serving is content-type-neutralized**: never `text/html` (see
  Findings 1), always `X-Content-Type-Options: nosniff`.
- **One `esc()` helper, used on every interpolated string** — filenames,
  commit messages, author names, diff bodies, ref names are all
  attacker-controlled (anyone with a pod can push anything).
- **Validation before any path or git argument is built**: owner/repo
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,N}$`, refs
  `^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$` minus `..`, path segments reject
  `..`, leading `.`, backslash, control chars and percent-encoded
  `./`/`\` forms. All git reads use `execFile` argv arrays (no shell),
  NUL-separated `--format`s (never parsed human output), with
  `GIT_CONFIG_NOSYSTEM=1` and no `HOME`.
- Client-side JavaScript is the clone-box copy button (degrades to a
  selectable input) and the issues client above (degrades to read-only
  pages). The page CSP grants `connect-src 'self'` — exactly enough for
  the client's same-origin fetches, nothing outbound.

## Deliberate cuts

- **No syntax highlighting** — that's where the old attempt's 1 MB
  bundle came from. A `<pre>` with line numbers covers tier-1 browsing;
  highlighting is a candidate for a later wave *if* it can be done
  server-side and dependency-free.
- **No search, no PRs/webhooks** — later tiers (see Findings 3). Issues
  arrived in tier 2; PRs want the same pod-native treatment.
- **No browser-git** — every byte of git logic is the system binary;
  server-side rendering made the old client bundle unnecessary.

## Findings

### 1. Stored-XSS via pushed HTML is neutralized by content-type, not by a second domain

A forge serves attacker-authored bytes from the API origin: a pushed
`evil.html` fetched as `text/html` would run scripts with the origin's
cookies/storage — classic stored XSS. GitHub's fix is architectural (a
separate `raw.githubusercontent.com` domain); a single-origin plugin
can't have that, so the raw endpoint neutralizes instead: text-ish blobs
go out as `text/plain`, everything else as `application/octet-stream` +
`content-disposition: attachment`, never `text/html`, plus
`X-Content-Type-Options: nosniff` so browsers can't second-guess.
Test-proven. The same reasoning puts the README renderer server-side and
escape-first: HTML in a README is data, never markup.

### 2. The counter-witness pattern again: everything under one prefix, no reservePath

Like micropub/, this plugin needs **zero** protocol-fixed paths outside
its prefix — smart HTTP, UI and JSON API all live under `<prefix>`,
which the loader WAC-exempts. `api.reservePath` (#602) exists and is the
right tool for protocol-pinned roots (xrpc, .well-known), but a forge is
evidence the common case needs nothing beyond `api.prefix`. gitscratch's
scoped pass-through content parser was also enough to stream raw pack
bodies through Fastify — `api.mountApp` (#583) was not needed here.

### 3. What a forge needs that the plugin api lacks (the tier-2 shopping list)

- **Per-repo ACL beyond owner-only** — collaborators, org repos, private
  repos shared with named agents: that is exactly `api.authorize`'s
  (#604) issuer-authority case. Today the model is binary
  (public / owner-only via `privateRepos`) because the owner's WAC
  cannot be consulted for a *third party's* read.
- **Webhooks / push notifications** — "repo X was pushed" wants
  `api.events` (#603). The post-receive hook is where the fact is known;
  today it can only fix HEAD, not notify anyone.
- **Repo metadata as pod resources** — description, topics, default
  branch override should live in the owner's pod so they are
  WAC-governed and portable. Tier 2 added `PATCH api/repos/<o>/<n>`
  (owner-authed) writing git's `description` file — a forge-owned file,
  deliberately, because *repo* metadata is coordination state like the
  issue index (Finding 6), not the owner's speech. The README-first-line
  fallback remains for repos that never set one.
- **Identity mapping is convention, not contract** — owner = first
  WebID path segment (podFromWebid) works for this host's pods but is a
  heuristic; did:nostr agents have no pod namespace at all and therefore
  cannot push. An `api.podOf(agent)` seam would make ownership honest.

### 4. The JSON API doubles as the Gitea-parity surface

The maintainer wants clients with JSON and JS; the api layer
(`<prefix>/api/...`) is deliberately shaped so a future vanilla-JS
client (or a Gitea-compatible tool, loosely) can drive everything the
HTML shows: repo meta with pre-rendered README html, typed tree entries,
blob flags (`binary`/`tooLarge`), paginated commits, and a structured
diff (`files[] → hunks[] → typed lines` with old/new line numbers) that
is the same parse the HTML diff is rendered from — one parser, two
surfaces, so they cannot drift. HTML stayed server-rendered because it
was finished and correct; the JSON API is the extension point for a
richer client, not a rewrite hook.

### 5. Costs accepted and written down

- The file table's per-entry "last commit touching this path" column is
  one `git log -1 -- <path>` per entry (capped at 100) — O(N) process
  spawns per tree view. Gitea caches this; a cache is a tier-2 concern.
- The repo index runs a few git calls per repo (capped at 200 repos) to
  get last-push time and a description line.
- No `api.events` also means no push-time cache invalidation, so
  everything is computed read-time — consistent with the sparql//rss/
  finding that read-time walks are the only option today.

### 6. Content ownership with a plugin-owned index (the tier-2 pattern)

An issue body or comment is a JSON-LD resource **the author owns**: the
forge loopback-PUTs it into the author's own pod with the author's own
forwarded Bearer, so the pod's real WAC decides the write and the
resource remains the author's property. The forge keeps only the
*spine* — number allocation, title, open/closed state, and an ordered
list of `{author, resourceUrl, at}` pointers — and re-fetches the words
at read time. The split is exact: everything that is *coordination*
(numbering, state, ordering) is plugin state; everything that is
*speech* is pod data. The killer beat, test-proven: when the commenter
DELETEs her resource from her own pod (a plain LDP DELETE the forge
never sees), the thread renders "content removed by its author" — real
deletion with no forge cooperation required, GDPR-shaped for free, and
the pointer preserves the thread's who/when integrity.

### 7. The moderation gap is `api.authorize`'s issuer-authority case, named

The flip side of Finding 6: the repo owner **cannot edit or delete the
words** in a commenter's pod — melvin can close the issue or retitle it
(index operations), but a spam comment's body sits in the spammer's pod
under the spammer's WAC, where melvin has no write bit. All the forge
could do today is drop the pointer (hiding, not deleting — the resource
survives at a public URL). Real moderation needs a third authority
level: "this *forge* rules this *thread*", i.e. the plugin asserting
authority over content it indexes but does not store — exactly the
`api.authorize` (#604) issuer-authority case. Until that seam exists,
moderation here is honest about being curation of pointers.

### 8. Read-time fan-out is the price of not copying (the api.events/cache case)

A thread with N entries costs N loopback GETs on every render, because
the index refuses to cache body text (a cache would resurrect deleted
content — the one thing the architecture promises not to do). Bounded
here: 8-way parallelism, 8 s per-fetch timeout, 500-entry thread cap,
64 KiB body cap; a full 500-entry thread is ~63 sequential rounds of 8.
That is fine at plugin scale and wrong at any bigger scale — the correct
fix is an invalidation signal, not a TTL: `api.events` (#603) firing on
pod resource change would let the forge cache bodies *and* evict on
delete, keeping the removal semantics exact. One more real discovery:
once a page carries a JSON-driven client, CSP needs `connect-src 'self'`
— tier 1's `default-src 'none'` silently blocks every `fetch()`, which
is invisible until the first interactive page exists.
