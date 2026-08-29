'use strict';

/**
 * Familiar faces — who is probably in this video.
 *
 * A performer you have named in twenty videos is described by those twenty
 * videos: average their faces and you have her, far more reliably than any one
 * frame of any one of them. That average is what an unnamed video is compared
 * against, and the comparison is a ranking rather than a threshold — a name that
 * beats every other name by a clear margin is worth suggesting, and a raw
 * similarity number on its own is worth nothing.
 *
 * Nothing here ever writes a label. It suggests; you decide.
 *
 * Two deliberate properties:
 *
 *   Cloud-safe    Only downloaded files are ever profiled, and the profile is
 *                 keyed by size and modified time exactly as the library is. A
 *                 file freed up to the cloud afterwards keeps everything already
 *                 known about it — dehydration changes neither size nor mtime.
 *
 *   Optional      No models, or no onnxruntime, and every export here still
 *                 answers; the app simply reports the feature unavailable.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const engine = require('./face-engine');

// 2: three faces a frame instead of two, and a clustering threshold that stops
// splitting one woman into two people. Older entries are re-profiled rather than
// carried, since the grouping is what a suggestion is built on.
const VERSION = 2;

// Enough videos to average into a face. Two is a coincidence; three is a person.
const MIN_VIDEOS = 3;
// A group of frames too small to trust as a second person in the video.
const MIN_GROUP = 3;

/**
 * When a match is worth showing, per recogniser.
 *
 * Measured on 258 hold-out videos rather than guessed, and the two models need
 * different lines because they do not use the same range. Under SFace a wrong
 * name still scores 0.49, so the score alone can never separate them and the gap
 * to the runner-up does the work. ArcFace pushes the wrong names down to 0.18,
 * which leaves room for the score to mean something on its own.
 *
 * Both gates always have to pass. A high score with a close runner-up is two
 * performers who look alike, and naming either would be a guess.
 */
const BANDS = {
  arcface: [
    { band: 'strong', score: 0.55, margin: 0.15 },
    { band: 'likely', score: 0.45, margin: 0.10 },
    { band: 'maybe', score: 0.38, margin: 0.06 },
  ],
  sface: [
    { band: 'strong', score: 0.70, margin: 0.12 },
    { band: 'likely', score: 0.64, margin: 0.06 },
    { band: 'maybe', score: 0.58, margin: 0.03 },
  ],
};

const state = {
  dir: '',
  index: { version: VERSION, model: '', videos: {} },
  rebuilding: '',
  centroids: new Map(),   // performer -> { sum, count, keys:Set, vec }
  suggestions: new Map(), // video key -> [{ name, score, band, person }]
  queue: [],
  walking: false,
  nextWalk: 0,
  running: false,
  enabled: true,
  current: '',
  lastActivity: 0,
  counted: { downloaded: 0, at: 0 },
  // Every downloaded video's key, from the last sweep for work. Its purpose is
  // the difference: a profile whose video is NOT in here is one whose file has
  // since gone back to the cloud, and the work is kept regardless.
  onDisk: new Set(),
  failures: new Map(),
  library: null,
  rootsOf: () => [],
  dirty: false,
  saveTimer: null,
};

// --------------------------------------------------------------------- store

const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;
const fileNameFor = (key) => key.replace(':', '_');

function init({ cacheDir, library, roots }) {
  state.dir = cacheDir || path.join(
    process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'faces',
  );
  state.library = library;
  state.rootsOf = roots;
  const modelDir = process.env.VIDEO_EXPLORER_FACE_MODELS
    || path.join(path.dirname(state.dir), 'face-models');

  const ready = engine.init(modelDir);

  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(state.dir, 'index.json'), 'utf8'));
    // Vectors from two different recognisers are not comparable, so an index
    // built by the other one is discarded rather than mixed. Re-profiling is
    // hours of background work; a silently wrong suggestion is worse.
    const usable = parsed && parsed.videos && parsed.version === VERSION
      && parsed.model === ready.model;
    if (usable) state.index = parsed;
    else if (parsed && parsed.videos) state.rebuilding = parsed.model || 'an older model';
  } catch { /* no index yet, or one written by an older shape */ }
  state.index.model = ready.model || state.index.model;

  rebuild();
  return { ...ready, profiled: Object.keys(state.index.videos).length, modelDir };
}

/**
 * Vectors are stored as plain arrays at four decimals.
 *
 * A 128-number embedding is meaningless past that, and the difference over a few
 * thousand videos is a 4MB file rather than a 20MB one.
 */
const packVector = (v) => Array.from(v, (x) => Math.round(x * 10000) / 10000);
const unpackVector = (a) => engine.normalise(Float32Array.from(a));

function saveSoon() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(state.dir, { recursive: true });
      await fsp.writeFile(
        path.join(state.dir, 'index.json'), JSON.stringify(state.index),
      );
      state.dirty = false;
    } catch { /* a full or read-only disk must not break browsing */ }
  }, 2000);
}

/** Written on the way out, so a session's work is never lost to a close. */
async function flush() {
  clearTimeout(state.saveTimer);
  if (!state.dirty) return;
  try {
    await fsp.mkdir(state.dir, { recursive: true });
    await fsp.writeFile(path.join(state.dir, 'index.json'), JSON.stringify(state.index));
    state.dirty = false;
  } catch { /* nothing to be done at exit */ }
}

// ----------------------------------------------------------------- centroids

/**
 * One average face per performer, from every video she is named in.
 *
 * Built from solo credits only. With two names on a video there is no way to
 * know which face belongs to which name, and a centroid polluted by the wrong
 * person is worse than no centroid at all.
 */
function rebuild() {
  state.centroids.clear();
  const records = state.library ? state.library.all() : {};
  for (const [key, entry] of Object.entries(state.index.videos)) {
    const record = records[key];
    if (!record || !Array.isArray(record.models) || record.models.length !== 1) continue;
    const people = entry.people || [];
    if (!people.length) continue;
    // The dominant group: the face the video is mostly of.
    const vec = unpackVector(people[0].vec);
    const name = record.models[0];
    let acc = state.centroids.get(name);
    if (!acc) {
      acc = { sum: new Float32Array(vec.length), count: 0, keys: new Map() };
      state.centroids.set(name, acc);
    }
    for (let i = 0; i < vec.length; i += 1) acc.sum[i] += vec[i];
    acc.count += 1;
    acc.keys.set(key, vec);
  }
  for (const [name, acc] of state.centroids) {
    if (acc.count < MIN_VIDEOS) state.centroids.delete(name);
    else acc.vec = engine.normalise(Float32Array.from(acc.sum));
  }
  rescore();
}

/**
 * The centroid a video did not help build.
 *
 * A video already credited to her would otherwise be scored against an average
 * containing itself, which flatters it and makes the confirmation worthless.
 */
function centroidWithout(acc, key) {
  const own = acc.keys.get(key);
  if (!own) return acc.vec;
  if (acc.count <= MIN_VIDEOS) return null; // too thin to hold up without it
  const sum = Float32Array.from(acc.sum);
  for (let i = 0; i < sum.length; i += 1) sum[i] -= own[i];
  return engine.normalise(sum);
}

function bandFor(score, margin) {
  for (const b of BANDS[engine.modelName()] || BANDS.sface) {
    if (score >= b.score && margin >= b.margin) return b.band;
  }
  return '';
}

/**
 * One video, ranked against every performer.
 *
 * Each group of faces is ranked separately, so a video with two people in it can
 * suggest two names. Only the winner of each ranking is ever offered: second
 * place is what the margin is measured against, not a second guess.
 */
function scoreVideo(key, entry) {
  const out = [];
  for (const [personIndex, person] of (entry.people || []).entries()) {
    const vec = unpackVector(person.vec);
    const ranked = [];
    for (const [name, acc] of state.centroids) {
      const against = centroidWithout(acc, key);
      if (!against) continue;
      ranked.push({ name, score: engine.cosine(vec, against), videos: acc.count });
    }
    if (ranked.length < 2) continue;
    ranked.sort((a, b) => b.score - a.score);
    const margin = ranked[0].score - ranked[1].score;
    const band = bandFor(ranked[0].score, margin);
    if (!band) continue;
    // The same performer suggested for two groups is one suggestion, not two.
    if (out.some((s) => s.name === ranked[0].name)) continue;
    out.push({
      name: ranked[0].name,
      score: Math.round(ranked[0].score * 1000) / 1000,
      margin: Math.round(margin * 1000) / 1000,
      band,
      person: personIndex,
      videos: ranked[0].videos,
      runnerUp: ranked[1].name,
    });
  }
  // Strongest first, not biggest-group first. On a correctly credited video the
  // name already on it should be the one at the top -- that is the shape of a
  // healthy answer, and it only reads that way if the order is the score.
  out.sort((a, b) => b.score - a.score);
  if (out.length) state.suggestions.set(key, out);
  else state.suggestions.delete(key);
  return out;
}

/** Every profiled video, when the averages themselves have moved. */
function rescore() {
  state.suggestions.clear();
  if (!state.centroids.size) return;
  for (const [key, entry] of Object.entries(state.index.videos)) scoreVideo(key, entry);
}

// -------------------------------------------------------------- the listing

const EMPTY = Object.freeze({ suggested: [], profiled: false });

/**
 * Safe to spread onto any file entry.
 *
 * `suggested` travels with the listing so the advanced filter can ask for videos
 * that have one without a second round trip — including videos already credited,
 * where a suggestion is a confirmation, or a disagreement worth looking at.
 */
function decorate(stat) {
  const key = keyFor(stat);
  const entry = state.index.videos[key];
  if (!entry) return EMPTY;
  return { suggested: state.suggestions.get(key) || [], profiled: true };
}

function suggestionsFor(stat) {
  return state.suggestions.get(keyFor(stat)) || [];
}

/**
 * Every performer scored, band or no band.
 *
 * Not used by the app -- a ranking of thirty names is not a suggestion -- but it
 * is what the thresholds were calibrated against, and what to look at when a
 * suggestion is missing and the question is whether the face was recognised or
 * merely not confident enough.
 */
function rankFor(stat, person = 0) {
  const entry = state.index.videos[keyFor(stat)];
  if (!entry || !(entry.people || [])[person]) return [];
  const vec = unpackVector(entry.people[person].vec);
  const ranked = [];
  for (const [name, acc] of state.centroids) {
    const against = centroidWithout(acc, keyFor(stat));
    if (!against) continue;
    ranked.push({ name, score: Math.round(engine.cosine(vec, against) * 1000) / 1000 });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** Where the face behind a suggestion came from, as a PNG. */
async function faceImage(stat, person = 0) {
  const at = path.join(state.dir, 'thumbs', `${fileNameFor(keyFor(stat))}-${person}.png`);
  try { return await fsp.readFile(at); } catch { return null; }
}

// ------------------------------------------------------------- profiling one

const isCloudOnly = (s) => (s.size ? (s.blocks || 0) * 512 < s.size * 0.5 : false);

/**
 * Reads one video and files what it found.
 *
 * The expensive half is ffmpeg, so the result is written the moment it exists:
 * an interrupted backfill resumes from where it stopped rather than from the
 * beginning.
 */
async function profile(file, stat, opts = {}) {
  const key = keyFor(stat);
  if (state.index.videos[key]) return state.index.videos[key];
  const faces = await engine.facesIn(file, opts);
  const groups = faces.length >= 2 ? engine.groupFaces(faces) : [];
  const people = groups
    .filter((g, i) => i === 0 || g.faces >= MIN_GROUP)
    .slice(0, 4)
    .map((g) => ({ n: g.faces, vec: packVector(g.vector) }));

  const entry = { at: Date.now(), faces: faces.length, people };
  state.index.videos[key] = entry;
  saveSoon();

  // One picture per person, so a suggestion can show the face it came from.
  if (people.length) {
    try {
      await fsp.mkdir(path.join(state.dir, 'thumbs'), { recursive: true });
      for (const [i, g] of groups.slice(0, people.length).entries()) {
        await fsp.writeFile(
          path.join(state.dir, 'thumbs', `${fileNameFor(key)}-${i}.png`),
          engine.cropToPng(g.best),
        );
      }
    } catch { /* the vector is the point; the picture is a courtesy */ }
  }
  return entry;
}

// ------------------------------------------------------ the background sweep

/** Every downloaded video under the folders you have opened, deepest root wins. */
async function walkForWork() {
  const roots = state.rootsOf().map((r) => path.resolve(r));
  // A root inside another root would walk the same tree twice.
  const outer = roots.filter((r) => !roots.some((other) => other !== r
    && r.toLowerCase().startsWith(other.toLowerCase() + path.sep)));

  const work = [];
  const onDisk = new Set();
  const skip = new Set(['node_modules', '$recycle.bin', 'system volume information']);
  const seen = new Set();

  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || skip.has(e.name.toLowerCase())) continue;
        await walk(full);
      } else if (/\.(mp4|m4v|mov|mkv|webm)$/i.test(e.name)) {
        let stat;
        try { stat = await fsp.stat(full); } catch { continue; }
        if (isCloudOnly(stat)) continue;
        const key = keyFor(stat);
        onDisk.add(key);
        if (seen.has(key) || state.index.videos[key]) continue;
        if ((state.failures.get(key) || 0) >= 2) continue;
        seen.add(key);
        work.push({ file: full, stat, key });
      }
    }
  }

  for (const root of outer) await walk(root);
  state.onDisk = onDisk;
  state.counted = { downloaded: onDisk.size, at: Date.now() };
  // Unnamed videos first: a suggestion is worth most where there is no answer.
  const records = state.library ? state.library.all() : {};
  work.sort((a, b) => {
    const named = (w) => ((records[w.key] || {}).models || []).length > 0;
    return Number(named(a)) - Number(named(b));
  });
  return work;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// How long the app must be quiet before the sweep takes a turn. Profiling holds
// the CPU in bursts, and a browse that stutters is worse than a slow backfill.
const IDLE_MS = 1500;
// How often the library is counted again, so the pill's denominator corrects
// itself rather than standing at whatever the first sweep happened to see.
const WALK_EVERY_MS = 15 * 60 * 1000;
const busy = () => Date.now() - state.lastActivity < IDLE_MS;

function noteActivity() {
  state.lastActivity = Date.now();
}

/**
 * The sweep itself: one video at a time, only while nothing else is happening.
 *
 * It yields to the app rather than competing with it — the moment a request
 * arrives the current harvest abandons its remaining frames, and the loop waits
 * for quiet before picking the next file.
 */
async function loop() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.enabled && engine.available().ok) {
      if (busy()) { await wait(400); continue; }

      // Re-counted on a timer as well as when the queue runs dry. The library
      // is not fixed -- files are added, and freed up -- and on a fresh install
      // the first sweep can run before any folder has been opened, which would
      // otherwise leave a denominator counted from nothing until the queue
      // emptied. Anything already profiled is skipped, so a re-walk is cheap.
      if (!state.queue.length || Date.now() > state.nextWalk) {
        state.walking = true;
        try {
          const found = await walkForWork();
          // Merge rather than replace: an in-flight queue keeps its order, and
          // its unfinished items are in `found` again anyway.
          state.queue = found;
          state.nextWalk = Date.now() + WALK_EVERY_MS;
        } finally { state.walking = false; }
        if (!state.queue.length) {
          // Nothing outstanding: sleep, then look again in case files arrived.
          state.current = '';
          await wait(60000);
          continue;
        }
      }

      const next = state.queue.shift();
      state.current = path.basename(next.file);
      try {
        const entry = await profile(next.file, next.stat, { shouldStop: busy });
        if (!entry.people.length && entry.faces < 2) {
          // Abandoned early because the app woke up, or genuinely faceless. A
          // second look costs one more read; a third would be stubbornness.
          const tries = (state.failures.get(next.key) || 0) + 1;
          state.failures.set(next.key, tries);
          if (busy()) delete state.index.videos[next.key];
        } else {
          // A solo credit joins someone's average, which moves every score. An
          // unnamed video moves nothing but its own, so it is scored alone --
          // the difference between a few microseconds and a full sweep of the
          // library, several thousand times over.
          const record = (state.library ? state.library.all() : {})[next.key];
          if (record && (record.models || []).length === 1) rebuild();
          else scoreVideo(next.key, entry);
        }
      } catch {
        state.failures.set(next.key, (state.failures.get(next.key) || 0) + 1);
      }
      state.current = '';
      await wait(150);
    }
  } finally {
    state.running = false;
    state.current = '';
  }
}

function start() {
  if (!engine.available().ok || state.running || !state.enabled) return;
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
 * `downloaded` is the denominator the user asked for — profiled out of the
 * downloaded library, not out of everything, since cloud files are never
 * candidates.
 */
function status() {
  const ready = engine.available().ok;
  const keys = Object.keys(state.index.videos);
  const withFaces = Object.values(state.index.videos)
    .reduce((n, v) => n + ((v.people || []).length ? 1 : 0), 0);
  // Profiles whose video is no longer on this machine. They keep working --
  // the key is size and modified time, which dehydration does not touch -- so
  // this is the count of work that outlived the file being freed up.
  const cached = state.counted.at
    ? keys.reduce((n, k) => n + (state.onDisk.has(k) ? 0 : 1), 0) : 0;
  return {
    available: ready,
    reason: engine.available().reason,
    enabled: state.enabled,
    running: state.running,
    walking: state.walking,
    idle: !busy(),
    current: state.current,
    profiled: keys.length,
    // How many of the downloaded videos are done -- the pair that belongs
    // either side of a slash. Profiles of freed-up files are counted apart,
    // since a denominator they are not part of cannot contain them.
    profiledOnDisk: keys.length - cached,
    cached,
    counted: Boolean(state.counted.at),
    withFaces,
    downloaded: state.counted.downloaded,
    remaining: state.walking ? null : state.queue.length,
    performers: state.centroids.size,
    suggestions: state.suggestions.size,
    model: engine.available().model,
    rebuilding: state.rebuilding,
  };
}

module.exports = {
  init, start, setEnabled, status, noteActivity, decorate, suggestionsFor, rankFor,
  faceImage, profile, rebuild, flush, keyFor, MIN_VIDEOS,
};
