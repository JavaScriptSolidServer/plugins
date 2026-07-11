// WebFinger (RFC 7033, https://www.rfc-editor.org/rfc/rfc7033) as a #206
// loader plugin — the WebFinger half of JSS issue #164.
//
//   plugins: [{ module: 'webfinger/plugin.js', prefix: '/webfinger',
//               config: { podsRoot: './data',
//                         baseUrl: 'https://pod.example',
//                         actorPathTemplate: '/<user>/actor' } }]
//
// Serves `GET /.well-known/webfinger?resource=acct:<user>@<host>` → a JRD
// (JSON Resource Descriptor, RFC 7033 §4.4):
//
//   { "subject": "acct:alice@pod.example",
//     "aliases": [ "<webid>", "<profile-page>" ],
//     "links": [
//       { "rel": "http://webfinger.net/rel/profile-page", "href": "<profile>" },
//       { "rel": "self", "type": "application/activity+json", "href": "<actor>" },
//       { "rel": "http://openid.net/specs/connect/1.0/issuer", "href": "<idp>" }
//     ] }
//
// WebFinger is the acct: → resource resolver the whole fediverse (Mastodon,
// Pleroma, any ActivityPub client) uses to turn a handle like
// `@alice@pod.example` into that pod's actor URL — it is exactly what the
// mastodon/ and bluesky/ shims need pointed at their pods. It is ALSO how
// Solid-OIDC relying parties and remoteStorage clients discover a pod's
// issuer (the `http://openid.net/specs/connect/1.0/issuer` link) — hence
// #164 wants it extracted from `--activitypub` into an always-on plugin
// that many protocols hang links off.
//
// The pod is resolved from the acct: local part by scanning config.podsRoot
// for a matching pod dir (the same scan nip05/ does), or in single-user
// layout the one pod at the root. Unknown users get a 404 (RFC 7033 §4.5).
//
// ------------------------------------------------------------- the path
//
// Like nip05/, the interesting part is the path. `/.well-known/webfinger`
// is a fixed absolute path, and a plugin is mounted under ONE prefix. It
// works today by the identical chain of luck nip05 documents: the loader
// hands plugins the real (scoped) Fastify instance and does not confine
// routes to the prefix, so an exact-path GET registers fine and beats
// core's LDP `GET /*` wildcard on route specificity; and it is served
// unauthenticated only because core's auth preHandler blanket-exempts
// `/.well-known/*` as the spec-mandated public namespace — NOT because the
// plugin api granted anything. All load-bearing accidents of core's current
// routing (see README "Findings"), so the absolute registration is a
// guarded attempt and the same document is also served at the
// contract-safe `<prefix>/webfinger`.

import fs from 'node:fs/promises';
import path from 'node:path';

/** acct: local part / pod dir grammar (also blocks path traversal). */
const LOCAL_PART = /^[a-zA-Z0-9._-]+$/;

/** Collapse accidental `//` (from an empty <user> substitution) to `/`. */
const collapseSlashes = (p) => p.replace(/\/{2,}/g, '/');

/** Does `<dir>/profile/card.jsonld` exist? (a pod always has its WebID card) */
async function hasCard(dir) {
  try {
    await fs.access(path.join(dir, 'profile', 'card.jsonld'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the `resource` query into a pod local part.
 *   acct:alice@host          → { user: 'alice' }
 *   acct:host                → { user: 'host' }        (no @ — bare acct)
 *   https://host/alice/...   → { user: 'alice' }       (path-mode WebID URL)
 *   https://host/profile/... → { user: null }          (single-user WebID URL)
 * Returns null when the resource is syntactically unusable.
 */
export function parseResource(resource) {
  if (typeof resource !== 'string' || resource === '') return null;
  if (resource.startsWith('acct:')) {
    const acct = resource.slice('acct:'.length);
    const at = acct.lastIndexOf('@');
    const user = at >= 0 ? acct.slice(0, at) : acct;
    return user ? { user } : null;
  }
  // Otherwise treat it as a URI whose path locates the pod (the WebID form).
  let u;
  try {
    u = new URL(resource);
  } catch {
    return null;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  // Single-user layout: WebID lives at `<origin>/profile/card`.
  if (segs.length === 0 || segs[0] === 'profile') return { user: null };
  return { user: segs[0] };
}

export async function activate(api) {
  const prefix = api.prefix || '/webfinger';
  const podsRoot = api.config.podsRoot ?? null;
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  // `null`/`''` disables the `self` (ActivityPub actor) link — "IF
  // applicable" from the issue: a deployment without AP actors omits it.
  const actorPathTemplate = 'actorPathTemplate' in api.config
    ? api.config.actorPathTemplate
    : '/<user>/actor';

  if (!baseUrl) {
    // A JRD is nothing but absolute URLs of this server's own origin, and
    // the plugin api exposes no server origin (same finding as mastodon/,
    // notifications/, webdav/). Without it there is nothing truthful to
    // serve, so unlike nip05 (whose document carries no self-origin URLs)
    // this is a hard boot failure.
    throw new Error(
      'webfinger plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin, and every URL in a JRD (WebID, profile page, actor, '
      + 'issuer) is absolute against it (same finding as mastodon/notifications).',
    );
  }
  if (!podsRoot) {
    // Without a data root the plugin cannot resolve any user, so every
    // query 404s. Still activate (a purely additive discovery endpoint
    // shouldn't fail the whole boot), but say so loudly — see README
    // finding on podsRoot repetition.
    api.log.warn('webfinger: no config.podsRoot — every resource will 404 '
      + '(the plugin api cannot learn the data root itself)');
  }

  /**
   * Confirm the pod named by `user` exists (has a WebID card), scanning
   * fresh per request so pods provisioned after boot resolve immediately.
   * `user === null` means single-user layout (card at the podsRoot itself).
   */
  async function podExists(user) {
    if (!podsRoot) return false;
    if (user === null) return hasCard(podsRoot);
    if (!LOCAL_PART.test(user)) return false; // illegal / traversal attempt
    if (user.startsWith('.')) return false; // .idp, .plugins, .well-known…
    return hasCard(path.join(podsRoot, user));
  }

  /** Build the JRD for a resolved pod. `subject` echoes the query verbatim. */
  function buildJrd(user, subject) {
    const podPath = user ? `/${user}/` : '/';
    const webid = `${baseUrl}${podPath}profile/card#me`;
    const profilePage = `${baseUrl}${podPath}profile/card`;
    const links = [
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: profilePage,
      },
    ];
    if (actorPathTemplate) {
      const actorPath = collapseSlashes(actorPathTemplate.replaceAll('<user>', user ?? ''));
      links.push({
        rel: 'self',
        type: 'application/activity+json',
        href: `${baseUrl}${actorPath}`,
      });
    }
    // The IdP issuer link makes Solid-OIDC / remoteStorage discovery work
    // off the same document (the #164 point: WebFinger serves many protocols).
    links.push({
      rel: 'http://openid.net/specs/connect/1.0/issuer',
      href: baseUrl,
    });
    return { subject, aliases: [webid, profilePage], links };
  }

  async function handler(request, reply) {
    // Fediverse clients (browsers, bots) carry no credentials: CORS must be
    // wide open, which RFC 7033 §5 calls out explicitly.
    reply.header('access-control-allow-origin', '*');
    const resource = request.query?.resource;
    if (typeof resource !== 'string' || resource === '') {
      // RFC 7033 §4.2: `resource` is REQUIRED.
      return reply.code(400)
        .header('content-type', 'application/json; charset=utf-8')
        .send({ error: 'the "resource" query parameter is required' });
    }
    const parsed = parseResource(resource);
    if (!parsed || !(await podExists(parsed.user))) {
      // RFC 7033 §4.5: no such resource → 404.
      return reply.code(404)
        .header('content-type', 'application/json; charset=utf-8')
        .send({ error: 'no such resource' });
    }
    return reply
      .header('content-type', 'application/jrd+json; charset=utf-8')
      .send(buildJrd(parsed.user, resource));
  }

  // Contract-safe mount: under the plugin's own prefix (WAC-exempt via the
  // loader's appPaths push — the only exemption the plugin api grants).
  api.fastify.get(`${prefix}/webfinger`, handler);

  // Attempt the real WebFinger location. Works today for the same reasons
  // nip05/ documents (loader doesn't confine routes to the prefix; core's
  // GET there is only the LDP wildcard; core blanket-exempts /.well-known/*
  // from auth) — but nothing in the plugin CONTRACT promises any of it, so
  // treat a conflict (e.g. core someday claiming the GET route) as degraded,
  // not fatal: the prefix mount still serves.
  let wellKnown = false;
  try {
    api.fastify.get('/.well-known/webfinger', handler);
    wellKnown = true;
  } catch (err) {
    api.log.warn(`webfinger: could not claim /.well-known/webfinger (${err.message}); `
      + `serving under ${prefix}/webfinger only`);
  }

  api.log.info(`webfinger: serving ${prefix}/webfinger`
    + (wellKnown ? ' and /.well-known/webfinger' : '')
    + (podsRoot ? ` from ${podsRoot}` : ' (no podsRoot: every resource 404s)'));
}
