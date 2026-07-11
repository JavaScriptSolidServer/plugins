// JMAP server (RFC 8620 core + a slice of RFC 8621 mail) as a #206 loader
// plugin — messages are JSON resources in the caller's own pod.
//
//   plugins: [{ module: 'jmap/plugin.js', prefix: '/jmap',
//               config: { baseUrl: 'http://localhost:3000',
//                         loopbackUrl: 'http://127.0.0.1:3000' } }]
//
// JMAP is the modern HTTP/JSON email API. Unlike IMAP — a long-lived,
// stateful, server-push protocol — the JMAP core is STATELESS
// request/response: a session document, then batched method calls over one
// POST endpoint. That contrast is the headline finding: what makes an email
// protocol bridgeable onto the plugin api is not "email", it's "no server
// push". The stateless slice (session, Mailbox/get, Email/get/query/set)
// maps onto loopback pod I/O exactly; the push half (EventSource,
// */changes, Email/queryChanges) is blocked on the missing
// `api.events.onResourceChange` seam, the same wall matrix/'s `/sync` hit.
//
// --------------------------------------------------------- the token bridge
//
// JMAP says clients authenticate with `Authorization: Bearer` (RFC 8620
// §8.2 recommends OAuth-style bearers). A Solid pod access token is *also*
// just a bearer resent on every call — so, as in mastodon/ bluesky/ matrix/
// micropub/, the bridge is the identity function: a pod bearer IS a JMAP
// token. `api.auth.getAgent(request)` resolves it to the WebID, and every
// pod read/write is a loopback LDP call carrying that same bearer, so real
// WAC — not this shim — decides every operation.
//
// --------------------------------------------------------- object mapping
//
// JMAP Account   = the caller's pod; accountId = a stable hash of the WebID.
// JMAP Mailbox   = a pod container under <pod>/private/mail/ — Inbox,
//                  Drafts, Sent, Trash (ids: inbox/drafts/sent/trash;
//                  containers are auto-created by the pod on first PUT).
// JMAP Email     = one JSON resource <mailbox>/<id>.json storing the JMAP
//                  Email fields verbatim (id is ulid-ish: sortable time
//                  prefix + randomness).
// move           = PUT into the new mailbox container, DELETE from the old.
// state strings  = a hash of the four mailbox listings — coarse but honest
//                  (see README; real deltas need api.events).
//
// Discovery: RFC 8620 §2.2 autodiscovery is `/.well-known/jmap` → 301 to
// the Session resource. That path registers OUTSIDE the plugin's prefix and
// works only because core blanket-exempts `/.well-known/*` from WAC — the
// by-luck reservePath finding, another witness. Everything else lives under
// the one prefix, so unlike mastodon/bluesky/matrix NO appPaths widening is
// needed: JMAP's session document makes every other URL client-discovered.

import crypto from 'node:crypto';

const MAIL_DIR = 'private/mail'; // where mailboxes live inside a pod
const CORE_URN = 'urn:ietf:params:jmap:core';
const MAIL_URN = 'urn:ietf:params:jmap:mail';

// The fixed mailbox set. id doubles as the JMAP Mailbox id; name is the pod
// container name under MAIL_DIR.
const MAILBOXES = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'drafts', name: 'Drafts', role: 'drafts' },
  { id: 'sent', name: 'Sent', role: 'sent' },
  { id: 'trash', name: 'Trash', role: 'trash' },
];
const mailboxById = (id) => MAILBOXES.find((m) => m.id === id);

// Email properties we persist verbatim from a create.
const EMAIL_PROPS = [
  'from', 'to', 'cc', 'bcc', 'replyTo', 'sender', 'subject', 'sentAt',
  'keywords', 'messageId', 'inReplyTo', 'references', 'headers',
  'bodyValues', 'textBody', 'htmlBody',
];

/**
 * Derive the pod root path and a display username from a WebID.
 * Path-mode WebID:   http://host/alice/profile/card.jsonld#me → { alice, /alice/ }
 * Single-user WebID: http://host/profile/card.jsonld#me       → { host label, / }
 * (Copied from mastodon/matrix — the same WebID→pod convention.)
 */
function podFromWebid(webid) {
  const u = new URL(webid);
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length >= 2 && segs[0] !== 'profile') {
    return { username: segs[0], podPath: `/${segs[0]}/` };
  }
  return { username: u.hostname.split('.')[0] || 'user', podPath: '/' };
}

/** A ulid-ish id: millisecond time prefix (base36, sortable) + randomness. */
function newEmailId() {
  return `${Date.now().toString(36).padStart(9, '0')}${crypto.randomBytes(8).toString('hex')}`;
}

/** Filename-safe email id (it becomes a pod path segment). */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** Server-computed preview: first ~200 chars of the plain-text body. */
function previewOf(spec) {
  if (typeof spec.preview === 'string') return spec.preview.slice(0, 256);
  const values = spec.bodyValues && typeof spec.bodyValues === 'object' ? spec.bodyValues : {};
  const parts = Array.isArray(spec.textBody) ? spec.textBody : [];
  const texts = parts
    .map((p) => values[p?.partId]?.value)
    .filter((v) => typeof v === 'string');
  const text = texts.length
    ? texts.join(' ')
    : Object.values(values).map((v) => v?.value).filter((v) => typeof v === 'string').join(' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** A method-level JMAP error, thrown by handlers and caught by the dispatcher. */
function methodError(type, description) {
  const e = new Error(type);
  e.jmap = { type, ...(description ? { description } : {}) };
  return e;
}

export async function activate(api) {
  const baseUrl = (api.config.baseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error(
      'jmap plugin requires config.baseUrl — the plugin api exposes no '
      + 'server origin (same finding as notifications/, mastodon/, matrix/). '
      + 'It is needed to mint the session urls (apiUrl) and the '
      + '/.well-known/jmap redirect target.',
    );
  }
  const loopback = (api.config.loopbackUrl || '').replace(/\/$/, '');
  if (!loopback) {
    throw new Error(
      'jmap plugin requires config.loopbackUrl — all mailbox/message I/O is '
      + 'loopback LDP with the caller\'s own Authorization forwarded, so real '
      + 'WAC decides every operation.',
    );
  }
  const prefix = api.prefix || '/jmap';

  // The session document is static per boot (fixed capabilities, fixed urls),
  // so its state string — and the request-level sessionState — is a constant.
  const sessionStateStr = crypto.createHash('sha256')
    .update(`${baseUrl}${prefix}`).digest('hex').slice(0, 12);

  const accountIdFor = (webid) => crypto.createHash('sha256')
    .update(webid).digest('base64url').slice(0, 16);

  // ----------------------------------------------------------------- helpers
  const cors = (reply) => reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-headers', 'authorization, content-type')
    .header('access-control-allow-methods', 'GET, POST, OPTIONS');
  const json = (reply, code, obj) => cors(reply)
    .code(code).header('content-type', 'application/json; charset=utf-8').send(obj);
  // RFC 7807 problem+json, as RFC 8620 §3.6.1 requires for request-level errors.
  const problem = (reply, status, type, detail) => cors(reply)
    .code(status).header('content-type', 'application/problem+json')
    .send({ type, status, ...(detail ? { detail } : {}) });

  /** Reach the host over loopback, forwarding the caller's Authorization. */
  const lb = (p, { method = 'GET', headers = {}, body, auth } = {}) => fetch(loopback + p, {
    method,
    redirect: 'manual',
    headers: { ...headers, ...(auth ? { authorization: auth } : {}) },
    ...(body !== undefined ? { body } : {}),
  });

  const mailboxPath = (podPath, mb) => `${podPath}${MAIL_DIR}/${mb.name}/`;
  const emailPath = (podPath, mb, id) => `${mailboxPath(podPath, mb)}${id}.json`;

  /** List a mailbox container → message ids (filenames sans .json). 404 → []. */
  async function listMailbox(podPath, mb, auth) {
    const res = await lb(mailboxPath(podPath, mb), {
      headers: { accept: 'application/ld+json' }, auth,
    });
    if (res.status === 401 || res.status === 403) {
      throw methodError('forbidden', `not allowed to read mailbox ${mb.id}`);
    }
    if (!res.ok) return [];
    let container;
    try { container = await res.json(); } catch { return []; }
    const ids = [];
    for (const child of [].concat(container.contains ?? [])) {
      const cid = typeof child === 'string' ? child : child?.['@id'];
      const m = cid && /\/([^/]+)\.json$/.exec(cid);
      if (m) ids.push(m[1]);
    }
    return ids;
  }

  /** Read one message JSON out of a known mailbox. null if absent. */
  async function readEmailFrom(podPath, mb, id, auth) {
    const res = await lb(emailPath(podPath, mb, id), {
      headers: { accept: 'application/json' }, auth,
    });
    if (res.status === 401 || res.status === 403) {
      throw methodError('forbidden', `not allowed to read mailbox ${mb.id}`);
    }
    if (!res.ok) return null;
    try {
      const email = await res.json();
      return email && typeof email === 'object' ? email : null;
    } catch { return null; }
  }

  /** Find a message by id across the mailboxes. → { email, mb } | null. */
  async function findEmail(podPath, id, auth) {
    if (!SAFE_ID.test(String(id))) return null;
    for (const mb of MAILBOXES) {
      const email = await readEmailFrom(podPath, mb, id, auth);
      if (email) return { email, mb };
    }
    return null;
  }

  /** PUT a message JSON into a mailbox under the caller's own bearer. */
  async function writeEmail(podPath, mb, id, email, auth) {
    return lb(emailPath(podPath, mb, id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(email, null, 2),
      auth,
    });
  }

  /**
   * The state string: a hash over the four mailbox listings. Coarse but
   * honest — it changes on any create/move/destroy, but NOT on an in-place
   * content update, and computing it is 4 loopback listings per call. Real
   * (and cheap) state needs api.events.onResourceChange (see README).
   */
  async function mailState(podPath, auth) {
    const h = crypto.createHash('sha256');
    for (const mb of MAILBOXES) {
      const ids = await listMailbox(podPath, mb, auth);
      h.update(`${mb.id}:${ids.sort().join(',')};`);
    }
    return h.digest('hex').slice(0, 16);
  }

  // =========================================================== JMAP methods
  // Each handler: (ctx, args) → response args object, or throws
  // methodError(type) for a method-level ['error', ...] response.
  // ctx = { podPath, auth, accountId, state() } — state() memoizes the
  // mailbox-listing hash for the duration of one method call chain.

  async function mailboxGet(ctx, args) {
    const wanted = args.ids == null ? MAILBOXES.map((m) => m.id) : args.ids;
    if (!Array.isArray(wanted)) throw methodError('invalidArguments', 'ids must be an array or null');
    const list = [];
    const notFound = [];
    for (const id of wanted) {
      const mb = mailboxById(id);
      if (!mb) { notFound.push(id); continue; }
      const ids = await listMailbox(ctx.podPath, mb, ctx.auth);
      list.push({
        id: mb.id,
        name: mb.name,
        parentId: null,
        role: mb.role,
        sortOrder: MAILBOXES.indexOf(mb),
        totalEmails: ids.length,
        unreadEmails: 0, // keywords are stored but not aggregated (read-time O(N) cost)
        totalThreads: ids.length,
        unreadThreads: 0,
        myRights: {
          mayReadItems: true, mayAddItems: true, mayRemoveItems: true,
          maySetSeen: true, maySetKeywords: true, mayCreateChild: false,
          mayRename: false, mayDelete: false, maySubmit: false,
        },
        isSubscribed: true,
      });
    }
    return { accountId: ctx.accountId, state: await ctx.state(), list, notFound };
  }

  async function emailGet(ctx, args) {
    if (!Array.isArray(args.ids)) {
      throw methodError('invalidArguments', 'Email/get requires an ids array');
    }
    const props = Array.isArray(args.properties) ? args.properties : null;
    const list = [];
    const notFound = [];
    for (const id of args.ids) {
      const found = await findEmail(ctx.podPath, id, ctx.auth);
      if (!found) { notFound.push(id); continue; }
      const email = { ...found.email, id, mailboxIds: found.email.mailboxIds ?? { [found.mb.id]: true } };
      if (!props) { list.push(email); continue; }
      const picked = { id };
      for (const p of props) if (email[p] !== undefined) picked[p] = email[p];
      list.push(picked);
    }
    return { accountId: ctx.accountId, state: await ctx.state(), list, notFound };
  }

  async function emailQuery(ctx, args) {
    const filter = args.filter ?? {};
    if (typeof filter !== 'object' || Array.isArray(filter)) {
      throw methodError('unsupportedFilter', 'filter must be a FilterCondition object');
    }
    const unsupported = Object.keys(filter).filter((k) => k !== 'inMailbox');
    if (unsupported.length) {
      throw methodError('unsupportedFilter', `only inMailbox is supported (got ${unsupported.join(', ')})`);
    }
    let boxes = MAILBOXES;
    if (filter.inMailbox !== undefined) {
      const mb = mailboxById(filter.inMailbox);
      if (!mb) throw methodError('invalidArguments', `no such mailbox ${filter.inMailbox}`);
      boxes = [mb];
    }
    // Sort: receivedAt only; default newest-first. (JMAP comparators default
    // to ascending, so an explicit {property:'receivedAt'} sorts oldest-first.)
    let ascending = false;
    if (args.sort !== undefined) {
      if (!Array.isArray(args.sort) || args.sort.length !== 1
        || args.sort[0]?.property !== 'receivedAt') {
        throw methodError('unsupportedSort', 'only a single receivedAt comparator is supported');
      }
      ascending = args.sort[0].isAscending !== false;
    }
    // Read-time O(N): GET every message in scope to sort by receivedAt.
    // A write-time index is impossible without api.events (see README).
    const all = [];
    for (const mb of boxes) {
      const ids = await listMailbox(ctx.podPath, mb, ctx.auth);
      for (const id of ids) {
        const email = await readEmailFrom(ctx.podPath, mb, id, ctx.auth);
        if (email) all.push({ id, receivedAt: String(email.receivedAt ?? '') });
      }
    }
    all.sort((a, b) => (ascending ? 1 : -1) * a.receivedAt.localeCompare(b.receivedAt));
    const total = all.length;
    const position = Math.max(0, Number.isInteger(args.position) ? args.position : 0);
    const limit = Number.isInteger(args.limit) && args.limit >= 0 ? args.limit : total;
    return {
      accountId: ctx.accountId,
      queryState: await ctx.state(),
      canCalculateChanges: false, // Email/queryChanges needs api.events
      position,
      total,
      ids: all.slice(position, position + limit).map((e) => e.id),
    };
  }

  /** Resolve a mailboxIds map to its single target mailbox, or throw-shape. */
  function targetMailbox(mailboxIds) {
    if (!mailboxIds || typeof mailboxIds !== 'object' || Array.isArray(mailboxIds)) return null;
    const ids = Object.keys(mailboxIds).filter((k) => mailboxIds[k]);
    if (ids.length !== 1) return null; // maxMailboxesPerEmail: 1 (advertised in the session)
    return mailboxById(ids[0]) ?? null;
  }

  async function emailSet(ctx, args) {
    const oldState = await mailState(ctx.podPath, ctx.auth);
    const created = {};
    const notCreated = {};
    const updated = {};
    const notUpdated = {};
    const destroyed = [];
    const notDestroyed = {};

    // ------------------------------------------------------------- create
    for (const [cid, spec] of Object.entries(args.create ?? {})) {
      if (!spec || typeof spec !== 'object') {
        notCreated[cid] = { type: 'invalidProperties', description: 'creation object required' };
        continue;
      }
      const mb = targetMailbox(spec.mailboxIds);
      if (!mb) {
        notCreated[cid] = {
          type: 'invalidProperties',
          properties: ['mailboxIds'],
          description: 'mailboxIds must name exactly one of inbox/drafts/sent/trash',
        };
        continue;
      }
      const id = newEmailId();
      // threadId is degenerate: this server has no Thread/get, so every
      // message is its own single-message thread (threadId = the message id).
      // Persisting it keeps Email/get consistent with the create response.
      const email = { id, threadId: id, mailboxIds: { [mb.id]: true }, keywords: {} };
      for (const p of EMAIL_PROPS) if (spec[p] !== undefined) email[p] = spec[p];
      email.receivedAt = typeof spec.receivedAt === 'string' ? spec.receivedAt : new Date().toISOString();
      email.preview = previewOf(spec);
      // The stored representation is exactly what writeEmail PUTs — its byte
      // length is `size`, and its content hash is a stable blobId (there is no
      // separate blob store; the message JSON IS the blob).
      const stored = JSON.stringify(email, null, 2);
      const put = await writeEmail(ctx.podPath, mb, id, email, ctx.auth);
      if (put.status === 401 || put.status === 403) {
        notCreated[cid] = { type: 'forbidden' };
      } else if (!(put.ok || put.status === 204)) {
        notCreated[cid] = { type: 'serverFail', description: `pod storage rejected the message (${put.status})` };
      } else {
        // Echo EVERY server-set property the client didn't supply, per
        // RFC 8620 §5.3 / RFC 8621 §4.6 — a client caches these from the
        // response instead of re-fetching. blobId/threadId are degenerate but
        // stable and honest (see README Findings): no blob store, no threads.
        created[cid] = {
          id,
          blobId: crypto.createHash('sha256').update(stored).digest('base64url').slice(0, 24),
          threadId: id,
          size: Buffer.byteLength(stored),
          receivedAt: email.receivedAt,
          preview: email.preview,
        };
      }
    }

    // ------------------------------------------------------------- update
    // Supports mailboxIds (the move) and keywords, as whole properties or
    // "mailboxIds/<id>" / "keywords/<kw>" patch pointers. Nothing else.
    for (const [id, patch] of Object.entries(args.update ?? {})) {
      if (!patch || typeof patch !== 'object') {
        notUpdated[id] = { type: 'invalidProperties', description: 'patch object required' };
        continue;
      }
      const found = await findEmail(ctx.podPath, id, ctx.auth);
      if (!found) { notUpdated[id] = { type: 'notFound' }; continue; }
      const email = JSON.parse(JSON.stringify(found.email));
      email.mailboxIds = email.mailboxIds && typeof email.mailboxIds === 'object'
        ? email.mailboxIds : { [found.mb.id]: true };
      email.keywords = email.keywords && typeof email.keywords === 'object' ? email.keywords : {};
      const invalid = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'mailboxIds') email.mailboxIds = v;
        else if (k.startsWith('mailboxIds/')) {
          const box = k.slice('mailboxIds/'.length);
          if (v) email.mailboxIds[box] = true; else delete email.mailboxIds[box];
        } else if (k === 'keywords') email.keywords = v;
        else if (k.startsWith('keywords/')) {
          const kw = k.slice('keywords/'.length);
          if (v) email.keywords[kw] = true; else delete email.keywords[kw];
        } else invalid.push(k);
      }
      if (invalid.length) {
        notUpdated[id] = { type: 'invalidProperties', properties: invalid, description: 'only mailboxIds and keywords are updatable' };
        continue;
      }
      const dest = targetMailbox(email.mailboxIds);
      if (!dest) {
        notUpdated[id] = { type: 'invalidProperties', properties: ['mailboxIds'], description: 'mailboxIds must name exactly one of inbox/drafts/sent/trash' };
        continue;
      }
      email.mailboxIds = { [dest.id]: true };
      const put = await writeEmail(ctx.podPath, dest, id, email, ctx.auth);
      if (put.status === 401 || put.status === 403) { notUpdated[id] = { type: 'forbidden' }; continue; }
      if (!(put.ok || put.status === 204)) {
        notUpdated[id] = { type: 'serverFail', description: `pod storage rejected the update (${put.status})` };
        continue;
      }
      if (dest.id !== found.mb.id) {
        // The move: new copy is durable, now remove the old one.
        await lb(emailPath(ctx.podPath, found.mb, id), { method: 'DELETE', auth: ctx.auth });
      }
      updated[id] = null;
    }

    // ------------------------------------------------------------- destroy
    for (const id of [].concat(args.destroy ?? [])) {
      const found = await findEmail(ctx.podPath, id, ctx.auth);
      if (!found) { notDestroyed[id] = { type: 'notFound' }; continue; }
      const res = await lb(emailPath(ctx.podPath, found.mb, id), { method: 'DELETE', auth: ctx.auth });
      if (res.status === 401 || res.status === 403) { notDestroyed[id] = { type: 'forbidden' }; continue; }
      if (!(res.ok || res.status === 204)) {
        notDestroyed[id] = { type: 'serverFail', description: `pod delete failed (${res.status})` };
        continue;
      }
      destroyed.push(id);
    }

    return {
      accountId: ctx.accountId,
      oldState,
      newState: await mailState(ctx.podPath, ctx.auth),
      created, notCreated, updated, notUpdated, destroyed, notDestroyed,
    };
  }

  // Mailbox/Email `/changes` and Email/queryChanges: honestly refused, per
  // RFC 8620 §5.2 — delta sync from a coarse listing-hash state string is
  // not computable; the real fix is api.events.onResourceChange.
  const cannotCalculateChanges = () => {
    throw methodError('cannotCalculateChanges',
      'state strings are a coarse mailbox-listing hash; computing deltas '
      + 'needs a resource-change feed the plugin api does not expose '
      + '(api.events.onResourceChange)');
  };

  const METHODS = {
    'Mailbox/get': mailboxGet,
    'Email/get': emailGet,
    'Email/query': emailQuery,
    'Email/set': emailSet,
    'Mailbox/changes': cannotCalculateChanges,
    'Email/changes': cannotCalculateChanges,
    'Email/queryChanges': cannotCalculateChanges,
  };

  // ================================================================== routes

  api.fastify.options(`${prefix}/*`, (request, reply) => cors(reply).code(204).send());

  // RFC 8620 §2.2 autodiscovery — a fixed .well-known path OUTSIDE the
  // prefix, reachable only because core blanket-exempts /.well-known/* (the
  // by-luck reservePath finding; see README).
  api.fastify.get('/.well-known/jmap', (request, reply) => cors(reply)
    .code(301).header('location', `${baseUrl}${prefix}/session`).send());

  // ------------------------------------------------------------- session
  api.fastify.get(`${prefix}/session`, async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) {
      return problem(reply, 401, 'about:blank', 'authenticate with a pod Bearer token');
    }
    const { username } = podFromWebid(webid);
    const accountId = accountIdFor(webid);
    const mailCap = {
      maxMailboxesPerEmail: 1,
      maxMailboxDepth: 1,
      maxSizeMailboxName: 64,
      maxSizeAttachmentsPerEmail: 0, // no blobs — needs the raw-body-stream seam (#583)
      emailQuerySortOptions: ['receivedAt'],
      mayCreateTopLevelMailbox: false,
    };
    return json(reply, 200, {
      capabilities: {
        [CORE_URN]: {
          maxSizeUpload: 0, // no blob upload (see README: #583 raw-body seam)
          maxConcurrentUpload: 1,
          maxSizeRequest: 10 * 1024 * 1024,
          maxConcurrentRequests: 4,
          maxCallsInRequest: 16,
          maxObjectsInGet: 256,
          maxObjectsInSet: 128,
          collationAlgorithms: ['i;ascii-casemap'],
        },
        [MAIL_URN]: mailCap,
      },
      accounts: {
        [accountId]: {
          name: username,
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: { [CORE_URN]: {}, [MAIL_URN]: mailCap },
        },
      },
      primaryAccounts: { [MAIL_URN]: accountId },
      username: webid,
      apiUrl: `${baseUrl}${prefix}/api`,
      // downloadUrl/uploadUrl omitted: blobs/attachments are unimplemented
      // (multipart/binary upload needs the un-drained raw body stream, #583).
      // eventSourceUrl omitted: JMAP push needs api.events (see README).
      state: sessionStateStr,
    });
  });

  // ------------------------------------------------------------- api
  api.fastify.post(`${prefix}/api`, async (request, reply) => {
    const webid = await api.auth.getAgent(request);
    if (!webid) {
      return problem(reply, 401, 'about:blank', 'authenticate with a pod Bearer token');
    }

    // JSS parses application/json bodies into objects; anything else arrives
    // as a Buffer (server.js wildcard parser) — decode and be honest per
    // RFC 8620 §3.6.1 about which failure it is.
    let body = request.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        return problem(reply, 400, 'urn:ietf:params:jmap:error:notJSON',
          'the request body is not parseable JSON');
      }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !Array.isArray(body.using) || !Array.isArray(body.methodCalls)) {
      return problem(reply, 400, 'urn:ietf:params:jmap:error:notRequest',
        'the request body is not a JMAP Request object ({ using, methodCalls })');
    }
    const unknownCap = body.using.find((u) => u !== CORE_URN && u !== MAIL_URN);
    if (unknownCap !== undefined) {
      return problem(reply, 400, 'urn:ietf:params:jmap:error:unknownCapability',
        `capability ${String(unknownCap)} is not supported here`);
    }
    for (const call of body.methodCalls) {
      if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== 'string'
        || !call[1] || typeof call[1] !== 'object' || Array.isArray(call[1])
        || typeof call[2] !== 'string') {
        return problem(reply, 400, 'urn:ietf:params:jmap:error:notRequest',
          'each methodCall must be [name, arguments, callId]');
      }
    }

    const { podPath } = podFromWebid(webid);
    const accountId = accountIdFor(webid);
    const auth = request.headers.authorization;
    // Memoize the (4-listing) state hash per request; Email/set bypasses the
    // memo to report a true oldState/newState pair.
    let stateMemo = null;
    const ctx = {
      podPath,
      auth,
      accountId,
      state: async () => (stateMemo ??= await mailState(podPath, auth)),
    };

    const methodResponses = [];
    for (const [name, args, callId] of body.methodCalls) {
      // Back-references (#resultOf) are NOT implemented — a spec-honest
      // serverFail rather than a silent literal-`#` misread (see README).
      const backref = Object.keys(args).find((k) => k.startsWith('#'));
      if (backref) {
        methodResponses.push(['error', {
          type: 'serverFail',
          description: `back-references (${backref}) are not implemented by this server`,
        }, callId]);
        continue;
      }
      if (args.accountId !== undefined && args.accountId !== accountId) {
        methodResponses.push(['error', { type: 'accountNotFound' }, callId]);
        continue;
      }
      const handler = METHODS[name];
      if (!handler) {
        methodResponses.push(['error', { type: 'unknownMethod' }, callId]);
        continue;
      }
      if (name === 'Email/set') stateMemo = null; // it mutates; drop the memo
      try {
        methodResponses.push([name, await handler(ctx, args), callId]);
      } catch (e) {
        if (e?.jmap) methodResponses.push(['error', e.jmap, callId]);
        else {
          api.log.error(`jmap: ${name} failed: ${e?.message || e}`);
          methodResponses.push(['error', { type: 'serverFail', description: String(e?.message || e) }, callId]);
        }
      }
      if (name === 'Email/set') stateMemo = null; // state moved; recompute lazily
    }

    return json(reply, 200, { methodResponses, sessionState: sessionStateStr });
  });

  api.log.info(`jmap: session at ${prefix}/session, api at ${prefix}/api → `
    + `mail in <pod>/${MAIL_DIR}/ via ${loopback}; discovery /.well-known/jmap (301)`);
}
