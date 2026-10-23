'use strict';

// The API, in this process: the dispatcher listening on a free port with
// every store pointed at the sandbox. Labels and performers move their
// colours, spares, race, traits and tier; the settings route takes only user
// settings of the right shape; a bad path in a bulk edit is an error entry,
// not a 500; a page fault lands in the log.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { state, PORT } = require('../server/config');
const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');
const { server, setCoreReady } = require('../server/routes');

let port = 0;
test.before(async () => {
  await library.init(sandbox.home);
  faces.init({ cacheDir: path.join(sandbox.home, '.video-explorer', 'faces'), library, roots: () => [], home: () => sandbox.home });
  dupes.init({ cacheDir: path.join(sandbox.home, '.video-explorer'), roots: [], home: sandbox.home });
  state.config.homeDir = sandbox.home;
  state.config.roots = [];
  setCoreReady(Promise.resolve());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
test.after(async () => {
  await library.flush().catch(() => {});
  // Keep-alive connections would otherwise hold close() open for ever.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  sandbox.cleanup();
});

function call(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      // The gate knows the app's own port, not the free one this test listens on.
      headers: { Host: `127.0.0.1:${PORT}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('labels: rename moves the colour and the spare; delete takes both off', async () => {
  const dir = sandbox.tempDir('labels');
  const v = sandbox.video(dir, 'a.mp4');
  state.config.roots = [dir];
  state.config.labelColours = { outdoor: '#123456' };
  state.config.spareLabels = ['Outdoor', 'Unused'];
  library.apply(v.stat, 'a.mp4', { tags: ['Outdoor'] });

  const renamed = await call('POST', '/api/labels', { action: 'rename', name: 'Outdoor', to: 'Outside' });
  assert.strictEqual(renamed.status, 200, renamed.text);
  assert.strictEqual(renamed.json.changed, 1);
  assert.deepStrictEqual(renamed.json.config.labelColours, { outside: '#123456' });
  assert.deepStrictEqual(renamed.json.config.spareLabels, ['Unused', 'Outside']);
  assert.deepStrictEqual(library.get(v.stat).tags, ['Outside']);

  const gone = await call('POST', '/api/labels', { action: 'delete', name: 'outside' });
  assert.strictEqual(gone.json.changed, 1);
  assert.deepStrictEqual(gone.json.config.labelColours, {});
  assert.deepStrictEqual(gone.json.config.spareLabels, ['Unused']);
  assert.strictEqual(library.get(v.stat), null, 'nothing left on the record');

  assert.strictEqual((await call('POST', '/api/labels', { action: 'nope', name: 'x' })).status, 400);
  assert.strictEqual((await call('POST', '/api/labels', { action: 'rename', name: 'x' })).status, 400);
});

test('models rename: credits, refusals, race, traits and favourite tier move; the target keeps its own', async () => {
  const dir = sandbox.tempDir('models');
  const a = sandbox.video(dir, 'a.mp4', { mtimeMs: 1700000000000 });
  const b = sandbox.video(dir, 'b.mp4', { mtimeMs: 1700000001000 });
  state.config.roots = [dir];
  library.apply(a.stat, 'a.mp4', { models: ['Old Name'] });
  library.apply(b.stat, 'b.mp4', { notModels: ['Old Name'], models: ['New Name'] });
  library.setPerformerRace('Old Name', 'Asian');
  library.setPerformerTraits('Old Name', { height: 'Tall', body: ['Curvy'] });
  library.setFavouriteModel('Old Name', true, 2);
  library.setPerformerRace('New Name', 'White');

  const out = await call('POST', '/api/models', { action: 'rename', name: 'Old Name', to: 'New Name' });
  assert.strictEqual(out.status, 200, out.text);
  assert.strictEqual(out.json.credited, 1);
  assert.strictEqual(out.json.refused, 1);
  assert.deepStrictEqual(library.get(a.stat).models, ['New Name']);
  assert.deepStrictEqual(library.get(b.stat).notModels, ['New Name']);
  assert.strictEqual(out.json.races['new name'], 'White', 'the target keeps its own race');
  assert.strictEqual(out.json.races['old name'], undefined);
  assert.deepStrictEqual(out.json.traits['new name'], { height: 'Tall', body: ['Curvy'] });
  assert.strictEqual(out.json.favouriteTiers['new name'], 2);
  assert.ok(!out.json.favourites.includes('Old Name'));
});

test('config POST: user settings of the right shape only; roots and unknown keys are ignored', async () => {
  const before = state.config.roots.slice();
  const out = await call('POST', '/api/config', { roots: 'C:\\', dwellMs: 'slow', cardWidth: 333, nothing: 1, homeFolders: 'x', labelColours: [] });
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.json.roots, before);
  assert.strictEqual(out.json.cardWidth, 333);
  assert.notStrictEqual(out.json.dwellMs, 'slow');
  assert.ok(Array.isArray(out.json.homeFolders));
  assert.ok(!Array.isArray(out.json.labelColours));
  assert.ok(!('nothing' in out.json));
});

test('library POST: an unauthorised path is an error entry beside the ones that worked', async () => {
  const dir = sandbox.tempDir('bulk');
  const ok = sandbox.video(dir, 'ok.mp4');
  state.config.roots = [dir];
  const out = await call('POST', '/api/library', { paths: [ok.path, 'C:\\nowhere\\x.mp4'], rating: 4 });
  assert.strictEqual(out.status, 200, out.text);
  assert.strictEqual(out.json.records[ok.path].rating, 4);
  assert.match(out.json.records['C:\\nowhere\\x.mp4'].error, /outside any opened folder/);
});

test('a page fault posted to /api/log reaches the daily file; GET on a POST route is 405', async () => {
  const out = await call('POST', '/api/log', { message: 'Something went wrong: test fault', stack: 'at nowhere' });
  assert.strictEqual(out.status, 200);
  const logs = fs.readdirSync(process.env.VIDEO_EXPLORER_LOG_DIR).map((n) => fs.readFileSync(path.join(process.env.VIDEO_EXPLORER_LOG_DIR, n), 'utf8')).join('');
  assert.match(logs, /page: Something went wrong: test fault/);
  assert.strictEqual((await call('GET', '/api/log')).status, 405);
  assert.strictEqual((await call('GET', '/api/scan?dir=x')).status, 405);
  assert.strictEqual((await call('GET', '/api/nothing')).status, 404);
});
