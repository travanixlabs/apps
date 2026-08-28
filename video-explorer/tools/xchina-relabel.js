'use strict';

/**
 * Fills in models, studio, production and source url that the catalogue knows
 * and the sidecar does not.
 *
 *   node tools/xchina-relabel.js            what is missing — changes nothing
 *   node tools/xchina-relabel.js --apply    fills it in
 *
 * Why this exists: the label dialog's Replace mode *sets* every field it is
 * shown, so applying it to a selection with the Models and Studio boxes empty
 * clears the cast and the studio on every video in that selection. It is one
 * click away from Add, and it has happened twice.
 *
 * The repair is exact rather than a guess, because the url survives — Replace
 * only sends the three fields the dialog holds, and the url is not one of them.
 * So a record whose url points at a catalogue page that names a cast, while the
 * record itself names nobody, has lost that cast. The reference code in the
 * filename says the same thing a second way, and both are checked.
 *
 * Anything already filled in is left exactly as it is: this only ever fills
 * blanks, so running it twice is the same as running it once, and a cast someone
 * corrected by hand is never overwritten by the catalogue's version.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { build } = require('./xchina-match');

const APPLY = process.argv.includes('--apply');
const FIX = process.argv.includes('--fix-production');
const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = process.env.VIDEO_EXPLORER_LIBRARY
  || path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = 4321;

/** `size:mtime`, the sidecar's key — it survives a rename, which is the point. */
const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/**
 * Which letter-prefixes number their *series* rather than their shoots.
 *
 * Learned from the whole catalogue instead of guessed per reference, because a
 * single reference cannot tell you: `MTVQ18` and `XSJTC09` are the same shape,
 * but MTVQ also publishes `MTVQ12-EP1`, which proves the 12 is a season and the
 * episode is what follows. XSJTC never does that, so its 09 is a shoot number.
 *
 * The evidence is a short number followed by a separator: letters, one or two
 * digits, then `-`. Three prefixes qualify across all 8,975 references — MTVQ,
 * MTVSQ and XKK — and once a prefix qualifies, every one of its references is
 * read that way, so `MTVQ12` and `MTVQ12-EP1` land on the same code.
 */
function seriesNumberedPrefixes(entries) {
  const found = new Set();
  for (const entry of entries) {
    const m = String(entry.ref || '').trim().match(/^(\d*[A-Za-z]+)\d{1,2}[-_ ]/);
    if (m) found.add(m[1].toUpperCase());
  }
  return found;
}

/**
 * The production code inside a reference.
 *
 *   MD0352        -> MD        the digits are the shoot's number
 *   MD0200-2      -> MD        and -2 is a part of that shoot
 *   RS036-EP3     -> RS        three digits is a shoot, not a season
 *   MKY-TH002     -> MKY       the letters stop at the separator
 *   91CM-224      -> 91CM      two references begin with a number
 *   MTVQ21-EP1-2  -> MTVQ21    MTVQ numbers its series
 *   MTVQ18        -> MTVQ18    so a bare one is a season too
 *   MTVSQ2-EP11   -> MTVSQ2
 *   XKK9-8009     -> XKK9
 *   XSJTC09       -> XSJTC     XSJTC does not, so 09 is the shoot
 */
function productionOf(ref, seriesNumbered) {
  const text = String(ref || '').trim();
  const m = text.match(/^(\d*[A-Za-z]+)(\d*)/);
  if (!m || !m[1]) return '';
  const letters = m[1].toUpperCase();
  const digits = m[2];
  if (digits.length >= 1 && digits.length <= 2 && seriesNumbered.has(letters)) {
    return letters + digits;
  }
  return letters;
}

/**
 * The reference the import baked into a filename: `Title (MD0352).mp4`.
 *
 * Only a code in trailing parentheses counts, because that is the shape this
 * repo's own renamer writes — a code-shaped run anywhere else in a name is as
 * likely to be part of the title.
 */
function refFromName(file) {
  const base = path.basename(file, path.extname(file));
  const m = base.match(/\(([^()]{2,30})\)\s*$/);
  return m ? m[1].trim() : '';
}

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 600 },
      (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Whether the running app understands every field this run wants to write.
 *
 * A server started before a field existed accepts the write and drops it: the
 * patch key is simply one it has never heard of, so the request succeeds, the
 * count says it worked, and nothing changed. Asking what it can report is the
 * cheapest way to find out, and refusing is better than a silent no-op.
 */
function serverKnows(field) {
  const plural = field + 's';
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/library', timeout: 3000 },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try { resolve(Object.prototype.hasOwnProperty.call(JSON.parse(text), plural)); }
          catch { resolve(false); }
        });
      });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** One label edit, through the running app — it owns the sidecar while it is up. */
function post(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/library',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function main() {
  const { matched, entries } = build();
  const seriesNumbered = seriesNumberedPrefixes(entries);
  const records = JSON.parse(fs.readFileSync(SIDECAR, 'utf8')).records || {};

  // Every catalogue entry that names a cast, by its page url, so a record can be
  // repaired even if its filename never carried a usable code.
  const byUrl = new Map();
  for (const item of matched) {
    if (item.entry.url) byUrl.set(item.entry.url, item.entry);
  }

  const work = [];
  const gone = [];
  let intact = 0;
  let nothingToSay = 0;

  for (const item of matched) {
    let stat;
    try {
      stat = fs.statSync(item.file);
    } catch {
      gone.push(item.file); // renamed or moved since the walk
      continue;
    }
    const record = records[keyFor(stat)];

    // The entry the filename points at, and the one the record's own url points
    // at. Normally the same; where they differ the record's url wins, since that
    // is the page whoever labelled it was actually looking at.
    const viaUrl = record && record.url ? byUrl.get(record.url) : null;
    const entry = viaUrl || item.entry;

    const models = entry.models || [];
    const studio = entry.studio || '';
    const url = entry.url || '';
    // The catalogue's reference first; failing that, the one already in the
    // filename, which this repo's renamer put there from the same catalogue.
    const production = productionOf(entry.ref, seriesNumbered)
      || productionOf(refFromName(item.file), seriesNumbered);
    if (!models.length && !studio && !url && !production) { nothingToSay += 1; continue; }

    // Fill blanks only. A record that is absent entirely counts as blank.
    const patch = {};
    if (models.length && !((record && record.models) || []).length) patch.addModels = models;
    if (studio && !(record && record.studio)) patch.studio = studio;
    if (production && !(record && record.production)) {
      patch.production = production;
    } else if (FIX && production && record && record.production !== production
      // Only a value the old rule would have produced: MTVQ where the code is
      // MTVQ21. Anything else is someone's own answer and is left alone.
      && production.startsWith(record.production)) {
      patch.production = production;
      patch.wasProduction = record.production;
    }
    if (url && !(record && record.url)) patch.url = url;
    if (!Object.keys(patch).length) { intact += 1; continue; }

    work.push({
      file: item.file,
      patch,
      had: record
        ? { models: (record.models || []).length, studio: record.studio || '', url: !!record.url }
        : null,
      viaUrl: !!viaUrl,
    });
  }

  const missing = (field) => work.filter((w) => w.patch[field]).length;
  console.log(`matched on disk  : ${matched.length}`);
  console.log(`  already right  : ${intact}`);
  console.log(`  nothing to add : ${nothingToSay} (the catalogue names nobody either)`);
  if (gone.length) console.log(`  vanished       : ${gone.length} (moved since the walk)`);
  console.log(`to repair        : ${work.length}`);
  console.log(`  models         : ${missing('addModels')}`);
  console.log(`  studio         : ${missing('studio')}`);
  console.log(`  production     : ${missing('production')}`);
  const corrected = work.filter((w) => w.patch.wasProduction);
  if (corrected.length) {
    const moves = new Map();
    for (const w of corrected) {
      const move = w.patch.wasProduction + ' -> ' + w.patch.production;
      moves.set(move, (moves.get(move) || 0) + 1);
    }
    console.log(`    corrected    : ${corrected.length}`);
    for (const [move, n] of [...moves].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${move.padEnd(22)} ${n}`);
    }
  }
  console.log(`  url            : ${missing('url')}`);

  // Which codes, and how many of each — a long tail of one-offs would mean the
  // extraction rule is picking up something that is not a series.
  const codes = new Map();
  for (const w of work) {
    if (!w.patch.production) continue;
    codes.set(w.patch.production, (codes.get(w.patch.production) || 0) + 1);
  }
  if (seriesNumbered.size) {
    console.log(`  series-numbered: ${[...seriesNumbered].sort().join(', ')}`);
  }
  if (codes.size) {
    const top = [...codes].sort((a, b) => b[1] - a[1]);
    console.log(`  distinct codes : ${codes.size}`);
    console.log(`    busiest      : ${top.slice(0, 8).map(([c, n]) => c + '\u00d7' + n).join(', ')}`);
    console.log(`    one-offs     : ${top.filter(([, n]) => n === 1).length}`);
  }

  // A record that still has a rating or tags but has lost its cast is the
  // signature of the accident, as against a video that was never labelled.
  const hadSomething = work.filter((w) => w.had && (w.had.url || w.had.studio));
  console.log(`  of those, ${hadSomething.length} still hold a url or studio — labelled before, lost since`);

  if (work.length) {
    console.log('');
    console.log('First few:');
    for (const w of work.slice(0, 12)) {
      const bits = [];
      if (w.patch.addModels) bits.push(`models: ${w.patch.addModels.join(', ')}`);
      if (w.patch.studio) bits.push(`studio: ${w.patch.studio}`);
      if (w.patch.production) {
        bits.push(`production: ${w.patch.production}`
          + (w.patch.wasProduction ? ` (was ${w.patch.wasProduction})` : ''));
      }
      if (w.patch.url) bits.push('url');
      console.log(`  ${path.basename(w.file)}`);
      console.log(`    + ${bits.join(' | ')}`);
    }
    if (work.length > 12) console.log(`  … and ${work.length - 12} more`);
  }

  return work;
}

async function apply(work) {
  if (!work.length) {
    console.log('\nNothing to do.');
    return;
  }

  // The sidecar is the only copy of a year of ratings, and this run edits
  // thousands of records. A dated copy costs a megabyte.
  fs.mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUPS, `library-${stamp}.json`);
  fs.copyFileSync(SIDECAR, backup);
  console.log(`\nbackup           : ${backup}`);

  const up = await serverIsUp();
  let done = 0;
  const failed = [];

  if (up) {
    // A field the running app predates would be accepted and dropped, so check
    // before writing rather than reporting a success that changed nothing.
    const fields = new Set(work.flatMap((w) => Object.keys(w.patch)));
    for (const field of ['production', 'studio']) {
      if (!fields.has(field)) continue;
      if (await serverKnows(field)) continue;
      console.error(`The running app does not know about "${field}" — it would accept`);
      console.error('the write and drop it. Close Video Explorer and run this again,');
      console.error('or restart it on the current build first.');
      process.exit(1);
    }

    // Through the app rather than under it: while it is running it holds the
    // sidecar in memory and writes it back on its own schedule, so a tool
    // editing the file directly would be overwritten by the next rating change.
    console.log('writing through the running app');
    for (const w of work) {
      try {
        const { wasProduction, ...fields } = w.patch;
        const data = await post({ paths: [w.file], ...fields });
        const result = (data.records || {})[w.file];
        if (result && result.error) throw new Error(result.error);
        done += 1;
      } catch (err) {
        failed.push({ file: w.file, why: err.message });
      }
    }
  } else {
    console.log('the app is closed, so writing the sidecar directly');
    const library = require('../library');
    await library.init(ONEDRIVE);
    for (const w of work) {
      try {
        const { wasProduction, ...fields } = w.patch;
        library.apply(fs.statSync(w.file), path.basename(w.file), fields);
        done += 1;
      } catch (err) {
        failed.push({ file: w.file, why: err.message });
      }
    }
    await library.flush();
  }

  console.log(`repaired         : ${done}`);
  if (failed.length) {
    console.log(`failed           : ${failed.length}`);
    for (const f of failed.slice(0, 10)) console.log(`  ${path.basename(f.file)} — ${f.why}`);
  }
}

const work = main();
if (!APPLY) {
  console.log('\nDry run. Nothing was changed. Add --apply to fill these in.');
} else {
  apply(work).catch((err) => { console.error(err); process.exit(1); });
}
