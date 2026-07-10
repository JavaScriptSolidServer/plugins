# pay — the wall-report

**Core's pay feature cannot be ported.** This directory documents why (the
finding), plus a minimal plugin showing the part that *does* work.

## What core pay is

`createServer({ pay: true })` makes **ordinary pod resources** paid: the
402 decision happens inside the host's WAC/authorize pipeline
(`src/server.js`: `authorize()` returns `paymentRequired`, the global hook
answers `402 PaymentRequired` *instead of* 401/403 on LDP routes), with
MRC20 token deposits verified by `src/mrc20.js` and balance/deposit
endpoints alongside.

## Why a plugin can't be that

The plugin api grants routes *under your own prefix*. Pay's essence is
modifying the host's handling of routes it **doesn't** own — every LDP
path. There is no `api.hooks` and no way to run middleware on core routes.

That's not an accidental gap; it's the trust boundary. A plugin that can
rewrite every response is a different kind of grant than one that owns
`/relay`. If pipeline hooks ever ship, they should be a separately-gated
capability (`plugins: [{ module, capabilities: ['hooks'] }]`), not part of
the default api.

## The line this draws for #564

| Feature kind | Example | Plugin-able today? |
|---|---|---|
| Route-owning | relay, webrtc, terminal, tunnel, notifications endpoint | ✅ yes — proven in this repo |
| Pipeline-modifying | pay's LDP 402, conneg, quotas, WAC itself | ❌ no — stays core (or waits for a gated hooks capability) |

## What this directory's plugin actually does

Paid routes **under its own prefix**, speaking core's exact 402 response
shape (`{ type: 'PaymentRequired', cost, … }`) so clients treat both alike;
payment verification pluggable via `config.verify`. Core's MRC20
state-chain verifier is pure crypto and *could* be vendored here (the
relay/nip01.js pattern) for real token deposits on plugin routes — the
unportable part is only the LDP integration.
