/* Where a preview strip lives, and how to build one without the app.
 *
 * The naming half is shared with server.js on purpose. A strip is addressed by
 * the file's size and modified time -- never its path -- so that anything
 * holding those two numbers can find it: the desktop, the phone over Graph,
 * and this. Two copies of that arithmetic in two files is how a cache ends up
 * half-addressable, so there is one copy and both callers use it.
 *
 * The building half is for downloaded files only. server.js keeps its own
 * builder because it also has to serve cloud placeholders over HTTPS, which
 * needs Graph, a URL cache and a concurrency cap none of which belong in a
 * headless tool. What is here is the local path: ten seeks on a file that is
 * already on the disk.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ------------------------------------------------------------------ naming

/** The tile box. 16:9, rounded to an even height so encoders do not complain. */
function tileDims(config = {}) {
  const tileW = Math.max(120, Math.min(640, Number(config.tileWidth) || 320));
  return { tileW, tileH: 2 * Math.round((tileW * 9 / 16) / 2) };
}

function frameCount(config = {}) {
  return Math.max(2, Math.min(24, Number(config.frames) || 10));
}

/** "s" = even-division spacing; the midpoint-spaced strips were "sprite-v2". */
function spriteSalt(config = {}) {
  return `s${frameCount(config)}x${tileDims(config).tileW}`;
}

/** A name anything holding the file's size and modified time can work out. */
function cacheName(stat, salt) {
  return `${stat.size}_${Math.round(stat.mtimeMs)}-${salt}.jpg`;
}

/** The sha1-over-the-path name strips carried before the rename. */
function legacyKey(file, stat, salt) {
  return crypto.createHash('sha1')
    .update([path.resolve(file), stat.size, Math.round(stat.mtimeMs), salt].join('|'))
    .digest('hex');
}

function spritePath(cacheDir, stat, config) {
  return path.join(cacheDir, cacheName(stat, spriteSalt(config)));
}

function legacySpritePath(cacheDir, file, stat, config) {
  const salt = `sprite-v2:${frameCount(config)}:${tileDims(config).tileW}`;
  return path.join(cacheDir, `${legacyKey(file, stat, salt)}.jpg`);
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

/**
 * The canonical path, moving a pre-rename strip onto it if that is where it
 * still is.
 *
 * Renaming rather than rebuilding: there are thousands of these, and a rebuild
 * is ten seeks and ten encodes to arrive at a file that already exists. The
 * sidecar comes too -- it carries how many frames actually rendered, which is
 * not always how many were asked for.
 */
async function adopt(cacheDir, file, stat, config) {
  const now = spritePath(cacheDir, stat, config);
  if (await exists(now)) return now;
  const was = legacySpritePath(cacheDir, file, stat, config);
  if (!(await exists(was))) return now;
  try {
    await fsp.rename(was, now);
    if (await exists(`${was}.json`)) await fsp.rename(`${was}.json`, `${now}.json`);
  } catch { /* locked or half-synced: it gets rebuilt instead */ }
  return now;
}

/** Is there a strip for this file already, under either name? */
async function has(cacheDir, file, stat, config) {
  return exists(await adopt(cacheDir, file, stat, config));
}

// ---------------------------------------------------------------- building

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Must stay in lockstep with segmentSeek() in server.js and segmentTime() in the UI. */
function segmentSeek(duration, index, count) {
  if (!(duration > 0)) return 0;
  const at = (duration * (index + 1)) / count;
  return Math.min(at, Math.max(0, duration - 1));
}

async function durationOf(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file,
  ]);
  return Number(JSON.parse(stdout || '{}').format?.duration) || 0;
}

/**
 * One strip for a downloaded file: N frames, letterboxed into identical boxes
 * and tiled into a single row.
 *
 * Identical boxes are the point -- the client addresses frame i with percentage
 * arithmetic, so a portrait video padded rather than stretched keeps the maths
 * honest and the picture the right shape.
 *
 * Seeks run one after another rather than at once. It is a local file, so the
 * cost is the decode; several at a time on one drive trades a streaming read
 * for a seeking one, which is the same reason the fingerprint sweep is
 * conservative about parallelism.
 */
async function build(cacheDir, file, stat, config) {
  const out = await adopt(cacheDir, file, stat, config);
  if (await exists(out)) return { file: out, frames: 0, cached: true };

  const frames = frameCount(config);
  const { tileW, tileH } = tileDims(config);
  const tmpDir = path.join(cacheDir, `tmp_${path.basename(out, '.jpg')}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const vf = [
    `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
    `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:black`,
  ].join(',');

  try {
    const duration = await durationOf(file);
    const got = [];
    for (let i = 0; i < frames; i += 1) {
      const raw = path.join(tmpDir, `raw${i}.jpg`);
      try {
        await run('ffmpeg', [
          '-hide_banner', '-loglevel', 'error',
          '-ss', segmentSeek(duration, i, frames).toFixed(3),
          '-i', file,
          '-frames:v', '1', '-vf', vf, '-q:v', '4', '-y', raw,
        ]);
        const st = await fsp.stat(raw).catch(() => null);
        if (st && st.size > 0) got.push(raw);
      } catch { /* a seek past the last keyframe, or a damaged region */ }
    }
    if (!got.length) throw new Error(`no frames from ${path.basename(file)}`);

    // ffmpeg's image2 demuxer needs a contiguous %d sequence.
    for (let i = 0; i < got.length; i += 1) {
      await fsp.rename(got[i], path.join(tmpDir, `f${i}.jpg`));
    }
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-start_number', '0',
      '-i', path.join(tmpDir, 'f%d.jpg'),
      '-filter_complex', `tile=${got.length}x1`,
      '-frames:v', '1', '-q:v', '4', '-y', out,
    ]);
    // The sidecar is how the app knows the strip holds nine frames, not ten.
    await fsp.writeFile(`${out}.json`,
      JSON.stringify({ frames: got.length, tileW, tileH })).catch(() => {});
    return { file: out, frames: got.length, cached: false };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  tileDims,
  frameCount,
  spriteSalt,
  cacheName,
  spritePath,
  legacySpritePath,
  adopt,
  has,
  build,
  segmentSeek,
};
