'use strict';

// The carry-over end to end: a video that comes back under a new modified
// time keeps its labels, face profile and fingerprint, and the move is
// written to carried-over.jsonl; a dry run changes nothing.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { state } = require('../server/config');
const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');
const tree = require('../tree');
const { carryOver } = require('../server/fileops');

const store = path.join(sandbox.home, '.video-explorer');
const F = faces.__forTest;
const D = dupes.__forTest.state;

test.before(async () => {
  await library.init(sandbox.home);
  faces.init({ cacheDir: path.join(store, 'faces'), library, roots: () => state.config.roots, home: () => sandbox.home });
  dupes.init({ cacheDir: store, roots: () => state.config.roots, home: () => sandbox.home });
  D.ready = true;
  // The face store reads its entries in the background; the carry-over
  // declines until both stores know their keys.
  while (faces.knownKeys() === null) await sandbox.sleep(20);
});
test.after(async () => { await library.flush().catch(() => {}); sandbox.cleanup(); });

test('a file back under a new modified time carries its record, profile and print; dry changes nothing', async () => {
  const lib = path.join(sandbox.home, 'Library');
  fs.mkdirSync(lib);
  const was = sandbox.video(lib, 'film.mp4', { mtimeMs: 1700000000000 });
  state.config.homeDir = sandbox.home;
  state.config.roots = [lib];
  library.apply(was.stat, 'film.mp4', { rating: 8, tags: ['Keep'] });
  F.state.index.videos[was.key] = { at: 1, faces: 1, people: [{ n: 1, vec: Float32Array.from([1, 0, 0, 0]) }], name: 'film.mp4', gen: 2 };
  await F.writeEntry(was.key, F.state.index.videos[was.key]);
  D.light.set(was.key, { gaps: [1], secs: 9, cuts: 1, name: 'film.mp4' });
  fs.mkdirSync(path.join(store, 'dupes', 'v'), { recursive: true });
  fs.writeFileSync(path.join(store, 'dupes', 'v', `${was.key.replace(':', '_')}.json`), '{}');

  // The same bytes, a new modified time: to every store a new video.
  const later = new Date(1700000099000);
  fs.utimesSync(was.path, later, later);
  const now = fs.statSync(was.path);
  const to = `${now.size}:${Math.round(now.mtimeMs)}`;
  assert.notStrictEqual(to, was.key);
  tree.invalidate();

  const dry = await carryOver({ dry: true });
  assert.deepStrictEqual(dry.pairs, [{ from: was.key, file: was.path }]);
  assert.ok(library.all()[was.key] && !library.all()[to], 'a dry run moved nothing');

  tree.invalidate();
  const moved = await carryOver();
  assert.strictEqual(moved.moved, 1);
  assert.ok(!library.all()[was.key]);
  assert.strictEqual(library.all()[to].rating, 8);
  assert.deepStrictEqual(library.all()[to].aliases, [was.key]);
  assert.ok(F.state.index.videos[to] && !F.state.index.videos[was.key], 'the profile moved');
  assert.ok(fs.existsSync(path.join(store, 'faces', 'v', `${to.replace(':', '_')}.json`)));
  assert.ok(D.light.has(to) && !D.light.has(was.key), 'the print moved');
  const lines = fs.readFileSync(path.join(store, 'carried-over.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual([lines[0].from, lines[0].to, lines[0].labels, lines[0].profile, lines[0].fingerprint], [was.key, to, true, true, true]);

  tree.invalidate();
  const nothing = await carryOver();
  assert.strictEqual(nothing.moved, 0, 'nothing left to carry');
});
