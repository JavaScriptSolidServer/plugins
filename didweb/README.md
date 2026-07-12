# didweb — did:web DID document resolver plugin

Out-of-tree implementation of the [did:web](https://w3c-ccg.github.io/did-method-web/)
DID method for JSS pods. Serves the two DID documents that any DID resolver —
the DIF [universal-resolver](https://dev.uniresolver.io/), `did-resolver` +
[`web-did-resolver`](https://github.com/decentralized-identity/web-did-resolver),
Veramo, etc. — fetches to resolve a `did:web`:

| DID | resolves to (HTTPS GET) |
|---|---|
| `did:web:<host>` | `https://<host>/.well-known/did.json` |
| `did:web:<host>:<user>` | `https://<host>/<user>/did.json` |

The port, if present, is percent-encoded into the host: `localhost:3000` →
`did:web:localhost%3A3000`.

```js
plugins: [{ module: 'didweb/plugin.js', prefix: '/didweb',
            config: {
              podsRoot: './data',                 // pod dirs to scan (finding 3)
              baseUrl: 'https://pod.example',      // optional override; api.serverInfo() default (finding 3)
              actorPathTemplate: '/ap/<user>/actor', // optional → ActivityPubActor service
              serviceEndpoints: [ /* extra service entries, appended verbatim */ ],
            } }]
```

## The DID document

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  "id": "did:web:pod.example:alice",
  "alsoKnownAs": ["https://pod.example/alice/profile/card#me"],
  "verificationMethod": [
    { "id": "did:web:pod.example:alice#owner-key", "type": "Multikey",
      "controller": "did:web:pod.example:alice",
      "publicKeyMultibase": "zQ3sh…" }
  ],
  "authentication":  ["did:web:pod.example:alice#owner-key"],
  "assertionMethod": ["did:web:pod.example:alice#owner-key"],
  "service": [
    { "id": "…#pod", "type": "SolidPod", "serviceEndpoint": "https://pod.example/alice/" },
    { "id": "…#linked-domain", "type": "LinkedDomains", "serviceEndpoint": "https://pod.example" }
  ]
}
```

### Verification-method derivation (ties to nostr / AP identity)

The key material is read from the pod's **public** WebID profile card
(`<pod>/profile/card.jsonld`) exactly as `nip05/` and `webfinger/` read it —
the provisioned Nostr owner key (#437/#443) in the card's `verificationMethod`,
in either `publicKeyMultibase` (f-form `f` + multicodec `e701` + parity + x)
or `publicKeyJwk` (EC secp256k1) form. Every candidate is checked **on-curve**
with `@noble/curves` before it is published, then re-encoded as a base58btc
**secp256k1 Multikey** (`zQ3s…`). Because it is the *same* key the pod signs
Nostr events / did:nostr with, the `did:web` document and the pod's Nostr
identity resolve to one subject; `alsoKnownAs` binds the same subject to the
pod's WebID, and the `SolidPod` service (plus an optional `ActivityPubActor`
service from `actorPathTemplate`) links the DID to the pod's data plane and its
fediverse actor.

If a pod carries **no** key, the plugin **mints and persists an Ed25519
keypair** in `api.storage.pluginDir()` (`node:crypto`, private key never served)
and publishes it as an Ed25519 Multikey (`z6Mk…`) — so every resolvable DID
always has at least one verification method and a usable `authentication`
reference. The root/server DID `did:web:<host>` is served from the single-user
pod card at `podsRoot` if present, else from a minted server key.

- Served at **both** `/.well-known/did.json` (attempted; finding 1) and the
  contract-safe `<prefix>/did.json`; pathed DIDs at **both** `/<user>/did.json`
  (reserved via `api.reservePath('/:user/did.json')`, anonymous GET; finding 2
  — closed) and `<prefix>/<user>/did.json`.
- `Access-Control-Allow-Origin: *` so any resolver/browser can fetch. Content
  type `application/did+json`. Pods scanned fresh per request. Unknown user →
  404 (on the WAC-exempt prefix mount).

## Findings

1. **The root DID lives at a well-known path — servable only by accident.**
   `/.well-known/did.json` lies outside any prefix a plugin can mount on, yet
   `api.fastify.get('/.well-known/did.json', h)` works, served *unauthenticated*
   (the test proves an anonymous 200 against a server whose default is not
   public-read). This is the **third** `.well-known`-by-luck document in the
   repo, after `nip05/` (`/.well-known/nostr.json`) and `webfinger/`
   (`/.well-known/webfinger`) — three plugins now depending on the identical
   chain of core internals, none of it in the plugin contract: the loader
   hands over the real scoped Fastify instance and doesn't confine routes to
   `prefix`; an exact path outranks core's LDP `GET /*` wildcard; and core's
   auth preHandler blanket-exempts `/.well-known/*`. The registration is
   wrapped in try/catch and degrades to the prefix mount. **Partially closed
   by `api.reservePath` (#602, JSS 0.0.219):** the plugin now reserves
   `/.well-known/did.json`, so the *claim* is deliberate and cross-plugin —
   two plugins pinning the same document fail the boot naming each other
   instead of one silently losing (the webfinger-vs-remotestorage outcome).
   The WAC exemption the reservation carries is redundant here (the blanket
   `/.well-known/*` skip already covers it), and route registration is still
   the plugin's job via `api.fastify` per the seam's own contract — so the
   exact-path-outranks-wildcard footing remains loader behavior, now at least
   sanctioned by that contract rather than pure coincidence.

2. **The pathed DID's namespace-interleaving wall — CLOSED by parameterized
   `api.reservePath` (#602, JSS 0.0.219).** did:web's pathed form
   `GET /<user>/did.json` lands *inside* the pod's own `/<user>/` LDP
   namespace — the exact collision `activitypub/` hit putting `/<user>/inbox`
   on top of the pod. This used to be **impossible**, not just inconvenient:
   the path is *parameterized* and `appPaths` matches only fixed prefixes, so
   no operator config could carve the exemption; `activitypub/`, `mastodon/`,
   and `bluesky/` escaped by inventing a single fake root (`/ap`, `/api`,
   `/xrpc`), but did:web's URLs are fixed by the method spec — no escape. The
   test had to write an explicit public-read `/alice/did.json.acl` to make
   resolution work at all. **Now:** `api.reservePath('/:user/did.json')`
   compiles an *exact-shape* matcher core's WAC hook consults per request, so
   the anonymous GET answers with no ACL grant, no `appPaths`, no pod-owner
   action — and every other `/<user>/` path stays WAC-governed. The test
   proves both halves: the DID document resolves anonymously with nothing but
   the reservation, while a sibling resource, a deeper `…/sub/did.json`, and
   an anonymous PUT to `did.json` itself all stay denied (reservations are
   read-only by default — exactly did.json's GET-only surface, so the default
   needed no widening). A second plugin reserving the same shape fails the
   boot naming both claimants. **What remains:** route registration is still
   the plugin's job via `api.fastify` (by the seam's contract); and fastify's
   default `maxParamLength` (100) caps the `:user` route while the
   reservation's matcher is length-unbounded, so a >100-char pod name would
   miss the route and fall through to LDP's `GET /*` with the read-only
   exemption applied — the wildcard escape `capability/` used is unavailable
   (`GET /*` is core's), harmless for `LOCAL_PART` pod names in practice but
   a real shape/route mismatch at the margin. The always-safe
   `<prefix>/<user>/did.json` mount stays, and the test still asserts it is
   byte-identical.

3. **`config.baseUrl` repetition — RESOLVED by `api.serverInfo()` (#601,
   merged JSS 0.0.218).** The did:web `id` (`did:web:<host>`) and every
   service URL now derive from `api.serverInfo().baseUrl`, resolved at
   request time; `config.baseUrl` is an *optional* override and the boot no
   longer hard-fails without it. This mattered most here of all the
   consumers — a mismatched host silently mints a valid-looking DID whose
   `id` doesn't match the URL it was fetched from, which a resolver then
   caches — so landing the seam fixes a *silent-corruption* failure, not just
   a config chore. **`config.podsRoot` is still a repetition** (see
   `nip05/`): a plugin can't learn the *data root* — the remaining
   `api.storage.serverRoot` candidate. Subdomain-mode did:web
   (`did:web:alice.pod.example` → `https://alice.pod.example/.well-known/did.json`)
   is out of reach for the same reason `nip05/` couldn't do per-host filtering:
   a plugin can read `request.headers.host` but has no way to learn the base
   domain or the pod↔host mapping, so this port ships path-mode only.

4. **Key-codec helpers had to be vendored** (same wall `nip05/`, `relay/nip01`
   document). Decoding the card's f-form/JWK secp256k1 key lives in core's
   internal `src/auth/nostr-keys.js`; ~40 lines were re-implemented here
   against `@noble/curves`, plus a small base58btc encoder (Multikey has no
   `node:` primitive). The base58 output is self-checking: Ed25519 keys encode
   to the canonical `z6Mk…` prefix and secp256k1 to `zQ3s…`, which the tests
   pin. If the card format evolves (new multicodec, base58 `z`-form keys) this
   plugin silently drops those keys and falls back to a minted Ed25519 key.
   Candidate: publish the key-codec helpers (and a Multikey encoder) on the
   documented surface (`auth.js` or a `keys.js`).
