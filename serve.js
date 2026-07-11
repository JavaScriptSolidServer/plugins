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
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'javascript-solid-server/src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const at = (p) => path.join(__dirname, p);

// Is `port` bindable on 0.0.0.0 right now? (A quick listen-then-close probe.)
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

// An OS-assigned free port (bind to 0, read it back, release).
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Prefer the requested port; if it's busy, hop to a free one and say so.
// (The plugin configs bake the origin in before listen, so the port has to
// be settled up front — a retry-on-EADDRINUSE loop around listen() can't fix
// the loopback/baseUrl already handed to every plugin.)
async function pickPort(preferred) {
  if (await portFree(preferred)) return preferred;
  const hopped = await freePort();
  console.warn(`port ${preferred} is in use — hopping to ${hopped} (set PORT= to pin one)`);
  return hopped;
}

const PORT = await pickPort(Number(process.env.PORT || 3240));
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA = process.env.DATA || path.join(__dirname, 'data');
const PODS = path.join(DATA, 'pods');
fs.mkdirSync(PODS, { recursive: true });

const terminalToken = process.env.TERMINAL_TOKEN || crypto.randomBytes(16).toString('hex');

// One hand-copied inventory feeding both the admin home and the dashboard —
// a plugin can't enumerate its co-loaded siblings (the #463/#464 app-registry
// finding), so this duplicate of the plugins array below can silently drift.
const INVENTORY = [
  { id: 'relay', prefix: '/relay', description: 'nostr relay (ws)', probe: '/relay', kind: 'ws' },
  { id: 'webrtc', prefix: '/webrtc', description: 'WebRTC signaling (ws)', probe: '/webrtc', kind: 'ws' },
  { id: 'terminal', prefix: '/terminal', description: 'token-gated shell (ws)', probe: '/terminal', kind: 'ws' },
  { id: 'tunnel', prefix: '/tunnel', description: 'HTTP tunnel (ws)', probe: '/tunnel', kind: 'ws' },
  { id: 'notifications', prefix: '/.notifications', description: 'solid-0.1 notifications (ws)', probe: '/.notifications', kind: 'ws' },
  { id: 'pay', prefix: '/paid', description: '402 pay gate demo', probe: '/paid/demo', expect: [402] },
  { id: 'nip05', prefix: '/nip05', description: 'NIP-05 discovery', probe: '/nip05/nostr.json', expect: [200] },
  { id: 'corsproxy', prefix: '/proxy', description: 'CORS forward proxy', probe: '/proxy', expect: [400] },
  { id: 'capability', prefix: '/cap', description: 'capability URLs', probe: '/cap/issue', expect: [404, 401, 405] },
  { id: 'webdav', prefix: '/webdav', description: 'WebDAV bridge', probe: '/webdav/', expect: [401, 207, 200] },
  { id: 'gitscratch', prefix: '/git', description: 'Solid-authed git remotes', probe: '/git/probe.git/info/refs?service=git-receive-pack', expect: [401] },
  { id: 'sparql', prefix: '/sparql', description: 'SPARQL SELECT + UPDATE', probe: '/sparql', expect: [400, 404, 405] },
  { id: 'otp', prefix: '/otp', description: 'one-time-password sessions', probe: '/otp/whoami', expect: [401] },
  { id: 'carddav', prefix: '/carddav', description: 'CardDAV contacts', probe: '/carddav/', expect: [401, 207, 200] },
  { id: 'mastodon', prefix: '/mastodon', description: 'Mastodon API shim', probe: '/api/v1/instance', expect: [200] },
  { id: 'bluesky', prefix: '/bluesky', description: 'AT-Proto XRPC shim', probe: '/xrpc/com.atproto.server.describeServer', expect: [200] },
  { id: 'caldav', prefix: '/caldav', description: 'CalDAV calendars + free-busy', probe: '/caldav/', expect: [401, 207, 200] },
  { id: 'webfinger', prefix: '/webfinger', description: 'WebFinger discovery', probe: '/.well-known/webfinger', expect: [400] },
  { id: 'activitypub', prefix: '/activitypub', description: 'AS2 federation actor', probe: '/ap/alice/actor', expect: [200, 404] },
  { id: 'rss', prefix: '/feed', description: 'container → Atom/RSS', probe: '/feed/atom', expect: [400] },
  { id: 'matrix', prefix: '/matrix', description: 'Matrix client-server shim', probe: '/_matrix/client/versions', expect: [200] },
  { id: 'search', prefix: '/search', description: 'full-text pod search', probe: '/search', expect: [400] },
  { id: 'didweb', prefix: '/didweb', description: 'did:web resolver', probe: '/didweb/nobody/did.json', expect: [404] },
  { id: 's3', prefix: '/s3', description: 'S3 gateway (SigV4)', probe: '/s3/bucket/key', expect: [403] },
  { id: 'micropub', prefix: '/micropub', description: 'IndieWeb Micropub', probe: '/micropub?q=config', expect: [200] },
  { id: 'backup', prefix: '/backup', description: 'pod → tar.gz export', probe: '/backup', expect: [400] },
  { id: 'shortlink', prefix: '/short', description: 'pod link shortener', probe: '/short', expect: [401] },
  { id: 'oembed', prefix: '/oembed', description: 'oEmbed provider', probe: '/oembed', expect: [400] },
  { id: 'jmap', prefix: '/jmap', description: 'JMAP mail over the pod', probe: '/jmap/session', expect: [401] },
  { id: 'remotestorage', prefix: '/remotestorage', description: 'remoteStorage server', probe: '/remotestorage/webfinger', expect: [400] },
  { id: 'metrics', prefix: '/metrics', description: 'healthz + Prometheus', probe: '/metrics/healthz', expect: [200] },
  { id: 'dashboard', prefix: '/dashboard', description: 'plugin liveness page', probe: '/dashboard/status.json', expect: [200] },
  { id: 'admin', prefix: '/admin', description: 'operator home (this page)' },
];

const fastify = createServer({
  root: PODS,
  idp: true,
  idpIssuer: PUBLIC_URL,
  // The protocol shims own fixed roots outside their prefix — mastodon
  // (/api,/oauth), bluesky (/xrpc), activitypub (/ap), matrix (/_matrix) —
  // which a plugin can't self-exempt from WAC, so the operator widens
  // appPaths.
  appPaths: ['/api', '/oauth', '/xrpc', '/ap', '/_matrix'],
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
    { id: 'caldav', module: at('caldav/plugin.js'), prefix: '/caldav', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'webfinger', module: at('webfinger/plugin.js'), prefix: '/webfinger', config: { podsRoot: PODS, baseUrl: PUBLIC_URL } },
    { id: 'activitypub', module: at('activitypub/plugin.js'), prefix: '/activitypub', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'rss', module: at('rss/plugin.js'), prefix: '/feed', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'matrix', module: at('matrix/plugin.js'), prefix: '/matrix', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'search', module: at('search/plugin.js'), prefix: '/search', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'didweb', module: at('didweb/plugin.js'), prefix: '/didweb', config: { podsRoot: PODS, baseUrl: PUBLIC_URL } },
    { id: 's3', module: at('s3/plugin.js'), prefix: '/s3', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'micropub', module: at('micropub/plugin.js'), prefix: '/micropub', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'backup', module: at('backup/plugin.js'), prefix: '/backup', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'shortlink', module: at('shortlink/plugin.js'), prefix: '/short', config: { baseUrl: PUBLIC_URL } },
    { id: 'oembed', module: at('oembed/plugin.js'), prefix: '/oembed', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    { id: 'jmap', module: at('jmap/plugin.js'), prefix: '/jmap', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}` } },
    // webfinger/ above owns /.well-known/webfinger — the witnessed collision
    // (remotestorage/README.md) — so remotestorage stands down here.
    { id: 'remotestorage', module: at('remotestorage/plugin.js'), prefix: '/remotestorage', config: { baseUrl: PUBLIC_URL, loopbackUrl: `http://127.0.0.1:${PORT}`, claimWellKnown: false } },
    { id: 'metrics', module: at('metrics/plugin.js'), prefix: '/metrics', config: { loopbackUrl: `http://127.0.0.1:${PORT}`, ...(process.env.METRICS_TOKEN ? { token: process.env.METRICS_TOKEN } : {}) } },
    {
      id: 'dashboard',
      module: at('dashboard/plugin.js'),
      prefix: '/dashboard',
      config: {
        loopbackUrl: `http://127.0.0.1:${PORT}`,
        // The shared INVENTORY minus itself (self-probes would recurse).
        plugins: INVENTORY.filter((p) => p.id !== 'dashboard' && p.probe),
      },
    },
    {
      id: 'admin',
      module: at('admin/plugin.js'),
      prefix: '/admin',
      config: {
        loopbackUrl: `http://127.0.0.1:${PORT}`,
        baseUrl: PUBLIC_URL,
        podsRoot: PODS,
        plugins: INVENTORY,
        // Gate the operator home: ADMIN_AGENTS is a comma-separated list of
        // WebIDs/agent ids. Without it the plugin serves OPEN and warns
        // loudly (finding: the api has no operator concept).
        ...(process.env.ADMIN_AGENTS
          ? { adminAgents: process.env.ADMIN_AGENTS.split(',').map((s) => s.trim()).filter(Boolean) }
          : {}),
      },
    },
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
console.log(`  caldav:         ${PUBLIC_URL}/caldav/  (calendar sync)`);
console.log(`  webfinger:      GET ${PUBLIC_URL}/.well-known/webfinger?resource=acct:me@host`);
console.log(`  activitypub:    GET ${PUBLIC_URL}/ap/<user>/actor`);
console.log(`  rss/atom:       GET ${PUBLIC_URL}/feed/atom?container=<pod-container>`);
console.log(`  matrix:         GET ${PUBLIC_URL}/_matrix/client/versions  (point Element here)`);
console.log(`  search:         GET ${PUBLIC_URL}/search?q=<terms>&container=<pod-container>`);
console.log(`  did:web:        GET ${PUBLIC_URL}/.well-known/did.json`);
console.log(`  s3:             ${PUBLIC_URL}/s3/<bucket>/<key>  (aws-cli/rclone, SigV4)`);
console.log(`  micropub:       POST ${PUBLIC_URL}/micropub  (IndieWeb clients; pod bearer as token)`);
console.log(`  backup:         GET ${PUBLIC_URL}/backup/<pod>/  → .tar.gz of what you can read`);
console.log(`  shortlink:      POST ${PUBLIC_URL}/short  (auth; local targets only)`);
console.log(`  oembed:         GET ${PUBLIC_URL}/oembed?url=<pod-resource-url>  (link unfurling)`);
console.log(`  jmap:           GET ${PUBLIC_URL}/jmap/session  (JMAP mail over the pod)`);
console.log(`  remotestorage:  ${PUBLIC_URL}/remotestorage/<user>/<category>/…  (rS clients)`);
console.log(`  metrics:        GET ${PUBLIC_URL}/metrics/healthz | /metrics/metrics  (Prometheus${process.env.METRICS_TOKEN ? ', token-guarded' : ''})`);
console.log(`  dashboard:      GET ${PUBLIC_URL}/dashboard/  (live plugin status)`);
console.log(`  admin:          GET ${PUBLIC_URL}/admin/  (operator home${process.env.ADMIN_AGENTS ? ', gated' : ' — OPEN, set ADMIN_AGENTS'})`);
