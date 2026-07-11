# gitscratch — ephemeral git remotes ([#322](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/322))

Push to a URL that doesn't exist → the repo materializes, serves the full
git smart-HTTP protocol, and auto-deletes when its TTL expires. Solid-authed,
no pre-provisioning, no tokens to mint beyond the identity you already have.

```json
{ "plugins": [{ "id": "gitscratch", "module": "gitscratch/plugin.js",
                "prefix": "/git",
                "config": { "ttlMs": 86400000, "requireAuth": false } }] }
```

```sh
git remote add scratch http://host/git/feature-x.git
git -c http.extraHeader="Authorization: Bearer $TOKEN" push scratch main
# repo materialized on first contact; anyone can clone it until the TTL sweeps it
git clone http://host/git/feature-x.git
```

## How: the git-http-backend CGI bridge

The protocol is not reimplemented. Every request under
`{prefix}/<name>.git/…` is delegated to the stock `git-http-backend`
binary — the same CGI that Apache/nginx deployments use — via a small
bridge (~70 lines):

1. **Spawn** `/usr/lib/git-core/git-http-backend` (path autodetected via
   `git --exec-path`, overridable with `config.gitHttpBackend`) with the
   CGI/1.1 environment: `GIT_PROJECT_ROOT` (the repos dir),
   `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO=/<name>.git/<endpoint>`,
   `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `CONTENT_LENGTH`,
   `REMOTE_USER` (the verified agent), `HTTP_CONTENT_ENCODING` (the backend
   inflates gzip'd pack uploads itself), and `GIT_PROTOCOL` from the
   `Git-Protocol` header (wire protocol v2 negotiation — the same
   `SetEnvIf` dance Apache configs do).
2. **Pipe** the raw request body into its stdin.
3. **Parse** its CGI stdout: header block terminated by a blank line
   (`\r\n\r\n` or `\n\n`), a `Status:` pseudo-header for the HTTP code
   (default 200), everything else copied verbatim into the reply — then the
   remainder of stdout is **streamed** (not buffered) as the response body.

Only the smart protocol surface is exposed: `GET info/refs?service=…` and
`POST git-upload-pack` / `git-receive-pack`. Dumb-protocol paths get a 400,
anything else in a repo a 404, so `GIT_HTTP_EXPORT_ALL` never turns into a
raw file server. Repo names must match `[A-Za-z0-9][A-Za-z0-9._-]*\.git` —
no slashes, no traversal, no leading dot (the host's dotfile guard 403s
those anyway, as the tests confirm).

Server-side git runs hermetically (`GIT_CONFIG_NOSYSTEM=1`, no `HOME`), so
an operator's personal `~/.gitconfig` can't leak into scratch repos — a
personal `init.defaultBranch` otherwise leaves every repo's HEAD dangling.
Since the first push may bring any branch name, each repo gets a
`post-receive` hook that repoints a dangling HEAD at the first branch that
lands, so clones check something out.

## Auth model

- **Push** (`git-receive-pack`, including its `info/refs` advertisement)
  always requires a verified agent from `api.auth.getAgent` — Bearer, DPoP,
  NIP-98, whatever the server accepts. Anonymous pushes get
  `401 + WWW-Authenticate`.
- **Clone/fetch** is public by default; `config.requireAuth: true` gates
  reads behind the same check.
- The agent id is passed to the backend as `REMOTE_USER` and recorded as
  `creator` in the repo's `jss-scratch.json`.

Clients send Solid credentials with plain git via
`git -c http.extraHeader="Authorization: Bearer <token>" …`.

## TTL model

First access materializes the bare repo (`git init --bare` +
`http.receivepack=true`) and stamps `jss-scratch.json` with `createdAt`. A
sweeper (`setInterval`, unref'd, cadence `config.sweepIntervalMs`, default
min(ttl, 60s)) removes repos older than `config.ttlMs` (default 24h).
`deactivate()` clears the timer. Not built (future work, per the issue):
per-repo TTL bump, `persist`/`DELETE` endpoints, activity-extended TTLs,
quota/max-repos caps.

## Test

```sh
node --test --test-concurrency=1 gitscratch/test.js
```

Seven end-to-end tests drive the real `git` CLI (hermetic HOME, no
credential helpers) against a real JSS from npm: anonymous push refused
(and nothing materialized), Bearer push materializes + succeeds, anonymous
clone round-trips content, second push + pull, protocol-surface/traversal
hardening, `requireAuth` gating reads, TTL sweep.

## Findings

- **Git smart-HTTP works fully as a plugin via the git-http-backend CGI.**
  No core git handler needed: clone, fetch, push, protocol v2, gzip'd pack
  uploads — all through `activate(api)` + a spawned CGI. A plugin can host
  a whole protocol subsystem, not just JSON routes. (Core's
  `src/handlers/git.js` remains untouched and off by default; note the two
  would collide if `git: true` were set, since core intercepts any URL
  containing `/info/refs` or `/git-*-pack` in a preHandler hook before
  plugin routes run.)
- **Raw request bodies — the #583 seam, again.** git POST bodies are opaque
  (often gzip'd) pack data; Fastify's default parsers would consume and
  mangle them. Fix: a scoped
  `addContentTypeParser('*', (req, payload, done) => done(null, payload))`
  hands the **unconsumed request stream** through as `request.body`, which
  pipes straight into the CGI's stdin — zero buffering, byte-exact,
  gzip passthrough included. This goes a step further than tunnel's
  `parseAs: 'buffer'` variant: a plugin doesn't just need raw bytes, it
  needs the *stream*. Whatever shape `mountApp`/#583 takes, "give me the
  unconsumed body stream" is the primitive to preserve.
- **Auth over git-HTTP is workable but awkward.** git has no native Bearer
  story: the server must answer `401 + WWW-Authenticate: Basic` (or git
  reports a protocol error rather than an auth failure), yet real
  credentials arrive out-of-band via `http.extraHeader`. It works — same
  header, `getAgent` verifies it on every request — but no credential
  helper integration, and DPoP/NIP-98 (which sign method+URL) would need
  per-request header minting that static `extraHeader` can't do. Bearer is
  the practical scheme for git agents.
- **First-contact materialization has a policy edge**: with public reads
  (default), an anonymous `ls-remote` of a nonexistent name creates an
  empty repo (the TTL test exploits this). Contained by the TTL and name
  rules, but a real deployment wants `requireAuth: true` or
  create-only-on-push plus a max-repos cap.
- **The operator's gitconfig is an ambient hazard** for any plugin that
  shells out to git: this test suite failed first on a machine-local
  `init.defaultBranch = gh-pages` leaking into server-created repos.
  `GIT_CONFIG_NOSYSTEM=1` + no `HOME` in the child env is the cure.
