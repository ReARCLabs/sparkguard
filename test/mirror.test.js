'use strict';
// Mirror to Bilinc against a local stub server (no real network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkguard-mirror-'));
process.env.SPARKGUARD_CONFIG_DIR = path.join(tmp, 'config');
process.env.SPARKGUARD_DATA_DIR = path.join(tmp, 'data');

test('outbox flushes rule commits with idempotency keys; 5xx stays queued', async () => {
  const seen = [];
  let fail = true;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, idem: req.headers['idempotency-key'], body: JSON.parse(body) });
      if (fail) { fail = false; res.writeHead(503); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.BILINC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(process.env.SPARKGUARD_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPARKGUARD_CONFIG_DIR, 'bilinc.key'), 'test-key\n');

  const mirror = require('../lib/mirror');
  const store = require('../lib/store');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const { rule } = store.add({ text: 'Never touch prisma/migrations.', paths: ['prisma/migrations'], project: repo });
  assert.ok(mirror.enqueue(mirror.ruleItem(rule)));

  const first = await mirror.flush();
  assert.deepStrictEqual(first, { sent: 0, left: 1 }); // 503 -> kept
  const second = await mirror.flush();
  assert.deepStrictEqual(second, { sent: 1, left: 0 });

  const ok = seen[1];
  assert.strictEqual(ok.url, '/api/cloud/memory/commit');
  assert.strictEqual(ok.auth, 'Bearer test-key');
  assert.match(ok.idem, /^sparkguard-rule-/);
  assert.strictEqual(ok.body.value.text, 'Never touch prisma/migrations.');
  assert.strictEqual(ok.body.source, 'sparkguard');
  assert.strictEqual(seen[0].idem, seen[1].idem); // retry reuses the same idempotency key
  server.close();
});
