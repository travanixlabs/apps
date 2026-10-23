'use strict';

// The face store without the engine: an entry written and read back through
// the snapshot pair, a snapshot whose .bin is missing or the wrong width
// rejected, a remembered ranking adopted only for the same cast, a rekey that
// carries the entry and its thumbnails, and a settled video that suggests
// only its credits.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../library');
const faces = require('../faces');
const T = faces.__forTest;

const DIM = 8;
const vec = (seed) => Float32Array.from({ length: DIM }, (unused, i) => ((seed * 31 + i * 7) % 13) / 13);
const dir = path.join(sandbox.home, '.video-explorer', 'faces');

test.before(async () => {
  await library.init(sandbox.home);
  faces.init({ cacheDir: dir, library, roots: () => [], home: () => sandbox.home });
});
test.after(() => sandbox.cleanup());

test('an entry goes to its own file, into the snapshot pair, and comes back by reference into one buffer', async () => {
  T.state.index.videos = {};
  const entry = { at: 1, faces: 2, people: [{ n: 2, vec: vec(1) }, { n: 1, vec: vec(2) }], name: 'a.mp4', gen: 2 };
  T.state.index.videos['100:1'] = entry;
  await T.writeEntry('100:1', entry);
  assert.ok(fs.existsSync(path.join(dir, 'v', '100_1.json')));
  T.state.snapshotDirty = true;
  await T.writeSnapshot();
  const snapFile = path.join(process.env.LOCALAPPDATA, 'video-explorer', 'faces-snapshot.json');
  assert.ok(fs.existsSync(snapFile));
  assert.ok(fs.existsSync(snapFile.replace(/\.json$/, '.bin')));
  const back = await T.readSnapshot();
  assert.ok(back && back['100:1']);
  assert.strictEqual(back['100:1'].people.length, 2);
  assert.ok(back['100:1'].people[0].vec instanceof Float32Array);
  assert.deepStrictEqual([...back['100:1'].people[1].vec].map((x) => Math.round(x * 1000)), [...vec(2)].map((x) => Math.round(x * 1000)));
  assert.strictEqual(back['100:1'].people[0].vec.buffer, back['100:1'].people[1].vec.buffer, 'one buffer for the lot');
});

test('a snapshot whose .bin is missing, or does not match, is not read', async () => {
  const snapFile = path.join(process.env.LOCALAPPDATA, 'video-explorer', 'faces-snapshot.json');
  const bin = snapFile.replace(/\.json$/, '.bin');
  const held = fs.readFileSync(bin);
  fs.unlinkSync(bin);
  assert.strictEqual(await T.readSnapshot(), null, 'no .bin: half a snapshot is none');
  fs.writeFileSync(bin, held.subarray(0, 4));
  const short = await T.readSnapshot();
  assert.ok(short && short['100:1']);
  assert.deepStrictEqual([...short['100:1'].people[0].vec], [], 'a row the .bin cannot hold is empty, not garbage');
  fs.writeFileSync(bin, held);
});

test('adoptScores takes a remembered ranking only for the same cast signature', async () => {
  const file = path.join(process.env.LOCALAPPDATA, 'video-explorer', 'faces-scores.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const videos = { '100:1': [{ name: 'Ann', score: 0.7, band: 'strong', person: 0 }], '999:9': [{ name: 'Gone', score: 0.9, band: 'strong', person: 0 }] };
  fs.writeFileSync(file, JSON.stringify({ version: T.state.index.version, model: T.state.index.model, sig: 'cast-A', videos }));
  assert.strictEqual(await T.adoptScores('cast-B'), false, 'a different cast');
  assert.strictEqual(await T.adoptScores('cast-A'), true);
  assert.deepStrictEqual(T.state.suggestions.get('100:1')[0].name, 'Ann');
  assert.ok(!T.state.suggestions.has('999:9'), 'a video no longer in the index is not carried');
});

test('a settled video suggests only the names credited on it', () => {
  T.state.suggestions.set('100:1', [{ name: 'Ann', score: 0.7, band: 'strong', person: 0 }, { name: 'Bea', score: 0.6, band: 'likely', person: 0 }]);
  const stat = { size: 100, mtimeMs: 1 };
  library.apply(stat, 'a.mp4', { models: ['Bea'] });
  assert.deepStrictEqual(faces.decorate(stat).suggested.map((s) => s.name), ['Ann', 'Bea']);
  library.apply(stat, 'a.mp4', { settled: true });
  assert.deepStrictEqual(faces.decorate(stat).suggested.map((s) => s.name), ['Bea'], 'settled: the credits are the whole answer');
  assert.deepStrictEqual(faces.allSuggestions().videos['100:1'].map((s) => s.name), ['Bea'], 'and the set by key agrees');
  library.apply(stat, 'a.mp4', { settled: false });
});

test('rekey carries the entry, its suggestions and its thumbnails to the new key', async () => {
  fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbs', '100_1-0.png'), 'png');
  fs.writeFileSync(path.join(dir, 'thumbs', '100_1-1.png'), 'png');
  assert.strictEqual(await faces.rekey('100:1', '100:2'), true);
  assert.ok(T.state.index.videos['100:2'] && !T.state.index.videos['100:1']);
  assert.ok(fs.existsSync(path.join(dir, 'v', '100_2.json')));
  assert.ok(fs.existsSync(path.join(dir, 'thumbs', '100_2-0.png')));
  assert.ok(fs.existsSync(path.join(dir, 'thumbs', '100_2-1.png')));
  assert.ok(T.state.suggestions.has('100:2') && !T.state.suggestions.has('100:1'));
  assert.strictEqual(await faces.rekey('100:1', '100:3'), false, 'nothing under the old key any more');
  assert.strictEqual(faces.rescoreOne({ size: 1, mtimeMs: 1 }).length, 0, 'an unknown video has no ranking');
});
