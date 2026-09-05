/* Credits the AV Idolz folder from its own filenames.
 *
 *   node tools/avidolz-credit.mjs           what would change -- writes nothing
 *   node tools/avidolz-credit.mjs --apply   fills the blanks in
 *
 * Every name here carries three facts:
 *
 *   avidolz_Gravure_Idol_Collection_Yuki_Serina_scene1_hd.mp4
 *           ^--- the series ---^ ^-- her --^
 *
 * The studio is the prefix, the same on all of them. The hard part is where the
 * series stops and she starts, since both are just underscored words and the
 * series is between one and three words long.
 *
 * The split is read off the folder rather than hardcoded: every series in it
 * ends with either "Idol" or "Collection", and no performer's name contains
 * either word, so the series is the LONGEST run of leading words ending in one
 * of those two. That settles Club_Idol_Erena (Club Idol / Erena) and
 * Idol_Premium_Collection_Risa (Idol Premium Collection / Risa) the same way,
 * without a list to keep up to date. The tool prints the series it found, so a
 * new one that broke the rule would be visible rather than silent.
 *
 * A trailing digit is the shoot, not the woman -- Rino_Tokiwa_2 is Rino Tokiwa.
 * This folder proves the rule rather than assuming it: eight of the numbered
 * files have a bare counterpart sitting beside them.
 *
 * Fills blanks only: a name typed in by hand is never overwritten, and running
 * this twice is the same as running it once.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DISK = process.env.AVIDOLZ_DIR
  || 'C:/Users/User/OneDrive/Folder 0/AV Jiali/AV Idolz';
const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = Number(process.env.VIDEO_EXPLORER_PORT || 4321);
const STUDIO = 'AV Idolz';

const APPLY = process.argv.includes('--apply');

/** The same key the app uses: survives a rename, a move and a dehydration. */
const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/** The word every series ends on. Nobody here is named either. */
const ENDS_SERIES = new Set(['idol', 'collection']);

/**
 * The series and the woman, out of one filename.
 *
 * Returns null for anything not shaped like the rest: a folder that grows a
 * stray download should say so rather than have something invented for it.
 */
function readName(stem) {
  const m = /^avidolz_(.+?)_scene\d+/i.exec(stem);
  if (!m) return null;
  const words = m[1].split('_').filter(Boolean);

  // The last leading word that ends a series. Last rather than first, so
  // "Idol Premium Collection" wins over the "Idol" inside it.
  let end = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (ENDS_SERIES.has(words[i].toLowerCase())) end = i;
  }
  if (end < 0 || end === words.length - 1) return null;

  const production = words.slice(0, end + 1).join(' ');
  let rest = words.slice(end + 1);
  // The shoot number, not part of her.
  const shoot = /^\d+$/.test(rest[rest.length - 1]) ? rest.pop() : '';
  if (!rest.length) return null;

  return { production, model: rest.join(' '), parts: rest.length, shoot };
}

const files = fs.readdirSync(DISK)
  .filter((f) => /\.(mp4|m4v|mov|wmv|avi)$/i.test(f))
  .map((f) => path.join(DISK, f));

const records = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).records || {};

const rows = [];
const odd = [];
for (const file of files) {
  const stem = path.basename(file, path.extname(file));
  const read = readName(stem);
  if (!read) { odd.push(stem); continue; }

  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  const record = records[keyFor(stat)] || {};

  // One or two words is a name. More than that is a cast list the underscores
  // cannot punctuate -- Nami_Itoshino_Yuri_Sato_Runa is three women, and which
  // words belong to which of them is not in the filename. Those rows still get
  // the studio and the series, which were never in doubt; only the name waits.
  const crowded = read.parts > 2;

  const patch = {};
  if (!crowded && !(record.models || []).length) patch.addModels = [read.model];
  if (!record.studio) patch.studio = STUDIO;
  if (!record.production) patch.production = read.production;

  rows.push({ file, stem, ...read, crowded, patch, record });
}

const series = new Map();
const people = new Map();
for (const r of rows) {
  series.set(r.production, (series.get(r.production) || 0) + 1);
  if (!r.crowded) people.set(r.model, (people.get(r.model) || 0) + 1);
}

const work = rows.filter((r) => Object.keys(r.patch).length);
const crowded = rows.filter((r) => r.crowded);
const numbered = rows.filter((r) => r.shoot);

console.log(`on disk    : ${files.length} videos`);
console.log(`parsed     : ${rows.length}`);
console.log(`to write   : ${work.length}`);
console.log(`  models   : ${work.filter((r) => r.patch.addModels).length}`);
console.log(`  studio   : ${work.filter((r) => r.patch.studio).length}`);
console.log(`  series   : ${work.filter((r) => r.patch.production).length}`);
console.log(`performers : ${people.size}`);
if (odd.length) console.log(`not parsed : ${odd.length}`);

console.log(`\n${series.size} series found, which is the split working:`);
for (const [name, n] of [...series].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(2)}  ${name}`);
}

const repeat = [...people].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
if (repeat.length) {
  console.log('\nMore than one video each:');
  for (const [name, n] of repeat) console.log(`  ${String(n).padStart(2)}  ${name}`);
}

if (numbered.length) {
  console.log('\nNumbered filenames -- the digit read as the shoot, not the name:');
  for (const r of numbered) {
    const bare = rows.some((o) => !o.shoot && o.model === r.model);
    console.log(`  ${r.model} (${r.shoot})${bare ? '   -- and she is here unnumbered too' : ''}`);
  }
}

if (crowded.length) {
  console.log('\nMore than one woman, and the filename does not say where each '
    + 'name ends.\nStudio and series written; the cast left for you:');
  for (const r of crowded) console.log(`  ${r.stem}\n    reads as: ${r.model}`);
}

// Two spellings of one woman make two performers, two face averages and two
// rows in the filter. Worth seeing even though the tool writes what it is told.
const flipped = [];
for (const [name] of people) {
  const parts = name.split(' ');
  if (parts.length !== 2) continue;
  const other = `${parts[1]} ${parts[0]}`;
  if (people.has(other) && name < other) flipped.push([name, other]);
}
if (flipped.length) {
  console.log('\nThe same name written both ways round -- these will show as two '
    + 'performers:');
  for (const [a, b] of flipped) console.log(`  ${a}   /   ${b}`);
}

if (odd.length) {
  console.log('\nNot shaped like the rest, so not credited:');
  for (const s of odd) console.log(`  ${s}`);
}

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
      // POST /api/library. There is no /api/label -- writing to that name gets a
      // 404 for every record and reports every one as a failure.
      host: '127.0.0.1', port: PORT, path: '/api/library', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

if (!APPLY) {
  console.log(`\nDry run. Nothing was changed. Add --apply to write ${work.length}.`);
} else if (!work.length) {
  console.log('\nNothing to do.');
} else {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS, `library-${stamp}.json`);
  fs.copyFileSync(SIDECAR, backup);
  console.log(`\nbackup    : ${backup}`);

  // Never edit the sidecar underneath the app: it holds the whole thing in
  // memory and writes it back on its own schedule, so a change made behind it
  // is thrown away at the next flush.
  if (!(await serverIsUp())) {
    console.error(`The app is not running on ${PORT}. Start Video Explorer and run this again.`);
    process.exit(1);
  }
  console.log('writing through the running app');

  let done = 0;
  const failed = [];
  for (const r of work) {
    try {
      const data = await post({ paths: [r.file], ...r.patch });
      const result = (data.records || {})[r.file];
      if (result && result.error) throw new Error(result.error);
      done += 1;
    } catch (err) {
      failed.push({ file: r.file, why: err.message });
    }
  }
  console.log(`written   : ${done}`);
  if (failed.length) {
    console.log(`failed    : ${failed.length}`);
    for (const f of failed.slice(0, 10)) {
      console.log(`  ${path.basename(f.file)} -- ${f.why}`);
    }
  }
}
