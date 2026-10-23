'use strict';

// The HTTP plumbing: which requests are another site's, byte ranges on the
// video stream, and the static server's path check.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { PORT } = require('../server/config');
const { foreignRequest, streamVideo, serveStatic } = require('../server/http');

test.after(() => sandbox.cleanup());

test('foreignRequest: own host and same-origin pass; another host, site or origin is refused', () => {
  const own = `127.0.0.1:${PORT}`;
  const req = (headers) => ({ headers });
  assert.strictEqual(foreignRequest(req({})), '', 'no headers at all: the native host, a tool');
  assert.strictEqual(foreignRequest(req({ host: own })), '');
  assert.strictEqual(foreignRequest(req({ host: `localhost:${PORT}`, 'sec-fetch-site': 'same-origin' })), '');
  assert.strictEqual(foreignRequest(req({ host: own, 'sec-fetch-site': 'none' })), '', 'typed into the bar');
  assert.match(foreignRequest(req({ host: 'evil.example' })), /host/);
  assert.match(foreignRequest(req({ host: own, 'sec-fetch-site': 'cross-site' })), /cross-site/);
  assert.match(foreignRequest(req({ host: own, origin: 'https://evil.example' })), /origin/);
  assert.match(foreignRequest(req({ host: own, origin: 'null' })), /origin/, 'an opaque origin is refused');
  assert.strictEqual(foreignRequest(req({ host: own, origin: `http://${own}` })), '');
});

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const get = (route, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('streamVideo: whole file, a range, a suffix range, and a range past the end', async () => {
  const dir = sandbox.tempDir('stream');
  const file = path.join(dir, 'clip.mp4');
  const bytes = Buffer.from(Array.from({ length: 1000 }, (unused, i) => i % 256));
  fs.writeFileSync(file, bytes);
  const { get, close } = await serve((req, res) => { streamVideo(req, res, file).catch(() => res.end()); });
  try {
    const whole = await get('/');
    assert.strictEqual(whole.status, 200);
    assert.strictEqual(whole.body.length, 1000);
    assert.strictEqual(whole.headers['accept-ranges'], 'bytes');

    const first = await get('/', { range: 'bytes=0-9' });
    assert.strictEqual(first.status, 206);
    assert.strictEqual(first.headers['content-range'], 'bytes 0-9/1000');
    assert.deepStrictEqual([...first.body], [...bytes.subarray(0, 10)]);

    const tail = await get('/', { range: 'bytes=990-' });
    assert.strictEqual(tail.status, 206);
    assert.strictEqual(tail.headers['content-range'], 'bytes 990-999/1000');

    const suffix = await get('/', { range: 'bytes=-5' });
    assert.strictEqual(suffix.status, 206, 'a suffix range is the LAST bytes');
    assert.strictEqual(suffix.headers['content-range'], 'bytes 995-999/1000');
    assert.deepStrictEqual([...suffix.body], [...bytes.subarray(995)]);

    const past = await get('/', { range: 'bytes=999999-' });
    assert.strictEqual(past.status, 416);
    assert.strictEqual(past.headers['content-range'], 'bytes */1000');

    const over = await get('/', { range: 'bytes=900-5000' });
    assert.strictEqual(over.status, 206, 'an end past the file is clamped');
    assert.strictEqual(over.headers['content-range'], 'bytes 900-999/1000');
  } finally {
    await close();
  }
});

test('serveStatic: a path that escapes the folder, or a sibling with the same prefix, is refused', async () => {
  const base = sandbox.tempDir('static');
  fs.writeFileSync(path.join(base, 'ok.txt'), 'fine');
  fs.writeFileSync(path.join(path.dirname(base), path.basename(base) + '-2.txt'), 'sibling');
  const { get, close } = await serve((req, res) => {
    const rel = decodeURIComponent(req.url.replace(/^\/+/, ''));
    serveStatic(res, rel, base).catch(() => res.end());
  });
  try {
    assert.strictEqual((await get('/ok.txt')).status, 200);
    assert.strictEqual((await get('/..%2F' + path.basename(base) + '-2.txt')).status, 403);
    assert.strictEqual((await get('/..%2F..%2Fserver.js')).status, 403);
    assert.strictEqual((await get('/missing.txt')).status, 404);
  } finally {
    await close();
  }
});
