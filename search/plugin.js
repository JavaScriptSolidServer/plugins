// Full-text search over a pod's resources, as a #206 loader plugin.
//
//   plugins: [{ module: 'search/plugin.js', prefix: '/search',
//               config: { baseUrl: 'http://localhost:3000',
//                         defaultContainer: '/alice/', maxHits: 20 } }]
//
// A new feature built straight onto the plugin api:
//
//   GET /search?q=<terms>&container=/path/
//     → { query, hits: [{ url, title, snippet, score }] }
//
// The container subtree is walked over LOOPBACK HTTP carrying the CALLER'S
// OWN Authorization header — the pattern notifications/, sparql/, rss/ and
// webdav/ established. Each member is fetched, its text extracted (JSON-LD
// text-ish props, or a text/html/plain body with tags crudely stripped),
// tokenised, and ranked by TF-IDF over the query terms (AND semantics; a
// doc must contain every term). A snippet is cut around the first match. A
// private resource the caller cannot GET simply contributes nothing — WAC
// by construction, no authority of the plugin's own.
//
// Two index modes (both documented as findings in README.md):
//
//   1. READ-TIME (default): walk + scan per query. Correct, O(N) per query,
//      never stale. This is what works cleanly on the public api and what
//      the tests exercise deterministically.
//   2. CACHED INDEX (config.index: true): build an in-memory inverted index
//      (persisted under pluginDir), refreshed by an OPTIONAL fs.watch on
//      config.podsRoot plus a TTL. THIS IS THE FINDING: without
//      api.events.onResourceChange a plugin cannot see writes, so the cache
//      goes STALE (a write the watcher misses / a non-fs storage backend)
//      or WRONG (a shared cache holds text under one agent's authority and
//      would leak it to another). Mode 2 patches the leak with a per-hit
//      loopback HEAD recheck, but staleness is unfixable here — search is
//      the api.events seam's THIRD and sharpest consumer (after
//      notifications/ and sparql/): freshness is the one thing users most
//      expect of search, and it is exactly what a plugin cannot guarantee.

import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_HITS = 20;
const DEFAULT_MAX_RESOURCES = 200; // loopback fetches per crawl
const DEFAULT_MAX_DEPTH = 3; // container nesting below the scope container
const DEFAULT_SNIPPET_RADIUS = 80; // chars either side of the first match
const DEFAULT_REINDEX_MS = 60_000; // cached-index TTL
const MAX_QUERY_LENGTH = 2_000;

// -------------------------------------------------------------- tokenising

/** Lowercase, Unicode-aware alphanumeric tokens. */
function tokenize(s) {
  return (String(s ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu)) || [];
}

/**
 * Parse the ?q= string into query terms. Quoted runs are phrase terms
 * (matched as a normalised substring); bare words are single terms. All
 * terms must be present in a document (AND). Returns [] when nothing usable.
 */
function parseQuery(q) {
  const terms = [];
  const seen = new Set();
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    if (m[1] !== undefined) {
      const toks = tokenize(m[1]);
      if (!toks.length) continue;
      const text = toks.join(' ');
      const key = 'p:' + text;
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ type: 'phrase', text, tokens: toks });
    } else {
      for (const tok of tokenize(m[2])) {
        const key = 't:' + tok;
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push({ type: 'term', text: tok, tokens: [tok] });
      }
    }
  }
  return terms;
}

// -------------------------------------------------------- text extraction

const TITLE_KEYS = ['title', 'name', 'headline', 'label'];
const TEXT_KEYS = [
  'title', 'name', 'headline', 'label', 'content', 'articlebody', 'text',
  'description', 'body', 'summary', 'abstract',
];

/** Local name of a JSON-LD key: strip up to the last # / or :. */
function localName(key) {
  const m = /[^#/:]*$/.exec(key);
  return (m ? m[0] : key).toLowerCase();
}

/** Decoded filename without its extension, for a fallback title. */
function filenameTitle(p) {
  const base = p.slice(p.lastIndexOf('/') + 1);
  let name = base;
  try { name = decodeURIComponent(base); } catch { /* keep raw */ }
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name) || base;
}

/** Every object node worth reading props off (the doc, its @graph, arrays). */
function collectNodes(doc) {
  const nodes = [];
  const push = (n) => { if (n && typeof n === 'object' && !Array.isArray(n)) nodes.push(n); };
  for (const top of Array.isArray(doc) ? doc : [doc]) {
    push(top);
    if (top && Array.isArray(top['@graph'])) for (const g of top['@graph']) push(g);
  }
  return nodes;
}

/** Flatten a JSON-LD value (array / @value / @id / scalar) to strings. */
function unwrapAll(v, out) {
  if (v == null) return;
  if (Array.isArray(v)) { for (const item of v) unwrapAll(item, out); return; }
  if (typeof v === 'object') {
    if ('@value' in v) { if (v['@value'] != null) out.push(String(v['@value'])); return; }
    // nested named objects: recurse into their text-ish props too
    for (const [k, raw] of Object.entries(v)) {
      if (k.startsWith('@')) continue;
      if (TEXT_KEYS.includes(localName(k))) unwrapAll(raw, out);
    }
    return;
  }
  out.push(String(v));
}

/** Pull title + concatenated searchable text out of a parsed JSON-LD doc. */
function extractJsonText(doc) {
  const nodes = collectNodes(doc);
  let title = null;
  const parts = [];
  for (const node of nodes) {
    for (const [key, raw] of Object.entries(node)) {
      if (key.startsWith('@')) continue;
      const ln = localName(key);
      if (!TEXT_KEYS.includes(ln)) continue;
      const vals = [];
      unwrapAll(raw, vals);
      if (!vals.length) continue;
      if (!title && TITLE_KEYS.includes(ln)) title = vals[0];
      parts.push(...vals);
    }
  }
  return { title, text: parts.join('\n') };
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

/** Crude tag strip: drop script/style, remove tags, decode a few entities. */
function stripHtml(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => (e in HTML_ENTITIES ? HTML_ENTITIES[e] : m))
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtml(m[1]).trim() : null;
}

/**
 * Map one fetched member (url, path, content-type, body) to a document
 * { url, path, title, text }, or null when there is nothing to search.
 */
function extractDoc(url, resourcePath, contentType, body) {
  const ct = (contentType || '').toLowerCase();
  let title = null;
  let text = '';
  if (ct.includes('json')) {
    let doc = null;
    try { doc = JSON.parse(body); } catch { /* not JSON after all */ }
    if (doc && typeof doc === 'object') {
      const ex = extractJsonText(doc);
      title = ex.title;
      text = ex.text;
    }
  } else if (ct.includes('html')) {
    title = htmlTitle(body);
    text = stripHtml(body);
  } else {
    // text/plain, markdown, xml, … : the body IS the text.
    text = body;
  }
  return { url, path: resourcePath, title: title || filenameTitle(resourcePath), text };
}

// --------------------------------------------------------------- ranking

/** Precompute per-document structures the ranker needs. */
function indexDoc(doc) {
  const tokens = tokenize(doc.text);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return {
    url: doc.url,
    path: doc.path,
    title: doc.title,
    text: doc.text,
    counts,
    length: tokens.length || 1,
    norm: doc.text.toLowerCase().replace(/\s+/g, ' '),
  };
}

/** Term frequency of one query term in one indexed doc. */
function termFreq(d, term) {
  if (term.type === 'term') return d.counts.get(term.text) || 0;
  // phrase: count non-overlapping occurrences of the normalised phrase
  let n = 0;
  let from = 0;
  for (;;) {
    const i = d.norm.indexOf(term.text, from);
    if (i === -1) break;
    n++;
    from = i + term.text.length;
  }
  return n;
}

/** Round a score to 4 decimals for a stable JSON payload. */
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * TF-IDF rank of indexed docs against query terms. AND semantics: a doc is a
 * hit only when it contains EVERY term. Returns hits sorted by score desc.
 */
function rank(idxDocs, terms, snippetRadius) {
  const N = idxDocs.length || 1;
  const idfs = terms.map((term) => {
    const df = idxDocs.reduce((n, d) => n + (termFreq(d, term) > 0 ? 1 : 0), 0);
    return Math.log((N + 1) / (df + 1)) + 1; // smoothed, always positive
  });

  const hits = [];
  for (const d of idxDocs) {
    let score = 0;
    let all = true;
    for (let i = 0; i < terms.length; i++) {
      const tf = termFreq(d, terms[i]);
      if (tf === 0) { all = false; break; }
      // sublinear tf, length-normalised, times idf
      score += ((1 + Math.log(tf)) / Math.sqrt(d.length)) * idfs[i];
    }
    if (!all) continue;
    hits.push({
      url: d.url,
      title: d.title,
      snippet: makeSnippet(d.text, terms, snippetRadius),
      score: round4(score),
      path: d.path,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return hits;
}

/** A snippet of `text` around the first occurrence of any query term. */
function makeSnippet(text, terms, radius) {
  const hay = text.toLowerCase();
  let idx = -1;
  let len = 0;
  for (const term of terms) {
    const needle = term.text; // token or normalised phrase; both are lowercase
    const i = hay.indexOf(needle);
    if (i !== -1 && (idx === -1 || i < idx)) { idx = i; len = needle.length; }
  }
  if (idx === -1) {
    return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + len + radius);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '… ' + s;
  if (end < text.length) s = s + ' …';
  return s;
}

// ---------------------------------------------------------------- activate

export async function activate(api) {
  const routePath = api.prefix || '/search';
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'search plugin requires config.baseUrl — the plugin api exposes no ' +
      'server origin (same api.serverInfo finding as notifications/sparql/rss); ' +
      'optional config.loopbackUrl overrides where the plugin reaches its host',
    );
  }
  const loopback = (api.config.loopbackUrl || baseUrl).replace(/\/$/, '');
  const origin = new URL(baseUrl).origin;
  const defaultContainer = api.config.defaultContainer || null;
  const maxHits = api.config.maxHits ?? DEFAULT_MAX_HITS;
  const maxResources = api.config.maxResources ?? DEFAULT_MAX_RESOURCES;
  const maxDepth = api.config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const snippetRadius = api.config.snippetRadius ?? DEFAULT_SNIPPET_RADIUS;
  const useIndex = api.config.index === true;
  const reindexMs = api.config.reindexMs ?? DEFAULT_REINDEX_MS;
  const podsRoot = api.config.podsRoot || null;

  /** One loopback GET carrying the caller's own Authorization. */
  function lb(p, accept, auth) {
    return fetch(loopback + p, {
      redirect: 'manual',
      headers: { accept, ...(auth ? { authorization: auth } : {}) },
    });
  }

  /**
   * Walk `containerPath` over loopback as the caller: read each container's
   * ldp:contains listing (recursively, bounded by maxDepth/maxResources),
   * fetch every leaf member, extract its text. A resource the caller cannot
   * GET contributes nothing — WAC by construction.
   */
  async function crawl(containerPath, auth) {
    const path0 = containerPath.endsWith('/') ? containerPath : containerPath + '/';
    const docs = [];
    const visited = new Set();
    const state = { fetched: 0, truncated: false };

    async function extractLeaf(leafPath) {
      if (visited.has(leafPath)) return;
      if (state.fetched >= maxResources) { state.truncated = true; return; }
      visited.add(leafPath);
      state.fetched++;
      let res;
      try { res = await lb(leafPath, 'application/ld+json, text/*;q=0.9, */*;q=0.5', auth); }
      catch { return; }
      if (!res.ok) { try { await res.body?.cancel(); } catch { /* drained */ } return; }
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!/json|text|html|xml|markdown/.test(ct)) {
        try { await res.body?.cancel(); } catch { /* drained */ } // don't slurp binaries
        return;
      }
      let body;
      try { body = await res.text(); } catch { return; }
      const doc = extractDoc(baseUrl + leafPath, leafPath, ct, body);
      if (doc && doc.text.trim()) docs.push(doc);
    }

    async function walk(cpath, depth) {
      if (visited.has(cpath)) return;
      if (state.fetched >= maxResources) { state.truncated = true; return; }
      visited.add(cpath);
      state.fetched++;
      let res;
      try { res = await lb(cpath, 'application/ld+json', auth); } catch { return; }
      if (!res.ok || !(res.headers.get('content-type') || '').toLowerCase().includes('json')) {
        try { await res.body?.cancel(); } catch { /* drained */ }
        return;
      }
      let listing;
      try { listing = await res.json(); } catch { return; }
      for (const child of [].concat(listing.contains ?? [])) {
        const id = typeof child === 'string' ? child : child?.['@id'];
        if (!id) continue;
        let u;
        try { u = new URL(id, baseUrl + cpath); } catch { continue; }
        if (u.origin !== origin) continue;
        if (/\.(acl|meta)$/i.test(u.pathname)) continue;
        if (u.pathname.endsWith('/')) {
          if (depth < maxDepth) await walk(u.pathname, depth + 1);
          else state.truncated = true;
        } else {
          await extractLeaf(u.pathname);
        }
      }
    }

    await walk(path0, 0);
    return { docs, truncated: state.truncated, resources: visited.size };
  }

  // ------------------------------------------------ cached-index mode
  //
  // In-memory inverted index per container, persisted under pluginDir. This
  // is the honest-but-unsafe half — see the module header and README
  // Findings. Kept OFF by default so the read-time path (correct, fresh) is
  // what the tests and the common case exercise.
  const cache = new Map(); // containerPath -> { builtAt, idxDocs, truncated, resources }
  let pluginDir = null;
  let watcher = null;

  if (useIndex) {
    try { pluginDir = api.storage.pluginDir(); } catch { pluginDir = null; }
    if (podsRoot) {
      // OPTIONAL fs.watch refresh (like notifications/): coarse — any write
      // under the pods root invalidates the whole cache. It CANNOT catch a
      // write the OS coalesces, nor a non-fs storage backend; that gap is
      // precisely the api.events finding. Correctness does not depend on it —
      // the TTL rebuild and the per-hit HEAD recheck below are the backstops.
      try {
        watcher = watch(podsRoot, { recursive: true }, (_evt, filename) => {
          if (!filename) return;
          const base = String(filename).split('/').pop();
          if (base.startsWith('.') || filename.startsWith('.')) return; // dot-guarded trees
          cache.clear();
        });
        watcher.on('error', (err) => api.log.warn(`search: watcher error: ${err.message}`));
      } catch (err) {
        api.log.warn(`search: fs.watch unavailable (${err.message}); relying on TTL`);
      }
    }
  }

  const cacheFile = (containerPath) =>
    pluginDir ? path.join(pluginDir, 'index-' + createHash('sha1').update(containerPath).digest('hex') + '.json') : null;

  async function persist(containerPath, entry) {
    const file = cacheFile(containerPath);
    if (!file) return;
    const docs = entry.idxDocs.map((d) => ({ url: d.url, path: d.path, title: d.title, text: d.text }));
    try {
      await fs.writeFile(file, JSON.stringify({ builtAt: entry.builtAt, truncated: entry.truncated, resources: entry.resources, docs }));
    } catch (err) {
      api.log.warn(`search: could not persist index: ${err.message}`);
    }
  }

  async function loadPersisted(containerPath) {
    const file = cacheFile(containerPath);
    if (!file) return null;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Date.now() - raw.builtAt > reindexMs) return null;
      return {
        builtAt: raw.builtAt,
        truncated: raw.truncated,
        resources: raw.resources,
        idxDocs: raw.docs.map(indexDoc),
      };
    } catch { return null; }
  }

  /**
   * The indexed docs for a container in cached mode. Freshness is best-effort
   * only: an entry is rebuilt when older than reindexMs or invalidated by the
   * watcher. The build uses whichever caller triggered it — so the cache is a
   * CROSS-AGENT store (a real hazard, documented). WAC correctness of the
   * OUTPUT is restored by re-checking each hit against the current caller
   * (see filterReadable); staleness of the CONTENT cannot be, without a write
   * hook.
   */
  async function getIndexed(containerPath, auth) {
    const fresh = (e) => e && (Date.now() - e.builtAt) <= reindexMs;
    let entry = cache.get(containerPath);
    if (!fresh(entry)) entry = await loadPersisted(containerPath);
    if (!fresh(entry)) {
      const { docs, truncated, resources } = await crawl(containerPath, auth);
      entry = { builtAt: Date.now(), truncated, resources, idxDocs: docs.map(indexDoc) };
      cache.set(containerPath, entry);
      await persist(containerPath, entry);
    } else {
      cache.set(containerPath, entry);
    }
    return entry;
  }

  /** May the caller GET this url? Cheap loopback HEAD with their own creds. */
  async function readable(url, auth) {
    let p;
    try { p = new URL(url).pathname; } catch { return false; }
    try {
      const r = await fetch(loopback + p, { method: 'HEAD', redirect: 'manual', headers: auth ? { authorization: auth } : {} });
      try { await r.body?.cancel(); } catch { /* no body */ }
      return r.status < 400;
    } catch { return false; }
  }

  /**
   * Restore WAC for cached-mode output: keep only hits the current caller can
   * actually read. Bounded to the hits we would return anyway.
   */
  async function filterReadable(hits, auth, limit) {
    const out = [];
    for (const hit of hits) {
      if (out.length >= limit) break;
      if (await readable(hit.url, auth)) out.push(hit);
    }
    return out;
  }

  // ------------------------------------------------------------ CORS
  function cors(request, reply) {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'GET, OPTIONS');
    reply.header('access-control-allow-headers',
      request.headers['access-control-request-headers'] || 'authorization, content-type');
    reply.header('access-control-max-age', '86400');
  }

  api.fastify.options(routePath, (request, reply) => {
    cors(request, reply);
    reply.code(204).send();
  });

  api.fastify.get(routePath, async (request, reply) => {
    cors(request, reply);
    reply.header('content-type', 'application/json; charset=utf-8');

    const q = request.query?.q;
    if (typeof q !== 'string' || q.trim() === '') {
      return reply.code(400).send({ error: 'the "q" query parameter is required' });
    }
    if (q.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ error: 'query too long' });
    }

    // Scope: which container subtree to search.
    let containerPath = null;
    const c = request.query?.container;
    if (typeof c === 'string' && c) {
      if (c.startsWith('/')) containerPath = c;
      else {
        try { const u = new URL(c); if (u.origin === origin) containerPath = u.pathname; } catch { /* junk */ }
      }
      if (!containerPath) {
        return reply.code(400).send({ error: '?container= must be an absolute path like /alice/notes/ (this server)' });
      }
    } else if (defaultContainer) {
      containerPath = defaultContainer;
    } else {
      return reply.code(400).send({
        error: 'name a container: ?container=/path/ (this server) or set config.defaultContainer',
      });
    }

    const terms = parseQuery(q);
    if (!terms.length) {
      return { query: q, hits: [] }; // nothing searchable (e.g. only punctuation)
    }

    const auth = request.headers.authorization ?? null;

    let hits;
    let truncated;
    let resources;
    let mode;
    if (useIndex) {
      mode = 'cached-index';
      const entry = await getIndexed(containerPath, auth);
      truncated = entry.truncated;
      resources = entry.resources;
      const ranked = rank(entry.idxDocs, terms, snippetRadius);
      // WAC: the cache is cross-agent, so re-check each hit against THIS caller.
      hits = await filterReadable(ranked, auth, maxHits);
    } else {
      mode = 'read-time';
      const { docs, truncated: t, resources: r } = await crawl(containerPath, auth);
      truncated = t;
      resources = r;
      hits = rank(docs.map(indexDoc), terms, snippetRadius).slice(0, maxHits);
    }

    reply.header('x-search-mode', mode);
    reply.header('x-search-scope-resources', String(resources));
    if (truncated) reply.header('x-search-scope-truncated', 'true');

    return {
      query: q,
      hits: hits.map(({ url, title, snippet, score }) => ({ url, title, snippet, score })),
    };
  });

  api.log.info(
    `search: full-text search at ${routePath} (${useIndex ? 'cached-index' : 'read-time'} mode; ` +
    'loopback container walk; WAC-respecting)',
  );

  return {
    deactivate() {
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
      cache.clear();
    },
  };
}
