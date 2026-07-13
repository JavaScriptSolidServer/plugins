# forge — a node in a decentralized git network

`forge/` is not just a git host with a UI. It is a **node** in a
trust-minimized, decentralized git-collaboration network: your code lives on
one (or many) forges, its canonical history is settled by Bitcoin, and updates
propagate over Nostr. This file is the architecture and the workflow. For the
route/API/config reference and the numbered findings, see
[`README.md`](./README.md).

Everything here is portable — no host, domain, key, or path is specific to any
deployment. Substitute your own.

## The layered model — one job per layer

The design deliberately separates four concerns that decentralized-git efforts
usually tangle together:

| Layer | What does it | Why it's separable |
|---|---|---|
| **Storage** | the forge hosts the git objects (bare repos under `pluginDir`), serves them over smart-HTTP, and renders a GitHub-light UI + JSON API | many forges can hold the same repo (mirrors) |
| **Identity** | owners are `did:nostr:<hex>` keys **or** pod WebIDs — no central account authority | a key/WebID is sovereign; nobody can revoke it |
| **Truth** | a Blocktrails **mark chain** binds each repo state to a Bitcoin transaction | Bitcoin gives total order + finality + fork-resolution, so no forge has to be trusted for "which state is real" |
| **Discovery / reaction** | the forge emits **NIP-34** Nostr events; subscribers react (pull, mirror, build, deploy) | Nostr is the trigger bus; anyone can subscribe, no central webhook |

A forge implements storage + truth + discovery. The *reaction* side (mirroring,
CD) is any Nostr subscriber — e.g. a git-sync daemon.

## What a forge instance provides

- **Hosting** — push-to-create bare repos at `<prefix>/<owner>/<name>.git`;
  `<owner>` is a pod username or a 64-hex `did:nostr` pubkey. Anonymous clone
  by default; `config.privateRepos` gates reads to the owner.
- **Browse** — server-rendered GitHub-light UI (file tree, blob, commits,
  green/red diffs, branches, tags, releases with `git archive` tarballs) and a
  matching **JSON API** under `<prefix>/api/...`. Zero deps, zero build.
- **Forks & PRs** — `git clone --local` forks, cross-fork compare, and real
  merges (`git merge-tree` → `commit-tree` → compare-and-swap `update-ref`).
- **Web edit** — `POST <prefix>/api/repos/<o>/<n>/edit {path, content,
  message?, branch?}` commits ONE file over HTTP (GitHub's web editor) in a
  disposable local clone pushed back to the bare, then rides the same
  push→anchor→NIP-34 beats. Owner-signed by default; `config.openEdit` relaxes
  to anonymous edits for **throwaway demo repos only** (never a default — the
  edit surface is otherwise an open-vandalism vector). CORS-open + preflight.
- **Unstaged preview** — `POST <prefix>/api/repos/<o>/<n>/preview {path,
  content, branch?}` is the tier *below* a commit: it publishes a NIP-01
  **ephemeral** event (kind 21617, the 20000–29999 range relays SHOULD NOT
  store) carrying the file content, and touches neither git nor disk nor
  Bitcoin. Only currently-connected subscribers receive it — a live, throwaway
  draft that vanishes the moment nobody's looking. Same auth as `/edit`. This
  surfaces git's own three states as three tiers of permanence: **unstaged**
  (ephemeral event) → **committed** (a commit + 30618) → **marked** (a
  Bitcoin-anchored checkpoint). A subscriber picks which tier it reacts to, so
  preview-vs-production (and `requireAnchor` = staging-vs-settled) falls out of
  the layering rather than being wired.
- **Issues & PRs as data you own** — an issue/comment body is a JSON-LD
  resource in the **author's own pod** (WAC-governed); the forge stores only a
  validated pointer in its index. Delete the resource from your pod and the
  thread shows "content removed by its author." Podless `did:nostr` agents get
  forge-hosted storage instead.
- **WebID / Solid writes** — because DPoP (and NIP-98) proofs are bound to one
  request, the *browser* does the pod write via `authFetch` (fresh proof per
  request) and the forge validates the pointer is inside the author's own pod
  area. This is the WAC-correct, server-can't-forge-a-credential design.
- **Bitcoin anchoring** — per-repo Blocktrails trails: enabling derives a
  genesis P2TR address (pure crypto, **no chain I/O by the server**); the owner
  reports the funding txo; the forge serves a verifier-compatible
  `blocktrails.json`. Derive-and-record on the server, broadcast-and-verify off
  it — the SSRF-free split.
- **Nostr discovery (NIP-34)** — emits a **kind-30617** repo announcement
  (name, clone/web URLs, maintainers, and — if anchored — the `r`(blocktrails)
  + `anchor`(chain, txid) tags) and a **kind-30618** repo-state event (the
  `refs/heads/*` → commit shas, plus the same anchor tags). Signed by a
  per-instance announce key (persisted, `0600`), or `config.announceKey`.

## The decentralized CD / sync workflow (the loop)

This is what ties it together — event-driven, trust-verified, Bitcoin-anchorable
sync that generalizes to CI/CD:

```
  edit + commit on forge A
     │
     ▼  (owner anchors, or calls the announce endpoint)
  forge advances the mark  ──▶  Bitcoin (testnet/mainnet)   ← the truth
     │
     ▼  emits NIP-34 30617 + 30618 (carrying the new commit + the anchor txid)
  Nostr relay(s)  ── your own JSS --nostr relay, and/or public relays
     │
     ▼  (open subscription)
  a subscriber node (e.g. nostr-git-sync)
     │  1. verify: event signed by a TRUSTED key?   (reject otherwise)
     │  2. optional: require the commit be Bitcoin-anchored  (requireAnchor)
     │  3. git pull from forge A's clone URL
     │  4. run postSync  ── the CI/CD step: mirror, build, deploy, test, …
     ▼
  the action happens — on any number of independent nodes
```

Key properties:

- **No central authority.** The trigger is a Nostr event on a relay you chose
  (it can be your own); the trust is a key you chose; the truth is Bitcoin.
  This is `push → CI → deploy` with GitHub removed from every step.
- **Sync ≈ CI.** `postSync` is an arbitrary command. Mirroring is one action;
  building and deploying a site (gh-pages-style) is another; running tests is
  another. Same primitive: *on a verified update event, do work.*
- **Trust-minimized.** A subscriber accepts an update only if it's signed by a
  trusted maintainer key. With `requireAnchor`, it additionally refuses any
  state not committed on Bitcoin — so a compromised or lying mirror cannot
  advance the canonical history; only the holder of the trail key can, and
  Bitcoin is the arbiter. The mark chain is **single-writer, multi-reader**.

## Trust & verification model

- **Who can advance the canonical state:** only the holder of the repo's
  Blocktrails trail key (the maintainer). Mirrors replicate and verify; they
  cannot rewrite the truth.
- **Who a subscriber accepts events from:** its `trusted` list of `did:nostr` /
  npub keys. An event from any other key is ignored.
- **What "verified" means on-chain:** the mark chain is an unbroken sequence of
  Bitcoin UTXO spends; whichever mirror's state matches it is canonical. Anyone
  can check independently from `blocktrails.json` — no forge is trusted for it.
- **Who signs the announcements:** by default the **forge instance key** (an
  honest "this node hosts these clone URLs, anchored here" claim). The
  `maintainers` tag names the real maintainer key, so a maintainer-signed
  announcement can supersede it. The principled end state is client-side
  signing (NIP-07 / a login widget) with the forge as a pure relay.

## Operating knobs (all optional, all in the entry `config`)

- `privateRepos` — gate clone/read to the owner (default public).
- `announceRelays: [wss://…]` — enable NIP-34 emission (empty = off).
- `announceKey` — hex privkey for the forge's Nostr identity (else generated
  and persisted in `pluginDir`).
- `chain` — Blocktrails chain (default a testnet); mainnet requires
  `allowMainnet: true`.
- `sparseMarks` — when true, a new tip RE-TARGETS the trailing unfunded mark
  instead of stacking one pending mark per commit. The chain then gains a link
  only per *funded* mark, so anchoring HEAD is one tx per period regardless of
  commit cadence — the "rolling mark" that lets fast commits (fresh mirrors)
  coexist with slow, cheap anchoring. Default off (each commit is its own
  candidate state).
- `cspConnect: [origin, …]` — extra `connect-src` origins for a login widget
  that talks to external identity providers.
- `pushTokenTtl`, `gitHttpBackend` — see `README.md`.

## Composing a multi-forge deployment

- **Mirror:** point a second forge (or a sync daemon) at the first's clone URL;
  verify against `blocktrails.json`. If a host disappears or censors, others
  hold the repo, and Bitcoin says which copy is honest.
- **Announce with mirror URLs:** a maintainer-signed 30617 can list several
  `clone` URLs — one repo, many mirrors — which a NIP-34 viewer shows as one
  entry.
- **CD fan-out:** many subscribers can watch the same repo and each run their
  own `postSync` (deploy to different edges, run different builds).

## Live data on a cheaply-anchored mesh — the two-channel pattern

A frequently-changing app (a tracker, a dashboard, a game board) wants two
things that pull against each other: **mirrors fresh in real-time** and **cheap,
sparse Bitcoin anchoring**. Run them as two channels over the same repo:

- **Ephemeral channel (real-time).** On every change, emit a NIP-01 *ephemeral*
  event (kind in 20000–29999) carrying the new value — the forge's `/preview`
  endpoint does this (kind 21617), or any signer can. Subscribers (the status
  page, and the mirror app itself) render it live. **No commit, no mark, no
  cost.** Relays don't store ephemeral events, so add a slow heartbeat re-emit
  (~30s) so a freshly-loaded page catches the current value. Source the change
  from an *event*, not a poll: subscribe to the app's own push stream (or LDP
  notifications) rather than watching the filesystem — `fs.watch` dies with
  `EMFILE` on a large directory, and polling is the wrong tool when the server
  already emits change events.
- **Super-commit channel (durable + anchored).** A periodic *sync* commits the
  accumulated state; with **`sparseMarks`** those commits collapse into one
  re-targeted pending mark, so the periodic anchor is a single tx per period.
  *The sync becomes the next super-commit.* Frequent commits (fresh git mirrors)
  and one cheap mark per period now coexist.

**Latency is the relay you choose, not the design.** Route the ephemeral channel
through a relay **you control and co-locate with the consumers**, not a shared
public relay — a public relay can add unpredictable seconds; a local one is
sub-second. *Measure each hop before tuning anything else* (stream → emit → each
relay → render); the slow link is almost always the public relay, not your code.
Emit fire-and-forget so a slow relay's ACK never blocks the next event.

**Mirrors stay verifiable and can go live too.** Ship a `marks.json` snapshot
*inside the repo* (all public data — txids, addresses, commits) so every mirror
carries its own provable mark state and renders the marked tier straight from
Bitcoin, with no reach back to the origin. A static mirror app becomes real-time
by subscribing to the same ephemeral channel (intercept the current-value fetch,
re-render) — appended at deploy time by the subscriber's `postSync`, so the
origin's own copy stays untouched.

## Known walls / upstream

- **Core `--git` shadows plugin-owned git paths.** A server that also runs core
  git-over-HTTP intercepts `<prefix>/…/*.git` smart-HTTP requests by a global
  substring match, so the forge can't serve its own git alongside core `--git`.
  Filed upstream; the fix is for core's git guard to skip plugin-owned
  prefixes. A one-line local shim (exclude the forge prefix) is the interim.
- **Anchor granularity is a policy choice.** You cannot anchor every commit
  (cost, block time); the mark is a periodic checkpoint (per release, per N
  commits, a rolling mark) with git content-addressing between checkpoints.
- **`api.podOf(agent)`** would let a `did:nostr` key that owns a pod write its
  issue/comment bodies into that pod instead of forge-hosted storage. Today a
  bare key has nowhere of its own to write.
