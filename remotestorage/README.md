# remotestorage — a remoteStorage server over a pod

[remoteStorage](https://remotestorage.io/)
([draft-dejong-remotestorage-22](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage-22))
as a #206 loader plugin — the out-of-tree port of a feature JSS bundles in
core (`src/remotestorage.js`, always-on at `/storage/:user/*`) and that
issue #564's migration list names as a plugin candidate. Every rS document
is a plain pod resource at `/<user>/remotestorage/<category>/<path>`,
reached over loopback with the caller's own credentials, so real WAC — not
this plugin — decides every read and write.

```js
import { createServer } from 'javascript-solid-server/src/server.js';

const server = createServer({
  idp: true,
  plugins: [{
    id: 'remotestorage',
    module: './plugins/remotestorage/plugin.js',
    prefix: '/remotestorage',
    config: {
      baseUrl: 'https://pod.example',        // required: public origin
      loopbackUrl: 'http://127.0.0.1:3000',  // required: how to reach the host
      // dataDir: 'remotestorage',           // pod subfolder for the rS tree
      // claimWellKnown: false,              // stand down from /.well-known/webfinger
    },
  }],
});
```

## Surface

| route | what |
|---|---|
| `GET/HEAD/PUT/DELETE <prefix>/<user>/<category>/<path>` | the storage API → loopback LDP at `/<user>/remotestorage/<category>/<path>`, Authorization forwarded |
| `GET <prefix>/<user>/<folder>/` | rS folder description (`{"@context":"…/folder-description","items":{…}}`) from a loopback container listing, per-item host ETags |
| `POST <prefix>/token` | token bridge: `{username,password}` → the host's `/idp/credentials` → the pod bearer as the rS token |
| `GET <prefix>/webfinger?resource=acct:…` | the rS JRD (contract-safe mount) |
| `GET /.well-known/webfinger` | the same JRD at the real discovery location — claimed **unguarded** (see Findings #1); disable with `claimWellKnown: false` |

Anonymous `GET`/`HEAD` on `…/public/…` paths work iff the pod grants public
read (the anonymous loopback request decides — no plugin-side ACL logic).
Conditional requests (`If-Match`, `If-None-Match`, incl. `*`) are honored on
documents by forwarding them to the host, and on folders plugin-side.

## What maps / what doesn't

Maps cleanly:

- **Documents are pod resources.** PUT/GET/DELETE round-trip byte-for-byte;
  the ETags rS clients sync on are the host's own LDP ETags, passed through.
- **Access control is WAC.** The rS notion "the module folders this token
  may touch" degrades to "whatever the pod's ACLs allow this agent",
  which is strictly more expressive; `public/` anonymity falls out of a
  normal public-read `.acl`.
- **Conditional writes.** The host's LDP implements `If-Match` /
  `If-None-Match` on PUT and DELETE, so the rS concurrency contract is the
  host's, not a reimplementation (Findings #2).

Deviations:

- **No OAuth implicit-grant dialog.** rS clients expect to redirect a
  browser to an authorize UI scoped per module (`documents:rw`). A login UI
  is product-scale; this plugin ships the mastodon/-style shortcut instead:
  `POST <prefix>/token` bridges username+password to the host's
  `/idp/credentials` and returns the pod bearer verbatim. The JRD's
  `rfc6749#section-4.2` property points at that endpoint, so a stock rS
  widget's redirect will not find a form there. Scope strings are not
  interpreted at all — WAC governs instead.
- **WebFinger under the plugin's own prefix** (`<prefix>/webfinger`) is the
  contract-safe mount; the real `/.well-known/webfinger` is claimed
  by-luck and collides with any other webfinger owner (Findings #1).
- **Folder ETags are plugin-derived** (hash of the items map), not host
  ETags — measured reason in Findings #3, depth limitation in Findings #6.
- **Content types don't round-trip** for extension-less documents
  (Findings #5).
- Range requests are forwarded but unadvertised; web-authoring and
  querystring bearer tokens (`rfc6750#section-2.3`) are not supported
  (declared `null` in the JRD properties).

## Findings

### 1. HEADLINE — the `/.well-known/webfinger` collision, now WITNESSED

NOTES.md (seam 5) *predicted* that two plugins claiming the same
`.well-known` route would collide; it had never been witnessed because no
two co-loaded plugins wanted the same document. remoteStorage is the
natural second claimant — its clients discover storage via a JRD link in
exactly the file webfinger/ already serves. Both boots were measured:

- **webfinger/ first, remotestorage/ second → the boot FAILS.** This
  plugin registers `GET /.well-known/webfinger` unguarded, and Fastify
  refuses the duplicate. The error, verbatim as the test asserts it:

  ```
  plugin remotestorage: activate() failed: Method 'GET' already declared for route '/.well-known/webfinger'
  ```

  Note the loader's wrap (`plugin <id>: activate() failed: …`) preserves
  Fastify's message but **drops `err.code`** (`FST_ERR_DUPLICATED_ROUTE`),
  so operators and tests must match on the message text.
- **remotestorage/ first, webfinger/ second → the boot SUCCEEDS and
  webfinger/ silently loses.** webfinger/ wraps its claim in try/catch and
  degrades to prefix-only, so `/.well-known/webfinger` serves the
  remoteStorage JRD and every link webfinger/ would have contributed
  (profile-page, ActivityPub actor, OIDC issuer) is simply absent from the
  well-known document. No error, no warning a client ever sees. This is
  the *silent* form of the same collision NOTES.md predicted for links.

So the outcome is **order- and guarding-dependent**: unguarded claims fail
the boot loudly, guarded claims lose silently — both are wrong, because
both plugins are *legitimate* owners of parts of one discovery document. A
deployment today must choose ONE webfinger owner (`claimWellKnown: false`
here, or drop webfinger/) and lose the other's links. The missing seam is a
**link/JRD registry** — `api.webfinger.addLink(rel, buildLink)` or
equivalent — where the loader owns the route once and plugins contribute
links; that would dissolve both failure modes at once.

### 2. Conditional-write pass-through: the host honors it (measured)

`If-Match` and `If-None-Match` are forwarded verbatim over loopback and the
host's LDP handlers implement them: a stale `If-Match` PUT → **412** from
the host, `If-None-Match: *` on an existing document → **412**,
`If-None-Match: *` on a new path → 201, a stale `If-Match` DELETE →
**412**, and `If-None-Match: <etag>` GET → **304** — all asserted in
test.js with the refused bodies proven not to have landed. No plugin-side
conditional logic was needed for documents (folders are the exception,
finding #3). This is the best case for the loopback pattern: the rS
concurrency contract comes from the host for free, and it is atomic at the
host (a plugin-side check-then-write would race).

### 3. ETag provenance: host's for documents, hand-rolled for folders — and PUT/DELETE responses have none

- **Documents: pass-through.** GET/HEAD relay the host's own ETag
  (md5 of mtime+size, computed by core storage). The test proves the ETag
  served at `<prefix>/alice/…` is byte-identical to the one LDP serves at
  `/alice/remotestorage/…`.
- **But the host's PUT and DELETE responses carry NO ETag header** (LDP
  omits it), and rS requires one on both. The plugin therefore does a
  follow-up HEAD after PUT and a preceding HEAD before DELETE — one extra
  loopback round-trip per write, and not atomic: a concurrent write between
  PUT and HEAD reports the newer revision's ETag. A host that returned the
  new ETag on PUT (as its own bundled `src/remotestorage.js` does) would
  remove both the cost and the race.
- **Folders: hand-rolled, for a measured reason.** The host's directory
  ETag is directory-mtime-based, and overwriting an existing child updates
  the *file's* mtime, not the directory's — so passing it through would
  leave folder listings looking unchanged after every document update,
  breaking rS sync. The plugin instead hashes the items map
  (`"rs-<sha256(name→ETag pairs)>"`); the test asserts the folder ETag
  changes when a child is overwritten.

### 4. rS is a route-owning feature → plugin-able (7th port-shaped witness)

The whole protocol fit the public api: one prefix for the data plane, the
loopback pattern for storage and authorization, the mastodon/ token bridge
for auth, `.well-known` by-luck for discovery. Nothing needed an internal —
core's bundled `src/remotestorage.js` imports `storage/filesystem.js` and
`auth/token.js` directly, and every one of those uses was replaced by a
loopback HTTP call. That confirms #564's line again: remoteStorage OWNS its
routes, so it moves out-of-tree — the 7th route-owning bundled feature this
repo has ported. (Corollary: core currently serves `/storage/:user/*`
always-on; an operator running this plugin has two rS implementations up.
The migration list's point is that core's could be deleted.)

### 5. Content types don't round-trip (measured)

rS requires the stored `Content-Type` to be returned exactly. JSS stores
only bytes and derives the type from the file *extension* on every GET:
a document PUT as `text/csv` to an extension-less path comes back
`application/octet-stream` (asserted in test.js). Documents whose names
carry a truthful extension are fine; anything else loses its type. Fixing
this needs per-resource metadata the plugin api doesn't offer (a `.meta`
convention or host support) — same class of gap as backup/'s
"permissions don't round-trip".

### 6. Folder listings cost O(N) loopback HEADs, and depth ≥ 2 version propagation is unbuildable

The LDP container listing carries `stat:size` and `dcterms:modified` per
child but **no ETags**, so the plugin HEADs every child over loopback to
get per-item ETags that exactly match a direct GET of that document (the
property rS sync depends on — asserted in test.js). That is N+1 loopback
requests per folder listing. Worse, rS wants a *folder's* version to change
when **any descendant** changes; the items-hash folder ETag is correct for
direct children, but a change two levels down doesn't alter the
intermediate folder's host ETag (directory mtime), so it can't propagate
without a full recursive walk per request. A faithful implementation needs
either per-child ETags in the host's container listing (cheap host
affordance) or a write-time version index — which is blocked on the
**`api.events.onResourceChange`** seam, adding rS to notifications/,
sparql/, search/, matrix/ and backup/ as its 6th consumer.

### 7. Smaller notes

- `api.auth.getAgent` ended up **unused**: forwarding the caller's
  `Authorization` over loopback subsumes every authorization decision the
  data plane needs, and the token endpoint takes a password, not a token.
  The token bridge's server side is just `/idp/credentials` — another
  witness that a Solid bearer and a protocol token are the same thing.
- `<prefix>/token` and `<prefix>/webfinger` shadow pods named `token` /
  `webfinger` at the storage root — static routes beat the wildcard.
  Reserved names, documented here.
- The webfinger JRD is served for **any well-formed local part** (no
  `podsRoot` scan): the storage URL behind it 401/404s for pods that don't
  exist. webfinger/'s filesystem scan is the richer behavior; duplicating
  it here would have doubled exactly the code the collision shows should be
  a shared registry.
- The empty-folder case mirrors core's bundled rS: a folder that doesn't
  exist yet lists as `{}` with **no ETag**, so clients re-process it every
  cycle instead of getting a 304 that would skip their push logic.
