// Relay plugin over a real JSS from npm: publish, subscribe, verify,
// replaceable kinds, and persistence across a restart.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startJss, wsCollect } from '../helpers.js';
import { finalizeEvent, generateSecretKey } from './nip01.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const entry = { module: path.join(__dirname, 'plugin.js'), prefix: '/relay' };

function connect(wsBase) {
  const socket = new WebSocket(`${wsBase}/relay`);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

describe('relay plugin', () => {
  let jss;
  after(async () => { if (jss) await jss.close(); });

  it('accepts a signed event and rejects a forged one', async () => {
    jss = await startJss({ plugins: [entry] });
    const sk = generateSecretKey();
    const socket = await connect(jss.wsBase);

    const good = finalizeEvent({ kind: 1, content: 'hello from the plugin' }, sk);
    socket.send(JSON.stringify(['EVENT', good]));
    const [ok] = await wsCollect(socket, (m) => m.length >= 1);
    assert.deepStrictEqual(ok.slice(0, 3), ['OK', good.id, true]);

    const forged = { ...good, content: 'tampered' };
    socket.send(JSON.stringify(['EVENT', forged]));
    const msgs = await wsCollect(socket, (m) => m.length >= 1); // fresh listener
    assert.strictEqual(msgs[0][2], false);
    socket.close();
  });

  it('REQ returns stored events then EOSE; live events reach subscribers', async () => {
    const sub = await connect(jss.wsBase);
    sub.send(JSON.stringify(['REQ', 'sub1', { kinds: [1] }]));
    const history = await wsCollect(sub, (m) => m.some((x) => x[0] === 'EOSE'));
    assert.ok(history.some((m) => m[0] === 'EVENT' && m[2].content === 'hello from the plugin'));

    const pub = await connect(jss.wsBase);
    const live = finalizeEvent({ kind: 1, content: 'live one' }, generateSecretKey());
    pub.send(JSON.stringify(['EVENT', live]));
    const streamed = await wsCollect(sub, (m) => m.some((x) => x[0] === 'EVENT' && x[2].id === live.id));
    assert.ok(streamed.length > 0);
    sub.close();
    pub.close();
  });

  it('replaceable kinds replace instead of accumulate', async () => {
    const sk = generateSecretKey();
    const socket = await connect(jss.wsBase);
    const v1 = finalizeEvent({ kind: 0, content: '{"name":"one"}', created_at: 1000 }, sk);
    const v2 = finalizeEvent({ kind: 0, content: '{"name":"two"}', created_at: 2000 }, sk);
    socket.send(JSON.stringify(['EVENT', v1]));
    socket.send(JSON.stringify(['EVENT', v2]));
    await wsCollect(socket, (m) => m.filter((x) => x[0] === 'OK').length >= 2);

    socket.send(JSON.stringify(['REQ', 'meta', { kinds: [0], authors: [v1.pubkey] }]));
    const msgs = await wsCollect(socket, (m) => m.some((x) => x[0] === 'EOSE'));
    const found = msgs.filter((m) => m[0] === 'EVENT');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0][2].content, '{"name":"two"}');
    socket.close();
  });

  it('events survive a server restart (pluginDir persistence)', async () => {
    const root = jss.root;
    await jss.close({ keepData: true });
    jss = await startJss({ plugins: [entry], root });

    const socket = await connect(jss.wsBase);
    socket.send(JSON.stringify(['REQ', 'again', { kinds: [1] }]));
    const msgs = await wsCollect(socket, (m) => m.some((x) => x[0] === 'EOSE'));
    assert.ok(
      msgs.some((m) => m[0] === 'EVENT' && m[2].content === 'hello from the plugin'),
      `expected restored event, got ${JSON.stringify(msgs)}`,
    );
    socket.close();
  });
});
