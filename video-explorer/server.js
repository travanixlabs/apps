'use strict';

// Before anything touches the filesystem: Node's four-thread pool serves
// every stat, readdir, readFile and gzip -- and ONNX inference sits on the
// same threads. A face sweep's model runs were queueing a 27,000-file walk
// behind them (2s alone, 18s under a sweep). Eight gives the walk a lane.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '8';

/**
 * Video Explorer — local hover-preview file browser for MP4 libraries.
 * One npm dependency (onnxruntime-node, for familiar faces) + ffmpeg/ffprobe on PATH.
 * Binds to loopback only.
 *
 * This file is the entry point: startup, the store loading behind the open
 * port, and the process's signal handlers. The rest lives in server/, one file
 * per concern -- util (log, limiters, child processes), config (settings,
 * roots, and the one shared `state`), cloud (Graph), files (walks, placeholders,
 * the Recycle Bin), cache (previews, metadata), walk (listings), fileops (embed,
 * carry-over, move/copy/rename/delete), http (plumbing) and routes (the API).
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const library = require('./library');
const faces = require('./faces');
const dupes = require('./dupes');
const framing = require('./framing');

const {
  pruneLogs, log, logFailure, exists, run,
} = require('./server/util');
const {
  defaultCacheDir, HOST, PORT, writeColours, loadConfig,
  applyHomeDir, pruneRoots, onRootsChanged, state,
} = require('./server/config');
const {
  flushMeta, cacheName, spriteSalt, countStrips, adoptLegacyCache,
  writeCacheManifest, ensureSprite, cachedStripNames, migrateCacheNames,
  tidyCache, loadMetaIndex, removeStaleTemps,
} = require('./server/cache');
const { carryOver } = require('./server/fileops');
const { server, flushAll, setCoreReady } = require('./server/routes');

/**
 * Chrome/Edge "--app=" opens a plain window: no tabs, no address bar, its own
 * taskbar button. Closest thing to a native window without bundling a browser.
 */
function findBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  return candidates.find((exe) => exe && fs.existsSync(exe)) || null;
}

function openWindow(url) {
  const browser = process.env.APP_WINDOW === '0' ? null : findBrowser();
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1500,950'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  // No Chromium browser found: fall back to whatever handles http.
  spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function checkFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await run(bin, ['-version']);
    } catch (err) {
      const reason = `"${bin}" could not be started (${err && err.code ? err.code : err}). `
        + 'Install it with:  winget install Gyan.FFmpeg  -- then restart the app.';
      log(`WARNING: ${reason}`);
      log('  No previews will be made and the three sweeps will not run until then.');
      state.ffmpeg = { ok: false, reason };
      return false;
    }
  }
  state.ffmpeg = { ok: true, reason: '' };
  return true;
}

async function main() {
  pruneLogs();
  // Where a launch spends its time, on the record: every step below says when
  // it finished, so a slow start names its own culprit.
  const booted = Date.now();
  const mark = (what) => log(`boot +${Date.now() - booted}ms: ${what}`);
  await fsp.mkdir(state.CACHE_DIR, { recursive: true });
  // A file that will not parse is copied aside and said out loud, never
  // silently replaced by the defaults -- see loadConfig.
  loadConfig();
  // Opening a folder outside everything swept so far widens each sweep's
  // denominator; the sweeps hear about it here rather than being required by
  // the config module.
  onRootsChanged(() => { faces.rootsChanged(); dupes.rootsChanged(); framing.rootsChanged(); });
  // Flattening is a view you reach for, not a mode you live in: reopening the
  // app into 5,682 videos from one folder is jarring, so it starts off.
  state.config.recursive = false;
  // Same for the ordering: every launch starts on your own judgement, highest
  // first, with the unrated bulk below it. A session can sort however it likes
  // and that choice is still written down -- it just does not decide what you
  // see when you next open the app.
  state.config.sort = 'rating';
  state.config.sortDir = 'desc';
  await applyHomeDir();
  // Before anything is served: the authorised list is the answer to "what can
  // this app read", and it should be as short as the truth allows.
  await pruneRoots();
  // The home folder is only known after the account resolves, and everything
  // cached hangs off it.
  state.CACHE_DIR = defaultCacheDir(state.ONEDRIVE_ROOT);
  state.META_FILE = path.join(state.CACHE_DIR, 'meta.json');

  await fsp.mkdir(state.CACHE_DIR, { recursive: true });
  mark('home resolved, roots pruned');

  // The port opens HERE, before a single store is read. The window used to
  // wait on all of them -- the labels, a megabyte of metadata parsed
  // synchronously, the face engine, two ffmpeg version checks -- which was
  // most of the ten seconds between double-click and anything appearing.
  // Requests that need the stores park on coreReady instead.
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    mark(`ready at ${url}`);
    log(`cache: ${state.CACHE_DIR}`);
    if (!process.env.NO_OPEN) openWindow(url);
  });

  const booting = loadCore(mark);
  setCoreReady(booting);
  // Marked handled so a store failure surfaces per-request rather than as an
  // unhandled rejection; the requests awaiting it still see the error.
  booting.catch((err) => log('BOOT FAILED loading stores:', err.message));
}

/** Everything the API needs read before it answers. Behind the open port. */
async function loadCore(mark) {
  const lib = await library.init(state.ONEDRIVE_ROOT);
  mark(`labels: ${lib.count} records at ${lib.file}`);
  // The phone, or this library open on another PC, writes the same file.
  // Its edits are taken in while this one sits idle; a write of ours merges
  // them anyway.
  setInterval(() => {
    library.refreshFromDisk()
      .then((changed) => { if (changed) faces.rebuildSoon(); })
      .catch(() => {});
  }, 30000).unref();
  // An unreadable sidecar is the one startup condition worth shouting about:
  // everything still works except the thing you would not notice was broken.
  if (lib.readOnly) log(`LABELS READ-ONLY: ${lib.readOnly} — edits refused until this reads`);

  // Familiar faces is optional by construction: without onnxruntime or the
  // models it reports why and the rest of the app is untouched.
  // The geometry behind the cache names, for anything reading them from the
  // sync root rather than from here.
  await writeCacheManifest();
  await writeColours();

  // Before any sweep is let loose. Without ffmpeg every read came back
  // empty, and empty was written down as the answer -- a faceless, silent
  // film -- for every video, into the stores every machine shares.
  const ffmpegOk = await checkFfmpeg();
  mark(ffmpegOk ? 'ffmpeg found' : 'ffmpeg MISSING -- sweeps held');

  const face = faces.init({
    cacheDir: path.join(path.dirname(state.CACHE_DIR), 'faces'),
    library,
    // The home folder counts even when nothing has been opened yet: a fresh
    // install has an empty `roots`, and a sweep over nothing would report a
    // library of nothing.
    roots: () => [...state.config.roots, state.config.homeDir].filter(Boolean),
    // A folder opened above the library -- C:\Users\User, say -- authorises
    // reading but must not widen the sweep to the whole profile.
    home: () => state.config.homeDir || state.ONEDRIVE_ROOT || '',
  });
  mark('face engine up');
  if (face.ok) {
    // The store is read in the background, so the count here is what had landed
    // by now rather than what is there -- say where it is instead.
    log(`familiar faces: ${face.model}, store at `
      + `${path.join(path.dirname(state.CACHE_DIR), 'faces')}`);
    log(`familiar faces: models at ${face.modelDir}`);
    // Started at every launch; the pill pauses it. The worker itself waits
    // for the store to finish loading before it queues anything.
    if (ffmpegOk) {
      faces.setEnabled(true);
      log('familiar faces: sweeping (the pill pauses it)');
    } else {
      log('familiar faces: not started -- ffmpeg is missing');
    }
  } else {
    log(`familiar faces: off (${face.reason})`);
  }
  // Duplicates sit beside the face store for the same reason: a fingerprint is
  // expensive to make and worth keeping. Only downloaded files are ever
  // fingerprinted -- see dupes.js -- so this is silent on a library that lives
  // entirely in the cloud.
  dupes.init({
    cacheDir: path.dirname(state.CACHE_DIR),
    roots: () => [...state.config.roots, state.config.homeDir].filter(Boolean),
    home: () => state.config.homeDir || state.ONEDRIVE_ROOT || '',
  });
  // The digest first and on its own: it is one small file and it is all a
  // listing needs, where reading every fingerprint is thousands of files.
  // Fingerprinting starts at every launch, once the index is read; the pill
  // pauses it.
  dupes.loadDigest()
    .then(() => dupes.loadIndex())
    .then(() => {
      if (!ffmpegOk) { log('duplicates: not started -- ffmpeg is missing'); return; }
      dupes.setEnabled(true);
      log('duplicates: sweeping (the pill pauses it)');
    })
    .catch(() => { });

  // The third sweep. It owns no store of its own -- a strip lives in the
  // preview cache like any other -- so all it needs is the way in.
  framing.init({
    // background: nobody is waiting on these, so they must not make the other
    // two sweeps stand aside.
    build: (file, stat) => ensureSprite(file, stat, { background: true }),
    hasStrip: async (file, stat) => {
      // One lookup in the folder's names, which the scan holds anyway, rather
      // than one or two filesystem round trips per downloaded video.
      const names = await cachedStripNames();
      if (names.has(cacheName(stat, spriteSalt()))) return true;
      // Missing under its own name. Before the tidy has run it may still be
      // under the old one, so ask through adoptLegacyCache, which moves it
      // across -- otherwise every pre-rename strip would count as missing and
      // get rebuilt. After the tidy there are no old names left to find.
      if (state.config.cacheTidyV3) return false;
      const at = await adoptLegacyCache(file, stat, 'sprite');
      return exists(at);
    },
    countCached: countStrips,
    roots: () => [...state.config.roots, state.config.homeDir].filter(Boolean),
    home: () => state.config.homeDir || state.ONEDRIVE_ROOT || '',
  });
  if (ffmpegOk) {
    framing.setEnabled(true);
    log('framing: sweeping (the pill pauses it)');
  } else {
    log('framing: not started -- ffmpeg is missing');
  }

  // A video that came back under a new modified time keeps what was known
  // about it: shortly after launch, then every ten minutes.
  const carry = () => carryOver().catch((err) => log(`carry-over: ${err.message}`));
  setTimeout(carry, 90000).unref?.();
  setInterval(carry, 10 * 60000).unref?.();

  const metaCount = await loadMetaIndex();
  mark(`${metaCount} cached metadata entries -- core ready`);

  // Housekeeping, behind everything: nothing waits on any of it.
  setTimeout(() => { migrateCacheNames().catch(() => {}); }, 3000);
  // After the rename pass has had its turn, and well behind everything a
  // person is waiting on: this walks the roots once and then never again.
  setTimeout(() => { tidyCache().catch((err) => log('cache tidy failed:', err.message)); }, 8000);
  // Folders a killed strip build left behind.
  setTimeout(() => { removeStaleTemps().catch(() => {}); }, 12000);

  /**
   * Count the library up front, so a pill knows its own numbers before it is
   * switched on.
   *
   * The walk that fills in "142 of 3,908" only ever happened inside a sweep, so
   * a paused pill showed 0 -- which reads as nothing to do rather than nothing
   * counted -- and switching one on meant waiting through a walk of 28,000
   * files before the first video was touched. Counting here fixes both: the
   * numbers are honest on arrival, and because a count sets the same walk timer
   * the sweep consults, starting a pill afterwards goes straight to reading.
   *
   * One after another, not all three at once. Each is a stat of every video in
   * the library, and running them together would only make each one slower.
   * Each also declines if a walk is already in flight, so this cannot collide
   * with a sweep somebody starts while it is still going.
   */
  setTimeout(() => {
    (async () => {
      await faces.count();
      await dupes.count();
      await framing.count();
      const said = [
        `faces ${faces.status().remaining}`,
        `fingerprints ${dupes.status().remaining}`,
        `frames ${framing.status().remaining}`,
      ].join(', ');
      log(`counted the library: ${said} outstanding`);
    })().catch(() => { /* a count is not worth failing a launch over */ });
  }, 4000);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use. Start with a different one:  set PORT=4400 && node server.js`);
    process.exit(1);
  }
  // Anything else is logged, not thrown: a throw here takes the whole app down
  // over something a single connection did.
  logFailure('server error:', err);
});

/**
 * The last line of defence: logged, with the stack, and the server keeps
 * serving.
 *
 * Without these one stray throw in a timer or one forgotten .catch() ended the
 * process -- the window went blank, and with no console the reason went with
 * it. Carrying on after an uncaught exception is not guaranteed to be safe in
 * general, but everything durable here is written whole through a rename, and
 * an app that stays up and says what went wrong is a better failure than one
 * that silently vanishes mid-sweep.
 */
process.on('uncaughtException', (err) => logFailure('UNCAUGHT', err));
process.on('unhandledRejection', (reason) => logFailure('UNHANDLED REJECTION', reason));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await flushAll();
    process.exit(0);
  });
}
// Only what can be done synchronously: the metadata index. The face store
// and the labels are async writes, which 'exit' cannot wait for -- they land
// on their own timers while the app runs (see faces.js, library.js) and in
// the /api/shutdown flush the host waits on.
process.on('exit', () => { flushMeta(); });

main();
