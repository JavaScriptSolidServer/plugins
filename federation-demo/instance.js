// Child-process entry: boot ONE federated JSS instance — webfinger (actor
// discovery) + activitypub (the actor itself) — on a probed loopback port
// against a throwaway data root, then print `READY {json}` and stay alive
// until stdin closes (or SIGTERM/SIGINT).
//
// WHY A CHILD PROCESS AT ALL — the two-instance finding:
// JSS keeps the storage root in process-global state. createServer writes
// `process.env.DATA_ROOT` (src/server.js:203) and the IdP + storage layers
// re-read it lazily per request (src/idp/accounts.js getAccountsDir,
// src/idp/keys.js, src/utils/url.js getDataRoot, src/handlers/pay.js, …).
// So two LIVE createServer instances in one process both serve whichever
// root booted LAST: server A's account lookups, WAC checks and pod reads
// would silently hit server B's data root. This is the same module-global
// DATA_ROOT footgun AGENT.md documents for *sequential* boots, but for
// CONCURRENT servers there is no ordering trick that saves you — a real
// two-server federation on one machine needs two processes. Hence this
// bootstrap: the driver (test.js / demo.js) spawns one of these per server.
//
// Config comes as JSON in argv[2]:
//   { name?: string, allowPrivateDelivery?: boolean }
//
// allowPrivateDelivery is the activitypub plugin's DOCUMENTED opt-in for
// private-network/test deployments. Its SSRF gate refuses loopback/private
// delivery targets BY DEFAULT (and must keep doing so — three security
// regression tests in activitypub/test.js protect that default). A demo
// where both "servers" are 127.0.0.1 is exactly the deployment the opt-in
// exists for; the driver sets it on server A only, so server B still
// demonstrates the production default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const cfg = JSON.parse(process.argv[2] || '{}');

const port = await probePort();
const base = `http://127.0.0.1:${port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), `jss-fed-${cfg.name || 'node'}-`));

const jss = await startJss({
  port,
  root,
  idp: true, // /idp/register + /idp/credentials → the owner Bearer
  plugins: [
    {
      id: 'webfinger',
      module: path.join(__dirname, '..', 'webfinger', 'plugin.js'),
      prefix: '/webfinger',
      // podsRoot: the plugin api cannot learn the data root itself
      // (webfinger README finding), so it is handed the same root.
      // actorPathTemplate points the JRD's rel=self link at the
      // activitypub plugin's actor layout under its reserved /ap root.
      config: { podsRoot: root, actorPathTemplate: '/ap/<user>/actor' },
    },
    {
      id: 'activitypub',
      module: path.join(__dirname, '..', 'activitypub', 'plugin.js'),
      // No appPaths needed: the plugin claims + WAC-exempts /ap itself via
      // api.reservePath (#602, JSS ≥ 0.0.219). baseUrl is still hand-fed
      // (the plugin predates api.serverInfo and requires it in config).
      config: {
        baseUrl: base,
        ...(cfg.allowPrivateDelivery ? { allowPrivateDelivery: true } : {}),
      },
    },
  ],
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // keepData: the parent owns cleanup (it may still want the state files).
  try { await jss.close({ keepData: true }); } catch { /* already down */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.resume();
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);

console.log(`READY ${JSON.stringify({ base, port, root })}`);
