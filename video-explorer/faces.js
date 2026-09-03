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

const log = (msg) => console.log(`[video-explorer] familiar faces: ${msg}`);

// 2: three faces a frame instead of two, and a clustering threshold that stops
// splitting one woman into two people. Older entries are re-profiled rather than
// carried, since the grouping is what a suggestion is built on.
const VERSION = 2;

// Enough videos to average into a face. Two is a coincidence; three is a person.
const MIN_VIDEOS = 3;
/**
 * A group of frames too small to trust as a second person in the video.
 *
 * Two, not three. Three lost real performers: a video yielding five faces, three
 * of the male co-star and two of her, kept him as the video's face and dropped
 * her entirely — she had been found and then thrown away. Denser sampling makes
 * that rarer; this makes it survivable when it still happens.
 */
const MIN_GROUP = 2;

/**
 * What the harvest settings were when a video was read.
 *
 * Bumped when they change materially, because a profile taken at the old
 * settings answers a different question -- it cannot show a second performer it
 * never sampled. Rather than discard those, they are re-read in the background,
 * last in the queue, and go on working in the meantime.
 */
const HARVEST_GEN = 2;

/**
 * When a match is worth showing.
 *
 * Measured on 258 hold-out videos rather than guessed. These lines are ArcFace's
 * range and nobody else's — they were keyed by model while SFace was a fallback,
 * whose wrong answers scored 0.49 and left the score gate unable to separate
 * anything on its own. ArcFace pushes wrong names down to 0.18, which is what
 * lets a score floor mean something.
 *
 * Both gates always have to pass. A high score with a close runner-up is two
 * performers who look alike, and naming either would be a guess.
 */
const BANDS = [
  { band: 'strong', score: 0.55, margin: 0.15 },
  { band: 'likely', score: 0.45, margin: 0.10 },
  { band: 'maybe', score: 0.38, margin: 0.06 },
];

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
  // The last file read, kept after it finishes. `current` empties between
  // videos and while the library is being counted, and a progress indicator
  // that blanks every few seconds reads as nothing happening.
  lastRead: '',
  done: 0,
  startedAt: 0,
  lastActivity: 0,
  counted: { downloaded: 0, at: 0 },
  // Every downloaded video's key, from the last sweep for work. Its purpose is
  // the difference: a profile whose video is NOT in here is one whose file has
  // since gone back to the cloud, and the work is kept regardless.
  onDisk: new Set(),
  failures: new Map(),
  library: null,
  rootsOf: () => [],
  homeOf: () => '',
  loading: false,
};

// --------------------------------------------------------------------- store

const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;
const fileNameFor = (key) => key.replace(':', '_');
const keyFromFileName = (name) => name.replace(/\.json$/, '').replace('_', ':');

/**
 * One small file per video, rather than one big index.
 *
 * The index was rewritten whole after every video: 3.9ms and a growing few
 * megabytes, five hundred times an hour. Over a full sweep that is about 25GB
 * of writing to store 12MB, and it is what makes this impossible to keep in a
 * synced folder -- OneDrive would re-upload the whole thing after every video.
 *
 * Per video it is 0.1ms and 3.6KB, written once and never touched again. That
 * saves fourteen seconds across a seven-hour sweep, which is nothing; what it
 * actually buys is a folder that can be synced, that two machines can both add
 * to without conflicting, and that cannot lose everything to one bad write.
 */
const ENTRIES = 'v';

function init({ cacheDir, library, roots, home }) {
  state.dir = cacheDir || path.join(
    process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'faces',
  );
  state.library = library;
  state.rootsOf = roots;
  state.homeOf = home || (() => '');
  // The models stay on the machine even though the profiles no longer do: 200MB
  // of weights are a download, not the user's data, and syncing them to every
  // device to save one download would be the waste the cache was once accused
  // of being. So this is not derived from where the store lives.
  const modelDir = process.env.VIDEO_EXPLORER_FACE_MODELS
    || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'face-models');

  const ready = engine.init(modelDir);
  state.index = { version: VERSION, model: ready.model || '', videos: {} };

  // Vectors from two different recognisers are not comparable, so a store built
  // by the other one is not read. Re-profiling is hours of background work; a
  // silently wrong suggestion is worse.
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(state.dir, 'meta.json'), 'utf8'));
  } catch { /* first run, or still the single-file shape */ }

  migrateFromSingleFile(ready.model);

  try {
    meta = meta || JSON.parse(fs.readFileSync(path.join(state.dir, 'meta.json'), 'utf8'));
  } catch { /* nothing migrated either */ }

  if (meta && (meta.version !== VERSION || meta.model !== ready.model)) {
    state.rebuilding = meta.model || 'an older model';
  } else {
    // Read in the background. Thousands of small files is about two seconds,
    // and the app opening two seconds later to have suggestions ready two
    // seconds sooner is a bad trade -- the sweep cannot start until the app is
    // up anyway. Suggestions appear a moment after the window does.
    state.loading = true;
    loadEntries().then(() => {
      state.loading = false;
      rebuild();
    }).catch(() => { state.loading = false; });
  }
  writeMeta(ready.model);

  rebuild();
  return { ...ready, profiled: Object.keys(state.index.videos).length, modelDir };
}

function writeMeta(model) {
  try {
    fs.mkdirSync(path.join(state.dir, ENTRIES), { recursive: true });
    fs.writeFileSync(path.join(state.dir, 'meta.json'),
      JSON.stringify({ version: VERSION, model: model || '' }));
  } catch { /* read-only disk: the store simply will not persist */ }
}

/**
 * The old single index, split up, once.
 *
 * Nobody should have to re-read three and a half thousand videos because the
 * file layout changed. The original is kept beside the new folder rather than
 * deleted -- it costs a few megabytes and it is the only copy of that work.
 */
function migrateFromSingleFile(model) {
  const single = path.join(state.dir, 'index.json');
  const dir = path.join(state.dir, ENTRIES);
  if (fs.existsSync(dir) || !fs.existsSync(single)) return;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(single, 'utf8')); } catch { return; }
  if (!parsed || !parsed.videos) return;

  try {
    fs.mkdirSync(dir, { recursive: true });
    let moved = 0;
    for (const [key, entry] of Object.entries(parsed.videos)) {
      fs.writeFileSync(path.join(dir, `${fileNameFor(key)}.json`), JSON.stringify(entry));
      moved += 1;
    }
    fs.writeFileSync(path.join(state.dir, 'meta.json'),
      JSON.stringify({ version: parsed.version || VERSION, model: parsed.model || model || '' }));
    fs.renameSync(single, path.join(state.dir, 'index.json.migrated'));
    log(`split ${moved} profiles out of index.json`);
  } catch { /* leave the single file alone and start empty rather than half-done */ }
}

/**
 * Every stored profile, read back.
 *
 * In parallel, in batches: several thousand sequential reads is a second and a
 * half of waiting on the disk one file at a time, where sixty-four at once is a
 * fraction of that. The batch is bounded because a few thousand open file
 * handles at once is its own kind of rude.
 */
async function loadEntries() {
  const dir = path.join(state.dir, ENTRIES);
  let names;
  try { names = await fsp.readdir(dir); } catch { return; }
  const wanted = names.filter((n) => n.endsWith('.json'));
  const BATCH = 64;
  for (let i = 0; i < wanted.length; i += BATCH) {
    await Promise.all(wanted.slice(i, i + BATCH).map(async (name) => {
      try {
        state.index.videos[keyFromFileName(name)] =
          JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      } catch { /* one unreadable profile is not worth failing the rest for */ }
    }));
  }
}

/**
 * Vectors are stored as plain arrays at four decimals.
 *
 * A 512-number embedding is meaningless past that, and the difference over a few
 * thousand videos is a 12MB store rather than a 60MB one.
 */
const packVector = (v) => Array.from(v, (x) => Math.round(x * 10000) / 10000);
const unpackVector = (a) => engine.normalise(Float32Array.from(a));

/** One profile, written the moment it exists. */
async function writeEntry(key, entry) {
  try {
    const dir = path.join(state.dir, ENTRIES);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${fileNameFor(key)}.json`), JSON.stringify(entry));
  } catch { /* a full or read-only disk must not break browsing */ }
}

async function dropEntry(key) {
  delete state.index.videos[key];
  try {
    await fsp.unlink(path.join(state.dir, ENTRIES, `${fileNameFor(key)}.json`));
  } catch { /* never written, or already gone */ }
}

/**
 * Nothing is held back any more, so there is nothing to flush -- except the
 * digest, which is deliberately lazy about being written.
 */
async function flush() {
  await writeDigest();
}

// ------------------------------------------------------------------- digest

/**
 * What has been profiled and what it suggests, in one small file the phone can
 * read.
 *
 * The profiles themselves are a thousand files of packed vectors, and the
 * suggestions are not in them: they come from averaging every performer across
 * the library and scoring each video against the lot. A phone cannot do that
 * work and has no business trying. But the *answer* is tiny -- a name, a score
 * and a band per video -- so it is written out beside the profiles and the
 * phone reads the answer instead of the evidence.
 *
 * A key with an empty list is a video that was read and matched nobody, which
 * is a different fact from one that has not been read, and the filter needs to
 * tell them apart.
 */
const DIGEST = 'suggestions.json';
const DIGEST_DEBOUNCE_MS = 30000;

let digestTimer = null;
let digestDirty = false;

/**
 * Every performer's lineup, precomputed.
 *
 * A lineup is "her other faces, most like the rest of her first", and the
 * ordering comes from a medoid agreement over her whole set -- every one of her
 * vectors against every other. That is cheap here and impossible anywhere else,
 * since the vectors are the one thing deliberately not published. So the answer
 * is: which crops, in which order, with how much each agrees.
 *
 * Only rebuilt when the averages themselves have moved, which is what changes an
 * ordering. During a sweep the digest is rewritten every half minute and this is
 * not, because nothing in it has changed.
 */
const LINEUPS = 'lineups.json';

let lineupsDirty = true;

async function writeLineups() {
  if (!lineupsDirty || !state.dir) return false;
  lineupsDirty = false;
  const performers = {};
  for (const name of state.centroids.keys()) {
    const built = lineup(name, 24);
    if (!built.faces.length) continue;
    performers[name] = {
      total: built.total,
      odd: built.odd,
      contributing: built.contributing,
      // `key` addresses the crop: thumbs/<size>_<mtime>-0.png, person 0 being
      // the dominant face, which is what a lineup is made of.
      faces: built.faces.map((f) => ({
        key: f.key, name: f.name, rating: f.rating, solo: f.solo, agrees: f.agrees,
      })),
    };
  }
  try {
    await fsp.writeFile(path.join(state.dir, LINEUPS), JSON.stringify({
      version: 1,
      model: state.index.model || '',
      updated: Date.now(),
      // What counts as a face that does not look like the rest of her, so a
      // reader can mark the odd ones the way the desktop panel does.
      apart: SAME_PERSON,
      performers,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * A sweep finishes a video every seven seconds, and this file sits in a synced
 * folder. Half a minute of coalescing turns a night of profiling into a
 * manageable number of uploads, and the worst case of being half a minute
 * behind is a suggestion appearing on the phone a moment late.
 */
function digestSoon() {
  digestDirty = true;
  if (digestTimer) return;
  digestTimer = setTimeout(() => {
    digestTimer = null;
    writeDigest().catch(() => {});
  }, DIGEST_DEBOUNCE_MS);
}

async function writeDigest() {
  if (!digestDirty || !state.dir) return false;
  digestDirty = false;
  clearTimeout(digestTimer);
  digestTimer = null;

  const videos = {};
  for (const key of Object.keys(state.index.videos)) {
    // Trimmed to what a reader needs: a name, how sure, and which face group it
    // came from -- that last one is how the crop behind the suggestion is
    // addressed. The margin and the runner-up stay here, where the bands that
    // were computed from them are all anyone else needs.
    videos[key] = (state.suggestions.get(key) || [])
      .map((s) => ({ name: s.name, score: s.score, band: s.band, person: s.person || 0 }));
  }

  try {
    await fsp.mkdir(state.dir, { recursive: true });
    await fsp.writeFile(path.join(state.dir, DIGEST), JSON.stringify({
      version: 2,
      model: state.index.model || '',
      updated: Date.now(),
      profiled: Object.keys(videos).length,
      performers: state.centroids.size,
      videos,
    }));
    await writeLineups();
    return true;
  } catch {
    return false;   // a read-only or offline folder is not worth an error
  }
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
  // The averages have moved, so every lineup's ordering is stale with them.
  lineupsDirty = true;
  rescore();
}

// Below this, two faces are different people: same-person crops sit at 0.5 and
// up, different people around 0.1. Used to order a lineup, not to filter one.
const SAME_PERSON = 0.30;

/**
 * How much each of a performer's videos looks like the rest of her.
 *
 * The dominant face in a video is usually the performer but not always -- where
 * a video yielded only two or three faces the male co-star can be the biggest of
 * them, and the lineup shows this plainly: two of six faces for one performer
 * were a man.
 *
 * Dropping those from her average was the obvious fix and it does not work.
 * Measured leave-one-out over 280 videos it moved top-1 by -0.4 points and top-3
 * by +0.3 -- noise, in exchange for discarding 11% of the evidence. A wrong face
 * among a dozen right ones is simply outvoted by the averaging, and the averaging
 * is cheaper than deciding who to believe.
 *
 * So nothing is thrown away. This only says which faces are most like her, so
 * a lineup can lead with those rather than opening on the co-star.
 */
function agreementWithin(acc) {
  const entries = [...acc.keys.entries()];
  if (entries.length < 2) return new Map(entries.map(([k]) => [k, 1]));
  const sims = entries.map(([, a]) => entries.map(([, b]) => engine.cosine(a, b)));
  let best = 0;
  let bestTotal = -Infinity;
  for (let i = 0; i < entries.length; i += 1) {
    const total = sims[i].reduce((n, x) => n + x, 0);
    if (total > bestTotal) { bestTotal = total; best = i; }
  }
  return new Map(entries.map(([key], i) => [key, sims[best][i]]));
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
  for (const b of BANDS) {
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
  digestSoon();
  if (!state.centroids.size) return;
  for (const [key, entry] of Object.entries(state.index.videos)) scoreVideo(key, entry);
}

// -------------------------------------------------------------- the listing

const EMPTY = Object.freeze({ suggested: [], profiled: false, people: 0 });

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
  // How many distinct faces it yielded, not how many it matched. Read and
  // faceless is a different fact from read and unrecognised -- there is nothing
  // to credit on the first and something to credit on the second -- and only
  // the listing can tell them apart across a whole folder.
  return {
    suggested: state.suggestions.get(key) || [],
    profiled: true,
    people: (entry.people || []).length,
  };
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

/**
 * What a video came to, whether or not anything cleared the bar.
 *
 * Silence is ambiguous: not read yet, read and no face found, and read with a
 * face that matched nobody are three different situations and the strip showed
 * nothing for all of them. This says which, and names the closest few so a near
 * miss is visible as a near miss rather than as an absence.
 *
 * Asked per video when the player opens, not carried with the listing -- three
 * more names on every one of several thousand entries is a lot of payload for
 * something read one video at a time.
 */
function standing(stat) {
  const key = keyFor(stat);
  const entry = state.index.videos[key];
  if (!entry) return { profiled: false };
  const suggested = state.suggestions.get(key) || [];
  const out = {
    profiled: true,
    faces: entry.faces || 0,
    people: (entry.people || []).length,
    suggested: suggested.length,
    performers: state.centroids.size,
    near: [],
  };
  if (suggested.length || !out.people) return out;
  // Nothing cleared the bar. Say what came closest, and by how much it did not.
  const ranked = rankFor(stat, 0);
  const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : 0;
  out.near = ranked.slice(0, 3).map((r, i) => ({
    name: r.name,
    score: r.score,
    margin: i === 0 ? Math.round(gap * 1000) / 1000 : 0,
  }));
  return out;
}

/** Where the face behind a suggestion came from, as a PNG. */
async function faceImage(stat, person = 0) {
  return faceImageByKey(keyFor(stat), person);
}

/**
 * The same picture, addressed by key rather than by path.
 *
 * A lineup shows faces from other videos, and those videos may since have been
 * renamed, moved, or freed up to the cloud -- none of which changes the key. It
 * is also our own generated 112x112 crop rather than any part of a file, so
 * there is nothing here for the path authorisation to protect.
 */
async function faceImageByKey(key, person = 0) {
  if (!/^\d+:\d+$/.test(String(key))) return null;
  const at = path.join(state.dir, 'thumbs', `${fileNameFor(key)}-${Number(person) || 0}.png`);
  try { return await fsp.readFile(at); } catch { return null; }
}

/**
 * A performer's other faces, for checking a suggestion against.
 *
 * A name beside a thumbnail asks to be taken on trust. The same face beside
 * eight of hers does not -- it is the comparison the ranking already made,
 * shown rather than asserted.
 *
 * Solo credits lead, because those are the videos her average is actually built
 * from; a face from a two-hander might be the other performer.
 */
function lineup(model, limit = 8) {
  const want = String(model || '').toLowerCase();
  if (!want) return { model: '', total: 0, faces: [] };
  const records = state.library ? state.library.all() : {};
  const rows = [];
  for (const [key, entry] of Object.entries(state.index.videos)) {
    const record = records[key];
    if (!record || !(entry.people || []).length) continue;
    const models = record.models || [];
    if (!models.some((m) => m.toLowerCase() === want)) continue;
    rows.push({
      key,
      name: entry.name || '',
      rating: record.rating || 0,
      solo: models.length === 1,
      faces: entry.people[0].n || 0,
    });
  }
  rows.sort((a, b) => Number(b.solo) - Number(a.solo) || b.faces - a.faces);
  const centroid = state.centroids.get(model);
  // Most like the rest of her first, so the panel opens on faces that are
  // actually hers. The odd ones stay in the list, and stay in her average --
  // they are part of what the match was made against, and hiding them would
  // make the lineup a nicer picture of a less honest answer.
  let odd = 0;
  if (centroid) {
    const agreement = agreementWithin(centroid);
    for (const row of rows) row.agrees = agreement.has(row.key)
      ? Math.round(agreement.get(row.key) * 100) / 100 : null;
    odd = rows.filter((r) => r.agrees !== null && r.agrees < SAME_PERSON).length;
    rows.sort((a, b) => (b.agrees ?? -1) - (a.agrees ?? -1)
      || Number(b.solo) - Number(a.solo) || b.faces - a.faces);
  }
  return {
    model,
    total: rows.length,
    odd,
    // How many of hers the average is actually built from, which is not the
    // same as how many she is in.
    contributing: centroid ? centroid.count : 0,
    faces: rows.slice(0, Math.max(1, Math.min(24, limit))),
  };
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
  const have = state.index.videos[key];
  if (have && !opts.force) return have;
  const faces = await engine.facesIn(file, opts);
  const groups = faces.length >= 2 ? engine.groupFaces(faces) : [];
  const people = groups
    .filter((g, i) => i === 0 || g.faces >= MIN_GROUP)
    .slice(0, 4)
    .map((g) => ({ n: g.faces, vec: packVector(g.vector) }));

  const entry = {
    at: Date.now(), faces: faces.length, people, name: path.basename(file),
    gen: HARVEST_GEN,
  };
  state.index.videos[key] = entry;
  await writeEntry(key, entry);

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

/**
 * Folders that are never a video library and are expensive to prove empty.
 *
 * AppData in particular contains junctions that point at their own ancestors --
 * "Application Data" inside "AppData\Local" is the classic one -- so walking it
 * without a loop guard does not finish at all.
 */
const NEVER_WALK = new Set([
  'appdata', 'application data', 'local settings', 'windows', 'program files',
  'program files (x86)', 'programdata', 'node_modules', '$recycle.bin',
  'system volume information', 'onedrivetemp', 'temp', 'tmp', '.cache', '.git',
]);

const skipDir = (name) => name.startsWith('$') || name.startsWith('.')
  || NEVER_WALK.has(name.toLowerCase());

const inside = (child, parent) => {
  const c = path.resolve(child).toLowerCase();
  const r = path.resolve(parent).toLowerCase();
  return c === r || c.startsWith(r + path.sep);
};

/**
 * Which folders the sweep should cover.
 *
 * Opening a folder authorises reading it, and one of those can easily be a
 * parent of the library -- C:\Users\User was in the list here, put there by a
 * single browse. Taking the outermost root then turns a video sweep into a walk
 * of the whole user profile: hundreds of thousands of files that are not videos,
 * and junction loops that never terminate.
 *
 * So a root above the home folder is not honoured as itself; it becomes the home
 * folder. The sweep can be narrower than what you have opened, never wider.
 */
function sweepRoots() {
  // Everything resolved to one form first. Comparing a resolved path against an
  // unresolved one makes each look like it is inside the other, and the pair
  // then cancels out -- which emptied the sweep entirely.
  const raw = state.homeOf ? state.homeOf() : '';
  const home = raw ? path.resolve(raw) : '';
  const bounded = [];
  const add = (dir) => {
    if (!bounded.some((r) => r.toLowerCase() === dir.toLowerCase())) bounded.push(dir);
  };
  for (const root of state.rootsOf().filter(Boolean).map((r) => path.resolve(r))) {
    // Above the library: stand at the library instead.
    if (home && inside(home, root) && !inside(root, home)) add(home);
    else add(root);
  }
  if (home && !bounded.length) add(home);
  // Then the usual: a root inside another would walk the same tree twice.
  return bounded.filter((r) => !bounded.some((other) => other !== r && inside(r, other)));
}

/** Every downloaded video under the folders the sweep covers. */
async function walkForWork() {
  const work = [];
  const onDisk = new Set();
  const seen = new Set();
  const visited = new Set();

  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth >= 12 || skipDir(e.name)) continue;
        // A junction pointing back up its own tree would otherwise recurse for
        // ever, which is exactly what walking the user profile did.
        const real = path.resolve(full).toLowerCase();
        if (visited.has(real)) continue;
        visited.add(real);
        await walk(full, depth + 1);
      } else if (/\.(mp4|m4v|mov|mkv|webm)$/i.test(e.name)) {
        let stat;
        try { stat = await fsp.stat(full); } catch { continue; }
        if (isCloudOnly(stat)) continue;
        const key = keyFor(stat);
        onDisk.add(key);
        if (seen.has(key)) continue;
        const have = state.index.videos[key];
        // Read at the current settings: nothing to do. Read at older ones: worth
        // doing again, but only once everything unread has had its turn.
        if (have && (have.gen || 0) >= HARVEST_GEN) continue;
        if ((state.failures.get(key) || 0) >= 2) continue;
        seen.add(key);
        work.push({ file: full, stat, key, redo: Boolean(have) });
      }
    }
  }

  for (const root of sweepRoots()) {
    const real = path.resolve(root).toLowerCase();
    if (visited.has(real)) continue;
    visited.add(real);
    await walk(root, 0);
  }
  state.onDisk = onDisk;
  state.counted = { downloaded: onDisk.size, at: Date.now() };
  return prioritise(work);
}

/**
 * What to read first.
 *
 * The obvious order -- unnamed videos first, since that is where a suggestion
 * is worth most -- is exactly wrong, and was how this shipped. Nothing can be
 * suggested until somebody has an average face, and averages are built only
 * from videos that already carry a name. Starting with the unnamed ones means
 * hours of reading that produces no suggestion at all, and an empty lineup to
 * check the first one against.
 *
 * So the credited videos come first, and round-robin rather than performer by
 * performer: six each across everyone is a working index, where sixty of one
 * woman is one working performer. Then the unnamed videos it is all for, and
 * then the rest -- deeper coverage of people already recognised, and the
 * two-handers that no average can be built from.
 */
function prioritise(work) {
  const records = state.library ? state.library.all() : {};
  const modelsOf = (w) => ((records[w.key] || {}).models || []);

  const byPerformer = new Map();
  const unnamed = [];
  const rest = [];
  // Already answered, just at older settings. Last, always: a video nobody has
  // looked at beats a better look at one already covered.
  const again = [];
  for (const item of work) {
    if (item.redo) { again.push(item); continue; }
    const models = modelsOf(item);
    if (models.length === 1) {
      const name = models[0];
      if (!byPerformer.has(name)) byPerformer.set(name, []);
      byPerformer.get(name).push(item);
    } else if (!models.length) unnamed.push(item);
    else rest.push(item);
  }

  // Enough of one performer to be recognisable, twice over: the first pass
  // makes her nameable, the second makes her average steady.
  const ENOUGH = MIN_VIDEOS * 2;
  const seeding = [];
  const deeper = [];
  for (let round = 0; ; round += 1) {
    let anyLeft = false;
    for (const vids of byPerformer.values()) {
      if (round >= vids.length) continue;
      anyLeft = true;
      (round < ENOUGH ? seeding : deeper).push(vids[round]);
    }
    if (!anyLeft) break;
  }
  return [...seeding, ...unnamed, ...deeper, ...rest, ...again];
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
 * A folder was opened that had not been before.
 *
 * The library is otherwise re-counted on a timer, and until that fires the
 * denominator is whatever the last sweep happened to see -- which on a fresh
 * install, before any folder is open, is almost nothing. So opening one counts
 * again straight away rather than in a quarter of an hour.
 */
function rootsChanged() {
  state.nextWalk = 0;
  start();
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
      // Nothing may be queued until the store is fully read: a video whose
      // profile has not loaded yet looks unread, and would be read again.
      if (state.loading) { await wait(250); continue; }
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
      state.lastRead = state.current;
      if (!state.startedAt) state.startedAt = Date.now();
      try {
        const entry = await profile(next.file, next.stat,
          { shouldStop: busy, force: next.redo });
        if (!entry.people.length && entry.faces < 2) {
          // Abandoned early because the app woke up, or genuinely faceless. A
          // second look costs one more read; a third would be stubbornness.
          const tries = (state.failures.get(next.key) || 0) + 1;
          state.failures.set(next.key, tries);
          // Abandoned midway rather than genuinely empty: drop it so it is read
          // again properly. Never for a re-read -- that would throw away a
          // working profile in exchange for an interrupted one.
          if (busy() && !next.redo) await dropEntry(next.key);
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
      state.done += 1;
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
    // What it is doing right now, in one word, so the UI does not have to
    // reconstruct it from four booleans.
    doing: !state.enabled ? 'paused'
      : state.loading ? 'loading'
        : state.walking ? 'counting'
          : state.current ? 'reading'
            : state.running ? 'waiting' : 'stopped',
    lastRead: state.lastRead,
    done: state.done,
    // Videos an hour, from this session's own work. Nothing to calibrate and it
    // answers the only question a progress readout is really asked.
    rate: state.done > 2 && state.startedAt
      ? Math.round((state.done / ((Date.now() - state.startedAt) / 3600000)))
      : 0,
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
    // Profiled, but before the sampling was made dense enough to see a second
    // performer. They work; they are queued to be read again.
    stale: keys.reduce((n, k) => n
      + ((state.index.videos[k].gen || 0) < HARVEST_GEN ? 1 : 0), 0),
    covering: sweepRoots(),
    model: engine.available().model,
    rebuilding: state.rebuilding,
  };
}

module.exports = {
  init, start, setEnabled, status, noteActivity, rootsChanged, decorate, writeDigest,
  suggestionsFor, rankFor,
  lineup, faceImageByKey, standing,
  // The reading order, for checking what a fresh install would do first.
  __queueForTest: walkForWork,
  faceImage, profile, rebuild, flush, keyFor, MIN_VIDEOS,
};
