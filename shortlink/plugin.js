// shortlink — a link shortener for pod resources, as a #206 loader plugin.
//
//   plugins: [{ module: 'shortlink/plugin.js', prefix: '/s',
//               config: { baseUrl: 'https://pod.example' } }]
//
// Turn long pod URLs into short redirect links:
//
//   POST   {prefix}          authed (api.auth.getAgent) — { url, slug? } →
//                            201 { short, slug, url, created }. Re-posting
//                            the same url+slug as the same agent → 200
//                            (idempotent). A slug held by anyone else → 409.
//   GET    {prefix}          authed — list the caller's OWN links.
//   GET    {prefix}/<slug>   → 302 Location: <target>, Cache-Control:
//                            no-store (so deletion actually takes effect).
//                            ?preview=1 → JSON of the record instead of the
//                            redirect (see where you're going before you go).
//   DELETE {prefix}/<slug>   creator only → 204; anyone else → 403.
//
// NOT AN OPEN REDIRECTOR (deliberate): the target must live under
// config.baseUrl — this shortens POD resources, nothing else. An
// unauthenticated 302 to arbitrary URLs is phishing infrastructure (the
// short host's reputation launders the destination), so external targets
// are refused with 400. Corollary: because every target is local, the
// redirect can never leak a Referer to a third party, and redirecting to a
// WAC-protected resource is safe — the 302 grants nothing; the pod still
// runs its own auth when the client arrives. Route ownership ≠ authority.
//
// Locality is checked by PARSED origin comparison, not string prefixing:
// `url.startsWith(baseUrl)` would accept http://pod.example.evil.test when
// baseUrl is http://pod.example — a classic open-redirect-filter bypass.
//
// Persistence (the pluginDir pattern, after otp/'s JSON table): one file,
// pluginDir()/links.json, slug → { url, agent, created, hits }. Creates and
// deletes are written synchronously (durable); hit counts are incremented
// in memory and flushed fire-and-forget on a serialized async chain — a
// crash can lose recent HIT COUNTS but never a LINK. See README findings
// for the durability tradeoff and the pluginDir-vs-pod-resource discussion.
//
// Slugs: custom slugs are lowercased and must match [a-z0-9-]{1,64}.
// Minted slugs are 7 chars of base62 from node:crypto randomBytes (~62^7 ≈
// 3.5e12 — collision retried, practically never hit). Lookup is exact-match
// (minted slugs are case-sensitive). The slug routes are wildcard routes
// (`{prefix}/*`), following capability/'s maxParamLength finding: a named
// `:slug` param 404s anything over 100 chars at the router, and a plugin
// cannot raise Fastify server options — with the wildcard, arbitrary junk
// gets this plugin's own clean JSON 404.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const MAX_URL_LENGTH = 2048;

/** 7 chars of base62 from randomBytes. (Mod-62 bias is ~3% toward the
 *  first 8 chars — irrelevant for uniqueness, which is all a slug needs.) */
export function randomSlug(len = 7) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += B62[b % 62];
  return s;
}

// ------------------------------------------------------- durable write
// Atomic persist: write to a uniquely-named temp file in the SAME directory
// (rename is only atomic within one filesystem), then rename it over the
// target. A crash mid-write truncates the throwaway temp, never the live
// links table — so a truncated table can no longer silently reset to {} at
// boot and lose every link. The random suffix avoids concurrent-writer temp
// collisions; a failed rename unlinks the temp so no partial file and no
// stale `.tmp` are left behind. Both the sync (create/delete) and async
// (hit-count flush) writers go through this — a crashed hit-count flush must
// not truncate the table either. (This does NOT address the read-modify-
// write TOCTOU between concurrent persisters — a separate, larger concern.)
function atomicWriteSync(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

async function atomicWriteAsync(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export async function activate(api) {
  const prefix = api.prefix || '/shortlink';
  const cfg = api.config || {};

  if (!cfg.baseUrl || typeof cfg.baseUrl !== 'string') {
    throw new Error(
      'shortlink plugin requires config.baseUrl — used to validate that targets are '
      + 'local pod resources and to mint absolute short URLs '
      + '(no api.serverInfo: a plugin cannot learn its own origin)',
    );
  }
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error(`shortlink: config.baseUrl is not a valid URL: ${cfg.baseUrl}`); }
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;

  /**
   * A target is acceptable iff it parses and lives under baseUrl — parsed
   * origin equality (never string startsWith; see header comment).
   * @returns {string|null} the normalized href, or null
   */
  function localTarget(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LENGTH) return null;
    let target;
    try { target = new URL(raw); } catch { return null; }
    if (target.origin !== base.origin) return null;
    if (target.pathname !== base.pathname && !target.pathname.startsWith(basePath)) return null;
    return target.href;
  }

  // ------------------------------------------------------- persistence
  // links.json: slug -> { url, agent, created, hits }
  const dir = api.storage.pluginDir();
  const tableFile = path.join(dir, 'links.json');
  const loadJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const links = new Map(Object.entries(loadJson(tableFile)));

  const persist = () => atomicWriteSync(tableFile, JSON.stringify(Object.fromEntries(links)));

  // Fire-and-forget flush for hit counts: serialized on a promise chain so
  // concurrent redirects never interleave writes to the same file. A crash
  // between the 302 and the flush loses recent counts — an accepted
  // tradeoff (counts are advisory; the redirect must not wait on fsync).
  let pending = Promise.resolve();
  const persistLazy = () => {
    pending = pending
      .then(() => atomicWriteAsync(tableFile, JSON.stringify(Object.fromEntries(links))))
      .catch((err) => api.log.warn(`shortlink: hit-count flush failed: ${err.message}`));
  };

  const recordOut = (slug, entry) => ({
    short: `${baseUrl}${prefix}/${slug}`,
    slug,
    url: entry.url,
    created: entry.created,
  });

  // ------------------------------------------------------------ routes
  // POST {prefix} — mint a short link. Only a signed-in agent may mint:
  // anonymous minting on a public host is abuse-bait even with local-only
  // targets (slug squatting, enumeration noise).
  api.fastify.post(prefix, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    if (!agent) return reply.code(401).send({ error: 'authentication required to create short links' });

    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const url = localTarget(body.url);
    if (!url) {
      return reply.code(400).send({
        error: `url must be a resource under ${baseUrl} — this shortens pod resources, not an open redirector`,
      });
    }

    let slug;
    if (body.slug !== undefined) {
      slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
      if (!SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: 'slug must be 1-64 chars of [a-z0-9-] (after lowercasing)' });
      }
      const existing = links.get(slug);
      if (existing) {
        if (existing.agent === agent && existing.url === url) {
          // Idempotent: the same agent re-posting the same mapping gets the
          // existing record back, 200 not 201, nothing rewritten.
          return reply.code(200).send(recordOut(slug, existing));
        }
        return reply.code(409).send({ error: `slug '${slug}' is already taken` });
      }
    } else {
      slug = randomSlug();
      for (let i = 0; links.has(slug) && i < 8; i++) slug = randomSlug();
      if (links.has(slug)) return reply.code(500).send({ error: 'could not mint a unique slug' }); // unreachable in practice
    }

    const entry = { url, agent, created: new Date().toISOString(), hits: 0 };
    links.set(slug, entry);
    persist();
    api.log.info(`shortlink: ${agent} minted ${prefix}/${slug} -> ${url}`);
    return reply
      .code(201)
      .header('location', `${baseUrl}${prefix}/${slug}`)
      .send(recordOut(slug, entry));
  });

  // GET {prefix} — the caller's own links (authed). Exact route; coexists
  // with the wildcard below (Fastify prefers the more specific match).
  api.fastify.get(prefix, async (request, reply) => {
    const agent = await api.auth.getAgent(request);
    if (!agent) return reply.code(401).send({ error: 'authentication required to list your links' });
    const mine = [...links.entries()]
      .filter(([, e]) => e.agent === agent)
      .sort(([, a], [, b]) => a.created.localeCompare(b.created))
      .map(([slug, e]) => ({ ...recordOut(slug, e), hits: e.hits }));
    return reply.send({ links: mine });
  });

  /** Wildcard param → slug, or null for anything that isn't one path segment. */
  const slugOf = (request) => {
    const raw = request.params['*'] || '';
    return raw && !raw.includes('/') ? raw : null;
  };

  // GET {prefix}/<slug> — the redirect (or ?preview=1 → the record). No
  // auth: a short link is a public name for a resource whose OWN access
  // control still applies on arrival. Cache-Control: no-store on every
  // response so a deleted link stops resolving everywhere, immediately —
  // a cached 302 would outlive the deletion.
  api.fastify.get(`${prefix}/*`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const slug = slugOf(request);
    const entry = slug ? links.get(slug) : undefined;
    if (!entry) return reply.code(404).send({ error: 'no such short link' });

    if (request.query && request.query.preview) {
      // Safety affordance: see the destination without being sent there.
      // Previews don't count as hits.
      return reply.send({ ...recordOut(slug, entry), agent: entry.agent, hits: entry.hits });
    }

    entry.hits += 1;
    persistLazy(); // fire-and-forget — never block the redirect on disk
    return reply.code(302).header('location', entry.url).send();
  });

  // DELETE {prefix}/<slug> — creator only.
  api.fastify.delete(`${prefix}/*`, async (request, reply) => {
    const slug = slugOf(request);
    const entry = slug ? links.get(slug) : undefined;
    if (!entry) return reply.code(404).send({ error: 'no such short link' });

    const agent = await api.auth.getAgent(request);
    if (!agent) return reply.code(401).send({ error: 'authentication required to delete a short link' });
    if (agent !== entry.agent) return reply.code(403).send({ error: 'only the creator may delete a short link' });

    links.delete(slug);
    persist();
    api.log.info(`shortlink: ${agent} deleted ${prefix}/${slug}`);
    return reply.code(204).send();
  });

  api.log.info(
    `shortlink: mint at POST ${prefix}, redirect at ${prefix}/<slug> (?preview=1 for the record), `
    + `local targets under ${baseUrl} only (${links.size} link(s) loaded)`,
  );
  return {
    async deactivate() {
      await pending; // let any in-flight hit flush land…
      persist(); // …then write the final state synchronously
    },
  };
}

export default activate;
