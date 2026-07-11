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
              baseUrl: 'https://pod.example',      // host for the did:web id (required)
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
  (attempted, WAC-governed; finding 2) and `<prefix>/<user>/did.json`.
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
   wrapped in try/catch and degrades to the prefix mount. Same candidate seam
   the other two name: a declared `wellKnown: [...]` / reserved-path api so the
   loader reserves the route, reports conflicts, and extends the WAC exemption
   deliberately instead of by coincidence.

2. **The pathed DID re-hits activitypub's namespace-interleaving wall.**
   did:web's pathed form `GET /<user>/did.json` lands *inside* the pod's own
   `/<user>/` LDP namespace — the exact collision `activitypub/` hit putting
   `/<user>/inbox` and `/<user>/outbox` on top of the pod. Unlike the
   well-known root, this path is **WAC-governed**: core's auth preHandler skips
   only `/.well-known/*`, `appPaths` prefixes, and the plugin's own `prefix`
   (`server.js`), so an anonymous `GET /alice/did.json` is denied by default.
   The root `/.acl` JSS seeds is public-read on the container **with no
   `acl:default`**, so a child `did.json` is not inherited-public either — the
   test must write an explicit public-read `/alice/did.json.acl` for the
   absolute did:web location to resolve. **Consequence:** did:web pathed
   resolution works only where the pod owner grants public Read at that path;
   the operator cannot fix it globally the way an API shim does with
   `appPaths`, because the path is *parameterized* (`/:user/did.json`) and
   `appPaths` matches only fixed prefixes. This strengthens the case for
   `api.reservePath()` (#582) to cover *parameterized* public routes that
   interleave with pod namespaces, not just fixed app roots — a requirement
   `activitypub/`, `mastodon/`, and `bluesky/` only approximated by inventing a
   single fake root (`/ap`, `/api`, `/xrpc`). did:web has no such escape: its
   URLs are fixed by the method spec. The plugin therefore also serves every
   DID under the always-safe `<prefix>/<user>/did.json`, and the test asserts
   that mount is byte-identical.

3. **`config.podsRoot` + `config.baseUrl` repetition, again** (see `webfinger/`,
   `nip05/`, `notifications/`). A plugin can learn neither the data root nor
   its own origin, so both are repeated in config and can be pointed at the
   wrong place — here the failure mode is that the resolver *confidently mints
   a valid-looking DID* off a stale/empty pod or a mismatched host, which a
   resolver then caches. `api.storage.serverRoot` (read-only) and
   `api.serverInfo` remain the candidate seams. Subdomain-mode did:web
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
