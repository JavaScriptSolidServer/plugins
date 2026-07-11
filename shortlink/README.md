# shortlink

A link shortener for pod resources. Long pod URLs
(`/alice/notes/2026/07/a-very-long-resource-name….html`) become short,
shareable redirect links (`/s/x7Kp2Qa`) — with custom slugs, per-creator
ownership, hit counts, and a preview mode. **Local targets only**: this is a
pod-resource shortener, not an open redirector.

## Usage

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const server = createServer({
  plugins: [{
    id: 'shortlink',
    module: './plugins/shortlink/plugin.js',
    prefix: '/s',
    config: { baseUrl: 'https://pod.example' },   // required
  }],
});
```

`baseUrl` is required (the plugin throws at activate without it — no
`api.serverInfo`, the usual finding): it is both the locality boundary for
targets and the origin the minted `short` URLs carry.

| Route | Auth | Does |
|---|---|---|
| `POST {prefix}` | bearer | `{ url, slug? }` → 201 `{ short, slug, url, created }` |
| `GET {prefix}` | bearer | list the caller's own links (with hit counts) |
| `GET {prefix}/<slug>` | none | 302 → target, `Cache-Control: no-store`; `?preview=1` → the record as JSON |
| `DELETE {prefix}/<slug>` | bearer, creator only | 204 |

Slugs: omit `slug` for a minted 7-char base62 one; a custom slug is
lowercased and must match `[a-z0-9-]{1,64}`. A slug held by another agent →
409; the same agent re-posting the same `url`+`slug` is idempotent (200,
nothing rewritten).

## A curl session

```sh
# mint a pod bearer
TOKEN=$(curl -s -X POST https://pod.example/idp/credentials \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"…"}' | jq -r .access_token)

# shorten a long pod URL
curl -s -X POST https://pod.example/s -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://pod.example/alice/notes/2026/07/quarterly-numbers.html"}'
# → 201 {"short":"https://pod.example/s/x7Kp2Qa","slug":"x7Kp2Qa","url":"…","created":"…"}

# …or claim a custom slug
curl -s -X POST https://pod.example/s -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://pod.example/alice/notes/2026/07/quarterly-numbers.html","slug":"q2"}'

# follow it (anyone, no auth — the TARGET still enforces its own WAC)
curl -si https://pod.example/s/q2 | grep -iE 'HTTP|location|cache-control'
# HTTP/1.1 302 Found
# location: https://pod.example/alice/notes/2026/07/quarterly-numbers.html
# cache-control: no-store

# see where it goes without going (safety affordance; not counted as a hit)
curl -s https://pod.example/s/q2?preview=1
# {"short":"…","slug":"q2","url":"…","created":"…","agent":"https://pod.example/alice/profile/card#me","hits":3}

# an external target is refused — not an open redirector
curl -s -X POST https://pod.example/s -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"url":"https://evil.example/phish"}'
# → 400

# my links, and cleanup (creator only)
curl -s https://pod.example/s -H "authorization: Bearer $TOKEN"
curl -s -X DELETE https://pod.example/s/q2 -H "authorization: Bearer $TOKEN"   # 204; others get 403
```

## What maps / what doesn't

**Maps cleanly:** authed minting via `api.auth.getAgent` (any credential
scheme); per-creator ownership from the same agent id; a JSON table in
`api.storage.pluginDir()`; one exact route (`{prefix}` for POST/list)
coexisting with a wildcard (`{prefix}/*` for slug GET/DELETE) — Fastify
prefers the more specific match, no tricks needed.

**Doesn't:** the plugin can't learn its own origin (`config.baseUrl`
required — `api.serverInfo` seam); it can't raise `maxParamLength`, so slug
routes are wildcards after capability/'s finding; and there is no guidance
on *where plugin state should live* — see finding 4.

## Findings

1. **No open redirector, by decision.** Targets must live under
   `config.baseUrl` — anything else is 400. An unauthenticated 302 to
   arbitrary URLs is phishing infrastructure: the pod's domain reputation
   would launder any destination, and every mail filter that trusts the pod
   host would trust the phish. Locality is enforced by **parsed-origin
   comparison, never `url.startsWith(baseUrl)`** — the string check accepts
   `https://pod.example.evil.test` when baseUrl is `https://pod.example`
   (the classic open-redirect-filter bypass; the test suite drives it).
   The corollary is the nice part: because every target is local,
   redirecting to a **WAC-protected** resource is perfectly safe — the 302
   grants nothing, the pod runs its own auth when the client arrives, and
   an anonymous follower of a short link to a private note gets the pod's
   401, not the note. A loopback-free demonstration that **route ownership
   ≠ authority**: the plugin names resources, it never confers access to
   them. (Same boundary capability/ documents from the other side.) Bonus
   hygiene for free: local-only targets mean the redirect can never leak a
   Referer to a third-party host, so no `Referrer-Policy` gymnastics needed.
2. **`pluginDir` JSON-table persistence — the 11th witness.** One file
   (`links.json`, slug → `{ url, agent, created, hits }`), loaded into a
   `Map` at activate, written back on mutation — otp/'s shape verbatim.
   Eleven of the repo's plugins now persist through `pluginDir()` (relay,
   capability, otp, activitypub, gitscratch, mastodon, oembed, search,
   terminal, didweb, shortlink); the pattern costs ~10 lines every time and
   has never needed anything from core. It is easily the most settled seam
   in the api.
3. **Hit-counter durability: fire-and-forget, on purpose.** Creates and
   deletes are written synchronously (a link must never be lost), but the
   redirect path increments in memory and flushes asynchronously on a
   serialized promise chain — the 302 must not wait on disk. A crash loses
   recent *counts*, never *links*. A real deployment that cared about the
   numbers would want an append-only hit log (WAL) replayed into the table
   at boot, or batched interval flushes with the loss window made explicit
   — and past one process, a real datastore, because a rewritten JSON
   snapshot has no cross-process story at all. Counts here are advisory;
   that's the honest label.
4. **Where should plugin state live? `pluginDir` vs pod resources — a
   design-note seam.** Short links on a *pod* server would more naturally
   be POD RESOURCES: a `/alice/shortlinks/` container the owner controls,
   WAC-governed, portable, visible to other apps. But walk it through: the
   CREATE path becomes a micropub-style loopback write into the pod, and —
   the killer — every REDIRECT becomes a loopback read per hit, turning the
   hottest, cheapest route (a Map lookup and a 302) into an internal HTTP
   round-trip; the hit counter would be a read-modify-write per hit against
   WAC. So this plugin chose `pluginDir` for latency, and the cost is real:
   the links are invisible to the pod's own tooling, don't back up with the
   pod (backup/ won't see them), don't move if the pod moves, and deletion
   rights ride the plugin's own `agent ===` check instead of WAC. Neither
   answer is wrong; the point is **the api gives no guidance** — `storage`
   offers exactly one primitive (`pluginDir()`) and no doctrine for when
   state belongs in the pod instead. A `storage` design note (rule of
   thumb: *pod for user-owned durable data an owner should see and control;
   pluginDir for indexes, secrets, and hot operational state — and say
   which one your plugin picked*) would do more for consistency across
   plugins than any new primitive. shortlink's records are arguably
   user-owned durable data serving as hot operational state — precisely the
   case the missing note needs to adjudicate.
5. **`maxParamLength` avoided pre-emptively (capability/'s finding pays
   off).** Slugs are ≤ 64 chars, under Fastify's 100-char named-param
   limit, so `:slug` would *work* — but any request with a longer garbage
   slug would 404 at the *router* with Fastify's default body instead of
   this plugin's JSON error. Since a plugin can't set server options, the
   slug routes are wildcards (`{prefix}/*`, reject anything containing
   `/`), which handles arbitrary-length input uniformly; the suite drives a
   150-char slug and asserts *our* 404 body answered. Second consumer for
   the "can't set Fastify server options" note, this time as dodge rather
   than bite.
6. **`Cache-Control: no-store` on the 302 is what makes DELETE real.** A
   cacheable redirect outlives its record — an intermediary that cached the
   302 would keep resolving a deleted (or worse, a *reassigned*) slug.
   Every slug-route response carries `no-store`, and the deletion test
   passes because of it. Redirect hygiene is two lines, but only if you
   remember them.
