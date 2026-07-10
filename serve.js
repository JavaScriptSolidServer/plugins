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
  plugins: [
    { module: at('relay/plugin.js'), prefix: '/relay' },
    { module: at('webrtc/plugin.js'), prefix: '/webrtc' },
    { module: at('terminal/plugin.js'), prefix: '/.terminal', config: { token: terminalToken } },
    { module: at('tunnel/plugin.js'), prefix: '/tunnel' },
    {
      module: at('notifications/plugin.js'),
      prefix: '/.notifications',
      config: { podsRoot: PODS, baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` },
    },
    { module: at('pay/plugin.js'), prefix: '/paid', config: { cost: 1, address: 'demo' } },
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
console.log(`  terminal:       ws  ${PUBLIC_URL}/.terminal?token=${terminalToken}`);
console.log(`  tunnel:         ws  ${PUBLIC_URL}/tunnel`);
console.log(`  notifications:  ws  ${PUBLIC_URL}/.notifications`);
console.log(`  paid demo:      GET ${PUBLIC_URL}/paid/demo`);
