// Solid notifications (legacy "solid-0.1" protocol) as a #206 loader plugin.
//
//   plugins: [{ module: 'notifications/plugin.js', prefix: '/.notifications',
//               config: { podsRoot: './data', baseUrl: 'http://localhost:3000' } }]
//
// Out-of-tree port of JSS src/notifications/ (AGPL-3.0-only). This is the
// deliberate seam-forcer of the experiment: core's version has two change
// sources (in-process emitChange() calls from the LDP handlers, plus a
// recursive fs watcher) and injects Updates-Via discovery headers into
// every response. A plugin gets none of that — see README "Findings" for
// the three seams this port demonstrates the need for (api.events,
// api.serverInfo, response-header hooks). What it CAN do honestly:
//
//   - watch the pod root via fs.watch (the operator passes the path in —
//     the plugin api has no way to learn it);
//   - speak the exact solid-0.1 protocol (protocol/sub/ack/err/pub, with
//     ancestor-container fan-out) so SolidOS clients work unchanged;
//   - authorize subscriptions WITHOUT internal WAC access by loopback:
//     a HEAD request to the resource carrying the subscriber's own
//     Authorization header — if the server would serve it, they may hear
//     about it. Slower than core's in-process checkAccess, but it can
//     never disagree with the server's real policy.

import { watch } from 'node:fs';

const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;
const MAX_URL_LENGTH = 2048;
const DEBOUNCE_MS = 100;

export async function activate(api) {
  const wsPath = api.prefix || '/.notifications';
  const podsRoot = api.config.podsRoot;
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!podsRoot || !baseUrl) {
    throw new Error(
      'notifications plugin requires config.podsRoot and config.baseUrl — ' +
      'the plugin api exposes neither the data root nor the public origin (see README findings)',
    );
  }
  const loopback = api.config.loopbackUrl || baseUrl; // where WE can reach the server

  const subscriptions = new Map(); // socket -> Set<url>
  const subscribers = new Map(); // url -> Set<socket>

  function subscribe(socket, url) {
    subscriptions.get(socket)?.add(url);
    if (!subscribers.has(url)) subscribers.set(url, new Set());
    subscribers.get(url).add(socket);
  }

  function unsubscribe(socket, url) {
    subscriptions.get(socket)?.delete(url);
    subscribers.get(url)?.delete(socket);
    if (subscribers.get(url)?.size === 0) subscribers.delete(url);
  }

  function cleanup(socket) {
    for (const url of subscriptions.get(socket) ?? []) subscribers.get(url)?.delete(socket);
    subscriptions.delete(socket);
  }

  function notifySubscribers(url) {
    for (const socket of subscribers.get(url) ?? []) {
      try {
        socket.send(`pub ${url}`);
      } catch { /* closing; cleaned up on close */ }
    }
  }

  function getParentContainer(url) {
    try {
      const u = new URL(url);
      if (u.pathname === '/' || u.pathname === '') return null;
      const trimmed = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
      const parent = trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
      return u.origin + parent;
    } catch {
      return null;
    }
  }

  /** pub the resource and every ancestor container (solid-0.1 semantics). */
  function broadcast(url) {
    notifySubscribers(url);
    const originRoot = new URL(url).origin + '/';
    let current = url;
    let container = getParentContainer(current);
    while (container && container !== current && container.length >= originRoot.length) {
      notifySubscribers(container);
      current = container;
      container = getParentContainer(current);
    }
  }

  /**
   * May this subscriber hear about this URL? No internal WAC access from a
   * plugin, so ask the server itself: HEAD with the subscriber's own
   * credentials. 2xx/3xx — including 304 — means readable.
   */
  async function canSubscribe(url, authorization) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.origin !== new URL(baseUrl).origin) return false; // no proxy-probing other hosts
    try {
      const res = await fetch(new URL(parsed.pathname + parsed.search, loopback), {
        method: 'HEAD',
        redirect: 'manual',
        headers: authorization ? { authorization } : {},
      });
      // 404 subscribes fine (watching a resource that doesn't exist yet is
      // legitimate — core behaves the same for non-existent paths).
      return res.status < 400 || res.status === 404;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ watcher
  const debounceMap = new Map();
  const watcher = watch(podsRoot, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const base = filename.split('/').pop();
    if (base.startsWith('.') || filename.endsWith('~') || filename.endsWith('.swp')) return;
    if (filename.startsWith('.')) return; // .idp, .plugins, dot-guarded trees
    const now = Date.now();
    if (now - (debounceMap.get(filename) ?? 0) < DEBOUNCE_MS) return;
    debounceMap.set(filename, now);
    if (debounceMap.size > 1000) {
      for (const [key, time] of debounceMap) {
        if (now - time > 5000) debounceMap.delete(key);
      }
    }
    broadcast(baseUrl + '/' + filename.replace(/\\/g, '/'));
  });
  watcher.on('error', (err) => api.log.error(`notifications: watcher error: ${err.message}`));

  // ------------------------------------------------------------ websocket
  await api.ws.route(wsPath, (socket, request) => {
    const authorization = request.headers?.authorization ?? null;
    socket.send('protocol solid-0.1');
    subscriptions.set(socket, new Set());

    socket.on('message', async (message) => {
      const msg = String(message).trim();
      if (msg.startsWith('sub ')) {
        const url = msg.slice(4).trim();
        if (!url) return;
        if (url.length > MAX_URL_LENGTH) return socket.send('error: URL too long');
        if ((subscriptions.get(socket)?.size ?? 0) >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          return socket.send('error: Subscription limit exceeded');
        }
        if (!(await canSubscribe(url, authorization))) return socket.send(`err ${url} forbidden`);
        subscribe(socket, url);
        socket.send(`ack ${url}`);
      } else if (msg.startsWith('unsub ')) {
        const url = msg.slice(6).trim();
        if (url) unsubscribe(socket, url);
      }
    });
    socket.on('close', () => cleanup(socket));
    socket.on('error', () => cleanup(socket));
  });

  // Status endpoint (core keeps this at /.well-known/solid/notifications —
  // outside any single prefix a plugin can own; ours lives under the mount).
  api.fastify.get(wsPath + '/status', async () => ({
    connections: subscriptions.size,
    subscriptions: [...subscriptions.values()].reduce((n, s) => n + s.size, 0),
    protocol: 'solid-0.1',
  }));

  api.log.info(`notifications: solid-0.1 websocket at ${wsPath}, watching ${podsRoot}`);
  return {
    deactivate() {
      watcher.close();
      for (const socket of subscriptions.keys()) {
        try { socket.close(); } catch { /* already gone */ }
      }
    },
  };
}
