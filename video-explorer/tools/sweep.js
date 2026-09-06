/* Reads and fingerprints the library from outside the app.
 *
 *   node tools/sweep.js              three profilers, one fingerprinter
 *   node tools/sweep.js --faces 6    more profilers
 *   node tools/sweep.js --only faces
 *   node tools/sweep.js --dry        say what is outstanding, read nothing
 *
 * The app does this too, but politely: one video at a time on each sweep,
 * because it is a background job competing with somebody browsing. With the app
 * closed there is nobody to be polite to, so this runs the same engines harder
 * -- three harvests at once, since profiling spends most of its time waiting on
 * ffmpeg, and one fingerprint at a time, since that is a long sequential read
 * and three at once on one drive trade streaming for seeking.
 *
 * IT MUST NOT RUN WHILE THE APP IS OPEN. Both write the same stores, and two
 * writers on one file is how a library gets lost. It checks the port and
 * refuses, and keeps checking while it works: open the app mid-run and it stops
 * on its own rather than racing you.
 *
 * Nothing here touches library.json. Ratings, tags and cast are the app's to
 * write; this only reads them, to know whose face is whose.
 *
 * Stopping is free. Every profile and every fingerprint is written as it is
 * made, so Ctrl-C loses at most the few in flight, and running it again picks up
 * where this left off.
 */
const path = require('path');
const http = require('http');
const fsp = require('fs/promises');

const APP = path.join(__dirname, '..');
const library = require(path.join(APP, 'library.js'));
const faces = require(path.join(APP, 'faces.js'));
const dupes = require(path.join(APP, 'dupes.js'));

const PORT = Number(process.env.VIDEO_EXPLORER_PORT || 4321);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const FACE_WORKERS = Math.max(1, Number(flag('faces', 3)));
const PRINT_WORKERS = Math.max(1, Number(flag('prints', 1)));
const ONLY = flag('only', '');
const DRY = argv.includes('--dry');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toTimeString().slice(0, 8);
const say = (line) => console.log(`${now()}  ${line}`);

/** Is the app listening? Two writers on one store is the thing to avoid. */
function appIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/config', timeout: 2000 },
      (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * A pool of `size` workers over one queue.
 *
 * The queue is consumed in order -- faces.js sorts it so credited videos come
 * first, round-robin across performers, and taking the next N off the front
 * keeps that ordering intact where taking N at random would not.
 */
async function pool(size, queue, each, onDone) {
  const running = new Set();
  let stopped = false;
  const stop = () => { stopped = true; };

  while (!stopped && (queue.length || running.size)) {
    while (!stopped && running.size < size && queue.length) {
      const item = queue.shift();
      const job = (async () => {
        try { await each(item); } catch { /* counted by the caller */ }
      })();
      running.add(job);
      job.finally(() => running.delete(job)).catch(() => {});
    }
    if (!running.size) break;
    await Promise.race(running);
    if (onDone) onDone();
  }
  await Promise.allSettled([...running]);
  return stop;
}

async function main() {
  if (await appIsUp()) {
    console.error(`Video Explorer is running on ${PORT}. Close it first -- it holds the`);
    console.error('same face and fingerprint stores, and two writers on one store is how');
    console.error('a library gets lost.');
    process.exit(1);
  }

  const configFile = process.env.VIDEO_EXPLORER_CONFIG
    || path.join(process.env.APPDATA || '', 'Video Explorer', 'config.json');
  let config = {};
  try { config = JSON.parse(await fsp.readFile(configFile, 'utf8')); } catch { /* defaults */ }
  const home = config.homeDir || process.env.OneDrive || '';
  if (!home) throw new Error('No home folder in config and no OneDrive in the environment.');

  const store = path.join(home, '.video-explorer');
  const roots = () => [...(config.roots || []), home].filter(Boolean);

  say(`home     : ${home}`);
  say(`store    : ${store}`);

  const lib = await library.init(home);
  say(`library  : ${lib.count} records${lib.readOnly ? `  READ-ONLY: ${lib.readOnly}` : ''}`);

  // init only. start() would set the app's own one-at-a-time loops going and
  // they would race the pools below for the same queue.
  const face = faces.init({
    cacheDir: path.join(store, 'faces'),
    library,
    roots,
    home: () => home,
  });
  if (!face.ok) say(`profiling: unavailable (${face.reason})`);
  else say(`profiling: ${face.model}`);

  dupes.init({ cacheDir: store, roots, home: () => home });
  await dupes.loadDigest();
  await dupes.loadIndex();

  // The face store is read in the background and a video whose profile has not
  // loaded yet looks unread -- queueing before it lands reads everything twice.
  if (face.ok) {
    process.stdout.write(`${now()}  waiting for the face store to load`);
    while (faces.status().doing === 'loading') {
      process.stdout.write('.');
      await wait(500);
    }
    process.stdout.write('\n');
  }

  const doFaces = face.ok && ONLY !== 'dupes';
  const doPrints = ONLY !== 'faces';

  const faceQueue = doFaces ? await faces.__queueForTest() : [];
  const printQueue = doPrints
    ? (await dupes.walkForWork()).filter((w) => !dupes.has(w.key))
    : [];

  say(`to profile    : ${faceQueue.length}`);
  say(`to fingerprint: ${printQueue.length}`);

  if (DRY) { say('dry run, nothing read'); return; }
  if (!faceQueue.length && !printQueue.length) { say('nothing outstanding'); return; }

  const began = Date.now();
  const count = { faces: 0, faceFail: 0, prints: 0, printFail: 0 };
  const faceTotal = faceQueue.length;
  const printTotal = printQueue.length;

  let halt = false;
  const stoppers = [];
  const quit = (why) => {
    if (halt) return;
    halt = true;
    say(why);
    for (const s of stoppers) s();
  };
  process.on('SIGINT', () => quit('stopping -- finishing what is in flight'));

  // If the app opens while this runs, stand down rather than race it.
  const watch = setInterval(async () => {
    if (!halt && await appIsUp()) quit('the app has opened -- standing down');
  }, 5000);

  let lastSaid = 0;
  const progress = () => {
    if (Date.now() - lastSaid < 15000) return;
    lastSaid = Date.now();
    const mins = (Date.now() - began) / 60000;
    const rate = mins > 0.2 ? Math.round((count.faces / mins) * 60) : 0;
    say(`profiled ${count.faces}/${faceTotal}`
      + `   fingerprinted ${count.prints}/${printTotal}`
      + (rate ? `   ${rate} profiles/hr` : ''));
  };

  const runFaces = pool(FACE_WORKERS, faceQueue, async (item) => {
    if (halt) return;
    try {
      await faces.profile(item.file, item.stat, { force: item.redo });
      count.faces += 1;
    } catch { count.faceFail += 1; }
  }, progress).then((stop) => stoppers.push(stop));

  const runPrints = pool(PRINT_WORKERS, printQueue, async (item) => {
    if (halt) return;
    try {
      await dupes.profile(item.file, item.stat);
      count.prints += 1;
    } catch { count.printFail += 1; }
  }, progress).then((stop) => stoppers.push(stop));

  say(`reading with ${FACE_WORKERS} profiler(s) and ${PRINT_WORKERS} fingerprinter(s)`);
  await Promise.all([runFaces, runPrints]);
  clearInterval(watch);

  // Scoring is the loop's job in the app, and it was not running. One rebuild
  // at the end rather than one per video: it clears every centroid, walks every
  // profile and re-scores the library, so doing it once is the whole point.
  if (count.faces) {
    say('rebuilding the averages and re-scoring');
    faces.rebuild();
    await faces.flush();
  }
  if (count.prints) {
    say('matching the new fingerprints');
    await dupes.refresh();
  }

  const mins = Math.round((Date.now() - began) / 60000);
  say(`done in ${mins}m`);
  say(`  profiled     ${count.faces}${count.faceFail ? `  (${count.faceFail} failed)` : ''}`);
  say(`  fingerprinted ${count.prints}${count.printFail ? `  (${count.printFail} failed)` : ''}`);
  say(`  left to do   ${faceQueue.length} profiles, ${printQueue.length} fingerprints`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
