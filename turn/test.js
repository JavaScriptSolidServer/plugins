// TURN credentials plugin over a real JSS from npm: draft-uberti REST shape,
// HMAC correctness against the shared secret, expiry math, user tags,
// env-variable config fallback, auth gating, and loud activation failures.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const MODULE = path.join(__dirname, 'plugin.js');
const SECRET = 'test-static-auth-secret';
const URIS = ['turn:relay.example:3478?transport=udp', 'turns:relay.example:5349'];

const hmac = (username) =>
  crypto.createHmac('sha1', SECRET).update(username).digest('base64');

describe('turn credentials plugin', () => {
  let jss;
  before(async () => {
    jss = await startJss({
      plugins: [{ module: MODULE, prefix: '/turn', config: { secret: SECRET, uris: URIS, ttl: 600 } }],
    });
  });
  after(async () => { if (jss) await jss.close(); });

  it('mints draft-shaped credentials coturn will verify', async () => {
    const res = await fetch(`${jss.base}/turn/credentials`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepStrictEqual(body.uris, URIS);
    assert.strictEqual(body.ttl, 600);
    // username is a bare unix expiry ~ttl from now
    assert.match(body.username, /^\d+$/);
    const skew = Number(body.username) - (Math.floor(Date.now() / 1000) + 600);
    assert.ok(Math.abs(skew) < 30, `expiry off by ${skew}s`);
    // password = base64(HMAC-SHA1(secret, username)) — coturn's check, replayed
    assert.strictEqual(body.password, hmac(body.username));
    // drop-in iceServers entry
    assert.deepStrictEqual(body.iceServers, [{ urls: URIS, username: body.username, credential: body.password }]);
  });

  it('embeds a user tag after the expiry, colon-delimited', async () => {
    const res = await fetch(`${jss.base}/turn/credentials?user=mesh-tab.1`);
    const body = await res.json();
    assert.match(body.username, /^\d+:mesh-tab\.1$/);
    assert.strictEqual(body.password, hmac(body.username));
  });

  it('rejects tags outside [A-Za-z0-9._-]{1,64}', async () => {
    const res = await fetch(`${jss.base}/turn/credentials?user=${encodeURIComponent('a:b c')}`);
    assert.strictEqual(res.status, 400);
  });

  it('reads secret and uris from the environment when config carries none', async () => {
    process.env.TURN_STATIC_AUTH_SECRET = SECRET;
    process.env.TURN_URIS = URIS.join(', ');
    let envJss;
    try {
      envJss = await startJss({ plugins: [{ module: MODULE, prefix: '/turn-env' }] });
      const body = await (await fetch(`${envJss.base}/turn-env/credentials`)).json();
      assert.deepStrictEqual(body.uris, URIS);
      assert.strictEqual(body.password, hmac(body.username));
    } finally {
      delete process.env.TURN_STATIC_AUTH_SECRET;
      delete process.env.TURN_URIS;
      if (envJss) await envJss.close();
    }
  });

  it('requireAuth turns anonymous minting into a 401', async () => {
    const gated = await startJss({
      plugins: [{ module: MODULE, prefix: '/turn-gated', config: { secret: SECRET, uris: URIS, requireAuth: true } }],
    });
    try {
      const res = await fetch(`${gated.base}/turn-gated/credentials`);
      assert.strictEqual(res.status, 401);
    } finally { await gated.close(); }
  });

  it('a missing secret fails listen() loudly', async () => {
    await assert.rejects(
      () => startJss({ plugins: [{ module: MODULE, prefix: '/turn-bad', config: { uris: URIS } }] }),
      /no secret/,
    );
  });

  it('missing uris fail listen() loudly', async () => {
    await assert.rejects(
      () => startJss({ plugins: [{ module: MODULE, prefix: '/turn-bad2', config: { secret: SECRET } }] }),
      /no TURN uris/,
    );
  });
});
