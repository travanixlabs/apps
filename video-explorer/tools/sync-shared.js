#!/usr/bin/env node
'use strict';

/**
 * Copies shared/facets.js into the phone's folder, as mobile/shared/facets.js.
 *
 * The phone is served from somewhere else and cannot reach this folder, so it
 * carries a copy -- and a copy is only as good as the last time somebody made
 * it. This is the one way it is made, and test/shared-drift.test.js fails the
 * moment the two disagree, so a change to the vocabulary cannot reach the
 * desktop and quietly miss the phone.
 *
 *   node tools/sync-shared.js          write the copy
 *   node tools/sync-shared.js --check  exit 1 if it is out of date, write nothing
 */

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..');
const SOURCE = path.join(APP, 'shared', 'facets.js');
const TARGET = path.join(APP, 'mobile', 'shared', 'facets.js');

const HEADER = [
  '// GENERATED -- a copy of ../shared/facets.js in the desktop app, made by',
  '// tools/sync-shared.js there. Edit that file and run the tool; an edit made',
  '// here is overwritten, and the desktop tests fail until the two agree.',
];

/** What the copy should hold, byte for byte: the header, then the source. */
function render(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return HEADER.join(eol) + eol + eol + source;
}

function main() {
  const want = render(fs.readFileSync(SOURCE, 'utf8'));
  if (!fs.existsSync(path.join(APP, 'mobile'))) {
    console.log('no mobile/ folder here: nothing to copy into');
    return 0;
  }
  let have = null;
  try { have = fs.readFileSync(TARGET, 'utf8'); } catch { /* not made yet */ }
  if (process.argv.includes('--check')) {
    if (have === want) { console.log('mobile/shared/facets.js is current'); return 0; }
    console.log('mobile/shared/facets.js is out of date: run node tools/sync-shared.js');
    return 1;
  }
  if (have === want) { console.log('mobile/shared/facets.js already current'); return 0; }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, want);
  console.log(`wrote ${path.relative(APP, TARGET)}`);
  return 0;
}

module.exports = { SOURCE, TARGET, HEADER, render };

if (require.main === module) process.exitCode = main();
