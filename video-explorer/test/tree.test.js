'use strict';

// The shared library walk: what it lists, in what order, and that it walks
// the disk once for everybody until told otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tree = require('../tree.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-tree-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (rel) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // Big enough to be allocated on disk: a file resident in the MFT has no
  // blocks, which is exactly what a OneDrive placeholder looks like.
  fs.writeFileSync(full, Buffer.alloc(8192, 1));
};
put('a/one.mp4');
put('a/sub/two.MOV');
put('a/sub/notes.txt');
put('b/three.mkv');
put('node_modules/skipped.mp4');
put('.hidden/skipped.mp4');

const names = (list) => list.map((v) => path.relative(root, v.path).replace(/\\/g, '/'));

test('lists every video under the roots, in directory order, skipping what every walk skips', async () => {
  const list = await tree.videos({ home: root, roots: [] }, { maxAgeMs: 0 });
  assert.deepStrictEqual(names(list), ['a/one.mp4', 'a/sub/two.MOV', 'b/three.mkv']);
  assert.ok(list.every((v) => v.stat && typeof v.stat.size === 'number' && v.cloudOnly === false));
});

test('one walk serves everybody until it is too old or invalidated', async () => {
  const before = tree.status().walks;
  const first = await tree.videos({ home: root, roots: [root] });
  // As the server asks: the home folder among the roots, plus one inside it.
  const again = await tree.videos({ home: root, roots: [root, path.join(root, 'a')] });
  assert.strictEqual(again, first, 'the held list, not a new one');
  assert.strictEqual(tree.status().walks, before + 1);
  // Two callers at once share the walk in flight.
  tree.invalidate();
  const [x, y] = await Promise.all([tree.videos({ home: root }), tree.videos({ home: root })]);
  assert.strictEqual(x, y);
  assert.strictEqual(tree.status().walks, before + 2);
  // A file added by somebody else is seen once the walk is old enough.
  put('b/four.mp4');
  assert.strictEqual((await tree.videos({ home: root })).length, 3, 'still the held answer');
  assert.strictEqual((await tree.videos({ home: root }, { maxAgeMs: 0 })).length, 4, 'walked again on demand');
});

test('roots above the home folder stand at the home folder; nested roots collapse', () => {
  const home = path.join(root, 'a');
  assert.deepStrictEqual(tree.boundRoots({ home, roots: [root] }), [home]);
  assert.deepStrictEqual(tree.boundRoots({ home, roots: [path.join(root, 'b'), path.join(root, 'b', 'c')] }), [path.join(root, 'b')]);
  assert.deepStrictEqual(tree.boundRoots({ home, roots: [] }), [home]);
});
