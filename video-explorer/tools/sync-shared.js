#!/usr/bin/env node
'use strict';

/**
 * Copies shared/*.js into the phone's folder, as mobile/shared/*.js.
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
// Every file the phone carries a copy of. Add to this list, never to mobile/.
const FILES = ['facets.js', 'merge.js', 'format.js'];
const sourceOf = (name) => path.join(APP, 'shared', name);
const targetOf = (name) => path.join(APP, 'mobile', 'shared', name);
// Kept for anything still naming the first of them.
const SOURCE = sourceOf('facets.js');
const TARGET = targetOf('facets.js');

const header = (name) => [
  `// GENERATED -- a copy of ../shared/${name} in the desktop app, made by`,
  '// tools/sync-shared.js there. Edit that file and run the tool; an edit made',
  '// here is overwritten, and the desktop tests fail until the two agree.',
];
const HEADER = header('facets.js');

/** What the copy should hold, byte for byte: the header, then the source. */
function render(source, name = 'facets.js') {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return header(name).join(eol) + eol + eol + source;
}

function main() {
  if (!fs.existsSync(path.join(APP, 'mobile'))) {
    console.log('no mobile/ folder here: nothing to copy into');
    return 0;
  }
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const name of FILES) {
    const want = render(fs.readFileSync(sourceOf(name), 'utf8'), name);
    let have = null;
    try { have = fs.readFileSync(targetOf(name), 'utf8'); } catch { /* not made yet */ }
    if (have === want) { console.log(`mobile/shared/${name} is current`); continue; }
    if (check) { console.log(`mobile/shared/${name} is out of date: run node tools/sync-shared.js`); stale += 1; continue; }
    fs.mkdirSync(path.dirname(targetOf(name)), { recursive: true });
    fs.writeFileSync(targetOf(name), want);
    console.log(`wrote mobile/shared/${name}`);
  }
  return stale ? 1 : 0;
}

module.exports = { FILES, sourceOf, targetOf, SOURCE, TARGET, HEADER, render };

if (require.main === module) process.exitCode = main();
