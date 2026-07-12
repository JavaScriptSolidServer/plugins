// WebFinger plugin over a real JSS from npm (JSS issue #164, WebFinger half).
//
// The headline assertion is the well-known one: the plugin registers
// `GET /.well-known/webfinger` — an absolute path OUTSIDE its mount prefix —
// and an unauthenticated fetch gets the JRD. That works (see README
// findings) for the same reasons nip05/ documents: the loader doesn't
// confine routes to the prefix and core blanket-exempts /.well-known/* from
// auth. The same document is also asserted at the contract-safe
// `<prefix>/webfinger`. The default server is NOT public-read, so the
// anonymous 200 here demonstrates the exemption, not a permissive default.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const PLUGIN = path.join(__dirname, 'plugin.js');

/** Write a minimal pod WebID card at `<podDir>/profile/card.jsonld`. */
function writeCard(podDir, webId) {
  fs.mkdirSync(path.join(podDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(podDir, 'profile', 'card.jsonld'), JSON.stringify({
    '@id': webId,
    '@type': ['foaf:Person'],
    'foaf:name': 'Test',
  }, null, 2));
}

const linkByRel = (body, rel) => body.links.find((l) => l.rel === rel);

describe('webfinger plugin', () => {
  let jss;
  let base;
  const HOST = 'pod.example';

  after(async () => { if (jss) await jss.close(); });

  before(async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jss-webfinger-'));
    // Two pods under the data root, plus a dot-guarded tree that is never a pod.
    writeCard(path.join(root, 'alice'), `${base}/alice/profile/card#me`);
    writeCard(path.join(root, 'bob'), `${base}/bob/profile/card#me`);
    writeCard(path.join(root, '.idp'), `${base}/.idp/profile/card#me`);

    jss = await startJss({
      port,
      root,
      plugins: [{
        module: PLUGIN,
        prefix: '/webfinger',
        // No baseUrl: the origin now comes from api.serverInfo() (#601).
        // The JRD's absolute URLs (issuer, actor, WebID) below must still
        // resolve to the server's real origin — that's the retrofit proof.
        config: { podsRoot: root },
      }],
    });
  });

  it('resolves acct: at /.well-known/webfinger with a full JRD, unauthenticated', async () => {
    const resource = `acct:alice@${HOST}`;
    const res = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
    assert.strictEqual(res.status, 200, 'anonymous GET on the absolute well-known path');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*',
      'fediverse clients require open CORS');
    assert.match(res.headers.get('content-type') || '', /application\/jrd\+json/,
      'RFC 7033 media type');
    const body = await res.json();

    assert.strictEqual(body.subject, resource, 'subject echoes the queried acct: URI');
    assert.ok(body.aliases.includes(`${base}/alice/profile/card#me`), 'WebID is an alias');
    assert.ok(body.aliases.includes(`${base}/alice/profile/card`), 'profile page is an alias');

    const self = linkByRel(body, 'self');
    assert.ok(self, 'a self link is present');
    assert.strictEqual(self.type, 'application/activity+json',
      'the self link is the ActivityPub actor type Mastodon follows');
    assert.strictEqual(self.href, `${base}/alice/actor`, 'default actorPathTemplate');

    const issuer = linkByRel(body, 'http://openid.net/specs/connect/1.0/issuer');
    assert.ok(issuer, 'an OIDC issuer link is present (Solid-OIDC / remoteStorage discovery)');
    assert.strictEqual(issuer.href, base, 'issuer is the server baseUrl');

    const profile = linkByRel(body, 'http://webfinger.net/rel/profile-page');
    assert.ok(profile, 'a profile-page link is present');
    assert.strictEqual(profile.href, `${base}/alice/profile/card`, 'profile page href');
  });

  it('404s for an unknown user', async () => {
    const res = await fetch(
      `${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:nobody@${HOST}`)}`);
    assert.strictEqual(res.status, 404, 'RFC 7033 §4.5: no such resource');
  });

  it('400s when the resource parameter is missing', async () => {
    const res = await fetch(`${base}/.well-known/webfinger`);
    assert.strictEqual(res.status, 400, 'RFC 7033 §4.2: resource is required');
  });

  it('resolves the WebID-URL resource form to the same pod', async () => {
    const webid = `${base}/bob/profile/card#me`;
    const res = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(webid)}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.subject, webid, 'subject echoes the WebID URL');
    assert.strictEqual(linkByRel(body, 'self').href, `${base}/bob/actor`, 'resolved bob via URL path');
  });

  it('serves the identical JRD under its own prefix (the contract-safe mount)', async () => {
    const resource = `acct:alice@${HOST}`;
    const q = `resource=${encodeURIComponent(resource)}`;
    const viaPrefix = await fetch(`${base}/webfinger/webfinger?${q}`);
    assert.strictEqual(viaPrefix.status, 200);
    assert.deepStrictEqual(
      await viaPrefix.json(),
      await (await fetch(`${base}/.well-known/webfinger?${q}`)).json(),
    );
  });
});
