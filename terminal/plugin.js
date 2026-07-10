// terminal — WebSocket shell as a #206 loader plugin.
//
//   plugins: [{ module: 'terminal/plugin.js', prefix: '/terminal',
//               config: { allowAgents: ['https://alice.example/profile/card#me'],
//                         token: 'optional-shared-secret',
//                         shell: '/bin/sh', cwd: '/srv/work' } }]
//
// Out-of-tree port of JSS src/terminal/index.js (AGPL-3.0-only). This is a
// remote shell over a WebSocket — the most dangerous of the ports — so the
// gate is *stricter* than core, not merely mirrored:
//
//   - core boots the shell whenever --terminal is passed and only refuses a
//     connection with no webId (`options.public` can even waive that). This
//     port REFUSES TO ACTIVATE without an explicit allowlist or shared token:
//     an open shell is never the default.
//   - core spawns with `{ ...process.env }`, leaking every server secret
//     into the child. This port spawns with a minimal, curated env.
//   - connection auth is verified via api.auth.getAgent(request) (#584) —
//     the same credential schemes the host itself accepts — against
//     config.allowAgents, with a query-param token as the browser fallback.
//
// Attribution: adapted from JavaScriptSolidServer/src/terminal/index.js.

import { spawn } from 'node:child_process';

// Wire protocol (matches core): raw text/binary chunks are shell stdio;
// JSON envelopes carry lifecycle signals.
const err = (message) => JSON.stringify({ type: 'error', message });
const exit = (code) => JSON.stringify({ type: 'exit', code: code ?? 1 });

const OPEN = 1; // ws.readyState OPEN

export async function activate(api) {
  const wsPath = api.prefix || '/terminal';
  const cfg = api.config || {};

  // ---------------------------------------------------------------- gate
  // Access control is mandatory. Two mechanisms, either satisfies boot:
  //   - allowAgents: verified-agent allowlist (WebID / did:nostr), the
  //     primary path — credentials proven via api.auth.getAgent.
  //   - token: a shared secret compared to ?token=, the browser fallback
  //     (browsers cannot set Authorization on a WebSocket handshake).
  const allowAgents = Array.isArray(cfg.allowAgents) ? cfg.allowAgents.filter(Boolean) : null;
  const token = typeof cfg.token === 'string' && cfg.token ? cfg.token : null;
  if ((!allowAgents || allowAgents.length === 0) && !token) {
    throw new Error(
      'terminal: refusing to boot an open shell — set config.allowAgents ' +
      '(array of allowed agent ids) and/or config.token (shared secret)',
    );
  }
  const allow = new Set(allowAgents || []);

  const shellCmd = typeof cfg.shell === 'string' && cfg.shell ? cfg.shell : '/bin/sh';
  const shellArgs = Array.isArray(cfg.args) ? cfg.args : [];
  // Working dir: the plugin's private data dir unless overridden. Never the
  // server's cwd.
  const cwd = typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : api.storage.pluginDir();

  // Curated env — never `process.env`. Secrets (token secrets, JWKS paths,
  // API keys the operator set) must not reach a shell the client drives.
  const env = {
    PATH: cfg.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    TERM: 'xterm-256color',
    LANG: process.env.LANG || 'C.UTF-8',
    ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}),
  };

  const shells = new Set();

  // Verify the handshake before spawning anything. Returns an agent label
  // string when authorized, or null.
  async function authorize(request) {
    // Browser fallback: a shared token in the query string.
    if (token) {
      const qToken = request.query?.token;
      if (typeof qToken === 'string' && qToken.length === token.length) {
        // constant-time-ish compare
        let diff = 0;
        for (let i = 0; i < token.length; i++) diff |= qToken.charCodeAt(i) ^ token.charCodeAt(i);
        if (diff === 0) return 'token';
      }
    }
    // Primary: a verified agent from a Bearer/DPoP/NIP-98/… credential.
    // The `ws` npm client CAN send headers, so this path works for
    // programmatic clients; browsers use the token fallback above.
    if (allow.size) {
      const agent = await api.auth.getAgent(request);
      if (agent && allow.has(agent)) return agent;
    }
    return null;
  }

  await api.ws.route(wsPath, async (socket, request) => {
    const agent = await authorize(request);
    if (!agent) {
      try {
        if (socket.readyState === OPEN) socket.send(err('Authentication required'));
        socket.close(1008, 'unauthorized');
      } catch { /* already gone */ }
      return;
    }

    const shell = spawn(shellCmd, shellArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    shells.add(shell);
    api.log.info(`terminal: shell for ${agent} (pid ${shell.pid})`);

    const pipe = (stream) => stream.on('data', (data) => {
      if (socket.readyState !== OPEN) return;
      try { socket.send(data.toString().replace(/\r?\n/g, '\r\n')); } catch { /* closed */ }
    });
    pipe(shell.stdout);
    pipe(shell.stderr);

    shell.on('close', (code) => {
      shells.delete(shell);
      if (socket.readyState !== OPEN) return;
      try { socket.send(exit(code)); socket.close(); } catch { /* closed */ }
    });
    shell.on('error', (e) => {
      shells.delete(shell);
      if (socket.readyState !== OPEN) return;
      try { socket.send(err(e.message)); socket.close(); } catch { /* closed */ }
    });

    socket.on('message', (data) => {
      if (!shell.stdin.writable) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try { shell.stdin.write(buf); } catch { /* stdin closed */ }
    });

    const kill = () => {
      shells.delete(shell);
      try { shell.kill('SIGKILL'); } catch { /* already dead */ }
    };
    socket.on('close', kill);
    socket.on('error', kill);
  });

  api.log.info(
    `terminal: shell websocket at ${wsPath} ` +
    `(${allow.size ? `${allow.size} allowed agent(s)` : 'no allowlist'}` +
    `${token ? ', token' : ''}, cwd ${cwd})`,
  );

  return {
    deactivate() {
      for (const proc of shells) {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }
      shells.clear();
    },
  };
}

export default activate;
