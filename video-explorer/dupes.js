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
  possible: [],            // pairs one signal liked and the other did not
  byKey: new Map(),        // key -> index into groups
  scanned: 0,
  matched: 0,
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
    state.groups = (body.groups || []).map((group) => group.map((g) => g.key));
    state.possible = body.possible || [];
    state.matched = (body.confirmed || []).length;
    state.byKey = new Map();
    state.groups.forEach((group, i) => group.forEach((k) => state.byKey.set(k, i)));
    // The names in the digest cover videos whose fingerprints have not been
    // read yet, so a review list works the moment the server is up.
    for (const group of body.groups || []) {
      for (const g of group) {
        if (!state.light.has(g.key)) {
          state.light.set(g.key, { gaps: [], secs: g.secs || 0, cuts: 0, name: g.name || '' });
        }
      }
    }
    log(`${state.groups.length} duplicate groups from the last run`);
    return body;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ storage

async function loadIndex() {
  const dir = path.join(state.dir, ENTRIES);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
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
  row.secs = raw.hashes.length * engine.FRAME_EVERY;
  await writePrint(key, row);
  state.light.set(key, {
    gaps: row.gaps, secs: row.secs, cuts: row.cuts, name: row.name,
  });
  state.scanned += 1;
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

  const confirmed = [];
  const possible = [];
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
    if (verdict.verdict === 'duplicate') confirmed.push(row);
    else if (verdict.verdict !== 'no') possible.push(row);
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
  for (const row of confirmed) {
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
  state.possible = possible;
  state.byKey = new Map();
  state.groups.forEach((group, i) => group.forEach((k) => state.byKey.set(k, i)));
  state.matched = confirmed.length;

  log(`${state.groups.length} duplicate groups (${confirmed.length} confirmed pairs), `
    + `${possible.length} to look at by eye`);
  return { groups: state.groups, confirmed, possible };
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
    }))),
    confirmed,
    possible,
  };
  await fsp.writeFile(path.join(state.dir, DIGEST), JSON.stringify(body, null, 1));
  return body;
}

const EMPTY = Object.freeze({ duplicate: false, copies: 0 });

/** What a listing needs to know about one video. */
function decorate(stat) {
  const key = keyFor(stat);
  const at = state.byKey.get(key);
  if (at === undefined) return EMPTY;
  return { duplicate: true, copies: state.groups[at].length, group: at };
}

function status() {
  return {
    ready: state.ready,
    fingerprinted: state.light.size,
    scanned: state.scanned,
    groups: state.groups.length,
    pairs: state.matched,
    possible: state.possible.length,
  };
}

module.exports = {
  init,
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
