/* Credits the Teen Thais folder from the names in its own filenames.
 *
 *   node tools/teenthais-credit.mjs           what would change -- writes nothing
 *   node tools/teenthais-credit.mjs --apply   fills the blanks in
 *
 * No site to fetch and no title to match: this studio puts the performer in the
 * filename, every file, the same way.
 *
 *   teenthais_Pra_scene1_hd.mp4       -> Pra
 *   teenthais_Peow_Peow_scene1_hd.mp4 -> Peow Peow
 *   teenthais_Pra2_scene1_hd.mp4      -> Pra
 *
 * That last one is the only judgement in the whole tool. A trailing digit is the
 * shoot, not the woman -- Pra and Pra2 are the same Pra, which is the rule the
 * folder's owner gave for them. Five names carry one: May3, Muei2, Pra2, Pui2,
 * Zara2. Only Pra has a bare counterpart here, so for the other four the digit
 * merely disappears and nothing is merged; for Pra, two files become one name.
 *
 * Worth knowing if that rule is ever wrong: Thai nicknames repeat, so a numbered
 * name COULD be a second woman with the same one. If Pra2 turns out to be
 * someone else, the cost is not just a label -- familiar-faces averages a
 * centroid per name, so two women under one name blur each other's face. The
 * fix is to rename her in the app; the score rebuilds from the credits.
 *
 * Fills blanks only, like the other credit tools here: a name typed in by hand
 * is never overwritten, and running this twice is the same as running it once.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DISK = process.env.TEENTHAIS_DIR
  || 'C:/Users/User/OneDrive/Folder 0/AV Jiali/Teen Thais';
const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = Number(process.env.VIDEO_EXPLORER_PORT || 4321);

const APPLY = process.argv.includes('--apply');

/** The same key the app uses: survives a rename, a move and a dehydration. */
const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/**
 * Her name, out of the filename.
 *
 * Everything between the studio prefix and the scene number is the name, with
 * underscores standing in for the spaces a filename cannot hold. Returns null
 * rather than guessing when a file is not shaped like the rest -- a folder that
 * grows a stray download should say so, not credit it to something.
 */
function nameIn(stem) {
  const m = /^teenthais_(.+?)_scene\d+/i.exec(stem);
  if (!m) return null;
  const name = m[1]
    .replace(/_+/g, ' ')
    // The shoot number, not part of her: Pra2 is Pra.
    .replace(/\s*\d+$/, '')
    .trim();
  return name || null;
}

const files = fs.readdirSync(DISK)
  .filter((f) => /\.(mp4|m4v|mov|wmv|avi)$/i.test(f))
  .map((f) => path.join(DISK, f));

const records = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).records || {};

const work = [];
const intact = [];
const numbered = [];
const odd = [];

for (const file of files) {
  const stem = path.basename(file, path.extname(file));
  const name = nameIn(stem);
  if (!name) { odd.push(stem); continue; }

  let stat;
  try { stat = fs.statSync(file); } catch { continue; }
  const record = records[keyFor(stat)] || {};

  const row = { file, stem, name, record };
  if (/\d+_scene/i.test(stem)) numbered.push(row);
  if ((record.models || []).length) intact.push(row);
  else work.push(row);
}

const byName = new Map();
for (const r of work.concat(intact)) {
  byName.set(r.name, (byName.get(r.name) || 0) + 1);
}

console.log(`on disk        : ${files.length} videos`);
console.log(`already named  : ${intact.length}`);
console.log(`to credit      : ${work.length}`);
console.log(`performers     : ${byName.size}`);
if (odd.length) console.log(`not the pattern: ${odd.length}`);

const shared = [...byName].filter(([, n]) => n > 1);
if (shared.length) {
  console.log('\nMore than one video each:');
  for (const [name, n] of shared.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(2)}  ${name}`);
  }
}

if (numbered.length) {
  console.log('\nNumbered filenames -- the digit read as the shoot, not the name:');
  for (const r of numbered) console.log(`  ${r.stem}  ->  ${r.name}`);
}

if (intact.length) {
  console.log('\nAlready credited, left alone:');
  for (const r of intact) {
    console.log(`  ${r.stem}  keeps ${r.record.models.join(', ')} (filename says ${r.name})`);
  }
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
  console.log(`\nDry run. Nothing was changed. Add --apply to credit ${work.length}.`);
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
      const data = await post({ paths: [r.file], addModels: [r.name] });
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
    for (const f of failed.slice(0, 10)) {
      console.log(`  ${path.basename(f.file)} -- ${f.why}`);
    }
  }
}
