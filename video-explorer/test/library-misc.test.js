'use strict';

// The label store's smaller promises: a tag renamed everywhere (merging on a
// clash, case aside), a tag taken off everything, traits held to the shared
// lists, a favourite's default tier, an unreadable file leaving the store
// read-only until it reads again, and the five-to-ten star migration done
// once with a snapshot first.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const library = require('../library');

const stat = (size, mtimeMs = 1000) => ({ size, mtimeMs });

async function fresh(contents) {
  const dir = sandbox.tempDir('lib');
  const file = path.join(dir, 'library.json');
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  const out = await library.init('');
  return { dir, file, out };
}

test.after(async () => { await library.flush().catch(() => {}); sandbox.cleanup(); });

test('renameTag: everywhere, case aside, merging onto an existing tag; updated moves', async () => {
  await fresh();
  library.apply(stat(1), 'a.mp4', { tags: ['Beach', 'Solo'] });
  library.apply(stat(2), 'b.mp4', { tags: ['beach'] });
  library.apply(stat(3), 'c.mp4', { tags: ['Night'] });
  const before = library.get(stat(3)).updated;
  const { changed } = library.renameTag('BEACH', 'Solo');
  assert.strictEqual(changed, 2);
  assert.deepStrictEqual(library.get(stat(1)).tags, ['Solo'], 'merged, not doubled');
  assert.deepStrictEqual(library.get(stat(2)).tags, ['Solo']);
  assert.strictEqual(library.get(stat(3)).updated, before, 'untouched records keep their stamp');
  assert.deepStrictEqual(library.renameTag('', 'x'), { changed: 0 });
  assert.strictEqual(library.removeTagEverywhere('solo').changed, 2);
  assert.strictEqual(library.get(stat(1)), null, 'nothing left on it');
});

test('setPerformerTraits holds to the shared lists; favouriteTiers defaults a favourite without one', async () => {
  await fresh();
  const traits = library.setPerformerTraits('Ann', { height: 'Tall', bust: 'Enormous', body: ['Curvy', 'Made up', 'Tattoos'] });
  assert.deepStrictEqual(traits.ann, { height: 'Tall', body: ['Tattoos', 'Curvy'].sort((a, b) => a.localeCompare(b)) .length === 2 ? traits.ann.body : null });
  assert.strictEqual(traits.ann.bust, undefined, 'a value off the list is not stored');
  assert.deepStrictEqual([...traits.ann.body].sort(), ['Curvy', 'Tattoos']);
  assert.deepStrictEqual(library.setPerformerTraits('Ann', { height: '', body: [] }), {}, 'cleared entirely');
  library.setFavouriteModel('Bea', true);
  library.setFavouriteModel('Cat', true, 1);
  assert.deepStrictEqual(library.favouriteTiers(), { bea: 3, cat: 1 });
  library.setFavouriteModel('Bea', false);
  assert.deepStrictEqual(library.favouriteTiers(), { cat: 1 });
});

test('an unreadable file leaves the store read-only (apply refuses with 503) until it reads again', async () => {
  const { file, out } = await fresh('{"records": {');
  assert.match(out.readOnly, /not valid JSON/);
  assert.throws(() => library.apply(stat(1), 'a.mp4', { rating: 3 }), (err) => err.statusCode === 503);
  assert.strictEqual((await library.flush()).readOnly, out.readOnly, 'nothing written over the bad file');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"records": {');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ratingScale: 10, records: { '5:1000': { rating: 6, tags: [], models: [], name: 'x.mp4', updated: 1 } } }));
  assert.strictEqual(await library.refreshFromDisk(), true, 'read again');
  assert.strictEqual(library.get(stat(5)).rating, 6);
  library.apply(stat(1), 'a.mp4', { rating: 3 });
  await library.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).records['1:1000'].rating, 3, 'editing works from here on');
});

test('a file on the five-star scale is doubled once, after a snapshot, and says so', async () => {
  const { dir, file } = await fresh({ version: 1, records: { '1:1000': { rating: 4, tags: [], models: [], name: 'a.mp4', updated: 1 }, '2:1000': { rating: 0, tags: ['t'], models: [], name: 'b.mp4', updated: 1 } } });
  await library.flush();
  const on = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(on.ratingScale, 10);
  assert.strictEqual(on.records['1:1000'].rating, 8);
  assert.strictEqual(on.records['2:1000'].rating, 0);
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter((n) => /^library-\d{4}/.test(n));
  assert.ok(backups.length >= 1, 'a snapshot of the file as it was');
  // Read again: nothing left to double.
  await library.init('');
  await library.flush();
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).records['1:1000'].rating, 8);
});
