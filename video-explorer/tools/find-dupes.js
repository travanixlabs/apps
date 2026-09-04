/**
 * Fingerprint every downloaded video and report which are the same video twice.
 *
 *   node tools/find-dupes.js                 fingerprint what is missing, then match
 *   node tools/find-dupes.js --match-only    skip straight to matching
 *   node tools/find-dupes.js --limit 200     stop after 200 new fingerprints
 *
 * Safe to interrupt and safe to re-run: each fingerprint is written as it is
 * made, so a second run picks up where the first stopped. Nothing is deleted,
 * moved or modified -- the output is a list for a person to act on.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const dupes = require('../dupes');

const CONFIG_FILE = process.env.VIDEO_EXPLORER_CONFIG
  || path.join(__dirname, '..', 'config.json');
// The same place the server keeps it: alongside the face store in the OneDrive
// sidecar, so a fingerprint outlives a machine and is never made twice.
const SIDECAR = process.env.VIDEO_EXPLORER_CACHE
  || path.join(process.env.OneDrive || path.join(os.homedir(), 'OneDrive'), '.video-explorer');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const LIMIT = Number(value('--limit', Infinity));
const WORKERS = Number(value('--workers', Math.max(2, Math.min(6, (os.cpus().length || 4) - 2))));

const bytes = (n) => (n / 1e9 >= 1 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  dupes.init({ cacheDir: SIDECAR, roots: config.roots || [], home: config.homeDir || null });
  await dupes.loadIndex();

  if (!flag('--match-only')) {
    const work = await dupes.walkForWork();
    const outstanding = work.filter((w) => !dupes.has(w.key));
    const todo = outstanding.slice(0, LIMIT);
    console.log(`${work.length} downloaded videos, ${work.length - outstanding.length} already done, `
      + `${outstanding.length} outstanding`
      + (todo.length < outstanding.length ? ` (taking ${todo.length} this run)` : '')
      + `, ${WORKERS} at a time\n`);

    const started = Date.now();
    let done = 0;
    let failed = 0;
    // A pool rather than a queue of promises: this runs for hours and the
    // memory of ten thousand pending closures is not worth carrying.
    const next = async () => {
      while (todo.length) {
        const job = todo.shift();
        try {
          await dupes.profile(job.file, job.stat);
        } catch (err) {
          failed += 1;
          console.log(`  ! ${path.basename(job.file)}: ${err.message.slice(0, 80)}`);
        }
        done += 1;
        if (done % 25 === 0 || !todo.length) {
          const per = (Date.now() - started) / done / 1000;
          const left = todo.length * per;
          process.stdout.write(`\r  ${done} fingerprinted, ${todo.length} to go, `
            + `${per.toFixed(1)}s each, about ${clock(left)} left      `);
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, next));
    console.log(`\n\nfingerprinted ${done} in ${clock((Date.now() - started) / 1000)}`
      + `${failed ? `, ${failed} failed` : ''}\n`);
  }

  const { confirmed, possible } = await dupes.match({
    onProgress: (at, total) => process.stdout.write(`\r  compared ${at} of ${total}      `),
  });
  process.stdout.write('\r');
  const digest = await dupes.writeDigest(confirmed, possible);
  console.log(`\ndigest written to ${path.join(SIDECAR, 'dupes', 'duplicates.json')}\n`);

  // ---- the review list
  const sizeOf = (key) => Number(String(key).split(':')[0]) || 0;
  let recoverable = 0;

  if (!digest.groups.length) console.log('no duplicates found\n');
  else console.log(`==== ${digest.groups.length} duplicate groups ====\n`);

  const groups = digest.groups.slice().sort((a, b) =>
    sizeOf(b[0].key) - sizeOf(a[0].key));
  for (const group of groups) {
    const keep = group.slice().sort((x, y) => sizeOf(y.key) - sizeOf(x.key))[0];
    recoverable += group.reduce((s, g) => s + sizeOf(g.key), 0) - sizeOf(keep.key);
    const pair = confirmed.find((c) => group.some((g) => g.key === c.a)
      && group.some((g) => g.key === c.b));
    console.log(`  ${group.length} copies`
      + (pair ? `   sound ${pair.sound ? pair.sound.r : '-'}`
        + ` · picture ${pair.picture ? pair.picture.bits : '-'} bits`
        + ` · cuts ${pair.cuts.run}/${pair.cuts.of}`
        + ` · offset ${pair.offset}s` : ''));
    for (const g of group) {
      console.log(`      ${bytes(sizeOf(g.key)).padStart(8)}  ${clock(g.secs).padStart(6)}  ${g.name}`);
    }
    console.log('');
  }
  if (recoverable) console.log(`${bytes(recoverable)} recoverable by keeping one of each\n`);

  if (possible.length) {
    console.log(`==== ${possible.length} that only one signal liked -- worth an eye ====\n`);
    for (const p of possible.slice(0, 40)) {
      console.log(`  ${p.verdict}  sound ${p.sound ? p.sound.r : '-'}`
        + ` · picture ${p.picture ? p.picture.bits : '-'} bits`
        + ` · cuts ${p.cuts.run}/${p.cuts.of}`);
      console.log(`      ${p.aName}`);
      console.log(`      ${p.bName}`);
    }
    if (possible.length > 40) console.log(`  ... and ${possible.length - 40} more\n`);
  }

  console.log(JSON.stringify(dupes.status()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
