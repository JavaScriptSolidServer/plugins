// Demo composition: ONE JavaScript Solid Server (from npm) running pods,
// an IdP, and every plugin in this repo — from pure config.
//
//   node serve.js                # http://localhost:3240
//   PORT=3240 TERMINAL_TOKEN=... PUBLIC_URL=https://... node serve.js
//
// The terminal plugin refuses to boot without access control; a token is
// generated per run unless TERMINAL_TOKEN is set (printed at startup).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'javascript-solid-server/src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const at = (p) => path.join(__dirname, p);

const PORT = Number(process.env.PORT || 3240);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA = process.env.DATA || path.join(__dirname, 'data');
const PODS = path.join(DATA, 'pods');
fs.mkdirSync(PODS, { recursive: true });

const terminalToken = process.env.TERMINAL_TOKEN || crypto.randomBytes(16).toString('hex');

const fastify = createServer({
  root: PODS,
  idp: true,
  idpIssuer: PUBLIC_URL,
  // mastodon (/api,/oauth) and bluesky (/xrpc) own fixed roots outside
  // their prefix; a plugin can't self-exempt them from WAC, so the
  // operator widens appPaths.
  appPaths: ['/api', '/oauth', '/xrpc'],
  // Explicit ids — the <name>/plugin.js convention collides on basename.
  plugins: [
    { id: 'relay', module: at('relay/plugin.js'), prefix: '/relay' },
    { id: 'webrtc', module: at('webrtc/plugin.js'), prefix: '/webrtc' },
    { id: 'terminal', module: at('terminal/plugin.js'), prefix: '/terminal', config: { token: terminalToken } },
    { id: 'tunnel', module: at('tunnel/plugin.js'), prefix: '/tunnel' },
    {
      id: 'notifications',
      module: at('notifications/plugin.js'),
      prefix: '/.notifications',
      config: { podsRoot: PODS, baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` },
    },
    { id: 'pay', module: at('pay/plugin.js'), prefix: '/paid', config: { cost: 1, address: 'demo' } },
    { id: 'nip05', module: at('nip05/plugin.js'), prefix: '/nip05', config: { podsRoot: PODS, relayUrl: `${PUBLIC_URL.replace(/^http/, 'ws')}/relay` } },
    { id: 'corsproxy', module: at('corsproxy/plugin.js'), prefix: '/proxy', config: {} },
    { id: 'capability', module: at('capability/plugin.js'), prefix: '/cap', config: {} },
    { id: 'webdav', module: at('webdav/plugin.js'), prefix: '/webdav', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'gitscratch', module: at('gitscratch/plugin.js'), prefix: '/git', config: {} },
    { id: 'sparql', module: at('sparql/plugin.js'), prefix: '/sparql', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'otp', module: at('otp/plugin.js'), prefix: '/otp', config: {} },
    { id: 'carddav', module: at('carddav/plugin.js'), prefix: '/carddav', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'mastodon', module: at('mastodon/plugin.js'), prefix: '/mastodon', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'bluesky', module: at('bluesky/plugin.js'), prefix: '/bluesky', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
  ],
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await fastify.close().catch(() => {});
    process.exit(0);
  });
}

await fastify.listen({ port: PORT, host: '0.0.0.0' });
console.log(`jss + every plugin up at ${PUBLIC_URL}`);
console.log(`  pods:           ${PUBLIC_URL}/idp/register`);
console.log(`  relay:          ws  ${PUBLIC_URL}/relay`);
console.log(`  webrtc:         ws  ${PUBLIC_URL}/webrtc`);
console.log(`  terminal:       ws  ${PUBLIC_URL}/terminal?token=${terminalToken}`);
console.log(`  tunnel:         ws  ${PUBLIC_URL}/tunnel`);
console.log(`  notifications:  ws  ${PUBLIC_URL}/.notifications`);
console.log(`  paid demo:      GET ${PUBLIC_URL}/paid/demo`);
console.log(`  nip05:          GET ${PUBLIC_URL}/.well-known/nostr.json`);
console.log(`  cors-proxy:     GET ${PUBLIC_URL}/proxy?url=<url>`);
console.log(`  capability:     POST ${PUBLIC_URL}/cap/issue  (auth)`);
console.log(`  webdav:         ${PUBLIC_URL}/webdav/  (mount with a pod Bearer)`);
console.log(`  git scratch:    git clone ${PUBLIC_URL}/git/<name>.git`);
console.log(`  sparql:         POST ${PUBLIC_URL}/sparql  (auth)`);
console.log(`  otp:            POST ${PUBLIC_URL}/otp/request`);
console.log(`  carddav:        ${PUBLIC_URL}/carddav/  (contact sync)`);
console.log(`  mastodon:       GET ${PUBLIC_URL}/api/v1/instance  (point a client here)`);
console.log(`  bluesky:        GET ${PUBLIC_URL}/xrpc/com.atproto.server.describeServer`);
