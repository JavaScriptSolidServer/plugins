# nip05 — NIP-05 identity mapping plugin

Out-of-tree take on JSS [#445](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/issues/445):
serve [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md)
(`GET /.well-known/nostr.json?name=<name>`) for every pod whose **public**
WebID profile carries a provisioned Nostr owner key (#437/#443). The port's
real subject is the path: `/.well-known/nostr.json` is a fixed absolute
location, and a plugin owns exactly one mount prefix.

```js
plugins: [{ module: 'nip05/plugin.js', prefix: '/nip05',
            config: {
              podsRoot: './data',                    // pod dirs to scan (finding 3)
              relayUrl: 'wss://pod.example/relay',   // optional → relays block
              rootName: '_',                         // optional; single-user name
            } }]
```

Response shape, aggregated across pods (path-mode semantics from the issue):

```json
{ "names":  { "alice": "<pubkey-hex>", "_": "<pubkey-hex>" },
  "relays": { "<pubkey-hex>": ["wss://pod.example/relay"] } }
```

- `names.<pod>` — one entry per `<podsRoot>/<pod>/profile/card.jsonld` whose
  `verificationMethod` yields a valid secp256k1 pubkey (f-form
  `publicKeyMultibase` preferred, `publicKeyJwk` fallback; keys are checked
  on-curve with @noble/curves before being advertised).
- `names._` — a card at the podsRoot itself (single-user layout) maps to
  NIP-05's reserved `_` name, matching core's #446 MVP.
- `?name=<n>` returns just that mapping; unknown names get `{ "names": {} }`.
- `relays` appears only when `config.relayUrl` is set, keyed by the pubkeys
  actually listed in the (possibly filtered) response.
- Pods scanned fresh per request — pods provisioned after boot appear
  immediately. `Access-Control-Allow-Origin: *` per the NIP-05 spec.
- Served at **both** `/.well-known/nostr.json` (attempted; see finding 1)
  and `<prefix>/nostr.json` (always).
- No `podsRoot` → the plugin still activates and serves a valid empty
  `{ "names": {} }`, with a loud warning. Chosen over notifications'
  hard-fail because an empty NIP-05 document is well-formed and harmless,
  and a purely additive discovery feature shouldn't refuse the whole boot.

## Findings

1. **A plugin can serve a well-known path — but only by accident.** The
   headline question: `/.well-known/nostr.json` lies outside any prefix a
   plugin can be mounted on. It turns out
   `api.fastify.get('/.well-known/nostr.json', h)` **works** — registered at
   the absolute path, served, and served *unauthenticated* (the test proves
   an anonymous 200 against a server whose default is not public-read). But
   every link in that chain is an accident of core's current internals, not
   the plugin contract:
   - the loader hands plugins the real scoped Fastify instance and does
     not confine routes to `prefix` — nothing documents that routes outside
     the mount are allowed (or will stay allowed);
   - the route only wins because core's own GET at that path is the LDP
     wildcard `GET /*`, which an exact path outranks. Core already registers
     *exact* PUT/POST/PATCH/DELETE/OPTIONS blocks at
     `/.well-known/nostr.json` (server.js, #446) — had it also claimed GET,
     the plugin's registration would throw `FST_ERR_DUPLICATED_ROUTE` at
     boot. The plugin therefore wraps the registration in try/catch and
     degrades to prefix-only;
   - it is WAC-exempt only because core's auth preHandler blanket-skips
     `/.well-known/*` as the spec public namespace. The loader's own
     exemption covers `prefix` alone — a plugin claiming any *other*
     absolute path would find it behind WAC.
   Candidate seam: let a plugin entry declare
   `wellKnown: ['nostr.json']` (or a general `paths: [...]`) so the loader
   reserves the route, fails informatively on conflicts with core or other
   plugins, and extends the exemption deliberately instead of by
   coincidence.
2. **Collision with core's own NIP-05 is undetectable.** Core's #446 MVP
   *writes a static file* at `<root>/.well-known/nostr.json` when running
   `--provision-keys`; the LDP wildcard serves it. This plugin's exact-path
   GET silently shadows that file — first-class route beats wildcard, no
   error, no warning. Operator running both gets the plugin's aggregated
   answer and may never notice the core-written file is dead. Same seam as
   finding 1: reserved paths would turn the silent shadow into a boot-time
   conflict report.
3. **`config.podsRoot` repetition, third time** (see notifications
   findings 1–2, tunnel). A plugin cannot learn the data root, so the
   operator repeats it in config and can point it at the wrong directory —
   here that failure mode is nasty because the endpoint then *confidently
   serves an empty (or stale) identity mapping* while everything else
   works. `api.storage.serverRoot` (read-only) remains the candidate seam.
   Unlike notifications, no `baseUrl` is needed — NIP-05 documents contain
   no absolute URLs of their own origin — but `relayUrl` is the same class
   of repetition when the relay is the sibling plugin on this very server
   (`api.serverInfo` would let the plugin default it).
4. **Pubkey extraction had to be vendored.** The card's
   `verificationMethod` decoding (f-form multibase `f` + multicodec `e701`
   + parity + x-only hex; secp256k1 JWK fallback) lives in core's
   `src/auth/nostr-keys.js` — internal, so off-limits under the repo rule.
   ~60 lines re-implemented here against `@noble/curves` (same wall
   relay/nip01.js hit). If the card format evolves (new multicodec, base58
   `z`-form keys), this plugin silently drops those pods — the test pins a
   `z`-form key as *absent* to make that behaviour explicit. Candidate:
   publish the key codec helpers on the documented surface (auth.js or a
   `keys.js`).
5. **Per-host filtering (subdomain mode) is out of reach.** The issue wants
   `alice.example.com/.well-known/nostr.json` to return only alice's entry.
   A plugin *could* read `request.headers.host`, but it has no way to learn
   the server's base domain or pod↔host mapping (both internal config), so
   this port ships path-mode aggregation only. Not a new seam so much as
   more `api.serverInfo` surface.
