/* Credits a folder whose studio writes the facts into the filenames.
 *
 *   node tools/studio-credit.mjs                    every folder, writes nothing
 *   node tools/studio-credit.mjs tenshigao          one folder, writes nothing
 *   node tools/studio-credit.mjs tenshigao --apply  fills the blanks in
 *
 * Three studios in this library name their files rather than leaving the work to
 * a site fetch, and they do it the same way underneath:
 *
 *   teenthais_Pra_scene1_hd                          -> Pra
 *   tenshigao_Towa_Nakamori_02_hd                    -> Towa Nakamori
 *   avidolz_Gravure_Idol_Collection_Yuki_Serina_s1_hd -> Gravure Idol Collection
 *                                                       / Yuki Serina
 *
 * so they share one reader here instead of three scripts that would drift. What
 * differs is only the folder, the studio's name, and whether there is a series
 * in front of hers.
 *
 * THE SHOOT NUMBER. A trailing number is which shoot, never who: Pra2 is Pra,
 * Rino_Tokiwa_2 is Rino Tokiwa, Towa_Nakamori_02 is Towa Nakamori. The studios
 * disagree only on where they put it -- attached, or as its own word, or both at
 * once in Miki_Motohashi_2_02 -- so the reader strips trailing numbers wherever
 * they sit. The folders themselves argue for the rule rather than against it:
 * dozens of the numbered files have the same woman beside them, numbered
 * differently or not at all.
 *
 * WORTH KNOWING IF THAT IS EVER WRONG. Nicknames repeat, so a numbered name
 * COULD be a second woman with the same one. The cost is not just a label:
 * familiar faces averages one centroid per name, so two women under one name
 * blur each other. Rename her in the app and the score rebuilds from the credits.
 *
 * PAST TWO WORDS IT IS NOT A NAME. Sometimes it is a cast list the underscores
 * cannot punctuate -- Aya_Oukura_Madoka_Ohnishi, or worse
 * Nami_Itoshino_Yuri_Sato_Runa, which splits as plausibly 2/2/1 as 1/2/2 since
 * these folders write names both ways round. Sometimes it is nobody at all:
 * My_School_Life is a scene title standing where a performer usually goes.
 * Two words is the line because every real name in these folders fits inside
 * it, stage names included -- Peow Peow, Baby Doll, Spooky Boogie. Those rows
 * get the studio and the series, which were never in doubt, and wait for a
 * person on the name.
 *
 * Fills blanks only: a name typed in by hand is never overwritten, and running
 * this twice is the same as running it once.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = Number(process.env.VIDEO_EXPLORER_PORT || 4321);
const HOME = process.env.STUDIO_CREDIT_DIR
  || path.join(ONEDRIVE, 'Folder 0', 'AV Jiali');

/**
 * `series` is how a studio's own series is told from the woman who follows it.
 * AV Idolz is the only one with any, and rather than a list to keep up to date
 * it is read off the folder: every series there ends on "Idol" or "Collection"
 * and nobody is named either word, so the series is the longest leading run
 * ending on one of the two. A ninth series that broke the rule would show up in
 * the printed tally rather than quietly swallowing somebody's first name.
 */
const ENDS_SERIES = new Set(['idol', 'collection']);

const STUDIOS = [
  { key: 'teenthais', dir: 'Teen Thais', studio: 'Teen Thais', prefix: 'teenthais' },
  { key: 'tenshigao', dir: 'Tenshigao', studio: 'Tenshigao', prefix: 'tenshigao' },
  { key: 'nucosplay', dir: 'Nu Cosplay', studio: 'Nu Cosplay', prefix: 'nucosplay' },
  {
    key: 'avidolz',
    dir: 'AV Idolz',
    studio: 'AV Idolz',
    prefix: 'avidolz',
    series: true,
  },
];

/** The same key the app uses: survives a rename, a move and a dehydration. */
const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/**
 * The facts in one filename, or null for anything not shaped like the rest -- a
 * folder that grows a stray download should say so rather than have something
 * invented for it.
 */
function read(stem, studio) {
  const head = new RegExp(`^${studio.prefix}_(.+)$`, 'i').exec(stem);
  if (!head) return null;

  const words = head[1].split('_').filter(Boolean);
  // Every one of them ends on the quality, which is not a fact about the video
  // worth recording when the whole folder shares it.
  if (words.length && /^(hd|sd|4k)$/i.test(words[words.length - 1])) words.pop();

  // Trailing numbers are the shoot. Plural, since Miki_Motohashi_2_02 has two.
  const shoot = [];
  while (words.length && /^(scene)?\d+$/i.test(words[words.length - 1])) {
    shoot.unshift(words.pop());
  }
  if (!words.length) return null;
  // And one may be attached rather than standing alone: Pra2, May3.
  const tail = /^(.*[^\d])(\d+)$/.exec(words[words.length - 1]);
  if (tail) {
    words[words.length - 1] = tail[1];
    shoot.unshift(tail[2]);
  }

  let production = '';
  if (studio.series) {
    let end = -1;
    for (let i = 0; i < words.length; i += 1) {
      if (ENDS_SERIES.has(words[i].toLowerCase())) end = i;
    }
    if (end < 0 || end === words.length - 1) return null;
    production = words.splice(0, end + 1).join(' ');
  }
  if (!words.length) return null;

  return {
    production,
    model: words.join(' '),
    parts: words.length,
    shoot: shoot.join('/'),
  };
}

function survey(studio) {
  const dir = path.join(HOME, studio.dir);
  if (!fs.existsSync(dir)) return { studio, missing: dir };

  const files = fs.readdirSync(dir)
    .filter((f) => /\.(mp4|m4v|mov|wmv|avi)$/i.test(f))
    .map((f) => path.join(dir, f));
  const records = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).records || {};

  const rows = [];
  const odd = [];
  for (const file of files) {
    const stem = path.basename(file, path.extname(file));
    const got = read(stem, studio);
    if (!got) { odd.push(stem); continue; }

    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const record = records[keyFor(stat)] || {};

    const crowded = got.parts > 2;
    const patch = {};
    if (!crowded && !(record.models || []).length) patch.addModels = [got.model];
    if (!record.studio) patch.studio = studio.studio;
    if (got.production && !record.production) patch.production = got.production;

    rows.push({ file, stem, ...got, crowded, patch, record });
  }
  return { studio, dir, files, rows, odd };
}

function report(s) {
  console.log(`\n=== ${s.studio.studio} ===`);
  if (s.missing) { console.log(`  folder not found: ${s.missing}`); return; }

  const work = s.rows.filter((r) => Object.keys(r.patch).length);
  const people = new Map();
  const series = new Map();
  for (const r of s.rows) {
    if (!r.crowded) people.set(r.model, (people.get(r.model) || 0) + 1);
    if (r.production) series.set(r.production, (series.get(r.production) || 0) + 1);
  }

  console.log(`on disk    : ${s.files.length} videos`);
  console.log(`to write   : ${work.length}`
    + `  (models ${work.filter((r) => r.patch.addModels).length}`
    + `, studio ${work.filter((r) => r.patch.studio).length}`
    + `${s.studio.series ? `, series ${work.filter((r) => r.patch.production).length}` : ''})`);
  console.log(`performers : ${people.size}`);
  if (s.odd.length) console.log(`not parsed : ${s.odd.length}`);

  if (series.size) {
    console.log(`\n  ${series.size} series found, which is the split working:`);
    for (const [name, n] of [...series].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(2)}  ${name}`);
    }
  }

  const crowded = s.rows.filter((r) => r.crowded);
  if (crowded.length) {
    console.log('\n  Past two words, so not read as one name -- a cast the '
      + 'underscores cannot\n  punctuate, or a scene title. Studio written, the '
      + 'name left for you:');
    for (const r of crowded) console.log(`    ${r.stem}\n      reads as: ${r.model}`);
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
    console.log('\n  The same name written both ways round -- two performers, '
      + 'two face averages:');
    for (const [a, b] of flipped) console.log(`    ${a}   /   ${b}`);
  }

  if (s.odd.length) {
    console.log('\n  Not shaped like the rest, so not credited:');
    for (const t of s.odd) console.log(`    ${t}`);
  }
  return work;
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

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const chosen = only.length
  ? STUDIOS.filter((s) => only.includes(s.key) || only.includes(s.dir.toLowerCase()))
  : STUDIOS;

if (!chosen.length) {
  console.error(`Nothing matched. Known: ${STUDIOS.map((s) => s.key).join(', ')}`);
  process.exit(1);
}

const todo = [];
for (const studio of chosen) {
  const s = survey(studio);
  const work = report(s);
  if (work) todo.push(...work);
}

if (!APPLY) {
  console.log(`\nDry run. Nothing was changed. Add --apply to write ${todo.length}.`);
} else if (!todo.length) {
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
  console.log(`written   : ${done}`);
  if (failed.length) {
    console.log(`failed    : ${failed.length}`);
    for (const f of failed.slice(0, 10)) {
      console.log(`  ${path.basename(f.file)} -- ${f.why}`);
    }
  }
}
