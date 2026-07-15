# recordweb — a RecordWeb (RWP) node as a JSS plugin

Ports the [RecordWeb Protocol](https://github.com/recordweb) (RWP —
[spec](https://recordweb.github.io/rwp/),
[concept](https://recordweb.github.io/rwc/)) onto the #206 plugin loader.
RecordWeb is a W3C Community Group draft (Nik Jenzer / TRIEBWERKSTATT) for
**institutional records**: give every record a global DID, keep its whole
version history as an immutable, content-addressed DAG, prove finalized
versions cryptographically, and group related records into Merkle-rooted
**Cases**. This plugin turns a JSS server into an RWP node — and RWC itself
names two of this estate's own pieces as extensions: *"deliver Records to
Solid Pods (citizen-controlled copies)"* (a JSS pod **is** that) and *"anchor
Merkle roots to an external timestamp proof"* (which [`forge/`](../forge)
already does against Bitcoin).

```js
plugins: [{
  module: 'recordweb/plugin.js',
  prefix: '/recordweb',
  config: {
    namespace: 'bern.ch',            // optional — RWP namespaces are DNS domains; default = host
    baseUrl: 'https://pod.example',  // optional reverse-proxy override; default = api.serverInfo()
  },
}]
```

## The model (RWP, mapped)

| RWP construct | here |
|---|---|
| **Record** `did:rwp:<ns>:<uuid>` | one directory under `pluginDir`; a version DAG of snapshots |
| **Snapshot** | content-addressed: `snapshotHash = SHA-256( JCS(meta \ {snapshotHash,signature}) ‖ payload )` (RFC 8785) |
| **state** `draft`→`finalized` | draft is mutable-by-replacement; finalize signs (Ed25519) + freezes + makes it linkable, one-way |
| **Version graph** (PROV-O DAG) | `parents[]` edges, cycle-guarded on append (RWP MUST) |
| **Case** | payload hard-links finalized snapshots (by hash) + soft-links Records (by DID); `merkleRoot` over the sorted hard links |
| **DID resolution** | `GET …/resolve/:uuid` + a DIF-universal-resolver shim; 200 / 404 / 410 |

## Endpoints

```
POST   /recordweb/records                                   create a Record (root draft)   [owner]
POST   /recordweb/records/:uuid/snapshots                   append a draft child           [owner]
POST   /recordweb/records/:uuid/snapshots/:hash/finalize    sign + freeze                  [owner]
GET    /recordweb/records/:uuid                             metadata + version graph
GET    /recordweb/records/:uuid/snapshots/:hash             one snapshot (verbatim; payload via Link header)
GET    /recordweb/records/:uuid/payload/:hash               raw payload bytes
POST   /recordweb/cases                                     create a Merkle-rooted Case    [owner]
GET    /recordweb/cases/:uuid                               Case doc + merkleRoot
GET    /recordweb/resolve/:uuid                             the Record's DID document
GET    /recordweb/1.0/identifiers/<did:rwp:…>               DIF universal-resolver shim
GET    /recordweb/verify/records/:uuid/:hash                recompute hash + check signature
GET    /recordweb/verify/cases/:uuid                        recompute the Merkle root
GET    /.well-known/rwp-resolver.json                       HTTP mirror of the DNS-TXT resolver record
```

`:hash` is written with the `sha256:` colon replaced by `_` in the URL (path
segments and fastify's param matcher stay clean); it is restored server-side.

Writes require an authenticated pod agent (`api.auth.getAgent`) who becomes
the Record `owner`/controller — only the owner may append or finalize.
Resolution and verification are public, as a DID resolver must be.

## What maps cleanly

- **Content-addressing + immutability** land naturally on `pluginDir`: a
  finalized snapshot is named by its own hash, so it cannot change without
  changing its DID reference, and the plugin refuses to overwrite one. This is
  a better footing than a pod for the *immutable* half of the model — a pod is
  WAC-governed but its owner can still mutate a resource; a content-addressed
  server-private blob cannot silently drift.
- **JCS (RFC 8785) + SHA-256 + Ed25519** are all `node:crypto` + a ~30-line
  canonicalizer — **zero new dependencies** (not even `@noble`; `didweb/`
  needed it for secp256k1, RWP signs with Ed25519 which `node:crypto` does
  natively). `canonicalize`, `computeSnapshotHash`, and `merkleRoot` are
  exported so a client re-derives every hash independently — the test asserts
  a client-side recompute equals the server's.
- **The DID document** is the `didweb/` shape almost verbatim (Multikey
  verificationMethod, `authentication`/`assertionMethod`), plus RWP's
  `recordEndpoint` + `currentVersion` pointers. Origin via `api.serverInfo()`
  (#601), resolved at request time.
- **`api.reservePath`** (#602) claims `/.well-known/rwp-resolver.json` the same
  deliberate, collision-guarded way `didweb/` claims `/.well-known/did.json`.

## Findings

- **The plugin api is sufficient for a whole new protocol with zero seam
  gaps.** recordweb needs none of the still-open seams: no `api.events`
  (records are explicit POSTs, not reactions to pod writes), no
  `api.authorize` (ownership is the requester's *own* identity via `getAgent`,
  never a third party's authority), no `api.mountApp` (payloads are bounded
  JSON/base64, not streams). `serverInfo` + `reservePath` + `getAgent` +
  `pluginDir` cover it end to end. That is itself the finding: the four
  landed seams (0.0.218/0.0.219) close the gap for a *from-scratch* protocol,
  not just for ports of bundled features.

- **`pluginDir` vs. the pod — the immutability/ownership split.** RWC frames
  Solid pods as *"citizen-controlled copies"*, which suggests storing records
  **in** the pod over loopback (the `micropub/`/`gallery/` pattern). But RWP's
  core invariant is that a finalized snapshot is immutable, and a pod resource
  is mutable by its owner. So this MVP keeps the authoritative,
  content-addressed snapshots server-private in `pluginDir` (immutability the
  plugin fully controls) and treats pod delivery as the *distribution* layer,
  not the *system of record*. **The natural next wave**: on finalize, PUT a
  read-only copy of the snapshot + DID doc into the owner's pod over loopback
  with forwarded auth — the citizen-controlled copy RWC describes — while the
  content hash keeps the pod copy honest. That needs no new api; it is the
  `micropub/` write pattern pointed at the owner's pod.

- **`did:rwp` is not `did:web`, so no well-known collision — but also no free
  WAC exemption.** `didweb/` leans on core blanket-exempting `/.well-known/*`.
  `did:rwp` resolution is namespace-scoped (discovered via a DNS TXT record,
  which we also mirror at `/.well-known/rwp-resolver.json`), so resolution
  lives under the plugin prefix where the loader already exempts routes — no
  reservation needed for the resolver itself, only for the well-known mirror.

- **`maxParamLength` (100) bites a full DID in a named param.** A
  `did:rwp:<ns>:<uuid>` easily exceeds fastify's default 100-char param cap,
  so the DIF-universal shim uses a **wildcard** route (`/1.0/identifiers/*`)
  and parses the DID itself — the same footgun `capability/` documented, same
  wildcard escape. The native `…/resolve/:uuid` route takes only the 36-char
  uuid and stays a clean named param.

- **Finalization is a state *transition*, not a new child.** The finalized
  snapshot keeps the draft's `parents` (it is the same logical node at a new
  state), so its content hash changes but its lineage doesn't — the finalized
  node and its former draft both descend from the same parent. Modeling it as
  a child instead would double every node's ancestry and corrupt the Merkle
  provenance. The draft node is retained in the graph (history never
  disappears — RWC's thesis), just no longer the `currentVersion`.

- **Deletion is a tombstone, honestly partial.** `resolve` returns **410** for
  a Record marked deleted (a `deleted` marker file) vs **404** for one never
  known — the RWP resolver contract. The full `DeletionRecord` regimes
  (payload-only "empty shell", full-delete, exempt) are modeled in the spec
  but not yet wired here; the 404/410 split is the resolver-visible part and
  the hook for the rest.

## Not yet (scoped out of the MVP, no api gap — just work)

- **Pod delivery of finalized copies** (the loopback wave above).
- **`SchemaRecord`-driven validation** — RWP lets a record type carry a JSON
  Schema + allowed `stateTransitions` + per-state `payloadFormats`; finalize
  would validate the payload against it. The engine is here; the schema
  registry + validation pass is additive.
- **Cross-namespace federation** (RWP Level 2) — resolve a foreign
  `did:rwp:<other-ns>:…` by reading its DNS TXT resolver endpoint and fetching
  over HTTP, then verifying the returned snapshot hash. Pure `fetch` + the
  `corsproxy/` SSRF-gate discipline; no new api.
- **Bitcoin anchoring of Case Merkle roots** — the RWC "external timestamp
  proof" extension, which `forge/` already implements against Bitcoin
  (Blocktrails). A Case's `merkleRoot` is exactly the thing to anchor; the
  obvious cross-plugin synergy in this estate.

## Test

```bash
node --test --test-concurrency=1 recordweb/test.js
```

17 tests: the pure crypto units (JCS, Merkle), the full create→append→finalize
lifecycle with owner/anon/non-owner gating, the one-way finalize, DID
resolution (native + universal shim + foreign-namespace 404), snapshot + Case
verification by independent recompute, and the well-known resolver doc.
