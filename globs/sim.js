// VENDORED from neonglobs@b7f930e (https://github.com/melvincarvalho/neonglobs
// sim.js) — the parity-tested deterministic sim. Sync manually when the game's
// physics change; neonglobs/tools/parity.sh is the drift alarm on that side.
// NEONGLOBS sim core — Copyright © 2026 Melvin Carvalho — AGPL-3.0-or-later
//
// A standalone, state-passing port of game.js's deterministic simulation:
// physics (fixed dt = 1/120, one resolution path), the elimination rule,
// and the aim bots. No DOM, no globals, no Date — a round is a pure
// function of (state, commitments), and a match of (seed, inputs).
//
// PARITY CONTRACT: this module must produce bit-identical results to
// game.js for the same seed and bot kinds. tools/parity.sh enforces it by
// running the same seeds through node (this file) and headless Chromium
// (game.js ?autoplay) and diffing the scorelines. If you touch physics or
// bots in either file, change both, then run parity.
//
// Determinism note (finding): Math.hypot and Math.pow are implementation-
// defined precision in ECMAScript. Both sides of the parity test run V8
// (node + Chromium), where they agree. A JavaScriptCore/SpiderMonkey client
// may diverge by ulps over a long round — which is why a server using this
// module must stay authoritative and clients must snap to its results.

// IEEE-exact length (see determinism note above)
const hyp = (x, y) => Math.sqrt(x * x + y * y);

// Deterministic trig for the sim path: library sin/cos/atan2 are
// implementation-defined precision and diverge across engines/versions.
// Range-reduce, then a fixed Taylor series — every op IEEE-exact.
function sinD(x) {
  const TAU = Math.PI * 2;
  x = x - Math.floor(x / TAU) * TAU;          // [0, 2pi)
  if (x > Math.PI) x -= TAU;                  // (-pi, pi]
  if (x > Math.PI / 2) x = Math.PI - x;
  else if (x < -Math.PI / 2) x = -Math.PI - x;
  const x2 = x * x;
  return x * (1 - x2 / 6 * (1 - x2 / 20 * (1 - x2 / 42 * (1 - x2 / 72 * (1 - x2 / 110)))));
}
function cosD(x) { return sinD(x + Math.PI / 2); }


export const PL = 120, PR = 1160, PT = 120, PB = 636;
export const GY0 = 288, GY1 = 468;
export const POCKET = 40;
export const GLOB_R = 20, BALL_R = 12;
export const MAXV = 860;
export const AIM_TIME = 18;
export const WIN_SCORE = 3;
export const DT = 1 / 120;
const FRICTION = 0.99001705700621589;    // pow(0.30, 1/120), pinned as a literal — pow is engine-defined
const REST_WALL = 0.82, REST_GLOB = 0.92, REST_BALL = 0.96;
const STOP_V = 7, SIM_MAX = 5.0;
const BALL_M = 0.45, GLOB_M = 1;
const MIDX = 640;                          // game.js's W / 2
const GOALX = [PL, PR];                    // TEAMS[t].goalX

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// same LCG as game.js, carried in the state so matches never share a stream
function srand(st, s) { st._seed = (s >>> 0) || 1; }
function rnd(st) { st._seed = (st._seed * 1664525 + 1013904223) >>> 0; return st._seed / 4294967296; }

function kickoffPositions(st) {
  const cx = (PL + PR) / 2, cy = (PT + PB) / 2;
  const globs = [];
  const form = [[-160, 0], [-320, -140], [-320, 140], [-460, 0]];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 4; i++) {
      const [fx, fy] = form[i];
      globs.push({
        team: t, idx: i, r: GLOB_R,
        x: cx + fx * (t === 0 ? 1 : -1), y: cy + fy,
        vx: 0, vy: 0, sq: 0, sqx: 1, sqy: 0, blink: rnd(st) * 4,
      });
    }
  }
  return globs;
}

export function makeMatch(seed) {
  const st = { _seed: 1 };
  srand(st, seed);
  st.seed = seed;
  st.round = 1;
  st.score = [0, 0];
  st.globs = kickoffPositions(st);
  st.ball = { x: (PL + PR) / 2, y: (PT + PB) / 2, vx: 0, vy: 0, r: BALL_R };
  st.winner = -1;
  st.rounds = 0;
  return st;
}

export function resetKickoff(st) {
  const s = st._seed;                      // keep rng continuity, as game.js does
  st.globs = kickoffPositions(st);
  st.ball.x = (PL + PR) / 2; st.ball.y = (PT + PB) / 2; st.ball.vx = 0; st.ball.vy = 0;
  st._seed = s;
}

function bodies(st) { return [...st.globs.filter(g => !g.dead), st.ball]; }

function globInGoal(g) {
  if (g.y > GY0 && g.y < GY1) {
    if (g.x < PL - 10) return true;
    if (g.x > PR + 10) return true;
  }
  return false;
}

function wallCollide(b) {
  const inMouth = b.y - b.r > GY0 - 6 && b.y + b.r < GY1 + 6;
  let L = PL, R = PR;
  if (inMouth) { L = PL - POCKET; R = PR + POCKET; }
  if (b.x - b.r < L) { b.x = L + b.r; b.vx = Math.abs(b.vx) * REST_WALL; return true; }
  if (b.x + b.r > R) { b.x = R - b.r; b.vx = -Math.abs(b.vx) * REST_WALL; return true; }
  if (b.y - b.r < PT) { b.y = PT + b.r; b.vy = Math.abs(b.vy) * REST_WALL; return true; }
  if (b.y + b.r > PB) { b.y = PB - b.r; b.vy = -Math.abs(b.vy) * REST_WALL; return true; }
  if (!inMouth) {
    if (b.x - b.r < PL) { b.x = PL + b.r; b.vx = Math.abs(b.vx) * REST_WALL; return true; }
    if (b.x + b.r > PR) { b.x = PR - b.r; b.vx = -Math.abs(b.vx) * REST_WALL; return true; }
  }
  return false;
}

function pairCollide(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr || d2 === 0) return null;
  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const ma = a.r === BALL_R ? BALL_M : GLOB_M;
  const mb = b.r === BALL_R ? BALL_M : GLOB_M;
  const overlap = rr - d;
  const tot = ma + mb;
  a.x -= nx * overlap * (mb / tot); a.y -= ny * overlap * (mb / tot);
  b.x += nx * overlap * (ma / tot); b.y += ny * overlap * (ma / tot);
  const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return null;
  const e = (a.r === BALL_R || b.r === BALL_R) ? REST_BALL : REST_GLOB;
  const j = -(1 + e) * vn / (1 / ma + 1 / mb);
  a.vx -= j * nx / ma; a.vy -= j * ny / ma;
  b.vx += j * nx / mb; b.vy += j * ny / mb;
  return { nx, ny, impact: Math.abs(vn) };
}

export function ballInGoal(st) {
  const b = st.ball;
  if (b.y > GY0 && b.y < GY1) {
    if (b.x + b.r < PL - 6) return 1;
    if (b.x - b.r > PR + 6) return 0;
  }
  return -1;
}

export function simStep(st, events) {
  for (const b of bodies(st)) {
    b.x += b.vx * DT; b.y += b.vy * DT;
    b.vx *= FRICTION; b.vy *= FRICTION;
    if (Math.abs(b.vx) < 2) b.vx *= 0.9;
    if (Math.abs(b.vy) < 2) b.vy *= 0.9;
    wallCollide(b);
  }
  for (const g of st.globs) {
    if (!g.dead && globInGoal(g)) {
      g.dead = true;
      if (events) events.push({ death: { team: g.team, idx: g.idx } });
    }
  }
  const bs = bodies(st);
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    pairCollide(bs[i], bs[j]);
  }
}

export function settled(st) {
  return bodies(st).every(b => hyp(b.vx, b.vy) < STOP_V);
}

export function launchCommits(st, commits) {
  for (let t = 0; t < 2; t++) for (const g of st.globs) {
    if (g.team !== t || g.dead) continue;
    const c = commits[t][g.idx];
    if (c) { g.vx = c.vx; g.vy = c.vy; }
  }
}

// resolve one committed round. Mutates state. Returns { scorer, deaths }.
export function simRound(st, commits) {
  launchCommits(st, commits);
  let t = 0, scorer = -1;
  while (t < SIM_MAX) {
    simStep(st, null);
    t += DT;
    const sc = ballInGoal(st);
    if (sc >= 0) { scorer = sc; break; }
    if (t > 0.4 && settled(st)) break;
  }
  // deaths are flagged on the globs; report every current casualty
  return { scorer, deaths: st.globs.filter(g => g.dead).map(g => ({ team: g.team, idx: g.idx })) };
}

// apply a full round with scoring rules: returns { scorer, end }
export function applyRound(st, commits) {
  const { scorer } = simRound(st, commits);
  st.rounds++;
  if (scorer >= 0) {
    st.score[scorer]++;
    if (st.score[scorer] >= WIN_SCORE) st.winner = scorer;
    else resetKickoff(st);
  }
  st.round++;
  return { scorer, end: st.winner >= 0 };
}

// ---------- bots (identical maths + rng order to game.js) ----------
function aimAt(g, tx, ty, power) {
  const dx = tx - g.x, dy = ty - g.y;
  const d = hyp(dx, dy) || 1;
  const v = clamp(power, 120, MAXV);
  return { vx: dx / d * v, vy: dy / d * v };
}
function jitter(st, c, deg, pj) {
  if (!deg) return c;
  // rotate by a small random angle via exact series — no atan2/cos/sin
  const d = (rnd(st) * 2 - 1) * deg * Math.PI / 180;
  const cd = cosD(d), sd = sinD(d);
  const s = 1 + (rnd(st) * 2 - 1) * pj;
  return { vx: (c.vx * cd - c.vy * sd) * s, vy: (c.vx * sd + c.vy * cd) * s };
}

export function botCommits(st, team, kind, aiLevel = 1) {
  const commits = {};
  const mine = st.globs.filter(g => g.team === team && !g.dead);
  if (!mine.length) return commits;
  if (kind === 'random') {
    for (const g of mine) {
      const a = rnd(st) * Math.PI * 2, v = 200 + rnd(st) * (MAXV - 200);
      commits[g.idx] = { vx: cosD(a) * v, vy: sinD(a) * v };
    }
    return commits;
  }
  const noise = kind === 'solver' ? 2 : [22, 11, 4][aiLevel];
  const pj = kind === 'solver' ? 0.03 : [0.3, 0.18, 0.06][aiLevel];
  const ball = st.ball;
  const enemyGoalX = team === 0 ? PR + POCKET : PL - POCKET;
  const ownGoalX = GOALX[team];
  const gy = (GY0 + GY1) / 2;
  const sorted = mine.slice().sort((a, b) => hyp(a.x - ball.x, a.y - ball.y) - hyp(b.x - ball.x, b.y - ball.y));
  sorted.forEach((g, role) => {
    let c;
    const db = hyp(g.x - ball.x, g.y - ball.y);
    if (role <= 1) {
      const aimY = role === 0 ? gy : (ball.y > gy ? GY0 + 40 : GY1 - 40);
      const gdx = enemyGoalX - ball.x, gdy = aimY - ball.y;
      const gd = hyp(gdx, gdy) || 1;
      const ghostX = ball.x - gdx / gd * (g.r + ball.r);
      const ghostY = ball.y - gdy / gd * (g.r + ball.r);
      const wrongSide = (team === 0 && g.x > ball.x + 8) || (team === 1 && g.x < ball.x - 8);
      if (wrongSide) c = aimAt(g, ball.x - Math.sign(enemyGoalX - ball.x) * 120, ball.y + (g.y > ball.y ? 90 : -90), 500);
      else c = aimAt(g, ghostX, ghostY, clamp(db * 2.4 + 260, 300, MAXV));
    } else if (role === 3) {
      const kx = ownGoalX + (team === 0 ? 70 : -70);
      const ky = clamp(ball.y, GY0 + 30, GY1 - 30);
      const d = hyp(kx - g.x, ky - g.y);
      c = d < 30 ? { vx: 0, vy: 0 } : aimAt(g, kx, ky, clamp(d * 2.2, 160, 700));
    } else {
      const foes = st.globs.filter(o => o.team !== team && !o.dead);
      if (!foes.length) { c = aimAt(g, ball.x, ball.y, 400); }
      else {
        const nearMouth = foes.find(o => o.y > GY0 - 40 && o.y < GY1 + 40 && (o.x < PL + 90 || o.x > PR - 90));
        if (nearMouth) {
          const gx2 = nearMouth.x < MIDX ? PL - POCKET / 2 : PR + POCKET / 2;
          const dxx = gx2 - nearMouth.x, dyy = (GY0 + GY1) / 2 - nearMouth.y;
          const dd2 = hyp(dxx, dyy) || 1;
          c = aimAt(g, nearMouth.x - dxx / dd2 * (g.r * 2), nearMouth.y - dyy / dd2 * (g.r * 2), MAXV);
        } else {
          const foe = foes.sort((a, b) => hyp(a.x - ball.x, a.y - ball.y) - hyp(b.x - ball.x, b.y - ball.y))[0];
          c = aimAt(g, foe.x, foe.y, clamp(hyp(foe.x - g.x, foe.y - g.y) * 2.2, 260, MAXV));
        }
      }
    }
    commits[g.idx] = jitter(st, c, noise, pj);
  });
  return commits;
}

// server-side commit validation: shape, ownership, speed cap
export function validateCommits(st, team, commits) {
  if (!commits || typeof commits !== 'object') return {};
  const clean = {};
  for (const g of st.globs) {
    if (g.team !== team || g.dead) continue;
    const c = commits[g.idx];
    if (!c || typeof c.vx !== 'number' || typeof c.vy !== 'number') continue;
    if (!isFinite(c.vx) || !isFinite(c.vy)) continue;
    let vx = c.vx, vy = c.vy;
    const v = hyp(vx, vy);
    if (v > MAXV) { vx = vx / v * MAXV; vy = vy / v * MAXV; }
    clean[g.idx] = { vx, vy };
  }
  return clean;
}

// replicate game.js runAutoplay's per-match block — the parity target
export function runMatch(seed, kinds, roundCap = 20) {
  const st = makeMatch(seed);
  let guard = 0;
  while (st.winner < 0 && guard++ < roundCap + 2) {
    const commits = [
      botCommits(st, 0, kinds[0]),
      botCommits(st, 1, kinds[1] === 'solver' ? 'solver' : 'random'),
    ];
    const { scorer } = simRound(st, commits);
    st.rounds++;
    if (scorer >= 0) {
      st.score[scorer]++;
      if (st.score[scorer] >= WIN_SCORE) st.winner = scorer;
      else resetKickoff(st);
    }
    st.round++;
    if (st.round > roundCap && st.winner < 0) st.winner = st.score[0] > st.score[1] ? 0 : st.score[1] > st.score[0] ? 1 : 2;
  }
  return { score: st.score, winner: st.winner, rounds: st.rounds };
}
