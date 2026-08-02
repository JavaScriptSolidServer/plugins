// globs: NEONGLOBS realtime match server.
//   1. leaderboard starts empty
//   2. a guest plays a full bot match to matchEnd (no ELO for guests)
//   3. an authenticated agent (hello{token} browser path) loses to the bot
//      and the leaderboard records it
//   4. two humans get matched together, an over-speed commit is clamped,
//      and the authoritative state ships with the result
//
// aimTimeMs is cranked down so rounds resolve as soon as commits land; the
// bot's commits are set at phase start, so a client that commits instantly
// drives the whole match at socket speed.
//
// The message buffer is attached BEFORE the socket opens: the server pushes
// `welcome` immediately after the upgrade, which can beat any listener
// attached after `open` resolves.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { startJss, probePort } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const entry = {
  id: 'globs', module: path.join(__dirname, 'plugin.js'), prefix: '/globs',
  config: { aimTimeMs: 200, queueBotFallbackMs: 500 },
};

function openSock(url, headers) {
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  socket._msgs = [];
  socket._waiters = [];
  socket.on('message', (d) => {
    socket._msgs.push(JSON.parse(String(d)));
    for (const w of socket._waiters.slice()) w();
  });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitFor(socket, pred, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ws timeout; got ${JSON.stringify(socket._msgs.map(m => m.type))}`)), timeoutMs);
    const check = () => {
      if (pred(socket._msgs)) {
        clearTimeout(t);
        const i = socket._waiters.indexOf(check);
        if (i >= 0) socket._waiters.splice(i, 1);
        resolve(socket._msgs);
      }
    };
    socket._waiters.push(check);
    check();
  });
}

// drive one match: commit an empty arrow-set for every phase until matchEnd
async function playOut(socket) {
  const answered = new Set();
  for (;;) {
    const msgs = await waitFor(socket,
      m => m.some(x => (x.type === 'phase' && !answered.has(x.round)) || x.type === 'matchEnd'), 30_000);
    const end = msgs.find(x => x.type === 'matchEnd');
    if (end) return { end, seen: msgs };
    for (const m of msgs) {
      if (m.type === 'phase' && !answered.has(m.round)) {
        answered.add(m.round);
        socket.send(JSON.stringify({ type: 'commit', round: m.round, commits: {} }));
      }
    }
  }
}

describe('globs plugin', async () => {
  const port = await probePort();
  const base = `http://127.0.0.1:${port}`;
  const jss = await startJss({ port, idp: true, plugins: [entry] });
  after(() => jss.close());

  it('serves an empty leaderboard', async () => {
    const res = await fetch(`${base}/globs/leaderboard`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.top, []);
    assert.strictEqual(body.players, 0);
    assert.strictEqual(body.bots.length, 3);
  });

  it('lets a guest play a bot match to the end', async () => {
    const socket = await openSock(`${jss.wsBase}/globs/play`);
    const msgs = await waitFor(socket, m => m.some(x => x.type === 'welcome'));
    assert.strictEqual(msgs.find(x => x.type === 'welcome').agent, null);
    socket.send(JSON.stringify({ type: 'queue', bot: 1 }));
    await waitFor(socket, m => m.some(x => x.type === 'matched'));
    const matched = socket._msgs.find(x => x.type === 'matched');
    assert.strictEqual(matched.opponent.bot, 1);
    assert.strictEqual(matched.opponent.rating, 1100);
    const { end } = await playOut(socket);
    assert.strictEqual(end.winner, 1, 'an immobile guest loses to the bot');
    assert.strictEqual(end.elo, null, 'guests are unrated');
    socket.close();
    const body = await (await fetch(`${base}/globs/leaderboard`)).json();
    assert.strictEqual(body.players, 0, 'guest left no trace on the board');
  });

  it('rates an authenticated agent who loses to the bot (hello{token} path)', async () => {
    const USER = 'globtester', PASS = 'glob-secret-1';
    await fetch(`${base}/idp/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    const cred = await fetch(`${base}/idp/credentials`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    const token = (await cred.json()).access_token;
    assert.ok(token, 'minted a pod bearer');

    const socket = await openSock(`${jss.wsBase}/globs/play`);
    await waitFor(socket, m => m.some(x => x.type === 'welcome'));
    socket.send(JSON.stringify({ type: 'hello', token }));
    await waitFor(socket, m => m.some(x => x.type === 'welcome' && x.agent));
    const agent = socket._msgs.find(x => x.type === 'welcome' && x.agent).agent;
    assert.ok(agent.includes(USER), `agent resolved: ${agent}`);

    socket.send(JSON.stringify({ type: 'queue', bot: 1 }));
    const { end } = await playOut(socket);
    assert.strictEqual(end.winner, 1);
    assert.ok(end.elo, 'rated match reports an elo delta');
    assert.strictEqual(end.elo.old, 1200);
    assert.ok(end.elo.new < 1200, `rating drops on a loss (${end.elo.new})`);
    socket.close();

    const body = await (await fetch(`${base}/globs/leaderboard`)).json();
    assert.strictEqual(body.players, 1);
    assert.strictEqual(body.top[0].agent, agent);
    assert.strictEqual(body.top[0].losses, 1);
    assert.ok(body.top[0].rating < 1200);
  });

  it('pairs two humans, clamps an over-speed commit, ships authoritative state', async () => {
    const s1 = await openSock(`${jss.wsBase}/globs/play`);
    const s2 = await openSock(`${jss.wsBase}/globs/play`);
    await waitFor(s1, m => m.some(x => x.type === 'welcome'));
    await waitFor(s2, m => m.some(x => x.type === 'welcome'));
    s1.send(JSON.stringify({ type: 'queue' }));
    s2.send(JSON.stringify({ type: 'queue' }));
    await waitFor(s1, m => m.some(x => x.type === 'phase'));
    await waitFor(s2, m => m.some(x => x.type === 'phase'));
    const side1 = s1._msgs.find(x => x.type === 'matched').side;
    const side2 = s2._msgs.find(x => x.type === 'matched').side;
    assert.notStrictEqual(side1, side2, 'opposite sides');
    assert.strictEqual(s1._msgs.find(x => x.type === 'matched').opponent.bot, undefined);
    const round = s1._msgs.find(x => x.type === 'phase').round;
    s1.send(JSON.stringify({ type: 'commit', round, commits: { 0: { vx: 4000, vy: 0 } } }));
    s2.send(JSON.stringify({ type: 'commit', round, commits: { 0: { vx: -300, vy: 12 } } }));
    await waitFor(s1, m => m.some(x => x.type === 'result'));
    const reveal = s1._msgs.find(x => x.type === 'reveal');
    assert.ok(reveal, 'reveal broadcast');
    const v = reveal.commits[side1][0];
    assert.ok(Math.sqrt(v.vx * v.vx + v.vy * v.vy) <= 860.0001, 'over-speed commit clamped to MAXV');
    assert.ok(s1._msgs.find(x => x.type === 'result').state, 'authoritative state shipped');
    s1.close(); s2.close();
  });
});
