// WebRTC signaling plugin over a real JSS from npm: identity-based
// offer/answer/ICE relay between authenticated pods, content-addressed
// rooms with isolation, tracker dialect, disconnect cleanup, errors.
//
// The test client buffers every message from socket construction: the
// server's welcome can share a TCP segment with the 101 handshake, and
// node's ws parses it synchronously right after emitting 'open' — a
// listener attached after `await open` is too late (see README Findings).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const entry = {
  module: path.join(__dirname, 'plugin.js'),
  prefix: '/webrtc',
  config: { maxMessageSize: 4096 },
};

/** Connect and buffer every incoming message from the very first frame. */
function connect(url, opts) {
  const socket = new WebSocket(url, opts);
  socket.inbox = [];
  socket.waiters = new Set();
  socket.on('message', (data) => {
    const msg = JSON.parse(String(data));
    for (const w of socket.waiters) {
      if (w.match(msg)) {
        socket.waiters.delete(w);
        w.resolve(msg);
        return;
      }
    }
    socket.inbox.push(msg);
  });
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Next buffered-or-future message of the given type (or tracker action). */
// Generous: the first getAgent in a fresh process pays a one-time cold
// load (JWKS + crypto). See NOTES.md — a hermetic test-credential seam
// would remove the need for this margin.
function next(socket, type, timeoutMs = 15000) {
  const match = (m) => m.type === type || m.action === type;
  const i = socket.inbox.findIndex(match);
  if (i !== -1) return Promise.resolve(socket.inbox.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve: null };
    const timer = setTimeout(() => {
      socket.waiters.delete(waiter);
      reject(new Error(`timeout waiting for "${type}"; inbox=${JSON.stringify(socket.inbox)}`));
    }, timeoutMs);
    waiter.resolve = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    socket.waiters.add(waiter);
  });
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('webrtc plugin', () => {
  let jss;
  const pods = {}; // name -> { webId, token, ... }

  before(async () => {
    jss = await startJss({ plugins: [entry] });
    for (const name of ['alice', 'bob']) {
      const res = await fetch(`${jss.base}/.pods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      assert.strictEqual(res.status, 201, `pod ${name}`);
      pods[name] = await res.json();
    }
  });
  after(async () => { if (jss) await jss.close(); });

  const wsUrl = () => `${jss.wsBase}/webrtc`;

  /** Authenticated connect via Bearer header; waits for the welcome. */
  async function connectAs(name) {
    const socket = await connect(wsUrl(), {
      headers: { Authorization: `Bearer ${pods[name].token}` },
    });
    const welcome = await next(socket, 'peers');
    return { socket, welcome };
  }

  it('welcomes an authenticated peer with you/peerId/peers', async () => {
    const { socket, welcome } = await connectAs('alice');
    assert.strictEqual(welcome.you, pods.alice.webId);
    assert.ok(welcome.peerId, 'welcome carries a peerId for content-addressed mode');
    assert.deepStrictEqual(welcome.peers, []);
    socket.close();
    await settle(100);
  });

  it('authenticates via ?token= query param (browser WebSocket)', async () => {
    const socket = await connect(`${wsUrl()}?token=${encodeURIComponent(pods.bob.token)}`);
    const welcome = await next(socket, 'peers');
    assert.strictEqual(welcome.you, pods.bob.webId);
    socket.close();
    await settle(100);
  });

  it('relays the full identity-based lifecycle: join, offer, answer, candidate, hangup, leave', async () => {
    const { socket: alice } = await connectAs('alice');

    const { socket: bob, welcome: bobWelcome } = await connectAs('bob');
    assert.deepStrictEqual(bobWelcome.peers, [pods.alice.webId], 'bob sees alice');
    const joined = await next(alice, 'peer-joined');
    assert.strictEqual(joined.webId, pods.bob.webId, 'alice told of bob');

    // offer alice -> bob
    alice.send(JSON.stringify({ type: 'offer', to: pods.bob.webId, sdp: 'v=0\r\nalice-offer' }));
    const offer = await next(bob, 'offer');
    assert.strictEqual(offer.from, pods.alice.webId);
    assert.strictEqual(offer.sdp, 'v=0\r\nalice-offer');
    assert.strictEqual(offer.to, undefined, '"to" is stripped from the relay');

    // answer bob -> alice
    bob.send(JSON.stringify({ type: 'answer', to: pods.alice.webId, sdp: 'v=0\r\nbob-answer' }));
    const answer = await next(alice, 'answer');
    assert.strictEqual(answer.from, pods.bob.webId);
    assert.strictEqual(answer.sdp, 'v=0\r\nbob-answer');

    // ICE candidate alice -> bob
    alice.send(JSON.stringify({
      type: 'candidate',
      to: pods.bob.webId,
      candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 12345 typ host', sdpMid: '0' },
    }));
    const cand = await next(bob, 'candidate');
    assert.strictEqual(cand.from, pods.alice.webId);
    assert.ok(cand.candidate.candidate.includes('UDP'));

    // hangup alice -> bob
    alice.send(JSON.stringify({ type: 'hangup', to: pods.bob.webId }));
    const hangup = await next(bob, 'hangup');
    assert.strictEqual(hangup.from, pods.alice.webId);

    // bob disconnects -> alice gets peer-left
    bob.close();
    const left = await next(alice, 'peer-left');
    assert.strictEqual(left.webId, pods.bob.webId);
    alice.close();
    await settle(100);
  });

  it('rejects identity-based signaling from anonymous sockets, but serves the tracker dialect', async () => {
    const anon = await connect(wsUrl());

    anon.send(JSON.stringify({ type: 'offer', to: pods.alice.webId, sdp: 'x' }));
    const err = await next(anon, 'error');
    assert.match(err.message, /Authentication required/);

    anon.send(JSON.stringify({
      action: 'announce',
      info_hash: '01234567890123456789',
      peer_id: '98765432109876543210',
      offers: [],
    }));
    const resp = await next(anon, 'announce');
    assert.strictEqual(resp.interval, 120);
    assert.strictEqual(resp.info_hash, '01234567890123456789');
    anon.close();
    await settle(100);
  });

  it('content-addressed rooms: announce, offer/answer relay, room isolation', async () => {
    const ROOM_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const ROOM_B = 'ffff0000ffff0000ffff0000ffff0000ffff0000';

    // Anonymous sockets are fine for content-addressed mode
    const alice = await connect(wsUrl());
    const bob = await connect(wsUrl());
    const charlie = await connect(wsUrl());

    // charlie sits alone in room B
    charlie.send(JSON.stringify({ type: 'announce', resource: ROOM_B, offers: [] }));
    assert.strictEqual((await next(charlie, 'resource-peers')).count, 0);

    // alice joins room A first
    alice.send(JSON.stringify({ type: 'announce', resource: ROOM_A, offers: [] }));
    const aliceCount = await next(alice, 'resource-peers');
    assert.strictEqual(aliceCount.resource, ROOM_A);
    assert.strictEqual(aliceCount.count, 0);

    // bob joins room A with an offer -> relayed to alice
    bob.send(JSON.stringify({
      type: 'announce',
      resource: ROOM_A,
      offers: [{ sdp: 'v=0\r\nbob-room-offer', offer_id: 'offer-1' }],
    }));
    assert.strictEqual((await next(bob, 'resource-peers')).count, 1, 'bob sees alice in the room');
    const offer = await next(alice, 'offer');
    assert.strictEqual(offer.resource, ROOM_A);
    assert.strictEqual(offer.offer_id, 'offer-1');
    assert.ok(offer.from, 'offer carries the sender peerId');
    assert.ok(offer.sdp.includes('bob-room-offer'));

    // alice answers bob by peerId
    alice.send(JSON.stringify({
      type: 'answer', resource: ROOM_A, to: offer.from, offer_id: 'offer-1', sdp: 'v=0\r\nalice-room-answer',
    }));
    const answer = await next(bob, 'answer');
    assert.strictEqual(answer.resource, ROOM_A);
    assert.strictEqual(answer.offer_id, 'offer-1');
    assert.ok(answer.sdp.includes('alice-room-answer'));

    // isolation: charlie (room B) saw none of room A's traffic
    await settle(300);
    const strays = charlie.inbox.filter((m) => m.resource === ROOM_A);
    assert.deepStrictEqual(strays, [], 'room B client must not receive room A messages');

    alice.close();
    bob.close();
    charlie.close();
    await settle(100);
  });

  it('leave and disconnect both remove a peer from its rooms', async () => {
    const ROOM = '0123456789abcdef0123456789abcdef01234567';

    // leave: alice joins then leaves; bob then counts 0
    const alice = await connect(wsUrl());
    alice.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    await next(alice, 'resource-peers');
    alice.send(JSON.stringify({ type: 'leave', resource: ROOM }));
    await settle(100);

    const bob = await connect(wsUrl());
    bob.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    assert.strictEqual((await next(bob, 'resource-peers')).count, 0, 'leave removed alice');

    // disconnect: bob is in; closing his socket empties the room again
    bob.close();
    await settle(200);

    const carol = await connect(wsUrl());
    carol.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    assert.strictEqual((await next(carol, 'resource-peers')).count, 0, 'disconnect removed bob');

    alice.close();
    carol.close();
    await settle(100);
  });

  it('errors: invalid JSON, missing to, peer not online, invalid hash, unknown type, oversized message', async () => {
    const { socket: alice } = await connectAs('alice');

    alice.send('not json');
    assert.strictEqual((await next(alice, 'error')).message, 'Invalid JSON');

    alice.send(JSON.stringify({ type: 'offer', sdp: 'x' }));
    assert.match((await next(alice, 'error')).message, /Missing "to"/);

    alice.send(JSON.stringify({ type: 'offer', to: 'https://nobody.example/#me', sdp: 'x' }));
    assert.match((await next(alice, 'error')).message, /not online/);

    alice.send(JSON.stringify({ type: 'announce', resource: 'not-hex!', offers: [] }));
    assert.match((await next(alice, 'error')).message, /Invalid resource hash/);

    alice.send(JSON.stringify({ type: 'shout', to: pods.bob.webId }));
    assert.match((await next(alice, 'error')).message, /Unknown type/);

    // config.maxMessageSize = 4096 for this entry
    alice.send(JSON.stringify({ type: 'offer', to: pods.bob.webId, sdp: 'x'.repeat(5000) }));
    assert.strictEqual((await next(alice, 'error')).message, 'Message too large');

    alice.close();
    await settle(100);
  });
});
