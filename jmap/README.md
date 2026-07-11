# jmap — a minimal JMAP server over a Solid pod

A JMAP server ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) core + a
useful slice of [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621) mail) as
a #206 loader plugin. Messages are plain JSON resources in the caller's own
pod; mailboxes are pod containers; the JMAP access token is the caller's
pod Bearer, verbatim.

```js
import { createServer } from 'javascript-solid-server/src/server.js';

createServer({
  idp: true, // the token the client sends is a pod bearer from /idp/credentials
  plugins: [{
    id: 'jmap',
    module: 'plugins/jmap/plugin.js',
    prefix: '/jmap',
    config: {
      baseUrl: 'https://pods.example',      // public origin (session urls, redirect)
      loopbackUrl: 'http://127.0.0.1:3000', // how the plugin reaches its own host
    },
  }],
});
```

No `appPaths` widening is needed (see Findings #3): everything lives under
the one `prefix` except `/.well-known/jmap`, which rides core's blanket
`/.well-known/*` exemption.

## The mapping

| JMAP | pod |
|---|---|
| Account | the caller's pod; `accountId` = stable hash of the WebID |
| Mailbox | a container under `<pod>/private/mail/` — `Inbox`, `Drafts`, `Sent`, `Trash` (ids `inbox`/`drafts`/`sent`/`trash`; created by the pod on first PUT) |
| Email | one JSON resource `<mailbox>/<id>.json` holding the JMAP Email fields |
| move (Email/set update `mailboxIds`) | PUT into the new container, DELETE from the old |
| destroy | DELETE |
| state strings | a hash of the four mailbox listings (coarse — see Findings #2) |

Auth is the token bridge, as in mastodon/ bluesky/ matrix/ micropub/: a
JMAP token and a pod bearer are the same kind of thing, so the bridge is
the identity function. Every pod read/write goes over loopback with the
caller's own `Authorization` forwarded — real WAC decides every operation,
not this shim.

## A curl session

```sh
# mint a pod bearer (the JMAP token)
TOKEN=$(curl -s -X POST http://localhost:3000/idp/credentials \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"..."}' | jq -r .access_token)

# autodiscovery: RFC 8620 §2.2 — 301 to the Session resource
curl -si http://localhost:3000/.well-known/jmap | grep -i location
#   location: http://localhost:3000/jmap/session

# the session object: capabilities, one account, apiUrl
curl -s http://localhost:3000/jmap/session -H "authorization: Bearer $TOKEN" | jq .

# create a message in the Inbox
curl -s -X POST http://localhost:3000/jmap/api \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [["Email/set", { "create": { "m1": {
    "mailboxIds": { "inbox": true },
    "from": [{ "name": "Alice", "email": "alice@example.org" }],
    "to":   [{ "name": "Bob",   "email": "bob@example.org" }],
    "subject": "Hello JMAP",
    "bodyValues": { "b": { "value": "Mail as JSON in a pod." } },
    "textBody": [{ "partId": "b", "type": "text/plain" }]
  }}}, "c1"]]
}' | jq '.methodResponses[0]'

# query the Inbox (receivedAt desc), read the message back
curl -s -X POST http://localhost:3000/jmap/api \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Email/query", { "filter": { "inMailbox": "inbox" } }, "q"],
    ["Email/get",   { "ids": ["<id from q>"] }, "g"]
  ]
}' | jq '.methodResponses'

# move to Trash, then destroy
#   Email/set update: { "<id>": { "mailboxIds": { "trash": true } } }
#   Email/set destroy: ["<id>"]
```

The stored resource is readable as a plain pod document too — `GET
/alice/private/mail/Inbox/<id>.json` is the same message.

## What maps

- **Session** (`GET /jmap/session`, authed): capabilities
  (`urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`), exactly one
  account (the caller's pod), `apiUrl`, coarse `state`.
- **`POST /jmap/api`** with `{ using, methodCalls }` →
  `{ methodResponses, sessionState }`, request-level failures as RFC 7807
  problem+json (`notJSON`, `notRequest`, `unknownCapability`).
- **Mailbox/get** — the four role mailboxes with live `totalEmails`.
- **Email/get** — ids → objects, with `properties` filtering.
- **Email/query** — `filter: { inMailbox }`, `receivedAt` sort (default
  newest-first), `position`/`limit` paging, `total`.
- **Email/set** — create (PUT into the mailbox container), update
  (`mailboxIds` move as whole-property or `mailboxIds/<id>` patch pointer;
  `keywords` likewise), destroy (DELETE). Per-object failures use the spec
  SetError shapes (`invalidProperties`, `notFound`, `forbidden`).
- **Method-level errors** per RFC 8620 §3.6.2: `unknownMethod`,
  `invalidArguments`, `unsupportedFilter`, `unsupportedSort`,
  `accountNotFound`, `forbidden`, `serverFail`.
- **Autodiscovery**: `GET /.well-known/jmap` → `301` to the session URL.

## What doesn't (all deliberate, all documented)

- **No push**: `eventSourceUrl` is omitted from the session.
  `Mailbox/changes`, `Email/changes`, `Email/queryChanges` return
  `cannotCalculateChanges` (the spec's own escape hatch). See Findings #2.
- **No back-references**: `#resultOf` arguments return `serverFail` with an
  explanatory description rather than being silently misread. A JMAP client
  that chains `Email/query → Email/get` in one request must send two.
- **No blobs/attachments**: `uploadUrl`/`downloadUrl` are omitted;
  `maxSizeUpload: 0` and `maxSizeAttachmentsPerEmail: 0` are advertised
  honestly. Binary upload wants the un-drained raw-body-stream seam (#583)
  — the same wall as micropub's media endpoint. See Findings #5.
- **No threads** (`Thread/get`), no `Email/import`, no
  `EmailSubmission/*` — this stores and organizes mail; it does not send
  SMTP. `Email/set` create still returns the RFC 8621 §4.6 server-set
  properties (`id`, `blobId`, `threadId`, `size`) so a client can cache them
  without a re-fetch, but two are **degenerate and documented**: `threadId`
  equals the message id (every message is its own single-message thread,
  since there is no `Thread/get`), and `blobId` is a SHA-256 hash of the
  stored message JSON (there is no separate blob store — the JSON resource
  *is* the blob; see also Findings #5). `size` is the honest byte length of
  that stored representation.
- **One mailbox per message** (`maxMailboxesPerEmail: 1`, advertised): a
  message is one resource in one container, so JMAP's "email in several
  mailboxes at once" doesn't map to LDP containment.
- **In-place updates don't move the state string**: the state hash is over
  mailbox *listings*, so a keywords-only update leaves it unchanged. Coarse
  but honest — and advertised as such via `cannotCalculateChanges`.

## Findings

1. **JMAP's stateless slice fits the plugin api exactly — and that sharpens
   matrix/'s line.** matrix/ found that a chat protocol's `/sync` long-poll
   needs server-side cursors and live push, so a stateless bridge can only
   do full-state sync. JMAP is the controlled experiment from the other
   side: it is *email* — the poster child of stateful server-push protocols
   (IMAP IDLE) — redesigned by the IETF as stateless request/response, and
   the entire redesigned core (session, batched method calls, coarse state
   strings, polling) bridged onto loopback pod I/O with **zero**
   approximation. What makes a protocol pluggable is not its domain
   ("email", "chat") but one property: **no server push**. IMAP could never
   be this plugin; JMAP minus its optional push extension can, faithfully.
2. **Push and delta sync are blocked on `api.events.onResourceChange` — the
   6th independent consumer** (after notifications/, sparql/, search/,
   matrix/, backup/). Two distinct JMAP features die on the same missing
   seam: (a) `eventSourceUrl` — JMAP push is an EventSource stream of
   `StateChange` objects, which needs a resource-change feed to emit from;
   (b) `*/changes` + `Email/queryChanges` — honest delta responses need
   either an event-fed change log or write-time state counters, neither of
   which a read-time-only plugin can keep. Today's state strings are a hash
   of the mailbox listings recomputed per request — 4 loopback listings per
   state, blind to in-place edits — and the spec's `cannotCalculateChanges`
   is the only honest answer. The same seam also forces Email/query to be
   read-time O(N) (GET every message to sort by `receivedAt`), like
   sparql/ and rss/.
3. **`/.well-known/jmap` works by core's blanket exemption — another
   by-luck witness for `api.reservePath`,** joining nip05/, webfinger/, the
   DAV trio, and matrix/'s `/.well-known/matrix/client`. RFC 8620 pins
   autodiscovery at that exact path; the plugin registers it outside its
   prefix and it is reachable only because core happens to WAC-exempt
   `/.well-known/*` — coincidence, not contract. The counter-face of the
   same finding: JMAP needs **no** `appPaths` at all (unlike
   mastodon/bluesky/matrix), because the session document makes every other
   URL client-discovered — same family as micropub/. So the reservePath
   seam is really about *protocol-pinned* paths, and JMAP pins exactly one.
4. **The token bridge, 5th protocol witness** (after mastodon/ OAuth,
   bluesky/ XRPC sessions, matrix/ access_tokens, micropub/ IndieAuth):
   RFC 8620 §8.2's Bearer token and a Solid pod bearer are the same kind of
   thing, so the bridge is the identity function — `api.auth.getAgent`
   resolves it, loopback forwards it, WAC decides. Five protocols in, this
   is a law of the repo, not a trick.
5. **Blobs want the raw-body-stream seam (#583).** JMAP attachments are
   uploaded as raw binary to `uploadUrl` and referenced by blobId. JSS's
   wildcard parser buffers non-JSON bodies, and a plugin cannot receive an
   un-drained stream — the same wall as micropub's media endpoint and
   gitscratch's pack streams. `uploadUrl` is therefore omitted and
   `maxSizeUpload: 0` advertised, which conforming clients respect.
6. **JMAP's error model rewards the honest bridge.** Unlike most protocols
   ported here, RFC 8620 gives first-class vocabulary for *declared*
   inability: `cannotCalculateChanges`, capability ceilings
   (`maxSizeUpload: 0`, `maxMailboxesPerEmail: 1`), omittable session urls.
   The gaps in this plugin are advertised in-protocol rather than
   documented beside it — a spec designed for partial servers is a spec a
   pod bridge can implement without lying.
