// WebRTC signaling plugin over a real JSS from npm: identity-based
// offer/answer/ICE relay between authenticated pods, content-addressed
// rooms with isolation, tracker dialect, disconnect cleanup, errors.

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

/** Resolve at the first message of the given type; attach BEFORE triggering. */
function expectType(socket, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', handler);
      reject(new Error(`timeout waiting for "${type}"`));
    }, timeoutMs);
    function handler(data) {
      const msg = JSON.parse(String(data));
      if (msg.type === type || msg.action === type) {
        clearTimeout(timer);
        socket.off('message', handler);
        resolve(msg);
      }
    }
    socket.on('message', handler);
  });
}

/** Collect every message arriving within a quiet window. */
function collectFor(socket, ms = 300) {
  return new Promise((resolve) => {
    const msgs = [];
    const handler = (data) => msgs.push(JSON.parse(String(data)));
    socket.on('message', handler);
    setTimeout(() => {
      socket.off('message', handler);
      resolve(msgs);
    }, ms);
  });
}

function open(url, opts) {
  const socket = new WebSocket(url, opts);
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

describe('webrtc plugin', () => {
  let jss;
  const pods = {}; // name -> { webId, token }

  before(async () => {
    jss = await startJss({ plugins: [entry] });
    for (const name of ['alice', 'bob', 'charlie']) {
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
    const socket = await open(wsUrl(), {
      headers: { Authorization: `Bearer ${pods[name].token}` },
    });
    const welcome = await expectType(socket, 'peers');
    return { socket, welcome };
  }

  it('welcomes an authenticated peer with you/peerId/peers', async () => {
    const { socket, welcome } = await connectAs('alice');
    assert.strictEqual(welcome.you, pods.alice.webId);
    assert.ok(welcome.peerId, 'welcome carries a peerId for content-addressed mode');
    assert.deepStrictEqual(welcome.peers, []);
    socket.close();
  });

  it('authenticates via ?token= query param (browser WebSocket)', async () => {
    const socket = await open(`${wsUrl()}?token=${encodeURIComponent(pods.bob.token)}`);
    const welcome = await expectType(socket, 'peers');
    assert.strictEqual(welcome.you, pods.bob.webId);
    socket.close();
  });

  it('relays the full identity-based lifecycle: join, offer, answer, candidate, hangup, leave', async () => {
    const { socket: alice } = await connectAs('alice');

    const joined = expectType(alice, 'peer-joined');
    const { socket: bob, welcome: bobWelcome } = await connectAs('bob');
    assert.deepStrictEqual(bobWelcome.peers, [pods.alice.webId], 'bob sees alice');
    assert.strictEqual((await joined).webId, pods.bob.webId, 'alice told of bob');

    // offer alice -> bob
    let inbox = expectType(bob, 'offer');
    alice.send(JSON.stringify({ type: 'offer', to: pods.bob.webId, sdp: 'v=0\r\nalice-offer' }));
    const offer = await inbox;
    assert.strictEqual(offer.from, pods.alice.webId);
    assert.strictEqual(offer.sdp, 'v=0\r\nalice-offer');
    assert.strictEqual(offer.to, undefined, '"to" is stripped from the relay');

    // answer bob -> alice
    inbox = expectType(alice, 'answer');
    bob.send(JSON.stringify({ type: 'answer', to: pods.alice.webId, sdp: 'v=0\r\nbob-answer' }));
    const answer = await inbox;
    assert.strictEqual(answer.from, pods.bob.webId);
    assert.strictEqual(answer.sdp, 'v=0\r\nbob-answer');

    // ICE candidate alice -> bob
    inbox = expectType(bob, 'candidate');
    alice.send(JSON.stringify({
      type: 'candidate',
      to: pods.bob.webId,
      candidate: { candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 12345 typ host', sdpMid: '0' },
    }));
    const cand = await inbox;
    assert.strictEqual(cand.from, pods.alice.webId);
    assert.ok(cand.candidate.candidate.includes('UDP'));

    // hangup alice -> bob
    inbox = expectType(bob, 'hangup');
    alice.send(JSON.stringify({ type: 'hangup', to: pods.bob.webId }));
    assert.strictEqual((await inbox).from, pods.alice.webId);

    // bob disconnects -> alice gets peer-left
    const left = expectType(alice, 'peer-left');
    bob.close();
    assert.strictEqual((await left).webId, pods.bob.webId);
    alice.close();
  });

  it('rejects identity-based signaling from anonymous sockets, but serves the tracker dialect', async () => {
    const anon = await open(wsUrl());

    const err = expectType(anon, 'error');
    anon.send(JSON.stringify({ type: 'offer', to: pods.alice.webId, sdp: 'x' }));
    assert.match((await err).message, /Authentication required/);

    const announced = expectType(anon, 'announce');
    anon.send(JSON.stringify({
      action: 'announce',
      info_hash: '01234567890123456789',
      peer_id: '98765432109876543210',
      offers: [],
    }));
    const resp = await announced;
    assert.strictEqual(resp.interval, 120);
    assert.strictEqual(resp.info_hash, '01234567890123456789');
    anon.close();
  });

  it('content-addressed rooms: announce, offer/answer relay, room isolation', async () => {
    const ROOM_A = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const ROOM_B = 'ffff0000ffff0000ffff0000ffff0000ffff0000';

    // Anonymous sockets are fine for content-addressed mode
    const alice = await open(wsUrl());
    const bob = await open(wsUrl());
    const charlie = await open(wsUrl());

    // charlie sits in room B
    let counted = expectType(charlie, 'resource-peers');
    charlie.send(JSON.stringify({ type: 'announce', resource: ROOM_B, offers: [] }));
    assert.strictEqual((await counted).count, 0);
    const charlieQuiet = collectFor(charlie, 700);

    // alice joins room A first
    counted = expectType(alice, 'resource-peers');
    alice.send(JSON.stringify({ type: 'announce', resource: ROOM_A, offers: [] }));
    const aliceCount = await counted;
    assert.strictEqual(aliceCount.resource, ROOM_A);
    assert.strictEqual(aliceCount.count, 0);

    // bob joins room A with an offer -> relayed to alice
    const offered = expectType(alice, 'offer');
    counted = expectType(bob, 'resource-peers');
    bob.send(JSON.stringify({
      type: 'announce',
      resource: ROOM_A,
      offers: [{ sdp: 'v=0\r\nbob-room-offer', offer_id: 'offer-1' }],
    }));
    assert.strictEqual((await counted).count, 1, 'bob sees alice in the room');
    const offer = await offered;
    assert.strictEqual(offer.resource, ROOM_A);
    assert.strictEqual(offer.offer_id, 'offer-1');
    assert.ok(offer.from, 'offer carries the sender peerId');
    assert.ok(offer.sdp.includes('bob-room-offer'));

    // alice answers bob by peerId
    const answered = expectType(bob, 'answer');
    alice.send(JSON.stringify({
      type: 'answer', resource: ROOM_A, to: offer.from, offer_id: 'offer-1', sdp: 'v=0\r\nalice-room-answer',
    }));
    const answer = await answered;
    assert.strictEqual(answer.resource, ROOM_A);
    assert.strictEqual(answer.offer_id, 'offer-1');
    assert.ok(answer.sdp.includes('alice-room-answer'));

    // isolation: charlie (room B) saw none of room A's traffic
    const strays = (await charlieQuiet).filter((m) => m.resource === ROOM_A);
    assert.deepStrictEqual(strays, [], 'room B client must not receive room A messages');

    alice.close();
    bob.close();
    charlie.close();
  });

  it('leave and disconnect both remove a peer from its rooms', async () => {
    const ROOM = '0123456789abcdef0123456789abcdef01234567';

    // leave: alice joins then leaves; bob then counts 0
    const alice = await open(wsUrl());
    let counted = expectType(alice, 'resource-peers');
    alice.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    await counted;
    alice.send(JSON.stringify({ type: 'leave', resource: ROOM }));

    const bob = await open(wsUrl());
    counted = expectType(bob, 'resource-peers');
    bob.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    assert.strictEqual((await counted).count, 0, 'leave removed alice');

    // disconnect: bob is in; closing his socket empties the room again
    bob.close();
    await new Promise((r) => setTimeout(r, 200));

    const carol = await open(wsUrl());
    counted = expectType(carol, 'resource-peers');
    carol.send(JSON.stringify({ type: 'announce', resource: ROOM, offers: [] }));
    assert.strictEqual((await counted).count, 0, 'disconnect removed bob');

    alice.close();
    carol.close();
  });

  it('errors: invalid JSON, missing to, peer not online, invalid hash, unknown type, oversized message', async () => {
    const { socket: alice } = await connectAs('alice');

    let err = expectType(alice, 'error');
    alice.send('not json');
    assert.strictEqual((await err).message, 'Invalid JSON');

    err = expectType(alice, 'error');
    alice.send(JSON.stringify({ type: 'offer', sdp: 'x' }));
    assert.match((await err).message, /Missing "to"/);

    err = expectType(alice, 'error');
    alice.send(JSON.stringify({ type: 'offer', to: 'https://nobody.example/#me', sdp: 'x' }));
    assert.match((await err).message, /not online/);

    err = expectType(alice, 'error');
    alice.send(JSON.stringify({ type: 'announce', resource: 'not-hex!', offers: [] }));
    assert.match((await err).message, /Invalid resource hash/);

    err = expectType(alice, 'error');
    alice.send(JSON.stringify({ type: 'shout', to: pods.bob.webId }));
    assert.match((await err).message, /Unknown type/);

    // config.maxMessageSize = 4096 for this entry
    err = expectType(alice, 'error');
    alice.send(JSON.stringify({ type: 'offer', to: pods.bob.webId, sdp: 'x'.repeat(5000) }));
    assert.strictEqual((await err).message, 'Message too large');

    alice.close();
  });
});
