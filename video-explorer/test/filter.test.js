'use strict';

// The advanced filter: what matches, and that a filter survives the trip over
// the wire and the compile step unchanged in meaning.

const test = require('node:test');
const assert = require('node:assert');

const filter = require('../public/filter.js');
const facets = require('../shared/facets.js');

const {
  newAdvFilter, matchesAdvanced, compileAdvanced, packFilter, unpackFilter,
  filterActive, NOTHING,
} = filter;

const ctx = {
  favSet: new Set(['ann']),
  favTiers: new Map([['ann', 1]]),
  raceOf: new Map([['ann', 'Asian'], ['bea', 'White']]),
  traitsOf: new Map([['ann', { height: 'Tall', body: ['Curvy', 'Tattoos'] }], ['bea', { bust: 'Big' }]]),
};

const files = [
  { path: 'a', models: ['Ann'], tags: ['Outdoor', 'Solo'], rating: 8, framed: true, profiled: true },
  { path: 'b', models: ['Bea'], tags: ['Indoor'], rating: 0, cloudOnly: true },
  { path: 'c', models: ['Ann', 'Bea'], tags: [], rating: 4, printed: true },
  { path: 'd', models: [], tags: ['solo'], rating: 10,
    suggested: [{ name: 'Cat', score: 0.5 }, { name: 'Dee', score: 0.1 }] },
  { path: 'e', models: ['Cat'], tags: ['Outdoor'], rating: 2, notModels: ['Cat'],
    suggested: [{ name: 'Cat', score: 0.9 }] },
];

const hits = (adv) => files.filter((f) => matchesAdvanced(f, adv, ctx)).map((f) => f.path);

function make(edit) {
  const adv = newAdvFilter();
  edit(adv);
  return adv;
}

// A handful of filters covering every kind of facet, used by several tests.
const CASES = [
  ['empty matches everything', () => {}, ['a', 'b', 'c', 'd', 'e']],
  ['tag, case-insensitive', (a) => a.tags.set('SOLO', 'in'), ['a', 'd']],
  ['two tags, all-of', (a) => { a.tags.set('Outdoor', 'in'); a.tags.set('Solo', 'in'); }, ['a']],
  ['two tags, any-of', (a) => {
    a.tags.set('Outdoor', 'in'); a.tags.set('Indoor', 'in'); a.mode.tags = 'any';
  }, ['a', 'b', 'e']],
  ['excluded tag', (a) => a.tags.set('outdoor', 'out'), ['b', 'c', 'd']],
  ['no tags at all', (a) => a.tags.set(NOTHING, 'in'), ['c']],
  ['some tags', (a) => a.tags.set(NOTHING, 'out'), ['a', 'b', 'd', 'e']],
  ['model and tag are separate facets', (a) => { a.models.set('ann', 'in'); a.tags.set('solo', 'in'); }, ['a']],
  ['rating included', (a) => { a.ratings.set(8, 'in'); a.ratings.set(10, 'in'); }, ['a', 'd']],
  ['unrated excluded', (a) => a.ratings.set(0, 'out'), ['a', 'c', 'd', 'e']],
  ['race from the credited performer', (a) => a.race.set('White', 'in'), ['b', 'c']],
  ['trait list value', (a) => a.body.set('Tattoos', 'in'), ['a', 'c']],
  ['favourite tier', (a) => a.favourites.set('Tier 1', 'in'), ['a', 'c']],
  ['choice facet', (a) => a.storage.set('cloud', 'in'), ['b']],
  ['choice facet excluded', (a) => a.framing.set('done', 'out'), ['b', 'c', 'd', 'e']],
  // At or over FACE_FLOOR and not already answered: d has Cat at 0.5 (Dee is
  // under the floor); e turned Cat down.
  ['pending suggestions', (a) => a.suggestions.set('some', 'in'), ['d']],
];

for (const [name, edit, want] of CASES) {
  test(`matchesAdvanced: ${name}`, () => {
    assert.deepStrictEqual(hits(make(edit)), want);
  });
}

test('compileAdvanced gives the same answers as the raw filter', () => {
  for (const [name, edit] of CASES) {
    const adv = make(edit);
    const compiled = compileAdvanced(adv);
    for (const f of files) {
      assert.strictEqual(matchesAdvanced(f, compiled, ctx), matchesAdvanced(f, adv, ctx), `${name} on ${f.path}`);
    }
  }
});

test('packFilter / unpackFilter round trip keeps every answer', () => {
  for (const [name, edit] of CASES) {
    const adv = make(edit);
    // Through JSON, as it travels.
    const back = unpackFilter(JSON.parse(JSON.stringify(packFilter(adv))));
    assert.deepStrictEqual(packFilter(back), packFilter(adv), name);
    assert.deepStrictEqual(hits(back), hits(adv), name);
    assert.strictEqual(filterActive(back), filterActive(adv), name);
  }
});

test('a rating stays a number over the wire', () => {
  const back = unpackFilter(JSON.parse(JSON.stringify(packFilter(make((a) => a.ratings.set(0, 'in'))))));
  assert.deepStrictEqual([...back.ratings.keys()], [0]);
});

test('unpackFilter drops what it does not recognise', () => {
  const back = unpackFilter({
    tags: [['ok', 'in'], [null, 'in'], ['bad-mode', 'maybe'], ['short']],
    ratings: [[null, 'in'], ['', 'in'], ['3', 'in'], [Infinity, 'in']],
    race: [['Martian', 'in'], ['Asian', 'out']],
    storage: [['somewhere', 'in'], ['cloud', 'in']],
    bogus: [['x', 'in']],
    mode: { tags: 'any', models: 'sideways' },
  });
  assert.deepStrictEqual([...back.tags], [['ok', 'in']]);
  assert.deepStrictEqual([...back.ratings], [[3, 'in']]);
  assert.deepStrictEqual([...back.race], [['Asian', 'out']]);
  assert.deepStrictEqual([...back.storage], [['cloud', 'in']]);
  assert.strictEqual(back.bogus, undefined);
  assert.strictEqual(back.mode.tags, 'any');
  assert.strictEqual(back.mode.models, 'all');
  assert.ok(!filterActive(unpackFilter(null)));
});

test('the filter takes its vocabularies from shared/facets.js', () => {
  assert.strictEqual(filter.RACES, facets.RACES);
  assert.strictEqual(filter.PERSON_FACETS, facets.PERSON_FACETS);
  assert.strictEqual(filter.FACE_FLOOR, facets.FACE_FLOOR);
});

test('in a page without shared/facets.js, the fallbacks are the same values', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const page = {};
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'filter.js'), 'utf8'), page);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(page.PERSON_FACETS)), JSON.parse(JSON.stringify(facets.PERSON_FACETS)));
  assert.strictEqual(page.FACE_FLOOR, facets.FACE_FLOOR);
  assert.deepStrictEqual([...page.RACES], facets.RACES);
});

test('in a page with shared/facets.js loaded first, the filter uses it', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const page = {};
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'facets.js'), 'utf8'), page);
  const theirs = page.PERSON_FACETS;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'filter.js'), 'utf8'), page);
  assert.strictEqual(page.PERSON_FACETS, theirs);
});
