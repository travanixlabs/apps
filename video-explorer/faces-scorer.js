'use strict';

/**
 * Ranking every video against every performer, off the main thread.
 *
 * The arithmetic is not subtle -- a dot product of two unit vectors, thirty
 * thousand faces against eight hundred averages -- but there is a lot of it:
 * twelve billion multiply-adds, measured at just under twenty seconds in the
 * server's own thread. For most of those twenty seconds the app answered
 * nothing at all: a rating, a tag, a folder listing, all queued behind a sum
 * nobody was waiting for. This is that sum, moved somewhere it cannot do that.
 *
 * Two things make it quick as well as invisible:
 *
 *   The matrix    Vectors arrive as one flat Float32Array and stay that way.
 *                 Four averages are walked at a time so each face is loaded
 *                 from memory once instead of four times.
 *
 *   The memory    A full pass keeps the best TOP_K performers per face, not
 *                 just the winner. When one performer's average moves -- which
 *                 is what naming somebody does -- only her column is worked
 *                 out again and merged into what is already known: one column
 *                 of eight hundred rather than all of them.
 *
 * Refusals are deliberately NOT part of the ranking. A name you have turned
 * down on a video is skipped when the winner is picked, not when the scores are
 * computed, so changing your mind costs nothing and the cached ranking stays
 * valid. TOP_K is the headroom that allows; a row whose K is exhausted is
 * handed back in `short` for the caller to work out exactly.
 */

const { parentPort } = require('worker_threads');

const TOP_K = 8;

/** The face matrix, as sent once and reused until it changes. */
let V = null;
/** The performer averages of the last pass. */
let C = null;
/** Per face row: the TOP_K best averages and their scores, best first. */
let topIdx = null;
let topScore = null;
/**
 * Rows whose K has been dented by an incremental update -- a score that fell
 * out of the list leaves a gap that only a full pass can honestly fill. It
 * costs nothing until refusals reach that far down, which is what `short` is.
 */
let holes = null;

function normalise(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) sum += vec[i] * vec[i];
  const len = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / len;
  return out;
}

/**
 * Where each video's dominant face sits in the matrix.
 *
 * An average is built from person 0 of each of her videos, so that is the row
 * to take back out again when a video is scored against an average it helped
 * build.
 */
function indexOwners() {
  const row0 = new Int32Array(V.nOwners).fill(-1);
  for (let r = 0; r < V.nRows; r += 1) {
    if (V.person[r] === 0 && row0[V.owner[r]] < 0) row0[V.owner[r]] = r;
  }
  V.row0 = row0;
}

/**
 * For each video, the performer whose average it is part of.
 *
 * At most one: an average is built from solo credits, so a video with one name
 * on it contributes to exactly that one performer. Kept as a Map of the
 * exceptions rather than a row per video, since two thirds of the library is
 * credited to nobody.
 */
function indexMembership() {
  const byOwner = new Map();
  for (let c = 0; c < C.count; c += 1) {
    for (let i = C.memberStart[c]; i < C.memberStart[c + 1]; i += 1) {
      const owner = C.memberOwner[i];
      const held = byOwner.get(owner);
      if (held === undefined) byOwner.set(owner, c);
      else if (Array.isArray(held)) held.push(c);
      else byOwner.set(owner, [held, c]);
    }
  }
  C.byOwner = byOwner;
}

/** The centroids this row helped build, as a plain array (usually empty). */
function membersOf(owner) {
  const held = C.byOwner.get(owner);
  if (held === undefined) return null;
  return Array.isArray(held) ? held : [held];
}

/**
 * The average `c` would be if this video were not in it.
 *
 * A video already credited to her is otherwise scored against an average
 * containing itself, which flatters it and makes the confirmation worthless.
 * Null when what is left is too thin to stand up -- which is a performer the
 * video is not ranked against at all, exactly as the in-process path does.
 */
function centroidWithout(c, owner) {
  if (C.countOf[c] <= C.minVideos) return null;
  const row = V.row0[owner];
  if (row < 0) return C.vec.subarray(c * V.dim, (c + 1) * V.dim);
  const dim = V.dim;
  const sum = new Float32Array(dim);
  const base = c * dim;
  const mine = row * dim;
  for (let i = 0; i < dim; i += 1) sum[i] = C.sum[base + i] - V.mat[mine + i];
  return normalise(sum);
}

/** One face against one performer, with the leave-one-out rule applied. */
function scoreOne(r, c) {
  const dim = V.dim;
  const owner = V.owner[r];
  const mineBase = r * dim;
  const members = membersOf(owner);
  if (members && members.includes(c)) {
    const against = centroidWithout(c, owner);
    if (!against) return -Infinity;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += V.mat[mineBase + i] * against[i];
    return dot;
  }
  const base = c * dim;
  let dot = 0;
  for (let i = 0; i < dim; i += 1) dot += V.mat[mineBase + i] * C.vec[base + i];
  return dot;
}

/** Slots the pair (score, centroid) into one row's best-K, best first. */
function offer(r, score, c) {
  if (!(score > -Infinity)) return;
  const at = r * TOP_K;
  if (score <= topScore[at + TOP_K - 1]) return;
  let i = TOP_K - 1;
  while (i > 0 && topScore[at + i - 1] < score) {
    topScore[at + i] = topScore[at + i - 1];
    topIdx[at + i] = topIdx[at + i - 1];
    i -= 1;
  }
  topScore[at + i] = score;
  topIdx[at + i] = c;
}

/**
 * Every face against every performer.
 *
 * Four averages per inner pass: the face is the operand that gets reused, so
 * loading it once for four columns is most of the speed-up over the obvious
 * loop. A video that helped build one of these averages has that one score
 * substituted as the row is walked rather than corrected afterwards -- a
 * correction applied after the fact would have evicted a name that belonged in
 * the list.
 */
function fullPass() {
  const { dim, nRows, mat } = V;
  const nC = C.count;
  topIdx = new Int32Array(nRows * TOP_K).fill(-1);
  topScore = new Float32Array(nRows * TOP_K).fill(-Infinity);
  holes = new Uint8Array(nRows);
  if (!nC) return;

  const q = new Float32Array(dim);
  for (let r = 0; r < nRows; r += 1) {
    const mine = r * dim;
    for (let i = 0; i < dim; i += 1) q[i] = mat[mine + i];

    // At most one, in every library this can be given: one name on a video
    // means one average it belongs to. More than one falls back below.
    const members = membersOf(V.owner[r]);
    const fixC = members && members.length === 1 ? members[0] : -1;
    const fixScore = fixC >= 0 ? scoreOne(r, fixC) : -Infinity;
    if (members && members.length > 1) {
      for (let c = 0; c < nC; c += 1) offer(r, scoreOne(r, c), c);
      continue;
    }

    let c = 0;
    for (; c + 3 < nC; c += 4) {
      const b0 = c * dim;
      const b1 = b0 + dim;
      const b2 = b1 + dim;
      const b3 = b2 + dim;
      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      let d3 = 0;
      for (let i = 0; i < dim; i += 1) {
        const x = q[i];
        d0 += x * C.vec[b0 + i];
        d1 += x * C.vec[b1 + i];
        d2 += x * C.vec[b2 + i];
        d3 += x * C.vec[b3 + i];
      }
      offer(r, c === fixC ? fixScore : d0, c);
      offer(r, c + 1 === fixC ? fixScore : d1, c + 1);
      offer(r, c + 2 === fixC ? fixScore : d2, c + 2);
      offer(r, c + 3 === fixC ? fixScore : d3, c + 3);
    }
    for (; c < nC; c += 1) {
      if (c === fixC) { offer(r, fixScore, c); continue; }
      const base = c * dim;
      let dot = 0;
      for (let i = 0; i < dim; i += 1) dot += q[i] * C.vec[base + i];
      offer(r, dot, c);
    }
  }
}

/** Takes one centroid out of a row's best-K and offers its new score back. */
function replaceScore(r, c, score) {
  const at = r * TOP_K;
  let write = at;
  for (let i = at; i < at + TOP_K; i += 1) {
    if (topIdx[i] === c) continue;
    topIdx[write] = topIdx[i];
    topScore[write] = topScore[i];
    write += 1;
  }
  for (let i = write; i < at + TOP_K; i += 1) { topIdx[i] = -1; topScore[i] = -Infinity; }
  offer(r, score, c);
  // A score that fell out of the list took a place with it that this row can no
  // longer name. Harmless until refusals reach that far down.
  if (C.count >= TOP_K && topIdx[at + TOP_K - 1] < 0) holes[r] = 1;
}

/**
 * One performer's column, when her average has moved.
 *
 * Correct rather than approximate for the two names that matter: everything
 * her score displaced was at least as good as the K-th, and everything outside
 * the K was worse, so a winner and a runner-up picked from what is kept are the
 * same two a full pass would have found.
 */
function updateColumns(changed) {
  for (const c of changed) {
    for (let r = 0; r < V.nRows; r += 1) replaceScore(r, c, scoreOne(r, c));
  }
}

function bandFor(bands, score, margin) {
  for (const b of bands) if (score >= b.score && margin >= b.margin) return b.band;
  return '';
}

/**
 * The best two names for each face, and whether that is worth saying.
 *
 * Refusals are applied here, over the cached ranking, which is why turning a
 * name down never costs a re-score.
 */
function pick(refusals, bands) {
  const out = [];
  const perVideo = new Map();
  const short = new Set();
  for (let r = 0; r < V.nRows; r += 1) {
    const owner = V.owner[r];
    const refused = refusals[owner];
    const at = r * TOP_K;
    let first = -1;
    let second = -1;
    let kept = 0;
    for (let i = 0; i < TOP_K; i += 1) {
      const c = topIdx[at + i];
      if (c < 0) break;
      kept += 1;
      if (refused && refused.includes(C.names[c].toLowerCase())) continue;
      if (first < 0) first = i;
      else if (second < 0) second = i;
    }
    if (second < 0) {
      // Fewer than two names survived the refusals. "There is no second" is
      // only something this can say when the row holds every performer there
      // is; short of that the real runner-up may be one the K never kept, and
      // the caller works the video out in full. Which is the point of K: it
      // takes seven refusals on one video to get here.
      if (kept < C.count) short.add(owner);
      continue;
    }

    const score = topScore[at + first];
    const margin = score - topScore[at + second];
    const band = bandFor(bands, score, margin);
    if (!band) continue;
    const name = C.names[topIdx[at + first]];
    let list = perVideo.get(owner);
    if (!list) { list = []; perVideo.set(owner, list); }
    // The same performer suggested for two groups is one suggestion, not two.
    if (list.some((s) => s.name === name)) continue;
    list.push({
      name,
      score: Math.round(score * 1000) / 1000,
      margin: Math.round(margin * 1000) / 1000,
      band,
      person: V.person[r],
      videos: C.countOf[topIdx[at + first]],
      runnerUp: C.names[topIdx[at + second]],
    });
  }
  for (const [owner, list] of perVideo) {
    // Strongest first, not biggest-group first.
    list.sort((a, b) => b.score - a.score);
    out.push([owner, list]);
  }
  return { out, short: [...short] };
}

function handle(msg) {
  if (msg.type === 'vectors') {
    V = {
      dim: msg.dim,
      nRows: msg.nRows,
      nOwners: msg.nOwners,
      mat: msg.mat,
      owner: msg.owner,
      person: msg.person,
    };
    indexOwners();
    // The ranking was of the old matrix; it says nothing about this one.
    topIdx = null;
    topScore = null;
    holes = null;
    C = null;
    parentPort.postMessage({ type: 'ready', version: msg.version });
    return;
  }

  if (msg.type !== 'score') return;
  if (!V) {
    parentPort.postMessage({ type: 'scored', run: msg.run, out: [], short: [], unusable: true });
    return;
  }
  const previous = C;
  C = {
    count: msg.names.length,
    names: msg.names,
    vec: msg.vec,
    sum: msg.sum,
    countOf: msg.countOf,
    memberStart: msg.memberStart,
    memberOwner: msg.memberOwner,
    minVideos: msg.minVideos,
  };
  indexMembership();

  // Incremental only when the cast is the same one, in the same order, and the
  // caller can say which of them moved.
  const sameCast = Boolean(previous && topIdx && msg.changed
    && previous.count === C.count
    && previous.names.every((n, i) => n === C.names[i]));
  const started = Date.now();
  if (sameCast) updateColumns(msg.changed);
  else fullPass();

  const { out, short } = pick(msg.refusals || {}, msg.bands);
  parentPort.postMessage({
    type: 'scored',
    run: msg.run,
    out,
    short,
    incremental: sameCast,
    ms: Date.now() - started,
  });
}

parentPort.on('message', (msg) => {
  try {
    handle(msg);
  } catch (err) {
    parentPort.postMessage({
      type: 'failed', run: msg && msg.run, error: String((err && err.message) || err),
    });
  }
});
