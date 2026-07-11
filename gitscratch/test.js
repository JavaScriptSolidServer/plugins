// Gitscratch plugin over a real JSS from npm, exercised end-to-end with the
// real git CLI: an unauthenticated push is refused, a Bearer-authed push
// materializes the repo on first contact, an anonymous clone round-trips
// the content, requireAuth gates reads, and the TTL sweeper reaps expired
// repos.
//
// All git invocations run against a scratch HOME (no system/user gitconfig,
// no credential helpers, no terminal prompts) so the test sees exactly what
// the server sends.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startJss } from '../helpers.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const PASS = 'correct horse battery staple';

// Hermetic git: fresh HOME, no system config, no prompts, no helpers.
const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitscratch-home-'));
fs.writeFileSync(path.join(gitHome, '.gitconfig'), [
  '[user]',
  '\temail = tester@example.org',
  '\tname = Scratch Tester',
  '[init]',
  '\tdefaultBranch = main',
  '[protocol]',
  '\tversion = 2',
  '',
].join('\n'));

function git(args, opts = {}) {
  return execFileP('git', args, {
    ...opts,
    env: {
      PATH: process.env.PATH,
      HOME: gitHome,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(opts.env ?? {}),
    },
  });
}

const authFlag = (token) => ['-c', `http.extraHeader=Authorization: Bearer ${token}`];

async function registerAndMint(base, username) {
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASS, confirmPassword: PASS }),
  });
  assert.ok([200, 201, 302].includes(reg.status) || reg.ok, `register ${username}: ${reg.status}`);
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `mint ${username} failed: ${JSON.stringify(body)}`);
  return body; // { access_token, webid }
}

describe('gitscratch plugin', () => {
  let jss;
  let token;
  let webid;
  let remote;
  let work; // local working repo we push from
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitscratch-test-'));

  before(async () => {
    jss = await startJss({
      idp: true,
      plugins: [{
        id: 'gitscratch',
        module: module_,
        prefix: '/git',
        config: { sweepIntervalMs: 60_000 },
      }],
    });
    ({ access_token: token, webid } = await registerAndMint(jss.base, 'alice'));
    remote = `${jss.base}/git/test.git`;

    work = path.join(tmp, 'work');
    fs.mkdirSync(work);
    await git(['init', '--quiet'], { cwd: work });
    fs.writeFileSync(path.join(work, 'scratch.txt'), 'hello from the scratchpad\n');
    await git(['add', 'scratch.txt'], { cwd: work });
    await git(['commit', '--quiet', '-m', 'first'], { cwd: work });
  });

  after(async () => {
    if (jss) await jss.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(gitHome, { recursive: true, force: true });
  });

  const repoDir = () => path.join(jss.root, '.plugins', 'gitscratch', 'repos', 'test.git');

  it('refuses an unauthenticated push and does not materialize the repo', async () => {
    await assert.rejects(
      git(['push', remote, 'main'], { cwd: work }),
      (err) => {
        assert.match(
          String(err.stderr),
          /authentication|401|could not read Username|terminal prompts disabled/i,
          `unexpected push failure: ${err.stderr}`,
        );
        return true;
      },
    );
    assert.ok(!fs.existsSync(repoDir()), 'auth must be checked before the repo is created');
  });

  it('authenticated push materializes the repo on first contact and succeeds', async () => {
    await git([...authFlag(token), 'push', remote, 'main'], { cwd: work });
    assert.ok(fs.existsSync(repoDir()), 'bare repo should exist under pluginDir/repos');
    const meta = JSON.parse(fs.readFileSync(path.join(repoDir(), 'jss-scratch.json'), 'utf8'));
    assert.strictEqual(meta.creator, webid, 'the pushing agent is recorded as creator');
    assert.ok(Number.isFinite(meta.createdAt), 'createdAt starts the TTL clock');
  });

  it('anonymous clone round-trips the pushed content', async () => {
    const cloneDir = path.join(tmp, 'clone');
    await git(['clone', '--quiet', remote, cloneDir]);
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, 'scratch.txt'), 'utf8'),
      'hello from the scratchpad\n',
    );
  });

  it('a second push updates; pull sees the new commit', async () => {
    fs.appendFileSync(path.join(work, 'scratch.txt'), 'second line\n');
    await git(['commit', '--quiet', '-am', 'second'], { cwd: work });
    await git([...authFlag(token), 'push', remote, 'main'], { cwd: work });

    const cloneDir = path.join(tmp, 'clone');
    await git(['pull', '--quiet'], { cwd: cloneDir });
    assert.match(fs.readFileSync(path.join(cloneDir, 'scratch.txt'), 'utf8'), /second line/);
  });

  it('serves only the smart-HTTP surface, with safe repo names', async () => {
    // Non-protocol paths inside a repo: never proxied to the backend.
    const config = await fetch(`${jss.base}/git/test.git/config`);
    assert.strictEqual(config.status, 404);

    // info/refs without a smart service parameter -> dumb protocol, refused.
    const dumb = await fetch(`${jss.base}/git/test.git/info/refs`);
    assert.strictEqual(dumb.status, 400);

    // Traversal in the repo name: refused. 403 when the host's own dotfile
    // guard catches the decoded '..' segment first, 404 from our name check
    // otherwise — either way it never reaches the backend.
    const evil = await fetch(`${jss.base}/git/..%2f..%2fpwn.git/info/refs?service=git-upload-pack`);
    assert.ok([400, 403, 404].includes(evil.status), `traversal got ${evil.status}`);
    assert.ok(!fs.existsSync(path.join(jss.root, '.plugins', 'gitscratch', 'repos', 'pwn.git')));
  });

  it('requireAuth: true gates reads too', async () => {
    const authed = await startJss({
      idp: true,
      plugins: [{
        id: 'gitscratch',
        module: module_,
        prefix: '/git',
        config: { requireAuth: true },
      }],
    });
    try {
      const { access_token: bobToken } = await registerAndMint(authed.base, 'bob');
      const privRemote = `${authed.base}/git/private.git`;

      await assert.rejects(
        git(['ls-remote', privRemote]),
        (err) => /authentication|401|could not read Username|terminal prompts disabled/i.test(String(err.stderr)),
        'anonymous read must be refused when requireAuth is on',
      );
      // Authenticated read works (and materializes the empty repo).
      await git([...authFlag(bobToken), 'ls-remote', privRemote]);
      assert.ok(
        fs.existsSync(path.join(authed.root, '.plugins', 'gitscratch', 'repos', 'private.git')),
        'authed first access materializes',
      );
    } finally {
      await authed.close();
    }
  });

  it('owned: true binds a repo to its creator — other agents cannot push', async () => {
    const owned = await startJss({
      idp: true,
      plugins: [{
        id: 'gitscratch',
        module: module_,
        prefix: '/git',
        config: { owned: true },
      }],
    });
    try {
      const { access_token: aliceTok } = await registerAndMint(owned.base, 'aliceowns');
      const { access_token: bobTok } = await registerAndMint(owned.base, 'bobintrudes');
      const ownedRemote = `${owned.base}/git/mine.git`;

      // Alice creates the repo by first push.
      await git([...authFlag(aliceTok), 'push', ownedRemote, 'main'], { cwd: work });

      // Bob, though a verified agent, is refused a push to alice's repo.
      await assert.rejects(
        git([...authFlag(bobTok), 'push', ownedRemote, 'main'], { cwd: work }),
        (err) => {
          assert.match(String(err.stderr), /403|belongs to another agent|forbidden/i,
            `bob's push should be forbidden: ${err.stderr}`);
          return true;
        },
      );

      // Alice can still push (a no-op update proves her access survives).
      await git([...authFlag(aliceTok), 'push', ownedRemote, 'main'], { cwd: work });
    } finally {
      await owned.close();
    }
  });

  it('TTL sweeper reaps expired repos', async () => {
    const shortLived = await startJss({
      plugins: [{
        id: 'gitscratch',
        module: module_,
        prefix: '/git',
        config: { ttlMs: 300, sweepIntervalMs: 100 },
      }],
    });
    try {
      // Anonymous read materializes (requireAuth is off) and starts the clock.
      await git(['ls-remote', `${shortLived.base}/git/ttl.git`]);
      const dir = path.join(shortLived.root, '.plugins', 'gitscratch', 'repos', 'ttl.git');
      assert.ok(fs.existsSync(dir), 'repo materialized');

      let reaped = false;
      for (let i = 0; i < 50; i++) {
        if (!fs.existsSync(dir)) { reaped = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(reaped, 'expired repo should be swept');
    } finally {
      await shortLived.close();
    }
  });
});
