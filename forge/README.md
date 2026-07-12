# forge — a personal git forge (tier 1: hosting + browsing; tier 2: issues; tier 2.5: nostr agents + xlogin; tier 3a: forks + pull requests)

The useful slice of Gogs/Gitea as a JSS plugin: push a repo over smart
HTTP, get a GitHub-style (light theme) web UI for it — repo list, file
table, rendered README, tree/blob/raw views, commit log with pagination,
green/red unified diffs, branches and tags — plus a clean JSON API over
the same model. Tier 2 adds **issues and comments whose bodies live in
the author's pod** (the forge keeps only a pointer index — see the
architecture below). Tier 2.5 makes **did:nostr agents first-class**
(hex-pubkey namespaces, a NIP-98 → push-token exchange, forge-hosted
issue bodies for podless agents) and puts the vendored **xlogin** widget
on the issues pages. Tier 3a adds **forks, compare, and pull requests
with real merges** (`merge-tree --write-tree` + `commit-tree` +
compare-and-swap `update-ref` — see "Forks & pull requests").
Zero npm dependencies, zero build step, no
framework: every page is server-rendered HTML with inline CSS, all git
work is done by the system `git` binary, and the wire protocol is
delegated to the stock `git-http-backend` CGI (gitscratch's proven
plumbing, re-rooted).

```js
plugins: [{ id: 'forge', module: 'forge/plugin.js', prefix: '/forge',
            config: {
              privateRepos: false,      // true: ALL reads become owner-only
              gitHttpBackend: '/usr/lib/git-core/git-http-backend', // optional
              pushTokenTtl: 3600,       // default lifetime of exchanged push tokens (s)
              cspConnect: [],           // extra connect-src origins (e.g. external Solid IdPs)
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
  (first path segment, mastodon/'s `podFromWebid` rule), **or the 64-hex
  pubkey for `did:nostr:` agents** (see "Nostr agents"). Pushing into
  your own namespace materializes the bare repo under
  `pluginDir/repos/<owner>/<name>.git` — persistent, no TTL. Pushing into
  someone else's namespace is 403; anonymous push is 401 +
  `WWW-Authenticate`. Clone/fetch and the UI are public by default;
  `privateRepos: true` flips every read (git, HTML, JSON) to owner-only.
- **`api` and `xlogin.js` are reserved owner names** (the JSON surface
  lives at `<prefix>/api`, the vendored widget at `<prefix>/xlogin.js`);
  pod users literally named that cannot have a forge namespace.
- **Hex-name collision, decided**: a pod username that is exactly 64
  lowercase hex characters is theoretically registrable and would collide
  with a nostr namespace. Hex-as-nostr wins for display and semantics
  (the UI shows npub-short); the push check is a string comparison, so
  such a pod user and the matching keyholder would share the namespace —
  noted rather than papered over, because pod names are human-chosen and
  a 64-hex username is not an accident.

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
| `.../compare/<base>...[<owner>:]<ref>` | compare view: ahead/behind counts, the ahead commit list, the structured diff, an "Open pull request" button |
| `.../pulls?state=open\|merged\|closed&page=N` | PR list: three-state filter tabs — green open, purple merged, red closed |
| `.../pulls/<n>` | PR conversation: state banner (merged / closed / clean-with-merge-button / conflict list), thread, comment form |
| `.../pulls/<n>/commits`, `.../pulls/<n>/files` | GitHub-style sub-tabs: the ahead commits, the structured diff |
| `.../pulls/new?base=...&head=...` | new-PR form (from the compare page) |
| `<prefix>/<owner>/<name>.git/...` | git smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`) |
| `<prefix>/api/token` | POST: exchange any `getAgent` credential for a push token (see "Nostr agents") |
| `<prefix>/api/hosted/<hex>/<uuid>` | GET (public) / DELETE (author-only): a podless agent's hosted issue words |
| `<prefix>/xlogin.js` | the vendored xlogin widget, byte-identical, `application/javascript`, immutable cache |

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

Tier 3a (additive):

- `api/repos/<o>/<n>` gains `parent` (`"<owner>/<name>" | null` — fork
  lineage) and `forks` (count); list entries gain `parent`.
- `POST api/repos/<o>/<n>/fork` (authed; optional `{name}` override so
  you can fork your own repo under a new name) → 201
  `{ owner, name, parent, url, cloneUrl }`; 409 if the target exists.
- `GET .../compare/<base>...[<owner>:]<ref>` →
  `{ base: {ref, sha}, head: {owner, repo, ref, sha}, aheadBy, behindBy,
     mergeBase, hasMore, commits, files }` (same commit/diff shapes as
  above — one parser, every surface).
- `GET .../pulls?state=open|merged|closed&page=N` →
  `{ state, page, perPage, hasMore, openCount, mergedCount, closedCount,
     pulls: [{ number, title, state, author, authorInfo, createdAt, base,
       head: {owner, repo, ref}, merged, comments }] }`
- `GET .../pulls/<n>` → the list fields plus `baseSha` (the CAS token the
  UI hands back at merge time), `head.sha`, `mergeable` (`true|false|null`
  — null when an end is gone or merge-tree is unavailable), `conflicts`
  (paths, from merge-tree), `merged` (`{sha, mergedBy, at, baseSha,
  headSha, fastForward} | null`) and the resolved `thread` (issues shape
  verbatim).
- `POST .../pulls` `{title, body, base, head}` → 201
  `{ number, url, resourceUrl, hosted? }` — body stored in the author's
  pod (or forge-hosted for podless agents), exactly like issues. 422 when
  the head is unresolvable or there are no commits between base and head.
- `POST .../pulls/<n>/comments` `{body}`, `POST .../pulls/<n>/close` /
  `.../reopen` — the issues beats (owner or PR author; merged is final,
  422).
- `POST .../pulls/<n>/merge` `{expectedBase?}` (TARGET repo owner only) →
  200 `{ number, state: 'merged', sha, fastForward }`; 409
  `{ error: 'merge conflict', conflicts }` or 409 when the base moved
  (stale `expectedBase`, or a race caught by update-ref's old-value
  guard); 501 naming the git version when `merge-tree --write-tree` is
  missing (needs git ≥ 2.38).

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
     issues: [{ number, title, state, author, authorInfo, createdAt, comments }] }`
- `GET api/repos/<o>/<n>/issues/<num>` →
  `{ number, title, state, author, authorInfo, createdAt, thread: [{ author,
     authorInfo, at, resourceUrl, hosted, body|null, removed, html|null }] }`
  — `html` is the server-side markdown renderer's already-escaped output;
  `body` is the raw markdown straight from the pod (JSON is the escape);
  `removed` is true when the author has deleted the pod (or hosted)
  resource. **Additive since 2.5**: `authorInfo` is
  `{ id, displayName, npub?, kind: 'webid'|'nostr' }` (`id` is the
  canonical agent string — a WebID or `did:nostr:<hex>`; `npub` only for
  nostr authors, display-only), and `hosted` is true when the entry's
  words are forge-hosted rather than pod-stored. `author` strings are
  unchanged, so pre-2.5 consumers keep working.
- `POST api/repos/<o>/<n>/issues` `{title, body}` → 201
  `{ number, url, resourceUrl, hosted? }` (auth required)
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

## Forks & pull requests (tier 3a)

The flow: **fork** (`POST api/repos/<o>/<n>/fork`) runs `git clone
--local --bare` into the caller's namespace — same repo name, 409 on
collision, optional `{name}` override (that's how you fork your *own*
repo, which GitHub also allows; a same-name self-fork would always
collide). Lineage is recorded in the fork's bare-repo config
(`forge.parent = <o>/<n>`); the fork's home and the repo lists show
"forked from …", the parent shows a fork count, and a freshly pushed
non-default branch on a fork earns an "open a pull request?" hint.
**Compare** (`/compare/<base>...<head>`) takes a ref of THIS repo as
base and either a same-repo ref or `<owner>:<ref>` as head. The fork
rule is deliberately simple and name-based: *the head owner's repo with
the same name* — lineage chains are not chased. Cross-repo heads are
fetched **by filesystem path** (both ends forge-owned, never a
user-supplied URL) into a hidden, reusable ref in the base repo
(`refs/forge/heads/<owner>/<ref>`, force-updated per call — repeat
compares refresh it, nothing to clean up). A **pull request** is the
issues architecture verbatim: the body/comments live in their authors'
pods (or forge-hosted for podless nostr agents), the spine lives in
`pluginDir/pulls/<owner>/<repo>.json` with the same atomic-write +
per-repo-lock discipline, plus base ref, head `{owner, repo, ref}` and
merge info.

**Merge semantics — real git, bare-repo safe.** The target repos are
bare, so nothing ever checks out a worktree:

1. head objects are path-fetched into the base repo (as in compare);
2. `git merge-tree --write-tree` (git ≥ 2.38 — probed at activate; the
   merge route answers **501 naming the installed version** when it's
   missing) computes the merged tree, or reports the conflicted paths,
   which the PR page renders as a GitHub-style "this branch has
   conflicts" banner (merge button withheld, PR stays open, the API says
   409 + `conflicts`);
3. a clean tree is committed with `git commit-tree` — **two parents,
   honest authorship**: author = the merging agent's display id with a
   synthesized `<owner>@forge.invalid` email, committer = `forge`,
   message `Merge pull request #N from <owner>:<ref>`;
4. `git update-ref refs/heads/<base> <new> <old>` lands it with an
   **old-value guard — the compare-and-swap**. The PR page pins the base
   sha it rendered (`baseSha` in the detail JSON, `expectedBase` in the
   merge POST); if the base moved since the diff the merger saw, the
   route answers 409 before touching anything, and even a race between
   the route's own read and the ref write is caught by update-ref
   itself.

**ff-when-possible policy**: when the base is an ancestor of the head,
the merge is a plain compare-and-swapped `update-ref` — no synthetic
merge commit — recorded as merged with `fastForward: true` and the head
sha as the merge sha. (GitHub's default always creates a merge commit;
this forge prefers not to invent history where none is needed. The
Commits/Files tabs of a merged PR stay exact either way: the shas are
frozen in the merge record.)

**Separate numbering, documented deviation**: GitHub numbers issues and
PRs from one shared counter; here `pulls/<owner>/<repo>.json` numbers
independently of the issues index. Sharing would entangle every PR
write with the issues index (one more lock, one more file rewritten,
crossed failure modes) for no user value in a personal forge — `#N` is
unambiguous because issues and pulls live under different routes.

Auth: fork needs any authenticated agent (it writes to the CALLER's
namespace); PR create/comment need an authenticated agent with
somewhere to keep the words (pod or hosted); close/reopen are for the
target repo owner or the PR author; **merge is target repo owner
only**. Anonymous writes are 401, everything else 403 — house rules.

## Nostr agents (tier 2.5)

### Identity model — hex canonical, npub display-only

Per [did-nostr.com](https://did-nostr.com), the canonical nostr identity
is `did:nostr:<64-char-lowercase-hex-pubkey>` — **exactly the string
`getAgent` returns** when a NIP-98 signature verifies and no WebID
mapping exists. The forge keys everything on it:

- **namespace / storage paths / index keys / API `id` fields: hex.**
  A nostr agent's repos live at `<prefix>/<hex>/<name>.git`; hosted
  content under `pluginDir/hosted/<hex>/`.
- **UI rendering: shortened npub** (`npub1abcd…wxyz`), produced by a
  ~30-line pure-node bech32 (BIP-173, full checksum) encoder, unit-tested
  against the canonical NIP-19 vector
  (`3bf0c63f…459d` → `npub180cvv07…jh6w6`). Raw hex is never rendered as
  a display name.
- **Author links** point at core's did:nostr DID-document route,
  `/.well-known/did/nostr/<hex>` (`src/idp/well-known-did-nostr.js` —
  real in the published server; it 404s for keys with no local account
  linkage, which is honest: there is no doc to show).

### NIP-98 → push-token exchange

git's static `http.extraHeader` cannot carry NIP-98 for a push: each
kind-27235 event signs one `u` (url) + `method` pair, and a push is at
least `GET …/info/refs` + `POST …/git-receive-pack` (Finding 9). So the
flow is one exchange:

```
POST <prefix>/api/token[?ttl=seconds]
  Authorization: <anything getAgent accepts — NIP-98 included>
→ 201 { token: "f1.…", tokenType: "Bearer", agent, iat, exp }
```

The token is macaroon-lite (capability/'s pattern): `f1.<base64url
payload>.<base64url HMAC-SHA256>`, payload `{ v:1, agent, iat, exp }`,
secret in `pluginDir/token-secret`. Scope is `{agent, ttl}` with
`ttl = config.pushTokenTtl ?? 3600` (a `?ttl=` override is capped at 30
days; non-positive values mint an already-expired token — used by the
tests). The forge accepts it wherever it authenticates — the git lane
first, then every core scheme via `getAgent`. A forge token cannot mint
another forge token (no self-refresh). WebID users don't need it (the
pod bearer works in `extraHeader` as before) but may use it.

Copy-paste client flow using the [`nip98`](https://www.npmjs.com/package/nip98)
npm lib's `getToken` for the exchange request (docs only — the forge
itself has no npm dependencies):

```js
import { getToken } from 'nip98';

const url = 'http://localhost:3000/forge/api/token';
const auth = await getToken(url, 'POST', (e) => window.nostr.signEvent(e), true);
const { token } = await (await fetch(url, { method: 'POST', headers: { authorization: auth } })).json();
// pubkey-hex namespace: your pubkey IS your owner segment
```

```sh
git -c http.extraHeader="Authorization: Bearer $TOKEN" \
    push http://localhost:3000/forge/<pubkey-hex>/myrepo.git main
```

### Hosted content — the podless-agent asymmetry

A did:nostr agent can authenticate and own a namespace, **but has no pod
of its own to keep its words in** — the tier-2 loopback-PUT beat has
nowhere to land. So nostr-authored issue/comment bodies are stored under
`pluginDir/hosted/<hex>/<uuid>.json`, thread pointers carry
`{hosted: true}`, the JSON API says so, and the UI renders a muted
*"hosted by the forge"* tag on those entries (pod-stored ones stay
pure). The author keeps the deletion beat: `DELETE
<prefix>/api/hosted/<hex>/<uuid>` (same did:nostr identity, verified by
NIP-98 or a forge token) removes the words and the thread renders the
same *"content removed by its author"* placeholder as a pod delete.
Anyone else gets 403. This asymmetry **is** the `api.podOf(agent)` /
pods-for-keys ask — see Finding 10.

## xlogin (the vendored login widget)

`forge/xlogin.js` is [xlogin](https://github.com/melvincarvalho/xlogin)
0.0.15, vendored **verbatim** (AGPL, attribution header only — AGENT.md's
pattern) and served byte-identical at `<prefix>/xlogin.js` with an
immutable cache header. Issues pages load it via `<script src>`; if
`window.xlogin` initialises, the auth area shows a **Sign in with
xlogin** button beside the local username/password box (the fallback
tab), and all API writes go through `window.xlogin.authFetch` — NIP-98
for nostr sessions, DPoP for Solid sessions, both verified server-side
by the same `getAgent` the rest of the forge uses.

What works locally vs. what CSP blocks (deliberately):

- **Works**: the widget itself (`script-src 'self'`), its crypto — with
  the caveat below — client-side NIP-98 signing, and every same-origin
  `authFetch` (`connect-src 'self'`). Logging in with a same-origin
  Solid IdP (the widget's first provider button is
  `window.location.origin`) also works.
- **Caveat, eyes open**: xlogin 0.0.15 dynamically `import()`s
  `@noble/secp256k1`, `nip98` and `solid-oidc` from `https://esm.sh` —
  and dynamic `import()` is governed by **script-src**, not connect-src.
  The page CSP therefore admits `script-src https://esm.sh`, the one
  external origin, or the widget would render a button that can do
  nothing (Finding 11).
- **Blocked and NOTED, not opened**: login against an **external**
  Solid IdP needs `connect-src` to that IdP (OIDC discovery + token
  fetches). The default CSP keeps `connect-src 'self'`, so external-IdP
  login fails in the browser console rather than the forge opening
  connect-src wide. Operators who want it opt in explicitly:
  `config.cspConnect: ['https://solidcommunity.net', …]`.

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
- **No search, no webhooks** — later tiers (see Findings 3). Issues
  arrived in tier 2; PRs arrived in tier 3a with the same pod-native
  treatment (bodies in pods, spine in pluginDir).
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
  heuristic. Tier 2.5 gave did:nostr agents a namespace (their hex
  pubkey) so they *can* push now, but the mapping is still forge
  convention; an `api.podOf(agent)` seam would make ownership honest —
  and Finding 10 shows the same seam is what hosted content is standing
  in for.

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

### 9. git cannot sign per-request NIP-98 — and core's leniencies show it knows

A NIP-98 event binds ONE `u` (url) + `method`; a push is at least an
`info/refs` GET and a `git-receive-pack` POST with different URLs and
methods, and `http.extraHeader` is static for the whole operation — so
"just put a NIP-98 header on git" is structurally impossible. Reading
`src/auth/nostr.js` shows core already fights this with git-mode
leniencies: it accepts NIP-98 smuggled inside `Basic base64("nostr:" +
token)` (git credential helpers), allows `method: "*"`, and allows the
event's `u` to be a PREFIX of the request URL — which means a
pre-signed base-URL event could ride a whole push, but only inside the
±60 s `created_at` window, and only by weakening exactly the bindings
NIP-98 exists to make. The forge's answer is the honest one: a single
`POST api/token` exchange (NIP-98-authenticated, per-request-correct)
for a bearer whose TTL is a real, chosen number instead of 60 seconds
of accidental slack. The exchange endpoint deliberately refuses to
accept its own tokens as the minting credential.

### 10. The podless-agent asymmetry IS the api.podOf ask

Tier 2's proudest property — words live in the author's pod under the
author's WAC — simply has no home for a did:nostr agent: the key can
authenticate (getAgent says so), can own a namespace, but owns no
storage on this host. The forge hosts those bodies itself
(`pluginDir/hosted/<hex>/`), marks them `hosted: true`, renders the tag,
and gives the author the same delete beat — but the asymmetry is now
visible in every thread: pod users' words are their property under
their ACLs; key users' words are the forge's tenant data. The seam this
begs for is `api.podOf(agent)` / pods-for-keys: if core could answer
"where does this agent keep things?" (or provision key-addressed
storage), hosted content would collapse back into the tier-2 path and
the `hosted` flag would disappear. Until then the forge is honest about
being a landlord for the podless.

### 11. Dynamic import() is script-src, not connect-src — the widget's CDN coupling is CSP-visible

The plan said "extend connect-src for whatever xlogin's NOSTR flows
need locally" — measuring showed the flows need no connect-src at all
(signing is client-side; the fetches are same-origin) but DO need
`script-src https://esm.sh`, because xlogin 0.0.15 hard-codes dynamic
`import()`s of its crypto from esm.sh and CSP governs module loads with
script-src. That's the whole CSP delta: one external script origin,
taken knowingly; connect-src stays `'self'` so external Solid-IdP login
is blocked-and-documented rather than silently allowed
(`config.cspConnect` is the operator's opt-in). The plugin-shaped fix
is upstream: a self-contained xlogin build would let script-src drop to
`'self'` — worth filing against xlogin rather than working around here.

### 12. NIP-98 verification gotchas, measured against auth.js

What the host verifier (`src/auth/nostr.js`) actually demands, found by
signing real events in the tests:

- **URL exactness is Host exactness.** `u` must equal
  `<proto>://<Host header><request.url>` (x-forwarded-* honored,
  trailing-slash normalized, query droppable). Sign for `localhost` and
  push to `127.0.0.1` and you 401 — the same Host-sensitivity already
  written down in NOTES.md for loopback WebID checks now applies to
  every NIP-98 client. The tests only pass because helpers.js uses
  `127.0.0.1` on both sides.
- **`created_at` window is ±60 s** — clock skew between a signing
  device and the server is a real 401 source; the push-token exchange
  also conveniently narrows NIP-98 to one instant per session.
- **`payload` tags need the wire bytes.** The verifier hashes
  `request.rawBody` (captured by core's JSON parser) — but this
  plugin's scope replaces the content parser with a raw pass-through
  stream for the git CGI lane, so at getAgent time the body was an
  unread stream and any body-carrying NIP-98 request (e.g. xlogin's
  authFetch POSTing an issue) would fail its payload check. The fix:
  API writes buffer the body FIRST, stash the exact wire string on
  `request.rawBody`, and only then authenticate. Order of operations
  as a correctness bug — invisible until the first signed-body client.
- **Unmapped keys cost an outbound fetch.** For a pubkey with no local
  WebID linkage, verification falls through profile → local index →
  an EXTERNAL did:nostr resolver (`nostr.social`, 5 s timeout, 60 s
  failure cache) before returning `did:nostr:<hex>` — a network
  round-trip on the auth hot path that the agent cannot opt out of.
  One more reason the token exchange is the right shape: it pays that
  cost once per TTL, not per request.

### 13. merge-tree --write-tree is the whole trick — and its availability is a real precondition

Everything GitHub does with a merge queue and a worktree farm, a bare
repo can do with three plumbing commands: `merge-tree --write-tree`
(compute the merged tree OR the conflicted paths, no worktree),
`commit-tree -p A -p B` (make the two-parent commit), `update-ref
<ref> <new> <old>` (land it atomically with a compare-and-swap). But
`merge-tree --write-tree` only exists since git 2.38 (2022); on older
gits there is NO bare-safe conflict-aware merge without a scratch
clone. The forge probes `git --version` at activate and the merge route
answers 501 naming the installed version rather than pretending — the
dev machine's git 2.53.0 is fine, and the conflict output's
`--name-only` section parses cleanly into the banner's path list. One
sharp edge found while parsing: merge-tree signals conflicts via **exit
code 1**, so the child-process wrapper must treat exit 1 + stdout as
data, not as failure.

### 14. protocol.file.allow was NOT needed — direct path fetches still count as user-initiated

The CVE-2022-39253 hardening (git ≥ 2.38.1) demoted `protocol.file.allow`
to `user`, which kills `file://`/local-path transports **when triggered
indirectly** (submodule clones). The forge's cross-repo fetches
(`git -C <base> fetch <abs-path-to-head> +refs/heads/x:refs/forge/...`)
are direct top-level invocations, which the `user` default still
permits — measured on git 2.53.0: no `-c protocol.file.allow=always`
override was required. Written down because it is one hardening release
away from mattering: if a future git demotes direct local fetches too,
the per-invocation override is the correct, bounded fix — both ends are
forge-owned paths under pluginDir, no user-supplied URLs ever reach the
fetch argv (owner/name/ref are strictly validated first).

### 15. Hidden refs are visible refs: refs/forge/* rides the wire, harmlessly

The reusable compare refs (`refs/forge/heads/<owner>/<ref>`) live
outside refs/heads and refs/tags, so no UI surface lists them — but
`git ls-remote` shows them and a fetching client may copy them, because
upload-pack advertises everything. That is accepted, not accidental:
the objects they pin are exactly the fork branches a compare or PR
already published, so nothing leaks; the cost is advertisement noise
proportional to compared branches. The alternative (fetch into a
temp ref + delete) re-downloads objects on every compare AND still
leaves the objects in the odb until gc. If it ever grates,
`uploadpack.hideRefs=refs/forge` per repo is the one-line cure.
