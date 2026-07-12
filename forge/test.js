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
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { schnorr } from '@noble/curves/secp256k1';
import { startJss } from '../helpers.js';
import { npubEncode } from './plugin.js';

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

// --- tier 2.5: craft REAL NIP-98 auth server-side (kind 27235, schnorr) ---
const bytesToHex = (b) => Buffer.from(b).toString('hex');

/**
 * A signed NIP-98 Authorization header for one url+method, matching the
 * host verifier exactly: kind 27235, created_at now (±60 s window),
 * tags [[u,url],[method,METHOD]] plus a payload tag (sha256 of the wire
 * body) when a body is sent, base64 JSON, `Nostr <b64>`.
 */
function nip98Header(skHex, url, method, body) {
  const event = {
    pubkey: bytesToHex(schnorr.getPublicKey(skHex)),
    created_at: Math.floor(Date.now() / 1000),
    kind: 27235,
    tags: [['u', url], ['method', method]],
    content: '',
  };
  if (body !== undefined) {
    event.tags.push(['payload', crypto.createHash('sha256').update(body).digest('hex')]);
  }
  event.id = crypto.createHash('sha256')
    .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]), 'utf8')
    .digest('hex');
  event.sig = bytesToHex(schnorr.sign(event.id, skHex));
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

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

/** Mint a fresh token for an ALREADY-registered user. */
async function mintToken(base, username) {
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASS }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `re-mint ${username} failed: ${JSON.stringify(body)}`);
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

  // ------------------------------------------ tier 2: issues + comments
  // The architecture under test: bodies are pod resources the AUTHOR owns
  // (loopback PUT with the author's own forwarded Bearer), the forge keeps
  // only a pointer spine in pluginDir — so deleting the pod resource
  // deletes the words everywhere, and cross-user comments really live in
  // the commenter's pod.

  describe('issues (tier 2: bodies in pods, spine in pluginDir)', () => {
    let dana;
    let apiBase;
    let issueUrl;   // casey's issue #1 body, in casey's pod
    let commentUrl; // dana's comment, in dana's pod

    before(async () => {
      dana = await registerAndMint(base, 'dana');
      apiBase = `${base}/forge/api/repos/casey/demo`;
    });

    const authed = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

    it('anonymous issue POST is 401', async () => {
      const res = await fetch(`${apiBase}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'nope', body: 'anon' }),
      });
      assert.strictEqual(res.status, 401);
      assert.ok(res.headers.get('www-authenticate'), 'WWW-Authenticate on the API 401');
      assert.ok((await res.json()).error);
    });

    it("casey opens issue #1 and the body lives in casey's OWN pod", async () => {
      const res = await fetch(`${apiBase}/issues`, {
        method: 'POST',
        headers: authed(casey.access_token),
        body: JSON.stringify({ title: 'Clone fails on Windows', body: 'Steps:\n\n1. clone\n2. see **boom**' }),
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.strictEqual(j.number, 1);
      issueUrl = j.resourceUrl;
      assert.ok(issueUrl.includes('/casey/public/forge/casey--demo/issue-'),
        `resource recorded in casey's pod namespace: ${issueUrl}`);
      // The pod resource is REAL: fetch it directly, no forge in the path.
      const direct = await fetch(issueUrl);
      assert.strictEqual(direct.status, 200);
      const doc = await direct.json();
      assert.strictEqual(doc.type, 'ForgeIssue');
      assert.strictEqual(doc.repo, 'casey/demo');
      assert.strictEqual(doc.issue, 1);
      assert.strictEqual(doc.author, casey.webid);
      assert.ok(doc.body.includes('**boom**'), 'raw markdown stored in the pod');
    });

    it("dana's comment lives in DANA's pod (the cross-user proof)", async () => {
      const res = await fetch(`${apiBase}/issues/1/comments`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ body: 'Repro on my machine too, with `git 2.44`.' }),
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.strictEqual(j.comments, 1);
      commentUrl = j.resourceUrl;
      assert.ok(commentUrl.includes('/dana/public/forge/casey--demo/comment-'),
        `resource recorded in dana's pod namespace: ${commentUrl}`);
      const direct = await fetch(commentUrl);
      assert.strictEqual(direct.status, 200);
      const doc = await direct.json();
      assert.strictEqual(doc.type, 'ForgeComment');
      assert.strictEqual(doc.issue, 1);
      assert.strictEqual(doc.author, dana.webid);
    });

    it('thread JSON re-fetches both bodies from the pods, authors correct', async () => {
      const t = await (await fetch(`${apiBase}/issues/1`)).json();
      assert.strictEqual(t.number, 1);
      assert.strictEqual(t.state, 'open');
      assert.strictEqual(t.author, casey.webid);
      assert.strictEqual(t.thread.length, 2);
      const [head, c1] = t.thread;
      assert.strictEqual(head.author, casey.webid);
      assert.strictEqual(head.removed, false);
      assert.ok(head.body.includes('**boom**'), 'raw body straight from the pod');
      assert.ok(head.html.includes('<strong>boom</strong>'), 'pre-rendered markdown html');
      assert.strictEqual(c1.author, dana.webid);
      assert.strictEqual(c1.resourceUrl, commentUrl);
      assert.ok(c1.html.includes('<code>git 2.44</code>'));
    });

    it('thread HTML: comment boxes, rendered markdown, owner badge', async () => {
      const res = await fetch(`${base}/forge/casey/demo/issues/1`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Clone fails on Windows'), 'title shown');
      assert.ok(html.includes('<strong>boom</strong>'), 'issue body markdown rendered');
      assert.ok(html.includes('>owner</span>'), "casey's box carries the owner badge");
      assert.ok(html.includes('>dana</b>'), 'commenter named');
      assert.ok(html.includes('state-open'), 'open pill');
    });

    it('the Issues tab carries an open-count badge on repo pages', async () => {
      const html = await (await fetch(`${base}/forge/casey/demo`)).text();
      assert.match(html, /Issues <span class="badge">1<\/span>/);
    });

    it('XSS probe: evil title and <script> body render inert everywhere', async () => {
      const res = await fetch(`${apiBase}/issues`, {
        method: 'POST',
        headers: authed(casey.access_token),
        body: JSON.stringify({
          title: '<img src=x onerror=alert(1)> "quoted" title',
          body: 'attack:\n\n<script>alert("issue-xss")</script>\n\nend',
        }),
      });
      assert.strictEqual(res.status, 201);
      const { number } = await res.json();
      assert.strictEqual(number, 2, 'numbering survives a second issue');

      const html = await (await fetch(`${base}/forge/casey/demo/issues/2`)).text();
      assert.ok(!html.includes('<script>alert'), 'no literal script tag from the body');
      assert.ok(!html.includes('<img src=x'), 'no literal img injection from the title');
      assert.ok(html.includes('&lt;script&gt;alert('), 'body attack line visible but escaped');

      const t = await (await fetch(`${apiBase}/issues/2`)).json();
      assert.ok(!t.thread[0].html.includes('<script>'), 'html field escaped');
      assert.ok(t.thread[0].html.includes('&lt;script&gt;'), 'attack visible as text in html field');
      assert.ok(t.thread[0].body.includes('<script>'), 'raw body stays raw in JSON — JSON is the escape');
      assert.strictEqual(t.title, '<img src=x onerror=alert(1)> "quoted" title', 'title raw in JSON');
    });

    it('deleting the pod resource turns the slot into a removed placeholder', async () => {
      // dana deletes HER OWN resource from HER pod — the forge is not asked.
      const del = await fetch(commentUrl, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${dana.access_token}` },
      });
      assert.ok([200, 202, 204, 205].includes(del.status), `dana deletes her own resource: ${del.status}`);

      const t = await (await fetch(`${apiBase}/issues/1`)).json();
      const slot = t.thread[1];
      assert.strictEqual(slot.removed, true);
      assert.strictEqual(slot.body, null);
      assert.strictEqual(slot.html, null);
      assert.strictEqual(slot.author, dana.webid, 'the pointer (who/when) remains');

      const html = await (await fetch(`${base}/forge/casey/demo/issues/1`)).text();
      assert.ok(html.includes('content removed by its author'), 'placeholder rendered');
      assert.ok(!html.includes('git 2.44'), 'the deleted words are gone from the forge');
    });

    it("dana cannot close casey's issue (403); anonymous close is 401", async () => {
      const res = await fetch(`${apiBase}/issues/1/close`, { method: 'POST', headers: authed(dana.access_token) });
      assert.strictEqual(res.status, 403);
      const anon = await fetch(`${apiBase}/issues/1/close`, { method: 'POST' });
      assert.strictEqual(anon.status, 401);
      const t = await (await fetch(`${apiBase}/issues/1`)).json();
      assert.strictEqual(t.state, 'open', 'still open');
    });

    it('casey (owner) closes; the list filters split open/closed correctly', async () => {
      const res = await fetch(`${apiBase}/issues/1/close`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { number: 1, state: 'closed' });

      const open = await (await fetch(`${apiBase}/issues?state=open`)).json();
      assert.deepStrictEqual(open.issues.map((i) => i.number), [2]);
      assert.strictEqual(open.openCount, 1);
      assert.strictEqual(open.closedCount, 1);

      const closed = await (await fetch(`${apiBase}/issues?state=closed`)).json();
      assert.deepStrictEqual(closed.issues.map((i) => i.number), [1]);
      assert.strictEqual(closed.issues[0].comments, 1, 'comment count survives deletion (pointer, not body)');

      const html = await (await fetch(`${base}/forge/casey/demo/issues?state=closed`)).text();
      assert.ok(html.includes('Clone fails on Windows'), 'closed filter tab lists issue #1');
      const openHtml = await (await fetch(`${base}/forge/casey/demo/issues`)).text();
      assert.ok(!openHtml.includes('Clone fails on Windows'), 'open list no longer shows it');
    });

    it('reopen + retitle work for owner/author; a third party gets 403', async () => {
      const re = await fetch(`${apiBase}/issues/1/reopen`, { method: 'POST', headers: authed(casey.access_token) });
      assert.deepStrictEqual(await re.json(), { number: 1, state: 'open' });

      const pa = await fetch(`${apiBase}/issues/1`, {
        method: 'PATCH',
        headers: authed(casey.access_token),
        body: JSON.stringify({ title: 'Clone fails on Windows 11' }),
      });
      assert.strictEqual(pa.status, 200);
      const t = await (await fetch(`${apiBase}/issues/1`)).json();
      assert.strictEqual(t.state, 'open');
      assert.strictEqual(t.title, 'Clone fails on Windows 11');

      const forbidden = await fetch(`${apiBase}/issues/1`, {
        method: 'PATCH',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'hijack' }),
      });
      assert.strictEqual(forbidden.status, 403);
      // leave #1 closed again so later readers see a stable split
      await fetch(`${apiBase}/issues/1/close`, { method: 'POST', headers: authed(casey.access_token) });
    });

    it('a non-owner issue author can close their own issue', async () => {
      const res = await fetch(`${apiBase}/issues`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'Docs typo', body: 'in the README' }),
      });
      assert.strictEqual(res.status, 201);
      const { number } = await res.json();
      assert.strictEqual(number, 3, 'numbering keeps counting');
      const close = await fetch(`${apiBase}/issues/${number}/close`, { method: 'POST', headers: authed(dana.access_token) });
      assert.strictEqual(close.status, 200, 'the issue author may close, without owning the repo');
    });

    it('issue list pagination shape: state, page, perPage, hasMore', async () => {
      const p1 = await (await fetch(`${apiBase}/issues`)).json();
      assert.strictEqual(p1.state, 'open');
      assert.strictEqual(p1.page, 1);
      assert.strictEqual(p1.perPage, 25);
      assert.strictEqual(p1.hasMore, false);
      const p9 = await (await fetch(`${apiBase}/issues?page=9`)).json();
      assert.deepStrictEqual(p9.issues, []);
      assert.strictEqual(p9.hasMore, false);
    });

    it('PATCH repo description: owner-only, shown (escaped) on repo home and API', async () => {
      const forbidden = await fetch(`${base}/forge/api/repos/casey/demo`, {
        method: 'PATCH',
        headers: authed(dana.access_token),
        body: JSON.stringify({ description: 'nope' }),
      });
      assert.strictEqual(forbidden.status, 403);

      const res = await fetch(`${base}/forge/api/repos/casey/demo`, {
        method: 'PATCH',
        headers: authed(casey.access_token),
        body: JSON.stringify({ description: 'A demo repo with <angle> brackets' }),
      });
      assert.strictEqual(res.status, 200);

      const meta = await (await fetch(`${base}/forge/api/repos/casey/demo`)).json();
      assert.strictEqual(meta.description, 'A demo repo with <angle> brackets');

      const home = await (await fetch(`${base}/forge/casey/demo`)).text();
      assert.ok(home.includes('A demo repo with &lt;angle&gt; brackets'), 'description on repo home, escaped');
      const list = await (await fetch(`${base}/forge/`)).text();
      assert.ok(list.includes('A demo repo with &lt;angle&gt; brackets'), 'description on the repo list');
    });

    it('issues/new renders the vanilla-JS client and degrades without JS', async () => {
      const res = await fetch(`${base}/forge/casey/demo/issues/new`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('id="f-title"') && html.includes('id="f-body"'), 'form fields');
      assert.ok(html.includes('<noscript>'), 'graceful no-JS note');
      assert.ok(html.includes('/idp/credentials'), 'login client targets the credentials endpoint');
      assert.match(res.headers.get('content-security-policy') ?? '', /connect-src 'self'/,
        'CSP admits same-origin fetch for the client');
    });
  });

  // ------------------------------------------ tier 2.5: did:nostr agents
  // Canonical identity is did:nostr:<64-hex> — the hex pubkey IS the forge
  // namespace; npub is display-only. git cannot sign per-request NIP-98
  // from a static header, so pushes ride the <prefix>/api/token exchange;
  // podless agents' issue words are forge-hosted, author-deletable.

  describe('nostr agents (tier 2.5: hex namespaces, push tokens, hosted content)', () => {
    const skA = bytesToHex(schnorr.utils.randomPrivateKey());
    const pkA = bytesToHex(schnorr.getPublicKey(skA));
    const didA = `did:nostr:${pkA}`;
    const skB = bytesToHex(schnorr.utils.randomPrivateKey());
    const pkB = bytesToHex(schnorr.getPublicKey(skB));
    const npubShortOf = (hex) => {
      const npub = npubEncode(hex);
      return `${npub.slice(0, 9)}…${npub.slice(-4)}`;
    };
    let tokenA;
    let tokenB;
    let hostedIssueUrl;   // key A's issue body, hosted by the forge
    let hostedCommentUrl; // key B's comment, hosted by the forge

    it('bech32: the canonical NIP-19 npub vector (BIP-173, full checksum)', () => {
      assert.strictEqual(
        npubEncode('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'),
        'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      );
    });

    it('NIP-98 -> push-token exchange: getAgent verifies, forge mints a bearer', async () => {
      const url = `${base}/forge/api/token`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: nip98Header(skA, url, 'POST') },
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.strictEqual(j.agent, didA, 'the DID from the signature, hex canonical');
      assert.ok(j.token.startsWith('f1.'), 'macaroon-lite forge token');
      assert.ok(j.exp > Math.floor(Date.now() / 1000), 'future expiry');
      tokenA = j.token;
      const res2 = await fetch(url, {
        method: 'POST',
        headers: { authorization: nip98Header(skB, url, 'POST') },
      });
      tokenB = (await res2.json()).token;
      assert.ok(tokenB, 'second key mints too');
    });

    it('anonymous token mint is 401; garbage f1 token never authenticates', async () => {
      const anon = await fetch(`${base}/forge/api/token`, { method: 'POST' });
      assert.strictEqual(anon.status, 401);
      const forged = `f1.${Buffer.from(JSON.stringify({ v: 1, agent: didA, exp: 9999999999 })).toString('base64url')}.AAAA`;
      const res = await fetch(`${base}/forge/api/token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${forged}` },
      });
      assert.strictEqual(res.status, 401, 'bad HMAC is anonymous, and tokens cannot mint tokens');
    });

    it('git push into the 64-hex namespace succeeds with the forge token (real git)', async () => {
      const remoteHex = `${base}/forge/${pkA}/nrepo.git`;
      await git([...authFlag(tokenA), 'push', remoteHex, 'main'], { cwd: work });
      assert.ok(fs.existsSync(repoDir(pkA, 'nrepo')), 'bare repo under repos/<hex>');
      const meta = JSON.parse(fs.readFileSync(path.join(repoDir(pkA, 'nrepo'), 'jss-forge.json'), 'utf8'));
      assert.strictEqual(meta.creator, didA, 'creator recorded as the did:nostr agent');
    });

    it("a DIFFERENT key's token cannot push into that namespace (403)", async () => {
      await assert.rejects(
        git([...authFlag(tokenB), 'push', `${base}/forge/${pkA}/nrepo.git`, 'main:intruder'], { cwd: work }),
        (err) => {
          assert.match(String(err.stderr), /403|forbidden|belongs to/i,
            `key B's push should be forbidden: ${err.stderr}`);
          return true;
        },
      );
    });

    it('an expired push token (minted with ttl 0) is 401', async () => {
      const url = `${base}/forge/api/token?ttl=0`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: nip98Header(skA, url, 'POST') },
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.ok(j.exp <= Math.floor(Date.now() / 1000), 'already expired');
      await assert.rejects(
        git([...authFlag(j.token), 'push', `${base}/forge/${pkA}/nrepo.git`, 'main:expired'], { cwd: work }),
        (err) => /authentication|401|could not read Username|terminal prompts disabled/i.test(String(err.stderr)),
      );
    });

    it('repo list, owner page and repo home display npub-short, hex stays in paths', async () => {
      const short = npubShortOf(pkA);
      const idx = await (await fetch(`${base}/forge/`)).text();
      assert.ok(idx.includes(short), 'index shows the shortened npub');
      assert.ok(idx.includes(`/forge/${pkA}/nrepo`), 'links keep the canonical hex path');
      const ownerHtml = await (await fetch(`${base}/forge/${pkA}`)).text();
      assert.ok(ownerHtml.includes(short), 'owner page heading is npub-short');
      const home = await (await fetch(`${base}/forge/${pkA}/nrepo`)).text();
      assert.ok(home.includes(short), 'repo crumb is npub-short');
      assert.ok(home.includes(`/forge/${pkA}/nrepo.git`), 'clone URL is hex');
    });

    it('a nostr agent opens an issue: body hosted by the forge (podless)', async () => {
      const url = `${base}/forge/api/repos/${pkA}/nrepo/issues`;
      const body = JSON.stringify({ title: 'Nostr-born issue', body: 'signed with **schnorr**' });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: nip98Header(skA, url, 'POST', body) },
        body,
      });
      assert.strictEqual(res.status, 201, 'NIP-98 with a payload tag verifies on the API');
      const j = await res.json();
      assert.strictEqual(j.number, 1);
      assert.strictEqual(j.hosted, true);
      hostedIssueUrl = j.resourceUrl;
      assert.ok(hostedIssueUrl.includes(`/forge/api/hosted/${pkA}/`),
        `hosted under the agent's hex: ${hostedIssueUrl}`);
      const direct = await fetch(hostedIssueUrl);
      assert.strictEqual(direct.status, 200, 'hosted doc publicly fetchable, like a pod resource');
      const doc = await direct.json();
      assert.strictEqual(doc.author, didA);
      assert.strictEqual(doc.hosted, true);
      assert.ok(doc.body.includes('**schnorr**'), 'raw markdown stored');
    });

    it("a second nostr key comments; thread JSON carries hosted + nostr author fields", async () => {
      const url = `${base}/forge/api/repos/${pkA}/nrepo/issues/1/comments`;
      const body = JSON.stringify({ body: 'confirmed from another key' });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: nip98Header(skB, url, 'POST', body) },
        body,
      });
      assert.strictEqual(res.status, 201);
      hostedCommentUrl = (await res.json()).resourceUrl;
      assert.ok(hostedCommentUrl.includes(`/forge/api/hosted/${pkB}/`), "hosted under the COMMENTER's hex");

      const t = await (await fetch(`${base}/forge/api/repos/${pkA}/nrepo/issues/1`)).json();
      assert.strictEqual(t.author, didA, 'author string stays the canonical DID');
      assert.deepStrictEqual(t.authorInfo, {
        id: didA, displayName: npubShortOf(pkA), npub: npubEncode(pkA), kind: 'nostr',
      }, 'additive author metadata');
      const [head, c1] = t.thread;
      assert.strictEqual(head.hosted, true);
      assert.strictEqual(head.authorInfo.kind, 'nostr');
      assert.ok(head.html.includes('<strong>schnorr</strong>'), 'markdown rendered from the hosted doc');
      assert.strictEqual(c1.hosted, true);
      assert.strictEqual(c1.authorInfo.npub, npubEncode(pkB));
    });

    it('thread HTML: "hosted by the forge" tag, npub-short author, no raw-hex name', async () => {
      const html = await (await fetch(`${base}/forge/${pkA}/nrepo/issues/1`)).text();
      assert.ok(html.includes('hosted by the forge'), 'hosted tag rendered');
      assert.ok(html.includes(`<b>${npubShortOf(pkA)}</b>`), 'author renders as npub-short');
      assert.ok(!html.includes(`>${pkA}<`), 'raw hex never rendered as a display name');
      assert.ok(html.includes(`/.well-known/did/nostr/${pkA}`), "author links to core's DID-document route");
      assert.ok(html.includes('>owner</span>'), 'hex-namespace owner badge still works');
    });

    it("another agent cannot delete someone else's hosted content (403)", async () => {
      const res = await fetch(hostedIssueUrl, {
        method: 'DELETE',
        headers: { authorization: nip98Header(skB, hostedIssueUrl, 'DELETE') },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual((await fetch(hostedIssueUrl)).status, 200, 'still there');
    });

    it('the author deletes their hosted content -> removed placeholder (the pod-delete beat)', async () => {
      const del = await fetch(hostedCommentUrl, {
        method: 'DELETE',
        headers: { authorization: nip98Header(skB, hostedCommentUrl, 'DELETE') },
      });
      assert.strictEqual(del.status, 200);
      assert.strictEqual((await fetch(hostedCommentUrl)).status, 404, 'the words are gone');

      const t = await (await fetch(`${base}/forge/api/repos/${pkA}/nrepo/issues/1`)).json();
      assert.strictEqual(t.thread[1].removed, true);
      assert.strictEqual(t.thread[1].body, null);
      assert.strictEqual(t.thread[1].author, `did:nostr:${pkB}`, 'the pointer (who/when) remains');
      const html = await (await fetch(`${base}/forge/${pkA}/nrepo/issues/1`)).text();
      assert.ok(html.includes('content removed by its author'), 'placeholder rendered');
      assert.ok(!html.includes('confirmed from another key'), 'deleted words gone from the forge');
    });

    it('xlogin.js is served byte-identical to the vendored file', async () => {
      const res = await fetch(`${base}/forge/xlogin.js`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type'), /^application\/javascript/);
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
      const served = Buffer.from(await res.arrayBuffer());
      const vendored = fs.readFileSync(path.join(__dirname, 'xlogin.js'));
      assert.ok(served.equals(vendored), 'byte-identical to forge/xlogin.js');
      assert.ok(served.toString('utf8').includes('version 0.0.15'), 'vendoring header present');
    });

    it("issues pages load the widget; CSP admits it and keeps connect-src 'self'", async () => {
      const res = await fetch(`${base}/forge/${pkA}/nrepo/issues/1`);
      const html = await res.text();
      assert.ok(html.includes('src="/forge/xlogin.js"'), 'script tag on the thread page');
      const cspHeader = res.headers.get('content-security-policy') ?? '';
      assert.match(cspHeader, /script-src 'unsafe-inline' 'self' https:\/\/esm\.sh/,
        "script-src admits the vendored widget and xlogin's esm.sh imports");
      assert.match(cspHeader, /connect-src 'self'(;|$)/,
        'connect-src stays self — external Solid IdPs blocked by default');
      assert.ok(html.includes('window.xlogin'), 'client integrates the widget when present');
    });
  });

  // ------------------------- tier 3a: forks, compare, pull requests, merges
  // The full story: dana forks casey/demo, pushes a feature branch to HER
  // fork, compare shows the divergence, a PR (body in dana's pod) carries
  // the conversation (issues thread machinery verbatim), and the merge is
  // REAL git: merge-tree --write-tree + commit-tree (two parents) +
  // update-ref with a compare-and-swap old-value guard. Conflicts, the
  // ff-when-possible policy, the CAS 409 and a nostr fork are all proven.

  describe('forks, compare and pull requests (tier 3a)', () => {
    let dana;       // re-minted token for the user registered in tier 2
    let apiBase;    // casey/demo JSON api
    let danaClone;  // dana's working clone of HER fork
    let featureSha; // dana's feature-branch commit
    let mergeSha;   // the PR #1 merge commit
    const authed = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

    before(async () => {
      dana = await mintToken(base, 'dana');
      apiBase = `${base}/forge/api/repos/casey/demo`;
    });

    it('anonymous fork is 401; dana forks casey/demo with lineage recorded; refork is 409', async () => {
      const anon = await fetch(`${apiBase}/fork`, { method: 'POST' });
      assert.strictEqual(anon.status, 401);

      const res = await fetch(`${apiBase}/fork`, { method: 'POST', headers: authed(dana.access_token) });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.strictEqual(j.owner, 'dana');
      assert.strictEqual(j.name, 'demo');
      assert.strictEqual(j.parent, 'casey/demo');
      assert.strictEqual(j.cloneUrl, `${base}/forge/dana/demo.git`);
      assert.ok(fs.existsSync(repoDir('dana', 'demo')), 'bare fork under repos/dana');
      const parent = (await git(['-C', repoDir('dana', 'demo'), 'config', '--get', 'forge.parent'])).stdout.trim();
      assert.strictEqual(parent, 'casey/demo', 'lineage in the fork\'s git config');

      const again = await fetch(`${apiBase}/fork`, { method: 'POST', headers: authed(dana.access_token) });
      assert.strictEqual(again.status, 409, 'same-name fork already exists');
    });

    it('lineage renders: "forked from" on the fork (home + list), fork count on the parent', async () => {
      const forkHome = await (await fetch(`${base}/forge/dana/demo`)).text();
      assert.ok(forkHome.includes('forked from'), 'fork home names its parent');
      assert.ok(forkHome.includes('href="/forge/casey/demo"'), 'parent linked');
      const parentHome = await (await fetch(`${base}/forge/casey/demo`)).text();
      assert.ok(parentHome.includes('1 fork'), 'parent shows the fork count');
      const list = await (await fetch(`${base}/forge/`)).text();
      assert.ok(list.includes('forked from'), 'repo list shows lineage');
      const meta = await (await fetch(`${base}/forge/api/repos/dana/demo`)).json();
      assert.strictEqual(meta.parent, 'casey/demo');
      const parentMeta = await (await fetch(apiBase)).json();
      assert.strictEqual(parentMeta.forks, 1);
    });

    it('dana pushes a feature branch to her fork', async () => {
      danaClone = path.join(tmp, 'dana-demo');
      await git(['clone', '--quiet', `${base}/forge/dana/demo.git`, danaClone]);
      await git(['checkout', '--quiet', '-b', 'feature'], { cwd: danaClone });
      fs.writeFileSync(path.join(danaClone, 'CONTRIBUTING.md'), '# Contributing\n\nPlease be kind.\n');
      await git(['add', '-A'], { cwd: danaClone });
      await git(['commit', '--quiet', '-m', 'add contributing guide'], { cwd: danaClone });
      featureSha = (await git(['rev-parse', 'HEAD'], { cwd: danaClone })).stdout.trim();
      await git([...authFlag(dana.access_token), 'push', '--quiet', 'origin', 'feature'], { cwd: danaClone });
      // the fork's home hints at the recent push with a compare link
      const forkHome = await (await fetch(`${base}/forge/dana/demo`)).text();
      assert.ok(forkHome.includes('open a pull request?'), 'recently-pushed hint');
      assert.ok(forkHome.includes('/forge/casey/demo/compare/main...dana:feature'), 'hint links the parent compare');
    });

    it('compare JSON: cross-fork head fetched and diffed; bogus head owner is 404', async () => {
      const cmp = await (await fetch(`${apiBase}/compare/main...dana:feature`)).json();
      assert.strictEqual(cmp.aheadBy, 1);
      assert.strictEqual(cmp.behindBy, 0);
      assert.strictEqual(cmp.head.owner, 'dana');
      assert.strictEqual(cmp.head.sha, featureSha);
      assert.strictEqual(cmp.commits.length, 1);
      assert.strictEqual(cmp.commits[0].subject, 'add contributing guide');
      assert.strictEqual(cmp.files.length, 1);
      assert.strictEqual(cmp.files[0].name, 'CONTRIBUTING.md');
      assert.ok(cmp.base.sha, 'base sha present');

      assert.strictEqual((await fetch(`${apiBase}/compare/main...nosuchowner:feature`)).status, 404);
      assert.strictEqual((await fetch(`${apiBase}/compare/main...dana:no-such-branch`)).status, 404);
      assert.strictEqual((await fetch(`${apiBase}/compare/main`)).status, 404, 'no ... separator');
      assert.strictEqual((await fetch(`${apiBase}/compare/main...dana:bad..ref`)).status, 404, 'traversal-ish ref refused');
    });

    it('compare HTML: ahead/behind, commit list, diff, open-PR button', async () => {
      const res = await fetch(`${base}/forge/casey/demo/compare/main...dana:feature`);
      assert.strictEqual(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('1 ahead, 0 behind'), 'ahead/behind counts');
      assert.ok(html.includes('add contributing guide'), 'ahead commit listed');
      assert.ok(html.includes('CONTRIBUTING.md'), 'diff file section');
      assert.ok(html.includes('<tr class="add">'), 'green rows');
      assert.ok(html.includes('Open pull request'), 'the PR button');
    });

    it('anonymous PR create is 401; dana opens PR #1 and the body lives in HER pod', async () => {
      const anon = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'nope', body: '', base: 'main', head: 'dana:feature' }),
      });
      assert.strictEqual(anon.status, 401);

      const res = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'Add contributing guide', body: 'Adds **CONTRIBUTING.md** with the basics.', base: 'main', head: 'dana:feature' }),
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.strictEqual(j.number, 1, 'pull numbering starts at 1, SEPARATE from issues');
      assert.ok(j.resourceUrl.includes('/dana/public/forge/casey--demo/pull-'),
        `PR body recorded in dana's pod: ${j.resourceUrl}`);
      const direct = await fetch(j.resourceUrl);
      assert.strictEqual(direct.status, 200);
      const doc = await direct.json();
      assert.strictEqual(doc.type, 'ForgePullRequest');
      assert.strictEqual(doc.repo, 'casey/demo');
      assert.strictEqual(doc.head, 'dana:feature');
      assert.strictEqual(doc.author, dana.webid);

      const bogus = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'x', body: '', base: 'main', head: 'nosuchowner:feature' }),
      });
      assert.strictEqual(bogus.status, 422, 'unresolvable head refused');
    });

    it("casey comments (pod resource in CASEY's pod); detail JSON is mergeable", async () => {
      const res = await fetch(`${apiBase}/pulls/1/comments`, {
        method: 'POST',
        headers: authed(casey.access_token),
        body: JSON.stringify({ body: 'Looks good, thanks!' }),
      });
      assert.strictEqual(res.status, 201);
      const j = await res.json();
      assert.ok(j.resourceUrl.includes('/casey/public/forge/casey--demo/comment-'),
        `comment in casey's pod: ${j.resourceUrl}`);

      const pr = await (await fetch(`${apiBase}/pulls/1`)).json();
      assert.strictEqual(pr.state, 'open');
      assert.deepStrictEqual({ owner: pr.head.owner, ref: pr.head.ref }, { owner: 'dana', ref: 'feature' });
      assert.strictEqual(pr.base, 'main');
      assert.ok(pr.baseSha, 'baseSha exposed (the CAS token for the UI)');
      assert.strictEqual(pr.mergeable, true);
      assert.deepStrictEqual(pr.conflicts, []);
      assert.strictEqual(pr.thread.length, 2);
      assert.strictEqual(pr.thread[0].author, dana.webid);
      assert.ok(pr.thread[0].html.includes('<strong>CONTRIBUTING.md</strong>'), 'markdown rendered');
      assert.strictEqual(pr.thread[1].author, casey.webid);
    });

    it('pull pages render: tab + list + conversation/commits/files sub-tabs', async () => {
      const home = await (await fetch(`${base}/forge/casey/demo`)).text();
      assert.match(home, /Pull requests <span class="badge">1<\/span>/, 'tab carries the open count');

      const list = await (await fetch(`${base}/forge/casey/demo/pulls`)).text();
      assert.ok(list.includes('Add contributing guide'), 'PR listed');
      assert.ok(list.includes('pr-open'), 'green open chip');
      assert.ok(list.includes('dana:feature'), 'head → base shown');

      const conv = await (await fetch(`${base}/forge/casey/demo/pulls/1`)).text();
      assert.ok(conv.includes('opened this pull request'), 'conversation thread');
      assert.ok(conv.includes('no conflicts with the base branch'), 'clean banner');
      assert.ok(conv.includes('id="do-merge"'), 'merge button present');
      assert.ok(conv.includes('Looks good, thanks!'), 'comment body re-fetched from the pod');

      const commits = await (await fetch(`${base}/forge/casey/demo/pulls/1/commits`)).text();
      assert.ok(commits.includes('add contributing guide'), 'ahead commit on the Commits tab');

      const files = await (await fetch(`${base}/forge/casey/demo/pulls/1/files`)).text();
      assert.ok(files.includes('CONTRIBUTING.md'), 'file section');
      assert.ok(files.includes('<tr class="add">'), 'diff rows');
    });

    it("dana cannot merge into casey's repo (403); anonymous merge is 401", async () => {
      const forbidden = await fetch(`${apiBase}/pulls/1/merge`, { method: 'POST', headers: authed(dana.access_token) });
      assert.strictEqual(forbidden.status, 403);
      const anon = await fetch(`${apiBase}/pulls/1/merge`, { method: 'POST' });
      assert.strictEqual(anon.status, 401);
      const pr = await (await fetch(`${apiBase}/pulls/1`)).json();
      assert.strictEqual(pr.state, 'open', 'still open');
    });

    it('casey merges PR #1: a real merge commit, two parents, honest authorship', async () => {
      // diverge main first (a different file) so this is a genuine
      // two-parent merge rather than the ff case (proven separately below)
      await git(['pull', '--quiet', '--ff-only', remote, 'main'], { cwd: work });
      fs.appendFileSync(path.join(work, 'README.md'), '\nA line added upstream.\n');
      await git(['commit', '--quiet', '-am', 'upstream readme note'], { cwd: work });
      await git([...authFlag(casey.access_token), 'push', '--quiet', remote, 'main'], { cwd: work });

      const res = await fetch(`${apiBase}/pulls/1/merge`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(res.status, 200);
      const j = await res.json();
      assert.strictEqual(j.state, 'merged');
      assert.strictEqual(j.fastForward, false, 'histories diverged: a merge commit was made');
      mergeSha = j.sha;

      const dir = repoDir('casey', 'demo');
      const log = (await git(['-C', dir, 'log', '--format=%H|%P|%an|%cn|%s', 'main'])).stdout;
      assert.ok(log.includes(featureSha), "dana's commit is reachable from casey's main");
      const mergeLine = log.split('\n').find((l) => l.startsWith(mergeSha));
      assert.ok(mergeLine, 'merge commit on main');
      const [, parents, an, cn, subject] = mergeLine.split('|');
      assert.strictEqual(parents.split(' ').length, 2, 'two parents');
      assert.strictEqual(an, 'casey', 'author is the merging agent');
      assert.strictEqual(cn, 'forge', 'committer is the forge');
      assert.strictEqual(subject, 'Merge pull request #1 from dana:feature');

      const pr = await (await fetch(`${apiBase}/pulls/1`)).json();
      assert.strictEqual(pr.state, 'merged');
      assert.strictEqual(pr.merged.sha, mergeSha);
      assert.strictEqual(pr.merged.mergedBy, casey.webid);

      const conv = await (await fetch(`${base}/forge/casey/demo/pulls/1`)).text();
      assert.ok(conv.includes('state-merged'), 'purple Merged pill on the page');
      const list = await (await fetch(`${base}/forge/casey/demo/pulls?state=merged`)).text();
      assert.ok(list.includes('Add contributing guide') && list.includes('pr-merged'),
        'merged filter shows the PR with the purple chip');
    });

    it('conflict: both sides change the same line -> 409, conflicted path named, PR stays open', async () => {
      // casey moves main (same line dana will touch)
      await git(['pull', '--quiet', '--ff-only', remote, 'main'], { cwd: work });
      fs.writeFileSync(path.join(work, 'src', 'main.js'), 'function main() {\n  return 3;\n}\n');
      await git(['commit', '--quiet', '-am', 'main goes to 3'], { cwd: work });
      await git([...authFlag(casey.access_token), 'push', '--quiet', remote, 'main'], { cwd: work });

      // dana's branch2 (from the fork point) touches the same line
      await git(['checkout', '--quiet', 'main'], { cwd: danaClone });
      await git(['checkout', '--quiet', '-b', 'branch2'], { cwd: danaClone });
      fs.writeFileSync(path.join(danaClone, 'src', 'main.js'), 'function main() {\n  return 42;\n}\n');
      await git(['commit', '--quiet', '-am', 'main goes to 42'], { cwd: danaClone });
      await git([...authFlag(dana.access_token), 'push', '--quiet', 'origin', 'branch2'], { cwd: danaClone });

      const create = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'Return 42', body: 'the answer', base: 'main', head: 'dana:branch2' }),
      });
      assert.strictEqual(create.status, 201);
      assert.strictEqual((await create.json()).number, 2);

      const pr = await (await fetch(`${apiBase}/pulls/2`)).json();
      assert.strictEqual(pr.mergeable, false, 'detail reports the conflict');
      assert.deepStrictEqual(pr.conflicts, ['src/main.js']);

      const conv = await (await fetch(`${base}/forge/casey/demo/pulls/2`)).text();
      assert.ok(conv.includes('conflicts that must be resolved'), 'conflict banner');
      assert.ok(conv.includes('src/main.js'), 'conflicted path named on the page');
      assert.ok(!conv.includes('id="do-merge"'), 'merge button withheld');

      const merge = await fetch(`${apiBase}/pulls/2/merge`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(merge.status, 409);
      const mj = await merge.json();
      assert.strictEqual(mj.error, 'merge conflict');
      assert.deepStrictEqual(mj.conflicts, ['src/main.js']);
      assert.strictEqual((await (await fetch(`${apiBase}/pulls/2`)).json()).state, 'open', 'PR survives the failed merge');
    });

    it('casey closes the conflicted PR (red chip); a merged PR cannot be closed', async () => {
      const close = await fetch(`${apiBase}/pulls/2/close`, { method: 'POST', headers: authed(casey.access_token) });
      assert.deepStrictEqual(await close.json(), { number: 2, state: 'closed' });
      const closed = await (await fetch(`${apiBase}/pulls?state=closed`)).json();
      assert.deepStrictEqual(closed.pulls.map((p) => p.number), [2]);
      const html = await (await fetch(`${base}/forge/casey/demo/pulls?state=closed`)).text();
      assert.ok(html.includes('Return 42') && html.includes('pr-closed'), 'closed filter, red chip');

      const sealed = await fetch(`${apiBase}/pulls/1/close`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(sealed.status, 422, 'merged is final');
    });

    it('fast-forward: a branch from the current tip merges with NO merge commit (ff-when-possible)', async () => {
      await git(['fetch', '--quiet', remote, 'main'], { cwd: danaClone });
      await git(['checkout', '--quiet', '-b', 'ff', 'FETCH_HEAD'], { cwd: danaClone });
      fs.writeFileSync(path.join(danaClone, 'docs', 'ff.txt'), 'fast forward\n');
      await git(['add', '-A'], { cwd: danaClone });
      await git(['commit', '--quiet', '-m', 'ff change'], { cwd: danaClone });
      const ffSha = (await git(['rev-parse', 'HEAD'], { cwd: danaClone })).stdout.trim();
      await git([...authFlag(dana.access_token), 'push', '--quiet', 'origin', 'ff'], { cwd: danaClone });

      const create = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'FF change', body: '', base: 'main', head: 'dana:ff' }),
      });
      const { number } = await create.json();
      assert.strictEqual(number, 3);

      const merge = await fetch(`${apiBase}/pulls/3/merge`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(merge.status, 200);
      const j = await merge.json();
      assert.strictEqual(j.fastForward, true);
      assert.strictEqual(j.sha, ffSha, "merged sha IS dana's commit — no synthetic merge commit");

      const dir = repoDir('casey', 'demo');
      const tip = (await git(['-C', dir, 'log', '-1', '--format=%H|%P', 'main'])).stdout.trim();
      assert.strictEqual(tip.split('|')[0], ffSha, 'main fast-forwarded to the head');
      assert.strictEqual(tip.split('|')[1].split(' ').length, 1, 'single parent: no merge commit');
      assert.strictEqual((await (await fetch(`${apiBase}/pulls/3`)).json()).state, 'merged');
    });

    it('CAS guard: the base moving between diff and merge is a 409 the first time', async () => {
      await git(['fetch', '--quiet', remote, 'main'], { cwd: danaClone });
      await git(['checkout', '--quiet', '-b', 'cas', 'FETCH_HEAD'], { cwd: danaClone });
      fs.writeFileSync(path.join(danaClone, 'cas.txt'), 'compare and swap\n');
      await git(['add', '-A'], { cwd: danaClone });
      await git(['commit', '--quiet', '-m', 'cas change'], { cwd: danaClone });
      await git([...authFlag(dana.access_token), 'push', '--quiet', 'origin', 'cas'], { cwd: danaClone });

      const create = await fetch(`${apiBase}/pulls`, {
        method: 'POST',
        headers: authed(dana.access_token),
        body: JSON.stringify({ title: 'CAS probe', body: '', base: 'main', head: 'dana:cas' }),
      });
      assert.strictEqual((await create.json()).number, 4);
      const seen = (await (await fetch(`${apiBase}/pulls/4`)).json()).baseSha;
      assert.ok(seen, 'the diff the merger saw is pinned to a base sha');

      // the base moves underneath (an unrelated push to main)
      await git(['pull', '--quiet', '--ff-only', remote, 'main'], { cwd: work });
      fs.appendFileSync(path.join(work, 'docs', 'notes.txt'), 'one more note\n');
      await git(['commit', '--quiet', '-am', 'notes tweak'], { cwd: work });
      await git([...authFlag(casey.access_token), 'push', '--quiet', remote, 'main'], { cwd: work });

      const stale = await fetch(`${apiBase}/pulls/4/merge`, {
        method: 'POST',
        headers: authed(casey.access_token),
        body: JSON.stringify({ expectedBase: seen }),
      });
      assert.strictEqual(stale.status, 409, 'stale expectedBase is rejected');
      assert.match((await stale.json()).error, /moved/);
      assert.strictEqual((await (await fetch(`${apiBase}/pulls/4`)).json()).state, 'open');

      // a fresh look merges fine (different files — clean three-way)
      const retry = await fetch(`${apiBase}/pulls/4/merge`, { method: 'POST', headers: authed(casey.access_token) });
      assert.strictEqual(retry.status, 200);
      const j = await retry.json();
      assert.strictEqual(j.fastForward, false);
      const line = (await git(['-C', repoDir('casey', 'demo'), 'log', '-1', '--format=%P|%s', 'main'])).stdout.trim();
      assert.strictEqual(line.split('|')[0].split(' ').length, 2, 'real merge commit after the retry');
      assert.strictEqual(line.split('|')[1], 'Merge pull request #4 from dana:cas');
    });

    it('a nostr agent forks into its hex namespace and opens a PR via NIP-98', async () => {
      const sk = bytesToHex(schnorr.utils.randomPrivateKey());
      const pk = bytesToHex(schnorr.getPublicKey(sk));

      const forkUrl = `${apiBase}/fork`;
      const fork = await fetch(forkUrl, {
        method: 'POST',
        headers: { authorization: nip98Header(sk, forkUrl, 'POST') },
      });
      assert.strictEqual(fork.status, 201);
      const fj = await fork.json();
      assert.strictEqual(fj.owner, pk, 'forked into the 64-hex namespace');
      assert.ok(fs.existsSync(repoDir(pk, 'demo')));
      const parent = (await git(['-C', repoDir(pk, 'demo'), 'config', '--get', 'forge.parent'])).stdout.trim();
      assert.strictEqual(parent, 'casey/demo');

      // push a change to the fork with an exchanged bearer, then PR it
      const tokUrl = `${base}/forge/api/token`;
      const tok = (await (await fetch(tokUrl, {
        method: 'POST',
        headers: { authorization: nip98Header(sk, tokUrl, 'POST') },
      })).json()).token;
      const nClone = path.join(tmp, 'nostr-demo');
      await git(['clone', '--quiet', `${base}/forge/${pk}/demo.git`, nClone]);
      await git(['checkout', '--quiet', '-b', 'npatch'], { cwd: nClone });
      fs.writeFileSync(path.join(nClone, 'nostr.txt'), 'signed with schnorr\n');
      await git(['add', '-A'], { cwd: nClone });
      await git(['commit', '--quiet', '-m', 'nostr patch'], { cwd: nClone });
      await git([...authFlag(tok), 'push', '--quiet', 'origin', 'npatch'], { cwd: nClone });

      const prUrl = `${apiBase}/pulls`;
      const prBody = JSON.stringify({ title: 'Nostr-born PR', body: 'from a **key**, not a pod', base: 'main', head: `${pk}:npatch` });
      const create = await fetch(prUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: nip98Header(sk, prUrl, 'POST', prBody) },
        body: prBody,
      });
      assert.strictEqual(create.status, 201, 'NIP-98 with a payload tag opens the PR');
      const pj = await create.json();
      assert.strictEqual(pj.number, 5);
      assert.strictEqual(pj.hosted, true, 'podless body is forge-hosted');
      assert.ok(pj.resourceUrl.includes(`/forge/api/hosted/${pk}/`));

      const pr = await (await fetch(`${apiBase}/pulls/5`)).json();
      assert.strictEqual(pr.author, `did:nostr:${pk}`);
      assert.strictEqual(pr.authorInfo.kind, 'nostr');
      assert.strictEqual(pr.head.owner, pk);
      assert.strictEqual(pr.thread[0].hosted, true);
    });

    it('pull and issue numbering are independent (the documented deviation)', async () => {
      const issue1 = await (await fetch(`${apiBase}/issues/1`)).json();
      const pull1 = await (await fetch(`${apiBase}/pulls/1`)).json();
      assert.strictEqual(issue1.number, 1);
      assert.strictEqual(pull1.number, 1);
      assert.notStrictEqual(issue1.title, pull1.title, 'same number, different registries');
      const pulls = await (await fetch(`${apiBase}/pulls?state=open`)).json();
      assert.strictEqual(pulls.openCount, 1, 'only the nostr PR remains open');
      assert.strictEqual(pulls.mergedCount, 3);
      assert.strictEqual(pulls.closedCount, 1);
    });
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
