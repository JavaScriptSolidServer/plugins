// oEmbed provider (https://oembed.com/) for pod resources, as a #206 loader
// plugin.
//
//   plugins: [{ module: 'oembed/plugin.js', prefix: '/oembed',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000',
//                         providerName: 'My Pod' } }]
//
// Third-party sites unfurl links to pod resources through one endpoint:
//
//   GET /oembed?url=<pod-resource-url>[&format=json|xml][&maxwidth=N][&maxheight=N]
//     → an oEmbed document describing the resource
//   GET /oembed/discover?url=<pod-resource-url>
//     → the <link rel="alternate" …+oembed> discovery tags as text, for the
//       pod owner to paste into their own HTML (see the discovery caveat at
//       the bottom of this file and README "Findings")
//
// ------------------------------------------------------------ how it works
//
// The `url` parameter MUST name a resource under this server's own baseUrl
// (micropub's localPath guard) — this endpoint NEVER fetches external URLs.
// The resource is resolved over loopback HTTP FORWARDING the caller's
// Authorization when present, so the host's real WAC decides visibility.
// oEmbed consumers are normally anonymous, so in practice only publicly
// readable resources unfurl — which is exactly right. Any 401/403/404 from
// the pod is collapsed to an oEmbed 404 "not found": per spec the consumer
// falls back to a plain link, and a private resource's existence is not
// leaked (the spec's optional 401-for-private response would leak it).
//
// Type mapping (by the resource's Content-Type):
//
//   image/*            → "photo" with url + REQUIRED width/height, parsed
//                        from the bytes themselves (PNG IHDR, JPEG SOF
//                        markers, GIF header — first 64 KiB); an image whose
//                        dimensions can't be parsed falls through to "link"
//                        rather than emit a spec-violating photo response.
//   text/html          → "link" — deliberately NOT "rich". A "rich"
//                        response's `html` field is injected verbatim into
//                        consumer pages; echoing pod-authored HTML there
//                        would hand every pod writer a stored-XSS vector on
//                        every consuming site. Safety choice, documented.
//   */json, *+json     → "link"; a Micropub h-entry contributes its
//                        properties.name (or content) as the title.
//   anything else      → "link" with the filename as title.
//
// format=json (default) and format=xml are both implemented; any other
// format is 501 per the spec's allowance. maxwidth/maxheight are honored on
// photo responses by scaling the DECLARED width/height proportionally — the
// plugin cannot resize actual image bytes (no image library, by the import
// rule), so `url` always names the original resource. Error bodies are
// always JSON `{"error":…}` regardless of format, for simplicity.
//
// Everything is stateless: no pluginDir, nothing returned from activate.

// --------------------------------------------------------------- utilities

const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

/** Decoded filename without its extension, for a fallback title. */
function filenameTitle(pathname) {
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  let name = base;
  try { name = decodeURIComponent(base); } catch { /* keep raw */ }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || base;
}

// -------------------------------------------------- image dimension parsing
//
// oEmbed's photo type REQUIRES width and height, and nothing in the plugin
// api (or HTTP) reveals them — so parse them from the image bytes, by magic
// number, on node buffers alone. PNG and GIF carry dimensions at fixed
// offsets; JPEG needs a walk over its marker segments to the first SOF.

/** { width, height } or null if the buffer isn't a parseable PNG/GIF/JPEG. */
function imageDimensions(buf) {
  // PNG: 8-byte signature, then the IHDR chunk (must be first per spec):
  // length(4) "IHDR" width(4 BE) height(4 BE) …
  if (buf.length >= 24
      && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
      && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then logical-screen width/height, 16-bit LE.
  if (buf.length >= 10) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
  }

  // JPEG: SOI (FFD8) then marker segments; dimensions live in the first SOF
  // (start-of-frame) marker: FF C0–CF excluding C4 (DHT), C8, CC (DAC).
  // Each non-standalone segment is FF <marker> <len BE, includes itself>.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) return null; // lost marker sync
      const marker = buf[off + 1];
      if (marker === 0xff) { off += 1; continue; } // fill byte
      if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { off += 2; continue; } // standalone
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (off + 9 > buf.length) return null;
        // segment: len(2) precision(1) height(2 BE) width(2 BE) …
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      off += 2 + len;
    }
  }
  return null;
}

/**
 * Read at most `max` bytes from a fetch response body, then cancel the rest.
 * Dimensions live in the first bytes (PNG/GIF: <32; JPEG SOF: almost always
 * well inside 64 KiB), so a huge image is never buffered whole.
 */
async function readPrefix(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  } catch { /* partial data is fine — parsing just fails to "link" */ }
  try { await reader.cancel(); } catch { /* already done */ }
  return Buffer.concat(chunks);
}

// --------------------------------------------------------- h-entry mapping

/** Best-effort title from a Micropub h-entry JSON document, else null. */
function hEntryTitle(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Array.isArray(doc.type) || !doc.type.includes('h-entry')) return null;
  const props = doc.properties;
  if (!props || typeof props !== 'object') return null;
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const name = first(props.name);
  if (typeof name === 'string' && name.trim()) return name.trim();
  let content = first(props.content);
  if (content && typeof content === 'object') content = content.value; // {value, html}
  if (typeof content === 'string' && content.trim()) return content.trim().slice(0, 140);
  return null;
}

// ------------------------------------------------------------ xml rendering

function renderXml(doc) {
  const parts = ['<?xml version="1.0" encoding="utf-8" standalone="yes"?>', '<oembed>'];
  for (const [k, v] of Object.entries(doc)) {
    parts.push(`  <${k}>${xmlEscape(v)}</${k}>`);
  }
  parts.push('</oembed>');
  return parts.join('\n');
}

// ---------------------------------------------------------------- activate

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'oembed plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (the api.serverInfo finding, Nth consumer). It is '
      + 'needed for provider_url and the "is this URL ours?" guard.',
    );
  }
  const loopback = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!loopback) {
    throw new Error(
      'oembed plugin requires config.loopbackUrl — resources are resolved '
      + 'over loopback HTTP forwarding the caller\'s Authorization, so the '
      + 'host\'s real WAC decides what unfurls.',
    );
  }
  const prefix = api.prefix || '/oembed';
  const providerName = api.config.providerName ?? 'Solid Pod';

  const sendJson = (reply, code, obj) => reply.code(code)
    .header('access-control-allow-origin', '*')
    .header('content-type', 'application/json; charset=utf-8')
    .send(obj);

  /** A url is ours iff it lives under baseUrl (micropub's guard) → its path. */
  function localPath(url) {
    if (typeof url !== 'string' || !url.startsWith(`${baseUrl}/`)) return null;
    try { return new URL(url).pathname; } catch { return null; }
  }

  const posInt = (v) => {
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  // ------------------------------------------------------- the endpoint
  api.fastify.get(prefix, async (request, reply) => {
    const format = request.query?.format ?? 'json';
    if (format !== 'json' && format !== 'xml') {
      // Spec: 501 Not Implemented when the requested format isn't supported.
      return sendJson(reply, 501, { error: `format "${format}" not implemented — json and xml are supported` });
    }
    const p = localPath(request.query?.url);
    if (!p) {
      return sendJson(reply, 400, {
        error: `url must name a resource under this server (${baseUrl}/…) — external URLs are never fetched`,
      });
    }
    const maxwidth = posInt(request.query?.maxwidth);
    const maxheight = posInt(request.query?.maxheight);
    const auth = request.headers.authorization ?? null;

    // Resolve over loopback AS THE CALLER: real WAC decides. Anonymous
    // callers (the normal oEmbed consumer) see only public resources.
    let res;
    try {
      res = await fetch(loopback + p, {
        redirect: 'manual',
        headers: { accept: '*/*', ...(auth ? { authorization: auth } : {}) },
      });
    } catch {
      return sendJson(reply, 502, { error: 'could not reach the pod over loopback' });
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* drained */ }
      // 401/403/404/… from the pod all collapse to oEmbed 404 "not found":
      // the consumer falls back to a plain link, and nothing is leaked
      // about whether a private resource exists.
      return sendJson(reply, 404, { error: 'not found' });
    }

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const resourceUrl = baseUrl + p;
    let type = 'link';
    let photo = null; // { url, width, height }
    let title = filenameTitle(p);

    if (ct.startsWith('image/')) {
      const head = await readPrefix(res, 64 * 1024);
      const dims = imageDimensions(head);
      if (dims && dims.width > 0 && dims.height > 0) {
        // photo REQUIRES width/height; honor maxwidth/maxheight by scaling
        // the declared dimensions (the url still serves the original bytes).
        let { width, height } = dims;
        const scale = Math.min(
          1,
          maxwidth ? maxwidth / width : 1,
          maxheight ? maxheight / height : 1,
        );
        if (scale < 1) {
          width = Math.max(1, Math.floor(width * scale));
          height = Math.max(1, Math.floor(height * scale));
        }
        type = 'photo';
        photo = { url: resourceUrl, width, height };
      }
      // unparseable image → honest "link" (never a photo without dimensions)
    } else if (ct === 'application/json' || ct.endsWith('+json')) {
      let parsed = null;
      try { parsed = JSON.parse(await res.text()); } catch { /* not JSON after all */ }
      const t = hEntryTitle(parsed);
      if (t) title = t;
    } else {
      // text/html lands here too — deliberately "link", never "rich": the
      // rich `html` field is injected verbatim into consumer pages, and
      // echoing pod-authored HTML there would be a stored-XSS vector.
      try { await res.body?.cancel(); } catch { /* drained */ }
    }

    const out = {
      version: '1.0',
      type,
      ...(photo ?? {}),
      title,
      provider_name: providerName,
      provider_url: baseUrl,
    };
    if (format === 'xml') {
      return reply.code(200)
        .header('access-control-allow-origin', '*')
        .header('content-type', 'text/xml; charset=utf-8')
        .send(renderXml(out));
    }
    return sendJson(reply, 200, out);
  });

  // -------------------------------------------------- discovery helper
  //
  // Real oEmbed discovery is a <link rel="alternate"
  // type="application/json+oembed" href="…"> in the HEAD of the resource's
  // OWN HTML (or an equivalent Link: header on its response). Those
  // responses are served by LDP core — routes this plugin does not own and
  // cannot decorate (the response-header/content-injection seam, NOTES.md
  // #8; third consumer after notifications/ and micropub/). So the best a
  // plugin can do is HAND the tag to the pod owner: this endpoint renders
  // the exact tags to paste into their HTML. See README "Findings".
  api.fastify.get(`${prefix}/discover`, (request, reply) => {
    const p = localPath(request.query?.url);
    if (!p) {
      return sendJson(reply, 400, {
        error: `url must name a resource under this server (${baseUrl}/…)`,
      });
    }
    const endpoint = (fmt) => `${baseUrl}${prefix}?url=${encodeURIComponent(baseUrl + p)}&format=${fmt}`;
    const title = filenameTitle(p);
    const tags = [
      `<link rel="alternate" type="application/json+oembed" href="${xmlEscape(endpoint('json'))}" title="${xmlEscape(title)} oEmbed (JSON)">`,
      `<link rel="alternate" type="text/xml+oembed" href="${xmlEscape(endpoint('xml'))}" title="${xmlEscape(title)} oEmbed (XML)">`,
    ];
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .send(`${tags.join('\n')}\n`);
  });

  api.log.info(`oembed: provider at ${prefix}?url=… (json+xml; photo/link; loopback via ${loopback}; WAC-respecting)`);
}
