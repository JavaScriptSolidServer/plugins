// Ripple (Fugger-classic trustlines) over a real JSS from npm.
//
// The canonical 2004 scenario, driven end-to-end over HTTP with real pod
// bearers: bob extends alice 1000 USD of trust, carol extends bob 500 USD —
// alice can then pay carol 300 USD *through* bob with no consent from anyone
// mid-path, because every hop consumes credit its next node already granted.
// Asserted from both sides: the routing that must work works, and the
// capacity/authorization boundaries that must refuse refuse (no route beyond
// capacity, no third-party trustlines, no settling debts you aren't owed,
// currencies fully isolated). The hash-chained transition log verifies after
// the whole run, and signed single-balance bookkeeping means the two
// directions of a pair can never disagree.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';
import { toMicro, fromMicro, pairKey, debtOf, capacityOf, findPath, entryHash } from './plugin.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');

async function mint(base, username) {
  const pass = 'ripple-pass';
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pass, confirmPassword: pass }),
  });
  assert.ok([200, 201, 302].includes(reg.status), `register ${username}: ${reg.status}`);
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: pass }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `mint ${username}: ${JSON.stringify(body)}`);
  return body.access_token;
}

const post = (url, token, obj) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(obj),
});

describe('ripple plugin (Fugger-classic trustlines)', () => {
  let jss; let base; let api;
  let aliceTok; let bobTok; let carolTok;
  let ALICE; let BOB; let CAROL; // agent ids (WebIDs)

  after(async () => { if (jss) await jss.close(); });

  before(async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    api = `${base}/ripple/api`;
    jss = await startJss({ port, idp: true, plugins: [{ module: PLUGIN, prefix: '/ripple' }] });
    aliceTok = await mint(base, 'alice');
    bobTok = await mint(base, 'bob');
    carolTok = await mint(base, 'carol');
    const who = async (t) => (await (await fetch(`${api}/whoami`, { headers: { authorization: `Bearer ${t}` } })).json()).agent;
    ALICE = await who(aliceTok); BOB = await who(bobTok); CAROL = await who(carolTok);
    assert.ok(ALICE && BOB && CAROL, 'all three agents resolve');
  });

  // ---- pure model units ----------------------------------------------------
  it('micro-unit conversion round-trips and rejects float garbage', () => {
    assert.strictEqual(toMicro(0.1), 100000n);
    assert.strictEqual(fromMicro(toMicro(1234.567891)), 1234.567891);
    assert.strictEqual(toMicro(0.1234567), null, '> 6 dp refused');
    assert.strictEqual(toMicro(-5), null);
    assert.strictEqual(toMicro(NaN), null);
  });

  it('signed single-balance bookkeeping: the two directions cannot disagree', () => {
    const state = { trustlines: {}, balances: {} };
    state.balances[pairKey('a', 'b', 'USD')] = toMicro(40).toString(); // lo(a) owes hi(b) 40
    assert.strictEqual(debtOf(state, 'a', 'b', 'USD'), 40000000n, 'a owes b 40');
    assert.strictEqual(debtOf(state, 'b', 'a', 'USD'), -40000000n, 'the mirror view is the SAME number, negated');
  });

  it('findPath spends owed-to-you credit with zero trustline (clearing)', () => {
    // y owes x 30 → x can "pay" y up to 30 with no line from y at all.
    const state = { trustlines: {}, balances: {} };
    state.balances[pairKey('x', 'y', 'USD')] = (-toMicro(30)).toString(); // hi? depends: pair(x,y) → [x,y]; lo x owes hi y = -30 → y owes x 30
    assert.strictEqual(capacityOf(state, 'x', 'y', 'USD'), 30000000n);
    assert.deepStrictEqual(findPath(state, 'x', 'y', 'USD', toMicro(30)), ['x', 'y']);
    assert.strictEqual(findPath(state, 'x', 'y', 'USD', toMicro(31)), null);
  });

  // ---- trustlines ----------------------------------------------------------
  it('refuses an anonymous trustline (401) and a self-trustline (400)', async () => {
    assert.strictEqual((await post(`${api}/trustlines`, null, { peer: 'x', currency: 'USD', limit: 1 })).status, 401);
    assert.strictEqual((await post(`${api}/trustlines`, bobTok, { peer: BOB, currency: 'USD', limit: 1 })).status, 400);
  });

  it('bob extends alice 1000 USD; carol extends bob 500 USD (creditor-only writes)', async () => {
    const r1 = await post(`${api}/trustlines`, bobTok, { peer: ALICE, currency: 'usd', limit: 1000 });
    assert.strictEqual(r1.status, 201, await r1.clone().text());
    const b1 = await r1.json();
    assert.strictEqual(b1.trustline.creditor, BOB, 'the authenticated agent is the creditor — never a param');
    assert.strictEqual(b1.trustline.currency, 'USD', 'currency normalized to uppercase');
    const r2 = await post(`${api}/trustlines`, carolTok, { peer: BOB, currency: 'USD', limit: 500 });
    assert.strictEqual(r2.status, 201);
  });

  // ---- routing + payment ---------------------------------------------------
  it('dry-run pathfind routes alice → bob → carol for 300 USD', async () => {
    const res = await fetch(`${api}/path?from=${encodeURIComponent(ALICE)}&to=${encodeURIComponent(CAROL)}&currency=USD&amount=300`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.path, [ALICE, BOB, CAROL]);
    assert.strictEqual(body.hops, 2);
  });

  it('alice pays carol 300 USD through bob — atomically, with no consent from bob', async () => {
    const res = await post(`${api}/payments`, aliceTok, { to: CAROL, currency: 'USD', amount: 300 });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.deepStrictEqual(body.payment.path, [ALICE, BOB, CAROL]);
    // The books: alice owes bob 300; bob owes carol 300.
    const g = await (await fetch(`${api}/graph`)).json();
    const owes = (d, c) => g.balances.find((b) => b.debtor === d && b.creditor === c)?.amount;
    assert.strictEqual(owes(ALICE, BOB), 300);
    assert.strictEqual(owes(BOB, CAROL), 300);
    // Carol's net position is +300 (her asset), alice's is −300.
    const carolNet = (await (await fetch(`${api}/balances?agent=${encodeURIComponent(CAROL)}`)).json()).net.USD;
    const aliceNet = (await (await fetch(`${api}/balances?agent=${encodeURIComponent(ALICE)}`)).json()).net.USD;
    assert.strictEqual(carolNet, 300);
    assert.strictEqual(aliceNet, -300);
  });

  it('refuses a payment beyond path capacity (404 no route, books untouched)', async () => {
    // bob→carol hop has 200 left of carol's 500 — 900 must find no route.
    const res = await post(`${api}/payments`, aliceTok, { to: CAROL, currency: 'USD', amount: 900 });
    assert.strictEqual(res.status, 404);
    const g = await (await fetch(`${api}/graph`)).json();
    assert.strictEqual(g.balances.length, 2, 'no partial fills — the failed attempt shifted nothing');
  });

  it('currencies are isolated: an EUR line cannot carry USD', async () => {
    await post(`${api}/trustlines`, carolTok, { peer: ALICE, currency: 'EUR', limit: 9999 });
    const res = await post(`${api}/payments`, aliceTok, { to: CAROL, currency: 'EUR', amount: 50 });
    assert.strictEqual(res.status, 200, 'EUR routes direct on the EUR line');
    const usd = await post(`${api}/payments`, aliceTok, { to: CAROL, currency: 'USD', amount: 250 });
    assert.strictEqual(usd.status, 404, 'the big EUR line lends no USD capacity (bob→carol has only 200 left)');
  });

  it('paying BACK clears debt first — reverse capacity needs no trustline', async () => {
    // carol owes nobody; but bob owes carol 300 — carol can pay bob up to 300
    // with zero trustline from bob, by forgiving the debt.
    const res = await post(`${api}/payments`, carolTok, { to: BOB, currency: 'USD', amount: 100 });
    assert.strictEqual(res.status, 200, await res.clone().text());
    const g = await (await fetch(`${api}/graph`)).json();
    const bobOwesCarol = g.balances.find((b) => b.debtor === BOB && b.creditor === CAROL)?.amount;
    assert.strictEqual(bobOwesCarol, 200, '300 − 100 forgiven = 200');
  });

  // ---- settle --------------------------------------------------------------
  it('settle: only the creditor records repayment, and only up to the debt', async () => {
    // bob (the debtor) cannot settle his own debt away…
    const cheeky = await post(`${api}/settle`, bobTok, { peer: CAROL, currency: 'USD', amount: 200 });
    assert.strictEqual(cheeky.status, 409, 'carol owes bob nothing — his claim to settle is empty');
    // …and carol cannot settle more than she is owed.
    const over = await post(`${api}/settle`, carolTok, { peer: BOB, currency: 'USD', amount: 500 });
    assert.strictEqual(over.status, 409);
    // carol records bob repaying 150 out of band.
    const ok = await post(`${api}/settle`, carolTok, { peer: BOB, currency: 'USD', amount: 150 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).settled.remaining, 50);
  });

  // ---- trustline removal ---------------------------------------------------
  it('a line with outstanding debt refuses removal (409); a clean line removes', async () => {
    const blocked = await post(`${api}/trustlines/remove`, bobTok, { peer: ALICE, currency: 'USD' });
    assert.strictEqual(blocked.status, 409, 'alice still owes bob 300');
    await post(`${api}/trustlines`, bobTok, { peer: CAROL, currency: 'GBP', limit: 10 });
    const clean = await post(`${api}/trustlines/remove`, bobTok, { peer: CAROL, currency: 'GBP' });
    assert.strictEqual(clean.status, 200);
  });

  // ---- the chained log -----------------------------------------------------
  it('the transition log hash-chains and verifies end-to-end', async () => {
    const v = await (await fetch(`${api}/log/verify`)).json();
    assert.strictEqual(v.valid, true, 'chain recomputes clean after the whole run');
    const log = await (await fetch(`${api}/log`)).json();
    assert.ok(log.entries.length >= 8, 'every transition landed in the log');
    const last = log.entries[log.entries.length - 1];
    assert.strictEqual(log.tip, last.hash, 'tip is the last entry hash');
    assert.strictEqual(entryHash(last), last.hash, 'an independent recompute agrees');
    const kinds = new Set(log.entries.map((e) => e.type));
    for (const k of ['create-trustline', 'send-payment', 'settle', 'remove-trustline']) {
      assert.ok(kinds.has(k), `log carries a ${k} transition`);
    }
  });

  // ---- UI ------------------------------------------------------------------
  it('serves the UI page anonymously', async () => {
    const res = await fetch(`${base}/ripple`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(await res.text(), /Extend trust/);
  });
});
