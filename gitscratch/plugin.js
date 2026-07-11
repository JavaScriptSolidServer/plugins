// Git scratchpads (#322) as a #206 loader plugin.
//
//   plugins: [{ id: 'gitscratch', module: 'gitscratch/plugin.js', prefix: '/git',
//               config: { ttlMs: 86_400_000, requireAuth: false } }]
//
// Push to a URL that doesn't exist -> JSS materializes an ephemeral bare
// repo under api.storage.pluginDir()/repos, serves the full git smart-HTTP
// protocol for it, and auto-deletes it once its TTL expires.
//
//   git remote add scratch http://host/git/feature-x.git
//   git -c http.extraHeader="Authorization: Bearer <t>" push scratch main
//
// The protocol itself is NOT reimplemented: every git request is delegated
// to the stock `git-http-backend` binary as a CGI — spawn it with the CGI
// environment (GIT_PROJECT_ROOT, PATH_INFO, REQUEST_METHOD, QUERY_STRING,
// CONTENT_TYPE, REMOTE_USER, …), pipe the raw request body to its stdin,
// parse its CGI stdout (Status: header, header block, blank line, body)
// back into the Fastify reply. No npm deps — node builtins + system git.
//
// Auth model:
//   - push (git-receive-pack, including its info/refs advertisement) always
//     requires a verified agent via api.auth.getAgent — Bearer, DPoP,
//     NIP-98, … An anonymous push gets 401 + WWW-Authenticate.
//   - clone/fetch is public unless config.requireAuth is true.
//   - the agent id is passed to the backend as REMOTE_USER.
//   - by default a scratch repo is SHARED: any verified agent may push to
//     any repo (that is the "scratch" model). Set config.owned: true to bind
//     each repo to the agent that first materialized it — thereafter only
//     that creator may push (and, when requireAuth is set, read); others get
//     403. This closes the cross-agent-overwrite gap for deployments that
//     want per-repo ownership without changing the shared default.
//
// Raw bodies (relates to JSS #583): the routes live in a Fastify scope
// whose content-type parser hands the *unconsumed request stream* through
// (`done(null, payload)`), so the body reaches git-http-backend byte-exact
// — including gzip'd pack uploads, which the backend inflates itself from
// HTTP_CONTENT_ENCODING. No buffering, no reparsing.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_SWEEP_MS = 60_000;
const DEFAULT_BACKEND = '/usr/lib/git-core/git-http-backend';
const META_FILE = 'jss-scratch.json';
// Conservative repo names: must end in .git, no slashes, no leading dot
// (the host's dotfile guard would 403 those anyway), no traversal.
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.git$/;
const SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

async function findBackend(config) {
  for (const candidate of [config.gitHttpBackend, DEFAULT_BACKEND]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  // Fall back to asking git itself where its helpers live.
  const { stdout } = await execFileP('git', ['--exec-path']);
  const derived = path.join(stdout.trim(), 'git-http-backend');
  if (fs.existsSync(derived)) return derived;
  throw new Error('gitscratch: git-http-backend not found; set config.gitHttpBackend');
}

export async function activate(api) {
  const prefix = api.prefix || '/git';
  const ttlMs = api.config.ttlMs ?? DEFAULT_TTL_MS;
  const sweepIntervalMs = api.config.sweepIntervalMs ?? Math.min(ttlMs, DEFAULT_SWEEP_MS);
  const requireAuth = api.config.requireAuth ?? false;
  const owned = api.config.owned ?? false;
  const backend = await findBackend(api.config);

  const reposDir = path.join(api.storage.pluginDir(), 'repos');
  fs.mkdirSync(reposDir, { recursive: true });

  // Server-side git must be hermetic: no operator ~/.gitconfig (a personal
  // init.defaultBranch would misplace every scratch repo's HEAD), no
  // /etc/gitconfig surprises.
  const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' };

  // A scratch repo's HEAD can't know the branch the first push will bring
  // (main? master? feature-x?). This hook repoints a dangling HEAD at the
  // first branch that lands, so a subsequent clone checks something out.
  const POST_RECEIVE_HOOK = [
    '#!/bin/sh',
    '# jss gitscratch: keep HEAD on a branch that exists.',
    'if ! git rev-parse --verify -q HEAD >/dev/null; then',
    "  first=$(git for-each-ref --format='%(refname)' refs/heads | head -n 1)",
    '  [ -n "$first" ] && git symbolic-ref HEAD "$first"',
    'fi',
    '',
  ].join('\n');

  // The agent that first materialized a repo, or null if unknown/shared.
  function repoCreator(name) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(reposDir, name, META_FILE), 'utf8'));
      return meta.creator ?? null;
    } catch { return null; }
  }

  // ------------------------------------------------------- materialize
  async function materialize(name, agent) {
    const repoPath = path.join(reposDir, name);
    if (fs.existsSync(repoPath)) return repoPath;
    await execFileP('git', ['init', '--bare', '--quiet', repoPath], { env: gitEnv });
    // Explicitly allow pushes: git-http-backend refuses receive-pack for
    // anonymous CGI setups unless http.receivepack is set. (We also pass
    // REMOTE_USER, but belt and braces.)
    await execFileP('git', ['-C', repoPath, 'config', 'http.receivepack', 'true'], { env: gitEnv });
    fs.writeFileSync(path.join(repoPath, 'hooks', 'post-receive'), POST_RECEIVE_HOOK, { mode: 0o755 });
    fs.writeFileSync(
      path.join(repoPath, META_FILE),
      JSON.stringify({ createdAt: Date.now(), creator: agent ?? null, ttlMs }, null, 2),
    );
    api.log.info(`gitscratch: materialized ${name}${agent ? ` for ${agent}` : ''} (ttl ${ttlMs}ms)`);
    return repoPath;
  }

  // -------------------------------------------------------- CGI bridge
  // Spawn git-http-backend with the CGI/1.1 environment, feed it the raw
  // request body, translate its CGI response (headers + blank line + body)
  // into the Fastify reply — streaming the body, not buffering it.
  function runBackend(request, reply, { name, subPath, agent }) {
    return new Promise((resolve, reject) => {
      const env = {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: reposDir,
        GIT_HTTP_EXPORT_ALL: '1',
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_PROTOCOL: 'HTTP/1.1',
        REQUEST_METHOD: request.method,
        PATH_INFO: `/${name}/${subPath}`,
        QUERY_STRING: request.raw.url.split('?')[1] ?? '',
        REMOTE_ADDR: request.ip ?? '',
      };
      const contentType = request.headers['content-type'];
      const contentLength = request.headers['content-length'];
      const contentEncoding = request.headers['content-encoding'];
      const gitProtocol = request.headers['git-protocol'];
      if (contentType) env.CONTENT_TYPE = contentType;
      if (contentLength) env.CONTENT_LENGTH = contentLength;
      // http-backend inflates gzip'd bodies itself when told about them.
      if (contentEncoding) env.HTTP_CONTENT_ENCODING = contentEncoding;
      // Wire protocol v2 negotiation travels in the Git-Protocol header;
      // a CGI learns it via GIT_PROTOCOL (same dance Apache configs do).
      if (gitProtocol) env.GIT_PROTOCOL = gitProtocol;
      if (agent) env.REMOTE_USER = agent;

      const child = spawn(backend, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });

      // Body: request.body is the unconsumed raw stream (see the scoped
      // content-type parser below), or undefined for GET.
      child.stdin.on('error', () => { /* EPIPE if backend exits early */ });
      if (request.body && typeof request.body.pipe === 'function') {
        request.body.pipe(child.stdin);
      } else {
        child.stdin.end(request.body ?? undefined);
      }

      // Parse the CGI header block incrementally, then stream the rest.
      let head = Buffer.alloc(0);
      let headersDone = false;
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        let sep = head.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sep === -1) { sep = head.indexOf('\n\n'); sepLen = 2; }
        if (sep === -1) {
          if (head.length > 64 * 1024) {
            child.kill();
            reject(new Error('gitscratch: CGI header block never terminated'));
          }
          return;
        }
        headersDone = true;
        child.stdout.off('data', onData);

        let status = 200;
        for (const line of head.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = parseInt(value, 10) || 200;
          else reply.header(key, value);
        }
        reply.code(status);

        const out = new PassThrough();
        out.write(head.subarray(sep + sepLen));
        child.stdout.pipe(out);
        resolve(reply.send(out));
      };
      child.stdout.on('data', onData);

      child.on('error', (err) => {
        if (!headersDone) reject(new Error(`gitscratch: cannot spawn ${backend}: ${err.message}`));
      });
      child.on('close', (code) => {
        if (!headersDone) {
          reject(new Error(`gitscratch: git-http-backend exited ${code} before headers${stderr ? `: ${stderr.trim()}` : ''}`));
        } else if (code !== 0 && stderr) {
          api.log.warn(`gitscratch: git-http-backend exited ${code}: ${stderr.trim()}`);
        }
      });

      // If the client goes away mid-transfer, reap the backend instead of
      // leaving it blocked on a full stdout pipe.
      reply.raw.on('close', () => {
        if (child.exitCode === null && !reply.raw.writableFinished) child.kill();
      });
    });
  }

  // ------------------------------------------------------------ routes
  // Scoped: within this register the content-type parser passes the raw
  // request stream through untouched — git bodies are opaque pack data
  // (often gzip'd) that must reach the backend byte-exact (JSS #583).
  await api.fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (req, payload, done) => done(null, payload));

    const handler = async (request, reply) => {
      const name = request.params.repo;
      const subPath = request.params['*'] || '';
      if (!REPO_NAME.test(name) || name.includes('..')) {
        return reply.code(404).send('no such repository\n');
      }

      // Smart HTTP only: the refs advertisement and the two service RPCs.
      const isInfoRefs = request.method === 'GET' && subPath === 'info/refs';
      const isService = request.method === 'POST' && SERVICES.has(subPath);
      if (!isInfoRefs && !isService) {
        return reply.code(404).send('smart HTTP endpoints only\n');
      }
      const service = isInfoRefs ? String(request.query?.service ?? '') : subPath;
      if (!SERVICES.has(service)) {
        return reply.code(400).send('dumb HTTP protocol is not supported; use git >= 1.6.6\n');
      }

      // Auth gate: pushes always need a verified agent; reads too when
      // config.requireAuth. The 401 + WWW-Authenticate pair is what makes
      // git clients surface "Authentication failed" instead of a protocol
      // error (they never see Basic succeed — Solid credentials arrive in
      // the same Authorization header via http.extraHeader / DPoP / …).
      const isWrite = service === 'git-receive-pack';
      const agent = await api.auth.getAgent(request);
      if ((isWrite || requireAuth) && !agent) {
        reply.header('WWW-Authenticate', 'Basic realm="jss-git-scratch", charset="UTF-8"');
        return reply.code(401).send('authentication required\n');
      }

      // Ownership (config.owned): once a repo has a creator, only that agent
      // may push to it — and, under requireAuth, read it. Anonymous access is
      // already handled above; here `agent` is set whenever the gate matters.
      if (owned) {
        const creator = repoCreator(name);
        if (creator && agent !== creator && (isWrite || requireAuth)) {
          return reply.code(403).send('this scratch repo belongs to another agent\n');
        }
      }

      // First access materializes the repo; the TTL clock starts here.
      await materialize(name, agent);

      return runBackend(request, reply, { name, subPath, agent });
    };

    scope.route({ method: ['GET', 'POST'], url: `${prefix}/:repo/*`, handler });
  });

  // ----------------------------------------------------------- sweeper
  function sweep() {
    let names;
    try { names = fs.readdirSync(reposDir); } catch { return; }
    const now = Date.now();
    for (const name of names) {
      const repoPath = path.join(reposDir, name);
      let createdAt;
      let ttl = ttlMs;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(repoPath, META_FILE), 'utf8'));
        createdAt = meta.createdAt;
        ttl = meta.ttlMs ?? ttlMs;
      } catch {
        // No/torn meta: fall back to the directory's mtime.
        try { createdAt = fs.statSync(repoPath).mtimeMs; } catch { continue; }
      }
      if (typeof createdAt === 'number' && now - createdAt > ttl) {
        try {
          fs.rmSync(repoPath, { recursive: true, force: true });
          api.log.info(`gitscratch: expired ${name}`);
        } catch (err) {
          api.log.warn(`gitscratch: failed to expire ${name}: ${err.message}`);
        }
      }
    }
  }
  const sweeper = setInterval(sweep, sweepIntervalMs);
  sweeper.unref();

  api.log.info(
    `gitscratch: smart-HTTP at ${prefix}/<name>.git (backend ${backend}, ttl ${ttlMs}ms, reads ${requireAuth ? 'authenticated' : 'public'})`,
  );

  return {
    deactivate() {
      clearInterval(sweeper);
    },
  };
}
