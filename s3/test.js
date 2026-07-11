// S3 object-storage gateway over a real JSS from npm: a pod created via
// /.pods (idp), then the S3 REST subset driven end-to-end with the pod's
// Bearer token AND with real AWS SigV4 signatures — every operation crossing
// the gateway over loopback, through real WAC.
//
// Same probe-port-then-boot dance as webdav/rss: the plugin needs the server
// origin in config before listen (finding: api.serverInfo).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const md5 = (s) => `"${crypto.createHash('md5').update(s).digest('hex')}"`;

// ── An independent SigV4 signer, so the test proves interop rather than
// re-using the plugin's verifier. Mirrors the AWS Signature V4 algorithm for
// service "s3", using the pod token as BOTH accessKeyId and secret. ────────
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const uriEncode = (s) => encodeURIComponent(s)
  .replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function canonicalQuery(qs) {
  if (!qs) return '';
  const pairs = [];
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    let dk; let dv;
    try { dk = decodeURIComponent(k); } catch { dk = k; }
    try { dv = decodeURIComponent(v); } catch { dv = v; }
    pairs.push([uriEncode(dk), uriEncode(dv)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

/** Return the headers (Authorization + x-amz-*) for a signed request. */
function sign({ method, url, host, body = Buffer.alloc(0), token, region = 'us-east-1' }) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = signed.join(';');
  const canonicalRequest = [
    method, u.pathname, canonicalQuery(u.search.replace(/^\?/, '')),
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(token, dateStamp, region, 's3'))
    .update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${token}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

describe('s3 plugin', () => {
  let jss;
  let base;
  let host;
  let token;
  const s3 = (p) => `${base}/s3${p}`;
  const bearer = () => ({ authorization: `Bearer ${token}` });

  after(async () => { if (jss) await jss.close(); });

  // Must run BEFORE the real boot: JSS keeps a module-level storage root, so
  // even a failed second createServer re-points it and poisons a listening
  // server (same ordering webdav/notifications use for their config case).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as webdav/rss)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ id: 's3', module: path.join(__dirname, 'plugin.js'), prefix: '/s3' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + s3; a pod created via /.pods hands out a Bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    host = `127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        id: 's3',
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/s3',
        // buckets live under the pod (server root '/' is server-owned:
        // not agent-writable, not JSON-LD-listable — see README findings).
        config: { baseUrl: base, loopbackUrl: base, bucketRoot: '/dave/' },
      }],
    });
    const res = await fetch(`${base}/.pods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dave', email: 'dave@example.com', password: 's3-pass-123' }),
    });
    assert.strictEqual(res.status, 201, `pod creation: ${res.status}`);
    ({ token } = await res.json());
    assert.ok(token, 'pod creation returned no token');
  });

  it('CreateBucket makes a container (loopback); location header echoes the bucket', async () => {
    const res = await fetch(s3('/photos'), { method: 'PUT', headers: bearer() });
    assert.strictEqual(res.status, 200, `CreateBucket: ${res.status}`);
    assert.strictEqual(res.headers.get('location'), '/photos');
  });

  it('PutObject stores the body and returns a content-md5 ETag', async () => {
    const body = 'hello from the s3 gateway';
    const res = await fetch(s3('/photos/greeting.txt'), {
      method: 'PUT',
      headers: { ...bearer(), 'content-type': 'text/plain' },
      body,
    });
    assert.strictEqual(res.status, 200, `PutObject: ${res.status}`);
    assert.strictEqual(res.headers.get('etag'), md5(body), 'ETag must be the md5 of the body');
  });

  it('GetObject returns the body byte-for-byte with content-type + ETag', async () => {
    const body = 'hello from the s3 gateway';
    const res = await fetch(s3('/photos/greeting.txt'), { headers: bearer() });
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/plain'));
    assert.strictEqual(res.headers.get('etag'), md5(body));
    assert.strictEqual(await res.text(), body);
  });

  it('HeadObject returns content-length + ETag + content-type, no body', async () => {
    const body = 'hello from the s3 gateway';
    const res = await fetch(s3('/photos/greeting.txt'), { method: 'HEAD', headers: bearer() });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(body.length));
    assert.strictEqual(res.headers.get('etag'), md5(body));
    assert.ok((res.headers.get('content-type') || '').startsWith('text/plain'));
    assert.strictEqual((await res.text()).length, 0, 'HEAD must have no body');
  });

  it('ListObjectsV2 lists keys with correct Size + ETag (and IsTruncated=false)', async () => {
    // add two more objects, one nested for the delimiter tests
    await fetch(s3('/photos/album/a.txt'), {
      method: 'PUT', headers: { ...bearer(), 'content-type': 'text/plain' }, body: 'aaa',
    });
    await fetch(s3('/photos/album/deep/c.txt'), {
      method: 'PUT', headers: { ...bearer(), 'content-type': 'text/plain' }, body: 'cccc',
    });

    const res = await fetch(s3('/photos?list-type=2'), { headers: bearer() });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /xml/);
    const xml = await res.text();
    assert.ok(xml.includes('<ListBucketResult'), xml);
    assert.ok(xml.includes('<Name>photos</Name>'), xml);
    assert.ok(xml.includes('<IsTruncated>false</IsTruncated>'), xml);
    // greeting.txt with correct size + md5 ETag
    const greeting = xml.split('<Contents>').find((c) => c.includes('<Key>greeting.txt</Key>'));
    assert.ok(greeting, `greeting.txt not listed: ${xml}`);
    assert.ok(greeting.includes('<Size>25</Size>'), greeting);
    assert.ok(greeting.includes(`<ETag>${md5('hello from the s3 gateway').replace(/"/g, '&quot;')}</ETag>`), greeting);
    // nested key present when there is no delimiter
    assert.ok(xml.includes('<Key>album/a.txt</Key>'), xml);
    assert.ok(xml.includes('<Key>album/deep/c.txt</Key>'), xml);
  });

  it('ListObjectsV2 prefix= filters to keys under the prefix', async () => {
    const res = await fetch(s3('/photos?list-type=2&prefix=album/'), { headers: bearer() });
    const xml = await res.text();
    assert.ok(xml.includes('<Prefix>album/</Prefix>'), xml);
    assert.ok(xml.includes('<Key>album/a.txt</Key>'), xml);
    assert.ok(xml.includes('<Key>album/deep/c.txt</Key>'), xml);
    assert.ok(!xml.includes('<Key>greeting.txt</Key>'), xml);
  });

  it('ListObjectsV2 delimiter=/ rolls sub-paths into CommonPrefixes', async () => {
    const res = await fetch(s3('/photos?list-type=2&delimiter=%2F'), { headers: bearer() });
    const xml = await res.text();
    // top-level object stays in Contents…
    assert.ok(xml.includes('<Key>greeting.txt</Key>'), xml);
    // …and everything under album/ collapses to one CommonPrefix
    assert.ok(xml.includes('<CommonPrefixes><Prefix>album/</Prefix></CommonPrefixes>'), xml);
    assert.ok(!xml.includes('<Key>album/a.txt</Key>'), xml);
  });

  it('DeleteObject removes it; a subsequent GET is 404 NoSuchKey XML', async () => {
    const del = await fetch(s3('/photos/greeting.txt'), { method: 'DELETE', headers: bearer() });
    assert.strictEqual(del.status, 204);

    const got = await fetch(s3('/photos/greeting.txt'), { headers: bearer() });
    assert.strictEqual(got.status, 404);
    const xml = await got.text();
    assert.ok(xml.includes('<Code>NoSuchKey</Code>'), xml);
  });

  it('ListBuckets shows the created bucket as <Bucket>', async () => {
    const res = await fetch(s3('/'), { headers: bearer() });
    assert.strictEqual(res.status, 200);
    const xml = await res.text();
    assert.ok(xml.includes('<ListAllMyBucketsResult'), xml);
    assert.ok(xml.includes('<Name>photos</Name>'), xml);
  });

  it('AccessDenied: no credentials → 403 AccessDenied XML', async () => {
    const res = await fetch(s3('/photos/album/a.txt'));
    assert.strictEqual(res.status, 403);
    const xml = await res.text();
    assert.ok(xml.includes('<Code>AccessDenied</Code>'), xml);
  });

  it('AccessDenied: a bogus Bearer is refused by WAC over loopback', async () => {
    const res = await fetch(s3('/photos/album/a.txt'), { headers: { authorization: 'Bearer not-a-real-token' } });
    assert.strictEqual(res.status, 403);
    assert.ok((await res.text()).includes('<Code>AccessDenied</Code>'));
  });

  // ── SigV4: the strong auth path — real AWS signatures, pod token as the
  // secret access key, verified by the plugin with node:crypto HMAC. ───────
  describe('AWS SigV4 (pod token as accessKeyId + secret)', () => {
    it('CreateBucket + PutObject + GetObject succeed when signed', async () => {
      const cbUrl = s3('/sigbucket');
      const cb = await fetch(cbUrl, { method: 'PUT', headers: sign({ method: 'PUT', url: cbUrl, host, token }) });
      assert.strictEqual(cb.status, 200, `signed CreateBucket: ${cb.status}`);

      const body = Buffer.from('signed via sigv4');
      const poUrl = s3('/sigbucket/obj.txt');
      const po = await fetch(poUrl, {
        method: 'PUT',
        headers: { ...sign({ method: 'PUT', url: poUrl, host, body, token }), 'content-type': 'text/plain' },
        body,
      });
      assert.strictEqual(po.status, 200, `signed PutObject: ${po.status}`);
      assert.strictEqual(po.headers.get('etag'), md5(body));

      const goUrl = s3('/sigbucket/obj.txt');
      const go = await fetch(goUrl, { headers: sign({ method: 'GET', url: goUrl, host, token }) });
      assert.strictEqual(go.status, 200);
      assert.strictEqual(await go.text(), 'signed via sigv4');
    });

    it('ListObjectsV2 works with the query string included in the signature', async () => {
      const url = s3('/sigbucket?list-type=2');
      const res = await fetch(url, { headers: sign({ method: 'GET', url, host, token }) });
      assert.strictEqual(res.status, 200);
      assert.ok((await res.text()).includes('<Key>obj.txt</Key>'));
    });

    it('a tampered signature is refused with SignatureDoesNotMatch (403)', async () => {
      const url = s3('/sigbucket/obj.txt');
      const headers = sign({ method: 'GET', url, host, token });
      headers.authorization = headers.authorization.replace(/Signature=./, 'Signature=0');
      const res = await fetch(url, { headers });
      assert.strictEqual(res.status, 403);
      assert.ok((await res.text()).includes('<Code>SignatureDoesNotMatch</Code>'));
    });
  });
});
