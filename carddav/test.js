// CardDAV bridge over a real JSS from npm: a pod is created via /.pods (idp),
// then the whole sync vertical slice is driven with the pod's Bearer token —
// every operation crossing the bridge, over loopback, through real WAC:
//
//   OPTIONS advertises addressbook → MKCOL the book → PUT a vCard (ETag back)
//   → PROPFIND Depth 1 lists it (etag, text/vcard) → GET returns the body
//   → REPORT addressbook-multiget returns it → DELETE → PROPFIND drops it.
//
// Same probe-port-then-boot dance as webdav/notifications: the plugin needs
// the server origin in config before listen (finding: api.serverInfo).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'UID:urn:uuid:ada1b2c3-0000-4000-8000-000000000001',
  'FN:Ada Lovelace',
  'N:Lovelace;Ada;;;',
  'EMAIL;TYPE=INTERNET:ada@example.com',
  'TEL;TYPE=CELL:+1-202-555-0100',
  'END:VCARD',
  '',
].join('\r\n');

describe('carddav plugin', () => {
  let jss;
  let base;
  let token;
  const cd = (p) => `${base}/carddav${p}`;
  const bearer = () => ({ authorization: `Bearer ${token}` });
  const book = '/carddav/cara/contacts/';
  const card = '/carddav/cara/contacts/ada.vcf';

  after(async () => { if (jss) await jss.close(); });

  // Must run BEFORE the real boot: JSS keeps a module-level storage root, so a
  // failed second createServer re-points storage for the already-listening
  // server (the footgun webdav/notifications document).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as webdav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: path.join(__dirname, 'plugin.js'), prefix: '/carddav' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + carddav; a pod created via /.pods hands out a Bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/carddav',
        config: { baseUrl: base },
      }],
    });
    const res = await fetch(`${base}/.pods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cara', email: 'cara@example.com', password: 'cara-pass-123' }),
    });
    assert.strictEqual(res.status, 201, `pod creation: ${res.status}`);
    ({ token } = await res.json());
    assert.ok(token, 'pod creation returned no token');
  });

  it('OPTIONS advertises DAV: addressbook and the CardDAV methods', async () => {
    const res = await fetch(cd('/cara/contacts/'), { method: 'OPTIONS' });
    assert.strictEqual(res.status, 200);
    const dav = res.headers.get('dav') || '';
    assert.match(dav, /addressbook/, `DAV header: ${dav}`);
    assert.match(dav, /\b3\b/, `DAV header missing class 3: ${dav}`);
    const allow = res.headers.get('allow') || '';
    for (const m of ['OPTIONS', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'REPORT', 'MKCOL']) {
      assert.ok(allow.includes(m), `Allow missing ${m}: ${allow}`);
    }
  });

  it('MKCOL creates the addressbook collection', async () => {
    const res = await fetch(cd('/cara/contacts/'), { method: 'MKCOL', headers: bearer() });
    assert.strictEqual(res.status, 201, `MKCOL: ${res.status}`);
  });

  it('PROPFIND marks the collection as a CARD:addressbook', async () => {
    const res = await fetch(cd('/cara/contacts/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0' },
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${book}</D:href>`), xml);
    assert.ok(xml.includes('<CARD:addressbook/>'), `not marked addressbook: ${xml}`);
  });

  let putEtag;
  it('PUT a vCard through the bridge returns an ETag', async () => {
    const res = await fetch(cd('/cara/contacts/ada.vcf'), {
      method: 'PUT',
      headers: { ...bearer(), 'content-type': 'text/vcard' },
      body: VCARD,
    });
    assert.ok([200, 201, 204].includes(res.status), `PUT: ${res.status}`);
    putEtag = res.headers.get('etag');
    assert.ok(putEtag && /^".+"$/.test(putEtag), `no ETag on PUT: ${putEtag}`);
  });

  it('401 without a token — WAC still rules', async () => {
    const res = await fetch(cd('/cara/contacts/ada.vcf'));
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /^Basic /);
  });

  it('PROPFIND Depth 1 lists the contact with getetag + text/vcard', async () => {
    const res = await fetch(cd('/cara/contacts/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:">'
        + '<D:prop><D:getetag/><D:getcontenttype/><D:resourcetype/></D:prop></D:propfind>',
    });
    assert.strictEqual(res.status, 207);
    assert.match(res.headers.get('content-type') || '', /application\/xml/);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${card}</D:href>`), xml);
    // the contact carries the same content-hash ETag the PUT returned…
    assert.ok(xml.includes(`<D:getetag>${putEtag}</D:getetag>`), `etag mismatch: ${xml}`);
    assert.ok(xml.includes('<D:getcontenttype>text/vcard</D:getcontenttype>'), xml);
  });

  it('GET returns the vCard body byte-for-byte with an ETag', async () => {
    const res = await fetch(cd('/cara/contacts/ada.vcf'), { headers: bearer() });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/vcard/);
    assert.strictEqual(res.headers.get('etag'), putEtag);
    assert.strictEqual(await res.text(), VCARD);
  });

  it('REPORT addressbook-multiget returns the requested vCard + etag', async () => {
    const res = await fetch(cd('/cara/contacts/'), {
      method: 'REPORT',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?>'
        + `<CARD:addressbook-multiget xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">`
        + '<D:prop><D:getetag/><CARD:address-data/></D:prop>'
        + `<D:href>${card}</D:href></CARD:addressbook-multiget>`,
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${card}</D:href>`), xml);
    assert.ok(xml.includes(`<D:getetag>${putEtag}</D:getetag>`), xml);
    assert.ok(xml.includes('<CARD:address-data>'), xml);
    assert.ok(xml.includes('FN:Ada Lovelace'), `vCard body not returned: ${xml}`);
  });

  it('REPORT addressbook-query returns all vCards in the collection', async () => {
    const res = await fetch(cd('/cara/contacts/'), {
      method: 'REPORT',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?>'
        + '<CARD:addressbook-query xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">'
        + '<D:prop><D:getetag/><CARD:address-data/></D:prop>'
        + '<CARD:filter><CARD:prop-filter name="FN"/></CARD:filter></CARD:addressbook-query>',
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${card}</D:href>`), xml);
    assert.ok(xml.includes('FN:Ada Lovelace'), xml);
  });

  it('discovery: PROPFIND current-user-principal + addressbook-home-set resolve', async () => {
    const res = await fetch(cd('/cara/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">'
        + '<D:prop><D:current-user-principal/><CARD:addressbook-home-set/></D:prop></D:propfind>',
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes('<D:current-user-principal>'), xml);
    assert.ok(xml.includes('<CARD:addressbook-home-set>'), xml);
    assert.ok(xml.includes('/carddav/cara/'), `home-set not under pod: ${xml}`);
  });

  it('/.well-known/carddav 301s toward the discovery root', async () => {
    const res = await fetch(`${base}/.well-known/carddav`, { redirect: 'manual' });
    assert.ok([301, 302, 307, 308].includes(res.status), `well-known status: ${res.status}`);
    assert.match(res.headers.get('location') || '', /\/carddav\/?$/);
  });

  it('DELETE removes the contact; PROPFIND no longer lists it; GET is 404', async () => {
    const del = await fetch(cd('/cara/contacts/ada.vcf'), { method: 'DELETE', headers: bearer() });
    assert.strictEqual(del.status, 204);

    const list = await fetch(cd('/cara/contacts/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    assert.strictEqual(list.status, 207);
    assert.ok(!(await list.text()).includes('ada.vcf'), 'still listed after delete');

    const got = await fetch(cd('/cara/contacts/ada.vcf'), { headers: bearer() });
    assert.strictEqual(got.status, 404);
  });

  it('Basic auth bridges to Bearer: username anything, pod token as password', async () => {
    const basic = Buffer.from(`cara:${token}`).toString('base64');
    const res = await fetch(cd('/cara/contacts/'), {
      method: 'PROPFIND',
      headers: { authorization: `Basic ${basic}`, depth: '0' },
    });
    assert.strictEqual(res.status, 207);
  });
});
