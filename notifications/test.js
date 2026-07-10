// Notifications plugin over a real JSS from npm: solid-0.1 protocol,
// change detection via the pod filesystem, container fan-out, and the
// loopback authorization check against real WAC.
//
// The setup itself demonstrates a finding: the plugin needs its server's
// public origin in config (for pub URLs, origin checks, and the loopback
// authorization), and a plugin cannot learn that origin at activate() time
// — so the test probes a port FIRST and boots the server on it. An
// operator does the same statically; api.serverInfo would remove the dance.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

function connect(wsBase) {
  const socket = new WebSocket(`${wsBase}/.notifications`);
  return new Promise((resolve, reject) => {
    const lines = [];
    socket.on('message', (d) => lines.push(String(d)));
    socket.on('open', () => resolve({ socket, lines }));
    socket.on('error', reject);
  });
}

function waitFor(lines, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = lines.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout; lines: ${JSON.stringify(lines)}`));
      }
    }, 25);
  });
}

describe('notifications plugin', () => {
  let jss;
  after(async () => { if (jss) await jss.close(); });

  it('boots only when podsRoot and baseUrl are configured', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: path.join(__dirname, 'plugin.js'), prefix: '/.notifications' }] }),
      /requires config\.podsRoot and config\.baseUrl/,
    );
  });

  it('speaks solid-0.1: greeting, sub/ack, pub on file change', async () => {
    const port = await probePort();
    const base = `http://127.0.0.1:${port}`;
    const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'jss-notif-'));
    jss = await startJss({
      port,
      root,
      plugins: [{
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/.notifications',
        config: { podsRoot: root, baseUrl: base },
      }],
    });

    // Public-read ACL first: the plugin authorizes subscriptions by asking
    // the server itself, so a WAC-refused resource is a refused sub.
    fs.writeFileSync(
      path.join(root, 'public-note.txt.acl'),
      `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#public> a acl:Authorization;
  acl:agentClass foaf:Agent;
  acl:accessTo <./public-note.txt>;
  acl:mode acl:Read.
`,
    );
    const { socket, lines } = await connect(jss.wsBase);
    await waitFor(lines, (l) => l === 'protocol solid-0.1');

    const resourceUrl = `${base}/public-note.txt`;
    socket.send(`sub ${resourceUrl}`);
    await waitFor(lines, (l) => l === `ack ${resourceUrl}`);

    fs.writeFileSync(path.join(root, 'public-note.txt'), 'changed!');
    await waitFor(lines, (l) => l === `pub ${resourceUrl}`);
    socket.close();
  });

  it('notifies ancestor container subscribers', async () => {
    const base = jss.base;
    const { socket, lines } = await connect(jss.wsBase);
    await waitFor(lines, (l) => l === 'protocol solid-0.1');

    const containerUrl = `${base}/`;
    socket.send(`sub ${containerUrl}`);
    await waitFor(lines, (l) => l === `ack ${containerUrl}`);

    fs.writeFileSync(path.join(jss.root, 'another-file.txt'), 'x');
    await waitFor(lines, (l) => l === `pub ${containerUrl}`);
    socket.close();
  });

  it('forbids subscriptions the server itself would refuse', async () => {
    const base = jss.base;
    // A resource locked down by a WAC acl only its owner can read.
    fs.writeFileSync(path.join(jss.root, 'secret.txt'), 'hidden');
    fs.writeFileSync(
      path.join(jss.root, 'secret.txt.acl'),
      `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization;
  acl:agent <https://owner.example/profile#me>;
  acl:accessTo <./secret.txt>;
  acl:mode acl:Read, acl:Write, acl:Control.
`,
    );
    const { socket, lines } = await connect(jss.wsBase);
    await waitFor(lines, (l) => l === 'protocol solid-0.1');
    socket.send(`sub ${base}/secret.txt`);
    await waitFor(lines, (l) => l === `err ${base}/secret.txt forbidden`);

    // Cross-origin subscriptions are refused outright.
    socket.send('sub https://elsewhere.example/thing');
    await waitFor(lines, (l) => l.startsWith('err https://elsewhere.example/thing'));
    socket.close();
  });

  it('reports status under its own prefix', async () => {
    const res = await fetch(`${jss.base}/.notifications/status`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.protocol, 'solid-0.1');
  });
});
