// Pay demo plugin: 402 shape parity on plugin-owned routes.

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJss } from '../helpers.js';

const __dirname = path.dirname(fileURLToPath(new URL(import.meta.url)));

describe('pay plugin (wall-report demo)', () => {
  let jss;
  after(async () => { if (jss) await jss.close(); });

  it('unpaid request gets core-shaped 402; proof unlocks the content', async () => {
    jss = await startJss({
      plugins: [{
        module: path.join(__dirname, 'plugin.js'),
        prefix: '/paid',
        config: { cost: 5, address: 'addr-test', content: { '/article': 'the goods' } },
      }],
    });

    let res = await fetch(`${jss.base}/paid/article`);
    assert.strictEqual(res.status, 402);
    const body = await res.json();
    assert.strictEqual(body.type, 'PaymentRequired'); // core's shape
    assert.strictEqual(body.cost, 5);

    res = await fetch(`${jss.base}/paid/article`, {
      headers: { 'x-payment-proof': 'demo-proof-of-payment' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).content, 'the goods');
  });
});
