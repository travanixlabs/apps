'use strict';

// The modules under test now log to the daily file; here that goes to a temp
// folder rather than into the real log on this machine.
process.env.VIDEO_EXPLORER_LOG_DIR = process.env.VIDEO_EXPLORER_LOG_DIR
  || require('node:path').join(require('node:os').tmpdir(), 've-test-logs');

// Merge-on-write: another writer's edits -- the phone, a second PC, OneDrive
// restoring a version -- survive ours, by the three-way rules in mergeLibraries.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../library.js');
const { mergeLibraries } = library;

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const rec = (rating, updated, extra = {}) => ({ rating, tags: [], models: [], name: 'x', updated, ...extra });

test('mergeLibraries: a change on one side only is taken from that side', () => {
  const base = { records: { a: rec(1, 1), b: rec(1, 1) } };
  const ours = { records: { a: rec(5, 2), b: rec(1, 1) } };
  const theirs = { records: { a: rec(1, 1), b: rec(7, 3) } };
  const out = mergeLibraries(base, ours, theirs);
  assert.strictEqual(out.records.a.rating, 5);
  assert.strictEqual(out.records.b.rating, 7);
});

test('mergeLibraries: changed on both sides, the later updated wins, ours on a tie', () => {
  const base = { records: { a: rec(1, 1), b: rec(1, 1) } };
  const ours = { records: { a: rec(5, 9), b: rec(5, 4) } };
  const theirs = { records: { a: rec(7, 3), b: rec(7, 4) } };
  const out = mergeLibraries(base, ours, theirs);
  assert.strictEqual(out.records.a.rating, 5, 'ours newer');
  assert.strictEqual(out.records.b.rating, 5, 'tie goes to ours');
  const flipped = mergeLibraries(base, { records: { a: rec(5, 2) } }, { records: { a: rec(7, 8) } });
  assert.strictEqual(flipped.records.a.rating, 7, 'theirs newer');
});

test('mergeLibraries: a deletion on one side stands; an edit beats a deletion', () => {
  const base = { records: { gone: rec(3, 1), edited: rec(3, 1) } };
  const ours = { records: { edited: rec(3, 1) } };   // we deleted "gone"
  const theirs = { records: { gone: rec(3, 1) } };   // they deleted "edited"
  const out = mergeLibraries(base, ours, theirs);
  assert.deepStrictEqual(Object.keys(out.records), [], 'each side deleted one, unchallenged');

  const editVsDelete = mergeLibraries(
    { records: { a: rec(3, 1) } },
    { records: {} },                       // we deleted it
    { records: { a: rec(9, 5) } },         // they edited it
  );
  assert.strictEqual(editVsDelete.records.a.rating, 9);
  const deleteVsEdit = mergeLibraries(
    { records: { a: rec(3, 1) } },
    { records: { a: rec(9, 5) } },
    { records: {} },
  );
  assert.strictEqual(deleteVsEdit.records.a.rating, 9);
});

test('mergeLibraries: favourites merge by name; races, traits and tiers per entry', () => {
  const base = { records: {}, favourites: ['Ann', 'Bea'], races: { ann: 'Asian' }, favouriteTiers: { ann: 3 } };
  const ours = { records: {}, favourites: ['Ann', 'Bea', 'Cat'], races: { ann: 'Asian', cat: 'White' }, favouriteTiers: { ann: 1 } };
  const theirs = { records: {}, favourites: ['ann'], races: { ann: 'Other' }, favouriteTiers: { ann: 3 }, traits: { dee: { height: 'Tall' } } };
  const out = mergeLibraries(base, ours, theirs);
  assert.deepStrictEqual(out.favourites, ['Ann', 'Cat'], 'they dropped Bea, we added Cat');
  assert.deepStrictEqual(out.races, { ann: 'Other', cat: 'White' });
  assert.deepStrictEqual(out.favouriteTiers, { ann: 1 });
  assert.deepStrictEqual(out.traits, { dee: { height: 'Tall' } });
});

test('a write after another writer changed the file keeps both sides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-merge-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'library.json');
  const start = {
    version: 1, ratingScale: 10, favourites: ['Ann'], favouriteTiers: { ann: 2 },
    races: { ann: 'Asian' }, traits: {},
    records: { a: rec(2, 1), b: rec(4, 1), c: rec(6, 1), gone: rec(8, 1) },
  };
  fs.writeFileSync(file, JSON.stringify(start));
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  await library.init();

  // Ours, in memory.
  const recs = library.all();
  recs.a.rating = 10; recs.a.updated = 5;
  library.setPerformerRace('Bea', 'White');

  // Theirs, written behind our back.
  await sleep(30);
  const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
  theirs.records.b.rating = 1; theirs.records.b.updated = 9;
  delete theirs.records.gone;
  theirs.favourites.push('Cat');
  theirs.records.c.rating = 3; theirs.records.c.updated = 7;
  theirs.records.added = rec(5, 9);
  fs.writeFileSync(file, JSON.stringify(theirs));
  recs.c.rating = 9; recs.c.updated = 6;   // both changed c; ours is older

  library.setFavouriteModel('Ann', true, 1);
  await library.flush();
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(out.records.a.rating, 10, 'our edit kept');
  assert.strictEqual(out.records.b.rating, 1, 'their edit kept');
  assert.strictEqual(out.records.added.rating, 5, 'their new record kept');
  assert.ok(!('gone' in out.records), 'their delete kept');
  assert.strictEqual(out.records.c.rating, 3, 'both changed: newer wins');
  assert.deepStrictEqual(out.favourites.slice().sort(), ['Ann', 'Cat'], 'favourites merged');
  assert.strictEqual(out.favouriteTiers.ann, 1, 'our tier');
  assert.strictEqual(out.races.bea, 'White', 'our race');
  assert.strictEqual(out.races.ann, 'Asian', 'existing race');

  // Picked up while idle: another write lands with nothing pending here.
  const again = JSON.parse(fs.readFileSync(file, 'utf8'));
  again.records.a.rating = 7; again.records.a.updated = 99;
  await sleep(30);
  fs.writeFileSync(file, JSON.stringify(again));
  assert.ok(await library.refreshFromDisk(), 'refresh noticed');
  assert.strictEqual(library.all().a.rating, 7, 'adopted in memory');

  // Back-to-back saves stay serial and leave no temporary files behind.
  for (let i = 0; i < 5; i += 1) {
    library.setPerformerRace('Dee', i % 2 ? 'Asian' : 'Black');
    await library.flush();
  }
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.writing')), []);
});
