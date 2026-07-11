// Pod backup: download a container (recursively) as a .tar.gz, as a #206
// loader plugin.
//
//   plugins: [{ module: 'backup/plugin.js', prefix: '/backup',
//               config: { loopbackUrl: 'http://127.0.0.1:3000' } }]
//
//   GET /backup/alice/           → alice.tar.gz  (the whole pod)
//   GET /backup/alice/photos/    → alice-photos.tar.gz
//   GET /backup/                 → 400 with usage (no whole-server export)
//
// Data portability, read-only: the named container is walked over LOOPBACK
// HTTP carrying the CALLER'S OWN Authorization header — the same pattern
// rss/, sparql/, search/ and webdav/ established — so the host's real WAC
// decides what is readable. The plugin has no authority of its own:
//
//   * with a pod bearer, you get everything you can read;
//   * with no credentials, you still get an archive — of exactly the
//     publicly-readable subset. Resources the walk cannot GET (401/403, or
//     any other failure) are SKIPPED, not fatal, and recorded in a
//     MANIFEST.json entry at the archive root (the last entry written).
//
// The tar is hand-rolled POSIX ustar on node builtins (512-byte headers,
// octal fields, checksum-over-spaces, data padded to 512, two zero blocks at
// the end), piped through node:zlib gzip and STREAMED to the response — one
// resource is buffered at a time, never the whole archive. Entry names
// longer than 100 bytes use the ustar prefix field (155 bytes); a name that
// still doesn't fit is skipped and counted. Containers become directory
// entries (typeflag '5'). `.acl` / `.meta` companions are not exported (the
// walk mirrors rss/'s proven member filter); permissions don't survive a
// tarball anyway — see README.

import zlib from 'node:zlib';
import { once } from 'node:events';

const DEFAULT_MAX_RESOURCES = 10000; // loopback fetches per archive
const DEFAULT_MAX_DEPTH = 32;

// ------------------------------------------------------------- ustar writer

/** Octal field: (len-1) digits, NUL-terminated — the POSIX form. */
function octal(value, len) {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}

/**
 * Split an entry name into ustar { name ≤100, prefix ≤155 } at a '/'
 * boundary (byte lengths). Returns null when no split fits.
 */
function splitName(full) {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' };
  for (let i = full.indexOf('/'); i !== -1; i = full.indexOf('/', i + 1)) {
    const prefix = full.slice(0, i);
    const name = full.slice(i + 1);
    if (name && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  return null;
}

/**
 * One 512-byte POSIX ustar header, or null when the name cannot be encoded.
 * type '0' = file, '5' = directory (name should end with '/').
 */
function tarHeader({ name, size, mtimeSec, type }) {
  const split = splitName(name);
  if (!split) return null;
  const buf = Buffer.alloc(512);
  buf.write(split.name, 0, 100, 'utf8');
  buf.write(octal(type === '5' ? 0o755 : 0o644, 8), 100);
  buf.write(octal(0, 8), 108); // uid
  buf.write(octal(0, 8), 116); // gid
  buf.write(octal(size, 12), 124);
  buf.write(octal(mtimeSec, 12), 136);
  buf.fill(0x20, 148, 156); // checksum counted as spaces
  buf.write(type, 156);
  buf.write('ustar', 257); // magic, NUL already in place at 262
  buf.write('00', 263); // version
  buf.write('backup', 265); // uname
  buf.write('backup', 297); // gname
  if (split.prefix) buf.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return buf;
}

// ---------------------------------------------------------------- utilities

/**
 * Tar entry name for a pod path: leading '/' stripped, each segment
 * percent-decoded for readability — but a segment whose decoded form would
 * change the path shape ('.', '..', '/', NUL…) keeps its encoded form, so a
 * hostile resource name can never traverse out of the extraction directory.
 */
function entryName(podPath) {
  return podPath.split('/').map((seg) => {
    if (!seg) return seg;
    let dec = seg;
    try { dec = decodeURIComponent(seg); } catch { return seg; }
    if (dec === '.' || dec === '..' || /[/\\\0]/.test(dec)) return seg;
    return dec;
  }).join('/').slice(1);
}

/** Download filename for a container path: '/alice/photos/' → 'alice-photos.tar.gz'. */
function archiveFilename(containerPath) {
  const stem = entryName(containerPath)
    .replace(/\/+$/, '')
    .replace(/\//g, '-')
    .replace(/[^\w.-]+/g, '_');
  return `${stem || 'backup'}.tar.gz`;
}

// ---------------------------------------------------------------- activate

export async function activate(api) {
  const prefix = api.prefix || '/backup';
  const loopback = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!loopback) {
    throw new Error(
      'backup plugin requires config.loopbackUrl — the plugin api exposes no '
      + 'server origin (same api.serverInfo finding as notifications/rss/sparql); '
      + 'point it at the host itself, e.g. http://127.0.0.1:3000',
    );
  }
  const origin = new URL(loopback).origin;
  const publicOrigin = api.config.baseUrl ? new URL(api.config.baseUrl).origin : null;
  const maxResources = api.config.maxResources ?? DEFAULT_MAX_RESOURCES;
  const maxDepth = api.config.maxDepth ?? DEFAULT_MAX_DEPTH;

  /** One loopback GET carrying the caller's own Authorization. */
  function lb(path, accept, auth) {
    return fetch(loopback + path, {
      redirect: 'manual',
      headers: { accept, ...(auth ? { authorization: auth } : {}) },
    });
  }

  /** The pod path this request addresses ('/alice/…'), or null on traversal. */
  function podPath(request) {
    let rest = request.raw.url.split('?')[0].slice(prefix.length);
    if (!rest.startsWith('/')) rest = '/' + rest;
    if (rest.split('/').includes('..')) return null;
    return rest;
  }

  /** GET a container listing as JSON-LD → { listing } | { error, status }. */
  async function fetchListing(containerPath, auth) {
    let res;
    try {
      res = await lb(containerPath, 'application/ld+json', auth);
    } catch {
      return { error: true, status: 502 };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      return { error: true, status: res.status };
    }
    if (!(res.headers.get('content-type') || '').toLowerCase().includes('json')) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      return { error: true, status: 415 }; // not an LDP container listing
    }
    try {
      return { listing: await res.json() };
    } catch {
      return { error: true, status: 502 };
    }
  }

  /** ldp:contains of a listing → [{ path, modified }], same-origin, no .acl/.meta. */
  function members(listing, containerPath) {
    const base = origin + containerPath;
    const out = [];
    for (const child of [].concat(listing.contains ?? [])) {
      const id = typeof child === 'string' ? child : child?.['@id'];
      if (!id) continue;
      let u;
      try { u = new URL(id, base); } catch { continue; }
      if (u.origin !== origin && u.origin !== publicOrigin) continue;
      if (u.pathname === containerPath) continue;
      if (/\.(acl|meta)$/i.test(u.pathname)) continue;
      const modified = typeof child === 'object'
        ? (child['dcterms:modified'] ?? child.modified ?? null)
        : null;
      out.push({ path: u.pathname, modified });
    }
    return out;
  }

  /**
   * Walk the container depth-first as the caller and stream tar entries into
   * `gzip`: directory entry per container, file entry per readable resource
   * (one buffered at a time), unreadable/overlong/failed entries skipped and
   * recorded, MANIFEST.json last, then the two terminating zero blocks.
   */
  async function streamArchive(gzip, rootPath, rootListing, auth) {
    const included = [];
    const skipped = [];
    const visited = new Set();
    let fetched = 0;
    let truncated = false;

    // Respect backpressure; events.once rejects if the stream errors.
    const write = async (chunk) => {
      if (!gzip.write(chunk)) await once(gzip, 'drain');
    };

    const writeEntry = async (name, body, { mtime, type = '0' } = {}) => {
      const size = type === '5' ? 0 : body.length;
      const header = tarHeader({
        name, size, mtimeSec: Math.max(0, Math.floor((mtime ?? Date.now()) / 1000)), type,
      });
      if (!header) return false; // name unrepresentable even with the prefix field
      await write(header);
      if (size > 0) {
        await write(body);
        const tail = size % 512;
        if (tail) await write(Buffer.alloc(512 - tail));
      }
      return true;
    };

    const skip = (path, reason, status) => {
      skipped.push({ path, reason, ...(status ? { status } : {}) });
    };

    async function addResource(member) {
      let res;
      try {
        res = await lb(member.path, '*/*', auth);
      } catch {
        return skip(member.path, 'error');
      }
      if (!res.ok) {
        try { await res.body?.cancel(); } catch { /* drained */ }
        return skip(
          member.path,
          res.status === 401 || res.status === 403 ? 'unauthorized' : 'error',
          res.status,
        );
      }
      const contentType = res.headers.get('content-type') || null;
      let body;
      try {
        body = Buffer.from(await res.arrayBuffer());
      } catch {
        return skip(member.path, 'error');
      }
      const name = entryName(member.path);
      const mtime = member.modified ? (Date.parse(member.modified) || Date.now()) : Date.now();
      if (!(await writeEntry(name, body, { mtime }))) {
        return skip(member.path, 'name-too-long');
      }
      included.push({ path: member.path, entry: name, size: body.length, contentType });
    }

    async function walk(containerPath, listing, depth) {
      const name = entryName(containerPath);
      if (!(await writeEntry(name, null, { type: '5' }))) {
        return skip(containerPath, 'name-too-long');
      }
      included.push({ path: containerPath, entry: name, container: true });
      for (const member of members(listing, containerPath)) {
        if (visited.has(member.path)) continue;
        visited.add(member.path);
        if (fetched >= maxResources) { truncated = true; break; }
        fetched += 1;
        if (member.path.endsWith('/')) {
          if (depth >= maxDepth) { truncated = true; skip(member.path, 'max-depth'); continue; }
          const sub = await fetchListing(member.path, auth);
          if (sub.error) {
            skip(
              member.path,
              sub.status === 401 || sub.status === 403 ? 'unauthorized' : 'error',
              sub.status,
            );
            continue;
          }
          await walk(member.path, sub.listing, depth + 1);
        } else {
          await addResource(member);
        }
      }
    }

    visited.add(rootPath);
    await walk(rootPath, rootListing, 0);

    const manifest = Buffer.from(JSON.stringify({
      container: rootPath,
      generated: new Date().toISOString(),
      truncated,
      counts: { included: included.length, skipped: skipped.length },
      included,
      skipped,
    }, null, 2));
    await writeEntry('MANIFEST.json', manifest, {});
    await write(Buffer.alloc(1024)); // two terminating zero blocks
    gzip.end();
  }

  // ------------------------------------------------------------------ route

  const usage = (reply) => reply.code(400).send({
    error: `name a container: GET ${prefix}/<pod-path>/ — e.g. ${prefix}/alice/ `
      + 'streams a .tar.gz of everything under /alice/ the caller can read '
      + '(whole-server export is deliberately not offered)',
  });

  async function handleBackup(request, reply) {
    const rest = podPath(request);
    if (rest === null) return reply.code(400).send();
    if (rest === '/' || rest === '') return usage(reply);
    const containerPath = rest.endsWith('/') ? rest : `${rest}/`;
    const auth = request.headers.authorization ?? null;

    // Probe the root container BEFORE committing 200: an unreadable or
    // missing root is the caller's error status, not an empty archive.
    const first = await fetchListing(containerPath, auth);
    if (first.error) {
      if (first.status === 401) reply.header('www-authenticate', 'Bearer');
      return reply.code(first.status).send();
    }

    const gzip = zlib.createGzip();
    reply.code(200)
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${archiveFilename(containerPath)}"`)
      .send(gzip);
    streamArchive(gzip, containerPath, first.listing, auth).catch((err) => {
      api.log.error(`backup: archive stream failed: ${err.message}`);
      gzip.destroy(err);
    });
    return reply;
  }

  api.fastify.get(`${prefix}/*`, handleBackup);
  api.fastify.get(prefix, (request, reply) => usage(reply));

  api.log.info(`backup: container → .tar.gz export at ${prefix}/<path>/ (loopback walk; WAC-respecting)`);
}
