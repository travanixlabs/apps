'use strict';

// The phone's copy of shared/facets.js is the desktop's, byte for byte, behind
// a generated header. Out of date means: run node tools/sync-shared.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { FILES, sourceOf, targetOf, render } = require('../tools/sync-shared.js');
const mobile = path.join(__dirname, '..', 'mobile');
const skip = !fs.existsSync(mobile) && 'no mobile/ folder';

for (const name of FILES) {
  test(`mobile/shared/${name} matches shared/${name}`, { skip }, () => {
    assert.ok(fs.existsSync(targetOf(name)), `mobile/shared/${name} is missing: run node tools/sync-shared.js`);
    assert.strictEqual(fs.readFileSync(targetOf(name), 'utf8'), render(fs.readFileSync(sourceOf(name), 'utf8'), name),
      `mobile/shared/${name} is out of date: run node tools/sync-shared.js`);
  });
}

test('the phone reads the shared files rather than carrying its own copies', { skip }, () => {
  const app = fs.readFileSync(path.join(mobile, 'app.js'), 'utf8');
  const graph = fs.readFileSync(path.join(mobile, 'graph.js'), 'utf8');
  const html = fs.readFileSync(path.join(mobile, 'index.html'), 'utf8');
  for (const name of ['RATING_MAX', 'FACE_FLOOR', 'STAR_POINTS', 'TIERS', 'RACES', 'PERSON_FACETS']) {
    assert.ok(!new RegExp(`^const ${name} = [\\[{0-9'"]`, 'm').test(app), `mobile/app.js declares its own ${name}`);
  }
  assert.ok(!/^export function mergeLibraries/m.test(graph), 'mobile/graph.js carries its own mergeLibraries');
  for (const name of ['fmtBytes', 'fmtDuration', 'starsNumber', 'fmtTime']) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(app), `mobile/app.js declares its own ${name}`);
  }
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'core.js'), 'utf8');
  for (const name of ['fmtBytes', 'fmtDuration', 'starsNumber']) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(page), `public/js/core.js declares its own ${name}`);
  }
  for (const name of FILES) assert.ok(html.includes(`./shared/${name}`), `mobile/index.html does not load shared/${name}`);
});

test('no page script declares a top-level function or const with a shared name (it would shadow the shared one)', () => {
  // A classic script's top-level function is a global: a page function
  // named like a shared helper replaced it for the whole page, and the
  // page's suggestedNames(file) once called itself for ever that way.
  const shared = new Set();
  for (const name of ['facets.js', 'merge.js', 'format.js', 'listing.js']) {
    Object.keys(require(path.join(__dirname, '..', 'shared', name))).forEach((k) => shared.add(k));
  }
  const pages = fs.readdirSync(path.join(__dirname, '..', 'public', 'js')).map((n) => path.join('public', 'js', n));
  pages.push(path.join('public', 'filter.js'));
  for (const rel of pages) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const name of shared) {
      const declared = new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(|^(const|let|var)\\s+${name}\\b`, 'm').test(text);
      assert.ok(!declared, `${rel} declares ${name}, which shared/ already provides`);
    }
  }
});

test('the shared merge is what the label store uses', () => {
  const library = require('../library.js');
  const shared = require('../shared/merge.js');
  assert.strictEqual(library.mergeLibraries, shared.mergeLibraries);
});

test('the shared vocabularies are what the label store accepts', () => {
  const facets = require('../shared/facets.js');
  assert.deepStrictEqual(facets.PERSON_FACETS.race, facets.RACES);
  assert.deepStrictEqual(facets.PERSON_FACETS.favourites, facets.TIERS.map((t) => `Tier ${t}`));
  assert.ok(facets.TIERS.includes(facets.DEFAULT_TIER));
  assert.strictEqual(facets.STAR_POINTS.length, facets.RATING_MAX + 1);
  assert.strictEqual(facets.keyFor({ size: 12, mtimeMs: 3.5 }), '12:4');
});
