'use strict';

// The carry-over's pairing: which gone key a fresh file certainly is. Only the
// decision, which is pure -- no walk, no stores, no disk.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

// Requiring the server modules reads nothing and writes nothing, but they do
// work out where things live from the environment; point it all somewhere
// harmless anyway.
const scratch = path.join(os.tmpdir(), 've-carry-test');
process.env.LOCALAPPDATA = scratch;
process.env.VIDEO_EXPLORER_CACHE = path.join(scratch, 'cache');
process.env.VIDEO_EXPLORER_LOG_DIR = path.join(scratch, 'logs');
process.env.VIDEO_EXPLORER_CONFIG = path.join(scratch, 'config.json');
process.env.VIDEO_EXPLORER_LIBRARY = path.join(scratch, 'library.json');

const { pairCarryOver } = require('../server/fileops.js');

const video = (size, mtimeMs, name) => ({ path: path.join('C:\\v', name), size, mtimeMs, cloudOnly: false });
const keyOf = (v) => `${v.size}:${Math.round(v.mtimeMs)}`;
const present = (...videos) => new Map(videos.map((v) => [keyOf(v), v]));
const pairs = (known, there) => pairCarryOver(known, there).map(([from, v]) => [from, path.basename(v.path)]);

test('a fresh file pairs with the gone key last seen under its name', () => {
  const known = new Map([['100:1', 'Clip.mp4'], ['100:2', 'other.mp4']]);
  // Two of the same size came back: names decide, case aside.
  const there = present(video(100, 50, 'clip.MP4'), video(100, 60, 'other.mp4'));
  assert.deepStrictEqual(pairs(known, there).sort(), [['100:1', 'clip.MP4'], ['100:2', 'other.mp4']]);
});

test('with no name to go on, the only gone and the only fresh of a size pair', () => {
  // A face profile knows the key and nothing else, so no name.
  const known = new Map([['200:1', '']]);
  assert.deepStrictEqual(pairs(known, present(video(200, 9, 'renamed.mp4'))), [['200:1', 'renamed.mp4']]);
  // Named differently: still the sole candidate either way.
  const named = new Map([['200:1', 'was.mp4']]);
  assert.deepStrictEqual(pairs(named, present(video(200, 9, 'now.mp4'))), [['200:1', 'now.mp4']]);
});

test('ambiguous is left alone', () => {
  // Two gone, one fresh, no names: which is it? Neither.
  const twoGone = new Map([['300:1', ''], ['300:2', '']]);
  assert.deepStrictEqual(pairs(twoGone, present(video(300, 9, 'x.mp4'))), []);
  // One gone, two fresh, no name match.
  const oneGone = new Map([['300:1', 'old.mp4']]);
  assert.deepStrictEqual(pairs(oneGone, present(video(300, 8, 'x.mp4'), video(300, 9, 'y.mp4'))), []);
});

test('a name match is taken first, and what is left pairs only if it is one to one', () => {
  const known = new Map([['400:1', 'a.mp4'], ['400:2', '']]);
  const there = present(video(400, 8, 'a.mp4'), video(400, 9, 'b.mp4'));
  assert.deepStrictEqual(pairs(known, there).sort(), [['400:1', 'a.mp4'], ['400:2', 'b.mp4']]);
});

test('a different size is never a candidate, and a key still on disk is not gone', () => {
  const known = new Map([['500:1', 'same.mp4'], ['600:1', 'here.mp4']]);
  const there = present(video(501, 9, 'same.mp4'), video(600, 1, 'here.mp4'));
  assert.deepStrictEqual(pairs(known, there), []);
});

test('a file every store already knows is not fresh', () => {
  const known = new Map([['700:1', 'a.mp4'], ['700:2', 'b.mp4']]);
  // 700:2 is on disk and known; 700:1 is gone, but the only file of that size
  // is 700:2 itself -- nothing new to pair with.
  assert.deepStrictEqual(pairs(known, present(video(700, 2, 'a.mp4'))), []);
});
