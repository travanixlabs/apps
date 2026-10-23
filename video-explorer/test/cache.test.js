'use strict';

// The preview cache: the metadata index survives a BOM and garbage, a rekey
// carries the strip, poster and sidecar across, and folders a killed build
// left behind are removed at launch -- old ones only.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { state } = require('../server/config');
const cache = require('../server/cache');

test.after(() => sandbox.cleanup());

test('loadMetaIndex: a BOM is forgiven, garbage reads as empty', async () => {
  const dir = sandbox.tempDir('meta');
  state.CACHE_DIR = dir;
  state.META_FILE = path.join(dir, 'meta.json');
  fs.writeFileSync(state.META_FILE, '\uFEFF' + JSON.stringify({ '10:20': { duration: 5 } }));
  assert.strictEqual(await cache.loadMetaIndex(), 1);
  assert.deepStrictEqual(cache.cachedMeta('C:\\x\\a.mp4', { size: 10, mtimeMs: 20 }), { duration: 5 });
  fs.writeFileSync(state.META_FILE, '{not json');
  assert.strictEqual(await cache.loadMetaIndex(), 0);
  assert.strictEqual(cache.cachedMeta('C:\\x\\a.mp4', { size: 10, mtimeMs: 20 }), null);
});

test('migrateCache: the strip, its sidecar and the poster follow the video onto its new key', async () => {
  const dir = sandbox.tempDir('migrate');
  state.CACHE_DIR = dir;
  const file = 'C:\\x\\b.mp4';
  const was = { size: 100, mtimeMs: 1000 };
  const now = { size: 100, mtimeMs: 2000 };
  for (const build of [cache.spriteCachePath, cache.thumbCachePath]) {
    fs.mkdirSync(path.dirname(build(file, was)), { recursive: true });
    fs.writeFileSync(build(file, was), 'jpeg');
  }
  fs.writeFileSync(`${cache.spriteCachePath(file, was)}.json`, '{"frames":9}');
  await cache.migrateCache(file, was, now);
  assert.ok(fs.existsSync(cache.spriteCachePath(file, now)));
  assert.ok(fs.existsSync(`${cache.spriteCachePath(file, now)}.json`));
  assert.ok(fs.existsSync(cache.thumbCachePath(file, now)));
  assert.ok(!fs.existsSync(cache.spriteCachePath(file, was)));
});

test('removeStaleTemps: an old tmp_ folder goes, a fresh one and everything else stays', async () => {
  const dir = sandbox.tempDir('tmp');
  state.CACHE_DIR = dir;
  const old = path.join(dir, 'tmp_old');
  const fresh = path.join(dir, 'tmp_fresh');
  fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'f0.jpg'), 'x');
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(dir, 'tmp_file.txt'), 'not a folder');
  fs.writeFileSync(path.join(dir, 'strip.jpg'), 'keep');
  const ago = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(old, ago, ago);
  assert.strictEqual(await cache.removeStaleTemps(), 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(path.join(dir, 'tmp_file.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'strip.jpg')));
});
