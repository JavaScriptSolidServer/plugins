# carddav — sync a pod addressbook to phones & desktops

CardDAV ([RFC 6352](https://www.rfc-editor.org/rfc/rfc6352)) over a Solid pod
as a #206 loader plugin, for [JSS #157](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/157).
CardDAV *is* WebDAV plus addressbook semantics, so this is the [`webdav/`](../webdav)
bridge specialised for contacts: clients (iOS/macOS Contacts, Thunderbird,
DAVx5) talk to `/carddav/<path>` and every request is replayed as a Solid/LDP
request against the host over loopback HTTP, carrying the client's own
credentials. The bridge holds **no authority** — the host's real auth + WAC
decide every call, so it cannot disagree with the server's policy (the loopback
pattern from `notifications/`, generalised to the data plane by `webdav/`).

Each contact is a `.vcf` resource (vCard 3.0/4.0, stored verbatim) under an
addressbook container, e.g. `<pod>/contacts/`.

```js
plugins: [{ module: 'carddav/plugin.js', prefix: '/carddav',
            config: {
              baseUrl: 'https://pod.example',       // REQUIRED (finding 1)
              loopbackUrl: 'http://127.0.0.1:3000', // optional (defaults to baseUrl)
              addressbook: 'contacts',              // optional container name
            } }]
```

## Adding the account on a client

Get a pod Bearer token first (`POST /.pods` → `{ token }`). Because CardDAV
account dialogs only prompt for username + password, the bridge maps
**Basic → Bearer: any username, the token as the password.**

- **iOS / iPadOS** — Settings → Contacts → Accounts → Add Account → Other →
  Add CardDAV Account. Server: `pod.example` (or the full
  `https://pod.example/carddav/alice/contacts/`), User: anything, Password: the
  pod token. iOS probes `/.well-known/carddav` then discovers the addressbook.
- **macOS Contacts** — Add Account → Other contacts account → CardDAV, account
  type *Manual*: Server `pod.example`, same user/password.
- **Thunderbird** — New → Address Book → CardDAV. Location:
  `https://pod.example/carddav/alice/contacts/` (or the well-known URL); it will
  ask for a username (anything) and password (the token).
- **DAVx5 (Android)** — Add account → *Login with URL and username*. Base URL:
  `https://pod.example/carddav/alice/contacts/`, username anything, password the
  token. DAVx5 also honours the `/.well-known/carddav` redirect.

A raw `Authorization: Bearer <token>` header is forwarded verbatim for clients
that can send one.

## The sync vertical slice

`OPTIONS` (advertises `addressbook`) → `MKCOL` the book → `PUT` a vCard (ETag
returned) → `PROPFIND Depth 1` lists it with that ETag + `text/vcard` → `GET`
returns the body → `REPORT addressbook-multiget` returns it → `DELETE` → it's
gone from the next `PROPFIND`. All driven with a real pod Bearer through real
WAC in `test.js` (15 tests).

## What maps

| CardDAV / WebDAV | LDP over loopback | notes |
|---|---|---|
| `OPTIONS` | answered locally | `DAV: 1, 3, addressbook`, `Allow`, `MS-Author-Via: DAV` |
| `PROPFIND` Depth 0/1 | `GET` (`Accept: ld+json`); `ldp:contains` → 207 | collection gets `<CARD:addressbook/>`; contacts get `getetag` + `getcontenttype: text/vcard` |
| `PROPFIND` discovery | derives pod from `api.auth.getAgent` | `current-user-principal`, `principal-URL`, `addressbook-home-set` |
| `REPORT` `addressbook-multiget` | `GET` per `<D:href>` | returns `getetag` + `<CARD:address-data>` |
| `REPORT` `addressbook-query` | lists the collection | returns **all** vCards (filter not evaluated — below) |
| `GET`/`HEAD` `.vcf` | `GET`/`HEAD`, body passthrough | `text/vcard`, content-hash `ETag` header |
| `PUT` `.vcf` | `PUT` (auto-creates the container) | stores the vCard, returns content-hash `ETag` |
| `DELETE` `.vcf` | `DELETE` | 204 |
| `MKCOL` / extended MKCOL | `PUT` to the trailing-slash URL | 201; host 409 "exists" → 405; extended-MKCOL body accepted but its props dropped |
| `/.well-known/carddav` | 301 → `<prefix>/` (guarded attempt) | PROPFIND there serves discovery |

## What doesn't map

- **`addressbook-query` filters** — the `<CARD:filter>` grammar
  (`prop-filter`, `text-match`, `param-filter`) is **not evaluated**; a query
  returns every vCard in the collection and the client filters locally. Correct
  but not selective — the filter engine is a sensible follow-up, not "minimum
  usable sync".
- **`sync-collection` / CTag** — no incremental sync token. Clients fall back to
  a full `PROPFIND` + ETag diff each poll, which works but is chattier. A real
  CTag/sync-token needs a change feed the plugin api doesn't expose
  (`api.events`, the same seam `notifications/` and `sparql/` want).
- **Multiple addressbooks / principal collection** — one addressbook per pod
  (the container named by `config.addressbook`); `addressbook-home-set` points
  at the pod root and the named child is flagged as the addressbook.
- **vCard validation / normalisation** — bodies are stored and returned
  byte-for-byte; the bridge does not parse or canonicalise vCard.
- **LOCK/UNLOCK/COPY/MOVE/PROPPATCH** — not part of the contact-sync slice
  (`webdav/` documents the same class-1-only boundary).

## Findings

1. **Reuse: CardDAV is `webdav/` + a resourcetype + a REPORT.** The whole
   transport — loopback with forwarded auth, `config.baseUrl`/`loopbackUrl`,
   hand-rolled multistatus XML, Basic→Bearer, the container-vs-resource HEAD
   sniff — is `webdav/` verbatim. CardDAV adds exactly three things: the
   `<CARD:addressbook/>` resourcetype on one container, `getetag`/`text/vcard`
   on `.vcf` children, and the `REPORT` verb carrying `<CARD:address-data>`.
   That the port is this thin is itself the finding: the loopback-bridge shape
   generalises across the whole WebDAV family (CalDAV #… would be the same
   again).

2. **ETag generation without a core hook — the bridge owns it.** Clients cannot
   sync without a strong per-contact ETag on every surface (PUT response,
   PROPFIND `getetag`, GET header, REPORT), and the plugin api exposes **no hook
   onto whatever ETag core does or doesn't emit** for a resource. So the bridge
   computes its own — `"<sha256(bytes)>"` — and because it hashes the exact
   stored bytes, PUT, GET, PROPFIND and REPORT all report an *identical* ETag
   for identical content, with no shared state to keep in sync. Cost: a Depth-1
   PROPFIND and an `addressbook-query` do one loopback `GET` per contact to hash
   it (JSS's container JSON-LD carries `stat:size`/`dcterms:modified` but not a
   content hash). A core `ETag`/content-hash exposed on the listing — or an
   `api.storage` digest hook — would remove those N extra loopback reads. Note a
   subtle correctness win of hashing over reusing an mtime-based ETag: identical
   re-PUTs are correctly seen as unchanged.

3. **The `/.well-known/carddav` reserved-path attempt works today but on
   borrowed ground — same accident `nip05/` documented.** RFC 6764 discovery
   wants an absolute `/.well-known/carddav` that redirects to the addressbook
   context. A plugin is mounted under **one** prefix, yet the loader does *not*
   confine `api.fastify` routes to that prefix, and core's auth preHandler
   blanket-exempts `/.well-known/*` — so an exact-path `route()` registers, is
   reachable unauthenticated, and outranks core's LDP `GET /*` wildcard on
   specificity. All load-bearing accidents of core's current routing, none
   promised by the plugin **contract**, so the registration is wrapped in
   `try/catch` and treated as degraded-not-fatal: clients can always be pointed
   straight at `<prefix>/<pod>/<addressbook>/`. A plugin-api way to *claim* a
   well-known name (or declare extra unauthenticated paths) would turn this
   accident into a guarantee.

4. **Discovery needs the pod identity, and `api.auth.getAgent` supplies it.**
   `current-user-principal` / `addressbook-home-set` must name a per-user URL,
   but the bridge has no config-time knowledge of *which* pod a request belongs
   to. `api.auth.getAgent(request)` (the documented `#584` auth contract)
   returns the caller's WebID; its first path segment is the pod, which the
   bridge turns into `<prefix>/<pod>/`. This is the one place CardDAV needs to
   *know the caller* rather than merely *forward the caller's bytes* — and the
   public auth seam covered it without reaching into `src/`. (A `did:…` WebID has
   no pod path segment; there the discovery props fall back to echoing the
   requested path.)

5. **vCard ↔ LDP is low-friction — a `.vcf` is just an opaque resource.** Unlike
   a Turtle/JSON-LD contact, a vCard body has no LDP-native representation to
   reconcile: the bridge stores and serves the exact bytes with
   `Content-Type: text/vcard`. The only awkwardness is collection *identity* —
   an addressbook is "a container whose name is `contacts`" (config-driven),
   because JSS has nowhere to persist the `<CARD:addressbook/>` resourcetype an
   extended-MKCOL would set. So the resourcetype is **derived at read time from
   the container name**, and the extended-MKCOL request body is accepted but its
   props are dropped. A dead-property store (`.meta`, the same gap `webdav/`
   notes) would let the addressbook flag be set explicitly instead of inferred.

6. **Fastify 4 already dispatches `REPORT`.** `REPORT` is a CardDAV/CalDAV verb,
   not plain WebDAV, yet `api.fastify.route({ method: ['REPORT', …] })`
   registers and dispatches with no new seam (verified by injection and by the
   live tests) — the same "Fastify already routes the DAV verbs" observation
   `webdav/` finding 5 makes, extended one verb further. Request bodies for
   `REPORT`/`PROPFIND` arrive via the host's inherited catch-all content-type
   parser, so the plugin reads `request.body` (Buffer) directly; a plugin-api
   guarantee about body parsing would make that less incidental.
