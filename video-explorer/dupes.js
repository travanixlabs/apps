/**
 * Which videos in the library are the same video twice.
 *
 * Built in the shape of the face profiler next door, for the same reasons: a
 * long job that must never block a request, a per-video sidecar keyed so it
 * survives a rename or a move, and a digest the page can read in one go.
 *
 * Downloaded files only. A cloud placeholder cannot be fingerprinted without
 * pulling it down, and pulling 24,000 of them down to compare them is not a
 * trade worth making -- so a placeholder is skipped exactly as the face
 * profiler skips it, and picked up on its own if it ever lands on the disk.
 *
 * Two stages, because comparing every video with every other is 7.4 million
 * pairs and each comparison is real work:
 *
 *   1. the shot-change rhythm proposes candidates. The gaps between cuts are
 *      immune to trimming, so three consecutive gaps make a lookup key that
 *      finds a copy however much leader it carries. Cheap, and it costs 130
 *      bytes a video to keep the whole index in memory.
 *   2. sound and picture settle it, one pair at a time -- see dupe-engine.
 *
 * The expensive part of a fingerprint stays on disk. Only the gap list, the
 * runtime and the name live in memory, which is why an index over thousands of
 * videos costs under a megabyte rather than the 150MB the full prints would.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const engine = require('./dupe-engine');

const log = (msg) => console.log(`[video-explorer] duplicates: ${msg}`);

const VERSION = 1;

/** Consecutive gaps per lookup key. Three is specific enough to be rare. */
const NGRAM = 3;
/** Gap values are bucketed this coarsely for the key, so near-misses collide. */
const GAP_BUCKET = 0.2;
/** A video with fewer cuts than this cannot be indexed by rhythm alone. */
const MIN_CUTS_TO_INDEX = NGRAM + 1;
/** Fallback for those: anything within this many seconds of the same runtime. */
const RUNTIME_BUCKET = 30;

const state = {
  dir: null,               // where fingerprints live
  rootsOf: () => [],
  homeOf: () => '',
  ready: false,
  light: new Map(),        // key -> { gaps, secs, cuts, name }
  groups: [],              // arrays of keys, each a set of the same video
  pairs: [],               // every pair a signal spoke for, with which one
  possible: [],            // kept for the digest's shape
  byKey: new Map(),        // key -> index into groups
  kindsByKey: new Map(),   // key -> { sound, picture, both }
  scanned: 0,
  matched: 0,
  // The in-app worker: one video at a time, only while nothing else is
  // happening. See the loop at the bottom of this file.
  enabled: true,
  running: false,
  walking: false,
  matching: false,
  queue: [],
  current: '',
  failures: new Set(),
  lastActivity: 0,
  nextWalk: 0,
  startedAt: 0,
  done: 0,
  sinceMatch: 0,
  needsMatch: false,
  lastMatch: 0,
  pathByKey: new Map(),   // key -> where the walk last saw it
  downloaded: 0,
  counted: false,
};

const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;
const fileNameFor = (key) => `${key.replace(':', '_')}.json`;
const keyFromFileName = (name) => name.replace(/\.json$/, '').replace('_', ':');

const ENTRIES = 'v';
const DIGEST = 'duplicates.json';

function init({ cacheDir, roots = [], home = null }) {
  state.dir = path.join(cacheDir, 'dupes');
  // Either a list or a function returning one. The server's roots grow as
  // folders are opened, so it passes functions and this must not snapshot them.
  state.rootsOf = typeof roots === 'function' ? roots : () => roots;
  state.homeOf = typeof home === 'function' ? home : () => home;
  fs.mkdirSync(path.join(state.dir, ENTRIES), { recursive: true });
  return state.dir;
}

/**
 * Re-adopt the last matching run without redoing it.
 *
 * Matching is minutes of work over thousands of fingerprints; the answer it
 * reached is already written down, and a listing only needs to know which
 * videos were in a group.
 */
async function loadDigest() {
  try {
    const body = JSON.parse(await fsp.readFile(path.join(state.dir, DIGEST), 'utf8'));
    // A group of one is not a group. A digest written before its last pair was
    // broken up can hold one, and it would flag a video as a copy of nothing.
    state.groups = (body.groups || [])
      .filter((group) => group.length > 1)
      .map((group) => group.map((g) => g.key));
    state.pairs = body.confirmed || [];
    state.matched = state.pairs.filter((p) => p.signals && p.signals.both).length;
    state.byKey = new Map();
    state.kindsByKey = new Map();
    state.groups.forEach((group, i) => group.forEach((k) => state.byKey.set(k, i)));
    for (const group of body.groups || []) {
      if (group.length < 2) continue;
      for (const g of group) {
        if (g.kinds) state.kindsByKey.set(g.key, g.kinds);
      }
    }
    // The names in the digest cover videos whose fingerprints have not been
    // read yet, so a review list works the moment the server is up.
    for (const group of body.groups || []) {
      for (const g of group) {
        if (!state.light.has(g.key)) {
          state.light.set(g.key, { gaps: [], secs: g.secs || 0, cuts: 0, name: g.name || '' });
        }
      }
    }
    // A digest from before the signals were recorded says nothing about WHICH
    // of sound and picture agreed, so the three filters would all come back
    // empty and every set would read "one signal only". Matching again is the
    // only way to fill that in, and it must not wait for the next batch of
    // twenty-five reads to trigger it.
    state.needsMatch = (body.confirmed || []).some((r) => !r.signals)
      || state.groups.some((g) => g.some((k) => !state.kindsByKey.has(k)));
    log(`${state.groups.length} duplicate groups from the last run`
      + (state.needsMatch ? ' (needs matching again: no signals recorded)' : ''));
    return body;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ storage

async function loadIndex() {
  const dir = path.join(state.dir, ENTRIES);
  let names = [];
  // An unreadable folder still counts as read: leaving `ready` false would
  // park the worker in "loading" for the life of the process.
  try { names = await fsp.readdir(dir); } catch { state.ready = true; return; }
  let loaded = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      state.light.set(keyFromFileName(name), {
        gaps: row.gaps || [],
        secs: row.secs || 0,
        cuts: row.cuts || 0,
        name: row.name || '',
        path: row.path || '',
      });
      loaded += 1;
    } catch { /* a half-written file from a hard kill: it will be redone */ }
  }
  state.ready = true;
  log(`loaded ${loaded} fingerprints`);
}

/** Has this exact file already been fingerprinted? */
const has = (key) => state.light.has(key);

async function readPrint(key) {
  try {
    const row = JSON.parse(await fsp.readFile(
      path.join(state.dir, ENTRIES, fileNameFor(key)), 'utf8'));
    return engine.unpack(row);
  } catch {
    return null;
  }
}

async function writePrint(key, row) {
  const file = path.join(state.dir, ENTRIES, fileNameFor(key));
  await fsp.writeFile(`${file}.tmp`, JSON.stringify(row));
  await fsp.rename(`${file}.tmp`, file);
}

// -------------------------------------------------------------- the sweep
//
// A OneDrive placeholder reports its full size but has almost no blocks
// allocated, which is the same test the face profiler uses. Anything under
// half-allocated is treated as cloud-only and left alone.

const isCloudOnly = (s) => (s.size ? (s.blocks || 0) * 512 < s.size * 0.5 : false);

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);
const NEVER_WALK = new Set(['node_modules', 'system volume information', '$recycle.bin']);
const skipDir = (name) => name.startsWith('$') || name.startsWith('.')
  || NEVER_WALK.has(name.toLowerCase());

/** Every downloaded video under the roots, deepest folder last. */
async function walkForWork() {
  const seen = new Set();
  const found = [];
  const roots = [...new Set([state.homeOf(), ...state.rootsOf()].filter(Boolean))]
    .map((r) => path.resolve(r));

  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (isCloudOnly(stat)) continue;
      const key = keyFor(stat);
      if (seen.has(key)) continue;             // the same file reached two ways
      seen.add(key);
      found.push({ file: full, stat, key });
    }
  };

  for (const root of roots) await walk(root);
  return found;
}

/**
 * Fingerprint one video and file the result.
 *
 * The name is kept alongside the numbers purely so a review list can be read
 * without a second pass over the disk -- the key alone says nothing a person
 * can act on.
 */
async function profile(file, stat) {
  const key = keyFor(stat);
  const raw = await engine.fingerprint(file);
  const row = engine.pack(raw);
  row.name = path.basename(file);
  // Where it was when it was read. A stale path is harmless -- it is checked
  // before use -- and it is the only way to put a set of copies on screen
  // together when they live in different folders.
  row.path = file;
  row.secs = (raw.hashes.length >>> 1) * engine.FRAME_EVERY;
  await writePrint(key, row);
  state.light.set(key, {
    gaps: row.gaps, secs: row.secs, cuts: row.cuts, name: row.name, path: file,
  });
  state.scanned += 1;
  state.done += 1;
  return row;
}

// ------------------------------------------------------------------ matching

/** Bucketed n-grams of the gap list: the lookup keys for one video. */
function keysOf(gaps) {
  const out = [];
  for (let i = 0; i + NGRAM <= gaps.length; i += 1) {
    const parts = [];
    for (let k = 0; k < NGRAM; k += 1) {
      parts.push(Math.round(gaps[i + k] / GAP_BUCKET));
    }
    out.push(parts.join(','));
  }
  return out;
}

/**
 * Pairs worth the cost of a real comparison.
 *
 * Rhythm first: two videos sharing any three-gap run are candidates. A video
 * with too few cuts to have a rhythm -- a single long shot -- falls back to
 * runtime, which is far weaker but only has to cover the handful of videos the
 * rhythm cannot speak for.
 */
function candidates() {
  const buckets = new Map();
  const quiet = [];
  for (const [key, light] of state.light) {
    if (light.cuts < MIN_CUTS_TO_INDEX) { quiet.push([key, light]); continue; }
    for (const k of keysOf(light.gaps)) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(key);
    }
  }

  const pairs = new Map();
  const add = (a, b) => {
    const id = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs.set(id, (pairs.get(id) || 0) + 1);
  };

  for (const keys of buckets.values()) {
    // A key shared by half the library is a rhythm of the encoder, not of the
    // footage -- an advert or a logo every video carries. It proposes nothing.
    if (keys.length > 40) continue;
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        if (keys[i] !== keys[j]) add(keys[i], keys[j]);
      }
    }
  }

  for (let i = 0; i < quiet.length; i += 1) {
    for (let j = i + 1; j < quiet.length; j += 1) {
      if (Math.abs(quiet[i][1].secs - quiet[j][1].secs) <= RUNTIME_BUCKET) {
        add(quiet[i][0], quiet[j][0]);
      }
    }
  }

  return [...pairs.entries()].map(([id, hits]) => {
    const [a, b] = id.split('|');
    return { a, b, hits };
  }).sort((x, y) => y.hits - x.hits);
}

/**
 * Confirm the candidates and gather the survivors into groups.
 *
 * Fingerprints are read from disk one pair at a time and cached only for the
 * length of the run: a full library of them in memory is 150MB, and this is a
 * background job, not a hot path.
 */
async function match({ onProgress } = {}) {
  const list = candidates();
  log(`${state.light.size} fingerprints, ${list.length} candidate pairs to check`);

  const cache = new Map();
  const CACHE_MAX = 400;
  const printOf = async (key) => {
    if (cache.has(key)) return cache.get(key);
    const print = await readPrint(key);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, print);
    return print;
  };

  const matches = [];
  let done = 0;
  for (const pair of list) {
    const [pa, pb] = [await printOf(pair.a), await printOf(pair.b)];
    done += 1;
    if (onProgress && done % 250 === 0) onProgress(done, list.length);
    if (!pa || !pb) continue;
    const verdict = engine.compare(pa, pb);
    const row = {
      a: pair.a,
      b: pair.b,
      aName: (state.light.get(pair.a) || {}).name || '',
      bName: (state.light.get(pair.b) || {}).name || '',
      ...verdict,
    };
    if (verdict.signals.sound || verdict.signals.picture) matches.push(row);
  }

  // Union-find, so three copies of one video make one group of three rather
  // than three pairs a person has to reconcile by eye.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  // Over every match, not only the certain ones: a pair only the sound agreed
  // on is exactly the pair worth putting side by side, and it cannot be put
  // side by side unless it is in a group.
  for (const row of matches) {
    for (const k of [row.a, row.b]) if (!parent.has(k)) parent.set(k, k);
    const ra = find(row.a); const rb = find(row.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const sets = new Map();
  for (const k of parent.keys()) {
    const root = find(k);
    if (!sets.has(root)) sets.set(root, []);
    sets.get(root).push(k);
  }

  state.groups = [...sets.values()];
  state.pairs = matches;
  state.byKey = new Map();
  state.groups.forEach((group, i) => group.forEach((k) => state.byKey.set(k, i)));

  // Which signals spoke for each video, across all of its pairs. A video can be
  // sound-matched to one copy and fully matched to another.
  state.kindsByKey = new Map();
  for (const row of matches) {
    for (const k of [row.a, row.b]) {
      const had = state.kindsByKey.get(k) || { sound: false, picture: false, both: false };
      state.kindsByKey.set(k, {
        sound: had.sound || row.signals.sound,
        picture: had.picture || row.signals.picture,
        both: had.both || row.signals.both,
      });
    }
  }

  const both = matches.filter((m) => m.signals.both).length;
  state.matched = both;
  log(`${state.groups.length} groups from ${matches.length} matched pairs `
    + `(${both} on both signals, ${matches.length - both} on one)`);
  return { groups: state.groups, confirmed: matches, possible: [] };
}

// -------------------------------------------------------------------- output

async function writeDigest(confirmed = [], possible = []) {
  const body = {
    version: VERSION,
    updated: new Date().toISOString(),
    fingerprinted: state.light.size,
    thresholds: {
      sound: engine.SOUND_PASS,
      picture: engine.PICTURE_PASS,
      cuts: engine.RUN_PASS,
    },
    groups: state.groups.map((keys) => keys.map((key) => ({
      key,
      name: (state.light.get(key) || {}).name || '',
      secs: (state.light.get(key) || {}).secs || 0,
      kinds: state.kindsByKey.get(key) || { sound: false, picture: false, both: false },
    }))),
    confirmed,
    possible,
  };
  await fsp.writeFile(path.join(state.dir, DIGEST), JSON.stringify(body, null, 1));
  return body;
}


/**
 * A video is gone: take it out of its set, and dissolve the set if that leaves
 * nothing to compare.
 *
 * A pair minus one member is not a pair. Leaving the survivor flagged meant the
 * Duplicates filter kept listing a video whose copy had already been deleted --
 * true when it was written down, false the moment it was acted on.
 *
 * The fingerprint itself is kept. It is keyed by size and modified time, so if
 * the file comes back -- restored from the Recycle Bin, or re-downloaded -- it
 * is recognised again without being read a second time.
 */
function forget(key) {
  const at = state.byKey.get(key);
  if (at === undefined) return { changed: false, survivors: [] };

  const group = state.groups[at].filter((k) => k !== key);
  state.byKey.delete(key);
  state.kindsByKey.delete(key);
  state.pairs = state.pairs.filter((p) => p.a !== key && p.b !== key);

  let survivors = group;
  if (group.length < 2) {
    // Nothing left to be a copy of.
    for (const k of group) {
      state.byKey.delete(k);
      state.kindsByKey.delete(k);
    }
    state.groups[at] = [];
  } else {
    state.groups[at] = group;
    survivors = group;
  }

  // Indices shift when an empty group is dropped, so the whole map is rebuilt
  // rather than patched -- there are tens of groups, not thousands.
  state.groups = state.groups.filter((g) => g.length > 1);
  state.byKey = new Map();
  state.groups.forEach((g, i) => g.forEach((k) => state.byKey.set(k, i)));
  state.matched = state.pairs.filter((p) => p.signals && p.signals.both).length;

  digestSoon();
  return { changed: true, survivors };
}

// Rewriting the digest per deletion would be a file write per click, so it is
// debounced: a selection of twenty deleted at once writes once.
let digestTimer = null;
function digestSoon() {
  if (digestTimer) clearTimeout(digestTimer);
  digestTimer = setTimeout(() => {
    digestTimer = null;
    // Never republish over a digest that is about to be rebuilt properly: this
    // write carries whatever is in memory, and if that came from an old-format
    // file it would overwrite a good match with a worse one.
    if (state.needsMatch) return;
    writeDigest(state.pairs, []).catch(() => { });
  }, 2000);
  if (digestTimer.unref) digestTimer.unref();
}

const EMPTY = Object.freeze({ duplicate: false, copies: 0, dupeKinds: null });

/** What a listing needs to know about one video. */
function decorate(stat) {
  const key = keyFor(stat);
  const at = state.byKey.get(key);
  if (at === undefined) return EMPTY;
  return {
    duplicate: true,
    copies: state.groups[at].length,
    group: at,
    // Which signals matched it to its copies, so the filter can ask for one
    // kind and the card can say which it was.
    dupeKinds: state.kindsByKey.get(key) || null,
  };
}


// ------------------------------------------------------------------ the loop
//
// Deliberately the face profiler's manners rather than the tool's: one video at
// a time, and only while the app is quiet. A backfill that makes browsing
// stutter is worse than a backfill that takes a week, and this one runs for as
// long as the app happens to be open rather than in one sitting.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long the app must be quiet before the sweep takes a turn. */
const IDLE_MS = 1500;
/** How often the library is walked again, so new files are picked up. */
const WALK_EVERY_MS = 15 * 60 * 1000;
/** How many new fingerprints are worth a re-match. */
const MATCH_AFTER = 25;
/** And how long a match must have rested first.

    Comparing grows with the library: a few thousand fingerprints make several
    thousand candidate pairs, and each pair is two files read and two
    cross-correlations. At twenty-five reads a batch that would soon be more
    matching than reading, so a match also has to wait its turn. */
const MATCH_REST_MS = 5 * 60 * 1000;

const busy = () => Date.now() - state.lastActivity < IDLE_MS;

function noteActivity() {
  state.lastActivity = Date.now();
}

/** A folder was opened that had not been before: count again now, not in 15m. */
function rootsChanged() {
  state.nextWalk = 0;
  start();
}

/**
 * Re-match and republish, when there is something new to match.
 *
 * Matching is seconds of work over thousands of fingerprints, so it does not
 * run per video -- it runs once a batch has built up, and again when the queue
 * finally empties, so the digest is never far behind what has been read.
 */
async function refresh() {
  if (state.matching) return;
  state.matching = true;
  state.lastMatch = Date.now();
  try {
    const { confirmed, possible } = await match();
    await writeDigest(confirmed, possible);
    state.sinceMatch = 0;
    state.needsMatch = false;
    state.lastMatch = Date.now();
  } catch (err) {
    log(`matching failed: ${err.message}`);
  } finally {
    state.matching = false;
  }
}

async function loop() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.enabled) {
      // Nothing may be queued until the index is read: a video whose
      // fingerprint has not loaded yet looks unread, and would be read again.
      if (!state.ready) { await wait(250); continue; }
      if (busy()) { await wait(400); continue; }

      // An old-format digest is worth fixing before anything else: until it is,
      // the filters have nothing to filter on.
      if (state.needsMatch) { await refresh(); continue; }

      if (!state.queue.length || Date.now() > state.nextWalk) {
        state.walking = true;
        try {
          const found = await walkForWork();
          state.downloaded = found.length;
          state.counted = true;
          // Where every downloaded video is, right now. The fingerprints
          // written before this existed carry no path, and a walk is happening
          // anyway -- so the live answer costs nothing and cannot go stale the
          // way a recorded one can.
          state.pathByKey = new Map(found.map((w) => [w.key, w.file]));
          state.queue = found.filter((w) => !has(w.key));
          state.nextWalk = Date.now() + WALK_EVERY_MS;
        } finally { state.walking = false; }
        // Now that where everything is is known, drop any member that is not
        // there any more -- deleted before this app learned to forget them, or
        // moved out from under the record.
        await prune();
        if (!state.queue.length) {
          // Everything read. Match whatever is outstanding, then sleep and look
          // again in case files arrive or come down from the cloud.
          state.current = '';
          if (state.sinceMatch) await refresh();
          await wait(60000);
          continue;
        }
      }

      const next = state.queue.shift();
      state.current = path.basename(next.file);
      if (!state.startedAt) state.startedAt = Date.now();
      try {
        await profile(next.file, next.stat);
        state.sinceMatch += 1;
      } catch {
        state.failures.add(next.key);
      }
      state.current = '';
      if (state.sinceMatch >= MATCH_AFTER && !busy()
        && Date.now() - state.lastMatch > MATCH_REST_MS) await refresh();
      await wait(150);
    }
  } finally {
    state.running = false;
    state.current = '';
  }
}

function start() {
  if (state.running || !state.enabled) return;
  loop().catch(() => { state.running = false; });
}

function setEnabled(on) {
  state.enabled = Boolean(on);
  if (state.enabled) start();
  return status();
}

/**
 * What the sweep has done and what is left.
 *
 * Shaped like the face profiler's, because the pill beside it reads the same
 * way: a fraction of the downloaded library, and one word for what it is doing.
 */

/**
 * Drop members whose file is no longer there, and dissolve what that empties.
 *
 * A key is size and modified time, so this catches a file deleted, moved out of
 * the library, or re-encoded in place -- all of which mean the video that was
 * compared no longer exists, whatever is at that path now.
 *
 * Only members whose path is known are ever judged. Before the first walk
 * nothing is known, and "I cannot find it" must not be mistaken for "it is
 * gone" -- that would dissolve the whole index on a slow start.
 */
async function prune() {
  if (!state.counted || !state.pathByKey.size) return 0;
  const gone = [];
  for (const group of state.groups) {
    for (const key of group) {
      const where = state.pathByKey.get(key) || (state.light.get(key) || {}).path;
      if (!where) {
        // No path at all, and the walk has finished: it is not among the
        // downloaded videos, so it is not somewhere this can compare against.
        //
        // A video freed up to the cloud since it was read lands here too, and
        // is dropped with the deleted ones -- the walk skips placeholders. That
        // is the right trade: a set nobody can open is not a set worth showing,
        // the fingerprint is kept either way, and pulling the file back down
        // re-forms the set at the next match.
        gone.push(key);
        continue;
      }
      try {
        const stat = await fsp.stat(where);
        if (keyFor(stat) !== key) gone.push(key);
      } catch {
        gone.push(key);
      }
    }
  }
  for (const key of gone) forget(key);
  if (gone.length) log(`${gone.length} copies no longer exist, sets updated`);
  return gone.length;
}

/**
 * Every video that is one of several copies, with the path it was read at.
 *
 * The listing uses this to complete a set whose other half is in a folder you
 * are not looking at -- the grouping is only worth having if the whole set is
 * in it.
 */
function members() {
  const out = [];
  state.groups.forEach((group, at) => {
    for (const key of group) {
      const light = state.light.get(key) || {};
      const where = state.pathByKey.get(key) || light.path;
      if (!where) continue;
      out.push({ key, group: at, path: where, name: light.name || '' });
    }
  });
  return out;
}

function status() {
  const fingerprinted = state.light.size;
  // Fingerprints whose video is no longer on this machine. They keep working
  // -- the key is size and modified time, which freeing a file up to the cloud
  // does not touch -- so this is the count of work that outlived its file.
  //
  // Counted only once the walk has said what is here. Before that everything
  // would look absent, and the pill would report the whole index as cached.
  const cached = state.counted
    ? [...state.light.keys()].reduce((n, k) => n + (state.pathByKey.has(k) ? 0 : 1), 0)
    : 0;
  return {
    available: true,
    ready: state.ready,
    enabled: state.enabled,
    running: state.running,
    fingerprinted,
    // The pair that belongs either side of a slash. Fingerprints of freed-up
    // files are counted apart, since a denominator they are not part of cannot
    // contain them -- which is what made this read "3,927 / 475".
    fingerprintedOnDisk: fingerprinted - cached,
    cached,
    downloaded: state.downloaded,
    counted: state.counted,
    remaining: state.walking ? null : state.queue.length,
    current: state.current,
    doing: !state.enabled ? 'paused'
      : !state.ready ? 'loading'
        : state.matching ? 'matching'
          : state.walking ? 'counting'
            : state.current ? 'reading'
              : state.running ? 'waiting' : 'stopped',
    done: state.done,
    rate: state.done > 2 && state.startedAt
      ? Math.round(state.done / ((Date.now() - state.startedAt) / 3600000))
      : 0,
    groups: state.groups.length,
    pairs: state.matched,
    possible: state.pairs.length - state.matched,
    copies: state.groups.reduce((n, g) => n + g.length - 1, 0),
  };
}

module.exports = {
  init,
  members,
  prune,
  forget,
  start,
  setEnabled,
  noteActivity,
  rootsChanged,
  refresh,
  loadIndex,
  loadDigest,
  walkForWork,
  profile,
  has,
  keyFor,
  readPrint,
  candidates,
  keysOf,
  match,
  writeDigest,
  decorate,
  status,
  state,
};
