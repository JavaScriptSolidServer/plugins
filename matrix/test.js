// Matrix Client-Server API shim over a real JSS from npm. Drives the whole
// Phase-1 vertical slice a Matrix client actually performs:
//
//   supported versions → GET  /_matrix/client/versions            (public)
//   log in             → POST /_matrix/client/v3/login            (pod creds)
//   who am I           → GET  /_matrix/client/v3/account/whoami
//   create a room      → POST /_matrix/client/v3/createRoom
//   send a message     → PUT  /_matrix/client/v3/rooms/{id}/send/m.room.message/{txn}
//   read it back       → GET  /_matrix/client/v3/rooms/{id}/messages
//
// Same probe-port-then-boot dance as mastodon/ and bluesky/: the shim needs
// its server origin in config before listen (finding: api.serverInfo), and
// idp:true gives us the /idp/register + /idp/credentials the token bridge
// rides on. The fixed `/_matrix` root is widened into appPaths by hand (the
// reserved-path finding — the operator must, a plugin can't self-exempt).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'matrixalice';
const PASS = 'correct horse battery staple';

describe('matrix plugin', () => {
  let jss;
  let base;
  let host;
  let token;
  let roomId;

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without baseUrl (no api.serverInfo — same finding as mastodon/bluesky)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_ }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + the shim, and registers a pod owner', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    host = `127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      // The finding in action: Matrix's fixed Client-Server root (/_matrix)
      // is an absolute path no single plugin `prefix` can own, so the plugin
      // can't self-exempt it from WAC — the operator widens appPaths by hand.
      appPaths: ['/_matrix'],
      plugins: [{ module: module_, config: { baseUrl: base } }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);
  });

  it('GET /_matrix/client/versions is public and lists supported versions', async () => {
    const res = await fetch(`${base}/_matrix/client/versions`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.versions) && body.versions.length > 0, 'no versions');
  });

  it('POST /_matrix/client/v3/login bridges pod creds to an access_token', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: USER },
        password: PASS,
      }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.access_token, `no access_token: ${JSON.stringify(body)}`);
    assert.strictEqual(body.user_id, `@${USER}:${host}`);
    assert.ok(body.device_id, 'no device_id');
    assert.strictEqual(body.home_server, host);
    token = body.access_token;
  });

  it('bad password is rejected at login (M_FORBIDDEN)', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', user: USER, password: 'wrong-password' }),
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).errcode, 'M_FORBIDDEN');
  });

  it('GET /_matrix/client/v3/account/whoami returns the logged-in user_id', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).user_id, `@${USER}:${host}`);

    // anonymous is 401
    const anon = await fetch(`${base}/_matrix/client/v3/account/whoami`);
    assert.strictEqual(anon.status, 401);
  });

  it('POST /_matrix/client/v3/createRoom persists a room in the pod and returns a room_id', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Room', topic: 'greetings' }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.room_id, new RegExp(`^!.+:${host.replace('.', '\\.')}$`), `bad room_id: ${body.room_id}`);
    roomId = body.room_id;

    // It really landed in the pod as a JSON resource under the owner's control.
    const local = roomId.replace(/^!/, '').split(':')[0];
    const raw = await fetch(`${base}/${USER}/matrix/rooms/${local}.json`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(raw.status, 200);
    const room = await raw.json();
    assert.strictEqual(room.room_id, roomId);
    assert.ok(Array.isArray(room.events), 'room has no events array');
  });

  it('unauthenticated createRoom is refused (401)', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    assert.strictEqual(res.status, 401);
  });

  it('PUT .../send/m.room.message/{txnId} appends an event and returns an event_id', async () => {
    const txnId = 'txn1';
    const res = await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello matrix' }),
      },
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.event_id && body.event_id.startsWith('$'), `bad event_id: ${JSON.stringify(body)}`);

    // Idempotency: re-sending the same txnId returns the same event_id.
    const again = await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello matrix' }),
      },
    );
    assert.strictEqual((await again.json()).event_id, body.event_id, 'txnId not idempotent');
  });

  it('GET .../messages returns the room timeline containing the message', async () => {
    const res = await fetch(
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=f`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.chunk), 'chunk is not an array');
    const msg = body.chunk.find((e) => e.type === 'm.room.message');
    assert.ok(msg, 'sent message not in timeline');
    assert.strictEqual(msg.content.body, 'hello matrix');
    assert.strictEqual(msg.sender, `@${USER}:${host}`);
  });

  it('GET /_matrix/client/v3/joined_rooms lists the created room', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/joined_rooms`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.joined_rooms), 'joined_rooms not an array');
    assert.ok(body.joined_rooms.includes(roomId), `room ${roomId} not in ${JSON.stringify(body.joined_rooms)}`);
  });

  it('GET /_matrix/client/v3/sync (stub) returns the room with its timeline', async () => {
    const res = await fetch(`${base}/_matrix/client/v3/sync`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.next_batch, 'no next_batch');
    assert.ok(body.rooms && body.rooms.join, 'no rooms.join');
    assert.ok(body.rooms.join[roomId], `room ${roomId} not in sync`);
    const evs = body.rooms.join[roomId].timeline.events;
    assert.ok(evs.some((e) => e.type === 'm.room.message'), 'message not in sync timeline');
  });
});
