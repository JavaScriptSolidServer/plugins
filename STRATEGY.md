# STRATEGY.md — where this sits, and whether it has a shot

Companion to [REPORT.md](./REPORT.md) (what to build into the api next).
This file answers the other question: **where does a JSS + plugins stack
sit in the ecosystem, what's missing, and what's the realistic play?**
Written 2026-07, at 33 plugins / 374 tests.

## The one-line position

**One data plane, many protocol views.** A single small Node process
where your data lives once — and Mastodon clients, Bluesky clients,
Element, CalDAV phones, IndieWeb editors, remoteStorage apps, aws-cli,
JMAP mail clients, nostr, and WebDAV mounts are all just *views of the
same pod*, each behind WAC. `serve.js` runs this today. Nothing else in
the ecosystem does.

## Head-to-head with the incumbents

| | **JSS + plugins** | **WordPress** | **Drupal** | **Nextcloud** |
|---|---|---|---|---|
| Core domain | personal data server (pods, WAC, identity) | CMS/publishing | CMS/framework | file sync + groupware |
| Plugin model | route-ownership + loopback; plugins **cannot** touch core's pipeline (measured, [NOTES.md](./NOTES.md) #564) | hooks/filters everywhere — plugins *are* pipeline modification | hook system, heavyweight | PHP apps, signed, runtime enable/disable |
| Ecosystem size | 33 | ~60,000 plugins, 20 years | ~50,000 modules, declining | ~300–400 apps |
| Marketplace / install | none — boot-time config (the #200 gap) | wp.org + one-click + auto-update | drupal.org | in-app store, `occ app:enable` |
| Admin | read side ✅ (`admin/`), write side impossible — each absence names a seam | the gold standard | strong | strong |
| Identity | WebID / did:nostr / Bearer — protocol-grade | email+password | email+password | email+password, LDAP/SSO |
| Protocol reach | Mastodon, Bluesky, Matrix, AP, JMAP, DAV×3, S3, remoteStorage, Micropub, oEmbed, WebFinger, nostr — one pod behind all | RSS + REST | similar | DAV family, some AP via app |

The architecture comparison flatters JSS: WordPress's hook soup is
exactly what the #564 line forbids, and it's why WP plugins conflict and
are a security tar pit. But architecture has never been why WordPress
wins. **Distribution is.**

## The ecosystem map

Grouped by distance from what JSS actually is:

**Same square — personal data servers with a protocol identity**

| Project | Note |
|---|---|
| ATProto PDS (+ Tranquil, Cocoon) | closest live competitor for "PDS" mindshare; real momentum, genuinely easy self-hosting — but single-protocol |
| Solid siblings (CSS, Inrupt ESS, NSS) | spec-complete, app-light, a decade of that; none has a plugin ecosystem — that is JSS's differentiator *within* Solid |
| Nostr relays (strfry, nostream…) | event stores, no personal data plane; JSS embeds a relay as one plugin |
| remoteStorage / 5apps | near-dormant; `remotestorage/` here may be among the more complete servers anywhere |
| Peergos | strong E2E-crypto story, weak protocol-bridge story |

**Adjacent — self-hosted groupware/CMS**: Nextcloud (the giant),
ownCloud/oCIS, Seafile; WordPress/Drupal on the publishing side. They
win on distribution and end-user UI, not architecture.

**Adjacent — "run apps on your box" platforms**: Umbrel (the app-store
UX bar), CasaOS/Cosmos (lowest-friction onboarding), YunoHost (best
operator experience — built-in SSO is what the `api.isOperator` finding
gestures at), Cloudron/Start9 (packaging-as-product), Sandstorm (the
philosophical cousin — capability-secure, effectively frozen, no
successor). Key structural difference: these run apps as **isolated
containers side by side** — apps don't share data. JSS is the inverse.

**Adjacent — single-protocol servers people actually self-host**:
Mastodon/GoToSocial, Matrix (Synapse/Conduit), Owncast, micro.blog.
Each is one protocol and one silo. The pitch to exactly these users:
*one* small process instead of five, one identity, one `backup/`.

## Why the square is empty (the graveyard)

It is not sparse because nobody noticed it. FreedomBox, Diaspora,
Unhosted/remoteStorage, Sandstorm, arguably a decade of Solid itself —
smart people kept entering this square and finding that technology was
never the bottleneck. **Demand and distribution were.** Most people
won't run a server; the ones who will already have opinions. An empty
square can be an opportunity or a kill zone; this one has been both.

## What changed (why now is different)

1. **The concept has mainstream legs.** Bluesky made "PDS" a word.
   Nobody must explain *why* you'd want your own data server the way
   Diaspora had to in 2011.
2. **The homelab wave built the rails.** Umbrel/CasaOS/YunoHost users
   already run boxes and browse app stores. The habit exists; be in the
   catalog.
3. **The build cost collapsed.** What killed most graveyard projects
   was ecosystem starvation — years to twenty apps. This repo added
   eleven protocol implementations in a day, each ~one agent-session,
   findings included ([AGENT.md](./AGENT.md) is the contract that makes
   that repeatable). The historical moat — thousands of developer-years
   of plugins — deflates when plugins cost hours. This is the one
   structural trend running in our favor.

## The honest gaps (ours)

1. **Distribution** — no marketplace, no one-click hosting, no
   auto-update. 90% of why WordPress is WordPress. (#200 + the
   runtime-lifecycle seam in REPORT.md.)
2. **End-user UI** — everything here is protocol surface. WP gives a
   human a website; Nextcloud gives them files; a pod gives them a URL.
   Solid's decade-old killer-app problem.
3. **Identity UX** — WebID/bearer beats passwords technically and loses
   at onboarding every time.
4. **Trust signals** — 0.0.x versioning; no third-party-plugin security
   story (and plugins can intercept each other today — NOTES.md #9).
5. **Bodies** — one maintainer + agents vs. twenty-year communities.
   (But see "what changed", point 3.)

## The play

**Not** a WordPress/Nextcloud competitor. The realistic wedge, in order:

1. **Lead with the demo nobody else can run** — one pod, every
   protocol, live (`npm run serve`, front door `/admin/`). This is the
   asset; Solid-the-spec is not the pitch.
2. **Ride existing networks' onboarding** — Bluesky PDS self-hosters
   and Nostr users are the two crowds already primed to run a personal
   server. Be the PDS that *also* does their calendar, files, mail.
3. **Get into the catalogs** — one Umbrel/CasaOS/YunoHost app that
   replaces five. The rails exist; use them.
4. **Close the self-description loop** — the four seams + `api.plugins`
   (REPORT.md's order of work), then a registry/marketplace story, so
   the ecosystem can grow and describe itself.
5. **Keep the findings discipline.** The repo's real moat is not the 33
   plugins; it's the measured, evidence-per-claim method that produced
   them and can produce the next 33.

## Verdict

An uncrowded space with a high body count, entered at the first moment
all three historical causes of death — no demand, no distribution, no
ecosystem — are weakening at once. The technology position is genuinely
strong and the ecosystem-growth cost just dropped by orders of
magnitude. The execution risk lives almost entirely in distribution and
onboarding, not in anything built in this repo. That's a real shot.
