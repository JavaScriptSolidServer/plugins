# webfinger — WebFinger (RFC 7033) discovery plugin

Out-of-tree take on the WebFinger half of JSS
[#164](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/164):
serve [WebFinger](https://www.rfc-editor.org/rfc/rfc7033)
(`GET /.well-known/webfinger?resource=acct:<user>@<host>`) for every pod, as
an **always-on** endpoint independent of `--activitypub`. WebFinger is the
resolver the fediverse and Solid-OIDC both lean on: it turns an `acct:`
handle (or a WebID URL) into a pod's actor URL, profile page, and IdP
issuer. Like nip05/, the port's real subject is the path —
`/.well-known/webfinger` is a fixed absolute location, and a plugin owns
exactly one mount prefix.

```js
plugins: [{ module: 'webfinger/plugin.js', prefix: '/webfinger',
            config: {
              podsRoot: './data',                 // pod dirs to scan (finding 3)
              baseUrl: 'https://pod.example',      // origin for JRD URLs (required)
              actorPathTemplate: '/<user>/actor',  // optional; '' / null omits `self`
            } }]
```

## The JRD it returns

`GET /.well-known/webfinger?resource=acct:alice@pod.example` →

```json
{
  "subject": "acct:alice@pod.example",
  "aliases": [
    "https://pod.example/alice/profile/card#me",
    "https://pod.example/alice/profile/card"
  ],
  "links": [
    { "rel": "http://webfinger.net/rel/profile-page",
      "type": "text/html",
      "href": "https://pod.example/alice/profile/card" },
    { "rel": "self",
      "type": "application/activity+json",
      "href": "https://pod.example/alice/actor" },
    { "rel": "http://openid.net/specs/connect/1.0/issuer",
      "href": "https://pod.example" }
  ]
}
```

- **subject** — echoes the queried `resource` verbatim (RFC 7033 §4.4).
- **aliases** — the pod's WebID (`…/profile/card#me`) and its profile page
  (`…/profile/card`).
- **`rel="…/rel/profile-page"`** — the pod's human-readable profile.
- **`rel="self"` type `application/activity+json`** — the pod's ActivityPub
  actor (`<baseUrl><actorPathTemplate>`). This is the link Mastodon/AP
  clients follow. Omitted if `actorPathTemplate` is set to `''`/`null` (a
  deployment with no AP actors — the issue's "IF applicable").
- **`rel="…/connect/1.0/issuer"`** — the IdP issuer (`baseUrl`), so
  Solid-OIDC relying parties and remoteStorage clients discover the pod's
  issuer off the *same* document (#164's point: one endpoint, many
  protocols, each contributing its own link relation).

Resolution:

- **`acct:<user>@<host>`** — the pod is resolved from the local part
  `<user>` by scanning `config.podsRoot` for a pod dir with a WebID card
  (`<user>/profile/card.jsonld`), exactly as nip05/ scans. The `<host>` is
  not matched against `baseUrl` — path-mode pods share one host and the
  handle's host is advisory.
- **`resource=<webid-url>`** — the path locates the pod
  (`…/<user>/profile/card` → `<user>`; `…/profile/card` → single-user).
- **single-user layout** — a card at the podsRoot itself resolves to the
  one pod at `/`.
- Pods are scanned **fresh per request**, so pods provisioned after boot
  resolve immediately. Unknown users → **404** (RFC 7033 §4.5); a missing
  `resource` → **400** (§4.2). `Access-Control-Allow-Origin: *` on every
  response (fediverse clients are browsers/bots with no credentials, §5).
- Served at **both** `/.well-known/webfinger` (attempted; see finding 1)
  and `<prefix>/webfinger` (always).

## Fediverse & Solid integration

This plugin is the missing front door for the mastodon/ and bluesky/ shims.
A Mastodon client resolving `@alice@pod.example` first fetches
`/.well-known/webfinger?resource=acct:alice@pod.example`, follows the
`self` link to `…/alice/actor`, and only then talks the API the mastodon/
shim serves. Without WebFinger the handle is unresolvable; with it, the pod
becomes a first-class fediverse actor address. The same document's issuer
link is what a Solid-OIDC RP or a remoteStorage app (#164's other callers)
reads to bootstrap auth — which is precisely why #164 wants WebFinger
lifted out of `--activitypub` into an always-on, multi-protocol plugin.

## Findings

1. **A plugin can serve a well-known path — but only by accident (shared
   with nip05).** `/.well-known/webfinger` lies outside any prefix a plugin
   can mount on, yet `api.fastify.get('/.well-known/webfinger', h)` works —
   registered at the absolute path, served, and served *unauthenticated*
   (the test proves an anonymous 200 against a server whose default is not
   public-read). Every link in that chain is the *same* accident nip05/
   documents, not the plugin contract:
   - the loader hands plugins the real scoped Fastify instance and does not
     confine routes to `prefix`;
   - the route only wins because core's GET there is the LDP wildcard
     `GET /*`, which an exact path outranks — had core also claimed an exact
     `GET /.well-known/webfinger`, this registration would throw
     `FST_ERR_DUPLICATED_ROUTE` at boot, so it is wrapped in try/catch and
     degrades to prefix-only;
   - it is WAC-exempt only because core's auth preHandler blanket-skips
     `/.well-known/*`; the loader's own exemption covers `prefix` alone.

   **This is the load-bearing observation for #164.** WebFinger and nip05
   are the *two most-wanted* `.well-known` documents a JSS deployment
   serves (fediverse/OIDC discovery, and Nostr identity) — and **both are
   plugin-served purely by luck**, resting on the identical undocumented
   routing coincidence. Two independent, high-value endpoints hitting the
   same wall is the strongest case yet for a first-class
   `api.reservePath('/.well-known/webfinger')` (or `wellKnown: [...]` /
   `paths: [...]` in the plugin entry): the loader would reserve the route,
   fail informatively on conflicts with core or other plugins, and extend
   the auth exemption deliberately instead of by coincidence. #164's own
   framing — "AP, RS, and future protocols register their own links" —
   presumes a *contended*, reservable endpoint; today that contention is
   silent and undetectable (see finding 2).

2. **Multi-protocol link contention is undetectable.** #164 wants AP, RS,
   and OIDC to each contribute link relations to one WebFinger document. On
   the current api there is no registry: this plugin owns the whole route
   and hardcodes the three relations. A second plugin wanting to add its own
   `rel` would have to register the *same* absolute path and lose to
   `FST_ERR_DUPLICATED_ROUTE` — there is no `api.webfinger.addLink(rel, …)`
   seam. The same reserved-path/registry seam from finding 1 is what would
   let the endpoint actually be the shared, extensible surface the issue
   describes.

3. **`config.podsRoot` / `baseUrl` repetition (as in nip05, notifications,
   mastodon, webdav).** A plugin cannot learn the data root or the server's
   own origin, so the operator repeats both in config. Here `baseUrl` is a
   hard requirement — every URL in a JRD (WebID, profile page, actor,
   issuer) is absolute against it — so unlike nip05 the plugin *hard-fails*
   boot without it. `podsRoot` is the same repetition nip05 documents, with
   the same failure mode: point it at the wrong directory and every lookup
   confidently 404s while the rest of the server works.
   `api.storage.serverRoot` and `api.serverInfo` (both read-only) remain the
   candidate seams.
