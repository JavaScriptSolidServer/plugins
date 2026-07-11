// Terminal plugin over a real JSS from npm: the gate refuses to boot open,
// unauthorized handshakes are closed, an authorized client runs a command
// and sees its output, and disconnect leaves no orphan shell.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module = path.join(__dirname, 'plugin.js');

const TOKEN = 'super-secret-terminal-token';
const AGENT_USER = 'alice';
const AGENT_PASS = 'correct horse battery staple';

// Collect raw string frames from a socket until `isDone(joined)` or timeout.
function collectRaw(socket, isDone, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`ws timeout; got ${JSON.stringify(buf)}`)), timeoutMs);
    socket.on('message', (data) => {
      buf += String(data);
      if (isDone(buf)) { clearTimeout(timer); resolve(buf); }
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// The HTTP upgrade always completes (fastify accepts it before our handler
// runs), so a refusal looks like open-then-immediate-close with code 1008.
// A connection counts as "opened" (usable) only if it stays open past a
// short grace window without the server closing it.
function open(url, opts, graceMs = 400) {
  const socket = new WebSocket(url, opts);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve({ socket, ...v }); } };
    socket.on('open', () => setTimeout(() => settle({ opened: true }), graceMs));
    socket.on('close', (code, reason) => settle({ opened: false, code, reason: String(reason) }));
    socket.on('error', () => settle({ opened: false }));
  });
}

describe('terminal plugin', () => {
  let jss;
  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without any access control', async () => {
    await assert.rejects(
      () => startJss({ plugins: [{ module, prefix: '/terminal', config: {} }] }),
      /refusing to boot an open shell|activate\(\) failed/i,
      'a config with neither allowAgents nor token must fail the boot',
    );
  });

  it('unauthorized handshake is closed (wrong / missing token)', async () => {
    jss = await startJss({ plugins: [{ module, prefix: '/terminal', config: { token: TOKEN } }] });

    const bad = await open(`${jss.wsBase}/terminal?token=nope`);
    assert.strictEqual(bad.opened, false, 'wrong token must not open a usable session');

    // A wrong token of the SAME length as the real one is also refused — the
    // compare is constant-time over sha256 digests, no length early-exit.
    const sameLen = await open(`${jss.wsBase}/terminal?token=${'x'.repeat(TOKEN.length)}`);
    assert.strictEqual(sameLen.opened, false, 'same-length wrong token must be refused');

    const none = await open(`${jss.wsBase}/terminal`);
    assert.strictEqual(none.opened, false, 'missing token must be refused');
  });

  it('authorized (token) runs a command and receives its output', async () => {
    const { socket, opened } = await open(`${jss.wsBase}/terminal?token=${TOKEN}`);
    assert.ok(opened, 'valid token must open');
    socket.send('echo hello-from-shell\n');
    const out = await collectRaw(socket, (b) => b.includes('hello-from-shell'));
    assert.match(out, /hello-from-shell/);
    socket.close();
  });

  it('kills the shell on disconnect — no orphan process', async () => {
    const { socket, opened } = await open(`${jss.wsBase}/terminal?token=${TOKEN}`);
    assert.ok(opened);
    // $$ is the shell's own pid; capture it, then disconnect and confirm death.
    socket.send('echo PID=$$\n');
    const out = await collectRaw(socket, (b) => /PID=\d+/.test(b));
    const pid = Number(out.match(/PID=(\d+)/)[1]);
    assert.ok(pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0), 'shell should be alive before disconnect');

    socket.close();
    // Poll for the process to disappear (SIGKILL on socket close).
    let dead = false;
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { dead = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(dead, `shell pid ${pid} should be reaped after disconnect`);
  });

  describe('agent allowlist via verified Bearer credential', () => {
    // The IdP signing keys and accounts live under the server's data root
    // (createServer sets DATA_ROOT=root). So we mint the credential on a
    // first boot, then re-boot the terminal on the SAME root: the persisted
    // JWKS still verifies the Bearer, and the WebID string is stable.
    it('allowlisted agent connects with a Bearer header; stranger is refused', async () => {
      // Boot 1: register two pods (an allowed agent + a stranger) on one
      // root, mint a Bearer for each — both signed by the same JWKS.
      const mintJss = await startJss({ idp: true, plugins: [] });
      const registerAndMint = async (username) => {
        const reg = await fetch(`${mintJss.base}/idp/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: AGENT_PASS, confirmPassword: AGENT_PASS }),
        });
        assert.ok([200, 201, 302].includes(reg.status) || reg.ok, `register ${username} status ${reg.status}`);
        const cred = await fetch(`${mintJss.base}/idp/credentials`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: AGENT_PASS }),
        });
        const body = await cred.json();
        assert.ok(body.access_token, `mint ${username} failed: ${JSON.stringify(body)}`);
        return body; // { access_token, webid }
      };
      const { access_token: token, webid: webId } = await registerAndMint(AGENT_USER);
      const { access_token: sTok } = await registerAndMint('mallory');
      const root = mintJss.root;
      await mintJss.close({ keepData: true });

      // Boot 2: same root -> same JWKS; allowlist exactly that WebID.
      const agentJss = await startJss({
        idp: true,
        root,
        plugins: [{ module, prefix: '/terminal', config: { allowAgents: [webId] } }],
      });
      try {
        // No credential -> refused.
        const anon = await open(`${agentJss.wsBase}/terminal`);
        assert.strictEqual(anon.opened, false, 'anonymous ws must be refused');

        // A validly-signed credential whose agent is NOT allowlisted -> refused.
        const notAllowed = await open(`${agentJss.wsBase}/terminal`, {
          headers: { authorization: `Bearer ${sTok}` },
        });
        assert.strictEqual(notAllowed.opened, false, 'a valid but non-allowlisted agent must be refused');

        // Allowlisted Bearer -> open + runs.
        const { socket, opened } = await open(`${agentJss.wsBase}/terminal`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.ok(opened, 'allowlisted agent must open');
        socket.send('echo agent-ok\n');
        const out = await collectRaw(socket, (b) => b.includes('agent-ok'));
        assert.match(out, /agent-ok/);
        socket.close();
      } finally {
        await agentJss.close();
      }
    });
  });
});
