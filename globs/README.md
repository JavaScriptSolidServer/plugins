# globs — NEONGLOBS realtime match server

Ranked online play for [NEONGLOBS](https://melvincarvalho.github.io/neonglobs/)
(a Globulos tribute): matchmaking, server-authoritative physics, three bot
levels, ELO ratings, and a leaderboard — as a #206 loader plugin.

```js
plugins: [{ id: 'globs', module: 'globs/plugin.js', prefix: '/globs' }]
```

- `WS {prefix}/play` — the match protocol (documented at the top of
  `plugin.js`): `hello` → `queue` → `matched` → per round
  `phase`/`commit`/`reveal`/`result` → `matchEnd`.
- `GET {prefix}/leaderboard` — top 50 by rating, player count, bot anchors.

## Why this game networks so well

NEONGLOBS rounds are *simultaneous secret commitments* resolved by a
deterministic, fixed-timestep sim — a round is a pure function of its
commitments. So the server relays one small message per round, re-runs the
same sim as the single authority, and never streams a tick. `./sim.js` is
vendored from the game repo, where `tools/parity.sh` proves node and
headless Chromium produce **bit-identical** match results for the same
seeds (that took work — see findings).

## Identity and ranking

`api.auth.getAgent` on the WS upgrade (node clients send `Authorization`);
browsers use `POST {prefix}/session` — any credential `getAgent`
understands (bearer, DPoP, **NIP-98**) authenticates a real HTTP request
and buys a 24h HMAC macaroon-lite session (pattern #4; secret in
`pluginDir`) that the socket presents as `hello{session}`. This is how
[xlogin](https://github.com/melvincarvalho/xlogin) users (Nostr extension /
guest key / Solid OIDC) get onto the leaderboard. A raw pod bearer still
works in-band as `hello{token}`. Guests play unrated. ELO: start 1200, K=32 vs humans, K=16 vs bots; bots are fixed
anchors (EASY 800 / MEDIUM 1100 / HARD 1400) that never move. Both deltas
are computed from pre-match ratings before either is applied. Disconnect
mid-match forfeits. State: `elo.json` (atomic tmp+rename) and
`matches.jsonl` in `pluginDir`.

## Findings

- **`ws.route` + `getAgent` + `pluginDir` covered the whole service** — a
  ranked realtime game server needed nothing beyond the documented surface.
  Zero new seams.
- **Browser WS auth is the same gap every WS plugin has**: browsers cannot
  set upgrade headers. The bearer-only in-band lift (`hello{token}`) works
  because bearer verification reads only headers — but DPoP and NIP-98 are
  signed over a method+URL and cannot ride it. The resolution is the
  session bridge: authenticate a REAL `POST /session` request (all schemes
  verify naturally), hand back an HMAC macaroon-lite the socket can
  present. That combination — pattern #1's "real request" + pattern #4's
  self-verifying token — is probably the canonical answer for any WS
  plugin wanting full-scheme auth.
- **Cross-engine float determinism is real and it bites.** With stock
  `Math.hypot`/`Math.sin`/`Math.cos`/`Math.atan2`/`Math.pow`, node 24 and
  Chromium disagreed on 4 of 20 solver-mirror matches (implementation-
  defined precision; knife-edge games amplify ulps). The game and this
  vendored sim now use `sqrt(x²+y²)`, a pinned FRICTION literal, and
  range-reduced Taylor-series trig — after which 40/40 matches are
  bit-identical across engines. Any plugin that replays client physics
  should expect this.
- **The server pushes `welcome` immediately after upgrade**, which beats a
  message listener attached after the client's `open` event — the test
  buffers from socket creation. Same race webrtc/ fixed on the server side
  for the opposite direction.

## What maps / what doesn't

Maps: the full ranked-match loop, bots, leaderboard, forfeits, keepalive
pings. Doesn't: spectators, reconnection grace (disconnect = forfeit),
multiple tables (soccer only, like the game), and rating decay — all
protocol-compatible extensions, none blocked by the api.
