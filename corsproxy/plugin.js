// CORS forward proxy as a #206 loader plugin.
//
//   plugins: [{ module: 'corsproxy/plugin.js', prefix: '/proxy',
//               config: { allowHosts: ['api.example.com'], requireAuth: true } }]
//
// Out-of-tree port of JSS src/handlers/cors-proxy.js (#378/#379,
// AGPL-3.0-only): browser apps fetch cross-origin resources that lack CORS
// headers through the pod's origin —
//
//   GET {prefix}?url=<encoded absolute URL>     query form
//   GET {prefix}/<absolute URL>                 path form
//
// and get the upstream response back with permissive CORS headers.
// Differences from core, all deliberate (see README.md):
//   - NO WAC gating. Core authorizes each request against the pod's .acl
//     for /proxy; a plugin's prefix is appPaths-exempt from WAC by design
//     (#582), so per-pod ACL control is impossible out here — the exact
//     limitation #382 describes. Access control is operator config only:
//     `requireAuth` (any agent api.auth.getAgent accepts) + `allowHosts`.
//   - fail-closed DNS: a hostname that resolves to zero addresses is
//     refused (core's shared guard fails open there — #381).
//   - `allowHosts` is a strict allowlist when set: only listed hosts are
//     reachable, and they bypass the private-address guard (the operator
//     vouched for them).
//
// SECURITY MODEL (a proxy is an SSRF cannon; every gate runs BEFORE fetch,
// and again on every redirect hop):
//   1. scheme gate      — http:/https: only (no file:, ftp:, gopher:, …)
//   2. allowHosts gate  — when configured, hostname (or host:port) must match
//   3. private-IP gate  — hostname is resolved (every A/AAAA record) and
//      refused if ANY address is loopback, RFC1918, link-local (incl. the
//      169.254.169.254 cloud metadata endpoint), CGNAT, ULA, multicast,
//      reserved, v4-mapped-private, or unresolvable (fail closed)
//   4. redirects        — followed manually (max `maxRedirects`), each
//      target re-validated through gates 1-3; the upstream Authorization
//      (from X-Upstream-Authorization) is stripped on cross-origin hops
//   5. credential hygiene — the caller's Authorization/Cookie/DPoP
//      authenticate to THIS pod and are never forwarded upstream; clients
//      opt in to upstream credentials via X-Upstream-Authorization
//   6. body cap         — upstream bodies stream through a `maxBodyBytes`
//      cap (partial slice, then abort), so a hostile upstream can't pin
//      memory or bandwidth forever
//
// Residual risk (documented, not fixable with global fetch): DNS rebinding.
// We resolve-then-fetch; fetch resolves again. A DNS answer that changes
// between the two lookups could slip past gate 3. Closing it needs a
// pinned-IP dial (custom undici Agent/connect), which the repo's import
// rule excludes. Core has the same resolve-then-fetch shape.

import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';

const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB, core's default
const DEFAULT_TIMEOUT_MS = 30_000; // headers-phase, core's default
const DEFAULT_MAX_REDIRECTS = 5;

// ---------------------------------------------------------------- IP gates

const V4_BLOCKED_CIDRS = [
  '0.0.0.0/8', //        "this network"
  '10.0.0.0/8', //       RFC1918
  '100.64.0.0/10', //    CGNAT
  '127.0.0.0/8', //      loopback
  '169.254.0.0/16', //   link-local (incl. 169.254.169.254 cloud metadata)
  '172.16.0.0/12', //    RFC1918
  '192.0.0.0/24', //     IETF protocol assignments
  '192.0.2.0/24', //     TEST-NET-1
  '192.168.0.0/16', //   RFC1918
  '198.18.0.0/15', //    benchmarking
  '198.51.100.0/24', //  TEST-NET-2
  '203.0.113.0/24', //   TEST-NET-3
  '224.0.0.0/4', //      multicast
  '240.0.0.0/4', //      reserved + broadcast
];

function v4ToInt(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

const V4_BLOCKED = V4_BLOCKED_CIDRS.map((cidr) => {
  const [base, bits] = cidr.split('/');
  const mask = (0xffffffff << (32 - Number(bits))) >>> 0;
  return { base: (v4ToInt(base) & mask) >>> 0, mask };
});

function isPrivateV4(ip) {
  const n = v4ToInt(ip);
  if (!Number.isFinite(n)) return true; // malformed — fail closed
  return V4_BLOCKED.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/** Expand an IPv6 literal to its 8 16-bit groups (null when malformed). */
function expandV6(ip) {
  let addr = ip.split('%')[0].toLowerCase();
  // Fold a trailing dotted-quad (::ffff:127.0.0.1) into two hex groups.
  const dotted = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    addr = addr.slice(0, -dotted[1].length)
      + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [headStr, tailStr = ''] = addr.split('::');
  const head = headStr ? headStr.split(':') : [];
  const tail = tailStr ? tailStr.split(':') : [];
  const groups = addr.includes('::')
    ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail]
    : head;
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (!g) return true; // malformed — fail closed
  const zeroThrough = (i) => g.slice(0, i).every((n) => n === 0);
  const embeddedV4 = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (zeroThrough(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4()); // ::ffff:v4
  if (g[0] === 0x64 && g[1] === 0xff9b && zeroThrough(6) === false
      && g.slice(2, 6).every((n) => n === 0)) return isPrivateV4(embeddedV4()); // 64:ff9b::/96 NAT64
  if (g.every((n) => n === 0)) return true; //                :: unspecified
  if (zeroThrough(7) && g[7] === 1) return true; //           ::1 loopback
  if ((g[0] & 0xfe00) === 0xfc00) return true; //             fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80) return true; //             fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; //             fec0::/10 site-local
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; //     2001:db8::/32 documentation
  return false;
}

function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true; // not an IP literal — fail closed
}

// ------------------------------------------------------------- target gate

class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Gates 1-3. Throws ProxyError(400) unless `url` may be fetched. */
async function assertAllowedTarget(url, cfg) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProxyError(400, `Refused: scheme '${url.protocol.slice(0, -1)}' not allowed (http/https only)`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (cfg.allowHosts.length > 0) {
    if (cfg.allowHosts.includes(hostname) || cfg.allowHosts.includes(url.host.toLowerCase())) return;
    throw new ProxyError(400, `Refused: host '${hostname}' is not in allowHosts`);
  }
  if (!cfg.blockPrivate) return;
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new ProxyError(400, `Refused: '${hostname}' is a private/reserved address`);
    }
    return;
  }
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ProxyError(400, `Refused: cannot resolve '${hostname}'`);
  }
  if (!records?.length) {
    // Zero A + AAAA records: refuse. Core's shared guard fails OPEN here (#381).
    throw new ProxyError(400, `Refused: '${hostname}' resolved to no addresses`);
  }
  for (const { address } of records) {
    if (isPrivateIp(address)) {
      throw new ProxyError(400, `Refused: '${hostname}' resolves to private/reserved address ${address}`);
    }
  }
}

// ------------------------------------------------------------ header policy

// Request → upstream: never forwarded. Hop-by-hop, this-pod credentials
// (Authorization/Cookie/DPoP authenticate to the pod, not the upstream —
// #379 header policy), request-routing metadata, and lengths/encodings
// fetch computes itself.
const STRIP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'expect', 'proxy-authorization', 'proxy-connection',
  'authorization', 'cookie', 'dpop', 'origin', 'referer',
  'content-length', 'accept-encoding', 'forwarded', 'via',
]);

// Upstream → response: hop-by-hop, encodings fetch already undid (the
// decoded body no longer matches content-length/-encoding), cookies (an
// upstream must not set cookies on the pod's origin), and the upstream's
// own CORS answer (we set ours).
const STRIP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'proxy-authenticate', 'proxy-connection',
  'content-encoding', 'content-length', 'set-cookie',
]);

function upstreamHeaders(request) {
  const out = {};
  for (const [k, v] of Object.entries(request.headers)) {
    const key = k.toLowerCase();
    if (STRIP_REQUEST.has(key)) continue;
    if (key.startsWith('x-forwarded-') || key.startsWith('sec-') || key.startsWith('access-control-')) continue;
    if (key === 'x-upstream-authorization') continue; // renamed below
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  // Opt-in upstream credential (#379): the caller's Authorization is for
  // this pod; X-Upstream-Authorization becomes Authorization on the way out.
  const upstreamAuth = request.headers['x-upstream-authorization'];
  if (typeof upstreamAuth === 'string' && upstreamAuth) out.authorization = upstreamAuth;
  return out;
}

// ------------------------------------------------------------------ plugin

export async function activate(api) {
  const prefix = api.prefix || '/proxy';
  const cfg = {
    allowHosts: Array.isArray(api.config.allowHosts)
      ? api.config.allowHosts.map((h) => String(h).toLowerCase())
      : [],
    blockPrivate: api.config.blockPrivate !== false, // default true
    requireAuth: api.config.requireAuth === true, // default false
    maxBodyBytes: Number.isFinite(api.config.maxBodyBytes) && api.config.maxBodyBytes > 0
      ? api.config.maxBodyBytes
      : DEFAULT_MAX_BODY_BYTES,
    timeoutMs: Number.isFinite(api.config.timeoutMs) && api.config.timeoutMs > 0
      ? api.config.timeoutMs
      : DEFAULT_TIMEOUT_MS,
    maxRedirects: Number.isFinite(api.config.maxRedirects)
      ? api.config.maxRedirects
      : DEFAULT_MAX_REDIRECTS,
  };

  function setCors(request, reply) {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('access-control-allow-headers',
      request.headers['access-control-request-headers']
      || 'Authorization, X-Upstream-Authorization, DPoP, Content-Type, Accept, If-None-Match, If-Modified-Since, Range');
    reply.header('access-control-expose-headers', '*');
    reply.header('access-control-max-age', '86400');
  }

  /** The proxied URL: query form (?url=) or path form ({prefix}/<url>). */
  function extractTarget(request) {
    const raw = request.raw.url || '';
    if (raw.startsWith(`${prefix}/`)) {
      const rawPath = raw.split('?')[0];
      if (rawPath.length > prefix.length + 1) {
        let tail = raw.slice(prefix.length + 1);
        if (/^https?%3a/i.test(tail)) {
          try { tail = decodeURIComponent(tail); } catch {
            throw new ProxyError(400, 'Malformed percent-encoding in target URL');
          }
        }
        // Path normalization collapses '//' — restore the scheme separator.
        return tail.replace(/^(https?:)\/+/i, '$1//');
      }
    }
    const q = request.query?.url;
    if (Array.isArray(q)) throw new ProxyError(400, 'Multiple url parameters');
    if (typeof q === 'string' && q) return q;
    throw new ProxyError(400, `Missing target: ${prefix}?url=<absolute-url> or ${prefix}/<absolute-url>`);
  }

  /**
   * Fetch with manual redirects: every hop re-runs the target gates, and
   * the upstream Authorization is dropped on cross-origin hops so an
   * X-Upstream-Authorization credential can't leak to a redirect target.
   */
  async function fetchWithRedirects(startUrl, method, headers, body, signal) {
    let url = startUrl;
    const initialOrigin = url.origin;
    for (let hop = 0; ; hop++) {
      await assertAllowedTarget(url, cfg);
      if (url.origin !== initialOrigin) delete headers.authorization;
      const noBody = method === 'GET' || method === 'HEAD';
      const res = await fetch(url, {
        method,
        headers,
        body: noBody ? undefined : body,
        redirect: 'manual',
        signal,
      });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return res;
      if (hop >= cfg.maxRedirects) throw new ProxyError(502, 'Too many redirects');
      res.body?.cancel().catch(() => {});
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new ProxyError(502, `Invalid redirect location: ${location}`);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && !noBody)) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
      }
      url = next;
    }
  }

  /** Stream the upstream body up to maxBodyBytes, then truncate + abort. */
  async function* capped(webBody, controller) {
    let sent = 0;
    try {
      for await (const chunk of webBody) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (sent + buf.length > cfg.maxBodyBytes) {
          yield buf.subarray(0, cfg.maxBodyBytes - sent);
          controller.abort(); // stop the upstream transfer too
          return;
        }
        sent += buf.length;
        yield buf;
      }
    } catch (err) {
      if (!controller.signal.aborted) throw err;
    }
  }

  async function handle(request, reply) {
    setCors(request, reply); // every exit — even errors — carries CORS (#376)
    if (request.method === 'OPTIONS') return reply.code(204).send();
    try {
      if (cfg.requireAuth) {
        const agent = await Promise.resolve(api.auth.getAgent(request)).catch(() => null);
        if (!agent) throw new ProxyError(401, 'Authentication required');
      }

      const target = extractTarget(request);
      let url;
      try {
        url = new URL(target);
      } catch {
        throw new ProxyError(400, `Invalid target URL: ${target}`);
      }

      const controller = new AbortController();
      const headerTimer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let res;
      try {
        const body = Buffer.isBuffer(request.body) && request.body.length ? request.body : undefined;
        res = await fetchWithRedirects(url, request.method, upstreamHeaders(request), body, controller.signal);
      } catch (err) {
        if (err instanceof ProxyError) throw err;
        if (controller.signal.aborted) throw new ProxyError(504, 'Upstream timed out');
        throw new ProxyError(502, `Upstream fetch failed: ${err?.cause?.message || err.message}`);
      } finally {
        clearTimeout(headerTimer); // headers-phase timeout only, like core (#380)
      }

      reply.code(res.status);
      for (const [k, v] of res.headers) {
        const key = k.toLowerCase();
        if (STRIP_RESPONSE.has(key) || key.startsWith('access-control-')) continue;
        reply.header(k, v);
      }
      if (!res.body) return reply.send('');
      return reply.send(Readable.from(capped(res.body, controller)));
    } catch (err) {
      const status = err instanceof ProxyError ? err.status : 502;
      return reply.code(status).send({ error: 'Proxy refused', message: err.message });
    }
  }

  // Scope with a pass-through parser so request bodies arrive as raw
  // Buffers and forward byte-exact (same move as tunnel/; relates to #583).
  await api.fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
    scope.all(prefix, handle);
    scope.all(`${prefix}/*`, handle);
  });

  api.log.info(
    `corsproxy: ${prefix}?url=… (${cfg.allowHosts.length ? `allowHosts: ${cfg.allowHosts.join(', ')}` : `blockPrivate: ${cfg.blockPrivate}`}${cfg.requireAuth ? ', requireAuth' : ''})`,
  );
}
