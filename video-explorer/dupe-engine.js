/**
 * Telling two files apart is easy. Telling two encodes of the same footage
 * apart from two different videos is not, and nothing in a file's metadata can
 * do it: the library holds thousands of clips off the same encoder farm at the
 * same geometry and the same bitrate, so a bucket of "same resolution, runtime
 * within two seconds, bitrate within one per cent" over 28,000 videos still
 * returns 73,000 candidate pairs. The names differ, the byte hashes differ, the
 * sizes differ. Only the content can answer.
 *
 * So this reads the content, and reads it twice over, because each signal has
 * a blind spot the other covers:
 *
 *   sound   -- a loudness trace. Survives re-encoding almost perfectly and is
 *              one-dimensional, so it aligns two copies to a fraction of a
 *              second. Blind to a copy that was re-dubbed, re-scored or muted.
 *   picture -- a perceptual hash per frame, plus the shot-change rhythm.
 *              Survives a bitrate change and a rescale. Blind to a copy that
 *              was cropped, letterboxed or watermarked differently.
 *
 * A verdict needs both to pass AND to agree on the same offset. Two
 * independent signals landing on the same alignment is not something that
 * happens by chance.
 *
 * The offset matters more than it sounds. The pair that prompted all this --
 * "Daughter gets fucked and tells dad not to (MCY0004)" and "Ghost father
 * fucks daughter until incontinence (MPG002)" -- are the same video, one
 * carrying 7.5s more leader than the other. Sampled at matched percentages of
 * their runtimes they score 29.6 of 64 bits apart, which is what two unrelated
 * videos score. Aligned first, they score 2.5. Align, then compare.
 *
 * Zero dependencies: ffmpeg and ffprobe on PATH, as everywhere else here.
 */

'use strict';

const { spawn } = require('child_process');

// ---------------------------------------------------------------- extraction

/** Audio is decoded at this rate, then binned down to ENVELOPE_HZ. */
const PCM_RATE = 1000;
/** Loudness samples per second kept in the fingerprint. */
const ENVELOPE_HZ = 4;
/** One perceptual hash per this many seconds. */
const FRAME_EVERY = 2;
/** How different two frames must be to count as a shot change. */
const SCENE_THRESHOLD = 0.35;
/** dHash geometry: 9 wide so 8 comparisons fit across, 8 rows deep. */
const HASH_W = 9;
const HASH_H = 8;

/** Collects a child process's stdout, and never rejects on a non-zero exit. */
function collect(args, { level = 'error' } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', level, ...args],
      { windowsHide: true });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', () => resolve({ out: Buffer.alloc(0), err: 'ffmpeg not runnable', code: -1 }));
    proc.on('close', (code) => {
      resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString(), code });
    });
  });
}

/**
 * The loudness trace: ENVELOPE_HZ points a second, each the mean absolute
 * amplitude over its window, log-scaled and zero-meaned.
 *
 * Log, because loudness is what the ear and the encoder both work in. Zero
 * mean, because one copy being mastered louder than the other must not count
 * as a difference -- correlation is then measuring shape alone.
 */
async function soundOf(file) {
  const { out } = await collect([
    '-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', 'pipe:1',
  ]);
  const hop = PCM_RATE / ENVELOPE_HZ;
  const points = Math.floor(out.length / 2 / hop);
  if (points < ENVELOPE_HZ * 20) return null;   // under 20s of audio: not worth it
  const env = new Float64Array(points);
  for (let i = 0; i < points; i += 1) {
    let sum = 0;
    for (let k = 0; k < hop; k += 1) sum += Math.abs(out.readInt16LE((i * hop + k) * 2));
    env[i] = Math.log1p(sum / hop);
  }
  return env;
}

/** 64-bit dHash of one HASH_W x HASH_H greyscale frame, as a BigInt. */
function hashFrame(buf, at) {
  let bits = 0n;
  for (let row = 0; row < HASH_H; row += 1) {
    for (let col = 0; col < HASH_H; col += 1) {
      const i = at + row * HASH_W + col;
      bits = (bits << 1n) | (buf[i] > buf[i + 1] ? 1n : 0n);
    }
  }
  return bits;
}

/**
 * The picture, in one read-through: a hash every FRAME_EVERY seconds and the
 * timestamps of every shot change.
 *
 * One decode for both, which is the whole point -- decoding is the expensive
 * part and neither signal is worth a pass of its own. The graph splits the
 * video, sends one branch through scene detection and the other to a stack of
 * tiny greyscale frames.
 *
 * The frames own stdout, so the cut times come back on stderr: `metadata=print`
 * writes to the log when given no file, and a log line is far easier to collect
 * than a temp file whose Windows path has to survive ffmpeg's filter syntax,
 * where a colon separates arguments and a backslash escapes them.
 */
async function pictureOf(file) {
  const { out, err } = await collect([
    '-i', file,
    '-filter_complex',
    `[0:v]split=2[det][grab];`
    + `[det]select='gt(scene\\,${SCENE_THRESHOLD})',metadata=print[cuts];`
    + `[grab]fps=1/${FRAME_EVERY},scale=${HASH_W}:${HASH_H},format=gray[frames]`,
    '-map', '[cuts]', '-an', '-f', 'null', '-',
    '-map', '[frames]', '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], { level: 'info' });

  const cuts = [...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));

  const frameBytes = HASH_W * HASH_H;
  const count = Math.floor(out.length / frameBytes);
  const hashes = new Array(count);
  for (let i = 0; i < count; i += 1) hashes[i] = hashFrame(out, i * frameBytes);

  return { hashes, cuts };
}

/**
 * Everything needed to compare this video with any other, in two ffmpeg runs.
 *
 * Audio and video are separate passes rather than one: the audio pass decodes
 * no pictures and the video pass decodes no sound, so between them they do
 * exactly the work required and nothing else.
 */
async function fingerprint(file) {
  const [sound, picture] = await Promise.all([soundOf(file), pictureOf(file)]);
  return {
    sound,                       // Float64Array | null
    hashes: picture.hashes,      // BigInt[]
    cuts: picture.cuts,          // seconds
  };
}

// ------------------------------------------------------------------ storage
//
// A fingerprint has to survive a restart, so it goes to disk as JSON. Floats
// and BigInts both need packing: the envelope quantises to a byte per point
// (its shape is what matters, not its precision) and the hashes are 8 bytes
// each. Both end up as base64, which is a third smaller than hex.

/** Quantise the envelope to bytes, keeping the scale needed to undo it. */
function packSound(env) {
  if (!env || !env.length) return null;
  let lo = Infinity; let hi = -Infinity;
  for (const x of env) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const span = hi - lo || 1;
  const bytes = Buffer.allocUnsafe(env.length);
  for (let i = 0; i < env.length; i += 1) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(((env[i] - lo) / span) * 255)));
  }
  return { lo, span, data: bytes.toString('base64') };
}

function unpackSound(packed) {
  if (!packed || !packed.data) return null;
  const bytes = Buffer.from(packed.data, 'base64');
  const env = new Float64Array(bytes.length);
  let mean = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    env[i] = packed.lo + (bytes[i] / 255) * packed.span;
    mean += env[i];
  }
  mean /= bytes.length || 1;
  // Zero-mean on the way out, so a level difference between two copies cannot
  // show up as a shape difference.
  for (let i = 0; i < env.length; i += 1) env[i] -= mean;
  return env;
}

function packHashes(hashes) {
  const buf = Buffer.allocUnsafe(hashes.length * 8);
  for (let i = 0; i < hashes.length; i += 1) buf.writeBigUInt64BE(hashes[i], i * 8);
  return buf.toString('base64');
}

function unpackHashes(text) {
  if (!text) return [];
  const buf = Buffer.from(text, 'base64');
  const out = new Array(Math.floor(buf.length / 8));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readBigUInt64BE(i * 8);
  return out;
}

/** The on-disk shape. Cuts become gaps: a gap is offset-proof, a time is not. */
function pack(fp) {
  return {
    v: 1,
    hz: ENVELOPE_HZ,
    every: FRAME_EVERY,
    sound: packSound(fp.sound),
    hashes: packHashes(fp.hashes),
    gaps: gapsOf(fp.cuts),
    cuts: fp.cuts.length,
  };
}

function unpack(row) {
  return {
    sound: unpackSound(row.sound),
    hashes: unpackHashes(row.hashes),
    gaps: row.gaps || [],
    hz: row.hz || ENVELOPE_HZ,
    every: row.every || FRAME_EVERY,
  };
}

// --------------------------------------------------------------- comparison

/**
 * The intervals between shot changes, to a tenth of a second.
 *
 * This is the part that is immune to trimming. A cut at 41.2s in one copy is a
 * cut at 33.7s in the other, but the gap from the previous cut is 12.7s in
 * both, because subtracting two timestamps cancels whatever leader was added.
 * Sixty-six numbers, about 130 bytes, and the pair that prompted this agree on
 * all sixty-six.
 */
function gapsOf(cuts) {
  const out = [];
  for (let i = 1; i < cuts.length; i += 1) {
    out.push(Math.round((cuts[i] - cuts[i - 1]) * 10) / 10);
  }
  return out;
}

const GAP_TOLERANCE = 0.15;

/**
 * The longest run of consecutive gaps two videos agree on.
 *
 * A run, not a count: any two videos share the odd gap by coincidence, but
 * agreeing on twenty in a row means the same shots in the same order.
 */
function longestRun(a, b) {
  if (!a.length || !b.length) return { len: 0, i: 0, j: 0 };
  let best = { len: 0, i: 0, j: 0 };
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    cur.fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (Math.abs(a[i - 1] - b[j - 1]) <= GAP_TOLERANCE) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.len) best = { len: cur[j], i: i - cur[j], j: j - cur[j] };
      }
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return best;
}

/**
 * Where two loudness traces line up, and how well.
 *
 * Normalised cross-correlation at every offset in range. The peak's height is
 * the verdict and its position is the offset; the height of the second-best
 * peak elsewhere says whether the first one means anything.
 */
function alignSound(x, y, hz, maxShiftSec = 180) {
  if (!x || !y || !x.length || !y.length) return null;
  const max = Math.round(maxShiftSec * hz);
  const floor = Math.round(30 * hz); // at least 30s of overlap to have an opinion
  let best = null;
  let second = -1;
  for (let s = -max; s <= max; s += 1) {
    const from = Math.max(0, -s);
    const to = Math.min(x.length, y.length - s);
    if (to - from < floor) continue;
    let num = 0; let dx = 0; let dy = 0;
    for (let i = from; i < to; i += 1) {
      const a = x[i]; const b = y[i + s];
      num += a * b; dx += a * a; dy += b * b;
    }
    if (!dx || !dy) continue;
    const r = num / Math.sqrt(dx * dy);
    if (!best || r > best.r) {
      if (best && Math.abs(best.shift - s) > hz * 3) second = Math.max(second, best.r);
      best = { r, shift: s, overlap: to - from };
    } else if (Math.abs(best.shift - s) > hz * 3 && r > second) {
      second = r;
    }
  }
  if (!best) return null;
  return {
    r: best.r,
    offset: best.shift / hz,
    background: second,
    overlap: best.overlap / hz,
  };
}

const popcount = (v) => {
  let n = 0;
  let x = v;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};

/**
 * Where two hash sequences line up, and how closely.
 *
 * Deliberately independent of the sound: it finds its own offset. Two signals
 * that agree on an alignment they each found alone is the strongest evidence
 * available here, and it costs nothing extra to have them work separately.
 */
function alignPicture(a, b, every, maxShiftSec = 180) {
  if (!a.length || !b.length) return null;
  const max = Math.round(maxShiftSec / every);
  const floor = Math.max(4, Math.round(30 / every));
  let best = null;
  let second = 64;
  for (let s = -max; s <= max; s += 1) {
    const from = Math.max(0, -s);
    const to = Math.min(a.length, b.length - s);
    if (to - from < floor) continue;
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += popcount(a[i] ^ b[i + s]);
    const mean = sum / (to - from);
    if (!best || mean < best.mean) {
      if (best && Math.abs(best.shift - s) > 3) second = Math.min(second, best.mean);
      best = { mean, shift: s, overlap: to - from };
    } else if (Math.abs(best.shift - s) > 3 && mean < second) {
      second = mean;
    }
  }
  if (!best) return null;
  return {
    bits: best.mean,
    offset: best.shift * every,
    background: second,
    overlap: best.overlap * every,
  };
}

// ------------------------------------------------------------------ verdict
//
// The thresholds come from measurement, not taste. On the pair that prompted
// this, against a control from the same folder and the same encoder:
//
//   sound    0.982 aligned   vs 0.081 unrelated
//   picture  2.5 bits        vs 32.3 unrelated (32 is what random bits give)
//   cuts     66 of 66 gaps   vs 1 of 66
//
// The gap between "same" and "unrelated" is an order of magnitude on every
// axis, so the bar sits in the middle of a very wide empty space.
//
// The picture bar is looser than the hand measurement suggests, and for a
// reason worth writing down: hashes are stored on a fixed FRAME_EVERY grid, so
// an offset that falls between two grid points can never be compared exactly.
// This pair's 7.5s offset sits halfway between grid points, leaving half a
// second of residual misalignment -- and half a second alone costs about 9 of
// the 64 bits. It scores 11.08 through the stored grid where hand-seeking to
// the exact offset scored 2.5. Unrelated pairs sit at 27 to 31 (32 is what
// random bits give), so 18 is still comfortably inside the empty space, and
// the mean is taken over the whole overlap -- a shared studio logo at the top
// of two different videos cannot drag it down.

const SOUND_PASS = 0.75;
const PICTURE_PASS = 18;
const OFFSET_AGREE = 2.5;
const RUN_PASS = 8;

/**
 * Compare two unpacked fingerprints.
 *
 * Returns what each signal said and what the two of them together mean, rather
 * than a bare yes: a review list wants to show its working, and a pair that
 * only one signal likes is exactly the pair a person should look at.
 */
function compare(a, b, opts = {}) {
  const maxShift = opts.maxShiftSec || 180;
  const hz = Math.min(a.hz, b.hz);
  const every = Math.max(a.every, b.every);

  const sound = alignSound(a.sound, b.sound, hz, maxShift);
  const picture = alignPicture(a.hashes, b.hashes, every, maxShift);
  const run = longestRun(a.gaps, b.gaps);

  const soundSays = Boolean(sound && sound.r >= SOUND_PASS);
  const pictureSays = Boolean(picture && picture.bits <= PICTURE_PASS);
  const cutsSay = run.len >= RUN_PASS;
  const agree = Boolean(sound && picture
    && Math.abs(sound.offset - picture.offset) <= OFFSET_AGREE);

  let verdict = 'no';
  if (soundSays && pictureSays && agree) verdict = 'duplicate';
  else if (soundSays && pictureSays) verdict = 'conflicted';   // both, on different offsets
  else if (soundSays || pictureSays || cutsSay) verdict = 'possible';

  return {
    verdict,
    offset: sound ? sound.offset : (picture ? picture.offset : 0),
    sound: sound ? { r: round(sound.r, 4), offset: round(sound.offset, 2), background: round(sound.background, 4) } : null,
    picture: picture ? { bits: round(picture.bits, 2), offset: round(picture.offset, 2), background: round(picture.background, 2) } : null,
    cuts: { run: run.len, of: Math.min(a.gaps.length, b.gaps.length) },
    agree,
  };
}

const round = (n, places) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

module.exports = {
  ENVELOPE_HZ,
  FRAME_EVERY,
  SOUND_PASS,
  PICTURE_PASS,
  RUN_PASS,
  fingerprint,
  pack,
  unpack,
  gapsOf,
  longestRun,
  alignSound,
  alignPicture,
  compare,
  popcount,
};
