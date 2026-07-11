// RSS/Atom feed plugin over a real JSS from npm: seed a pod container with
// JSON-LD posts, then subscribe to it through GET /feed/atom and /feed/rss —
// the loopback container walk, newest-first ordering, content negotiation,
// and the loopback-WAC property (a private feed is empty/refused without the
// caller's own token).
//
// Same probe-port-then-boot dance as sparql/webdav: the plugin needs the
// server's own origin in config before listen (api.serverInfo finding). And
// the misconfiguration test runs FIRST, because a failed second createServer
// re-points JSS's process-global data root and would poison the live server.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const module_ = path.join(__dirname, 'plugin.js');

const PASSWORD = 'correct-horse-battery';

async function registerAndMint(base, username) {
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, confirmPassword: PASSWORD }),
  });
  assert.ok(reg.status < 400, `register ${username}: ${reg.status}`);
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const body = await cred.json();
  assert.ok(body.access_token, `mint ${username} failed: ${JSON.stringify(body)}`);
  return body; // { access_token, webid }
}

describe('rss feed plugin', () => {
  let jss;
  let base;
  let alice; // { access_token, webid }
  let mallory;

  const feed = (kind, { token, container, accept } = {}) => {
    const qs = container ? `?container=${encodeURIComponent(container)}` : '';
    return fetch(`${base}/feed${kind}${qs}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(accept ? { accept } : {}),
      },
    });
  };

  after(async () => { if (jss) await jss.close(); });

  it('refuses to boot without config.baseUrl', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: module_, prefix: '/feed' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + pods, registers agents, seeds JSON-LD posts', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [
        {
          id: 'feed',
          module: module_,
          prefix: '/feed',
          config: { baseUrl: base, title: "Alice's journal", maxItems: 50 },
        },
        {
          // A second mount wired to a default container, to prove ?container=
          // is optional when config.defaultContainer is set.
          id: 'blogfeed',
          module: module_,
          prefix: '/blogfeed',
          config: { baseUrl: base, title: 'Default-container feed', defaultContainer: '/alice/blog/' },
        },
      ],
    });
    alice = await registerAndMint(base, 'alice');
    mallory = await registerAndMint(base, 'mallory');

    // Seed alice's blog container (owner-only by default WAC). PUT order is
    // deliberately NOT the date order, to prove sorting is on the date field,
    // not on insertion / listing order.
    const posts = {
      'post-middle.jsonld': {
        '@context': { schema: 'https://schema.org/', dcterms: 'http://purl.org/dc/terms/' },
        '@id': '',
        '@type': 'schema:BlogPosting',
        'schema:headline': 'A quiet Tuesday',
        'schema:datePublished': '2026-03-10',
        'schema:articleBody': 'Nothing much happened, and that was <fine>.',
      },
      'post-oldest.jsonld': {
        '@context': { schema: 'https://schema.org/' },
        '@id': '',
        '@type': 'schema:BlogPosting',
        'schema:name': 'First light',
        'schema:datePublished': '2025-11-01',
        'schema:text': 'The very first entry in this journal.',
      },
      'post-newest.jsonld': {
        '@context': { dcterms: 'http://purl.org/dc/terms/' },
        '@id': '',
        'dcterms:title': 'Storm over the bay',
        'dcterms:issued': '2026-06-20',
        'dcterms:description': 'Wind & rain all night; the pier held.',
      },
    };
    for (const [name, doc] of Object.entries(posts)) {
      const res = await fetch(`${base}/alice/blog/${name}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/ld+json',
          authorization: `Bearer ${alice.access_token}`,
        },
        body: JSON.stringify(doc),
      });
      assert.ok(res.status < 400, `seed ${name}: ${res.status}`);
    }
  });

  it('GET /feed/atom is a valid-ish Atom feed with an entry per post', async () => {
    const res = await feed('/atom', { token: alice.access_token, container: '/alice/blog/' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/atom\+xml/);
    const xml = await res.text();

    // Feed-level: <feed>, title, id = the container, self link, updated.
    assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'), xml);
    assert.ok(xml.includes("<title>Alice&apos;s journal</title>"), xml);
    assert.ok(xml.includes(`<id>${base}/alice/blog/</id>`), xml);
    assert.ok(xml.includes('<link rel="self"'), xml);
    assert.match(xml, /<updated>\d{4}-\d\d-\d\dT/, 'feed needs an <updated>');

    // The three titles, drawn from schema:headline, schema:name, dcterms:title.
    for (const t of ['A quiet Tuesday', 'First light', 'Storm over the bay']) {
      assert.ok(xml.includes(`<title>${t}</title>`), `missing entry title ${t}`);
    }
    // entry <id> equals the resource URL for each member.
    for (const name of ['post-middle', 'post-oldest', 'post-newest']) {
      assert.ok(xml.includes(`<id>${base}/alice/blog/${name}.jsonld</id>`), `missing id for ${name}`);
    }
    // content is escaped, not raw markup.
    assert.ok(xml.includes('and that was &lt;fine&gt;.'), 'content must be XML-escaped');
    assert.ok(!xml.includes('<fine>'), 'raw markup leaked into the feed');
  });

  it('entries are newest-first by the date field (not PUT / listing order)', async () => {
    const res = await feed('/atom', { token: alice.access_token, container: '/alice/blog/' });
    const xml = await res.text();
    const order = [...xml.matchAll(/<entry>[\s\S]*?<title>([^<]+)<\/title>/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      order,
      ['Storm over the bay', 'A quiet Tuesday', 'First light'],
      'entries must be sorted newest-first: 2026-06-20, 2026-03-10, 2025-11-01',
    );
  });

  it('GET /feed/rss is RSS 2.0 with an <item> per post', async () => {
    const res = await feed('/rss', { token: alice.access_token, container: '/alice/blog/' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
    const xml = await res.text();
    assert.ok(xml.includes('<rss version="2.0"'), xml);
    assert.ok(xml.includes('<channel>'), xml);
    assert.strictEqual((xml.match(/<item>/g) || []).length, 3, 'one <item> per post');
    for (const t of ['A quiet Tuesday', 'First light', 'Storm over the bay']) {
      assert.ok(xml.includes(`<title>${t}</title>`), `missing item title ${t}`);
    }
    // guid / link carry the resource URL; pubDate is RFC 822.
    assert.ok(xml.includes(`<guid isPermaLink="true">${base}/alice/blog/post-newest.jsonld</guid>`), xml);
    assert.match(xml, /<pubDate>[A-Z][a-z]{2}, \d\d /, 'RSS pubDate must be RFC 822');
  });

  it('GET /feed content-negotiates: Accept rss → RSS, default → Atom', async () => {
    const rss = await feed('', {
      token: alice.access_token, container: '/alice/blog/', accept: 'application/rss+xml',
    });
    assert.match(rss.headers.get('content-type'), /application\/rss\+xml/);
    assert.ok((await rss.text()).includes('<rss version="2.0"'));

    const atom = await feed('', {
      token: alice.access_token, container: '/alice/blog/', accept: 'application/atom+xml',
    });
    assert.match(atom.headers.get('content-type'), /application\/atom\+xml/);

    const def = await feed('', { token: alice.access_token, container: '/alice/blog/' });
    assert.match(def.headers.get('content-type'), /application\/atom\+xml/, 'default is Atom');
  });

  it('WAC via loopback: a private feed is refused/empty without the owner token', async () => {
    // Owner sees all three…
    const owner = await feed('/atom', { token: alice.access_token, container: '/alice/blog/' });
    assert.strictEqual((await owner.text()).match(/<entry>/g).length, 3);

    // …anonymous is refused (the container GET is 401/403 over loopback)…
    const anon = await feed('/atom', { container: '/alice/blog/' });
    assert.ok(anon.status >= 400, `anonymous should be refused, got ${anon.status}`);
    const anonBody = await anon.text();
    assert.ok(!anonBody.includes('<entry>'), 'anonymous must not see private entries');

    // …and a different authenticated agent is refused too.
    const stranger = await feed('/atom', { token: mallory.access_token, container: '/alice/blog/' });
    assert.ok(stranger.status >= 400, `stranger should be refused, got ${stranger.status}`);
    assert.ok(!(await stranger.text()).includes('<entry>'), 'stranger must not see alice\'s entries');
  });

  it('config.defaultContainer serves without ?container=; missing scope is 400', async () => {
    // The /blogfeed mount defaults to /alice/blog/, so no ?container= needed.
    const res = await fetch(`${base}/blogfeed/atom`, {
      headers: { authorization: `Bearer ${alice.access_token}` },
    });
    assert.strictEqual(res.status, 200);
    const xml = await res.text();
    assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'), xml);
    assert.ok(xml.includes('<title>Storm over the bay</title>'), 'default container should serve the blog');
    assert.strictEqual((xml.match(/<entry>/g) || []).length, 3, 'all three posts via the default container');

    // The /feed mount has no default → no ?container= is a 400.
    const noScope = await feed('/atom', { token: alice.access_token });
    assert.strictEqual(noScope.status, 400);
    assert.match((await noScope.json()).error, /name a container/);
  });
});
