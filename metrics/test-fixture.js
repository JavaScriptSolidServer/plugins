// Test-only neighbor plugin: owns one route and nothing else. It exists so
// metrics/test.js can measure the scope of hooks added on api.fastify —
// specifically whether the metrics plugin's onResponse hook observes a
// route registered by a DIFFERENT plugin entry (it does: all plugin entries
// activate inside one shared Fastify register scope — see README Findings).
export async function activate(api) {
  api.fastify.get((api.prefix || '') + '/ping', async () => ({ pong: true }));
  return {};
}
