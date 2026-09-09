/* Reads and fingerprints the library from outside the app.
 *
 *   node tools/sweep.js                   three profilers, one of each other
 *   node tools/sweep.js --faces 6         more profilers
 *   node tools/sweep.js --prints 3        more fingerprinters
 *   node tools/sweep.js --strips 2        more strip builders
 *   node tools/sweep.js --only dupes      one sweep only
 *   node tools/sweep.js --only dupes,frames   or two of them
 *   node tools/sweep.js --dry             say what is outstanding, read nothing
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
const framing = require(path.join(APP, 'framing.js'));
const strips = require(path.join(APP, 'strips.js'));

const PORT = Number(process.env.VIDEO_EXPLORER_PORT || 4321);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const FACE_WORKERS = Math.max(1, Number(flag('faces', 3)));
const PRINT_WORKERS = Math.max(1, Number(flag('prints', 1)));
const STRIP_WORKERS = Math.max(1, Number(flag('strips', 1)));
// A list, so "--only dupes,frames" can be asked for. Empty means all three.
const ONLY = new Set(String(flag('only', '')).split(',').map((w) => w.trim()).filter(Boolean));
const wanted = (name) => ONLY.size === 0 || ONLY.has(name);
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

  // Only what this run will actually use. The face store is a few hundred
  // megabytes and the fingerprint index is thousands of files, so a run asked
  // for one sweep should not pay to open the other two -- which matters when a
  // second copy of this tool is working alongside the first.
  //
  // init only, either way. start() would set the app's own one-at-a-time loops
  // going and they would race the pools below for the same queue.
  const face = wanted('faces')
    ? faces.init({ cacheDir: path.join(store, 'faces'), library, roots, home: () => home })
    : { ok: false, reason: 'not asked for' };
  if (wanted('faces')) {
    if (!face.ok) say(`profiling: unavailable (${face.reason})`);
    else say(`profiling: ${face.model}`);
  }

  if (wanted('dupes')) {
    dupes.init({ cacheDir: store, roots, home: () => home });
    await dupes.loadDigest();
    await dupes.loadIndex();
  }

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

  const doFaces = face.ok && wanted('faces');
  const doPrints = wanted('dupes');
  const doStrips = wanted('frames') || wanted('strips');

  // The strip sweep's own module owns the walk and the counting; it is handed
  // the same two things the server hands it, pointed at the cache on disk.
  const cacheDir = path.join(store, 'cache');
  if (doStrips) {
    framing.init({
      build: (file, stat) => strips.build(cacheDir, file, stat, config),
      hasStrip: (file, stat) => strips.has(cacheDir, file, stat, config),
      roots,
      home: () => home,
    });
  }

  const faceQueue = doFaces ? await faces.__queueForTest() : [];
  const printQueue = doPrints
    ? (await dupes.walkForWork()).filter((w) => !dupes.has(w.key))
    : [];
  const stripQueue = doStrips ? await framing.walkForWork() : [];

  say(`to profile    : ${faceQueue.length}`);
  say(`to fingerprint: ${printQueue.length}`);
  say(`to frame      : ${stripQueue.length}`);

  if (DRY) { say('dry run, nothing read'); return; }
  if (!faceQueue.length && !printQueue.length && !stripQueue.length) {
    say('nothing outstanding');
    return;
  }

  const began = Date.now();
  const count = { faces: 0, faceFail: 0, prints: 0, printFail: 0, strips: 0, stripFail: 0 };
  const faceTotal = faceQueue.length;
  const printTotal = printQueue.length;
  const stripTotal = stripQueue.length;

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
      + (stripTotal ? `   framed ${count.strips}/${stripTotal}` : '')
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

  const runStrips = pool(STRIP_WORKERS, stripQueue, async (item) => {
    if (halt) return;
    try {
      await strips.build(cacheDir, item.file, item.stat, config);
      count.strips += 1;
    } catch { count.stripFail += 1; }
  }, progress).then((stop) => stoppers.push(stop));

  say('reading with '
    + [
      doFaces && faceTotal ? `${FACE_WORKERS} profiler(s)` : '',
      doPrints && printTotal ? `${PRINT_WORKERS} fingerprinter(s)` : '',
      doStrips && stripTotal ? `${STRIP_WORKERS} framer(s)` : '',
    ].filter(Boolean).join(', '));
  await Promise.all([runFaces, runPrints, runStrips]);
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
  // Counted from what was asked for versus what was done, NOT from the queues:
  // standing down drains them as no-ops, so a halted run reported "0 left" when
  // it had skipped hundreds.
  const faceLeft = faceTotal - count.faces - count.faceFail;
  const printLeft = printTotal - count.prints - count.printFail;
  const stripLeft = stripTotal - count.strips - count.stripFail;
  say(`  framed       ${count.strips}${count.stripFail ? `  (${count.stripFail} failed)` : ''}`);
  say(`  left to do   ${faceLeft} profiles, ${printLeft} fingerprints, ${stripLeft} strips`
    + (halt ? '  (stood down early -- run again to finish)' : ''));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
