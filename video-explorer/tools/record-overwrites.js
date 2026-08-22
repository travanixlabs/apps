'use strict';

/**
 * Reads the rename manifests and writes down every case where more than one file
 * was renamed onto the same name — which, before the clobber guard, destroyed
 * all but the last of them.
 *
 * Kept as a tool rather than a one-off so the list can be regenerated from the
 * manifests, and so a future run's manifests get the same check.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'manifests');
const base = (p) => path.basename(p);

const groups = [];
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const byTarget = new Map();
  for (const move of JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')).moves || []) {
    const key = move.to.toLowerCase();
    if (!byTarget.has(key)) byTarget.set(key, { to: move.to, from: [] });
    byTarget.get(key).from.push(move.from);
  }
  for (const group of byTarget.values()) {
    if (group.from.length > 1) groups.push({ file, ...group });
  }
}

const lost = groups.reduce((n, g) => n + g.from.length - 1, 0);

const lines = [
  '# Files lost to a clobbering rename — 22 Aug 2026',
  '',
  'An earlier version of `tools/xchina-apply.js` could rename several files onto',
  'one name. `fs.renameSync` overwrites the destination silently on Windows, so in',
  'each group below only the **last** source survived — under the target name —',
  'and the others were destroyed.',
  '',
  `${groups.length} targets, ${lost} files lost.`,
  '',
  'These are OneDrive paths, so the overwritten content may still be recoverable:',
  'right-click the surviving file on onedrive.com and check **Version history**, or',
  'look in the site **Recycle bin**.',
  '',
];

for (const g of groups) {
  lines.push(`## ${base(g.to)}`);
  lines.push(`in \`${g.file}\`, still on disk: ${fs.existsSync(g.to) ? 'yes' : 'no'}`);
  lines.push('');
  g.from.forEach((from, i) => {
    lines.push(`- ${i === g.from.length - 1 ? '**survived**' : 'lost'}: \`${base(from)}\``);
  });
  lines.push('');
}

fs.writeFileSync(path.join(DIR, 'OVERWRITTEN.md'), lines.join('\n'));
console.log(`${groups.length} groups, ${lost} files lost — written to manifests/OVERWRITTEN.md`);
for (const g of groups) console.log(`  ${g.from.length} -> 1  ${base(g.to).slice(0, 60)}`);
