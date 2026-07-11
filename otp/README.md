# otp — one-time-password auth plugin (#505)

Out-of-tree exploration of
[#505](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/505):
a challenge / verify / **session** primitive for the three cases where JSS
has no story today — low-friction first-touch auth for someone with no
WebID, one-shot claims, and (as far as a plugin can reach) account recovery.
Not a port of core code — core has no OTP path yet; this is the
plugin-shaped probe of the design, and of where its boundary with core lies
(see Findings).

```js
plugins: [{ module: 'otp/plugin.js', prefix: '/otp',
            config: {
              // THE integration point — real delivery lives here:
              channel: async (identifier, code, purpose) => { /* email/SMS/DM */ },
              codeLength: 6,               // 6–8 digits
              ttl: 300,                    // code lifetime, seconds
              maxTtl: 3600,                // ceiling for a per-request ttl override
              sessionTtl: 900,             // minted session-token lifetime, seconds
              maxAttempts: 5,              // wrong tries before a row locks
              rateLimitPerIdentifier: 5,   // token-bucket capacity / rateWindow
              rateLimitPerIp: 20,
              rateWindow: 60,              // seconds
              exposeTestbox: false,        // NEVER true in production
            } }]
```

## Usage

```bash
# 1. Request a code. No auth — requesting proves nothing, only verifying does.
curl -X POST -H "Content-Type: application/json" \
     -d '{ "identifier": "bob@example.com", "purpose": "session" }' \
     https://pod.example/otp/request
# → { "ok": true, "identifier": "bob@example.com", "purpose": "session", "expiresIn": 300 }
#   The code itself is delivered ONLY over the channel — never in the response.

# 2. Verify the code Bob received. On success a plugin-scoped session token is minted.
curl -X POST -H "Content-Type: application/json" \
     -d '{ "identifier": "bob@example.com", "code": "419273", "purpose": "session" }' \
     https://pod.example/otp/verify
# → { "token": "otp1.eyJ2Ijox…", "identifier": "bob@example.com", "purpose": "session", "exp": … }

# 3. Use the session token. This is an OTP session, NOT a pod credential.
curl -H "Authorization: Bearer otp1.eyJ2Ijox…" https://pod.example/otp/whoami
# → { "identifier": "bob@example.com", "purpose": "session", "exp": … }
```

`purpose` ∈ `session` | `claim` | `recovery`:

- **session** — low-friction first-touch auth for a recipient who has no
  WebID yet (the #505 "delegated read / one-shot interaction" case).
- **claim** — a one-shot right to drop something. Designed to hand off to
  the [`capability/`](../capability) plugin (see Findings).
- **recovery** — proves the requester controls the registered channel. That
  is *all* a plugin can prove; actually restoring pod access (rebinding a
  new key into a WebID's `authentication` set) is a core seam this plugin
  cannot reach (see Findings).

## The channel adapter (the integration point)

`POST /otp/request` generates the code and hands it to a **channel adapter**
for out-of-band delivery. That adapter is the one seam a real deployment
must fill:

```js
config.channel = async (identifier, code, purpose) => {
  await sendEmail(identifier, `Your ${purpose} code is ${code}`);
};
```

Real email / SMS / Nostr-DM delivery is deliberately **out of scope** — it
is transport, not OTP logic, and every deployment wires it differently. The
plugin's contract is: generate, hash-at-rest, rate-limit, expire,
single-use, lock, mint session. Delivery is `config.channel`.

With **no** channel configured, a built-in **console/test channel** records
each `{ identifier, purpose, code }` in an in-memory outbox and logs a
notice. That outbox is readable at `GET /otp/_testbox` **only when
`config.exposeTestbox` is `true`** — it exists so the test can read a code.
It leaks live codes; a production config must never set it.

## Session token format (HMAC, macaroon-lite — same shape as capability/)

```
otp1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, "otp1." + payloadB64))>

payload = {
  v: 1,                 format version
  sub: <identifier>     the channel identifier the OTP proved control of
  purpose: session|claim|recovery
  iat, exp              issued-at / expiry, unix seconds
  jti: <96-bit random>  unique id
}
```

Self-describing and self-verifying — `whoami` needs no database lookup.
`crypto.timingSafeEqual` on the signature; tampering with any field kills it.

State kept in `api.storage.pluginDir()` (dot-guarded, never served):

- `secret` — 32 random bytes, generated once (mode 0600). HMAC key for both
  session tokens and the code hashes.
- `otp.json` — the OTP table, `identifier\0purpose → { hash, iat, exp,
  attempts_remaining, locked }`. One live code per (identifier, purpose); a
  new request supersedes the old. Expired rows pruned at boot.

## Security model

- **Codes hashed at rest.** The table stores `HMAC-SHA256(secret,
  identifier\npurpose\ncode)`, never the plaintext. After generation the
  code lives only in transit over the channel. Verify recomputes the hash
  and compares with `crypto.timingSafeEqual` (constant width, constant time).
- **Single-use, consumed atomically.** A correct verify deletes the row
  before minting — Node's single-threaded turn makes the check-and-consume
  indivisible; a replay finds no row.
- **Attempt lockout.** Each wrong code decrements `attempts_remaining`; at
  zero the row locks (`423 Locked`) and even the correct code is refused
  until a new one is requested.
- **Short TTL.** Codes expire (`ttl`, default 5 min); an optional
  per-request `ttl` is capped by `maxTtl`. Sessions expire (`sessionTtl`).
- **Rate limited per identifier AND per source IP.** Independent in-memory
  token buckets (capacity / `rateWindow`), the #505 brief. Process-local —
  the right scope for a throttle; not promised across restarts or nodes.
- **Plugin-scoped session, not a pod credential.** The `otp1.` token is
  verified by this plugin alone and is *not* checked by `api.auth`. It
  proves "this channel was controlled at this time", nothing about a pod.

Not implemented (out of scope for a boundary probe): pre-registered/confirmed
recovery-channel enrollment (an admin tool the issue itself defers), an
audit log surface, channel-binding a session to a device, TOTP/WebAuthn.

## Findings

1. **OTP as a low-friction SESSION is fully self-contained — the headline.**
   The whole challenge → verify → session loop needs zero server internals.
   `pluginDir()` holds the secret + OTP table; `node:crypto` covers code
   generation, hashing-at-rest, and HMAC session tokens; the prefix's
   appPaths exemption (#582) lets `POST {prefix}/request|verify` and `GET
   {prefix}/whoami` run credential-free, which is exactly right — the point
   of OTP is to serve callers who have no credential yet. For
   `purpose=session` this reproduces #505's low-friction first-touch and
   time-bound delegated-read cases end-to-end, no core changes.

2. **Recovery and real pod credentials are the boundary — core, not plugin
   (cross-ref capability/'s WAC finding).** #505's recovery flow ends
   "mint a recovery session bound to the WebID … register a new key in the
   profile's `authentication` set", and its `session` case wants "a real
   Bearer/DPoP token for normal auth". A plugin can do neither. It can
   prove *channel control*; it cannot rebind keys in a pod's WebID, nor
   issue a credential the host's `api.auth` (NIP-98 / Solid-OIDC / Bearer,
   `src/auth/*`) will honour — those live in server internals the repo RULE
   forbids, and a plugin holding the authority to mint pod credentials would
   be exactly the trust concentration to avoid. This is the **same shape**
   as [`capability/`](../capability)'s finding #2: the *service* (challenge,
   hash-at-rest, single-use, lockout, rate-limit, session) fits a plugin;
   turning a proven channel into *pod authority* is a core seam. Candidate:
   an `api.auth.mintSession({ subject, ttl, scope })` (session case) and an
   `api.identity.addAuthKey(webid, key)` under a recovery grant (recovery
   case) — the missing seams, not blockers for the session use.

3. **`purpose=claim` is a clean hand-off to `capability/`.** #505's
   claim-capability purpose "mark a paired capability URI as activated"
   maps onto the sibling plugin: OTP proves the recipient controls the
   channel, then a `capability/` write grant is honoured. Today that
   hand-off would be config/orchestration between two plugins (OTP verifies,
   caller then presents a cap URL); a first-class seam would be OTP calling
   into the capability plugin to flip a `requiresOtp` flag on a specific
   `jti`. Both are plugin-space — the pair already covers the drop-box case
   without touching core, which is the encouraging half of the boundary.

4. **Channel delivery is intentionally a config seam, and that is correct.**
   Unlike the WAC/credential walls above, "send an email" is not a missing
   *core* capability — it is deployment transport. Exposing it as
   `config.channel` keeps the plugin honest (no npm mail dep, no internals)
   and matches #505's pluggable-adapter design. The only host knob that
   would help is a shared outbound-notification surface so several plugins
   (this, `notifications/`) share one delivery config — a convenience, not a
   blocker.
