'use strict';

/**
 * Puts back models, studio and source url that the catalogue knows and the
 * sidecar has lost.
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
const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const SIDECAR = process.env.VIDEO_EXPLORER_LIBRARY
  || path.join(ONEDRIVE, '.video-explorer', 'library.json');
const BACKUPS = path.join(path.dirname(SIDECAR), 'backups');
const PORT = 4321;

/** `size:mtime`, the sidecar's key — it survives a rename, which is the point. */
const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 600 },
      (res) => { res.resume(); resolve(true); });
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
  const { matched } = build();
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
    if (!models.length && !studio && !url) { nothingToSay += 1; continue; }

    // Fill blanks only. A record that is absent entirely counts as blank.
    const patch = {};
    if (models.length && !((record && record.models) || []).length) patch.addModels = models;
    if (studio && !(record && record.studio)) patch.studio = studio;
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
  console.log(`  url            : ${missing('url')}`);

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
    // Through the app rather than under it: while it is running it holds the
    // sidecar in memory and writes it back on its own schedule, so a tool
    // editing the file directly would be overwritten by the next rating change.
    console.log('writing through the running app');
    for (const w of work) {
      try {
        const data = await post({ paths: [w.file], ...w.patch });
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
        library.apply(fs.statSync(w.file), path.basename(w.file), w.patch);
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
