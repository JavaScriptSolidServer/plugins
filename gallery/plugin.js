// Pod photo/media gallery, as a #206 loader plugin — the FIRST consumer of
// api.mountApp (#583, JSS ≥ 0.0.219).
//
//   plugins: [{ module: 'gallery/plugin.js', prefix: '/gallery' }]   // that's it
//
//   GET  /gallery?container=/alice/public/gallery/   → self-contained HTML grid
//   POST /gallery/upload/<filename>                  → STREAM the raw body into
//                                                      the pod (loopback PUT,
//                                                      caller's Authorization
//                                                      forwarded — WAC decides)
//
// The whole plugin is ONE raw node (req, res) handler mounted with
// api.mountApp: no Fastify routes, no body buffering in the plugin. mountApp
// hands the handler the UN-DRAINED request stream (its scoped pass-through
// content parser is the point of #583), so an upload is piped end-to-end:
//
//   client ──(raw bytes)──▶ this handler ──(loopback PUT, same stream)──▶ pod
//
// Plugin memory stays O(1) per upload regardless of file size. The pod write
// carries the caller's own Authorization, so real WAC — not this plugin —
// decides whether the bytes land (the notifications/rss/webdav pattern).
//
// Zero required config: the server origin comes from api.serverInfo() (#601)
// per request, and the target container defaults to the authenticated
// caller's own <pod>/public/gallery/ (public-read, owner-write — exactly what
// a shareable gallery wants). config.container / ?container= override.
//
// Playback needs NO plugin lane at all: core's LDP GET honors Range natively
// (206 + Content-Range, Accept-Ranges: bytes), so the gallery page links
// media straight at the pod resources and <video>/<audio> seeking just works.
// Probed in test.js; see README "Findings".

import { Readable } from 'node:stream';

const DEFAULT_MAX_ITEMS = 200;

// One path segment, no leading dot (the data root's dot-guard territory),
// no slashes, printable subset. The extension is load-bearing: core derives
// the served Content-Type from it (see Findings).
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}$/;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'wav', 'm4a', 'flac', 'aac', 'opus']);

// Fallback upload Content-Type when the client sends none. (On GET core
// re-derives the type from the extension anyway — the stored header is
// cosmetic; see Findings.)
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', m4v: 'video/mp4', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const kindOf = (name) => {
  const e = extOf(name);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e)) return 'audio';
  return 'file';
};

function humanSize(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  do { v /= 1024; u += 1; } while (v >= 1024 && u < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * Derive the pod root path from a WebID (same mapping as micropub/mastodon).
 * Path-mode WebID:   http://host/alice/profile/card.jsonld#me → /alice/
 * Single-user WebID: http://host/profile/card.jsonld#me       → /
 */
function podFromWebid(webid) {
  try {
    const u = new URL(webid);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length >= 2 && segs[0] !== 'profile') return `/${segs[0]}/`;
    return '/';
  } catch {
    return null;
  }
}

/**
 * A usable pod container path: absolute, trailing slash, no traversal, no
 * dot-segments (the data root's dot-guard), no query/fragment/controls.
 */
function validContainer(p) {
  if (typeof p !== 'string' || p.length < 2) return null;
  if (!p.startsWith('/') || !p.endsWith('/')) return null;
  if (p.includes('\\') || p.includes('?') || p.includes('#') || p.includes('//')) return null;
  if (/[\x00-\x1f\x7f]/.test(p)) return null;
  const segs = p.slice(1, -1).split('/');
  if (segs.some((s) => !s || s.startsWith('.'))) return null;
  return p;
}

function dateMillis(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

export async function activate(api) {
  // ------------------------------------------------------------ config
  // No REQUIRED config — serverInfo (#601) supplies the origin and the
  // container defaults per caller. Everything below is optional override,
  // validated loudly at boot (fail the boot, not the first request).
  const cfgContainer = api.config.container ?? null;
  if (cfgContainer !== null && !validContainer(cfgContainer)) {
    throw new Error(
      `gallery: config.container must be an absolute pod container path like `
      + `'/alice/public/gallery/' (leading and trailing '/', no '..', no dot `
      + `segments) — got ${JSON.stringify(cfgContainer)}`,
    );
  }
  const maxItems = api.config.maxItems ?? DEFAULT_MAX_ITEMS;
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error(`gallery: config.maxItems must be a positive integer, got ${JSON.stringify(api.config.maxItems)}`);
  }

  // Origins, resolved lazily (serverInfo is only authoritative once
  // listening — port 0 boots have no real port at activate time).
  function loopbackOrigin() {
    if (api.config.loopbackUrl) return String(api.config.loopbackUrl).replace(/\/$/, '');
    const { protocol, host, port } = api.serverInfo();
    const h = host.includes(':') ? `[${host}]` : host;
    return `${protocol}://${h}:${port}`;
  }
  function publicBase() {
    if (api.config.baseUrl) return String(api.config.baseUrl).replace(/\/$/, '');
    return api.serverInfo().baseUrl.replace(/\/$/, '');
  }

  // ------------------------------------------------------- raw helpers
  // mountApp hands a bare (req, res) — everything Fastify normally does
  // (routing, replies, HEAD, errors) is hand-rolled here. That trade is
  // the price of the un-drained stream; see README Findings.

  function send(res, method, code, headers, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
    res.writeHead(code, { 'content-length': buf.length, 'cache-control': 'no-store', ...headers });
    res.end(method === 'HEAD' ? undefined : buf);
  }
  const sendJson = (res, method, code, obj, extra = {}) => send(
    res, method, code, { 'content-type': 'application/json; charset=utf-8', ...extra },
    JSON.stringify(obj),
  );
  const sendHtml = (res, method, code, html) => send(
    res, method, code, { 'content-type': 'text/html; charset=utf-8' }, html,
  );

  /** Loopback fetch, forwarding the caller's Authorization when present. */
  const lb = (p, { method = 'GET', headers = {}, auth, body, duplex } = {}) => fetch(loopbackOrigin() + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
    ...(duplex ? { duplex } : {}),
  });

  /**
   * The caller's own default container: <pod>/public/gallery/ — public-read,
   * owner-write under the seeded pod ACLs, i.e. a shareable gallery.
   * getAgent wants a Fastify request; the raw req lacks protocol/hostname,
   * so a shim fills them. Bearer verification reads only headers and works;
   * DPoP/NIP-98 signature checks may not survive the shim (see Findings).
   */
  async function deriveContainer(req) {
    const agent = await api.auth.getAgent({
      headers: req.headers,
      method: req.method,
      url: req.url,
      protocol: 'http',
      hostname: req.headers.host || 'localhost',
    });
    if (!agent) return null;
    const pod = podFromWebid(agent);
    return pod ? validContainer(`${pod}public/gallery/`) : null;
  }

  /**
   * Resolve which container a request addresses.
   * Precedence: ?container= (400 on garbage — never silently fall back) →
   * config.container → the authenticated caller's own gallery → null.
   * Returns { container } or { error, status }.
   */
  async function resolveContainer(req, searchParams) {
    const q = searchParams.get('container');
    if (q !== null) {
      const c = validContainer(q);
      return c ? { container: c } : {
        error: `invalid container ${JSON.stringify(q)} — need an absolute pod path like /alice/public/gallery/`,
        status: 400,
      };
    }
    if (cfgContainer) return { container: cfgContainer };
    const derived = req.headers.authorization ? await deriveContainer(req) : null;
    return derived ? { container: derived } : { container: null };
  }

  // ------------------------------------------------------------- upload
  //
  // POST/PUT /gallery/upload/<filename>[?container=/path/] — the #583 lane.
  // The request stream is piped straight into a loopback PUT: no buffering
  // here, chunked transfer to the host, WAC judging the caller's own
  // Authorization. (Core's LDP still buffers the PUT body once, capped by
  // the server bodyLimit — see Findings; the *plugin* holds O(1) bytes.)

  async function handleUpload(req, res, rawName, searchParams) {
    let filename;
    try { filename = decodeURIComponent(rawName); } catch {
      return sendJson(res, req.method, 400, { error: 'undecodable filename' });
    }
    if (!FILENAME_RE.test(filename)) {
      req.resume();
      return sendJson(res, req.method, 400, {
        error: 'filename must be one plain path segment (letters, digits, ". _ ( ) + -", no leading dot)',
      });
    }
    const resolved = await resolveContainer(req, searchParams);
    if (resolved.error) {
      req.resume();
      return sendJson(res, req.method, resolved.status, { error: resolved.error });
    }
    if (!resolved.container) {
      req.resume();
      return sendJson(res, req.method, 401, {
        error: 'no target container: authenticate (Bearer) so your own /public/gallery/ applies, or pass ?container=/path/',
      }, { 'www-authenticate': 'Bearer' });
    }
    const target = resolved.container + encodeURIComponent(filename);
    const auth = req.headers.authorization;
    let put;
    try {
      put = await lb(target, {
        method: 'PUT',
        headers: {
          'content-type': req.headers['content-type'] || MIME[extOf(filename)] || 'application/octet-stream',
        },
        auth,
        body: Readable.toWeb(req), // the un-drained stream, verbatim — the whole point of #583
        duplex: 'half',
      });
    } catch (err) {
      return sendJson(res, req.method, 502, { error: `loopback PUT failed: ${err.message}` });
    }
    await put.text().catch(() => '');
    if (put.status === 401 || put.status === 403) {
      return sendJson(res, req.method, put.status, { error: 'the pod refused the write (WAC)' },
        put.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
    }
    if (!(put.ok || put.status === 201 || put.status === 204)) {
      return sendJson(res, req.method, put.status >= 400 ? put.status : 502,
        { error: `pod storage rejected the upload (${put.status})` });
    }
    const url = publicBase() + target;
    return sendJson(res, req.method, 201, { url, name: filename, container: resolved.container },
      { location: url });
  }

  // ------------------------------------------------------- container walk
  // The rss/sparql read-time walk: GET the container as JSON-LD over
  // loopback (caller's auth forwarded), map ldp:contains to media items.
  // The listing itself carries stat:size and dcterms:modified — no
  // per-member requests needed for the grid.

  async function walk(container, auth) {
    let res;
    try {
      res = await lb(container, { headers: { accept: 'application/ld+json' }, auth });
    } catch {
      return { status: 502, items: [] };
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      return { status: res.status, items: [] };
    }
    let listing;
    try { listing = await res.json(); } catch { return { status: 502, items: [] }; }
    const items = [];
    for (const child of [].concat(listing.contains ?? [])) {
      const id = typeof child === 'string' ? child : child?.['@id'];
      if (!id) continue;
      let u;
      try { u = new URL(id, 'http://internal.invalid' + container); } catch { continue; }
      if (u.pathname.endsWith('/')) continue; // sub-containers: not media
      const name = decodeURIComponent(u.pathname.slice(u.pathname.lastIndexOf('/') + 1));
      if (/\.(acl|meta)$/i.test(name)) continue;
      items.push({
        name,
        path: u.pathname,
        size: typeof child === 'object' ? Number(child['stat:size']) : NaN,
        modified: typeof child === 'object' ? (child['dcterms:modified'] ?? null) : null,
        kind: kindOf(name),
      });
    }
    items.sort((a, b) => dateMillis(b.modified) - dateMillis(a.modified));
    return { status: 200, items: items.slice(0, maxItems) };
  }

  // --------------------------------------------------------------- the page
  // Self-contained HTML: inline CSS, no external assets, dark-mode aware.
  // Server-rendered (curl-testable); one small inline script drives uploads
  // through the streaming lane above.

  function renderPage({ container, items, status, base }) {
    const total = items.reduce((n, i) => n + (Number.isFinite(i.size) ? i.size : 0), 0);
    const tiles = items.map((i) => {
      const href = base + i.path;
      const media = i.kind === 'image'
        ? `<a href="${esc(href)}"><img src="${esc(href)}" alt="${esc(i.name)}" loading="lazy"></a>`
        : i.kind === 'video'
          ? `<video src="${esc(href)}" controls preload="metadata"></video>`
          : i.kind === 'audio'
            ? `<div class="pad"><audio src="${esc(href)}" controls preload="metadata"></audio></div>`
            : `<a class="doc" href="${esc(href)}"><span>${esc(extOf(i.name) || 'file')}</span></a>`;
      return `      <figure class="tile">
        <div class="media">${media}</div>
        <figcaption><a href="${esc(href)}">${esc(i.name)}</a><small>${esc(humanSize(i.size))}</small></figcaption>
      </figure>`;
    }).join('\n');

    const note = !container
      ? '<p class="note">No container selected. Name one below, or send a Bearer token and your own <code>/public/gallery/</code> is used.</p>'
      : status === 404
        ? `<p class="note"><code>${esc(container)}</code> does not exist yet — the first upload creates it (deep PUT).</p>`
        : status === 401 || status === 403
          ? `<p class="note">The pod refused to list <code>${esc(container)}</code> (WAC ${status}). This gallery has no authority of its own — it asks as you.</p>`
          : status !== 200
            ? `<p class="note">Could not walk <code>${esc(container)}</code> (${status}).</p>`
            : items.length === 0
              ? '<p class="note">Nothing here yet — upload something below.</p>'
              : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pod gallery</title>
<style>
  :root { color-scheme: light dark;
    --fg: #1a1a1a; --bg: #fafafa; --card: #ffffff; --muted: #666;
    --line: #ddd; --accent: #3b5bdb; }
  @media (prefers-color-scheme: dark) { :root {
    --fg: #e6e6e6; --bg: #121212; --card: #1d1d1d; --muted: #999;
    --line: #333; --accent: #91a7ff; } }
  * { box-sizing: border-box; }
  body { margin: 2rem auto; max-width: 62rem; padding: 0 1rem;
    font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.25rem; margin: 0; }
  header { display: flex; flex-wrap: wrap; gap: .35rem 1rem; align-items: baseline; margin-bottom: 1rem; }
  header .meta { color: var(--muted); font-size: .85rem; }
  header code { font-size: .95em; }
  form.pick { display: flex; gap: .5rem; margin: 0 0 1rem; }
  form.pick input { flex: 1; padding: .45rem .6rem; border: 1px solid var(--line);
    border-radius: 6px; background: var(--card); color: var(--fg); font: inherit; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .9rem; }
  .tile { margin: 0; background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; }
  .media { aspect-ratio: 4 / 3; display: flex; align-items: center; justify-content: center;
    background: color-mix(in srgb, var(--line) 30%, var(--card)); }
  .media a { display: block; width: 100%; height: 100%; }
  .media img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .media video { width: 100%; height: 100%; background: #000; }
  .media .pad { width: 100%; padding: .6rem; }
  .media audio { width: 100%; }
  .media .doc { display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; text-decoration: none; }
  .media .doc span { border: 1px solid var(--line); border-radius: 6px; padding: .3em .7em;
    color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .06em; }
  figcaption { display: flex; justify-content: space-between; gap: .5rem;
    padding: .45rem .6rem; font-size: .85rem; }
  figcaption a { color: var(--fg); text-decoration: none; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  figcaption a:hover { color: var(--accent); }
  figcaption small { color: var(--muted); white-space: nowrap; }
  .note { color: var(--muted); }
  .up { margin-top: 1.5rem; padding: 1rem; background: var(--card);
    border: 1px dashed var(--line); border-radius: 10px; }
  .up h2 { font-size: .95rem; margin: 0 0 .6rem; }
  .up .row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .up input[type=password] { flex: 1; min-width: 12rem; padding: .45rem .6rem;
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
    color: var(--fg); font: inherit; }
  button { padding: .45rem .9rem; border: 1px solid var(--line); border-radius: 6px;
    background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  #upstatus { color: var(--muted); font-size: .85rem; margin-top: .5rem; min-height: 1.2em; }
</style>
</head>
<body>
  <header>
    <h1>pod gallery</h1>
    ${container
    ? `<span class="meta"><code>${esc(container)}</code> — ${items.length} item${items.length === 1 ? '' : 's'}${total ? `, ${esc(humanSize(total))}` : ''}</span>`
    : '<span class="meta">media in your own pod, streamed in, WAC-governed</span>'}
  </header>
  <form class="pick" method="get">
    <input name="container" placeholder="/alice/public/gallery/" value="${esc(container ?? '')}">
    <button type="submit">open</button>
  </form>
${note}
  <div class="grid">
${tiles}
  </div>
  <section class="up">
    <h2>upload — streamed to the pod, byte for byte</h2>
    <div class="row">
      <input type="file" id="file" multiple>
      <input type="password" id="token" placeholder="Bearer token (owner writes)">
      <button id="go" type="button">upload</button>
    </div>
    <p id="upstatus"></p>
  </section>
  <script>
    (function () {
      var prefix = ${JSON.stringify(api.prefix)};
      var container = ${JSON.stringify(container)};
      var el = function (id) { return document.getElementById(id); };
      el('go').addEventListener('click', async function () {
        var files = el('file').files;
        var status = el('upstatus');
        if (!files.length) { status.textContent = 'pick a file first'; return; }
        var token = el('token').value.trim();
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          status.textContent = 'uploading ' + f.name + ' (' + (i + 1) + '/' + files.length + ')…';
          var url = prefix + '/upload/' + encodeURIComponent(f.name)
            + (container ? '?container=' + encodeURIComponent(container) : '');
          var headers = { 'content-type': f.type || 'application/octet-stream' };
          if (token) headers.authorization = 'Bearer ' + token;
          try {
            var res = await fetch(url, { method: 'POST', headers: headers, body: f });
            if (!res.ok) {
              var body = await res.json().catch(function () { return {}; });
              status.textContent = f.name + ': ' + res.status + ' ' + (body.error || '');
              return;
            }
          } catch (err) { status.textContent = f.name + ': ' + err; return; }
        }
        location.reload();
      });
    })();
  </script>
</body>
</html>
`;
  }

  async function handlePage(req, res, searchParams) {
    const resolved = await resolveContainer(req, searchParams);
    if (resolved.error) {
      return sendHtml(res, req.method, resolved.status,
        renderPage({ container: null, items: [], status: 200, base: publicBase() }));
    }
    const base = publicBase();
    if (!resolved.container) {
      return sendHtml(res, req.method, 200, renderPage({ container: null, items: [], status: 200, base }));
    }
    const { status, items } = await walk(resolved.container, req.headers.authorization);
    // The page mirrors the walk's WAC verdict in its own status (a private
    // gallery is 401/403 to strangers, curl-visibly), but still renders a
    // human explanation; 404 renders as "empty, upload to create".
    const pageStatus = status === 200 || status === 404 ? 200 : status;
    return sendHtml(res, req.method, pageStatus,
      renderPage({ container: resolved.container, items, status, base }));
  }

  // ------------------------------------------------------------ the mount
  // ONE raw handler owns the whole prefix: page, upload lane, errors. This
  // is deliberately the pure #583 shape — no api.fastify routes at all.

  await api.mountApp(async (req, res) => {
    const u = new URL(req.url, 'http://internal.invalid');
    const p = u.pathname;
    const prefix = api.prefix;

    if (p === prefix || p === `${prefix}/`) {
      if (req.method === 'GET' || req.method === 'HEAD') return handlePage(req, res, u.searchParams);
      if (req.method === 'OPTIONS') return send(res, req.method, 204, { allow: 'GET, HEAD, OPTIONS' });
      req.resume();
      return sendJson(res, req.method, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD, OPTIONS' });
    }

    if (p.startsWith(`${prefix}/upload/`)) {
      const rest = p.slice(`${prefix}/upload/`.length);
      if (req.method === 'POST' || req.method === 'PUT') return handleUpload(req, res, rest, u.searchParams);
      if (req.method === 'OPTIONS') return send(res, req.method, 204, { allow: 'POST, PUT, OPTIONS' });
      req.resume();
      return sendJson(res, req.method, 405, { error: 'upload with POST or PUT' }, { allow: 'POST, PUT, OPTIONS' });
    }

    req.resume();
    return sendJson(res, req.method, 404, {
      error: `no such route — GET ${prefix}/ (the gallery) or POST ${prefix}/upload/<filename>`,
    });
  });

  api.log.info(
    `gallery: mounted raw app at ${api.prefix} (mountApp #583) — uploads stream to `
    + `${cfgContainer ?? '<pod>/public/gallery/'} over loopback; playback links straight to the pod (core Range)`,
  );
  // Stateless: nothing to tear down.
}
