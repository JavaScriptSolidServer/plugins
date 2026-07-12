# forge — a personal git forge (tier 1: hosting + browsing)

The useful slice of Gogs/Gitea as a JSS plugin: push a repo over smart
HTTP, get a GitHub-style (light theme) web UI for it — repo list, file
table, rendered README, tree/blob/raw views, commit log with pagination,
green/red unified diffs, branches and tags — plus a clean JSON API over
the same model. Zero npm dependencies, zero build step, no framework:
every page is server-rendered HTML with inline CSS, all git work is done
by the system `git` binary, and the wire protocol is delegated to the
stock `git-http-backend` CGI (gitscratch's proven plumbing, re-rooted).

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
- The only client-side JavaScript is the clone-box copy button, which
  degrades to a selectable input.

## Deliberate cuts

- **No syntax highlighting** — that's where the old attempt's 1 MB
  bundle came from. A `<pre>` with line numbers covers tier-1 browsing;
  highlighting is a candidate for a later wave *if* it can be done
  server-side and dependency-free.
- **No search, no issues/PRs/webhooks** — later tiers (see Findings 3).
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
  branch override should live in the owner's pod (tier-2 plan) so they
  are WAC-governed and portable; today description is derived (git's
  `description` file or README first line) because there is no clean
  write path from a plugin into a pod except loopback-with-the-user's-
  token, and browsing is anonymous.
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
