# forge — a personal git forge (tier 1: hosting + browsing; tier 2: issues; tier 2.5: nostr agents + xlogin; tier 3a: forks + pull requests; polish: labels, search, releases; tier 3.5: Bitcoin-anchored history via Blocktrails)

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
compare-and-swap `update-ref` — see "Forks & pull requests"). The polish
wave adds **labels** on issues and PRs (GitHub's default set, colored
chips, `?label=` filters), **read-time search** (repo-list filter +
in-repo `git grep`, bounded, no index), **releases** (every tag with
streamed tar.gz/zip archives), and hides the internal compare refs from
`ls-remote` (closing Finding 15). Tier 3.5 adds **git-mark anchoring via
[Blocktrails](https://blocktrails.org)** — Bitcoin(testnet)-anchored,
tamper-evident repo history: every default-branch tip derives a fresh
taproot address; spending the previous mark's output to the new address
IS the advance; the forge only **derives and records** (see "Anchors").
Zero build step, no framework: every page is server-rendered HTML with
inline CSS, all git work is done by the system `git` binary, and the
wire protocol is delegated to the stock `git-http-backend` CGI
(gitscratch's proven plumbing, re-rooted). One npm dependency —
`@noble/curves`, the host's own crypto library — arrived with tier 3.5
for the secp256k1 point math (the `blocktrails` npm package is
deliberately **not** imported: the spec math is implemented locally and
cross-checked in test.js against a vector generated from the
maintainer's reference implementation).

```js
plugins: [{ id: 'forge', module: 'forge/plugin.js', prefix: '/forge',
            config: {
              privateRepos: false,      // true: ALL reads become owner-only
              gitHttpBackend: '/usr/lib/git-core/git-http-backend', // optional
              pushTokenTtl: 3600,       // default lifetime of exchanged push tokens (s)
              cspConnect: [],           // extra connect-src origins (e.g. external Solid IdPs)
              chain: 'tbtc4',           // anchoring chain (testnet4); 'btc' is REFUSED …
              allowMainnet: false,      // … unless this is explicitly true (see Finding 18)
              announceRelays: [],       // NIP-34 relays (opt-in); empty => emission OFF
              announceKey: undefined,   // optional 32-byte hex nostr privkey; else generated once
              openEdit: false,          // DEMO ONLY: anonymous web edits (see caveat below) — never a default
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
| `.../issues?state=open\|closed&label=<name>&page=N` | issue list: GitHub-style filter tabs, label chips, green open / purple closed icons, relative times, comment counts |
| `.../search?q=<text>` | read-time code search over the DEFAULT branch: `git grep` hits (path:line + escaped excerpt) plus matching file paths — bounded, no index |
| `.../releases` | every tag, newest first: annotated-tag message, commit link, tar.gz + zip download buttons (linked from the Tags tab) |
| `.../archive/<ref>.tar.gz`, `.../archive/<ref>.zip` | `git archive` streamed (attachment, `--prefix=<repo>-<ref>/`); unresolvable refs are 404 |
| `.../issues/<n>` | thread: issue body then comments in comment boxes (identicon, author → WebID link, relative time, `owner` badge), markdown bodies |
| `.../issues/new` | new-issue form (vanilla-JS client, see below) |
| `.../compare/<base>...[<owner>:]<ref>` | compare view: ahead/behind counts, the ahead commit list, the structured diff, an "Open pull request" button |
| `.../pulls?state=open\|merged\|closed&label=<name>&page=N` | PR list: three-state filter tabs — green open, purple merged, red closed — plus label chips |
| `.../pulls/<n>` | PR conversation: state banner (merged / closed / clean-with-merge-button / conflict list), thread, comment form |
| `.../pulls/<n>/commits`, `.../pulls/<n>/files` | GitHub-style sub-tabs: the ahead commits, the structured diff |
| `.../pulls/new?base=...&head=...` | new-PR form (from the compare page) |
| `.../marks` | Anchors: the mark table (commit, state hash, derived tb1p… address, pending/marked chips, mempool.space tx links), chain badge, "Verify independently" hand-off, fund-this-mark box; the Enable pitch when anchoring is off |
| `.../blocktrails.json` | the verifier-compatible trail document — the ONE CORS-open (`Access-Control-Allow-Origin: *`) route |
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
- `POST .../edit` `{path, content, message?, branch?}` (owner-signed;
  `config.openEdit` relaxes to anonymous DEMO) → 200 `{ ok, commit,
  changed, url? }`; 400 (bad path / non-string content), 413 (over the
  1 MiB cap), 401/403 (auth), 404 (no repo), 500 (git failure). CORS-open
  with an `OPTIONS` preflight — see **Web edit** below.
- `POST .../preview` `{path, content, branch?}` (same auth as `/edit`) — the
  **unstaged** tier: publishes a NIP-01 ephemeral event (kind 21617) with the
  file content, making NO commit and writing nothing. → 200 `{ ok, published,
  kind, id, path, relays }`, or `{ ok, published:false }` with no relays
  configured. Only currently-connected subscribers see it; relays don't store
  it. Same 400/401/403/413 surface as `/edit`. CORS-open + preflight.

Polish wave (additive):

- Issue/pull list entries and details gain `labels:
  [{ name, color }]` (resolved against the repo's label set; empty array
  when unlabeled — pre-polish consumers keep working).
- `GET api/repos/<o>/<n>/labels` → `{ labels: [{ name, color }] }` —
  GitHub's default set (`bug` #d73a4a, `enhancement` #a2eeef,
  `documentation` #0075ca, `question` #d876e3, `wontfix` #ffffff) until
  the first label write materializes it into the repo's index.
- `POST .../labels` `{name, color}` (OWNER only; color = 6 hex digits,
  name 1–50 printable chars) → 201 `{ name, color }`; 409 on a
  (case-insensitive) duplicate.
- `PATCH .../labels/<name>` `{name?, color?}` (owner) → `{ name, color }`
  — a rename cascades onto every issue and pull carrying it.
- `DELETE .../labels/<name>` (owner) → `{ name, deleted: true }` — the
  label falls off every issue and pull (items store names, so a recolor
  needs no cascade at all).
- `PUT .../issues/<n>/labels` / `PUT .../pulls/<n>/labels`
  `{labels: [names]}` (repo owner or the item's author) → `{ number,
  labels }` — replaces the item's set; unknown names are 422 (max 20).
- `GET .../issues?label=<name>` / `GET .../pulls?label=<name>` — filters,
  composing with `state`.
- `GET .../search?q=<text>` →
  `{ q, ref, paths: [...], matches: [{ path, line, text }], truncated }`
  — read-time grep of the default branch (see "Search"); 422 without `q`.
- `GET .../releases` →
  `{ releases: [{ tag, sha, at, annotated, message, tarball, zipball }] }`
  — every tag, newest first; `message` is the first line of an annotated
  tag's message, `null` for lightweight tags; `sha` is the peeled commit.

Tier 3.5 (additive):

- `GET api/repos/<o>/<n>/marks` → `{ enabled: false, chain }` or
  `{ enabled: true, chain, pubkeyBase, marks: [{ index,
     state: {commit, repo, branch}, stateHash, program, address, status:
     'pending'|'marked', at, txid?, vout?, amount?, markedAt? }] }` —
  never the trail privkey (test-proven).
- `POST .../marks/enable` (OWNER only) → 201 `{ enabled, chain,
  pubkeyBase, mark }` — genesis: mints the trail key and derives mark 0
  from the current default-branch tip; 422 on an empty repo, 409 when
  already enabled (no silent key rotation).
- `POST .../marks/<i>/txo` `{txid, vout, amount}` (OWNER only) →
  `{ index, status: 'marked', txid, vout, amount }` — records where the
  mark landed on-chain. Shape-validated (64-hex txid, integer vout,
  positive integer sats) and **recorded, never verified** — the server
  does no chain I/O. 409 out of order (the trail is a linear spend
  chain), 409 when already marked.
- `GET <prefix>/<o>/<n>/blocktrails.json` → the verifier document (see
  "Anchors"); 404 (still CORS-readable) when anchoring is off.

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
- drives new-issue/comment/close/reopen through `fetch` + Bearer (or
  `xlogin.authFetch` for nostr/Solid) against the JSON API, then
  **reloads — the server always renders the truth**;
- for a **Solid (DPoP) login**, first `authFetch`-PUTs the body into the
  author's own pod (a fresh per-request proof the server could never
  forward) and posts the forge only the `resourceUrl` pointer — Finding
  21, the capstone; nostr and plain-Bearer keep posting `{title, body}`;
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

## Labels (polish)

The per-repo label SET lives in the repo's issues index file
(`idx.labels`); until the first label write, GitHub's default five apply
(and are what `GET .../labels` serves), so every repo has useful labels
with zero setup. Items — issues AND pull requests — store label **names**
only: a recolor is one index write with no cascade, while rename/delete
cascade over both the issues and pulls indexes under their locks. Chips
render GitHub-style (rounded-full, background = the label color,
black-ish/white text picked by perceptual luminance, hairline border so
`wontfix`'s white survives). Authorization is two-level, matching the
close/reopen beat: the label set is the OWNER's (CRUD), a given item's
labels are settable by the owner **or that item's author**.

## Search (polish)

Deliberately **read-time only — nothing is indexed**:

- The repo list (`<prefix>/?q=`) is a plain GET form (no JS): a
  case-insensitive substring filter over `owner/name` and description of
  the (already capped at 200) repo cards.
- In-repo (`.../search?q=`, HTML + api): one `git ls-tree -r --name-only`
  pass for path matches plus one `git grep -I -n -i -F` over the
  **default branch** — `-F` means literal substring (no regex
  injection), `-I` skips binaries, `-i` case-insensitive. Bounds, all
  hard: 256-char query, 100 grep hits, 100 path matches, 5 hits per file
  (`--max-count`, git ≥ 2.38 — the same floor merge-tree already probes;
  on older gits the per-file bound drops and the total cap still holds),
  200-char excerpts, escaped like everything else. The documented cost:
  O(repo) work per query, which is the right trade at personal-forge
  scale; an index would be cache-invalidation machinery the plugin api
  cannot power yet (Finding 5's family).

## Releases (polish)

`.../releases` lists **every tag, newest first** (`for-each-ref
--sort=-creatordate`) — annotated tags show the first line of their tag
message, lightweight tags are marked as such — each with tar.gz and zip
download buttons. `.../archive/<ref>.tar.gz|.zip` runs `git archive
--format=… --prefix=<repo>-<ref>/ <ref>` and **streams the child's
stdout** to the response (attachment disposition, no buffering); the ref
is validated (`okRef`/sha) and resolved with `rev-parse` *before* any
header goes out, so a bogus ref is a clean 404. Any resolvable ref works
— tags, branches, shas — which is exactly GitHub's archive behavior.

## Web edit (tier 3.7): commit one file over HTTP

`POST <prefix>/api/repos/<owner>/<name>/edit` is the **GitHub-web-editor
equivalent**: a browser edits one file and the change lands as a real
commit, then rides the forge's existing NIP-34 emission out to relays. No
server-side index surgery — the commit is made in a **disposable local
clone** and pushed back to the bare repo.

Body (`application/json`): `{ path, content, message?, branch? }`.

- **`path`** — repo-relative, validated hard: a non-empty string ≤ 1024
  chars, no leading `/`, no `..`, no backslash, no control chars; every
  `/`-separated segment matches `[A-Za-z0-9._-]+`; a `.git` segment is
  refused anywhere and a **leading-dot file at the repo root** (`.acl`,
  `.htaccess`, …) is refused to avoid surprises. Anything else → **400**.
- **`content`** — a string, capped at **1 MiB**; over the cap → **413**
  (a wildly oversized wire body is a **400** — the reader caps it before
  parse).
- **`message`** — optional; control chars stripped, capped at 1000 chars;
  defaults to `web edit: <path>`.
- **`branch`** — optional (`REF_RE`, no `..`); defaults to the repo's
  default branch (`symbolic-ref`). A branch that does not exist yet is
  created off the current HEAD.

**Auth — owner-signed by default (the principled mode).** Resolve the
agent (any scheme the git lane accepts, NIP-98 included), map it to a
namespace, and require it equals `<owner>`: anonymous → **401**, wrong
owner → **403** — the same gate as marks/enable and announce. The
principled browser upgrade is a **NIP-07 / browser-signature** path (sign
a NIP-98 event in the page, or exchange one for a push token at
`POST <prefix>/api/token`) so the edit carries the editor's own identity.

**`config.openEdit: true` relaxes this to anonymous edits (DEMO ONLY).**
It is **never a default**; the plugin logs a one-time loud warning at
activate when it is on. ⚠️ **Spam/abuse caveat:** with `openEdit` on,
*anyone on the internet can rewrite any file in any repo on the
instance* — reserve it for **throwaway testnet-demo repos** you are happy
to see vandalized, never a real forge. There is no rate limit and no
per-file authorization; the honest posture is owner-signed.

Behavior & responses (all CORS-readable — the demo page is cross-origin,
so success **and** error replies carry `Access-Control-Allow-Origin: *`
and an `OPTIONS` preflight is answered):

- Unknown repo → **404**.
- Identical content → **no commit** is made: `200 { ok:true,
  commit:<currentHead>, changed:false }` (`git diff --cached --quiet`
  decides — no empty commits).
- A real change → clone → `checkout <branch>` → write (parents made) →
  `git add` → `git -c user.name='forge web edit' -c
  user.email=forge@forge.invalid commit` → `git push <bare>
  HEAD:refs/heads/<branch>` → `200 { ok:true, commit:<full sha>,
  changed:true, url:<repo web url> }`. The author of record is the
  authenticated agent (or `anonymous` in demo mode); the committer is the
  forge. The temp clone is always removed (`finally`).
- Git failure → **500** with a generic message (the tmp path and raw git
  stderr are never leaked).

Because the push moves the tip, a web edit triggers the **same
downstream beats as a `git push`**: any Blocktrails anchor advances
(`recordTip`) and the NIP-34 **30617 + 30618** go out
(`announceRepoSafe`, fire-and-forget, a no-op with no relays). Every git
spawn runs hermetic — `GIT_CONFIG_NOSYSTEM=1`, no `HOME`, `execFile`
(never a shell).

## Anchors (tier 3.5): git-mark anchoring via Blocktrails

**The design stance, absolute: the server derives and records; it NEVER
touches the network.** All trail math is pure `@noble/curves` +
`node:crypto`; Bitcoin appears only as derived bech32m addresses,
mempool.space **links** in HTML (the user clicks), the served
`blocktrails.json`, and README instructions for the maintainer's own
CLIs (`fund-agent`, `git mark`) which do the funding/broadcasting
elsewhere. No fetch to any chain API from the plugin, ever (Finding 19).

**The derivation** (blocktrails spec v0.2, normative — implemented from
the spec, not imported):

```
state      = { commit, repo, branch }              one per default-branch tip
h          = sha256(JSON.stringify(state))         the git-mark-demo state-hash convention
tᵢ         = tagged_hash("TapTweak", x_only(Pᵢ₋₁) || h) mod n     BIP-341 TapTweak
Pᵢ         = Pᵢ₋₁ + tᵢ·G                           chained; P₋₁ = the trail base key
address    = bech32m(hrp, 1, x_only(Pᵢ))           tb1p… on testnet4
```

Each state derives a **new** address by tweaking; **spending the
previous mark's UTXO to the new address IS the advance** — a linear,
Bitcoin-ordered chain of commitments. The plugin derives and records
addresses and the expected chain; the transactions happen outside.

**The lifecycle**:

1. **Enable** (`POST .../marks/enable`, owner): mints a fresh trail key
   (forge-held, 0600 in `pluginDir/marks/<owner>/<repo>.json` — the
   custody trade-off is Finding 18) and derives mark 0 from the CURRENT
   default-branch tip.
2. **Advance on tip change**: when `git-receive-pack` completes on an
   anchoring-enabled repo (the CGI child's exit is the post-receive
   moment — Finding 17), or a PR merge lands via `update-ref`, one
   `recordTip` helper compares the default-branch tip to the last mark
   and appends a new **pending** mark. Multiple pushes stack pending
   marks honestly — each mark is one state; only funded/spent marks ever
   become `marked`. Non-default-branch pushes never advance
   (test-proven). 500-mark cap per trail.
3. **Fund/spend off-server**: the marks page shows the first pending
   mark's address plus copy-paste `npx fund-agent "txo:tbtc4:…"` /
   `git mark advance` instructions per the maintainer's READMEs.
4. **Record** (`POST .../marks/<i>/txo`, owner): report `{txid, vout,
   amount}`; the mark flips to `marked`. Recorded in order — the trail
   is a linear spend chain. Shape-checked, never chain-checked.
5. **Verify independently**: the marks page hands off to the hosted
   verifier (`https://blocktrails.github.io/verify/?uri=<this repo's
   blocktrails.json>`), which fetches the trail document cross-origin
   and checks every mark against the chain **client-side** — tx exists,
   confirmed, amount matches, spends the previous mark. The server
   records claims; an independent client verifies them. That split is
   the architecture's point.

**`blocktrails.json`** is exactly the shape the zero-build verifier
consumes (`@type: Blocktrail`, `profile: gitmark`, `pubkeyBase`,
`chain`, `states[]` = the marked commits, `txo[]` =
`txo:<chain>:<txid>:<vout>?amount=…&commit=…&pubkey=…` URIs), plus
additive self-description (`derivation`, `stateHash`, and the full
`marks[]` list including pendings). It is served with
`Access-Control-Allow-Origin: *` — a deliberate one-route CORS grant:
the document is a public verification artifact whose entire purpose is
to be fetched cross-origin by a verifier page; everything in it is
already public on the marks page, so CORS widens reach, not exposure.
(The hosted-verifier hand-off is a plain `<a href>` navigation, which
CSP's `connect-src 'self'` does not govern — no CSP delta needed.)

**Testnet-only defaults**: `chain: 'tbtc4'` (testnet4). Mainnet chain
identifiers (`btc`/`mainnet`/`bitcoin`) are **refused at activate** —
loudly, naming the stakes — unless `config.allowMainnet: true`; unknown
chains are refused too (no address is better than a wrong-network
address someone might fund).

## Nostr discovery (NIP-34)

A repo lives on **many** forges (mirrors); the Blocktrails mark (a
Bitcoin tx) is the **source of truth**; [NIP-34](https://github.com/nostr-protocol/nips/blob/master/34.md)
Nostr events are the **discovery + notification layer**. The Anchors
work above records the source of truth; this layer makes it *findable*
and **syncable to a precise commit**. The forge publishes two correlated
NIP-34 events, signed by the SAME stable per-instance key, to the
operator-configured relays:

- a **kind-30617 "repo announcement"** — the repo's name, description,
  clone/web **mirror URLs**, relay set, maintainers, and (when anchored)
  its Bitcoin anchor. [ngit](https://gitworkshop.dev/) (a kind-30617
  viewer) then shows the repo.
- a **kind-30618 "repo state"** — the repo's refs (`refs/heads/<branch> →
  <commit-sha>` + the symbolic `HEAD`), so a subscriber can sync to an
  exact commit. This is what enables **commit-precise sync**:
  [nostr-git-sync](https://github.com/) reads the `kind:30618` state and
  `git checkout <commit>` to the announced tip. Both events share the
  same `d` = `<owner>/<name>`, so a consumer correlates them.

### The announce identity

A stable per-instance Nostr key. `config.announceKey` (32-byte hex
privkey) wins if set; otherwise one is generated **once** and persisted
at `pluginDir/announce-key` (mode `0600`), so the forge keeps one
identity across restarts. Its `npub`-short is logged at boot. The
announce **pubkey** is the x-only 32-byte schnorr key (`event.pubkey`).

### Opt-in, never always-on

`config.announceRelays` is an array of `wss://` relay URLs. **Empty or
unset ⇒ emission is DISABLED** (a logged no-op) — relays are never
hardcoded always-on; the operator opts in. A reasonable ngit-compatible
set to opt into:

```js
announceRelays: [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]
```

### The kind-30617 event shape

`buildRepoEvent(owner, name)` returns a signed event (NIP-01: `id =
sha256` of the canonical `[0,pubkey,created_at,kind,tags,content]`
serialization, `sig =` schnorr over the `id`). Tags:

| tag | value | when |
|-----|-------|------|
| `d` | `<owner>/<name>` | always (the NIP-34 repo id) |
| `name` | `<name>` | always |
| `description` | first line of the repo `description`/README | always (also the `content`) |
| `web` | `<origin><prefix>/<owner>/<name>` | always (browse mirror URL) |
| `clone` | `<origin><prefix>/<owner>/<name>.git` | always (clone mirror URL) |
| `relays` | the configured relay URLs | when `announceRelays` set |
| `maintainers` | `<owner>` | nostr-owned repos (owner **is** the hex pubkey) |
| `r` | `<origin><prefix>/<owner>/<name>/blocktrails.json` | when anchored |
| `anchor` | `[<chain>, <genesis-txid>]` | when anchored |

The last two tie the discovery event back to the Bitcoin source of
truth: `r` hands a consumer the CORS-readable, verifier-compatible trail
doc, and the custom `anchor` tag carries the **chain + genesis txid** (a
marked mark 0 — marks are a linear spend chain, so a marked genesis is
the on-chain root). `created_at` is `Math.floor(Date.now()/1000)`
(normal plugin runtime).

### The kind-30618 event shape (repo state)

`buildStateEvent(owner, name)` returns a signed **kind-30618** event
(same NIP-01 id/sig helper, same announce key). It is a *replaceable*
event (NIP-33) keyed by the **same `d`** as the 30617, so a consumer
correlates the announcement with its state. It carries the repo's refs,
read straight from the bare repo (`symbolic-ref HEAD` for the default
branch, `for-each-ref refs/heads` for each head's full commit sha):

| tag | value | when |
|-----|-------|------|
| `d` | `<owner>/<name>` | always (same repo id as the 30617) |
| `refs/heads/<branch>` | `<full-commit-sha>` | one per local head (default branch first) |
| `HEAD` | `ref: refs/heads/<defaultBranch>` | always (the symbolic default) |
| `r` | `<origin><prefix>/<owner>/<name>/blocktrails.json` | when anchored |
| `anchor` | `[<chain>, <genesis-txid>]` | when anchored |

`content` is **empty** (per the state-event convention). Each
`refs/heads/<branch>` tag hands a subscriber a **precise commit** to
check out (nostr-git-sync's `kind:30618` → `git checkout <commit>`).
When the repo is anchored, the state event carries the SAME `anchor`
(chain + genesis txid) and `r` tags as the 30617 — so a subscriber can
**require Bitcoin-anchored state** (verify the txid on-chain) before
pulling the announced commit.

A tip change is announced by either **(a) anchoring** (a mark flipping to
`marked`) or **(b) calling the announce endpoint** — there is no
filesystem watcher (git over the forge is shadowed by core `--git` on the
live box, so pushes may not flow through the forge; the reliable triggers
are anchor + the manual endpoint).

### Publishing + triggers

`publishEvent(event)` opens a `ws` WebSocket to each relay, sends
`["EVENT", event]`, and waits (bounded ~5 s per relay) for the relay's
`["OK", <id>, true|false, …]`, returning `{relay, ok, error?}[]`. A
single relay failing never throws; the `ws` client is loaded lazily
(only when a publish actually happens), so activation never depends on
it and the no-relays path never touches it.

Every announce emits **both** events (30617 then 30618) to the relays.

- **Auto on anchor**: when a mark flips to `marked` (the `.../txo`
  handler), the forge fire-and-forgets an announcement **with** the
  anchor tags — the 30617 AND the 30618 (so the anchored state carries the
  Bitcoin txid) — the txo response never blocks on relays.
- **Manual**: `POST <prefix>/api/repos/<o>/<n>/announce` (owner-only,
  same auth as marks/labels) builds + publishes both and returns
  `{ published, event: {id, kind, tags} (30617), state: {id, kind, tags}
  (30618), relays: [{relay, ok}], stateRelays: [{relay, ok}] }`. With no
  relays configured it is a clear `200` no-op (`published: false`, both
  events still returned for inspection) so callers need no live relay.
- **Read-back**: `GET <prefix>/api/repos/<o>/<n>/nostr` returns the
  announce `pubkey`/`npub`, the relay set, and the freshly built signed
  `event` (30617) **and** `state` (30618) (also as `events: [30617,
  30618]`) — inspect the exact shapes, including the commit-precise refs,
  without a relay.

### Who signs — forge instance key, not the maintainer (a Finding)

The forge signs with its **own instance key**, not the maintainer's
nostr key. For a *mirror announcement* that is the honest claim — "this
instance hosts these clone URLs, anchored to this tx" — and it needs no
custody of the maintainer's key. The `maintainers` tag still names the
maintainer's pubkey (for nostr-owned repos the owner **is** that hex
pubkey), so a canonical **maintainer-signed** 30617 can supersede the
forge's mirror announcement in any viewer that prefers the maintainer.
This mirrors the anchoring custody posture (Finding 18): the
forge-instance key is a POC-grade signer for a discovery claim, and the
principled upgrade is the same one — the maintainer signs client-side
(NIP-07/xlogin) and the forge only relays. Until then, forge-signed
mirror announcements are a sound, clearly-scoped discovery layer.

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
  the client's same-origin fetches, nothing outbound — and
  `form-action 'self'` for the no-JS search forms (Finding 16).

## Deliberate cuts

- **No syntax highlighting** — that's where the old attempt's 1 MB
  bundle came from. A `<pre>` with line numbers covers tier-1 browsing;
  highlighting is a candidate for a later wave *if* it can be done
  server-side and dependency-free.
- **No search index, no webhooks** — search arrived in the polish wave
  as bounded read-time grep (see "Search"); webhooks still want
  `api.events` (see Findings 3). Issues arrived in tier 2; PRs arrived
  in tier 3a with the same pod-native treatment (bodies in pods, spine
  in pluginDir).
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

**Closed in the polish wave**: the one-line cure is applied —
`uploadpack.hideRefs=refs/forge/` is set in every repo's git config at
creation (materialize AND fork), and lazily on the first compare-fetch
for repos that predate it (a cheap config-file read skips the git spawn
once the line exists). Test-proven with a real `git ls-remote`: the
internal refs exist in the repo, and do not ride the wire.

### 16. CSP form-action 'none' blocks even a plain GET form

The search boxes are the no-JS ideal — `<form method="get">`, a text
input, the server filters — and they silently did nothing under the
tier-1 CSP, because `form-action 'none'` governs ALL form submissions,
navigation-only GET forms included (unlike `connect-src`, which only
sees script-initiated fetches). The delta is `form-action 'self'`: form
targets stay same-origin, which is exactly what the search forms need
and all they can reach. Worth writing down because the failure mode is
invisible — the page renders, the button clicks, nothing happens, and
only the browser console says why. Same lesson as Finding 8's
connect-src discovery: each new *kind* of page interactivity trips a
different CSP directive.

### 17. Core called git-mark post-receive "core, not a plugin" (#271) — the forge moved that line

Core's ISSUES.md argued a git-mark hook must live in core because only
core owns the receive path. The forge is the counter-witness: because
this plugin delegates the wire protocol to `git-http-backend` but OWNS
the CGI child, "receive finished, refs are final" is simply the child's
`close` event — a one-line `onExit` seam on the existing `runBackend`.
Both tip-movers route through one `recordTip` helper: receive-pack via
`onExit`, PR merges via a direct call after `update-ref` (they move the
tip without any receive-pack). `recordTip` re-checks everything under
the per-repo mark lock (compares the tip to the last mark's state), so
firing it on *any* child exit — even a partially failed push — is
correct rather than optimistic. What made it plugin-able wasn't a new
api seam; it was owning the receive path in the first place. The test
wrinkle: the hook fires after the response, so push-advance assertions
poll (the merge route, by contrast, awaits `recordTip` before
answering — the mark is in the response's happens-before).

### 18. Forge-held trail keys are testnet custody — real custody is the xlogin/NIP-07 path

Enabling anchoring mints the trail privkey server-side and keeps it in
`pluginDir/marks/<owner>/<repo>.json` (0600, never crossing an API
surface — test-proven against every marks route). That is CUSTODY: the
operator can read the key, and whoever holds the key controls all
future transitions and the funds in the head output (the spec's own
threat model). On testnet4 — the enforced default — the stakes are
demonstration sats, and the convenience (the forge can derive every
future address without a signing round-trip) is worth it. On mainnet it
would not be, which is exactly why `chain: 'btc'` is refused at
activate unless `allowMainnet` is explicit. The honest next step is
client-side keys: the owner's OWN key signs each advance in the browser
(xlogin already ships NIP-07/NIP-98 plumbing on these very pages), the
forge stores only `pubkeyBase` and derives addresses from public
material — the derivation needs no secrets, only the spend does. Then
the forge is purely a recorder and the custody Finding dissolves.

### 19. Derive-and-record vs. broadcast-and-verify: the SSRF-free anchoring architecture

The obvious design — server calls mempool.space to check funding, maybe
broadcasts too — makes the pod server an outbound HTTP client steered
by user-shaped data (SSRF surface, availability coupling, and a trusted
third party smuggled into the trust chain). The split here keeps the
server pure: it DERIVES addresses (local math) and RECORDS owner-shaped
claims (shape-validated JSON); funding and broadcasting happen in the
owner's own CLIs; verification happens in an independent, zero-build
client-side verifier that anyone can point at the served
`blocktrails.json`. The server never learns whether a claim is true —
and doesn't need to, because the verifier checks the actual chain and
the claims are cheap-talk until it does. One deliberate CORS grant
(`Access-Control-Allow-Origin: *` on `blocktrails.json` alone) is the
entire integration surface between the two halves. Bitcoin appears in
the plugin as: bech32m strings, `https://mempool.space/...` hrefs, and
instructions. `grep -c fetch` on the anchoring code: zero.

### 20. x-only parity in TapTweak land — and the maintainer's own CLI disagrees with the spec

Two real discoveries from implementing the derivation instead of
importing it:

- **Parity is an output-encoding concern, not a chain concern.** The
  spec keeps FULL points through the chain (`Pᵢ = Pᵢ₋₁ + tᵢ·G`, parity
  and all) and takes `x_only` twice per step: as the tweak input (the
  raw x of the possibly-odd-Y running point — NOT re-lifted to even-Y
  as BIP-341 wallet stacks do between steps) and at the output boundary
  (where `x(P) == x(−P)` makes comparison parity-free; only a SPENDER
  must negate per BIP-340, and this plugin never spends). Get the
  lift-x placement wrong and addresses diverge silently — which is why
  the test suite pins a vector generated by RUNNING the maintainer's
  reference implementation (`blocktrails` deriveChainedPublicKey +
  p2trXonly on fixed inputs; the mirror carries no hard-coded spec
  vectors, so the reference impl is the vector source), plus an
  independent bech32m decode round-trip. bech32 vs bech32m turned out
  to be ONE constant (`1` vs `0x2bc830a3`) over the same polymod — the
  tier-2.5 npub encoder and the tb1p… encoder now share their guts.
- **The git-mark CLI (npm `git-seal`) does not implement the spec's
  derivation.** It uses the raw commit hash as the scalar
  (`t = commit mod n` — no TapTweak, no state hash, no pubkey
  binding), while the spec mandates
  `tagged_hash("TapTweak", x_only(P) || sha256(state))` and the
  git-mark-demo hashes `{commit, repo, branch}`. This plugin follows
  the SPEC (the task's normative reference) with the demo's state
  convention — so addresses derived here will not match `git mark
  address` for the same commits under the same key. Interop survives
  because the hosted verifier checks the SPEND CHAIN (tx exists,
  confirmed, amount, spends-previous), not the derivation; the
  divergence is written down here and self-described in the served
  document (`derivation`, `stateHash` fields) so a future re-deriving
  verifier knows exactly what it is looking at.

### 21. Request-bound proofs make server-side pod writes impossible — the client writes, the forge validates a pointer (the capstone)

Tier 2's storage beat is a server-side loopback PUT into the author's
pod that FORWARDS the caller's `Authorization` header. That works for a
plain Bearer (a bearer is replayable to any URL), but it is
STRUCTURALLY impossible for the two proofs that actually matter for a
pod-native forge: **Solid-OIDC DPoP and NIP-98 are bound to ONE request
URI** (DPoP's `htu`, NIP-98's `u`). The browser signs a proof whose URI
is the forge API URL; forward that same proof to a *different* URL (the
pod-write) and it has no valid binding → the pod answers 401 → *"your
pod refused the write"*. The server cannot re-sign, because the signing
key lives in the browser (WebAuthn/NIP-07), not on the host. This is
the same request-bound wall Finding 9 hit for git pushes — here it
blocks the pod WRITE instead of the git wire.

The WAC-correct fix moves the write to the only party that can sign for
it. The **client** (`window.xlogin.authFetch`, which mints a FRESH DPoP
or NIP-98 proof per request) PUTs the JSON-LD body directly into the
author's OWN pod — `htu`/`u` now name the pod URL, so WAC governs a real
write the author owns — and then POSTs the forge only a POINTER
(`resourceUrl`). The forge stores it in the index identically to a
server-written pointer (`{author, resourceUrl, at}`), so the display
path (public loopback GET → `doc.body` → rendered markdown) reads a
pointer-based issue byte-for-byte the same as a body-based one. Proven
in the tests: a pointer issue renders the same `<strong>` as a
body-written one.

Two design points that make it safe:

- **Pointer-injection defense.** A `resourceUrl` is a client-supplied
  path, so the forge treats it as hostile: the path MUST start with
  exactly `${podPathFromAgent(agent)}public/forge/${owner}--${name}/`,
  end in `.jsonld`, and contain no `..` — else 403. The allowed prefix
  is keyed to the CALLER's pod (derived from the authenticated agent,
  not from the request body), so a caller can register pointers only
  into ITS OWN pod's forge area for THIS repo; eve cannot point at
  casey's pod, and casey cannot point at another repo's dir or escape
  `public/forge/`. Then an UNAUTHENTICATED loopback GET confirms the
  resource is really there and PUBLICLY readable (400 if not) — the
  same public read the display path uses, so registration validates
  exactly what rendering will later fetch. The read is deliberately
  unauthenticated: bodies live under `public/forge/`, the GET is itself
  request-bound and could not carry a forwarded proof anyway, and a
  private body would render as removed for everyone — so requiring
  public-readability at registration is honest about the display
  contract.
- **The index author is authoritative, not the doc.** The thread entry
  records the AUTHENTICATED agent as `author`; the pod document's own
  `author` field is cosmetic. A doc that lies about its author changes
  nothing the forge trusts.

Backward compatibility is total: `resourceUrl` is optional, and only a
pod agent (`podPathFromAgent` truthy) whose request carries it takes the
pointer branch. A plain Bearer with no `resourceUrl` still gets the
server-side write (tier 2 unchanged); a did:nostr agent still gets
forge-hosted storage (tier 2.5 unchanged, `resourceUrl` ignored — a key
has no pod to point at, which is Finding 10 restated). The client only
takes the pod-write path for `xlogin.type === 'solid'`; nostr sessions
and plain-Bearer logins post `{title, body}` as before. No CSP change:
the `authFetch` PUT is same-origin (`connect-src 'self'` already admits
it). The one seam this still wants is the same `api.podOf` ask from
Finding 10 — a did:nostr key with provisioned storage could take this
exact client-write path and the hosted asymmetry would finally vanish.

### 22. The forge is a NODE, not a home — storage + anchor + nostr discovery, three separable layers

Three tiers stack into a coherent role: the forge **hosts** the bytes
(tier 1 git), **anchors** their history to Bitcoin (tier 3.5 marks — the
source of truth), and now **announces** them over Nostr (NIP-34 30617
discovery + 30618 repo-state — the latter carries the refs so a
subscriber syncs to a precise commit, anchored to the same Bitcoin txid).
The load-bearing idea is that these are *separable*
and a repo is not owned by any one forge: the same repo lives on many
mirrors, each a node that hosts a clone URL and points at the one shared
anchor. The `clone`/`web` tags carry *this* node's mirror URLs; the
`anchor` tag carries the mirror-independent Bitcoin root; a viewer that
sees two forges announce the same `d`/`anchor` learns they are mirrors of
one repo. So the forge is deliberately a replaceable node in a
mirror-set, not the repo's home — losing one node loses a mirror, not the
project.

**Who signs the announcement** is the one real custody choice, and it is
the same shape as the anchoring one (Finding 18). The forge signs with a
**forge-instance key** (persisted `0600`, POC custody), not the
maintainer's nostr key. For a *mirror announcement* that is the honest
claim and needs no maintainer-key custody: the event asserts "this node
hosts these URLs, anchored here," which is exactly what the node is
entitled to say. The `maintainers` tag still names the maintainer's
pubkey (for nostr-owned repos the owner **is** that hex pubkey), leaving
room for a canonical **maintainer-signed** 30617 to supersede the
mirror's in any viewer that prefers it. The principled upgrade is,
again, client-side signing (NIP-07/xlogin) with the forge as pure relay —
at which point the forge signs nothing and this custody note dissolves,
just as Finding 18's does for the trail key. Until then a forge-signed
mirror announcement is a sound, clearly-scoped discovery layer, and
keeping emission **opt-in** (`config.announceRelays`, empty ⇒ off) means
a node broadcasts to the wider network only when its operator says so.
