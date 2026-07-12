// forge plugin over a real JSS from npm, exercised end-to-end with the real
// git CLI: anonymous push 401, cross-namespace push 403, push-to-create for
// the owner, byte-identical clone round-trip, the GitHub-light web UI
// (file table, rendered README, blob line numbers, commit log, green/red
// diff, branches/tags), the JSON API shapes, and the raw-serving XSS
// neutralization (text/plain / octet-stream+attachment, never text/html).
//
// All git invocations run against a scratch HOME (no system/user gitconfig,
// no credential helpers, no prompts) so the test sees exactly what the
// server sends.

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
const gitHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-home-'));
fs.writeFileSync(path.join(gitHome, '.gitconfig'), [
  '[user]',
  '\temail = casey@example.org',
  '\tname = Casey Coder',
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

const README_MD = [
  '# Demo Project',
  '',
  'A demo with **bold**, `inline code`, and a [doc](docs/notes.txt).',
  '',
  '```js',
  "console.log('hi');",
  '```',
  '',
  '<script>alert(1)</script>',
  '',
].join('\n');

const BINARY = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0x00, 0x89, 0x50]);

describe('forge plugin', () => {
  let jss;
  let casey; // { access_token, webid }
  let rival;
  let base;
  let remote;
  let work;
  let sha2; // second commit (touches src/main.js)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));

  const repoDir = (owner, name) => path.join(jss.root, '.plugins', 'forge', 'repos', owner, `${name}.git`);

  before(async () => {
    jss = await startJss({
      idp: true,
      plugins: [{ id: 'forge', module: module_, prefix: '/forge' }],
    });
    base = jss.base;
    casey = await registerAndMint(base, 'casey');
    rival = await registerAndMint(base, 'rival');
    remote = `${base}/forge/casey/demo.git`;

    // Working repo: README (heading + code block + <script> line), a source
    // file, a subdir file, a binary file, a pushed .html, then a second
    // commit touching the source file, and a tag.
    work = path.join(tmp, 'work');
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(work, 'README.md'), README_MD);
    fs.writeFileSync(path.join(work, 'src', 'main.js'), 'function main() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(work, 'docs', 'notes.txt'), 'notes live in a subdir\n');
    fs.writeFileSync(path.join(work, 'blob.bin'), BINARY);
    fs.writeFileSync(path.join(work, 'evil.html'), '<script>alert("xss")</script>\n');
    await git(['init', '--quiet'], { cwd: work });
    await git(['add', '-A'], { cwd: work });
    await git(['commit', '--quiet', '-m', 'initial import'], { cwd: work });
    fs.writeFileSync(path.join(work, 'src', 'main.js'), 'function main() {\n  return 2;\n}\n');
    await git(['commit', '--quiet', '-am', 'tweak main'], { cwd: work });
    await git(['tag', 'v1.0'], { cwd: work });
    sha2 = (await git(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();
  });

  after(async () => {
    if (jss) await jss.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(gitHome, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ smart HTTP

  it('anonymous push is 401 and does not create the repo', async () => {
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
    assert.ok(!fs.existsSync(repoDir('casey', 'demo')), 'auth must be checked before creation');
  });

  it("pushing into another owner's namespace is 403", async () => {
    await assert.rejects(
      git([...authFlag(rival.access_token), 'push', remote, 'main'], { cwd: work }),
      (err) => {
        assert.match(String(err.stderr), /403|forbidden|belongs to/i,
          `rival's push should be forbidden: ${err.stderr}`);
        return true;
      },
    );
    assert.ok(!fs.existsSync(repoDir('casey', 'demo')), 'no repo materialized for a forbidden push');
  });

  it('push-to-create: the owner pushing to their own namespace materializes the repo', async () => {
    await git([...authFlag(casey.access_token), 'push', remote, 'main', '--tags'], { cwd: work });
    assert.ok(fs.existsSync(repoDir('casey', 'demo')), 'bare repo under pluginDir/repos/casey');
    const meta = JSON.parse(fs.readFileSync(path.join(repoDir('casey', 'demo'), 'jss-forge.json'), 'utf8'));
    assert.strictEqual(meta.creator, casey.webid, 'the pushing agent is recorded');
  });

  it('anonymous clone round-trips the content byte-identical', async () => {
    const cloneDir = path.join(tmp, 'clone');
    await git(['clone', '--quiet', remote, cloneDir]);
    assert.strictEqual(fs.readFileSync(path.join(cloneDir, 'README.md'), 'utf8'), README_MD);
    assert.ok(fs.readFileSync(path.join(cloneDir, 'blob.bin')).equals(BINARY), 'binary bytes identical');
    assert.strictEqual(
      fs.readFileSync(path.join(cloneDir, 'src', 'main.js'), 'utf8'),
      'function main() {\n  return 2;\n}\n',
    );
  });

  // ------------------------------------------------------------ web UI

  it('the forge index lists the repo across owners', async () => {
    const res = await fetch(`${base}/forge/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('casey'), 'owner shown');
    assert.ok(html.includes('/forge/casey/demo'), 'repo linked');
  });

  it('the owner page lists that owner\'s repos', async () => {
    const res = await fetch(`${base}/forge/casey`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('/forge/casey/demo'));
  });

  it('repo home: file table, rendered README, escaped <script>, clone URL', async () => {
    const res = await fetch(`${base}/forge/casey/demo`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    // file table entries (folders and files)
    for (const name of ['README.md', 'blob.bin', 'docs', 'src', 'evil.html']) {
      assert.ok(html.includes(`>${name}</a>`), `file table lists ${name}`);
    }
    // README rendered as GitHub-style markdown
    assert.ok(html.includes('<h1>Demo Project</h1>'), 'README h1 rendered');
    assert.ok(html.includes('<strong>bold</strong>'), 'bold rendered');
    assert.ok(html.includes('<code>inline code</code>'), 'inline code rendered');
    assert.ok(html.includes('console.log'), 'fenced code block present');
    // the attack line renders INERT
    assert.ok(!html.includes('<script>alert'), 'no literal script tag from README');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'script line visible but escaped');
    // clone box
    assert.ok(html.includes('/forge/casey/demo.git'), 'smart-HTTP clone URL shown');
  });

  it('tree page shows a subdirectory listing', async () => {
    const res = await fetch(`${base}/forge/casey/demo/tree/main/docs`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('>notes.txt</a>'));
  });

  it('blob page shows the source with line numbers', async () => {
    const res = await fetch(`${base}/forge/casey/demo/blob/main/src/main.js`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="L1"') && html.includes('id="L3"'), 'line-number gutter');
    assert.ok(html.includes('return 2;'), 'file content shown');
    assert.ok(html.includes('3 lines'), 'line count in blob header');
  });

  it('commits page lists both commits', async () => {
    const res = await fetch(`${base}/forge/casey/demo/commits/main`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('tweak main'), 'newest commit listed');
    assert.ok(html.includes('initial import'), 'first commit listed');
    assert.ok(html.includes('Casey Coder'), 'author shown');
  });

  it('commit page renders a GitHub-style green/red diff for the touched file', async () => {
    const res = await fetch(`${base}/forge/casey/demo/commit/${sha2}`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('src/main.js'), 'per-file section named');
    assert.ok(html.includes('<tr class="add">'), 'addition row');
    assert.ok(html.includes('<tr class="del">'), 'deletion row');
    assert.ok(html.includes('return 2;'), 'added line content');
    assert.ok(html.includes('#dafbe1') && html.includes('#ffebe9'), 'GitHub diff palette in CSS');
    assert.ok(html.includes('+1') && html.includes('&minus;1'), 'add/del counts');
  });

  it('branches page lists the default branch; tags page lists the tag', async () => {
    const b = await fetch(`${base}/forge/casey/demo/branches`);
    assert.strictEqual(b.status, 200);
    const bh = await b.text();
    assert.ok(bh.includes('main') && bh.includes('default'), 'main marked default');

    const t = await fetch(`${base}/forge/casey/demo/tags`);
    assert.strictEqual(t.status, 200);
    assert.ok((await t.text()).includes('v1.0'), 'tag listed');
  });

  // ------------------------------------------------------- raw + security

  it('raw README is text/plain and byte-identical', async () => {
    const res = await fetch(`${base}/forge/casey/demo/raw/main/README.md`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(await res.text(), README_MD);
  });

  it('raw binary is octet-stream with attachment disposition, bytes identical', async () => {
    const res = await fetch(`${base}/forge/casey/demo/raw/main/blob.bin`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/octet-stream/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(BINARY));
  });

  it('a pushed .html file raw-serves as text/plain, never text/html', async () => {
    const res = await fetch(`${base}/forge/casey/demo/raw/main/evil.html`);
    assert.strictEqual(res.status, 200);
    const ct = res.headers.get('content-type');
    assert.match(ct, /^text\/plain/, `stored-XSS guard: got ${ct}`);
    assert.ok(!/html/.test(ct));
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('path traversal through raw is refused', async () => {
    const res = await fetch(`${base}/forge/casey/demo/raw/main/..%2f..%2f..%2fetc/passwd`);
    assert.ok(res.status >= 400 && res.status < 500, `traversal got ${res.status}`);
    const res2 = await fetch(`${base}/forge/casey/demo/raw/main/%2e%2e/%2e%2e/etc/passwd`);
    assert.ok(res2.status >= 400 && res2.status < 500, `encoded traversal got ${res2.status}`);
  });

  it('serves only the smart-HTTP protocol surface under <name>.git', async () => {
    const config = await fetch(`${base}/forge/casey/demo.git/config`);
    assert.strictEqual(config.status, 404);
    const dumb = await fetch(`${base}/forge/casey/demo.git/info/refs`);
    assert.strictEqual(dumb.status, 400, 'dumb protocol refused');
  });

  // ------------------------------------------------------------- JSON API

  it('api: repo list has stable shape', async () => {
    const res = await fetch(`${base}/forge/api/repos`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const { repos } = await res.json();
    const demo = repos.find((r) => r.owner === 'casey' && r.name === 'demo');
    assert.ok(demo, 'casey/demo listed');
    assert.strictEqual(demo.cloneUrl, `${base}/forge/casey/demo.git`, 'absolute clone URL via api.serverInfo');
    assert.ok(Number.isFinite(demo.lastPush), 'lastPush is unix seconds');
  });

  it('api: repo meta carries branches, tags, default branch and pre-rendered README html', async () => {
    const res = await fetch(`${base}/forge/api/repos/casey/demo`);
    assert.strictEqual(res.status, 200);
    const meta = await res.json();
    assert.strictEqual(meta.defaultBranch, 'main');
    assert.strictEqual(meta.empty, false);
    assert.ok(meta.branches.some((b) => b.name === 'main'));
    assert.ok(meta.tags.some((t) => t.name === 'v1.0'));
    assert.strictEqual(meta.cloneUrl, `${base}/forge/casey/demo.git`);
    assert.ok(meta.readme.html.includes('<h1>Demo Project</h1>'), 'server-rendered README html');
    assert.ok(!meta.readme.html.includes('<script>alert'), 'README html is escaped');
  });

  it('api: tree entries are typed, sized, sorted dirs-first, with last commits', async () => {
    const res = await fetch(`${base}/forge/api/repos/casey/demo/tree/main`);
    assert.strictEqual(res.status, 200);
    const { entries } = await res.json();
    assert.strictEqual(entries[0].type, 'tree', 'folders sort first');
    const readme = entries.find((e) => e.name === 'README.md');
    assert.strictEqual(readme.type, 'blob');
    assert.ok(readme.size > 0, 'blob size present');
    assert.ok(readme.lastCommit && readme.lastCommit.subject, 'per-entry last commit');
  });

  it('api: blob returns raw content for text, flags for binary', async () => {
    const text = await (await fetch(`${base}/forge/api/repos/casey/demo/blob/main/src/main.js`)).json();
    assert.strictEqual(text.binary, false);
    assert.strictEqual(text.tooLarge, false);
    assert.ok(text.content.includes('return 2;'), 'raw (unescaped) content — JSON is the escape');
    assert.ok(Number.isFinite(text.size));

    const bin = await (await fetch(`${base}/forge/api/repos/casey/demo/blob/main/blob.bin`)).json();
    assert.strictEqual(bin.binary, true);
    assert.strictEqual(bin.content, null);
  });

  it('api: commits paginate with hasMore', async () => {
    const p1 = await (await fetch(`${base}/forge/api/repos/casey/demo/commits/main`)).json();
    assert.strictEqual(p1.page, 1);
    assert.strictEqual(p1.perPage, 30);
    assert.strictEqual(p1.commits.length, 2);
    assert.strictEqual(p1.hasMore, false);
    assert.strictEqual(p1.commits[0].subject, 'tweak main');

    const p2 = await (await fetch(`${base}/forge/api/repos/casey/demo/commits/main?page=2`)).json();
    assert.strictEqual(p2.commits.length, 0);
    assert.strictEqual(p2.hasMore, false);
  });

  it('api: commit returns a structured diff (files -> hunks -> typed lines)', async () => {
    const res = await fetch(`${base}/forge/api/repos/casey/demo/commit/${sha2}`);
    assert.strictEqual(res.status, 200);
    const c = await res.json();
    assert.strictEqual(c.sha, sha2);
    assert.strictEqual(c.message, 'tweak main');
    assert.strictEqual(c.files.length, 1);
    assert.strictEqual(c.files[0].name, 'src/main.js');
    assert.strictEqual(c.files[0].adds, 1);
    assert.strictEqual(c.files[0].dels, 1);
    const lines = c.files[0].hunks[0].lines;
    assert.ok(lines.some((l) => l.type === 'add' && l.text.includes('return 2;')));
    assert.ok(lines.some((l) => l.type === 'del' && l.text.includes('return 1;')));
    assert.ok(lines.every((l) => l.type !== 'add' || Number.isFinite(l.newLine)));
  });

  it('api: unknown repo and traversal are clean JSON 4xx', async () => {
    const miss = await fetch(`${base}/forge/api/repos/casey/nope`);
    assert.strictEqual(miss.status, 404);
    assert.ok((await miss.json()).error);
    const evil = await fetch(`${base}/forge/api/repos/casey/demo/blob/main/..%2f..%2fetc/passwd`);
    assert.ok(evil.status >= 400 && evil.status < 500, `api traversal got ${evil.status}`);
  });

  // ---------------------------------------------------------- edge cases

  it('a repo with no README renders its home page without error', async () => {
    const bare = path.join(tmp, 'noreadme');
    fs.mkdirSync(bare);
    await git(['init', '--quiet'], { cwd: bare });
    fs.writeFileSync(path.join(bare, 'only.txt'), 'no readme here\n');
    await git(['add', 'only.txt'], { cwd: bare });
    await git(['commit', '--quiet', '-m', 'lone file'], { cwd: bare });
    await git([...authFlag(casey.access_token), 'push', `${base}/forge/casey/noreadme.git`, 'main'], { cwd: bare });

    const res = await fetch(`${base}/forge/casey/noreadme`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('>only.txt</a>'), 'file table still renders');
    assert.ok(!html.includes('class="readme"'), 'no README card');
  });

  it('visiting the .git URL in a browser redirects to the repo home', async () => {
    const res = await fetch(`${base}/forge/casey/demo.git`, { redirect: 'manual' });
    assert.ok([301, 302, 303, 307, 308].includes(res.status), `expected redirect, got ${res.status}`);
    assert.strictEqual(res.headers.get('location'), '/forge/casey/demo');
  });

  it('privateRepos: true flips every read (git, HTML, JSON) to owner-only', async () => {
    const priv = await startJss({
      idp: true,
      plugins: [{ id: 'forge', module: module_, prefix: '/forge', config: { privateRepos: true } }],
    });
    try {
      const own = await registerAndMint(priv.base, 'hermit');
      const other = await registerAndMint(priv.base, 'snoop');
      const privRemote = `${priv.base}/forge/hermit/secret.git`;
      await git([...authFlag(own.access_token), 'push', privRemote, 'main'], { cwd: work });

      // anonymous git read refused
      await assert.rejects(
        git(['ls-remote', privRemote]),
        (err) => /authentication|401|could not read Username|terminal prompts disabled/i.test(String(err.stderr)),
      );
      // another agent's git read refused
      await assert.rejects(
        git([...authFlag(other.access_token), 'ls-remote', privRemote]),
        (err) => /403|forbidden|belongs to/i.test(String(err.stderr)),
      );
      // owner reads fine
      await git([...authFlag(own.access_token), 'ls-remote', privRemote]);

      // HTML: anonymous 401, other 403, owner 200
      assert.strictEqual((await fetch(`${priv.base}/forge/hermit/secret`)).status, 401);
      const asOther = { headers: { authorization: `Bearer ${other.access_token}` } };
      assert.strictEqual((await fetch(`${priv.base}/forge/hermit/secret`, asOther)).status, 403);
      const asOwner = { headers: { authorization: `Bearer ${own.access_token}` } };
      assert.strictEqual((await fetch(`${priv.base}/forge/hermit/secret`, asOwner)).status, 200);

      // JSON: index requires auth and is filtered to the caller's namespace
      assert.strictEqual((await fetch(`${priv.base}/forge/api/repos`)).status, 401);
      const { repos } = await (await fetch(`${priv.base}/forge/api/repos`, asOwner)).json();
      assert.ok(repos.every((r) => r.owner === 'hermit'), 'index filtered to own repos');
      assert.strictEqual((await fetch(`${priv.base}/forge/api/repos/hermit/secret`, asOther)).status, 403);
    } finally {
      await priv.close();
    }
  });
});
