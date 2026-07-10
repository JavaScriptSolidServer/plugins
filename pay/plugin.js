// HTTP 402 paid routes — the WALL-REPORT port. See README.md.
//
// Core's pay feature (createServer({ pay: true })) is NOT portable: its 402
// fires inside the host's own WAC/authorize pipeline, turning ordinary LDP
// paths into paid resources. A plugin cannot intercept routes it does not
// own. What a plugin CAN do — demonstrated here — is run paid routes of its
// *own* under its prefix, speaking the same 402 response shape as core so
// clients handle both identically.
//
//   plugins: [{ module: 'pay/plugin.js', prefix: '/paid',
//               config: { cost: 1, address: 'mrc20-address',
//                         content: { '/article': 'the goods' } } }]
//
// Payment verification is pluggable via config.verify(proof, request) so
// the demo stays honest about what it is: the 402 *shape*, not a wallet.
// (Core's real MRC20 state-chain verification, src/mrc20.js, is pure crypto
// with no server coupling — it could be vendored here exactly like
// relay/nip01.js if someone wants real token deposits on plugin routes.)

export async function activate(api) {
  const cost = api.config.cost ?? 1;
  const address = api.config.address ?? null;
  const content = api.config.content ?? { '/demo': 'paid content: the demo goods' };
  const verify = api.config.verify ?? ((proof) => proof === 'demo-proof-of-payment');

  for (const [route, body] of Object.entries(content)) {
    api.fastify.get(api.prefix + route, async (request, reply) => {
      const proof = request.headers['x-payment-proof'];
      if (!proof || !(await verify(proof, request))) {
        // Same response shape as core's WAC-hook 402 (server.js).
        return reply.code(402).send({
          type: 'PaymentRequired',
          cost,
          currency: 'sat',
          address,
          accepts: 'X-Payment-Proof header',
        });
      }
      const agent = await api.auth.getAgent(request); // paid AND identified, if signed in
      return reply.code(200).send({ content: body, agent });
    });
  }

  api.log.info(`pay: ${Object.keys(content).length} paid route(s) under ${api.prefix}`);
  return {};
}
