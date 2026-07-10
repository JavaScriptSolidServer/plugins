// Shared test harness: boot a real JavaScript Solid Server from npm with a
// set of plugin entries, on a probed port, against a throwaway data root.
//
// createServer is the documented composition entry (docs/configuration.md);
// the no-internals rule is about *plugins*, not the host the tests boot.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'javascript-solid-server/src/server.js';

export function probePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @param {object} opts               extra createServer options (idp, …)
 * @param {Array}  opts.plugins       plugin entries under test
 * @returns {{ base, wsBase, root, fastify, close }}
 */
export async function startJss({ plugins, ...opts } = {}) {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jss-plugins-test-'));
  delete opts.root;
  // A fixed port lets configs reference the server's own origin (some
  // plugins need it — see notifications; finding: api.serverInfo).
  const port = opts.port ?? await probePort();
  delete opts.port;
  const fastify = createServer({
    logger: false,
    forceCloseConnections: true,
    root,
    ...(opts.idp ? { idpIssuer: `http://127.0.0.1:${port}` } : {}),
    plugins,
    ...opts,
  });
  await fastify.listen({ port, host: '127.0.0.1' });
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    root,
    fastify,
    async close({ keepData = false } = {}) {
      await fastify.close();
      if (!keepData) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Collect messages from a ws until predicate or timeout. */
export function wsCollect(socket, isDone, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => reject(new Error(`ws timeout; got ${JSON.stringify(msgs)}`)), timeoutMs);
    socket.on('message', (data) => {
      msgs.push(JSON.parse(String(data)));
      if (isDone(msgs)) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
