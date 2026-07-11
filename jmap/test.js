// JMAP server over a real JSS from npm. Drives the vertical slice a JMAP
// mail client actually performs:
//
//   discover     → GET  /.well-known/jmap                (301 → session)
//   session      → GET  /jmap/session                    (pod Bearer)
//   mailboxes    → POST /jmap/api  Mailbox/get
//   write mail   → POST /jmap/api  Email/set   (create into Inbox)
//   find it      → POST /jmap/api  Email/query (inMailbox, total)
//   read it      → POST /jmap/api  Email/get   (fields)
//   move it      → POST /jmap/api  Email/set   (update mailboxIds → Trash)
//   delete it    → POST /jmap/api  Email/set   (destroy)
//
// Same probe-port-then-boot dance as mastodon/matrix (finding:
// api.serverInfo); idp:true supplies /idp/register + /idp/credentials so a
// pod Bearer can be minted — the JMAP "token" IS the pod bearer. Unlike
// mastodon/bluesky/matrix, NO appPaths widening: everything lives under the
// /jmap prefix except /.well-known/jmap, which rides core's blanket
// /.well-known/* WAC exemption (the by-luck reservePath finding).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const USER = 'jmapalice';
const PASS = 'correct horse battery staple';
const CORE_URN = 'urn:ietf:params:jmap:core';
const MAIL_URN = 'urn:ietf:params:jmap:mail';

describe('jmap plugin', () => {
  let jss;
  let base;
  let token;
  let accountId;
  let apiUrl;
  let emailId;

  after(async () => { if (jss) await jss.close(); });

  /** POST a JMAP Request; returns { status, body }. */
  async function call(methodCalls, { auth = true, using = [CORE_URN, MAIL_URN] } = {}) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ using, methodCalls }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Email/query inMailbox → the response args ({ ids, total, ... }). */
  async function query(mailboxId) {
    const { status, body } = await call([
      ['Email/query', { accountId, filter: { inMailbox: mailboxId } }, 'q0'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args, callId] = body.methodResponses[0];
    assert.strictEqual(name, 'Email/query', JSON.stringify(args));
    assert.strictEqual(callId, 'q0');
    return args;
  }

  // Validation-failure boots FIRST: a second createServer in this process —
  // even a failing one — repoints the module-global DATA_ROOT and would
  // poison a long-lived earlier boot (the documented footgun).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as mastodon/matrix)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 'jmap', module: module_, prefix: '/jmap' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('refuses to boot without loopbackUrl (pod I/O is loopback with forwarded auth)', async () => {
    await assert.rejects(
      startJss({
        plugins: [{
          id: 'jmap', module: module_, prefix: '/jmap',
          config: { baseUrl: 'http://127.0.0.1:9' },
        }],
      }),
      /requires config\.loopbackUrl/,
    );
  });

  it('boots with idp + jmap, registers a pod owner, mints a bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    apiUrl = `${base}/jmap/api`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 'jmap', module: module_, prefix: '/jmap',
        config: { baseUrl: base, loopbackUrl: base },
      }],
    });
    const reg = await fetch(`${base}/idp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, confirmPassword: PASS }),
    });
    assert.ok([200, 201, 302].includes(reg.status), `register: ${reg.status}`);
    const cred = await fetch(`${base}/idp/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS }),
    });
    assert.strictEqual(cred.status, 200);
    token = (await cred.json()).access_token;
    assert.ok(token, 'no access_token from /idp/credentials');
  });

  it('GET /.well-known/jmap 301-redirects to the session resource', async () => {
    const res = await fetch(`${base}/.well-known/jmap`, { redirect: 'manual' });
    assert.strictEqual(res.status, 301);
    assert.strictEqual(res.headers.get('location'), `${base}/jmap/session`);
  });

  it('GET /jmap/session (authed) returns capabilities and exactly one account', async () => {
    const res = await fetch(`${base}/jmap/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.capabilities[CORE_URN], 'no core capability');
    assert.ok(body.capabilities[MAIL_URN], 'no mail capability');
    const ids = Object.keys(body.accounts);
    assert.strictEqual(ids.length, 1, `expected one account: ${JSON.stringify(ids)}`);
    assert.strictEqual(body.primaryAccounts[MAIL_URN], ids[0]);
    assert.strictEqual(body.apiUrl, apiUrl);
    assert.ok(body.state, 'no session state');
    // Honest omissions: no push, no blobs (documented findings).
    assert.strictEqual(body.eventSourceUrl, undefined);
    assert.strictEqual(body.uploadUrl, undefined);
    accountId = ids[0];
  });

  it('GET /jmap/session anonymous is 401 problem+json', async () => {
    const res = await fetch(`${base}/jmap/session`);
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('content-type') || '', /application\/problem\+json/);
  });

  it('Mailbox/get lists the four role mailboxes', async () => {
    const { status, body } = await call([['Mailbox/get', { accountId, ids: null }, 'c0']]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'Mailbox/get', JSON.stringify(body.methodResponses[0]));
    const roles = args.list.map((m) => m.role).sort();
    assert.deepStrictEqual(roles, ['drafts', 'inbox', 'sent', 'trash']);
    const inbox = args.list.find((m) => m.role === 'inbox');
    assert.strictEqual(inbox.name, 'Inbox');
    assert.strictEqual(inbox.totalEmails, 0);
  });

  it('Email/set create files a message into the Inbox and returns its id', async () => {
    const { status, body } = await call([
      ['Email/set', {
        accountId,
        create: {
          m1: {
            mailboxIds: { inbox: true },
            from: [{ name: 'Alice', email: 'alice@example.org' }],
            to: [{ name: 'Bob', email: 'bob@example.org' }],
            subject: 'Hello JMAP',
            bodyValues: { body1: { value: 'Hello over a pod. This is mail as JSON.' } },
            textBody: [{ partId: 'body1', type: 'text/plain' }],
          },
        },
      }, 'c1'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args, callId] = body.methodResponses[0];
    assert.strictEqual(name, 'Email/set', JSON.stringify(body.methodResponses[0]));
    assert.strictEqual(callId, 'c1');
    assert.ok(args.created?.m1?.id, `not created: ${JSON.stringify(args)}`);
    assert.ok(args.created.m1.receivedAt, 'no server-set receivedAt');
    assert.match(args.created.m1.preview, /Hello over a pod/);
    // RFC 8621 §4.6: the create response echoes every server-set property so
    // the client caches them instead of re-fetching (blobId/threadId/size).
    assert.ok(args.created.m1.blobId, 'no server-set blobId');
    assert.strictEqual(args.created.m1.threadId, args.created.m1.id,
      'threadId is the degenerate per-message id (one-message threads)');
    assert.ok(Number.isInteger(args.created.m1.size) && args.created.m1.size > 0,
      `no server-set size: ${JSON.stringify(args.created.m1)}`);
    assert.notStrictEqual(args.oldState, args.newState, 'state string did not change on create');
    emailId = args.created.m1.id;

    // It really landed in the pod as a JSON resource under the owner's control.
    const raw = await fetch(`${base}/${USER}/private/mail/Inbox/${emailId}.json`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.strictEqual(raw.status, 200);
    assert.strictEqual((await raw.json()).subject, 'Hello JMAP');
  });

  it('Email/query filter inMailbox=inbox finds it (total 1)', async () => {
    const args = await query('inbox');
    assert.strictEqual(args.total, 1);
    assert.deepStrictEqual(args.ids, [emailId]);
    assert.strictEqual(args.canCalculateChanges, false);
  });

  it('Email/get returns the message fields', async () => {
    const { status, body } = await call([
      ['Email/get', {
        accountId,
        ids: [emailId, 'no-such-id'],
        properties: ['mailboxIds', 'from', 'to', 'subject', 'receivedAt', 'preview'],
      }, 'c2'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'Email/get', JSON.stringify(body.methodResponses[0]));
    assert.strictEqual(args.list.length, 1);
    const email = args.list[0];
    assert.strictEqual(email.id, emailId);
    assert.strictEqual(email.subject, 'Hello JMAP');
    assert.strictEqual(email.from[0].email, 'alice@example.org');
    assert.strictEqual(email.to[0].email, 'bob@example.org');
    assert.deepStrictEqual(email.mailboxIds, { inbox: true });
    assert.ok(email.receivedAt, 'no receivedAt');
    assert.match(email.preview, /Hello over a pod/);
    assert.deepStrictEqual(args.notFound, ['no-such-id']);
  });

  it('Email/set update moves it to the Trash (mailboxIds)', async () => {
    const { status, body } = await call([
      ['Email/set', { accountId, update: { [emailId]: { mailboxIds: { trash: true } } } }, 'c3'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'Email/set', JSON.stringify(body.methodResponses[0]));
    assert.ok(Object.prototype.hasOwnProperty.call(args.updated, emailId),
      `not updated: ${JSON.stringify(args)}`);

    assert.strictEqual((await query('inbox')).total, 0, 'still in the inbox');
    const trash = await query('trash');
    assert.strictEqual(trash.total, 1);
    assert.deepStrictEqual(trash.ids, [emailId]);
  });

  it('Email/set destroy deletes it (query total 0)', async () => {
    const { status, body } = await call([
      ['Email/set', { accountId, destroy: [emailId] }, 'c4'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'Email/set', JSON.stringify(body.methodResponses[0]));
    assert.deepStrictEqual(args.destroyed, [emailId]);
    assert.strictEqual((await query('trash')).total, 0);
    assert.strictEqual((await query('inbox')).total, 0);
  });

  it('unknown method → ["error", { type: "unknownMethod" }] per RFC 8620', async () => {
    const { status, body } = await call([['Email/frobnicate', { accountId }, 'c5']]);
    assert.strictEqual(status, 200); // method-level errors are 200s
    assert.deepStrictEqual(body.methodResponses[0], ['error', { type: 'unknownMethod' }, 'c5']);
  });

  it('Email/queryChanges → cannotCalculateChanges (delta sync needs api.events)', async () => {
    const { status, body } = await call([
      ['Email/queryChanges', { accountId, sinceQueryState: 'x' }, 'c6'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'error');
    assert.strictEqual(args.type, 'cannotCalculateChanges');
  });

  it('back-references (#resultOf) → serverFail (documented gap)', async () => {
    const { status, body } = await call([
      ['Email/get', { accountId, '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' } }, 'c7'],
    ]);
    assert.strictEqual(status, 200);
    const [name, args] = body.methodResponses[0];
    assert.strictEqual(name, 'error');
    assert.strictEqual(args.type, 'serverFail');
    assert.match(args.description, /back-references/);
  });

  it('malformed body → 400 problem+json urn:ietf:params:jmap:error:notRequest', async () => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ hello: 'world' }), // valid JSON, not a Request
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/problem\+json/);
    const body = await res.json();
    assert.strictEqual(body.type, 'urn:ietf:params:jmap:error:notRequest');
    assert.strictEqual(body.status, 400);
  });

  it('POST /jmap/api anonymous is 401', async () => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ using: [CORE_URN], methodCalls: [] }),
    });
    assert.strictEqual(res.status, 401);
  });
});
