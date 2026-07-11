// WebDAV bridge over a real JSS from npm: pod created via /.pods (idp),
// then the whole WebDAV surface driven with the pod's Bearer token —
// every operation crossing the bridge, over loopback, through real WAC.
//
// Same probe-port-then-boot dance as notifications/test.js: the plugin
// needs the server origin in config before listen (finding: api.serverInfo).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

describe('webdav plugin', () => {
  let jss;
  let base;
  let token;
  const dav = (p) => `${base}/webdav${p}`;
  const bearer = () => ({ authorization: `Bearer ${token}` });

  after(async () => { if (jss) await jss.close(); });

  // This must run BEFORE the real boot: JSS keeps a module-level storage
  // root, so even a failed second createServer re-points it and poisons a
  // server that is already listening (same ordering notifications/test.js
  // uses for its config-validation case).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as notifications)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: path.join(__dirname, 'plugin.js'), prefix: '/webdav' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + webdav; a pod created via /.pods hands out a Bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/webdav',
        config: { baseUrl: base },
      }],
    });
    const res = await fetch(`${base}/.pods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dave', email: 'dave@example.com', password: 'dav-pass-123' }),
    });
    assert.strictEqual(res.status, 201, `pod creation: ${res.status}`);
    ({ token } = await res.json());
    assert.ok(token, 'pod creation returned no token');
  });

  it('OPTIONS advertises DAV: 1 and the implemented methods', async () => {
    const res = await fetch(dav('/dave/'), { method: 'OPTIONS' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('dav'), '1');
    const allow = res.headers.get('allow');
    for (const m of ['OPTIONS', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'MKCOL']) {
      assert.ok(allow.includes(m), `Allow missing ${m}: ${allow}`);
    }
  });

  it('PUT stores a file through the bridge; GET returns it byte-for-byte', async () => {
    const put = await fetch(dav('/dave/private/hello.txt'), {
      method: 'PUT',
      headers: { ...bearer(), 'content-type': 'text/plain' },
      body: 'hello via webdav',
    });
    assert.ok([200, 201, 204].includes(put.status), `PUT: ${put.status}`);

    const got = await fetch(dav('/dave/private/hello.txt'), { headers: bearer() });
    assert.strictEqual(got.status, 200);
    assert.ok((got.headers.get('content-type') || '').startsWith('text/plain'));
    assert.strictEqual(await got.text(), 'hello via webdav');
  });

  it('WAC still rules: the same paths without credentials are 401 + Basic challenge', async () => {
    const res = await fetch(dav('/dave/private/hello.txt'));
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /^Basic /);
  });

  it('PROPFIND Depth: 1 on the container is a 207 multistatus listing the file', async () => {
    const res = await fetch(dav('/dave/private/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    assert.strictEqual(res.status, 207);
    assert.match(res.headers.get('content-type') || '', /application\/xml/);
    const xml = await res.text();
    assert.ok(xml.includes('<D:multistatus xmlns:D="DAV:">'), xml);
    // the collection itself…
    assert.ok(xml.includes('<D:href>/webdav/dave/private/</D:href>'), xml);
    assert.ok(xml.includes('<D:resourcetype><D:collection/></D:resourcetype>'), xml);
    // …and the file as a non-collection child with basic props
    assert.ok(xml.includes('<D:href>/webdav/dave/private/hello.txt</D:href>'), xml);
    assert.ok(xml.includes('<D:displayname>hello.txt</D:displayname>'), xml);
    assert.ok(xml.includes(`<D:getcontentlength>${'hello via webdav'.length}</D:getcontentlength>`), xml);
    assert.ok(xml.includes('<D:getlastmodified>'), xml);
  });

  it('PROPFIND Depth: 0 on the file describes just the file', async () => {
    const res = await fetch(dav('/dave/private/hello.txt'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0' },
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes('<D:href>/webdav/dave/private/hello.txt</D:href>'), xml);
    assert.ok(xml.includes('<D:getcontenttype>text/plain'), xml);
    assert.ok(xml.includes('<D:resourcetype></D:resourcetype>'), xml);
    assert.ok(!xml.includes('<D:collection/>'), xml);
  });

  it('PROPFIND Depth: 0 on the container returns only the container', async () => {
    const res = await fetch(dav('/dave/private/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0' },
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes('<D:href>/webdav/dave/private/</D:href>'), xml);
    assert.ok(!xml.includes('hello.txt'), xml);
  });

  it('PROPFIND on a slash-less container path (what Finder sends first) still sees a collection', async () => {
    const res = await fetch(dav('/dave/private'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes('<D:href>/webdav/dave/private/</D:href>'), xml);
    assert.ok(xml.includes('<D:collection/>'), xml);
    assert.ok(xml.includes('hello.txt'), xml);
  });

  it('MKCOL creates a collection (LDP container); repeat MKCOL is 405', async () => {
    const res = await fetch(dav('/dave/private/photos/'), { method: 'MKCOL', headers: bearer() });
    assert.strictEqual(res.status, 201);

    const again = await fetch(dav('/dave/private/photos/'), { method: 'MKCOL', headers: bearer() });
    assert.strictEqual(again.status, 405);

    const list = await fetch(dav('/dave/private/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    const xml = await list.text();
    assert.ok(xml.includes('<D:href>/webdav/dave/private/photos/</D:href>'), xml);
    const photos = xml.split('<D:response>').find((r) => r.includes('photos/'));
    assert.ok(photos.includes('<D:collection/>'), photos);
  });

  it('DELETE removes the file; PROPFIND no longer lists it; GET is 404', async () => {
    const del = await fetch(dav('/dave/private/hello.txt'), { method: 'DELETE', headers: bearer() });
    assert.strictEqual(del.status, 204);

    const list = await fetch(dav('/dave/private/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    assert.strictEqual(list.status, 207);
    assert.ok(!(await list.text()).includes('hello.txt'));

    const got = await fetch(dav('/dave/private/hello.txt'), { headers: bearer() });
    assert.strictEqual(got.status, 404);
  });

  it('Basic auth bridges to Bearer: username anything, pod token as password', async () => {
    const basic = Buffer.from(`dave:${token}`).toString('base64');
    const res = await fetch(dav('/dave/private/'), {
      method: 'PROPFIND',
      headers: { authorization: `Basic ${basic}`, depth: '1' },
    });
    assert.strictEqual(res.status, 207);
  });

  it('LOCK/UNLOCK are honestly unimplemented (class 1 only)', async () => {
    const res = await fetch(dav('/dave/private/x.txt'), { method: 'LOCK', headers: bearer() });
    assert.strictEqual(res.status, 501);
  });
});
