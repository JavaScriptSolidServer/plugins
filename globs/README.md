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

`api.auth.getAgent` on the WS upgrade (node clients send `Authorization`),
or `hello{token}` for browsers — the token is lifted to an agent via
`getAgent` with a synthetic headers-only request, which the `auth.js`
contract documents as sufficient for bearer verification. Guests play
unrated. ELO: start 1200, K=32 vs humans, K=16 vs bots; bots are fixed
anchors (EASY 800 / MEDIUM 1100 / HARD 1400) that never move. Both deltas
are computed from pre-match ratings before either is applied. Disconnect
mid-match forfeits. State: `elo.json` (atomic tmp+rename) and
`matches.jsonl` in `pluginDir`.

## Findings

- **`ws.route` + `getAgent` + `pluginDir` covered the whole service** — a
  ranked realtime game server needed nothing beyond the documented surface.
  Zero new seams.
- **Browser WS auth is the same gap every WS plugin has**: browsers cannot
  set upgrade headers, so the plugin lifts a bearer sent in-band
  (`hello{token}`) via `getAgent({ headers: { authorization } , ... })`.
  Works because bearer verification only reads headers; a DPoP-bound token
  would not survive this path (documented limitation, same as core's
  `.webrtc`).
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
