// Reverse HTTP tunnel over WebSocket ("decentralized ngrok") as a #206
// loader plugin.
//
//   plugins: [{ module: 'tunnel/plugin.js', prefix: '/tunnel',
//               config: { requestTimeout: 30000 } }]
//
// A tunnel client connects to ws://host{prefix}/connect, authenticates
// (any credential api.auth.getAgent accepts: Bearer, DPoP, NIP-98, …),
// registers a name, and receives proxied HTTP requests to forward to a
// local server. Visitors reach it at http://host{prefix}/{name}/path.
//
// Tunnel client protocol (JSON over WebSocket) — unchanged from core:
//   → { type: "register", name: "myapp", passthrough?: true }
//   ← { type: "registered", name: "myapp", url: "/tunnel/myapp/", passthrough: true|false }
//   ← { type: "request", id: "<uuid>", method: "GET", path: "/api/hello",
//       headers: {...}, body?: "...", bodyEncoding?: "base64"|"utf8" }
//   → { type: "response", id: "<uuid>", status: 200, headers: {...},
//       body: "...", bodyEncoding?: "base64" }
//   ← { type: "error", message: "..." }
//
// Adapted from JSS src/tunnel/index.js (AGPL-3.0-only,
// https://github.com/JavaScriptSolidServer/JavaScriptSolidServer) — the
// #530 credential-passthrough model, #567 message-size cap and #528
// ?token= browser fallback are ported verbatim. Differences from core,
// all deliberate (see README.md):
//   - ONE mount prefix: core serves the control socket at /.tunnel and
//     traffic at /tunnel/{name}/…, two separate path roots. The loader
//     WAC-exempts a single prefix, so here the control socket lives at
//     {prefix}/connect and traffic at {prefix}/{name}/… — which makes
//     "connect" a reserved tunnel name.
//   - raw request bodies: the proxy routes live in a Fastify scope with
//     a pass-through content-type parser (relates to JSS #583), so any
//     body is forwarded byte-exact as base64 instead of core's
//     parsed-then-reserialized JSON.
//   - auth via api.auth.getAgent (the #584 contract) instead of the
//     internal getWebIdFromRequestAsync; agents are keyed on the agent
//     id string (WebID or did:nostr DID).
//   - requestTimeout / maxMessageSize are config knobs (core hardcodes
//     30s / 10MB).

import { randomUUID } from 'node:crypto';

const DEFAULT_REQUEST_TIMEOUT = 30_000; // 30s for tunnel responses
const DEFAULT_MAX_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB (#567)

// --- #530 credential hygiene, ported from core -------------------------
// Cookie names reserved by the relay's own oidc-provider IdP. They share
// two prefixes; match the prefix plus a `.`/`_` boundary so a tunnelled
// service's unrelated cookie (e.g. `_sessionsLeft`) isn't stripped.
const RELAY_COOKIE_PREFIXES = ['_session', '_interaction'];

function isRelayCookieName(name) {
  return RELAY_COOKIE_PREFIXES.some(
    (p) => name === p || name.startsWith(`${p}.`) || name.startsWith(`${p}_`),
  );
}

/**
 * Remove the relay's own IdP cookies from a forwarded Cookie header,
 * keeping the visitor's cookies bound for the tunnelled service.
 * Returns '' when nothing remains (caller then drops the header).
 */
function stripRelayCookies(cookieHeader) {
  // Node folds duplicate Cookie headers into one string, but Fastify can
  // surface string[] — normalize so passthrough doesn't drop every cookie
  // when an array arrives. Cookies join with '; '.
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (typeof raw !== 'string') return '';
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((pair) => {
      const eq = pair.indexOf('=');
      const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
      return !isRelayCookieName(name);
    })
    .join('; ');
}

export async function activate(api) {
  const prefix = api.prefix || '/tunnel';
  const connectPath = `${prefix}/connect`;
  const reservedName = 'connect'; // {prefix}/connect is the control socket
  const requestTimeout = api.config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
  const maxMessageSize = api.config.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;

  // Instance-scoped: tunnel name → { socket, agent, passthrough }
  const tunnels = new Map();
  // Pending HTTP requests waiting for a tunnel response: id → { resolve, timer, tunnelName }
  const pending = new Map();

  const send = (socket, msg) => {
    try { socket.send(JSON.stringify(msg)); } catch { /* socket going away */ }
  };

  // ------------------------------------------------ control WebSocket
  await api.ws.route(connectPath, (socket, request) => {
    // Browser WebSockets can't set an Authorization header, so accept the
    // bearer token as a ?token= query param too (#528).
    const queryToken = request.query?.token;
    if (queryToken && !request.headers.authorization) {
      request.headers.authorization = `Bearer ${queryToken}`;
    }

    // Authenticate. Unlike core (which awaits before wiring handlers and
    // can drop a register frame sent during a slow verification), queue
    // every message behind the auth promise — ordering is preserved.
    const agentPromise = Promise.resolve(api.auth.getAgent(request))
      .catch(() => null)
      .then((agent) => {
        if (!agent) {
          send(socket, { type: 'error', message: 'Authentication required' });
          socket.close();
        }
        return agent;
      });

    let tunnelName = null;

    socket.on('message', async (data) => {
      const agent = await agentPromise;
      if (!agent) return;

      const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (raw.byteLength > maxMessageSize) {
        send(socket, { type: 'error', message: 'Message too large' });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      if (msg.type === 'register') {
        const name = (msg.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!name) {
          send(socket, { type: 'error', message: 'Invalid tunnel name' });
          return;
        }
        if (name === reservedName) {
          send(socket, { type: 'error', message: `Invalid tunnel name: "${reservedName}" is reserved for the control endpoint` });
          return;
        }

        const existing = tunnels.get(name);
        if (existing && existing.agent !== agent) {
          send(socket, { type: 'error', message: 'Tunnel name taken by another user' });
          return;
        }
        // Close old tunnel with the same name from the same user
        if (existing) existing.socket.close();

        // Per-tunnel credential passthrough (#530) — strict boolean so a
        // truthy-but-wrong value ("false", 1) can't silently enable
        // credential forwarding. Echoed in the ack so the client knows
        // which mode was actually applied.
        const passthrough = msg.passthrough === true;

        tunnelName = name;
        tunnels.set(name, { socket, agent, passthrough });
        send(socket, { type: 'registered', name, url: `${prefix}/${name}/`, passthrough });

      } else if (msg.type === 'response') {
        // Tunnel client returning an HTTP response
        if (!msg.id) return;
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pending.delete(msg.id);
          p.resolve({
            status: msg.status || 502,
            headers: msg.headers || {},
            body: msg.body || '',
            bodyEncoding: msg.bodyEncoding,
          });
        }
      }
    });

    socket.on('close', () => {
      if (tunnelName && tunnels.get(tunnelName)?.socket === socket) {
        tunnels.delete(tunnelName);
        // Resolve pending requests for this tunnel only, with 502
        for (const [id, p] of pending) {
          if (p.tunnelName === tunnelName) {
            clearTimeout(p.timer);
            pending.delete(id);
            p.resolve({ status: 502, headers: {}, body: 'Tunnel disconnected' });
          }
        }
      }
    });

    socket.on('error', () => {});
  });

  // ------------------------------------------------ public HTTP proxy
  // The proxy must forward request bodies byte-exact, but Fastify's
  // default parsers consume and re-shape them (JSON → object). Scope the
  // proxy routes behind a pass-through parser so request.body is the raw
  // Buffer (relates to JSS #583).
  await api.fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

    scope.all(`${prefix}/:name/*`, async (request, reply) => {
      const { name } = request.params;
      const tunnel = tunnels.get(name);

      if (!tunnel || tunnel.socket.readyState !== 1) {
        return reply.code(502).send({ error: 'Bad Gateway', message: 'Tunnel not connected' });
      }

      // Build the downstream path (strip {prefix}/{name})
      const fullPath = request.url.replace(`${prefix}/${name}`, '') || '/';
      const id = randomUUID();

      // Serialize the HTTP request
      const tunnelReq = Object.create(null);
      tunnelReq.type = 'request';
      tunnelReq.id = id;
      tunnelReq.method = request.method;
      tunnelReq.path = fullPath;
      tunnelReq.headers = Object.create(null);
      // Forward relevant headers. Hop-by-hop headers are always skipped;
      // credentials (cookie / authorization) are skipped UNLESS the tunnel
      // registered with passthrough (#530 — owner opted in to receive
      // visitor credentials). Proxy-Authorization is always stripped: it
      // is addressed to this relay, never to the tunnelled service.
      const skipHeaders = new Set(['host', 'connection', 'upgrade', 'transfer-encoding', 'proxy-authorization']);
      if (!tunnel.passthrough) {
        skipHeaders.add('cookie');
        skipHeaders.add('authorization');
      }
      for (const [k, v] of Object.entries(request.headers)) {
        const lower = k.toLowerCase();
        if (skipHeaders.has(lower)) continue;
        if (lower === 'cookie' && tunnel.passthrough) {
          // Forward the visitor's cookies for the tunnelled service, but
          // never the relay's own IdP session cookies (#530 security).
          const filtered = stripRelayCookies(v);
          if (filtered) tunnelReq.headers[k] = filtered;
          continue;
        }
        tunnelReq.headers[k] = v;
      }
      // Forward body if present. The pass-through parser gives a Buffer;
      // the string/object branches are kept from core for safety should a
      // parser ever produce them.
      if (request.body) {
        tunnelReq.body = Buffer.isBuffer(request.body)
          ? request.body.toString('base64')
          : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        tunnelReq.bodyEncoding = Buffer.isBuffer(request.body) ? 'base64' : 'utf8';
      }

      // Send to the tunnel client and wait for the response
      const responsePromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ status: 504, headers: {}, body: 'Gateway Timeout' });
        }, requestTimeout);
        pending.set(id, { resolve, timer, tunnelName: name });
      });

      try {
        tunnel.socket.send(JSON.stringify(tunnelReq));
      } catch {
        const p = pending.get(id);
        if (p) { clearTimeout(p.timer); pending.delete(id); }
        return reply.code(502).send({ error: 'Bad Gateway', message: 'Failed to reach tunnel client' });
      }

      const res = await responsePromise;

      // Set response headers. Set-Cookie is stripped by default so a
      // tunnelled service can't set cookies on the relay's origin; with
      // passthrough (#530) the owner opted in and session flows (e.g.
      // OIDC login cookies) must survive the proxy. Fastify accepts an
      // array value for set-cookie, which JSON serialization preserves.
      const hopHeaders = new Set(['connection', 'transfer-encoding', 'keep-alive']);
      if (!tunnel.passthrough) {
        hopHeaders.add('set-cookie');
      }
      for (const [k, v] of Object.entries(res.headers)) {
        if (!hopHeaders.has(k.toLowerCase())) {
          reply.header(k, v);
        }
      }

      // Decode body if base64
      const body = res.bodyEncoding === 'base64' && res.body
        ? Buffer.from(res.body, 'base64')
        : res.body || '';

      return reply.code(res.status).send(body);
    });

    // Also handle {prefix}/{name} without a trailing path
    scope.all(`${prefix}/:name`, async (request, reply) => {
      const { name } = request.params;
      const tunnel = tunnels.get(name);

      if (!tunnel || tunnel.socket.readyState !== 1) {
        return reply.code(502).send({ error: 'Bad Gateway', message: 'Tunnel not connected' });
      }

      return reply.redirect(308, `${prefix}/${name}/`);
    });
  });

  api.log.info(`tunnel: control ws at ${connectPath}, public paths at ${prefix}/{name}/…`);

  return {
    deactivate() {
      for (const [, tunnel] of tunnels) {
        try { tunnel.socket.close(); } catch { /* already gone */ }
      }
      tunnels.clear();
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ status: 502, headers: {}, body: 'Tunnel shutting down' });
      }
      pending.clear();
    },
  };
}
