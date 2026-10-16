'use strict';

// The phone's copy of shared/facets.js is the desktop's, byte for byte, behind
// a generated header. Out of date means: run node tools/sync-shared.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { SOURCE, TARGET, render } = require('../tools/sync-shared.js');
const mobile = path.join(__dirname, '..', 'mobile');

test('mobile/shared/facets.js matches shared/facets.js', { skip: !fs.existsSync(mobile) && 'no mobile/ folder' }, () => {
  assert.ok(fs.existsSync(TARGET), 'mobile/shared/facets.js is missing: run node tools/sync-shared.js');
  assert.strictEqual(fs.readFileSync(TARGET, 'utf8'), render(fs.readFileSync(SOURCE, 'utf8')),
    'mobile/shared/facets.js is out of date: run node tools/sync-shared.js');
});

test('the shared vocabularies are what the label store accepts', () => {
  const facets = require('../shared/facets.js');
  assert.deepStrictEqual(facets.PERSON_FACETS.race, facets.RACES);
  assert.deepStrictEqual(facets.PERSON_FACETS.favourites, facets.TIERS.map((t) => `Tier ${t}`));
  assert.ok(facets.TIERS.includes(facets.DEFAULT_TIER));
  assert.strictEqual(facets.STAR_POINTS.length, facets.RATING_MAX + 1);
  assert.strictEqual(facets.keyFor({ size: 12, mtimeMs: 3.5 }), '12:4');
});
