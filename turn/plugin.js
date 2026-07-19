// TURN REST credentials (draft-uberti-behave-turn-rest-00) as a #206 loader
// plugin — the JSS half of a coturn deployment. coturn relays media; this
// endpoint mints the time-limited credentials browsers use to reach it, so
// no static TURN password ever ships in a public page (a leaked credential
// expires by itself).
//
//   plugins: [{ module: 'turn/plugin.js', prefix: '/.turn',
//               config: { uris: ['turn:pod.example:3478?transport=udp',
//                                'turns:pod.example:5349'],
//                         ttl: 3600 } }]
//
// Serves `GET <prefix>/credentials[?user=<tag>]` →
//   { username, password, ttl, uris,               // the draft's shape
//     iceServers: [{ urls, username, credential }] // drop-in for RTCPeerConnection
//   }
// where username = "<unix-expiry>[:<tag>]" and
// password = base64(HMAC-SHA1(secret, username)) — exactly what coturn
// verifies under `use-auth-secret` / `static-auth-secret`.
//
// The secret comes from config.secret, or the environment variable named by
// config.secretEnv (default TURN_STATIC_AUTH_SECRET) — the env path exists
// because a CLI `--plugin module@prefix` entry carries no config object.
// `uris` may likewise come from a comma-separated TURN_URIS. Activation
// fails loudly when either is missing: a server that would mint credentials
// nobody can use (or sign them with '') must not boot quietly.
//
// Minting is anonymous by default — the point of expiry is that handing
// creds to any visitor is survivable, and the mesh pages that need them run
// without accounts. Set config.requireAuth to gate on api.auth.getAgent
// (401 for anonymous) when the relay should serve only known agents.

import crypto from 'node:crypto';

const DEFAULT_TTL = 3600; // seconds; short — clients re-mint per session
const USER_TAG = /^[A-Za-z0-9._-]{1,64}$/;

export async function activate(api) {
  const cfg = api.config || {};
  const secret = cfg.secret
    || process.env[cfg.secretEnv || 'TURN_STATIC_AUTH_SECRET']
    || '';
  if (!secret) {
    throw new Error('turn plugin: no secret — set config.secret or the '
      + `${cfg.secretEnv || 'TURN_STATIC_AUTH_SECRET'} environment variable`);
  }
  const uris = (Array.isArray(cfg.uris) && cfg.uris.length ? cfg.uris
    : String(process.env.TURN_URIS || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!uris.length) {
    throw new Error('turn plugin: no TURN uris — set config.uris or TURN_URIS');
  }
  const ttl = Number.isInteger(cfg.ttl) && cfg.ttl > 0 ? cfg.ttl : DEFAULT_TTL;
  const requireAuth = !!cfg.requireAuth;

  api.fastify.get(`${api.prefix}/credentials`, async (request, reply) => {
    if (requireAuth) {
      const agent = await api.auth.getAgent(request);
      if (!agent) return reply.code(401).send({ error: 'Unauthorized' });
    }
    const tag = request.query?.user;
    if (tag !== undefined && !USER_TAG.test(String(tag))) {
      return reply.code(400).send({ error: 'BadRequest', message: 'user must match [A-Za-z0-9._-]{1,64}' });
    }
    const username = `${Math.floor(Date.now() / 1000) + ttl}${tag ? ':' + tag : ''}`;
    const password = crypto.createHmac('sha1', secret).update(username).digest('base64');
    reply.header('cache-control', 'no-store'); // every response is a fresh, expiring grant
    return {
      username, password, ttl, uris,
      iceServers: [{ urls: uris, username, credential: password }],
    };
  });

  api.log.info(`turn: minting ${ttl}s credentials at ${api.prefix}/credentials for ${uris.length} uri(s)`);
}
