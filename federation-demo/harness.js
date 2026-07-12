// Driver-side helpers shared by test.js (assertions) and demo.js
// (narration): spawn a federated JSS instance in a child process (see
// instance.js for why a child process is mandatory), register a pod owner,
// post activities, and poll the activitypub plugin's persisted state.
//
// Reading state files from the driver is legitimate observation, not a
// bypass: the Phase-1 activitypub plugin has no GET-inbox route, and its
// own test suite reads <root>/.plugins/activitypub/state/<user>.json the
// same way to assert on the inbox log.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));
const INSTANCE = path.join(__dirname, 'instance.js');

export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
export const AP_CT = 'application/activity+json';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a truthy value (which is returned). */
export async function waitFor(probe, what, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

/**
 * Spawn one federated JSS instance (instance.js) and wait for READY.
 * Returns { name, base, port, root, readState, stop }.
 */
export async function spawnInstance({ name = 'jss', allowPrivateDelivery = false } = {}) {
  const child = spawn(
    process.execPath,
    [INSTANCE, JSON.stringify({ name, allowPrivateDelivery })],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });

  const info = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name}: boot timed out\n${stderr}`));
    }, 30000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/^READY (.*)$/m);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name}: exited (${code}) before READY\n${stderr}`));
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const stateFile = (user) => path.join(info.root, '.plugins', 'activitypub', 'state', `${user}.json`);
  return {
    name,
    base: info.base,
    port: info.port,
    root: info.root,
    /** The activitypub plugin's persisted per-actor state (empty default). */
    readState(user) {
      try { return JSON.parse(fs.readFileSync(stateFile(user), 'utf8')); }
      catch { return { inbox: [], followers: [], following: [], notes: [] }; }
    },
    async stop() {
      if (child.exitCode === null && !child.killed) {
        child.stdin.end(); // instance.js shuts down on stdin end
        const exited = await Promise.race([
          once(child, 'exit').then(() => true),
          sleep(5000).then(() => false),
        ]);
        if (!exited) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      }
      fs.rmSync(info.root, { recursive: true, force: true });
    },
  };
}

/** Register a pod owner and mint a Bearer via the instance's own IdP. */
export async function registerUser(base, username, password) {
  const reg = await fetch(`${base}/idp/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, confirmPassword: password }),
  });
  if (![200, 201, 302].includes(reg.status)) {
    throw new Error(`register ${username} on ${base}: ${reg.status}`);
  }
  const cred = await fetch(`${base}/idp/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (cred.status !== 200) throw new Error(`credentials ${username} on ${base}: ${cred.status}`);
  const { access_token: token } = await cred.json();
  if (!token) throw new Error(`no access_token for ${username} on ${base}`);
  return token;
}

/** POST an activity (with @context) to an inbox/outbox URL. */
export function postActivity(url, activity, { token } = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': AP_CT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ '@context': AS_CONTEXT, ...activity }),
  });
}

/** GET a JSON document (webfinger JRD, actor, collection). */
export async function getJson(url, accept = AP_CT) {
  const res = await fetch(url, { headers: { accept } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}
