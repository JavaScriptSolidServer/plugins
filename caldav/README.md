# caldav — sync a pod calendar to phones & desktops

CalDAV ([RFC 4791](https://www.rfc-editor.org/rfc/rfc4791)) over a Solid pod as
a #206 loader plugin — the piece that completes the DAV family
([`webdav/`](../webdav) → [`carddav/`](../carddav) → `caldav/`). CalDAV *is*
WebDAV plus calendar semantics, so this is the `webdav/` bridge specialised for
events — the exact sibling of `carddav/` with calendar semantics substituted for
addressbook ones. Clients (iOS/macOS Calendar, Thunderbird) talk to
`/caldav/<path>` and every request is replayed as a Solid/LDP request against
the host over loopback HTTP, carrying the client's own credentials. The bridge
holds **no authority** — the host's real auth + WAC decide every call, so it
cannot disagree with the server's policy (the loopback pattern from
`notifications/`, generalised to the data plane by `webdav/`).

Each event is a `.ics` resource (iCalendar VEVENT, stored verbatim) under a
calendar container, e.g. `<pod>/calendar/`.

```js
plugins: [{ module: 'caldav/plugin.js', prefix: '/caldav',
            config: {
              baseUrl: 'https://pod.example',       // REQUIRED (finding 1)
              loopbackUrl: 'http://127.0.0.1:3000', // optional (defaults to baseUrl)
              calendar: 'calendar',                 // optional container name
              color: '#3b8ea5ff',                   // optional Apple calendar-color
            } }]
```

## Adding the account on a client

Get a pod Bearer token first (`POST /.pods` → `{ token }`). Because CalDAV
account dialogs only prompt for username + password, the bridge maps
**Basic → Bearer: any username, the token as the password.**

- **iOS / iPadOS** — Settings → Calendar → Accounts → Add Account → Other → Add
  CalDAV Account. Server: `pod.example` (or the full
  `https://pod.example/caldav/alice/calendar/`), User: anything, Password: the
  pod token. iOS probes `/.well-known/caldav` then discovers the calendar.
- **macOS Calendar** — Add Account → Other CalDAV Account, account type
  *Manual*: Server `pod.example`, same user/password.
- **Thunderbird** — New → Calendar → On the Network. Location:
  `https://pod.example/caldav/alice/calendar/` (or the well-known URL); it will
  ask for a username (anything) and password (the token).
- **DAVx5 (Android)** — Add account → *Login with URL and username*. Base URL:
  `https://pod.example/caldav/alice/calendar/`, username anything, password the
  token. DAVx5 also honours the `/.well-known/caldav` redirect.

A raw `Authorization: Bearer <token>` header is forwarded verbatim for clients
that can send one.

## The sync vertical slice

`OPTIONS` (advertises `calendar-access`) → `MKCALENDAR` the calendar → `PUT` a
VEVENT `.ics` (ETag returned) → `PROPFIND Depth 1` lists it with that ETag +
`text/calendar` → `GET` returns the VEVENT → `REPORT calendar-multiget` returns
it inside `<CAL:calendar-data>` → `DELETE` → it's gone from the next `PROPFIND`.
All driven with a real pod Bearer through real WAC in `test.js` (15 tests).

## What maps

| CalDAV / WebDAV | LDP over loopback | notes |
|---|---|---|
| `OPTIONS` | answered locally | `DAV: 1, 3, calendar-access`, `Allow`, `MS-Author-Via: DAV` |
| `PROPFIND` Depth 0/1 | `GET` (`Accept: ld+json`); `ldp:contains` → 207 | collection gets `<CAL:calendar/>` + `supported-calendar-component-set` (VEVENT); events get `getetag` + `getcontenttype: text/calendar` |
| `PROPFIND` discovery | derives pod from `api.auth.getAgent` | `current-user-principal`, `principal-URL`, `calendar-home-set` |
| `REPORT` `calendar-multiget` | `GET` per `<D:href>` | returns `getetag` + `<CAL:calendar-data>` |
| `REPORT` `calendar-query` | lists the collection | returns **all** events (filter not evaluated — below) |
| `GET`/`HEAD` `.ics` | `GET`/`HEAD`, body passthrough | `text/calendar`, content-hash `ETag` header |
| `PUT` `.ics` | `PUT` (auto-creates the container) | stores the VEVENT, returns content-hash `ETag` |
| `DELETE` `.ics` | `DELETE` | 204 |
| `MKCALENDAR` / `MKCOL` / extended MKCOL | `PUT` to the trailing-slash URL | 201; host 409 "exists" → 405; body accepted but its props dropped |
| `/.well-known/caldav` | 301 → `<prefix>/` (guarded attempt) | PROPFIND there serves discovery |

## What doesn't map

- **`calendar-query` filters** — the `<CAL:filter>` grammar (`comp-filter`,
  `time-range`, `prop-filter`, `text-match`) is **not evaluated**; a query
  returns every VEVENT in the collection and the client filters locally. Correct
  but not selective — the filter/time-range engine is a sensible follow-up, not
  "minimum usable sync".
- **Recurrence, free-busy, scheduling** — `RRULE` expansion, `calendar-data`
  with `<CAL:expand>`, `free-busy-query` REPORT, and the iTIP/iMIP scheduling
  inbox/outbox (RFC 6638) are all **out of scope**. Events are stored and served
  as opaque `.ics` bodies; a recurring VEVENT round-trips verbatim but the bridge
  does not expand or compute occurrences.
- **`sync-collection` / CTag** — no incremental sync token. Clients fall back to
  a full `PROPFIND` + ETag diff each poll, which works but is chattier. A real
  CTag/sync-token needs a change feed the plugin api doesn't expose
  (`api.events`, the same seam `notifications/`, `sparql/` and `carddav/` want).
- **VTODO / VJOURNAL** — only VEVENT is advertised in
  `supported-calendar-component-set`. Other components would be stored opaquely
  but the calendar declares itself events-only.
- **Multiple calendars / principal collection** — one calendar per pod (the
  container named by `config.calendar`); `calendar-home-set` points at the pod
  root and the named child is flagged as the calendar.
- **iCalendar validation / normalisation** — bodies are stored and returned
  byte-for-byte; the bridge does not parse or canonicalise iCalendar.
- **LOCK/UNLOCK/COPY/MOVE/PROPPATCH** — not part of the event-sync slice
  (`webdav/` documents the same class-1-only boundary).

## Findings

1. **The DAV-bridge generalisation is now proven 3×.** `caldav/` is `carddav/`
   with three mechanical substitutions: the `<CARD:addressbook/>` resourcetype →
   `<CAL:calendar/>`, `text/vcard`/`.vcf` → `text/calendar`/`.ics`, and the
   `addressbook-*` REPORT/discovery verbs → `calendar-*`. The entire transport —
   loopback with forwarded auth, `config.baseUrl`/`loopbackUrl`, hand-rolled
   multistatus XML, Basic→Bearer, the container-vs-resource HEAD sniff, the
   content-hash ETag, the guarded `/.well-known` claim — is **identical**. What
   `carddav/`'s finding 1 predicted ("CalDAV would be the same again") is now
   observed: the loopback-bridge shape is a reusable substrate for the **whole**
   WebDAV family (`webdav` + `carddav` + `caldav`), and each new member costs
   only its resourcetype + content-type + REPORT/discovery vocabulary. That the
   generalisation held a third time — with no new seam, no new import — is the
   finding.

2. **Same reserved-path finding, now confirmed across the whole DAV family.**
   RFC 6764 wants an absolute `/.well-known/caldav` that redirects to the
   calendar context. As with `nip05/` and `carddav/`: the loader does *not*
   confine `api.fastify` routes to the plugin prefix, and core's auth preHandler
   blanket-exempts `/.well-known/*`, so an exact-path `route()` registers, is
   reachable unauthenticated, and outranks core's LDP `GET /*` wildcard on
   specificity. Load-bearing accidents of core's routing, none promised by the
   plugin **contract**, so the registration is `try/catch`-guarded and treated as
   degraded-not-fatal (clients can always be pointed straight at
   `<prefix>/<pod>/<calendar>/`). Three plugins now depend on this same accident;
   a plugin-api way to *claim* a well-known name would turn it into a guarantee.

3. **Same ETag finding — the bridge owns the content hash — confirmed a third
   time.** Clients cannot sync without a strong per-event ETag on every surface
   (PUT response, PROPFIND `getetag`, GET header, REPORT), and the plugin api
   still exposes **no hook** onto whatever ETag core does or doesn't emit. So the
   bridge computes `"<sha256(bytes)>"` and, because it hashes the exact stored
   bytes, PUT/GET/PROPFIND/REPORT all report an *identical* ETag with no shared
   state. Cost, identically to `carddav/`: a Depth-1 PROPFIND and a
   `calendar-query` do one loopback `GET` per event to hash it. A core content
   hash on the listing — or an `api.storage` digest hook — would remove those N
   reads. Correctness win of hashing over an mtime ETag: an identical re-PUT is
   correctly seen as unchanged (matters for calendar clients that re-upload on
   every edit).

4. **Same `api.serverInfo` gap.** The plugin refuses to boot without
   `config.baseUrl` because the api exposes no server origin — the identical
   finding `webdav/`, `carddav/` and `notifications/` document. The
   probe-port-then-boot dance in `test.js` exists solely to feed the origin into
   config before `listen`.

5. **`MKCALENDAR` dispatches with no new seam.** `MKCALENDAR` is a CalDAV-only
   verb (RFC 4791), yet `api.fastify.route({ method: ['MKCALENDAR', …] })`
   registers and dispatches unchanged — `find-my-way` already lists it among the
   Node HTTP methods, extending `carddav/`'s "Fastify already routes the DAV
   verbs" (REPORT/PROPFIND/MKCOL) one verb further. Like extended MKCOL, its
   request body (calendar props: resourcetype, displayname,
   `supported-calendar-component-set`, `calendar-color`) is **accepted but
   dropped** — JSS has nowhere to persist those dead properties, so the calendar
   resourcetype is derived at read time from the container name instead. A dead-
   property store (`.meta`, the gap `webdav/` and `carddav/` both note) would let
   the calendar flag and colour be set explicitly rather than inferred/config-
   driven.

6. **Discovery reuses `api.auth.getAgent` verbatim.** `current-user-principal` /
   `calendar-home-set` must name a per-user URL; the bridge has no config-time
   knowledge of which pod a request belongs to, so it reads the caller's WebID
   from `api.auth.getAgent(request)` (the `#584` auth contract) and takes its
   first path segment as the pod. This is the one place CalDAV must *know the
   caller* rather than merely *forward the caller's bytes* — identical to
   `carddav/`, covered by the public auth seam with no reach into `src/`. (A
   `did:…` WebID has no pod path segment; there the discovery props fall back to
   echoing the requested path.)
