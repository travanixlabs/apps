'use strict';

// The label store: what an edit does to a record, and the guards around the
// file -- the rekey history, the big-drop snapshot, backup pruning, and the
// stale temp files a dead write leaves behind.
//
// library.js holds its state in the module, so each test starts it afresh on a
// new temporary file with init(), and flushes before it ends. The test runner
// gives every file its own process, so nothing here leaks into another file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../library.js');

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-lib-test-'));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** A library at a new temporary path, optionally with a file already there. */
async function fresh(contents) {
  const dir = tempDir();
  const file = path.join(dir, 'library.json');
  if (contents) fs.writeFileSync(file, JSON.stringify(contents));
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  const out = await library.init();
  assert.strictEqual(out.file, file);
  return { dir, file };
}

const stat = (size, mtimeMs = 1000) => ({ size, mtimeMs });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('normaliseTags: case-insensitive dedupe, first casing kept, sorted, blanks dropped', () => {
  assert.deepStrictEqual(library.normaliseTags(['solo', 'Outdoor', 'SOLO', '  two   words ', '', '  ']),
    ['Outdoor', 'solo', 'two words']);
  assert.deepStrictEqual(library.normaliseTags(null), []);
});

test('apply: tags are deduped without regard to case', async () => {
  const { file } = await fresh();
  const out = library.apply(stat(1), 'a.mp4', { tags: ['Foo', 'foo', ' Bar ', 'BAR'] });
  assert.deepStrictEqual(out.tags, ['Bar', 'Foo']);
  await library.flush();
  assert.deepStrictEqual(onDisk(file).records['1:1000'].tags, ['Bar', 'Foo']);
});

test('apply: addTags and removeTags merge with what is there', async () => {
  await fresh();
  library.apply(stat(2), 'b.mp4', { tags: ['A', 'B'] });
  let out = library.apply(stat(2), 'b.mp4', { addTags: ['c', 'a'] });
  assert.deepStrictEqual(out.tags, ['A', 'B', 'c']);
  out = library.apply(stat(2), 'b.mp4', { removeTags: ['b', 'nothing'] });
  assert.deepStrictEqual(out.tags, ['A', 'c']);
  // The same for models: one implementation.
  out = library.apply(stat(2), 'b.mp4', { addModels: ['Ann'], removeTags: ['a'] });
  assert.deepStrictEqual(out.models, ['Ann']);
  assert.deepStrictEqual(out.tags, ['c']);
  await library.flush();
});

test('apply: a record with nothing left in it is deleted', async () => {
  const { file } = await fresh();
  library.apply(stat(3), 'c.mp4', { rating: 6, tags: ['x'] });
  assert.ok(library.get(stat(3)));
  library.apply(stat(3), 'c.mp4', { rating: 0, tags: [] });
  assert.strictEqual(library.get(stat(3)), null);
  await library.flush();
  assert.ok(!('3:1000' in onDisk(file).records));
  // A rejection is content: "not her" keeps the record.
  library.apply(stat(4), 'd.mp4', { notModels: ['Ann'] });
  assert.ok(library.get(stat(4)));
  await library.flush();
});

test('apply: saving only the resume point does not move updated', async () => {
  await fresh();
  const first = library.apply(stat(5), 'e.mp4', { rating: 3 });
  await sleep(15);
  const resumed = library.apply(stat(5), 'e.mp4', { resume: 42.4 });
  assert.strictEqual(resumed.updated, first.updated);
  assert.strictEqual(resumed.resume, 42);
  await sleep(15);
  const edited = library.apply(stat(5), 'e.mp4', { rating: 4 });
  assert.ok(edited.updated > first.updated);
  await library.flush();
});

test('apply: ratings are clamped to the shared scale', async () => {
  await fresh();
  const { RATING_MAX } = require('../shared/facets.js');
  assert.strictEqual(library.apply(stat(6), 'f.mp4', { rating: 99 }).rating, RATING_MAX);
  assert.strictEqual(library.apply(stat(6), 'f.mp4', { rating: -3 }).rating, 0);
  await library.flush();
});

test('rekey: the record moves, and the old key is kept as an alias', async () => {
  const { file } = await fresh();
  library.apply(stat(7, 100), 'g.mp4', { rating: 5 });
  library.rekey(stat(7, 100), stat(7, 200), 'g.mp4');
  assert.strictEqual(library.get(stat(7, 100)), null);
  const moved = library.all()['7:200'];
  assert.strictEqual(moved.rating, 5);
  assert.deepStrictEqual(moved.aliases, ['7:100']);
  // Again, and back: newest first, no duplicates, never the key it is under.
  library.rekey(stat(7, 200), stat(7, 300), 'g.mp4');
  library.rekey(stat(7, 300), stat(7, 100), 'g.mp4');
  assert.deepStrictEqual(library.all()['7:100'].aliases, ['7:300', '7:200']);
  // decorate() is unaffected: no aliases in what the listing gets.
  assert.ok(!('aliases' in library.decorate(stat(7, 100))));
  await library.flush();
  assert.deepStrictEqual(onDisk(file).records['7:100'].aliases, ['7:300', '7:200']);
});

test('rekey: the alias list is capped at twenty', async () => {
  await fresh();
  library.apply(stat(8, 0), 'h.mp4', { rating: 2 });
  for (let i = 0; i < 30; i += 1) library.rekey(stat(8, i), stat(8, i + 1), 'h.mp4');
  const record = library.all()['8:30'];
  assert.strictEqual(record.aliases.length, 20);
  assert.strictEqual(record.aliases[0], '8:29');
  await library.flush();
});

function bulk(n, offset = 0) {
  const records = {};
  for (let i = 0; i < n; i += 1) records[`${offset + i}:1`] = { rating: 2, tags: [], models: [], name: `v${i}`, updated: 1 };
  return records;
}
const autoBackups = (dir) => {
  try { return fs.readdirSync(path.join(dir, 'backups')).filter((n) => /^library-\d{4}-\d{2}-\d{2}T/.test(n)); } catch { return []; }
};

test('a write that drops 200 records is snapshotted even when that is under a tenth', async () => {
  const { dir, file } = await fresh();
  // 2,500 records written, so 200 lost is 8% -- under the share, at the floor.
  Object.assign(library.all(), bulk(2500));
  library.apply(stat(1, 1), 'x.mp4', { rating: 1 });
  await library.flush();
  assert.strictEqual(autoBackups(dir).length, 0);
  for (let i = 0; i < 199; i += 1) delete library.all()[`${i}:1`];
  library.apply(stat(1, 1), 'x.mp4', { rating: 2 });
  await library.flush();
  assert.strictEqual(autoBackups(dir).length, 0, '199 is not enough');
  for (let i = 199; i < 399; i += 1) delete library.all()[`${i}:1`];
  library.apply(stat(1, 1), 'x.mp4', { rating: 3 });
  await library.flush();
  const kept = autoBackups(dir);
  assert.strictEqual(kept.length, 1, '200 gone at once is snapshotted');
  // The snapshot is the file as it was before the drop.
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'backups', kept[0]), 'utf8'));
  assert.strictEqual(Object.keys(before.records).length, 2500 - 199 + 1);
  assert.strictEqual(Object.keys(onDisk(file).records).length, 2500 - 399 + 1);
});

test('a write that drops a tenth is snapshotted however few that is', async () => {
  const { dir } = await fresh();
  Object.assign(library.all(), bulk(20));
  library.apply(stat(1, 1), 'x.mp4', { rating: 1 });
  await library.flush();
  for (let i = 0; i < 3; i += 1) delete library.all()[`${i}:1`];
  library.apply(stat(1, 1), 'x.mp4', { rating: 2 });
  await library.flush();
  assert.strictEqual(autoBackups(dir).length, 1);
});

test('backup pruning keeps fourteen dated snapshots and never touches a manual copy', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'library.json');
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  for (let d = 1; d <= 16; d += 1) {
    const day = String(d).padStart(2, '0');
    fs.writeFileSync(path.join(backups, `library-2020-01-${day}T00-00-00-000Z.json`), '{}');
  }
  fs.writeFileSync(path.join(backups, 'library-before-the-import.json'), '{"mine":true}');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ratingScale: 10, records: bulk(5) }));
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  // init takes today's backup, which prunes.
  await library.init();
  const names = fs.readdirSync(backups);
  assert.ok(names.includes('library-before-the-import.json'), 'manual copy kept');
  assert.strictEqual(autoBackups(dir).length, 14);
  assert.ok(!names.includes('library-2020-01-01T00-00-00-000Z.json'), 'oldest pruned');
  await library.flush();
});

test('a stale temp file from a dead write is reported and left alone', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ratingScale: 10, records: bulk(2) }));
  const stale = `${file}.4242-1.writing`;
  fs.writeFileSync(stale, '{"records":{"torn');
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  const said = [];
  const was = console.log;
  console.log = (...args) => { said.push(args.join(' ')); };
  try { await library.init(); } finally { console.log = was; }
  assert.ok(said.some((line) => line.includes(path.basename(stale))), said.join('\n'));
  assert.ok(fs.existsSync(stale), 'not deleted');
  assert.strictEqual(Object.keys(library.all()).length, 2, 'not adopted');
  await library.flush();
});
