// OTP plugin over a real JSS from npm. The full challenge/verify/session
// flow is self-contained (no pod credential involved): request a code, read
// it from the console channel's testbox, verify it, and use the minted
// session token at whoami. Every refusal path holds — wrong code decrements
// and locks, expiry, single-use reuse, rate limit, tampered session token.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJss } from '../helpers.js';
import { signSession } from './plugin.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('otp plugin', () => {
  let jss;

  const requestCode = (identifier, purpose, extra = {}) => fetch(`${jss.base}/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, purpose, ...extra }),
  });

  const verifyCode = (identifier, purpose, code) => fetch(`${jss.base}/otp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, code, purpose }),
  });

  const whoami = (token) => fetch(`${jss.base}/otp/whoami`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  // Read the plaintext code the console channel recorded (testbox is only
  // mounted because config.exposeTestbox is true).
  const lastCode = async (identifier, purpose) => {
    const box = await (await fetch(`${jss.base}/otp/_testbox`)).json();
    const hits = box.outbox.filter((e) => e.identifier === identifier && e.purpose === purpose);
    return hits.length ? hits[hits.length - 1].code : null;
  };

  before(async () => {
    jss = await startJss({
      plugins: [{
        module: module_,
        id: 'otp',
        prefix: '/otp',
        config: {
          exposeTestbox: true,
          maxAttempts: 3,
          rateLimitPerIdentifier: 3,
          rateLimitPerIp: 100000, // effectively off for the suite; the flood test uses the identifier bucket
          codeLength: 6,
        },
      }],
    });
  });
  after(async () => { if (jss) await jss.close(); });

  it('session flow: request → read code → verify → session token → whoami', async () => {
    const id = 'newcomer@example.com';
    const req = await requestCode(id, 'session');
    assert.strictEqual(req.status, 201);
    const reqBody = await req.json();
    assert.strictEqual(reqBody.ok, true);
    assert.strictEqual(reqBody.identifier, id);
    assert.ok(reqBody.expiresIn > 0);

    const code = await lastCode(id, 'session');
    assert.ok(/^\d{6}$/.test(code), `expected a 6-digit code, got ${code}`);

    const ver = await verifyCode(id, 'session', code);
    assert.strictEqual(ver.status, 200);
    const session = await ver.json();
    assert.ok(session.token.startsWith('otp1.'), 'session token is otp1.-prefixed');
    assert.strictEqual(session.identifier, id);
    assert.strictEqual(session.purpose, 'session');
    assert.ok(session.exp > Date.now() / 1000);

    const me = await whoami(session.token);
    assert.strictEqual(me.status, 200);
    const meBody = await me.json();
    assert.strictEqual(meBody.identifier, id);
    assert.strictEqual(meBody.purpose, 'session');
    assert.strictEqual(meBody.exp, session.exp);
  });

  it('claim and recovery purposes each mint a session that whoami reflects', async () => {
    for (const purpose of ['claim', 'recovery']) {
      const id = `${purpose}-user@example.com`;
      assert.strictEqual((await requestCode(id, purpose)).status, 201);
      const code = await lastCode(id, purpose);
      const session = await (await verifyCode(id, purpose, code)).json();
      const meBody = await (await whoami(session.token)).json();
      assert.strictEqual(meBody.identifier, id, `${purpose} identifier`);
      assert.strictEqual(meBody.purpose, purpose, `${purpose} purpose echoed`);
    }
  });

  it('wrong code decrements attempts and locks after N (then even the right code is refused)', async () => {
    const id = 'fumbler@example.com';
    await requestCode(id, 'session');
    const good = await lastCode(id, 'session');

    // maxAttempts is 3 → three wrong tries exhaust the budget and lock.
    let last;
    for (let i = 0; i < 3; i++) {
      last = await verifyCode(id, 'session', '000000' === good ? '111111' : '000000');
      assert.strictEqual(last.status, 401, `wrong attempt ${i + 1} refused`);
    }
    const lastBody = await last.json();
    assert.strictEqual(lastBody.attempts_remaining, 0);
    assert.strictEqual(lastBody.locked, true);

    // Now even the correct code is refused: the row is locked.
    const locked = await verifyCode(id, 'session', good);
    assert.strictEqual(locked.status, 423, 'locked row refuses the right code');
  });

  it('expired code is refused', async () => {
    const id = 'slowpoke@example.com';
    // Per-request ttl of 1s; grab the code, let it lapse, then verify.
    await requestCode(id, 'session', { ttl: 1 });
    const code = await lastCode(id, 'session');
    await delay(1300);
    const ver = await verifyCode(id, 'session', code);
    assert.strictEqual(ver.status, 401);
    assert.match((await ver.json()).error, /expired/);
  });

  it('a verified code is single-use: replay is refused', async () => {
    const id = 'oneshot@example.com';
    await requestCode(id, 'session');
    const code = await lastCode(id, 'session');

    assert.strictEqual((await verifyCode(id, 'session', code)).status, 200, 'first use succeeds');
    const replay = await verifyCode(id, 'session', code);
    assert.strictEqual(replay.status, 401, 'second use refused');
    assert.match((await replay.json()).error, /no active code/);
  });

  it('rate limit trips after the per-identifier threshold', async () => {
    const id = 'flood@example.com';
    // rateLimitPerIdentifier is 3: three succeed, the fourth is throttled.
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await requestCode(id, 'session')).status);
    assert.deepStrictEqual(statuses.slice(0, 3), [201, 201, 201], 'first three allowed');
    assert.strictEqual(statuses[3], 429, 'fourth request throttled');
  });

  it('a tampered or missing session token is refused at whoami', async () => {
    const id = 'tamper@example.com';
    await requestCode(id, 'session');
    const code = await lastCode(id, 'session');
    const { token } = await (await verifyCode(id, 'session', code)).json();

    // Flip the last char of the signature segment.
    const [v, body, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const forged = `${v}.${body}.${flipped}`;
    assert.strictEqual((await whoami(forged)).status, 401, 'bad signature refused');

    // Re-scoped payload keeping the original signature: signature must fail.
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.purpose = 'recovery';
    const repayloaded = `${v}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    assert.strictEqual((await whoami(repayloaded)).status, 401, 're-scoped payload refused');

    assert.strictEqual((await whoami('otp1.not.real')).status, 401, 'garbage refused');
    assert.strictEqual((await whoami()).status, 401, 'missing Bearer refused');

    // Sanity: a token honestly signed with the wrong secret is refused too.
    const bogus = signSession({ v: 1, sub: id, purpose: 'session', iat: 0, exp: 9999999999 }, Buffer.from('not-the-secret'));
    assert.strictEqual((await whoami(bogus)).status, 401, 'foreign-secret token refused');
  });
});
