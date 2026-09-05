/* Credits the AV Jiali folder from the cast fetched off the site.
 *
 *   node tools/avjiali-credit.mjs                    what would change
 *   node tools/avjiali-credit.mjs --apply            fills the blanks in
 *   node tools/avjiali-credit.mjs --apply --loose    reworded titles too
 *
 * Reads avjiali-cast.json next to it; run tools/avjiali-cast.mjs to refresh
 * that from the site. Override the folder with AVJIALI_DIR.
 *
 * These files carry no reference code in their names, only the title in curly
 * quotes, so the join is title-to-title rather than code-to-code the way the
 * xChina run worked. That sounds fragile and is not: the titles are the site's
 * own, verbatim, and 231 of 238 match to the character once quotes, case and
 * punctuation are set aside.
 *
 * Fills blanks only, like xchina-relabel: a cast someone corrected by hand is
 * never overwritten, and running it twice is the same as running it once.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1));
const DISK = process.env.AVJIALI_DIR
  || 'C:/Users/User/OneDrive/Folder 0/AV Jiali/AV Jiali';
const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = 4321;
const STUDIO = 'AV Jiali';

const APPLY = process.argv.includes('--apply');
const LOOSE = process.argv.includes('--loose');

const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/** Curly quotes, case and punctuation differ without meaning anything. */
function key(raw) {
  return String(raw)
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const words = (k) => new Set(k.split(' ').filter((w) => w.length > 2));

/** Does this title name her? Whole words, so "una" is not found in "tuna". */
function names(titleKey, name) {
  const n = key(name);
  if (!n) return false;
  return ` ${titleKey} `.includes(` ${n} `);
}

/**
 * A near title is safe to trust when the credited name reads the same on both
 * sides. Named on the site's side only means the site recredited the video and
 * the filename still carries whoever it was before -- which is a different
 * claim from a reworded title, and not one this tool should settle.
 */
function sameWoman(mineKey, entry) {
  return (entry.models || []).every(
    (m) => names(mineKey, m) === names(entry.key, m));
}

/** Overlap as a share of the smaller title, so a subtitle does not sink it. */
function overlap(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

// ---- the cast, as fetched
const cast = JSON.parse(fs.readFileSync(path.join(HERE, 'avjiali-cast.json'), 'utf8'));
const byTitle = new Map();
for (const p of cast.performers) {
  for (const v of p.videos) {
    const k = key(v.title);
    if (!k) continue;
    const at = byTitle.get(k) || { ...v, key: k, models: [] };
    if (!at.models.includes(p.name)) at.models.push(p.name);
    byTitle.set(k, at);
  }
}
const titles = [...byTitle.keys()];
console.log(`cast      : ${cast.performers.length} performers over ${byTitle.size} videos`);

// ---- the files
const files = fs.readdirSync(DISK)
  .filter((f) => /\.(mp4|m4v|mov)$/i.test(f))
  .map((f) => path.join(DISK, f));
console.log(`on disk   : ${files.length} videos`);

const records = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).records || {};

const work = [];
const intact = [];
const near = [];
const unknown = [];
const disputed = [];
const renamed = [];

for (const file of files) {
  const stem = path.basename(file, path.extname(file));
  const k = key(stem);
  let entry = byTitle.get(k);
  let via = 'title';

  if (!entry) {
    // Nothing exact. The near miss is nearly always a title the site has since
    // reworded -- "Escort Song Nan Yi…" against "Song Nan Yi…" -- so the best
    // overlap is offered rather than applied, unless --loose says otherwise.
    let best = null;
    for (const t of titles) {
      const score = overlap(k, t);
      if (!best || score > best.score) best = { t, score };
    }
    // 0.7 rather than something stricter because a recredited row writes no
    // name: the worst a loose match can do here is attach the wrong reference
    // url, and every file in this folder is the same studio either way. The
    // last holdout, "Gorgeous Brunette Xiao Mai" against the site's "Lei Wei
    // Wei", scores 0.71 -- the two names are most of what differs.
    if (best && best.score >= 0.7) {
      entry = byTitle.get(best.t);
      via = sameWoman(k, byTitle.get(best.t))
        ? `reworded ${Math.round(best.score * 100)}%`
        : `recredited ${Math.round(best.score * 100)}%`;
    } else {
      unknown.push({ file, stem, best });
      continue;
    }
  }

  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  const record = records[keyFor(stat)] || {};

  const patch = {};
  // Her name, only where the title matched exactly. A near title is the site
  // having edited the words, and one kind of edit is a recredit.
  if (via === 'title' && entry.models.length && !(record.models || []).length) {
    patch.addModels = entry.models;
  }
  if (!record.studio) patch.studio = STUDIO;
  // The reference url, not the title slug: a slug is an old title and the site
  // rewrites titles, but avjiali.com/avji-170/ is the video's own address.
  const at = entry.ref
    ? `https://avjiali.com/${String(entry.ref).toLowerCase()}/`
    : entry.url;
  if (at && !record.url) patch.url = at;
  // AVJI-074 -> AVJI. Every reference on this site shares the one prefix, so
  // the production is the same for all of them; it is recorded anyway because
  // the rest of the library records it and a facet with a hole in it is worse
  // than no facet.
  const production = (entry.ref || '').match(/^([A-Za-z]+)/);
  if (production && !record.production) patch.production = production[1];

  // Where a cast is already recorded, the site may name someone else. Filling
  // blanks only means that disagreement would pass unnoticed, which is the one
  // case worth surfacing: either the hand-written credit is wrong, or the site
  // has recredited the video the way it did with the tour bus slug.
  const had = (record.models || []).map((m) => m.toLowerCase());
  if (had.length && entry.models.length
    && !entry.models.some((m) => had.includes(m.toLowerCase()))) {
    disputed.push({ stem, mine: record.models, theirs: entry.models, ref: entry.ref });
  }

  const row = { file, stem, entry, via, patch, record };
  if (via.startsWith('recredited')) renamed.push(row);
  else if (!Object.keys(patch).length) intact.push(row);
  else if (via === 'title') work.push(row);
  else near.push(row);
}

const counting = (rows, field) => rows.filter((r) => r.patch[field]).length;

console.log(`\nmatched by title : ${work.length + intact.length}`);
console.log(`  already right  : ${intact.length}`);
console.log(`  to fill in     : ${work.length}`);
console.log(`    models       : ${counting(work, 'addModels')}`);
console.log(`    studio       : ${counting(work, 'studio')}`);
console.log(`    url          : ${counting(work, 'url')}`);
console.log(`    production   : ${counting(work, 'production')}`);
console.log(`reworded titles  : ${near.length}${LOOSE ? ' (included)' : ' (held back)'}`);
console.log(`recredited       : ${renamed.length} (no name; everything else written)`);
console.log(`no match at all  : ${unknown.length}`);
console.log(`disputed cast    : ${disputed.length}`);

const cast_count = new Map();
for (const r of work) for (const m of r.patch.addModels || []) {
  cast_count.set(m, (cast_count.get(m) || 0) + 1);
}
if (cast_count.size) {
  const top = [...cast_count].sort((a, b) => b[1] - a[1]);
  console.log(`\n${cast_count.size} performers credited. Busiest:`);
  for (const [name, n] of top.slice(0, 12)) console.log(`  ${String(n).padStart(3)}  ${name}`);
}

console.log('\nFirst few:');
for (const r of work.slice(0, 10)) {
  console.log(`  ${r.stem.slice(0, 68)}`);
  console.log(`    ${r.entry.ref}  + ${(r.patch.addModels || ['—']).join(', ')}`);
}

if (near.length) {
  console.log('\nReworded titles \u2014 same woman, the site edited the wording:');
  for (const r of near) {
    console.log(`  disk: ${r.stem}`);
    console.log(`  site: ${r.entry.title}   [${r.via}]  ${r.entry.ref}  ${r.entry.models.join(', ')}`);
  }
}

if (renamed.length) {
  console.log('\nRecredited by the site \u2014 no name written, your filename keeps the old one:');
  for (const r of renamed) {
    console.log(`  disk: ${r.stem}`);
    console.log(`  site: ${r.entry.title}   [${r.via}]  ${r.entry.ref}  ${r.entry.models.join(', ')}`);
  }
}

if (disputed.length) {
  console.log('\nAlready credited to someone the site does not name '
    + '\u2014 models left untouched:');
  for (const d of disputed) {
    console.log(`  ${d.stem.slice(0, 70)}`);
    console.log(`    yours: ${d.mine.join(', ')}   site: ${d.theirs.join(', ')}   ${d.ref}`);
  }
}

if (unknown.length) {
  console.log('\nNot in the cast at all (no performer page lists them):');
  for (const u of unknown) {
    const hint = u.best ? `  closest ${Math.round(u.best.score * 100)}%: ${u.best.t.slice(0, 52)}` : '';
    console.log(`  ${u.stem.slice(0, 70)}\n  ${hint}`);
  }
}

// ---- writing
function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      // POST /api/library. There is no /api/label -- writing to that name gets
      // a 404 for every record and reports every one as a failure, which is
      // exactly how the first run of this tool went.
      host: '127.0.0.1', port: PORT, path: '/api/library', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// A recredited row carries no addModels, so including it can only fill in the
// studio, the production code and the url -- never a name this cannot settle.
const todo = LOOSE ? work.concat(near, renamed) : work.concat(renamed);

if (!APPLY) {
  console.log(`\nDry run. Nothing was changed. Add --apply to fill in ${todo.length}.`);
} else if (!todo.length) {
  console.log('\nNothing to do.');
} else {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS, `library-${stamp}.json`);
  fs.copyFileSync(SIDECAR, backup);
  console.log(`\nbackup    : ${backup}`);

  if (!(await serverIsUp())) {
    console.error('The app is not running on 4321. It holds the sidecar in memory and');
    console.error('writes it back on its own schedule, so editing the file underneath it');
    console.error('would be thrown away. Start Video Explorer and run this again.');
    process.exit(1);
  }
  console.log('writing through the running app');

  let done = 0;
  const failed = [];
  for (const r of todo) {
    try {
      const data = await post({ paths: [r.file], ...r.patch });
      const result = (data.records || {})[r.file];
      if (result && result.error) throw new Error(result.error);
      done += 1;
    } catch (err) {
      failed.push({ file: r.file, why: err.message });
    }
  }
  console.log(`credited  : ${done}`);
  if (failed.length) {
    console.log(`failed    : ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`  ${path.basename(f.file)} — ${f.why}`);
  }
}
