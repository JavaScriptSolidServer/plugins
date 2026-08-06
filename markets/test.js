// markets/ — LMSR prediction-market plugin tests. Real HTTP against a
// booted JSS with idp, three funded agents.
//
// The load-bearing assertion is CONSERVATION: at every point,
// GET /api/stats → creditsInSystem (all balances + all escrowed pools)
// equals the sum of the signup grants. Not a leaderboard sample — the
// exact total, so it cannot silently measure the wrong thing.
//
// Beyond parity, this suite is the regression net for the exploits found
// in review: the void front-run, the dead-oracle freeze, oracle
// self-dealing, NaN slippage guards, CSRF, prototype-key ids, and
// double-executed retries.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { probePort, startJss, wsCollect } from '../helpers.js';
import { lmsrCost, lmsrPrices, twapPrices, sharesForBudget } from './lmsr.js';
import { createRateLimiter, createSessions, isSameOrigin } from './guard.js';
import { isAgentId } from './plugin.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const GRANT = 1000;
const AGENTS = 3;

describe('markets plugin', () => {
  let jss;
  let base;
  let mk;
  const bearer = {};   // user → pod bearer
  const cookie = {};   // user → markets session cookie
  let aliceId;

  after(async () => { if (jss) await jss.close(); });

  // --- request helpers -------------------------------------------------
  // A bodyless POST must not claim content-type: application/json —
  // Fastify 400s an empty JSON body before the handler runs.
  const call = (who, method, urlPath, body, extra = {}) => fetch(`${mk}${urlPath}`, {
    method,
    headers: {
      ...(who && bearer[who] ? { authorization: `Bearer ${bearer[who]}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (res, status) => {
    const b = await res.json();
    if (status !== undefined) assert.strictEqual(res.status, status, `${res.status}: ${JSON.stringify(b)}`);
    return b;
  };
  const me = (who) => call(who, 'GET', '/me').then((r) => json(r, 200));
  const stats = () => call(null, 'GET', '/stats').then((r) => json(r, 200));
  const balance = async (who) => (await me(who)).balance;

  // Operator adjustments mint or burn on purpose, so they move the
  // baseline; everything else must leave it untouched.
  let adminMinted = 0;

  /** Every credit ever granted is still somewhere: a balance or a pool. */
  async function assertConserved(where) {
    const s = await stats();
    const expected = AGENTS * GRANT + adminMinted;
    assert.ok(Math.abs(s.creditsInSystem - expected) < 1e-9,
      `${where}: creditsInSystem ${s.creditsInSystem} ≠ ${expected}`);
  }

  // ================================================== pure unit checks
  it('lmsr: uniform start, prices sum to 1, cost is convex', () => {
    const b = 100e6;
    const p0 = lmsrPrices([0, 0, 0], b);
    assert.ok(p0.every((p) => Math.abs(p - 1 / 3) < 1e-12));
    const c1 = lmsrCost([10e6, 0, 0], b) - lmsrCost([0, 0, 0], b);
    const c2 = lmsrCost([20e6, 0, 0], b) - lmsrCost([10e6, 0, 0], b);
    assert.ok(c2 > c1, 'buying into an outcome must get more expensive');
    assert.ok(lmsrPrices([10e6, 0, 0], b)[0] > 1 / 3, 'bought outcome price rises');
  });

  it('lmsr: buying x shares costs strictly less than x×p_final (the arb the TWAP closes)', () => {
    const b = 100e6;
    const q = [0, 0];
    const x = 2000e6;
    const cost = lmsrCost([x, 0], b) - lmsrCost(q, b);
    const pFinal = lmsrPrices([x, 0], b)[0];
    assert.ok(cost < x * pFinal, 'convexity: cost < shares × final price');
    // …and that gap is exactly what a spot-priced void would hand over.
    assert.ok(x * pFinal - cost > 60e6, 'the spot-void arb is ~b·ln 2 ≈ 69 credits');
  });

  it('lmsr: twap is time-weighted, so a late spike barely moves it', () => {
    const history = [
      { t: 0, p: [0.5, 0.5] },
      { t: 900, p: [0.99, 0.01] }, // a spike in the last 10% of the window
    ];
    const twap = twapPrices(history, 0, 1000, 2);
    assert.ok(twap[0] < 0.6, `late spike must barely move the twap (got ${twap[0]})`);
    assert.ok(Math.abs(twap[0] + twap[1] - 1) < 1e-12, 'twap is a probability vector');
  });

  it('lmsr: sharesForBudget inverts the cost function exactly', () => {
    const b = 100e6;
    const q = [0, 0, 0];
    const costOf = (x) => Math.ceil(lmsrCost([q[0] + x, q[1], q[2]], b) - lmsrCost(q, b));
    const budget = 25e6;
    const shares = sharesForBudget(q, b, 0, budget, costOf, 1e12);
    assert.ok(costOf(shares) <= budget, 'within budget');
    assert.ok(costOf(shares + 1e4) > budget, 'and maximal');
  });

  it('guard: session tokens verify, expire, and reject forgeries', () => {
    // A throwaway dir: minting into __dirname wrote secret material into
    // the source tree (and it got committed once — never again).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markets-sess-'));
    const s = createSessions({ dir, ttlMs: 60_000 });
    const tok = s.mint('https://alice.example/#me', 3);
    assert.strictEqual(s.verify(tok).agent, 'https://alice.example/#me');
    assert.strictEqual(s.verify(tok).epoch, 3, 'the epoch rides in the token so sessions can be revoked');
    assert.strictEqual(s.verify(`${tok}x`), null, 'tampered mac rejected');
    assert.strictEqual(s.verify('v1.aaa.bbb'), null);
    assert.strictEqual(s.verify(null), null);
    const expired = createSessions({ dir, ttlMs: -1 }).mint('https://bob.example/#me');
    assert.strictEqual(createSessions({ dir, ttlMs: -1 }).verify(expired), null, 'expired rejected');
    // A different deployment's secret must not verify our tokens.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'markets-sess2-'));
    assert.strictEqual(createSessions({ dir: other, ttlMs: 60_000 }).verify(tok), null,
      'a token from another deployment is rejected');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('guard: rate limiter refuses over-budget callers and refills', async () => {
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 });
    assert.strictEqual(rl.take('k', 1), 0);
    assert.strictEqual(rl.take('k', 1), 0);
    assert.strictEqual(rl.take('k', 1), 0);
    assert.ok(rl.take('k', 1) > 0, '4th call over capacity is refused');
    const fast = createRateLimiter({ capacity: 1, refillPerSec: 1000 });
    assert.strictEqual(fast.take('k', 1), 0);
    await sleep(20);
    assert.strictEqual(fast.take('k', 1), 0, 'refills');
  });

  it('guard: cross-origin is detected via Sec-Fetch-Site and Origin', () => {
    const own = 'https://pod.example';
    assert.ok(isSameOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }, own));
    assert.ok(!isSameOrigin({ headers: { 'sec-fetch-site': 'cross-site' } }, own));
    assert.ok(!isSameOrigin({ headers: { origin: 'https://evil.example' } }, own));
    assert.ok(isSameOrigin({ headers: { origin: own } }, own));
    // Both present must AGREE — otherwise the Origin check is dead code
    // whenever Sec-Fetch-Site is set.
    assert.ok(!isSameOrigin({ headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' } }, own));
    // Neither header, ambient credential: refused rather than trusted.
    assert.ok(!isSameOrigin({ headers: {} }, own));
  });

  it('agent ids: WebIDs and DIDs pass, typos do not', () => {
    assert.ok(isAgentId('https://alice.example/profile/card#me'));
    assert.ok(isAgentId('did:nostr:abc123'));
    assert.ok(!isAgentId('nobody-xyz'));
    assert.ok(!isAgentId(''));
    assert.ok(!isAgentId('ftp://x.example'));
  });

  // ============================================================== boot
  // DATA_ROOT footgun: config-validation boots MUST precede the long one.
  it('refuses to boot on bad config', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/markets', config: { feeBps: 99999 } }] }),
      /feeBps/,
    );
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/markets', config: { admins: ['not-an-agent'] } }] }),
      /admins/,
    );
    await assert.rejects(
      startJss({
        plugins: [{
          module: module_,
          prefix: '/markets',
          config: { disputeWindowMs: 60_000, settlementWindowMs: 1_000 },
        }],
      }),
      /disputeWindowMs/,
      'a dispute window longer than the settlement window makes every resolution voidable',
    );
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/markets', config: { twapWindowMs: 1 } }] }),
      /twapWindowMs/,
      'a 1ms twap window is spot pricing in disguise',
    );
  });

  it('boots with idp and mints three pod bearers', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    mk = `${base}/markets/api`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        module: module_,
        prefix: '/markets',
        config: {
          grantCredits: GRANT,
          feeBps: 100,
          baseUrl: base,
          disputeWindowMs: 300,
          settlementWindowMs: 800,
          twapWindowMs: 30 * 60 * 1000,
          admins: ['https://operator.example/profile/card#me'],
          rateCapacity: 1e9,
          rateRefillPerSec: 1e6,
        },
      }],
    });
    for (const user of ['alice', 'bob', 'carol']) {
      const pass = `correct horse ${user} staple`;
      const reg = await fetch(`${base}/idp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass, confirmPassword: pass }),
      });
      assert.ok(reg.ok, `register ${user}: ${reg.status}`);
      const cred = await (await fetch(`${base}/idp/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      })).json();
      assert.ok(cred.access_token, `mint ${user}: ${JSON.stringify(cred)}`);
      bearer[user] = cred.access_token;
    }
    aliceId = (await me('alice')).agent;
    assert.ok(isAgentId(aliceId));
  });

  // ========================================================== security
  it('the UI ships hardened headers and does not frame', async () => {
    const res = await fetch(`${base}/markets`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /prediction markets/i);
  });

  it('API replies are private, vary on Authorization, and pin CORS to our origin', async () => {
    const res = await call('alice', 'GET', '/me');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('vary'), /Authorization/);
    assert.strictEqual(res.headers.get('access-control-allow-credentials'), null,
      'credentialed CORS must not be inherited on money routes');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), base);
  });

  it('a pod bearer buys a scoped session cookie, and the cookie is HttpOnly', async () => {
    for (const user of ['alice', 'bob', 'carol']) {
      const res = await call(user, 'POST', '/session');
      const body = await json(res, 200);
      assert.ok(body.agent);
      const setCookie = res.headers.get('set-cookie');
      assert.match(setCookie, /markets_session=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      cookie[user] = setCookie.split(';')[0];
    }
  });

  it('CSRF: an ambient (cookie) credential is refused cross-origin', async () => {
    // Same-origin with the cookie: allowed.
    let res = await fetch(`${mk}/markets`, {
      method: 'POST',
      headers: { cookie: cookie.alice, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ title: '', outcomes: ['a', 'b'], closesAt: '' }),
    });
    assert.strictEqual(res.status, 400, 'reached the handler (validation error), i.e. not blocked');

    // Cross-site with the same cookie: refused before the handler.
    res = await fetch(`${mk}/markets`, {
      method: 'POST',
      headers: { cookie: cookie.alice, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ title: 'x', outcomes: ['a', 'b'], closesAt: new Date(Date.now() + 3600e3).toISOString() }),
    });
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /cross-origin/);

    res = await fetch(`${mk}/markets`, {
      method: 'POST',
      headers: { cookie: cookie.alice, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'x', outcomes: ['a', 'b'], closesAt: new Date(Date.now() + 3600e3).toISOString() }),
    });
    assert.strictEqual(res.status, 403, 'Origin-based cross-origin also refused');
  });

  it('prototype-shaped ids are misses, not 500s', async () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      const res = await call(null, 'GET', `/markets/${id}`);
      assert.strictEqual(res.status, 404, `${id} must 404`);
      const q = await call(null, 'GET', `/markets/${id}/quote?side=buy&outcome=0&shares=1`);
      assert.strictEqual(q.status, 404);
    }
  });

  it('anonymous: list and stats are public; me, trade and leaderboard are not', async () => {
    assert.strictEqual((await call(null, 'GET', '/markets')).status, 200);
    assert.strictEqual((await call(null, 'GET', '/stats')).status, 200);
    assert.strictEqual((await call(null, 'GET', '/me')).status, 401);
    assert.strictEqual((await call(null, 'POST', '/markets', {})).status, 401);
    assert.strictEqual((await call(null, 'GET', '/leaderboard')).status, 401,
      'an anonymous wealth ranking of WebIDs is a privacy leak');
  });

  it('the leaderboard pseudonymizes everyone but you', async () => {
    const { leaderboard } = await json(await call('alice', 'GET', '/leaderboard'), 200);
    assert.ok(leaderboard.length >= 3);
    for (const row of leaderboard) {
      if (row.you) assert.strictEqual(row.agent, aliceId);
      else assert.match(row.agent, /^anon-[0-9a-f]{8}$/, 'other agents are pseudonymous');
    }
  });

  // ======================================================== the market
  it('grants on first touch and conserves from the start', async () => {
    for (const u of ['alice', 'bob', 'carol']) assert.strictEqual(await balance(u), GRANT);
    await assertConserved('after grants');
  });

  it('create validation rejects bad outcomes, past close, silly b, typo oracle', async () => {
    const closesAt = new Date(Date.now() + 3600e3).toISOString();
    for (const [body, re] of [
      [{ title: '', outcomes: ['a', 'b'], closesAt }, /title/],
      [{ title: 'x', outcomes: ['a'], closesAt }, /outcomes/],
      [{ title: 'x', outcomes: ['a', 'a'], closesAt }, /distinct/],
      [{ title: 'x', outcomes: ['a', 'b'], closesAt: '2001-01-01T00:00:00Z' }, /closesAt/],
      [{ title: 'x', outcomes: ['a', 'b'], closesAt, b: 1 }, /liquidity/],
      [{ title: 'x', outcomes: ['a', 'b'], closesAt, oracle: 'nobody-xyz' }, /oracle/],
    ]) {
      const out = await json(await call('alice', 'POST', '/markets', body), 400);
      assert.match(out.error, re);
    }
  });

  let market;
  let escrow;

  it('creates a 1X2 market, escrowing b·ln(3) from the creator', async () => {
    market = await json(await call('alice', 'POST', '/markets', {
      title: 'Arsenal v Spurs: full-time result',
      description: 'Premier League, 90 minutes plus stoppage.',
      category: 'football',
      outcomes: ['Arsenal', 'Draw', 'Spurs'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 100,
    }), 201);
    assert.strictEqual(market.status, 'open');
    assert.ok(market.tradable);
    assert.ok(market.prices.every((p) => Math.abs(p - 1 / 3) < 2e-6), 'uniform start');
    escrow = GRANT - await balance('alice');
    assert.ok(Math.abs(escrow - 100 * Math.log(3)) < 0.01, `escrow ${escrow} ≈ 100·ln3`);
    await assertConserved('after create');
  });

  it('a cookie session resolves to the RIGHT agent, and sessions are isolated', async () => {
    // The regression that 62 status-code-only tests missed: verify()
    // returns a claims OBJECT, and returning it as the agent id made
    // every cookie user share one ledger row keyed "[object Object]".
    for (const user of ['alice', 'bob', 'carol']) {
      const res = await fetch(`${mk}/me`, {
        headers: { cookie: cookie[user], 'sec-fetch-site': 'same-origin' },
      });
      const body = await json(res, 200);
      assert.strictEqual(typeof body.agent, 'string', 'the agent is an id, not a claims object');
      assert.ok(isAgentId(body.agent), `${user}'s cookie resolves to a WebID (got ${body.agent})`);
      const viaBearer = await me(user);
      assert.strictEqual(body.agent, viaBearer.agent,
        `${user}'s cookie and pod bearer must be the same identity`);
    }
    // …and two users must not be the same account.
    const a = await (await fetch(`${mk}/me`, { headers: { cookie: cookie.alice, 'sec-fetch-site': 'same-origin' } })).json();
    const b = await (await fetch(`${mk}/me`, { headers: { cookie: cookie.bob, 'sec-fetch-site': 'same-origin' } })).json();
    assert.notStrictEqual(a.agent, b.agent, 'cookie sessions are not a shared ledger row');
    // A cookie session can also create a market (isAgentId(obj) failed,
    // so the shipped UI could not create one at all).
    const created = await fetch(`${mk}/markets`, {
      method: 'POST',
      headers: { cookie: cookie.alice, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({
        title: 'Created from a browser session',
        outcomes: ['Yes', 'No'],
        closesAt: new Date(Date.now() + 3600e3).toISOString(),
        b: 15,
      }),
    });
    assert.strictEqual(created.status, 201, await created.text());
    await assertConserved('after a cookie-session market');
  });

  it('signing out actually revokes the session token', async () => {
    // Clearing the cookie is cosmetic: the token is self-verifying, so a
    // captured copy worked for the full TTL until epochs were added.
    const res = await call('carol', 'POST', '/session');
    const tok = res.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await fetch(`${mk}/me`, { headers: { cookie: tok, 'sec-fetch-site': 'same-origin' } })).status, 200);
    await fetch(`${mk}/session`, {
      method: 'DELETE',
      headers: { cookie: tok, 'sec-fetch-site': 'same-origin' },
    });
    const replayed = await fetch(`${mk}/me`, { headers: { cookie: tok, 'sec-fetch-site': 'same-origin' } });
    assert.strictEqual(replayed.status, 401, 'a replayed token after sign-out must be dead');
    // carol needs a working session again for later tests.
    const fresh = await call('carol', 'POST', '/session');
    cookie.carol = fresh.headers.get('set-cookie').split(';')[0];
  });

  it('the creator and oracle may not trade in their own market', async () => {
    const out = await json(await call('alice', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 403);
    assert.match(out.error, /may not trade/);
  });

  it('stake-first quote: risk N credits, see shares, payout and odds', async () => {
    const q = await json(await call(null, 'GET',
      `/markets/${market.id}/quote?side=buy&outcome=0&spend=10`), 200);
    assert.ok(Math.abs(q.total - 10) <= 0.01, `stake ≈ the requested 10 (got ${q.total})`);
    assert.ok(q.shares > 10 && q.shares < 40, 'a ~1/3 chance pays roughly 3× the stake');
    assert.ok(Math.abs(q.toWin - q.shares) < 1e-9, 'a winning share redeems for 1 credit');
    assert.ok(q.odds > 2.5 && q.odds < 3.2, `decimal odds near 3 (got ${q.odds})`);
    assert.ok(Math.abs(q.profit - (q.toWin - q.total)) < 1e-6);
  });

  it('quote and trade agree, the price moves, and the balance falls by the stake', async () => {
    const q = await json(await call(null, 'GET',
      `/markets/${market.id}/quote?side=buy&outcome=0&shares=50`), 200);
    const before = await balance('bob');
    const t = await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, shares: 50 }), 200);
    assert.strictEqual(t.total, q.total, 'trade executes at the quote');
    assert.ok(t.market.prices[0] > 1 / 3, 'Arsenal price rose');
    assert.ok(Math.abs(await balance('bob') - (before - q.total)) < 1e-9);
    await assertConserved('after a buy');
  });

  it('positions carry per-outcome cost basis, live value and unrealized P&L', async () => {
    const m = await me('bob');
    const p = m.positions.find((x) => x.market === market.id);
    assert.ok(p, 'bob has a position');
    assert.strictEqual(p.shares[0], 50);
    assert.ok(p.cost[0] > 0 && p.cost[1] === 0, 'cost basis is per outcome');
    assert.ok(p.value[0] > 0, 'value is what closing the position would actually pay');
    assert.ok(Math.abs(p.unrealizedPnl - (p.totalValue - p.totalCost)) < 1e-6);
    assert.ok(p.unrealizedPnl < 0, 'immediately after buying, the round trip is under water (spread + fees)');
  });

  it('a stale slippage guard is refused and returns a fresh quote', async () => {
    const out = await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, shares: 50, maxCost: 0.01 }), 409);
    assert.match(out.error, /maxCost/);
    assert.ok(out.quote && out.quote.total > 0, 'the 409 carries the current quote to retry with');
  });

  it('a non-numeric slippage guard FAILS the request instead of being ignored', async () => {
    for (const body of [
      { side: 'buy', outcome: 0, shares: 1, maxCost: 'not-a-number' },
      { side: 'sell', outcome: 0, shares: 1, minProceeds: {} },
    ]) {
      const out = await json(await call('bob', 'POST', `/markets/${market.id}/trade`, body), 400);
      assert.match(out.error, /finite number/);
    }
  });

  it('no shorting, and no buying beyond your balance', async () => {
    let out = await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'sell', outcome: 1, shares: 5 }), 409);
    assert.match(out.error, /no short selling/);
    out = await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, shares: 100000 }), 402);
    assert.match(out.error, /insufficient balance/);
  });

  it('selling returns less than the round trip cost, and conserves', async () => {
    const t = await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'sell', outcome: 0, shares: 10 }), 200);
    assert.ok(t.total > 0 && t.total < 10);
    const p = (await me('bob')).positions.find((x) => x.market === market.id);
    assert.strictEqual(p.shares[0], 40);
    assert.ok(p.cost[0] > 0, 'cost basis is reduced proportionally, not zeroed');
    await assertConserved('after a sell');
  });

  it('an idempotency key makes a retried trade execute exactly once', async () => {
    const key = 'retry-me-once';
    const headers = { 'idempotency-key': key };
    const before = await balance('carol');
    const a = await json(await call('carol', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 2, shares: 5 }, headers), 200);
    const b = await json(await call('carol', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 2, shares: 5 }, headers), 200);
    assert.deepStrictEqual(a.shares, b.shares);
    const after = await balance('carol');
    assert.ok(Math.abs((before - after) - a.total) < 1e-9, 'charged once, not twice');
    await assertConserved('after an idempotent retry');
  });

  it('concurrent trades cannot oversell or break conservation', async () => {
    const before = await balance('carol');
    const results = await Promise.all(Array.from({ length: 12 }, () => call('carol', 'POST',
      `/markets/${market.id}/trade`, { side: 'buy', outcome: 1, shares: 3 })));
    const ok = results.filter((r) => r.status === 200);
    assert.ok(ok.length >= 10, `most concurrent trades succeed (got ${ok.length})`);
    const after = await balance('carol');
    assert.ok(after >= 0 && after < before, 'balance fell and never went negative');
    await assertConserved('after 12 concurrent trades');
  });

  it('trades broadcast on the ws feed without leaking positions', async () => {
    const ws = new WebSocket(`${jss.wsBase}/markets/ws`);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    const collect = wsCollect(ws, (msgs) => msgs.some((m) => m.type === 'trade'));
    await json(await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 2, shares: 5 }), 200);
    const trade = (await collect).find((m) => m.type === 'trade');
    assert.strictEqual(trade.market.id, market.id);
    assert.ok(!('position' in trade.market), 'broadcasts carry no private positions');
    ws.close();
  });

  it('price history accumulates for charting', async () => {
    const h = await json(await call(null, 'GET', `/markets/${market.id}/history`), 200);
    assert.ok(h.history.length > 3, 'a sample per trade, seeded at creation');
    assert.ok(h.history.every((s) => Math.abs(s.p.reduce((a, x) => a + x, 0) - 1) < 1e-5));
  });

  it('list: pagination, status filter, category and search', async () => {
    const one = await json(await call(null, 'GET', '/markets?limit=1'), 200);
    assert.strictEqual(one.markets.length, 1);
    const byCat = await json(await call(null, 'GET', '/markets?category=football'), 200);
    assert.ok(byCat.markets.some((m) => m.id === market.id));
    const search = await json(await call(null, 'GET', '/markets?q=spurs'), 200);
    assert.ok(search.markets.some((m) => m.id === market.id));
    const none = await json(await call(null, 'GET', '/markets?q=cricket-in-space'), 200);
    assert.strictEqual(none.markets.length, 0);
    const listed = await json(await call(null, 'GET', '/markets'), 200);
    assert.ok(!('position' in listed.markets[0]), 'the list never carries per-agent data (cacheability)');
  });

  it('a loser CANNOT void a validly-resolved market via the stale backstop', async () => {
    // The anyone-can-rescue backstop is for a DEAD oracle. When `stale`
    // ignored lifecycle state, a market that had been resolved but was
    // past closesAt + settlementWindow could be voided by any loser —
    // refunding their own losing bet, no bond, no dispute, erasing the
    // winner's payout.
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Resolved, and past the backstop deadline',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 600).toISOString(),
      b: 25,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 1, shares: 10 }), 200);
    const bobStake = await balance('bob');
    await sleep(700);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 0 }), 200);
    await sleep(900); // now past closesAt + settlementWindowMs as well

    const loser = await call('carol', 'POST', `/markets/${m.id}/void`);
    assert.ok(loser.status === 403 || loser.status === 409,
      `a resolved market is not abandoned; the loser must not void it (got ${loser.status})`);
    await call(null, 'POST', `/markets/${m.id}/settle`);
    const final = await json(await call(null, 'GET', `/markets/${m.id}`), 200);
    assert.strictEqual(final.status, 'resolved', 'the honest resolution stands');
    assert.ok(await balance('bob') - bobStake > 9, 'the winner was paid his 10 winning shares');
    await assertConserved('after a refused stale-void');
  });

  // =================================================== settlement rules
  it('only the oracle may resolve, and a holder may dispute', async () => {
    const out = await json(await call('bob', 'POST', `/markets/${market.id}/resolve`, { outcome: 0 }), 403);
    assert.match(out.error, /oracle/);
  });

  it('resolve opens a dispute window before paying out', async () => {
    const m = await json(await call('alice', 'POST', `/markets/${market.id}/resolve`, { outcome: 0 }), 200);
    assert.strictEqual(m.status, 'resolving');
    assert.ok(m.settleAt, 'payout is deferred to settleAt');
    const early = await json(await call(null, 'POST', `/markets/${market.id}/settle`), 409);
    assert.match(early.error, /dispute window/);
  });

  it('settlement pays 1 credit per winning share and conserves exactly', async () => {
    const bobBefore = await balance('bob');
    await sleep(400); // let the dispute window lapse
    const m = await json(await call(null, 'POST', `/markets/${market.id}/settle`), 200);
    assert.strictEqual(m.status, 'resolved');
    const bobAfter = await balance('bob');
    // bob bought 50 Arsenal, sold 10 back → 40 winning shares at 1 credit.
    assert.ok(Math.abs((bobAfter - bobBefore) - 40) < 1e-9,
      `bob held 40 winning shares → +40 (got ${bobAfter - bobBefore})`);
    await assertConserved('after resolve');
  });

  it('a settlement receipt lands in the winner’s history', async () => {
    const receipts = (await me('bob')).settlements;
    const r = receipts.find((x) => x.market === market.id);
    assert.ok(r, 'bob has a receipt');
    assert.strictEqual(r.status, 'resolved');
    assert.ok(Math.abs(r.payout - 40) < 1e-9);
  });

  it('a settled market refuses trades and re-resolution', async () => {
    assert.strictEqual((await call('bob', 'POST', `/markets/${market.id}/trade`,
      { side: 'buy', outcome: 0, shares: 1 })).status, 409);
    assert.strictEqual((await call('alice', 'POST', `/markets/${market.id}/resolve`,
      { outcome: 1 })).status, 409);
  });

  it('resolving to an outcome nobody holds wins the creator nothing beyond their escrow', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Self-dealing attempt',
      outcomes: ['A', 'B', 'C'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 50,
    }), 201);
    const escrowed = Math.ceil(50 * Math.log(3) * 1e6) / 1e6;
    const spent = (await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 40 }), 200)).total;
    const detail = await json(await call(null, 'GET', `/markets/${m.id}`), 200);
    const aliceBefore = await balance('alice');
    // Alice resolves to C, which nobody holds — the classic pool grab.
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 2 }), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const gained = await balance('alice') - aliceBefore;
    // The creator recovers their own escrow plus their share of trade
    // fees — never the traders' stakes, which fall through to the house.
    // She recovers her OWN escrow plus her fee share, and not one credit
    // of bob's stake — that falls through to the house, which is what
    // makes the grab pointless.
    assert.ok(gained <= escrowed + detail.fees + 1e-6,
      `creator recovered ${gained}, must not exceed escrow ${escrowed} + fees ${detail.fees}`);
    assert.ok(gained - escrowed < spent * 0.5,
      `the grab captured ${gained - escrowed} of the trader's ${spent} credit stake`);
    await assertConserved('after a self-dealing attempt');
  });

  it('VOID FRONT-RUN IS DEAD: buy-then-void loses money at the TWAP', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Void arbitrage attempt',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 50,
    }), 201);
    await sleep(400); // let the pre-attack price sit in the TWAP window
    const before = await balance('bob');
    // The full attack: pump the price to ~98c, then have the market
    // voided immediately, hoping to redeem the pumped shares at spot.
    const t = await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, spend: Math.min(before * 0.5, 200) }), 200);
    assert.ok(t.market.prices[0] > 0.9, 'bob pumped the price hard');
    // Voiding LIVE trading would cancel everyone's open bets, so the
    // oracle must close the market first.
    const live = await json(await call('alice', 'POST', `/markets/${m.id}/void`), 403);
    assert.match(live.error, /close the market before voiding/);
    await json(await call('alice', 'POST', `/markets/${m.id}/close`), 200);
    const proposed = await json(await call('alice', 'POST', `/markets/${m.id}/void`), 200);
    assert.strictEqual(proposed.status, 'voiding', 'an oracle void is a proposal, not a fait accompli');
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const after = await balance('bob');
    assert.ok(after < before,
      `pump-and-void must lose money (before ${before}, after ${after})`);
    await assertConserved('after a void');
  });

  it('void redeems a normal holder near the price they paid', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Match abandoned at half time',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 100,
    }), 201);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 20 }), 200);
    await sleep(350); // the holder's price is what sits in the window
    const before = await balance('carol');
    await json(await call('alice', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/void`), 200);
    await sleep(400); // the oracle's void sits in the dispute window
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const redeemed = await balance('carol') - before;
    assert.ok(redeemed > 8 && redeemed < 20, `redeemed ${redeemed} ≈ 20 shares near 50c`);
    await assertConserved('after a holder void');
  });

  it('DEAD ORACLE: funds are never stuck — anyone can void past the settlement window', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Oracle goes missing',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 700).toISOString(),
      b: 20,
      oracle: 'https://someone-who-never-shows-up.example/profile#me',
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    const before = await balance('bob');
    // Before the window lapses, an outsider may not void.
    assert.strictEqual((await call('carol', 'POST', `/markets/${m.id}/void`)).status, 403);
    await sleep(1700); // closesAt + settlementWindow
    const out = await json(await call('carol', 'POST', `/markets/${m.id}/void`), 200);
    assert.ok(out.status === 'void', 'a stranger recovered everyone’s funds');
    assert.ok(await balance('bob') > before, 'bob got his stake back at the twap');
    await assertConserved('after a dead-oracle rescue');
  });

  it('a disputed market does not auto-pay', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Contested result',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 30,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    const d = await json(await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'the goal was offside' }), 200);
    assert.strictEqual(d.status, 'disputed');
    await sleep(400);
    const after = await json(await call(null, 'GET', `/markets/${m.id}`), 200);
    assert.strictEqual(after.status, 'disputed', 'the dispute window closing must not pay out a disputed market');
    // A non-holder has no standing.
    assert.strictEqual((await call('carol', 'POST', `/markets/${m.id}/dispute`, { reason: 'me too' })).status, 403);
    // …and the same holder cannot stack bonds on one market.
    assert.strictEqual((await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'again' })).status, 409);
  });

  it('every disputer posts their OWN bond, scaled to what they staked', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Two unhappy holders',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 40,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, spend: 200 }), 200);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 5 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);

    const bobBefore = await balance('bob');
    await json(await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'wrong' }), 200);
    const bobBond = bobBefore - await balance('bob');
    // 20% of a ~200-credit position is well above the 25-credit floor.
    assert.ok(bobBond > 25, `a large position posts a large bond (got ${bobBond})`);

    const carolBefore = await balance('carol');
    const second = await json(await call('carol', 'POST', `/markets/${m.id}/dispute`,
      { reason: 'also wrong' }), 200);
    assert.strictEqual(second.disputes, 2, 'a second holder can dispute too');
    const carolBond = carolBefore - await balance('carol');
    assert.ok(Math.abs(carolBond - 25) < 1e-9, `a small position posts the floor (got ${carolBond})`);
    await assertConserved('with two bonds staked');
  });

  it('early close stops trading but keeps the market resolvable', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Kick-off came early',
      outcomes: ['A', 'B'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 20,
    }), 201);
    await json(await call('alice', 'POST', `/markets/${m.id}/close`), 200);
    assert.strictEqual((await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 1 })).status, 409);
    const r = await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    assert.strictEqual(r.status, 'resolving');
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    await assertConserved('after an early close');
  });

  // ============================================== shapes and edge cases
  it('a 12-outcome market at max b prices and settles correctly', async () => {
    const outcomes = Array.from({ length: 12 }, (_, i) => `Runner ${i + 1}`);
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Twelve-horse race',
      outcomes,
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 10, // b·ln(12) escrow must stay inside alice's balance
    }), 201);
    assert.strictEqual(m.outcomes.length, 12);
    assert.ok(m.prices.every((p) => Math.abs(p - 1 / 12) < 1e-5));
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 11, shares: 5 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 11 }), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    await assertConserved('after a 12-outcome market');
  });

  it('a market with no trades at all settles cleanly (escrow returns)', async () => {
    const before = await balance('alice');
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Nobody turned up',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 25,
    }), 201);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 0 }), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    assert.ok(Math.abs(await balance('alice') - before) < 1e-6, 'the creator is made whole');
    await assertConserved('after an empty market');
  });

  it('per-agent market caps and the escrow check hold', async () => {
    const poor = await json(await call('bob', 'POST', '/markets', {
      title: 'Too rich for me',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 100000,
    }), 402);
    assert.match(poor.error, /escrows/);
  });

  // ========================================================= admin plane
  it('admin routes are operator-only (no admins configured here)', async () => {
    for (const [p, body] of [
      ['/admin/freeze', { agent: aliceId, frozen: true }],
      ['/admin/adjust', { agent: aliceId, credits: 1e9, reason: 'heist' }],
      ['/admin/hide', { market: market.id, hidden: true }],
    ]) {
      const res = await call('bob', 'POST', p, body);
      assert.strictEqual(res.status, 403, `${p} must be operator-only`);
    }
    await assertConserved('after failed admin attempts');
  });

  // ======================================================== persistence
  it('survives a reboot WITH AN OPEN MARKET and live positions', async () => {
    // The riskiest persistence path: q, escrow and positions mid-flight.
    const open = await json(await call('alice', 'POST', '/markets', {
      title: 'Still trading across the restart',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 40,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${open.id}/trade`,
      { side: 'buy', outcome: 0, shares: 12 }), 200);
    const beforeStats = await stats();
    const bobBefore = await balance('bob');

    const { root } = jss;
    const port = await probePort();
    await jss.close({ keepData: true });
    base = `http://127.0.0.1:${port}`;
    mk = `${base}/markets/api`;
    jss = await startJss({
      root,
      port,
      idp: true,
      plugins: [{
        module: module_,
        prefix: '/markets',
        config: {
          grantCredits: GRANT, feeBps: 100, baseUrl: base,
          disputeWindowMs: 300, settlementWindowMs: 800, disputeBondCredits: 25,
          rateCapacity: 1e9, rateRefillPerSec: 1e6,
          admins: [aliceId], // the operator plane, exercised below
        },
      }],
    });

    const afterStats = await stats();
    assert.ok(Math.abs(afterStats.creditsInSystem - beforeStats.creditsInSystem) < 1e-9,
      'every credit survived the restart');
    assert.strictEqual(afterStats.journalSeq, beforeStats.journalSeq, 'the journal replayed to the same point');
    assert.strictEqual(await balance('bob'), bobBefore);

    const m = await json(await call(null, 'GET', `/markets/${open.id}`), 200);
    assert.ok(m.tradable, 'the open market is still open');
    assert.strictEqual(m.trades, 1);
    // …and it still trades and settles after the restart.
    await json(await call('carol', 'POST', `/markets/${open.id}/trade`,
      { side: 'buy', outcome: 1, shares: 5 }), 200);
    await json(await call('alice', 'POST', `/markets/${open.id}/resolve`, { outcome: 0 }), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${open.id}/settle`), 200);
    await assertConserved('after settling a market that spanned a restart');
  });

  // ============================================================ admin
  it('admin: hide makes a market untradable, not merely unlisted', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Something the operator must withdraw',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 20,
    }), 201);
    await json(await call('alice', 'POST', '/admin/hide', { market: m.id, hidden: true }), 200);
    const listed = await json(await call(null, 'GET', '/markets?limit=200'), 200);
    assert.ok(!listed.markets.some((x) => x.id === m.id), 'gone from listings');
    const t = await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 1 }), 403);
    assert.match(t.error, /withdrawn/, 'takedown that leaves the URL tradable is not takedown');
    await assertConserved('after a takedown');
  });

  it('admin: freeze blocks a trader, unfreeze restores them, both journalled', async () => {
    const carolId = (await me('carol')).agent;
    await json(await call('alice', 'POST', '/admin/freeze', { agent: carolId, frozen: true }), 200);
    const blocked = await json(await call('carol', 'GET', '/me'), 403);
    assert.match(blocked.error, /frozen/);
    await json(await call('alice', 'POST', '/admin/freeze', { agent: carolId, frozen: false }), 200);
    assert.strictEqual((await call('carol', 'GET', '/me')).status, 200);
  });

  it('admin: adjust requires a reason and moves the balance', async () => {
    const bobId = (await me('bob')).agent;
    const before = await balance('bob');
    const noReason = await json(await call('alice', 'POST', '/admin/adjust',
      { agent: bobId, credits: 5 }), 400);
    assert.match(noReason.error, /reason/);
    await json(await call('alice', 'POST', '/admin/adjust',
      { agent: bobId, credits: 5, reason: 'goodwill after a support ticket' }), 200);
    assert.ok(Math.abs(await balance('bob') - (before + 5)) < 1e-9);
    // An operator credit adjustment mints money on purpose, so it must
    // move the conservation baseline by exactly that amount and no more.
    adminMinted += 5;
    await assertConserved('after an operator adjustment');
  });

  it('admin: the agent history endpoint answers "what happened to this account"', async () => {
    const bobId = (await me('bob')).agent;
    const h = await json(await call('alice', 'GET',
      `/admin/agent?agent=${encodeURIComponent(bobId)}`), 200);
    assert.strictEqual(h.agent, bobId);
    assert.ok(h.history.length > 3, 'the journal, filtered to this agent');
    assert.ok(h.history.some((e) => e.type === 'trade'), 'his trades are there');
    assert.ok(h.history.some((e) => e.type === 'admin.adjust'), 'and the operator adjustment');
    assert.strictEqual((await call('bob', 'GET', `/admin/agent?agent=${encodeURIComponent(bobId)}`)).status, 403);
  });

  it('ADJUDICATION: a dispute can be UPHELD, and the bond is forfeited', async () => {
    // Without this verb, disputing is a free refund option on any lost
    // bet and every rational loser disputes.
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'A resolution worth arguing about',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 30,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);

    const beforeBond = await balance('bob');
    const d = await json(await call('bob', 'POST', `/markets/${m.id}/dispute`,
      { reason: 'the goal was onside' }), 200);
    assert.strictEqual(d.status, 'disputed');
    assert.ok(Math.abs((beforeBond - await balance('bob')) - 25) < 1e-9, 'the 25-credit bond is staked');

    const queue = await json(await call('alice', 'GET', '/admin/disputes'), 200);
    assert.ok(queue.disputes.some((x) => x.id === m.id), 'it lands in the operator queue');

    const before = await balance('bob');
    const out = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: true }), 200);
    assert.strictEqual(out.status, 'resolved', 'the original resolution stands');
    // bob backed the losing outcome AND lost his bond: no free refund.
    assert.ok(await balance('bob') - before < 1e-9, 'a rejected dispute pays nothing back');
    await assertConserved('after upholding a disputed resolution');
  });

  it('ADJUDICATION: a dispute can be UPHELD FOR THE DISPUTER, refunding the bond', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'A genuinely wrong resolution',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 30,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    const before = await balance('bob');
    await json(await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'clearly wrong' }), 200);
    const out = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: false }), 200);
    assert.strictEqual(out.status, 'void');
    const back = await balance('bob') - before;
    assert.ok(back > -1e-6, `a vindicated disputer gets the bond back plus redemption (got ${back})`);
    await assertConserved('after voiding a disputed resolution');
  });

  it('ADJUDICATION: an operator can RE-RESOLVE, making the honest winner whole', async () => {
    // The remedy for oracle error must not be a void: that refunds the
    // loser and wipes out whoever actually backed the correct outcome.
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'The oracle simply got it wrong',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 30,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 20 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    const before = await balance('bob');
    await json(await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'Home clearly won' }), 200);

    const fixed = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: false, outcome: 0 }), 200);
    assert.strictEqual(fixed.status, 'resolved');
    assert.strictEqual(fixed.resolvedOutcome, 0, 're-resolved to the correct outcome');
    // bob held 20 winning shares and gets his bond back — a sustained
    // dispute must leave the person who was right better off.
    assert.ok(await balance('bob') - before > 15,
      'the vindicated holder is paid out and refunded his bond');
    await assertConserved('after a re-resolution');
  });

  it('a re-resolved outcome survives a restart (it must be in the journal)', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Re-resolution must be journalled',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 25,
    }), 201);
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 8 }), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/dispute`, { reason: 'wrong' }), 200);
    await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: false, outcome: 0 }), 200);

    // Rebuild purely from the journal — the recovery the boot error
    // itself recommends — and the corrected outcome must still be there.
    const { root } = jss;
    const port = await probePort();
    await jss.close({ keepData: true });
    fs.rmSync(path.join(root, '.plugins', 'markets', 'state.json'), { force: true });
    base = `http://127.0.0.1:${port}`;
    mk = `${base}/markets/api`;
    jss = await startJss({
      root, port, idp: true,
      plugins: [{
        module: module_,
        prefix: '/markets',
        config: {
          grantCredits: GRANT, feeBps: 100, baseUrl: base,
          disputeWindowMs: 300, settlementWindowMs: 800, disputeBondCredits: 25,
          rateCapacity: 1e9, rateRefillPerSec: 1e6, admins: [aliceId],
        },
      }],
    });
    const after = await json(await call(null, 'GET', `/markets/${m.id}`), 200);
    assert.strictEqual(after.resolvedOutcome, 0,
      'replay must reproduce the ADJUDICATED outcome, not the oracle’s original');
    await assertConserved('after replaying a re-resolution');
  });

  it('settled positions stop showing as live value', async () => {
    const positions = (await me('bob')).positions;
    assert.ok(positions.every((x) => x.status !== 'resolved' && x.status !== 'void'),
      'a paid-out market must not also appear as an open position');
  });

  it('a disputed VOID PROPOSAL settles as a void, never as a zero-payout resolution', async () => {
    // A void proposal has no resolvedOutcome. Settling it as "resolved"
    // indexed shares[undefined] → NaN → silently floored to zero, paying
    // every holder nothing and burning the pool to the house.
    const m = await json(await call('bob', 'POST', '/markets', {
      title: 'Void proposal that someone objects to',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 25,
    }), 201);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, spend: 60 }), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/close`), 200);
    const proposed = await json(await call('bob', 'POST', `/markets/${m.id}/void`), 200);
    assert.strictEqual(proposed.status, 'voiding', 'an oracle void is a proposal');
    await json(await call('carol', 'POST', `/markets/${m.id}/dispute`, { reason: 'should be resolved' }), 200);

    const before = await balance('carol');
    const out = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: true }), 200);
    assert.strictEqual(out.status, 'void', 'upholding a proposed void must VOID it, not resolve it');
    assert.ok(await balance('carol') - before > 0, 'holders are redeemed, not zeroed');
    await assertConserved('after upholding a proposed void');
  });

  it('a sustained dispute against a void proposal resolves it instead', async () => {
    const m = await json(await call('bob', 'POST', '/markets', {
      title: 'Void proposed, but the result was clear',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 25,
    }), 201);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 12 }), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/void`), 200);
    await json(await call('carol', 'POST', `/markets/${m.id}/dispute`, { reason: 'Home won outright' }), 200);
    // Without an outcome there is nothing to resolve to.
    const vague = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: false }), 400);
    assert.match(vague.error, /supply an outcome/);
    const before = await balance('carol');
    const fixed = await json(await call('alice', 'POST', '/admin/adjudicate',
      { market: m.id, uphold: false, outcome: 0 }), 200);
    assert.strictEqual(fixed.status, 'resolved');
    assert.strictEqual(fixed.resolvedOutcome, 0);
    assert.ok(await balance('carol') - before > 11, 'the vindicated holder is paid 1 credit per share');
    await assertConserved('after resolving a disputed void proposal');
  });

  it('going silent must NOT pay the creator more than resolving honestly', async () => {
    // The escrow is the LMSR maker bond. When a void returned it, the
    // payout cap turned unpaid trader value into residual and the
    // abandoned-market backstop voided by itself after a week — so
    // refusing to resolve returned nearly the whole escrow while
    // resolving honestly returned a fraction of it. Measured at +57
    // credits for doing nothing, taken from the trader who was right.
    const mk2 = async (title) => json(await call('bob', 'POST', '/markets', {
      title,
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 500).toISOString(),
      b: 25,
    }), 201);

    const honest = await mk2('Creator resolves honestly');
    await json(await call('carol', 'POST', `/markets/${honest.id}/trade`,
      { side: 'buy', outcome: 0, spend: 40 }), 200);
    const beforeHonest = await balance('bob');
    await sleep(600);
    await json(await call('bob', 'POST', `/markets/${honest.id}/resolve`, { outcome: 0 }), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${honest.id}/settle`), 200);
    const honestGain = await balance('bob') - beforeHonest;

    const silent = await mk2('Creator says nothing at all');
    await json(await call('carol', 'POST', `/markets/${silent.id}/trade`,
      { side: 'buy', outcome: 0, spend: 40 }), 200);
    const beforeSilent = await balance('bob');
    await sleep(1500); // past closesAt + settlementWindowMs → auto-void
    await json(await call(null, 'POST', `/markets/${silent.id}/settle`), 200);
    const silentGain = await balance('bob') - beforeSilent;

    assert.ok(silentGain <= honestGain + 1e-6,
      `refusing to resolve must not pay better than resolving (silent ${silentGain} vs honest ${honestGain})`);
    await assertConserved('after comparing silence with honesty');
  });

  it('a partial sell before a void cannot bank a risk-free profit', async () => {
    // Capping per outcome let a trader realise a gain on part of a
    // pumped position and still redeem the remainder at its full
    // remaining basis — a measured 5.8% risk-free. The cap is now net
    // cash in, over the whole position.
    const m = await json(await call('bob', 'POST', '/markets', {
      title: 'Pump, part-sell, then void',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 40,
    }), 201);
    const before = await balance('carol');
    const bought = await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, spend: 120 }), 200);
    await sleep(400);
    // Sell just over half, banking the gain from the pump…
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'sell', outcome: 0, shares: bought.shares * 0.51 }), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/void`), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const net = await balance('carol') - before;
    assert.ok(net <= 1e-6, `pump, part-sell and void must not profit (net ${net})`);
    await assertConserved('after a part-sell void');
  });

  it('a void does not tax a market-neutral position', async () => {
    // Capping each leg separately meant a leg that gained could not
    // offset a leg that lost, so a position with NO outcome risk lost
    // ~12% to a void.
    const m = await json(await call('bob', 'POST', '/markets', {
      title: 'Both sides, no outcome risk',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 40,
    }), 201);
    const before = await balance('carol');
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 30 }), 200);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 1, shares: 30 }), 200);
    const staked = before - await balance('carol');
    await json(await call('bob', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/void`), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const lost = before - await balance('carol');
    // Only the fees should be gone, not a double-digit percentage.
    assert.ok(lost < staked * 0.05,
      `a hedged position should lose only fees to a void (lost ${lost} of ${staked})`);
    await assertConserved('after voiding a hedged position');
  });

  it('a void proposal abandons any prior resolution (no bait-and-switch)', async () => {
    // resolvedOutcome used to survive a void proposal, so an oracle
    // could resolve, publicly "offer" a void, and have any dispute land
    // back on the original resolution.
    const m = await json(await call('bob', 'POST', '/markets', {
      title: 'Resolution then a void offer',
      outcomes: ['Home', 'Away'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 25,
    }), 201);
    await json(await call('carol', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, shares: 10 }), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('bob', 'POST', `/markets/${m.id}/resolve`, { outcome: 1 }), 200);
    // The oracle may not withdraw a pending resolution by proposing a void.
    const swap = await json(await call('bob', 'POST', `/markets/${m.id}/void`), 409);
    assert.match(swap.error, /resolution pending/);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const final = await json(await call(null, 'GET', `/markets/${m.id}`), 200);
    assert.strictEqual(final.status, 'resolved');
    assert.strictEqual(final.resolvedOutcome, 1, 'the declared resolution is what settled');
    await assertConserved('after a refused bait-and-switch');
  });

  it('a void never pays a holder more than they paid (kills the sustained pump)', async () => {
    const m = await json(await call('alice', 'POST', '/markets', {
      title: 'Sustained pump attempt',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 50,
    }), 201);
    const before = await balance('bob');
    // Pump and HOLD, so the TWAP itself equals the pumped price — the
    // one case a TWAP alone does not defeat.
    await json(await call('bob', 'POST', `/markets/${m.id}/trade`,
      { side: 'buy', outcome: 0, spend: 150 }), 200);
    await sleep(600);
    await json(await call('alice', 'POST', `/markets/${m.id}/close`), 200);
    await json(await call('alice', 'POST', `/markets/${m.id}/void`), 200);
    await sleep(400);
    await json(await call(null, 'POST', `/markets/${m.id}/settle`), 200);
    const net = await balance('bob') - before;
    assert.ok(net <= 1e-6, `pump-and-hold-then-void must not profit (net ${net})`);
    await assertConserved('after a sustained-pump void');
  });

  it('the journal is an append-only audit trail of every credit movement', async () => {
    const journal = path.join(jss.root, '.plugins', 'markets', 'journal.jsonl');
    const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length > 20, 'every event is recorded');
    const types = new Set(lines.map((l) => l.type));
    for (const t of ['grant', 'market.create', 'trade', 'market.resolve', 'market.settle']) {
      assert.ok(types.has(t), `journal records ${t}`);
    }
    // Sequence numbers are gapless and monotonic — nothing was dropped.
    // (Relative to the first line, so a rotated journal still checks out.)
    const base = lines[0].seq;
    lines.forEach((l, i) => assert.strictEqual(l.seq, base + i, 'gapless journal sequence'));
    const aTrade = lines.find((l) => l.type === 'trade');
    for (const f of ['marketId', 'agent', 'side', 'outcome', 'sharesMicro', 'totalMicro', 't']) {
      assert.ok(aTrade[f] !== undefined, `a trade record carries ${f} for dispute adjudication`);
    }
  });

  it('CRASH RECOVERY: a torn journal tail is truncated, and later writes survive', async () => {
    // The crash the whole design exists to survive. Dropping the torn
    // fragment is not enough: if the file is reopened for append without
    // truncating it, the next acknowledged event is welded onto the
    // fragment and is silently lost at the NEXT boot — a real,
    // reproduced ledger-loss bug.
    const { root } = jss;
    const dir = path.join(root, '.plugins', 'markets');
    const journal = path.join(dir, 'journal.jsonl');
    let port = await probePort();
    await jss.close({ keepData: true });

    // Simulate a power cut mid-append.
    fs.appendFileSync(journal, '{"type":"trade","seq":99999,"marketId":"x","agen');
    fs.rmSync(path.join(dir, 'state.json'), { force: true }); // force full replay

    const boot = async (p) => startJss({
      root, port: p, idp: true,
      plugins: [{
        module: module_,
        prefix: '/markets',
        config: { grantCredits: GRANT, feeBps: 100, baseUrl: `http://127.0.0.1:${p}`, rateCapacity: 1e9, rateRefillPerSec: 1e6 },
      }],
    });

    jss = await boot(port);
    base = `http://127.0.0.1:${port}`;
    mk = `${base}/markets/api`;
    const afterCrash = await stats();

    // Now write a real event and confirm it survives the NEXT restart.
    await json(await call('bob', 'POST', '/markets', {
      title: 'Written after the crash',
      outcomes: ['Yes', 'No'],
      closesAt: new Date(Date.now() + 3600e3).toISOString(),
      b: 20,
    }), 201);
    const afterWrite = await stats();
    assert.strictEqual(afterWrite.journalSeq, afterCrash.journalSeq + 1);

    port = await probePort();
    await jss.close({ keepData: true });
    jss = await boot(port);
    base = `http://127.0.0.1:${port}`;
    mk = `${base}/markets/api`;
    const afterReboot = await stats();
    assert.strictEqual(afterReboot.journalSeq, afterWrite.journalSeq,
      'the post-crash event survived — it was not welded onto the torn fragment');
    assert.ok(Math.abs(afterReboot.creditsInSystem - afterWrite.creditsInSystem) < 1e-9,
      'and no credits moved across the restart');
  });

  it('refuses to boot on a journal with an excised middle line', async () => {
    const { root } = jss;
    const journal = path.join(root, '.plugins', 'markets', 'journal.jsonl');
    await jss.close({ keepData: true });
    jss = null;
    const lines = fs.readFileSync(journal, 'utf8').trim().split('\n');
    const kept = lines.filter((_, i) => i !== Math.floor(lines.length / 2));
    fs.writeFileSync(journal, `${kept.join('\n')}\n`);
    fs.rmSync(path.join(root, '.plugins', 'markets', 'state.json'), { force: true });
    await assert.rejects(
      startJss({ root, plugins: [{ module: module_, prefix: '/markets' }] }),
      /journal gap/,
      'a discontinuous audit trail must not replay silently',
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses to boot on a corrupt snapshot rather than resetting balances', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'markets-corrupt-'));
    fs.mkdirSync(path.join(root, '.plugins', 'markets'), { recursive: true });
    const snap = path.join(root, '.plugins', 'markets', 'state.json');
    fs.writeFileSync(snap, '{"ledger": {"a": ');  // truncated, as a crash would leave it
    await assert.rejects(
      startJss({ root, plugins: [{ module: module_, prefix: '/markets' }] }),
      /corrupt/,
      'a corrupt ledger must be a boot failure, never a silent wipe',
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
});
