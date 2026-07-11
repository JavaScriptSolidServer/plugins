# capability — capability URIs plugin (#506)

Out-of-tree exploration of
[#506](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/506):
scoped, time-bound, **shareable** access by URI possession instead of by
WebID. Not a port of core code — core has no capability layer yet; this is
the plugin-shaped probe of the design, and of where its boundary with core
lies (see Findings).

```js
plugins: [{ module: 'capability/plugin.js', prefix: '/cap',
            config: {
              resources: { 'report.pdf': '…seed content…' }, // optional read-only seeds
              defaultTtl: 3600,      // seconds, when a grant omits ttl
              maxTtl: 2592000,       // hard ceiling (30 days)
              maxBytes: 1048576,     // write-capability body ceiling
            } }]
```

## Usage

```bash
# 1. Mint (must be signed in — any credential scheme the host accepts):
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{ "resource": "report.pdf", "modes": ["read"], "ttl": 86400 }' \
     https://pod.example/cap/issue
# → { "url": "/cap/r/v1.eyJ2IjoxLCJqdGkiOi…", "token": "…", "jti": "…", "exp": … }

# 2. Hand the URL to anyone. Using it needs NO credential — possession is auth:
curl https://pod.example/cap/r/v1.eyJ2IjoxLCJqdGkiOi…

# 3. Revoke (issuer only), by token or by jti:
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{ "jti": "…" }' https://pod.example/cap/revoke
```

Modes: `read` (GET/HEAD), `write` (PUT/POST — body lands in the plugin's
store and is visible to later read capabilities: the #506 inbox/drop-box
case). A grant may carry both.

## Token format (macaroon-lite)

```
v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, "v1." + payloadB64))>

payload = {
  v: 1,                 format version
  jti: <128-bit random> unique id — the unit of revocation
  iss: <agent id>       verified issuer (WebID / did:nostr) at mint time
  res: <name>           canonical resource name, e.g. "report.pdf"
  modes: ["read"],      granted verbs
  iat, exp              issued-at / expiry, unix seconds
}
```

The token is **self-describing and self-verifying** — no database lookup
on the read path. The server checks, in order: HMAC signature
(timing-safe), expiry, revocation list, then that the request method is
inside `modes`. Everything the capability grants is inside the signed
payload; tampering with any field kills the signature.

State kept in `api.storage.pluginDir()` (dot-guarded, never served):

- `secret` — 32 random bytes, generated once (mode 0600). Signing key.
- `revoked.json` — `jti → exp`: revoked ids, kept until the token would
  have expired anyway (replay protection per #506), then pruned at boot.
- `issued.json` — `jti → { iss, exp }`: convenience index so an issuer can
  revoke by `jti` without having kept the token. Pruned at expiry; revoking
  by full token needs no index at all.
- `store/` — where write capabilities land and read capabilities look
  first (config seeds are the fallback).

## Security model

- **Bearer semantics**: whoever holds the URL has exactly the granted
  scope until `exp` or revocation — that is the feature. Responses carry
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer` (the #506
  Referer-leak note); tokens ride the path, so operators should scrub
  `{prefix}/r/` from access logs (a plugin cannot — see Findings).
- **Unforgeable, not just unguessable**: minting requires the server-side
  256-bit HMAC secret; the 128-bit random `jti` additionally makes every
  token unique. Signature comparison is `crypto.timingSafeEqual`.
- **Scope-minimal**: exact resource, explicit verb set, mandatory expiry
  (`maxTtl` ceiling), write-body byte ceiling. No wildcards.
- **Mint requires identity, use does not**: `POST /cap/issue` goes through
  `api.auth.getAgent` — every credential scheme the host accepts. The
  verified agent id is baked into the token as `iss`, and only that agent
  may revoke it.
- **Deviation from #506**: the issue signs tokens with the *issuer's*
  Nostr key so third parties could verify provenance. That key machinery
  is `src/auth/nostr-keys.js` — internal, unreachable under the repo rule
  — so this port signs with a per-plugin server secret instead. Same
  bearer semantics; the trade is that only the minting server can verify,
  and `iss` is trusted server attestation rather than issuer signature.
  Key rotation (delete `secret`) invalidates all outstanding capabilities,
  matching the issue's rotation note.
- **Not implemented from #506** (out of scope for a boundary probe):
  use-count ledgers (`uses: 1`), `nbf`, content-type/byte constraints
  beyond the global write ceiling, attenuated delegation.

## Findings

1. **Capabilities for the plugin's OWN resources need zero seams — the
   headline.** Everything #506's core loop requires is already on the
   plugin api: `api.auth.getAgent` gates minting (any credential scheme),
   `pluginDir()` holds the secret + revocation ledger, and the prefix's
   appPaths exemption (#582) is precisely what lets `GET {prefix}/r/<tok>`
   through with no credential so the capability itself can be the auth.
   Fully self-contained; no internals touched.
2. **Extending grants to arbitrary POD resources is the boundary — core,
   not plugin.** #506's verification path ends "synthesize a virtual agent
   … WAC check is bypassed — the capability IS the authorization". A
   plugin cannot do that step: it can neither tell WAC to treat a request
   as authorized nor read a WAC-protected resource on a holder's behalf.
   The notifications port's loopback trick doesn't transfer — loopback
   carries the *requester's* credentials, but a capability must exercise
   the *issuer's* authority, and impersonating the issuer would mean the
   plugin holding issuer credentials (unacceptable). The missing seam is a
   WAC integration point — e.g. `api.wac.grant(request, { agent, resource,
   modes })` scoped to one request, or core detecting `?cap=` in its own
   auth middleware. So the split is: capability *service* (mint / verify /
   revoke / token format) fits a plugin; capability *authorization over
   pod resources* is core. This demo therefore governs its own resource
   space (config seeds + `pluginDir()/store`) — which already covers
   #506's drop-box and time-bound-share cases end-to-end.
3. **`maxParamLength` bites token-in-path designs.** Fastify's default
   named-param limit (100 chars) silently 404s a ~300-char token; a plugin
   cannot change server options, so the route must be a wildcard
   (`{prefix}/r/*`). Worth a line in the plugin docs.
4. **No issuer-key signing from a plugin.** #506 wants tokens signed with
   the key the issuer's WebID already declares (`src/auth/nostr-keys.js`)
   — internal. A public "sign/verify as this agent's declared key" surface
   would let a plugin issue tokens verifiable by third parties instead of
   only by the minting server. Candidate seam, not a blocker: HMAC covers
   the single-server case fine.
5. **Log scrubbing needs a host knob.** #506 asks that cap tokens never
   reach access logs. A plugin can set response headers on its own routes
   but cannot redact the host's request logging. (Same family as the
   notifications header-injection finding: response/log hooks.)
