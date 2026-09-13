/* Builds the bookmark icon set from the pictures in tags\.
 *
 *   node tools/make-icons.js
 *
 * The source pictures are named with everything the picker needs already in
 * them -- a number, a name in brackets, and a comma list of what the position
 * is -- so the filename is parsed rather than re-typed:
 *
 *   Sex position #194 (Ribbon (reverse spoon)) from behind, reverse, ... .png
 *                 ^id      ^name                ^keywords
 *
 * The brackets are matched GREEDILY, to the LAST one. #194's name has brackets
 * of its own and no keyword ever does, so the last bracket is reliably the end
 * of the name where the first is not.
 *
 * Two things come out:
 *   public/icons/positions/pos-N.png   the picture, shrunk to icon size
 *   the pos- entries in public/icons.json, behind the hand-written ones
 *
 * Re-runnable: it replaces the pos- entries rather than adding to them, and
 * leaves the hand-written icons and the file's notes alone. tags\ is only ever
 * read.
 *
 * The id is the NUMBER, which is what makes re-running safe -- an id is what a
 * saved bookmark stores, so it has to survive the artwork being redone.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP = path.join(__dirname, '..');
const SRC = path.join(APP, 'tags');
const OUT = path.join(APP, 'public', 'icons', 'positions');
const JSON_FILE = path.join(APP, 'public', 'icons.json');

/* 500 wide shown in a 74px tile is four times more picture than can be used,
 * and 519 of those decode to some hundreds of megabytes of bitmap. 200 leaves
 * enough for a high-density screen and nothing beyond it. */
const WIDTH = 200;
const AT_ONCE = Math.max(1, Number(process.argv[process.argv.indexOf('--jobs') + 1]) || 3);

const PATTERN = /^Sex position #(\d+)\s*\((.+)\)\s*(.*)\.png$/i;

function read() {
  const items = [];
  const odd = [];
  for (const file of fs.readdirSync(SRC)) {
    if (!/\.png$/i.test(file)) continue;
    const m = PATTERN.exec(file);
    if (!m) { odd.push(file); continue; }
    items.push({
      file,
      num: Number(m[1]),
      name: m[2].trim(),
      tags: m[3].split(',').map((t) => t.trim()).filter(Boolean),
    });
  }
  items.sort((a, b) => a.num - b.num);
  return { items, odd };
}

const run = (args) => new Promise((resolve, reject) => {
  execFile('ffmpeg', args, (err) => (err ? reject(err) : resolve()));
});

async function convert(items) {
  fs.mkdirSync(OUT, { recursive: true });
  const queue = items.slice();
  const failed = [];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const to = path.join(OUT, `pos-${item.num}.png`);
      try {
        await run(['-y', '-loglevel', 'error', '-i', path.join(SRC, item.file),
          '-vf', `scale=${WIDTH}:-1:flags=lanczos`, to]);
        done += 1;
        if (done % 50 === 0) console.log(`  ${done}/${items.length}`);
      } catch (err) {
        failed.push({ item, why: String(err.message || err).split('\n')[0] });
      }
    }
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return { done, failed };
}

/* The notes at the top of icons.json are kept as they are, with one paragraph
 * added the first time this runs -- so someone opening the file to edit a
 * pos- entry by hand is told it will be overwritten. */
const MARKER = 'The positions below are GENERATED from the tags folder.';
function note(existing) {
  const lines = Array.isArray(existing) ? existing.slice() : [];
  if (lines.some((line) => String(line).includes(MARKER))) return lines;
  return lines.concat([
    '',
    MARKER,
    'Their id is the number in the filename, so it survives a re-run and any',
    'amount of renaming; the name and the keywords are the bracketed name and',
    'the comma list. Re-make them with `node tools/make-icons.js` after adding',
    'to tags\\ -- editing a pos- entry here by hand will be overwritten.',
  ]);
}

async function main() {
  const { items, odd } = read();
  console.log(`${items.length} pictures to convert${odd.length ? `, ${odd.length} skipped` : ''}`);
  for (const file of odd) console.log(`  did not parse: ${file}`);
  if (!items.length) return;

  const { done, failed } = await convert(items);
  console.log(`converted ${done}${failed.length ? `, FAILED ${failed.length}` : ''}`);
  for (const f of failed.slice(0, 10)) console.log(`  #${f.item.num} ${f.item.name}: ${f.why}`);

  const positions = items
    .filter((item) => fs.existsSync(path.join(OUT, `pos-${item.num}.png`)))
    .map((item) => ({
      id: `pos-${item.num}`,
      name: item.name,
      src: `icons/positions/pos-${item.num}.png`,
      /* The number is searchable too, so "194" reaches one exactly, and
       * "position" brings the whole set back after a search has narrowed it. */
      keywords: ['position', String(item.num), ...item.tags],
    }));

  const current = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  const kept = current.icons.filter((icon) => !/^pos-\d+$/.test(icon.id));
  const all = [...kept, ...positions];

  const seen = new Set();
  for (const icon of all) {
    if (seen.has(icon.id)) throw new Error(`two icons share the id ${icon.id}`);
    seen.add(icon.id);
  }

  fs.writeFileSync(JSON_FILE,
    `${JSON.stringify({ _: note(current._), icons: all }, null, 2)}\n`);
  console.log(`icons.json: ${kept.length} hand-written + ${positions.length} positions`);

  const missing = all.filter((i) => i.src && !fs.existsSync(path.join(APP, 'public', i.src)));
  console.log(missing.length
    ? `MISSING ${missing.length} picture(s) an entry points at`
    : 'every entry points at a picture that exists');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
