// S3-compatible object-storage gateway as a #206 loader plugin (issue: an
// AWS-S3 REST subset over a Solid pod).
//
//   plugins: [{ module: 's3/plugin.js', prefix: '/s3',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// Expose a pod as S3 object storage. The mapping is the whole idea:
//
//     S3 bucket      = a container under config.bucketRoot
//     S3 object key  = a resource path under that container
//
// e.g. with bucketRoot '/alice/':  bucket "photos", key "a/b.jpg"
//                                     ⇄  /alice/photos/a/b.jpg
//
// config.bucketRoot defaults to '/', but a Solid server's true root '/' is
// server-owned — an ordinary agent can neither create top-level containers
// there (403) nor GET it as a JSON-LD listing (it serves HTML). So in
// practice an operator points bucketRoot at a pod container the agent owns
// (its own pod, '/alice/'), and that pod's sub-containers ARE its buckets.
// That gap — "the pod's top-level containers" is not something an agent can
// enumerate or create — is a finding (see README).
//
// Every operation is translated to a Solid/LDP request against the host
// itself, performed over LOOPBACK HTTP carrying the caller's OWN credentials
// — the exact pattern notifications/ established and webdav/ carddav/ caldav/
// rss/ sparql/ reuse. The gateway therefore has NO authority of its own: WAC
// governs, because the gateway literally asks the server as the caller.
//
// Path-style S3 API under the prefix (virtual-host style is not supported —
// see README):
//
//   PUT    /s3/<bucket>/<key>            PutObject   → loopback PUT, ETag = md5(body)
//   GET    /s3/<bucket>/<key>            GetObject   → loopback GET, body+type+ETag
//   HEAD   /s3/<bucket>/<key>            HeadObject  → content-length, ETag, type
//   DELETE /s3/<bucket>/<key>            DeleteObject→ loopback DELETE, 204
//   GET    /s3/<bucket>?list-type=2      ListObjectsV2 (prefix/delimiter) XML
//   GET    /s3/                          ListBuckets  (pod top-level containers)
//   PUT    /s3/<bucket>                  CreateBucket (loopback create container)
//   DELETE /s3/<bucket>                  DeleteBucket
//
// Errors are S3 <Error><Code>…</Code></Error> XML (NoSuchKey→404,
// AccessDenied→403, NoSuchBucket→404, SignatureDoesNotMatch→403).
//
// ─── Auth ────────────────────────────────────────────────────────────────
// S3 authenticates with AWS Signature V4 (`Authorization: AWS4-HMAC-SHA256
// Credential=<id>/<date>/<region>/s3/aws4_request, SignedHeaders=…,
// Signature=…`). Real SDKs / aws-cli / rclone always sign; they will not send
// a bare Bearer. This plugin supports BOTH, and the tension between them is
// the headline finding (see README):
//
//   1. Bearer passthrough — `Authorization: Bearer <pod-token>` is forwarded
//      verbatim to loopback. Trivial, for curl / bespoke clients.
//   2. SigV4 verification (the strong path) — the plugin re-derives the
//      signature with node:crypto HMAC and compares. Because the plugin has
//      no accessKeyId→secret store and cannot reuse core's getAgent (which
//      only knows Bearer/DPoP/nostr — the getAgent-scheme-coupling finding),
//      the client configures BOTH access-key-id AND secret-access-key to the
//      pod token: the plugin reads the pod token from the (cleartext)
//      Credential accessKeyId, verifies the request was signed with that same
//      value as the secret, and forwards `Bearer <accessKeyId>` to loopback
//      so WAC still decides. This gives real S3 SDK compatibility and request
//      integrity; the "secret" travels in the Credential, so over TLS it is
//      no weaker than Bearer, but it is NOT a true secret — documented.

import crypto from 'node:crypto';

const XML_TYPE = 'application/xml';
const S3_MAX_KEYS = 1000; // hard cap on a single ListObjectsV2 page
const WALK_MAX_RESOURCES = 5000; // loopback fetches per list (bounded crawl)

// ─────────────────────────────────────────────────────────────── utilities

const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

const md5hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** An S3 ETag is the md5 hex wrapped in double quotes. */
const etagOf = (buf) => `"${md5hex(buf)}"`;

/** ISO-8601 with millis + Z, S3's LastModified/CreationDate format. */
function s3Date(v) {
  const d = v ? new Date(v) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
}

// ───────────────────────────────────────────────────────── S3 XML rendering

class S3Error extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const KNOWN_ERRORS = {
  400: 'InvalidRequest',
  403: 'AccessDenied',
  404: 'NoSuchKey',
  405: 'MethodNotAllowed',
  409: 'BucketAlreadyOwnedByYou',
  501: 'NotImplemented',
};

function s3ErrorXml(code, message, resource) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Error>'
    + `<Code>${xmlEscape(code)}</Code>`
    + `<Message>${xmlEscape(message)}</Message>`
    + (resource ? `<Resource>${xmlEscape(resource)}</Resource>` : '')
    + '</Error>';
}

function listAllMyBucketsXml(buckets) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    '<Owner><ID>solid-pod</ID><DisplayName>solid-pod</DisplayName></Owner>',
    '<Buckets>',
  ];
  for (const b of buckets) {
    parts.push(`<Bucket><Name>${xmlEscape(b.name)}</Name>`
      + `<CreationDate>${xmlEscape(b.creationDate)}</CreationDate></Bucket>`);
  }
  parts.push('</Buckets>', '</ListAllMyBucketsResult>');
  return parts.join('');
}

function listObjectsV2Xml({ bucket, prefix, delimiter, keyCount, maxKeys, truncated, contents, commonPrefixes }) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `<Name>${xmlEscape(bucket)}</Name>`,
    `<Prefix>${xmlEscape(prefix || '')}</Prefix>`,
    `<KeyCount>${keyCount}</KeyCount>`,
    `<MaxKeys>${maxKeys}</MaxKeys>`,
    delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : '',
    `<IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>`,
  ];
  for (const o of contents) {
    parts.push('<Contents>'
      + `<Key>${xmlEscape(o.key)}</Key>`
      + `<LastModified>${xmlEscape(o.lastModified)}</LastModified>`
      + `<ETag>${xmlEscape(o.etag)}</ETag>`
      + `<Size>${o.size}</Size>`
      + '<StorageClass>STANDARD</StorageClass>'
      + '</Contents>');
  }
  for (const cp of commonPrefixes) {
    parts.push(`<CommonPrefixes><Prefix>${xmlEscape(cp)}</Prefix></CommonPrefixes>`);
  }
  parts.push('</ListBucketResult>');
  return parts.join('');
}

// ─────────────────────────────────────────────────────────── SigV4 (verify)
//
// A faithful re-derivation of an AWS Signature V4 for service "s3": build the
// canonical request from what arrived, sign it with the presented accessKeyId
// as the secret, and constant-time compare to the presented signature. The
// canonical URI/query use the exact wire path so a compliant client that
// signs the request it actually sends will always match.

/** RFC-3986 encode (encodeURIComponent + the four it leaves: ! * ' ( )). */
function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => (
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  ));
}

function canonicalQuery(queryString) {
  if (!queryString) return '';
  const pairs = [];
  for (const part of queryString.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    // decode-then-encode so the canonical form is stable regardless of how
    // the client encoded it.
    let dk; let dv;
    try { dk = decodeURIComponent(k); } catch { dk = k; }
    try { dv = decodeURIComponent(v); } catch { dv = v; }
    pairs.push([uriEncode(dk), uriEncode(dv)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

function signingKey(secret, date, region, service) {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Parse `AWS4-HMAC-SHA256 Credential=…, SignedHeaders=…, Signature=…`. */
function parseSigV4(header) {
  const m = /^AWS4-HMAC-SHA256\s+(.*)$/s.exec(header);
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const cred = (out.Credential || '').split('/');
  if (cred.length < 5 || !out.SignedHeaders || !out.Signature) return null;
  return {
    accessKeyId: cred[0],
    date: cred[1],
    region: cred[2],
    service: cred[3],
    signedHeaders: out.SignedHeaders.split(';').map((h) => h.toLowerCase()),
    signature: out.Signature,
  };
}

/**
 * Verify a SigV4 request, treating the presented accessKeyId as the secret
 * (see the auth note at the top). Returns the pod bearer token to forward, or
 * throws S3Error(403, SignatureDoesNotMatch).
 */
function verifySigV4(request, bodyBuf) {
  const parsed = parseSigV4(request.headers.authorization);
  if (!parsed) throw new S3Error(403, 'AccessDenied', 'Malformed Authorization header');
  const method = request.raw.method;
  const [rawPath, queryString = ''] = request.raw.url.split('?');
  const amzDate = request.headers['x-amz-date'];
  if (!amzDate) throw new S3Error(403, 'AccessDenied', 'Missing x-amz-date');

  // Payload hash: the value the client put in x-amz-content-sha256 IS what
  // goes in the canonical request. When it is a real hex digest, verify the
  // body matches it (integrity); UNSIGNED-PAYLOAD is honoured verbatim.
  const payloadHash = request.headers['x-amz-content-sha256'] || sha256hex(bodyBuf);
  if (/^[0-9a-f]{64}$/.test(payloadHash) && payloadHash !== sha256hex(bodyBuf)) {
    throw new S3Error(403, 'AccessDenied', 'x-amz-content-sha256 does not match body');
  }

  const canonicalHeaders = parsed.signedHeaders
    .map((h) => `${h}:${String(request.headers[h] ?? '').trim()}\n`)
    .join('');
  const signedHeaders = parsed.signedHeaders.join(';');
  const canonicalRequest = [
    method,
    rawPath,
    canonicalQuery(queryString),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${parsed.date}/${parsed.region}/${parsed.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  // The pod token is the accessKeyId (only recoverable secret; see note).
  const secret = parsed.accessKeyId;
  const key = signingKey(secret, parsed.date, parsed.region, parsed.service);
  const expected = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(parsed.signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new S3Error(403, 'SignatureDoesNotMatch',
      'The request signature we calculated does not match the signature you provided');
  }
  return `Bearer ${parsed.accessKeyId}`;
}

// ─────────────────────────────────────────────────────────────────── plugin

export async function activate(api) {
  const prefix = api.prefix || '/s3';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      's3 plugin requires config.baseUrl — the plugin api exposes no server origin '
      + '(same api.serverInfo finding as notifications/webdav/rss); optional '
      + 'config.loopbackUrl overrides where the gateway reaches the host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  // Where buckets live. Normalize to a leading + trailing '/'. Default '/',
  // but that is server-owned — operators set this to their pod ('/alice/').
  let bucketRoot = api.config.bucketRoot || '/';
  if (!bucketRoot.startsWith('/')) bucketRoot = '/' + bucketRoot;
  if (!bucketRoot.endsWith('/')) bucketRoot += '/';

  const bucketPath = (bucket) => `${bucketRoot}${bucket}/`;
  const objectPath = (bucket, key) => `${bucketRoot}${bucket}/${key}`;

  // ------------------------------------------------------------------- auth
  /**
   * Resolve the request to a pod bearer to forward, or throw S3Error(403).
   * Bearer passes through; AWS4-HMAC-SHA256 is verified (accessKeyId = token).
   */
  function resolveAuth(request, bodyBuf) {
    const raw = request.headers.authorization;
    if (!raw) throw new S3Error(403, 'AccessDenied', 'Anonymous access is forbidden for this operation');
    if (/^bearer\s/i.test(raw)) return raw;
    if (/^AWS4-HMAC-SHA256/i.test(raw)) return verifySigV4(request, bodyBuf || Buffer.alloc(0));
    throw new S3Error(403, 'AccessDenied', 'Unsupported Authorization scheme');
  }

  // --------------------------------------------------------------- loopback
  function lb(path, { method = 'GET', headers = {}, body } = {}, auth) {
    return fetch(loopback + path, {
      method,
      redirect: 'manual',
      headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
  }

  /** Map a loopback status onto an S3Error (used after loopback ops). */
  function s3ErrorForStatus(status, { kind = 'key', resource } = {}) {
    if (status === 401 || status === 403) {
      return new S3Error(403, 'AccessDenied', 'Access Denied', resource);
    }
    if (status === 404) {
      return kind === 'bucket'
        ? new S3Error(404, 'NoSuchBucket', 'The specified bucket does not exist', resource)
        : new S3Error(404, 'NoSuchKey', 'The specified key does not exist', resource);
    }
    return new S3Error(status, KNOWN_ERRORS[status] || 'InternalError', `Upstream status ${status}`, resource);
  }

  /** GET a container listing as JSON-LD; throws S3Error on failure. */
  async function fetchListing(containerPath, auth, kind) {
    const res = await lb(containerPath, { headers: { accept: 'application/ld+json' } }, auth);
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* */ } throw s3ErrorForStatus(res.status, { kind }); }
    if (!(res.headers.get('content-type') || '').toLowerCase().includes('json')) {
      try { await res.body?.cancel(); } catch { /* */ }
      throw new S3Error(500, 'InternalError', 'Container listing was not JSON-LD');
    }
    try { return await res.json(); } catch { throw new S3Error(502, 'InternalError', 'Unparseable container listing'); }
  }

  /**
   * Members of a container listing, split into leaf objects and sub-containers,
   * each with its path relative to `origin` and best-effort size/modified.
   */
  function membersOf(listing, containerPath) {
    const base = baseUrl + containerPath;
    const objects = [];
    const containers = [];
    for (const child of [].concat(listing.contains ?? [])) {
      const id = typeof child === 'string' ? child : child?.['@id'];
      if (!id) continue;
      let u;
      try { u = new URL(id, base); } catch { continue; }
      if (u.origin !== origin) continue;
      const p = u.pathname;
      if (/\.(acl|meta)$/i.test(p)) continue;
      const meta = typeof child === 'object' ? child : {};
      const entry = { path: p, size: meta['stat:size'], modified: meta['dcterms:modified'] };
      if (p.endsWith('/')) containers.push(entry); else objects.push(entry);
    }
    return { objects, containers };
  }

  // --------------------------------------------------------------- requests
  /** The path after the prefix, e.g. '/photos/a/b.jpg' (query stripped). */
  function afterPrefix(request) {
    let rest = request.raw.url.split('?')[0].slice(prefix.length);
    if (!rest.startsWith('/')) rest = '/' + rest;
    try { /* keep encoded form for loopback, but reject traversal */ } catch { /* */ }
    if (rest.split('/').includes('..')) return null;
    return rest;
  }

  /** { bucket, key } from the post-prefix path ('' key ⇒ bucket-level op). */
  function parseTarget(request) {
    const rest = afterPrefix(request);
    if (rest === null) return null;
    const body = rest.slice(1); // drop leading '/'
    if (body === '') return { bucket: '', key: '' };
    const slash = body.indexOf('/');
    if (slash === -1) return { bucket: body, key: '' };
    return { bucket: body.slice(0, slash), key: body.slice(slash + 1) };
  }

  function sendXml(reply, status, xml) {
    return reply.code(status).header('content-type', XML_TYPE).send(xml);
  }

  function sendError(reply, err, resource) {
    const e = err instanceof S3Error ? err : new S3Error(500, 'InternalError', err.message);
    return sendXml(reply, e.status, s3ErrorXml(e.code, e.message, resource));
  }

  // ---- object operations --------------------------------------------------
  async function putObject(request, reply, { bucket, key }, auth) {
    const path = objectPath(bucket, key);
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const headers = {};
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    const res = await lb(path, { method: 'PUT', headers, body }, auth);
    if (!res.ok && res.status !== 204) throw s3ErrorForStatus(res.status, { resource: path });
    return reply.code(200).header('etag', etagOf(body)).send();
  }

  async function getObject(request, reply, { bucket, key }, auth, headOnly) {
    const path = objectPath(bucket, key);
    const res = await lb(path, { method: 'GET' }, auth);
    if (!res.ok) throw s3ErrorForStatus(res.status, { resource: path });
    // Buffer to compute the md5 ETag up-front (S3 clients read ETag from the
    // response headers before the body). See README: this trades streaming
    // for a content-hash ETag that matches PutObject/ListObjectsV2.
    const buf = Buffer.from(await res.arrayBuffer());
    reply.code(200)
      .header('etag', etagOf(buf))
      .header('content-length', String(buf.length))
      .header('accept-ranges', 'bytes');
    const ct = res.headers.get('content-type');
    if (ct) reply.header('content-type', ct);
    if (headOnly) return reply.send();
    return reply.send(buf);
  }

  async function deleteObject(reply, { bucket, key }, auth) {
    const path = objectPath(bucket, key);
    const res = await lb(path, { method: 'DELETE' }, auth);
    if (!res.ok && res.status !== 204 && res.status !== 404) throw s3ErrorForStatus(res.status, { resource: path });
    return reply.code(204).send();
  }

  // ---- bucket operations --------------------------------------------------
  async function createBucket(reply, { bucket }, auth) {
    const path = bucketPath(bucket);
    const res = await lb(path, { method: 'PUT' }, auth);
    if (!res.ok && res.status !== 204 && res.status !== 409) throw s3ErrorForStatus(res.status, { kind: 'bucket', resource: path });
    return reply.code(200).header('location', `/${bucket}`).send();
  }

  async function deleteBucket(reply, { bucket }, auth) {
    const path = bucketPath(bucket);
    const res = await lb(path, { method: 'DELETE' }, auth);
    if (!res.ok && res.status !== 204 && res.status !== 404) throw s3ErrorForStatus(res.status, { kind: 'bucket', resource: path });
    return reply.code(204).send();
  }

  async function listBuckets(reply, auth) {
    const listing = await fetchListing(bucketRoot, auth, 'bucket');
    const { containers } = membersOf(listing, bucketRoot);
    const buckets = containers.map((c) => ({
      name: c.path.slice(bucketRoot.length).replace(/\/$/, ''),
      creationDate: s3Date(c.modified),
    })).filter((b) => b.name);
    return sendXml(reply, 200, listAllMyBucketsXml(buckets));
  }

  /**
   * ListObjectsV2 — bounded recursive crawl of the bucket subtree. Without a
   * write-time index (no api.events) the only honest way to answer is a
   * read-time walk; O(N) in bucket size, capped at WALK_MAX_RESOURCES. Each
   * object is fetched to compute a content-md5 ETag that matches PutObject.
   */
  async function listObjectsV2(request, reply, { bucket }, auth) {
    const q = request.query || {};
    const reqPrefix = typeof q.prefix === 'string' ? q.prefix : '';
    const delimiter = typeof q.delimiter === 'string' ? q.delimiter : '';
    const maxKeys = Math.min(
      Number.isFinite(+q['max-keys']) && +q['max-keys'] > 0 ? +q['max-keys'] : S3_MAX_KEYS,
      S3_MAX_KEYS,
    );

    // Confirm the bucket exists (and is readable) before crawling.
    const bucketContainer = bucketPath(bucket);
    const rootListing = await fetchListing(bucketContainer, auth, 'bucket');

    const collected = []; // { key, size, modified }
    let fetched = 0;
    // DFS over containers; queue of { listing, containerPath }.
    const stack = [{ listing: rootListing, containerPath: bucketContainer }];
    while (stack.length && fetched < WALK_MAX_RESOURCES) {
      const { listing, containerPath } = stack.pop();
      const { objects, containers } = membersOf(listing, containerPath);
      for (const o of objects) {
        const key = o.path.slice(bucketContainer.length);
        if (reqPrefix && !key.startsWith(reqPrefix)) continue;
        collected.push({ key, path: o.path, size: o.size, modified: o.modified });
      }
      for (const c of containers) {
        const cKey = c.path.slice(bucketContainer.length); // e.g. 'a/'
        // With a delimiter we don't need to descend below the roll-up level,
        // but a nested key may still match reqPrefix, so descend only when the
        // sub-container could contain matching keys.
        if (reqPrefix && !cKey.startsWith(reqPrefix) && !reqPrefix.startsWith(cKey)) continue;
        if (fetched >= WALK_MAX_RESOURCES) break;
        fetched++;
        try {
          const sub = await fetchListing(c.path, auth);
          stack.push({ listing: sub, containerPath: c.path });
        } catch { /* unreadable sub-container: skip, WAC-respecting */ }
      }
    }

    // Apply delimiter roll-up over the prefix-filtered keys.
    const contents = [];
    const commonPrefixes = new Set();
    for (const item of collected) {
      if (delimiter) {
        const after = item.key.slice(reqPrefix.length);
        const idx = after.indexOf(delimiter);
        if (idx !== -1) {
          commonPrefixes.add(reqPrefix + after.slice(0, idx + delimiter.length));
          continue;
        }
      }
      contents.push(item);
    }

    contents.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const prefixes = [...commonPrefixes].sort();

    // Page + compute the content-md5 ETag per object (bounded fetches).
    const page = contents.slice(0, maxKeys);
    const truncated = contents.length > maxKeys;
    const out = [];
    for (const o of page) {
      let etag = '"d41d8cd98f00b204e9800998ecf8427e"'; // md5 of empty
      let size = Number.isFinite(+o.size) ? +o.size : 0;
      try {
        const res = await lb(o.path, { method: 'GET' }, auth);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          etag = etagOf(buf);
          size = buf.length;
        } else { try { await res.body?.cancel(); } catch { /* */ } }
      } catch { /* keep listing-derived size, empty-md5 etag */ }
      out.push({ key: o.key, lastModified: s3Date(o.modified), etag, size });
    }

    return sendXml(reply, 200, listObjectsV2Xml({
      bucket,
      prefix: reqPrefix,
      delimiter,
      keyCount: out.length + prefixes.length,
      maxKeys,
      truncated,
      contents: out,
      commonPrefixes: prefixes,
    }));
  }

  // --------------------------------------------------------------- dispatch
  async function dispatch(request, reply) {
    const method = request.raw.method;
    const target = parseTarget(request);
    if (target === null) return sendError(reply, new S3Error(400, 'InvalidRequest', 'Invalid path'));

    try {
      // Root: GET /s3/ → ListBuckets (needs auth).
      if (target.bucket === '') {
        if (method === 'GET' || method === 'HEAD') {
          const auth = resolveAuth(request, request.body);
          return await listBuckets(reply, auth);
        }
        throw new S3Error(405, 'MethodNotAllowed', 'Only GET is allowed on the service root');
      }

      // Object operations: bucket + non-empty key.
      if (target.key !== '') {
        const auth = resolveAuth(request, request.body);
        switch (method) {
          case 'PUT': return await putObject(request, reply, target, auth);
          case 'GET': return await getObject(request, reply, target, auth, false);
          case 'HEAD': return await getObject(request, reply, target, auth, true);
          case 'DELETE': return await deleteObject(reply, target, auth);
          default: throw new S3Error(405, 'MethodNotAllowed', `${method} not allowed on an object`);
        }
      }

      // Bucket operations: bucket, empty key.
      const auth = resolveAuth(request, request.body);
      switch (method) {
        case 'GET':
        case 'HEAD': return await listObjectsV2(request, reply, target, auth);
        case 'PUT': return await createBucket(reply, target, auth);
        case 'DELETE': return await deleteBucket(reply, target, auth);
        default: throw new S3Error(405, 'MethodNotAllowed', `${method} not allowed on a bucket`);
      }
    } catch (err) {
      const resource = `${prefix}${afterPrefix(request) || ''}`;
      return sendError(reply, err, resource);
    }
  }

  // Scope with a pass-through buffer parser so object bodies arrive as raw
  // Buffers (byte-exact PutObject, and exact bytes for SigV4 payload hashing)
  // — same move as corsproxy/ and gitscratch/ (relates to #583).
  await api.fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
    const methods = ['GET', 'HEAD', 'PUT', 'DELETE', 'POST'];
    for (const url of [prefix, `${prefix}/*`]) {
      scope.route({ method: methods, url, exposeHeadRoutes: false, handler: dispatch });
    }
  });

  api.log.info(`s3: S3 object-storage gateway at ${prefix} → ${loopback} (buckets under ${bucketRoot}; Bearer + SigV4)`);
}

// Exported for reuse in tests (an independent SigV4 signer proves interop).
export const _internals = { uriEncode, canonicalQuery, signingKey, sha256hex };
