'use strict';

// Listings: the slim entry, the folder tally's prefix rule, a walk served
// from memory until forgotten, and a scan's shape with a labelled file.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { state } = require('../server/config');
const library = require('../library');
const walk = require('../server/walk');
const { LISTING_DEFAULTS } = require('../shared/listing');

test.after(() => sandbox.cleanup());

test('slim drops every default and keeps the rest; null is a value', () => {
  const out = walk.slim({ name: 'a', rating: 0, tags: [], models: ['Ann'], printed: null, framed: false, studio: '', copies: 2, dupeKinds: null });
  assert.deepStrictEqual(out, { name: 'a', models: ['Ann'], printed: null, copies: 2 });
  for (const key of Object.keys(LISTING_DEFAULTS)) {
    const value = LISTING_DEFAULTS[key];
    assert.ok(!(key in walk.slim({ [key]: Array.isArray(value) ? [] : value })), `${key} default dropped`);
  }
});

test('countUnderFolders: C:\\a\\b holds nothing from C:\\a\\bc', async () => {
  const filter = require('../public/filter');
  const adv = filter.newAdvFilter();
  adv.ratings.set(0, 'in');
  const videos = [
    { path: 'C:\\a\\b\\one.mp4', size: 1, mtimeMs: 1, cloudOnly: false },
    { path: 'C:\\a\\bc\\two.mp4', size: 2, mtimeMs: 1, cloudOnly: false },
    { path: 'C:\\a\\b\\deep\\three.mp4', size: 3, mtimeMs: 1, cloudOnly: false },
  ];
  const subs = [
    { name: 'b', path: 'C:\\a\\b', prefix: 'c:\\a\\b\\' },
    { name: 'bc', path: 'C:\\a\\bc', prefix: 'c:\\a\\bc\\' },
  ];
  await library.init(sandbox.home);
  const counts = walk.countUnderFolders('C:\\a', videos, subs, adv, null);
  assert.deepStrictEqual(counts, { 'C:\\a\\b': 2, 'C:\\a\\bc': 1 });
});

test('a scan lists the labelled file slim, tallies subfolders by their own videos, and serves the walk from memory until forgotten', async () => {
  await library.init(sandbox.home);
  const root = sandbox.tempDir('scan');
  const sub = path.join(root, 'Sub');
  const sibling = path.join(root, 'Sub2');
  fs.mkdirSync(sub); fs.mkdirSync(sibling);
  const top = sandbox.video(root, 'top.mp4', { mtimeMs: 1700000000000 });
  sandbox.video(sub, 'in-sub.mp4', { mtimeMs: 1700000001000 });
  sandbox.video(sibling, 'in-sub2.mp4', { mtimeMs: 1700000002000 });
  sandbox.video(sibling, 'also.mp4', { mtimeMs: 1700000003000 });
  state.config.roots = [root];
  state.config.homeDir = sandbox.home;
  state.CACHE_DIR = sandbox.tempDir('cache');
  state.META_FILE = path.join(state.CACHE_DIR, 'meta.json');
  library.apply(top.stat, 'top.mp4', { tags: ['Solo'], rating: 7 });

  const first = await walk.scanDirectory(root, false, true, true);
  assert.strictEqual(first.files.length, 1, 'one video at this level');
  const entry = first.files[0];
  assert.deepStrictEqual(entry.tags, ['Solo']);
  assert.strictEqual(entry.rating, 7);
  assert.ok(!('models' in entry), 'the empty list is left out');
  assert.ok(!('suggested' in entry), 'suggestions travel by key, not in the listing');
  assert.strictEqual(entry.framed, undefined, 'not framed: the default is left out');
  const byName = Object.fromEntries(first.folders.map((f) => [f.name, f.videoCount]));
  assert.deepStrictEqual(byName, { Sub: 1, Sub2: 2 }, 'Sub does not count Sub2');
  assert.strictEqual(first.totalBelow, 4);
  assert.strictEqual(first.walkAge, 0);

  const again = await walk.scanDirectory(root, true, true, false);
  assert.ok(again.walkAge >= 0 && again.files.length === 4, 'served from the held walk, recursive');

  sandbox.video(root, 'new.mp4', { mtimeMs: 1700000004000 });
  const held = await walk.scanDirectory(root, true, true, false);
  assert.strictEqual(held.files.length, 4, 'the held walk does not see the new file yet');
  walk.forgetWalks();
  const fresh = await walk.scanDirectory(root, true, true, false);
  assert.strictEqual(fresh.files.length, 5, 'forgotten, so walked again');
});
