// CalDAV bridge over a real JSS from npm: a pod is created via /.pods (idp),
// then the whole sync vertical slice is driven with the pod's Bearer token —
// every operation crossing the bridge, over loopback, through real WAC:
//
//   OPTIONS advertises calendar-access → MKCALENDAR the calendar → PUT a VEVENT
//   .ics (ETag back) → PROPFIND Depth 1 lists it (etag, text/calendar) → GET
//   returns the VEVENT → REPORT calendar-multiget returns it → DELETE →
//   PROPFIND drops it.
//
// Same probe-port-then-boot dance as webdav/carddav/notifications: the plugin
// needs the server origin in config before listen (finding: api.serverInfo).

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

const VEVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//JSS caldav bridge//EN',
  'BEGIN:VEVENT',
  'UID:urn:uuid:ada1b2c3-0000-4000-8000-000000000001',
  'DTSTAMP:20260710T120000Z',
  'DTSTART:20260711T090000Z',
  'DTEND:20260711T100000Z',
  'SUMMARY:Analytical Engine demo',
  'LOCATION:London',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('caldav plugin', () => {
  let jss;
  let base;
  let token;
  const cd = (p) => `${base}/caldav${p}`;
  const bearer = () => ({ authorization: `Bearer ${token}` });
  const calendar = '/caldav/cal/calendar/';
  const event = '/caldav/cal/calendar/demo.ics';

  after(async () => { if (jss) await jss.close(); });

  // Must run BEFORE the real boot: JSS keeps a module-level storage root, so a
  // failed second createServer re-points storage for the already-listening
  // server (the footgun webdav/carddav/notifications document).
  it('refuses to boot without baseUrl (no api.serverInfo — same finding as carddav)', async () => {
    await assert.rejects(
      startJss({ plugins: [{ module: path.join(__dirname, 'plugin.js'), prefix: '/caldav' }] }),
      /requires config\.baseUrl/,
    );
  });

  it('boots with idp + caldav; a pod created via /.pods hands out a Bearer', async () => {
    const port = await probePort();
    base = `http://127.0.0.1:${port}`;
    jss = await startJss({
      port,
      idp: true,
      plugins: [{
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/caldav',
        config: { baseUrl: base },
      }],
    });
    const res = await fetch(`${base}/.pods`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cal', email: 'cal@example.com', password: 'cal-pass-123' }),
    });
    assert.strictEqual(res.status, 201, `pod creation: ${res.status}`);
    ({ token } = await res.json());
    assert.ok(token, 'pod creation returned no token');
  });

  it('OPTIONS advertises DAV: calendar-access and the CalDAV methods', async () => {
    const res = await fetch(cd('/cal/calendar/'), { method: 'OPTIONS' });
    assert.strictEqual(res.status, 200);
    const dav = res.headers.get('dav') || '';
    assert.match(dav, /calendar-access/, `DAV header: ${dav}`);
    assert.match(dav, /\b3\b/, `DAV header missing class 3: ${dav}`);
    const allow = res.headers.get('allow') || '';
    for (const m of ['OPTIONS', 'GET', 'PUT', 'DELETE', 'PROPFIND', 'REPORT', 'MKCALENDAR']) {
      assert.ok(allow.includes(m), `Allow missing ${m}: ${allow}`);
    }
  });

  it('MKCALENDAR creates the calendar collection', async () => {
    const res = await fetch(cd('/cal/calendar/'), { method: 'MKCALENDAR', headers: bearer() });
    assert.strictEqual(res.status, 201, `MKCALENDAR: ${res.status}`);
  });

  it('PROPFIND marks the collection as a CAL:calendar with VEVENT support', async () => {
    const res = await fetch(cd('/cal/calendar/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav">'
        + '<D:prop><D:resourcetype/><CAL:supported-calendar-component-set/></D:prop></D:propfind>',
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${calendar}</D:href>`), xml);
    assert.ok(xml.includes('<CAL:calendar/>'), `not marked calendar: ${xml}`);
    assert.ok(xml.includes('name="VEVENT"'), `no VEVENT component set: ${xml}`);
  });

  let putEtag;
  it('PUT a VEVENT through the bridge returns an ETag', async () => {
    const res = await fetch(cd('/cal/calendar/demo.ics'), {
      method: 'PUT',
      headers: { ...bearer(), 'content-type': 'text/calendar' },
      body: VEVENT,
    });
    assert.ok([200, 201, 204].includes(res.status), `PUT: ${res.status}`);
    putEtag = res.headers.get('etag');
    assert.ok(putEtag && /^".+"$/.test(putEtag), `no ETag on PUT: ${putEtag}`);
  });

  it('401 without a token — WAC still rules', async () => {
    const res = await fetch(cd('/cal/calendar/demo.ics'));
    assert.strictEqual(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /^Basic /);
  });

  it('PROPFIND Depth 1 lists the event with getetag + text/calendar', async () => {
    const res = await fetch(cd('/cal/calendar/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:">'
        + '<D:prop><D:getetag/><D:getcontenttype/><D:resourcetype/></D:prop></D:propfind>',
    });
    assert.strictEqual(res.status, 207);
    assert.match(res.headers.get('content-type') || '', /application\/xml/);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${event}</D:href>`), xml);
    // the event carries the same content-hash ETag the PUT returned…
    assert.ok(xml.includes(`<D:getetag>${putEtag}</D:getetag>`), `etag mismatch: ${xml}`);
    assert.ok(xml.includes('<D:getcontenttype>text/calendar</D:getcontenttype>'), xml);
  });

  it('GET returns the VEVENT body byte-for-byte with an ETag', async () => {
    const res = await fetch(cd('/cal/calendar/demo.ics'), { headers: bearer() });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/calendar/);
    assert.strictEqual(res.headers.get('etag'), putEtag);
    assert.strictEqual(await res.text(), VEVENT);
  });

  it('REPORT calendar-multiget returns the requested VEVENT + etag', async () => {
    const res = await fetch(cd('/cal/calendar/'), {
      method: 'REPORT',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?>'
        + '<CAL:calendar-multiget xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav">'
        + '<D:prop><D:getetag/><CAL:calendar-data/></D:prop>'
        + `<D:href>${event}</D:href></CAL:calendar-multiget>`,
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${event}</D:href>`), xml);
    assert.ok(xml.includes(`<D:getetag>${putEtag}</D:getetag>`), xml);
    assert.ok(xml.includes('<CAL:calendar-data>'), xml);
    assert.ok(xml.includes('SUMMARY:Analytical Engine demo'), `VEVENT body not returned: ${xml}`);
  });

  it('REPORT calendar-query returns all events in the collection', async () => {
    const res = await fetch(cd('/cal/calendar/'), {
      method: 'REPORT',
      headers: { ...bearer(), depth: '1', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?>'
        + '<CAL:calendar-query xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav">'
        + '<D:prop><D:getetag/><CAL:calendar-data/></D:prop>'
        + '<CAL:filter><CAL:comp-filter name="VCALENDAR">'
        + '<CAL:comp-filter name="VEVENT"/></CAL:comp-filter></CAL:filter></CAL:calendar-query>',
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes(`<D:href>${event}</D:href>`), xml);
    assert.ok(xml.includes('SUMMARY:Analytical Engine demo'), xml);
  });

  it('discovery: PROPFIND current-user-principal + calendar-home-set resolve', async () => {
    const res = await fetch(cd('/cal/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '0', 'content-type': 'application/xml' },
      body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:" xmlns:CAL="urn:ietf:params:xml:ns:caldav">'
        + '<D:prop><D:current-user-principal/><CAL:calendar-home-set/></D:prop></D:propfind>',
    });
    assert.strictEqual(res.status, 207);
    const xml = await res.text();
    assert.ok(xml.includes('<D:current-user-principal>'), xml);
    assert.ok(xml.includes('<CAL:calendar-home-set>'), xml);
    assert.ok(xml.includes('/caldav/cal/'), `home-set not under pod: ${xml}`);
  });

  it('/.well-known/caldav 301s toward the discovery root', async () => {
    const res = await fetch(`${base}/.well-known/caldav`, { redirect: 'manual' });
    assert.ok([301, 302, 307, 308].includes(res.status), `well-known status: ${res.status}`);
    assert.match(res.headers.get('location') || '', /\/caldav\/?$/);
  });

  it('DELETE removes the event; PROPFIND no longer lists it; GET is 404', async () => {
    const del = await fetch(cd('/cal/calendar/demo.ics'), { method: 'DELETE', headers: bearer() });
    assert.strictEqual(del.status, 204);

    const list = await fetch(cd('/cal/calendar/'), {
      method: 'PROPFIND',
      headers: { ...bearer(), depth: '1' },
    });
    assert.strictEqual(list.status, 207);
    assert.ok(!(await list.text()).includes('demo.ics'), 'still listed after delete');

    const got = await fetch(cd('/cal/calendar/demo.ics'), { headers: bearer() });
    assert.strictEqual(got.status, 404);
  });

  it('Basic auth bridges to Bearer: username anything, pod token as password', async () => {
    const basic = Buffer.from(`cal:${token}`).toString('base64');
    const res = await fetch(cd('/cal/calendar/'), {
      method: 'PROPFIND',
      headers: { authorization: `Basic ${basic}`, depth: '0' },
    });
    assert.strictEqual(res.status, 207);
  });
});
