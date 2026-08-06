// markets/demo.mjs — boot JSS with just this plugin and seed enough real
// activity that the UI has something to show.
//
//   node markets/demo.mjs            # http://localhost:3399/predict
//   PORT=4000 node markets/demo.mjs
//
// Then open http://localhost:3399/login/alice — a DEMO-ONLY shortcut
// that does the pod-bearer→session exchange server-side and hands your
// browser the cookie, so you don't have to paste a JWT to look around.
// Users: alice, bob, carol, dave (bob and carol create markets, so they
// cannot bet in their own; sign in as alice or dave to trade).
// alice is also the operator, so she sees the Operator panel.
//
// Data lives in markets/demo-data/ and is wiped on every run.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'javascript-solid-server/src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3399);
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(HERE, 'demo-data');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const USERS = ['alice', 'bob', 'carol', 'dave'];
const tokens = {};
// Deterministic, so it can be handed to the plugin before registration.
const ALICE = `${BASE}/alice/profile/card.jsonld#me`;

const fastify = createServer({
  logger: false,
  forceCloseConnections: true,
  root: ROOT,
  idp: true,
  idpIssuer: BASE,
  // The demo login shortcut lives outside the plugin prefix, so core's
  // access control would 401 it without this.
  appPaths: ['/login'],
  plugins: [{
    module: path.join(HERE, 'plugin.js'),
    prefix: '/predict',
    config: {
      baseUrl: BASE,
      grantCredits: 1000,
      feeBps: 100,
      // Short enough that the seeded market settles during startup, long
      // enough to click Dispute yourself and watch the flow.
      disputeWindowMs: 15_000,
      settlementWindowMs: 7 * 24 * 3600 * 1000,
      rateCapacity: 1e9,
      rateRefillPerSec: 1e6,
      admins: [ALICE],   // so alice sees the Operator panel
    },
  }],
});

// DEMO ONLY. Does the /api/session exchange server-side and forwards the
// Set-Cookie, so a human can click a link instead of pasting a bearer.
// Nothing like this belongs in the plugin.
fastify.get('/login/:user', async (request, reply) => {
  const token = tokens[request.params.user];
  if (!token) return reply.code(404).send({ error: `unknown demo user; try ${USERS.join(', ')}` });
  const res = await fetch(`${BASE}/predict/api/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const cookie = res.headers.get('set-cookie');
  if (cookie) reply.header('set-cookie', cookie);
  return reply.redirect('/predict');
});

await fastify.listen({ port: PORT, host: 'localhost' });

// ------------------------------------------------------------- seeding
const j = async (url, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${url}: ${JSON.stringify(b)}`);
  return b;
};

for (const user of USERS) {
  const pass = `demo ${user} passphrase`;
  const reg = await fetch(`${BASE}/idp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass, confirmPassword: pass }),
  });
  if (!reg.ok) throw new Error(`register ${user}: ${reg.status} ${await reg.text()}`);
  const cred = await j(`${BASE}/idp/credentials`, {
    method: 'POST',
    body: JSON.stringify({ username: user, password: pass }),
  });
  tokens[user] = cred.access_token;
}
const api = (user, method, p, body) => j(`${BASE}/predict/api${p}`, {
  method,
  headers: { authorization: `Bearer ${tokens[user]}` },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const hours = (n) => new Date(Date.now() + n * 3600e3).toISOString();

const MARKETS = [
  { by: 'bob', title: 'Arsenal v Spurs: full-time result', category: 'football', b: 200, closes: 6,
    outcomes: ['Arsenal', 'Draw', 'Spurs'],
    desc: 'Premier League, 90 minutes plus stoppage time. Extra time and penalties do not count.' },
  { by: 'bob', title: 'Man City v Liverpool: both teams to score?', category: 'football', b: 150, closes: 30,
    outcomes: ['Yes', 'No'], desc: 'Settled on the official Premier League match report.' },
  { by: 'carol', title: 'Premier League top scorer 2026-27', category: 'football', b: 120, closes: 240,
    outcomes: ['Haaland', 'Salah', 'Isak', 'Saka', 'Someone else'],
    desc: 'Golden Boot winner. A shared award settles on the alphabetically first name.' },
  { by: 'carol', title: 'Will the Bank of England cut rates in November?', category: 'economics', b: 100, closes: 72,
    outcomes: ['Cut', 'Hold', 'Raise'], desc: 'Settled on the published MPC decision.' },
  { by: 'bob', title: 'England to win the Ashes', category: 'cricket', b: 90, closes: 500,
    outcomes: ['England', 'Australia', 'Drawn series'] },
];

const made = [];
for (const m of MARKETS) {
  const created = await api(m.by, 'POST', '/markets', {
    title: m.title, description: m.desc || '', category: m.category,
    outcomes: m.outcomes, closesAt: hours(m.closes), b: m.b,
  });
  made.push({ ...created, by: m.by });
}

// Deterministic pseudo-random trading so prices move and history exists.
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let round = 0; round < 7; round++) {
  for (const mk of made) {
    for (const who of ['alice', 'dave']) {
      if (who === mk.by || rnd() < 0.35) continue;
      try {
        await api(who, 'POST', `/markets/${mk.id}/trade`, {
          side: 'buy',
          outcome: Math.floor(rnd() * mk.outcomes.length),
          spend: Math.round(5 + rnd() * 40),
        });
      } catch { /* balance or per-market cap */ }
    }
  }
}

// One settled market, so the receipts panel and the settled view have
// something real in them.
const done = await api('bob', 'POST', '/markets', {
  title: 'Chelsea v Newcastle: full-time result',
  description: 'Premier League, 90 minutes plus stoppage time.',
  category: 'football',
  outcomes: ['Chelsea', 'Draw', 'Newcastle'],
  closesAt: hours(0.001),
  b: 80,
});
await api('alice', 'POST', `/markets/${done.id}/trade`, { side: 'buy', outcome: 0, spend: 45 });
await api('dave', 'POST', `/markets/${done.id}/trade`, { side: 'buy', outcome: 2, spend: 25 });
await new Promise((r) => { setTimeout(r, 4500); });
await api('bob', 'POST', `/markets/${done.id}/close`).catch(() => {});
await api('bob', 'POST', `/markets/${done.id}/resolve`, { outcome: 0 });
// Wait out the dispute window and push it through, so the demo opens
// with a genuinely settled market and a receipt rather than one still
// counting down.
process.stdout.write('  settling the finished market');
for (let i = 0; i < 20; i++) {
  await new Promise((r) => { setTimeout(r, 1000); });
  process.stdout.write('.');
  const m = await j(`${BASE}/predict/api/markets/${done.id}`);
  if (m.status === 'resolved') break;
  await fetch(`${BASE}/predict/api/markets/${done.id}/settle`, { method: 'POST' }).catch(() => {});
}
process.stdout.write('\n');

console.log(`
  markets demo — ${made.length + 1} markets seeded, real trades, one settled

  Open        ${BASE}/login/alice     (alice trades, and is the operator)
  or          ${BASE}/login/dave      (another trader)
              ${BASE}/login/bob       (created 3 markets — can resolve them)
              ${BASE}/login/carol     (created 2 markets)

  Signed out  ${BASE}/predict

  Try: place a bet (Review → Confirm), cash out, open the settled market,
  and as bob resolve one of his — alice can then dispute it and, as the
  operator, adjudicate it from the panel in the right rail.

  Data in markets/demo-data (wiped on each run). Ctrl-C to stop.
`);
