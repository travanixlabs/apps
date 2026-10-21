'use strict';

/**
 * The preview cache and the probed-metadata index: where a strip or a poster
 * lives, how one is built (locally or over HTTPS for a cloud file), how the
 * pre-rename names are adopted, and the one-off tidy of what they left behind.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const priority = require('../priority');
const library = require('../library');
// The cache-name arithmetic, shared with the headless strip builder so the two
// cannot drift apart. See strips.js.
const strips = require('../strips');

const {
  log, exists, loadJsonSync, createLimiter, ffLimit, graphLimit, run,
} = require('./util');
const { saveConfigSoon, collapseRoots, state } = require('./config');
const { graphStreamInfo } = require('./cloud');
const { isCloudOnly, collectVideos, recycle } = require('./files');
// The key every store agrees on, shared with the label store and the phone.
const { keyFor } = require('../shared/facets.js');

let metaIndex = {};   // cacheKey -> probed metadata

let metaTimer = null;
let metaDirty = false;

/**
 * The probed-metadata index, written whole.
 *
 * It is the one file here that is not write-once, so in a synced folder its
 * cadence matters: a second of debounce meant a rewrite -- and a re-upload --
 * every time a page of thumbnails settled. Twenty seconds coalesces a browsing
 * session into one write, and the close flushes whatever is left. The cost of
 * losing twenty seconds of it to a hard kill is a few ffprobe calls.
 */
function saveMetaSoon() {
  metaDirty = true;
  if (metaTimer) return;
  metaTimer = setTimeout(() => {
    metaTimer = null;
    metaDirty = false;
    fsp.writeFile(state.META_FILE, JSON.stringify(metaIndex)).catch(() => {});
  }, 20000);
}

function flushMeta() {
  if (!metaDirty) return;
  clearTimeout(metaTimer);
  metaTimer = null;
  metaDirty = false;
  try { fs.writeFileSync(state.META_FILE, JSON.stringify(metaIndex)); } catch { /* going down */ }
}

// The sha1-over-the-path name of the pre-rename cache, from strips.js -- the
// same arithmetic, so there is one copy of it.
const cacheKey = strips.legacyKey;

// ------------------------------------------------------------------ ffprobe

async function probe(file) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,r_frame_rate,duration',
    '-show_entries', 'format=duration,size,bit_rate',
    // Free to ask for while we have ffprobe open, and it is how tags written
    // into a file on another device find their way into this one's sidecar.
    '-show_entries', 'format_tags=keywords,rating,rating_scale',
    '-of', 'json',
    file,
  ];
  const { stdout } = await run('ffprobe', args);
  const parsed = JSON.parse(stdout || '{}');
  const stream = (parsed.streams && parsed.streams[0]) || {};
  const format = parsed.format || {};

  let fps = 0;
  if (typeof stream.r_frame_rate === 'string' && stream.r_frame_rate.includes('/')) {
    const [num, den] = stream.r_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  }

  const tags = format.tags || {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    codec: stream.codec_name || '',
    fps: Math.round(fps * 100) / 100,
    duration: Number(format.duration || stream.duration) || 0,
    bitrate: Number(format.bit_rate) || 0,
    embedded: {
      tags: String(tags.keywords || '').split(';').map((t) => t.trim()).filter(Boolean),
      rating: Number(tags.rating) || 0,
      // Written alongside the rating since ratings went to ten. A file without
      // it was rated out of five.
      scale: Number(tags.rating_scale) || 5,
    },
  };
}

/**
 * The other half of the round trip: a file carrying tags written on another
 * device seeds this machine's sidecar the first time it is probed. Only when
 * there is no local record, so a rating made here is never overwritten by a
 * staler one baked into the file.
 */
function adoptEmbedded(file, stat, meta) {
  const found = meta && meta.embedded;
  if (!found || library.get(stat)) return;
  if (!found.tags.length && !found.rating) return;
  // A probe cached before the scale moved has no `scale`, and was out of five.
  const rating = (found.scale === 10 ? found.rating : found.rating * 2) || 0;
  library.apply(stat, path.basename(file), { tags: found.tags, rating });
  log(`adopted embedded tags from ${path.basename(file)}`);
}

/**
 * Where a video's bytes are read from. A local file is read as itself. A
 * cloud-only placeholder is read over HTTPS from its Graph stream and never
 * opened: touching one byte of a placeholder makes Windows fetch the whole
 * film. When OneDrive cannot be asked -- signed out, throttled, offline --
 * that is a refusal, said as 409, and not a fall back to the placeholder: the
 * fall back is exactly the download the rest of the app is built to avoid,
 * and it was happening whenever the token had expired.
 */
async function cloudSource(file, stat) {
  if (!isCloudOnly(stat)) return null;
  const cloud = await graphStreamInfo(file).catch(() => null);
  if (cloud && cloud.url) return cloud;
  const err = new Error(`${path.basename(file)} is cloud-only and OneDrive could not be asked for it`
    + ' -- sign in, or download it first');
  err.statusCode = 409;
  err.cloudOnly = true;
  throw err;
}

async function getMeta(file, stat) {
  const known = cachedMeta(file, stat);
  if (known) return known;
  // Outside the try: a refusal is not a probe failure to remember.
  const cloud = await cloudSource(file, stat);
  let meta;
  try {
    // A cloud file is probed over HTTPS, never through its placeholder:
    // ffprobe wants a few KB of header, and reading one byte of a placeholder
    // makes Windows fetch the entire video. ffprobe takes a URL exactly as it
    // takes a path. The cache key is still path + size + mtime, none of which
    // change when the file is dehydrated, so this is read once either way.
    //
    // Whichever queue matches what the work actually waits on: ffLimit is sized
    // from the core count for local decoding, graphLimit is the network one. A
    // probe over HTTPS in an ffLimit slot would block local thumbnails while it
    // sat waiting on a CDN.
    meta = cloud
      ? await graphLimit(() => probe(cloud.url))
      : await ffLimit(() => probe(file));
  } catch (err) {
    meta = { width: 0, height: 0, codec: '', fps: 0, duration: 0, bitrate: 0, error: 'probe failed' };
  }
  metaIndex[metaKey(stat)] = meta;
  saveMetaSoon();
  return meta;
}

// ------------------------------------------------------------- sprite sheet

const spriteFrameCount = new Map(); // sprite path -> frames actually rendered

// --- cache paths -----------------------------------------------------------
// One definition per artefact so a route can ask "is this already built?"
// without going through the generator.

// strips.js takes the settings as an argument, since it also runs outside this
// process; here they are always the live config.
const tileDims = () => strips.tileDims(state.config);

/**
 * A cache name anything holding the file's size and modified time can work out.
 *
 * The old name was a sha1 over `path | size | mtime | salt`, and the path in it
 * is the one thing a phone never learns -- records are keyed by size and mtime
 * precisely so no path has to travel. That made 8,500 cached preview strips
 * sitting in the sync root unaddressable from the phone: readable, but
 * unfindable, so it seeks the video itself over mobile data instead of
 * fetching 17KB holding all ten frames.
 *
 * Size and mtime is the key every other store here already uses, and the geometry
 * stays in the name so changing the tile width still invalidates what it should.
 * Old names are renamed across as they are met -- see legacyCachePath.
 */
const { cacheName } = strips;

// "s" = even-division spacing; the midpoint-spaced sprites were "sprite-v2".
const spriteSalt = () => strips.spriteSalt(state.config);

const thumbSalt = () => `t${tileDims().tileW}`;

function thumbCachePath(file, stat) {
  return path.join(state.CACHE_DIR, cacheName(stat, thumbSalt()));
}

function spriteCachePath(file, stat) {
  return path.join(state.CACHE_DIR, cacheName(stat, spriteSalt()));
}

/**
 * How many strips are on the disk, counted by their sidecars.
 *
 * A strip is the only cached artefact that writes a .json beside itself -- the
 * frame count -- so counting those is one directory read rather than a stat per
 * video. The framing sweep subtracts what it can account for to report the rest
 * as kept for files no longer downloaded.
 */
async function countStrips() {
  try {
    const names = await fsp.readdir(state.CACHE_DIR);
    return names.reduce((n, name) => (name.endsWith('.jpg.json') ? n + 1 : n), 0);
  } catch {
    return 0;
  }
}

/**
 * Where this artefact would have been found before the rename, so an existing
 * one can be moved across rather than rebuilt.
 *
 * Rebuilding is not cheap: a strip is ten seeks and ten encodes, and for a video
 * since freed up to the cloud it is a download first. There are 8,500 of them.
 */
function legacyCachePath(file, stat, which) {
  const salt = which === 'sprite'
    ? `sprite-v2:${Math.max(2, Math.min(24, Number(state.config.frames) || 10))}:${tileDims().tileW}`
    : `thumb:${tileDims().tileW}`;
  return path.join(state.CACHE_DIR, cacheKey(file, stat, salt) + '.jpg');
}

/**
 * Moves one artefact onto its new name, if that is where it still is.
 *
 * Lazy by design: every strip the app draws converts itself, which covers the
 * folders actually in use within a session or two. `migrateCacheNames` sweeps up
 * the rest in the background.
 */
async function adoptLegacyCache(file, stat, which) {
  const now = which === 'sprite' ? spriteCachePath(file, stat) : thumbCachePath(file, stat);
  // Once tidyCache has run, nothing under the old names is left -- it adopted
  // what it could and recycled the rest -- so looking for one is two sha1s and
  // two filesystem round trips spent finding nothing, on every strip and
  // poster asked for.
  if (state.config.cacheTidyV3) return now;
  if (await exists(now)) return now;
  const was = legacyCachePath(file, stat, which);
  if (!(await exists(was))) return now;
  try {
    await fsp.rename(was, now);
    forgetStripNames();
    // The sidecar carries how many frames actually rendered, which is not always
    // what was asked for -- a very short video yields fewer.
    if (which === 'sprite' && await exists(was + '.json')) {
      await fsp.rename(was + '.json', now + '.json');
    }
  } catch { /* a locked or half-synced file simply gets rebuilt */ }
  return now;
}

/**
 * The geometry behind the names, so a reader that is not this process can build
 * one. Rewritten whenever it would differ, which is when the tile width or the
 * frame count changes.
 */
async function writeCacheManifest() {
  const { tileW, tileH } = tileDims();
  const body = JSON.stringify({
    version: 2,
    frames: Math.max(2, Math.min(24, Number(state.config.frames) || 10)),
    tileW,
    tileH,
    // Spelled out rather than left to be inferred: `<size>_<mtime>-<salt>.jpg`.
    sprite: spriteSalt(),
    thumb: thumbSalt(),
  });
  try {
    const at = path.join(state.CACHE_DIR, 'manifest.json');
    if (await fsp.readFile(at, 'utf8').catch(() => '') === body) return;
    await fsp.mkdir(state.CACHE_DIR, { recursive: true });
    await fsp.writeFile(at, body);
  } catch { /* an offline sync folder is not worth an error */ }
}

/**
 * The metadata index's key: size and modified time, like every other store.
 *
 * It used to be a sha1 over the PATH as well, which meant a moved or renamed
 * video was re-probed as a stranger and its old entry sat in the index
 * forever -- the file only ever grew. Size and mtime survive a move, a rename
 * and OneDrive dehydration alike, and it is the key the sidecar, the faces and
 * the fingerprints already trust.
 */
const metaKey = keyFor;

/**
 * Metadata already on disk for this exact file version. An entry written under
 * the old path-hashed key moves across the first time it is met.
 */
function cachedMeta(file, stat) {
  const key = metaKey(stat);
  if (metaIndex[key]) return metaIndex[key];
  // The tidy rekeyed every live entry and dropped every other old-style key, so
  // after it there is nothing to find -- and a listing asks this for every video
  // with no metadata, which at the library root is a sha1 each for most of
  // 28,000 files.
  if (state.config.cacheTidyV3) return null;
  const legacy = cacheKey(file, stat, 'meta');
  const held = metaIndex[legacy];
  if (!held) return null;
  metaIndex[key] = held;
  delete metaIndex[legacy];
  saveMetaSoon();
  return held;
}

/** Must stay in lockstep with segmentTime() in public/app.js. One copy, in strips.js. */
const { segmentSeek } = strips;

// How many cloud frames are fetched at once, ACROSS THE WHOLE APP. Four,
// measured: the CDN began refusing connections at six and above, and two left
// the machine waiting on latency. See the commit message for the numbers.
//
// Global rather than per strip, because ffLimit lets six strips build at once
// and six fours would be twenty-four connections to the same host.
const cloudSeekLimit = createLimiter(4);

/**
 * One frame of a cloud video, pulled straight from OneDrive over HTTPS.
 *
 * `-ss` goes BEFORE `-i` so ffmpeg seeks by byte range instead of decoding from
 * the beginning; the CDN answers 206, so this costs a few hundred KB rather
 * than the whole file. The local placeholder is never opened, so nothing
 * hydrates -- which is the entire point.
 */
function cloudFrame(url, seek, out, vf) {
  return cloudSeekLimit(async () => {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', seek.toFixed(3),
      // A CDN hiccup mid-strip should cost one frame's retry, not the strip.
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4',
      '-rw_timeout', '30000000',
      '-i', url,
      '-frames:v', '1',
      '-vf', vf,
      '-q:v', '4',
      '-y', out,
    ]);
    const st = await fsp.stat(out).catch(() => null);
    return Boolean(st && st.size > 0);
  });
}

/**
 * The ten frames of a cloud strip, four at a time, each retried once.
 *
 * A retry is worth having because the failures seen in testing were TCP
 * refusals from the CDN rather than anything wrong with the seek -- the same
 * seek succeeded moments later. Returns the files that came back, in order;
 * a strip missing a frame or two is still worth showing.
 */
async function cloudFrames(url, duration, frames, tmpDir, vf) {
  const wanted = Array.from({ length: frames }, (unused, i) => i);

  const got = await Promise.all(wanted.map(async (i) => {
    const seek = segmentSeek(duration, i, frames);
    const out = path.join(tmpDir, `raw${i}.jpg`);
    let ok = false;
    try { ok = await cloudFrame(url, seek, out, vf); } catch { ok = false; }
    if (!ok) {
      // The failures seen in testing were TCP refusals from the CDN rather than
      // anything wrong with the seek -- the same seek succeeded moments later.
      await new Promise((resolve) => { setTimeout(resolve, 400); });
      try { ok = await cloudFrame(url, seek, out, vf); } catch { ok = false; }
    }
    return ok ? out : null;
  }));

  // In order, gaps dropped: a strip missing a frame is still worth showing.
  return got.filter(Boolean);
}

/**
 * Builds an N-wide sprite strip. Every tile is letterboxed to the exact same
 * box, so the client can address frame i with pure percentage maths and
 * portrait videos are never stretched.
 */
async function ensureSprite(file, stat, { background = false } = {}) {
  const frames = Math.max(2, Math.min(24, Number(state.config.frames) || 10));
  const { tileW, tileH } = tileDims();

  const out = await adoptLegacyCache(file, stat, 'sprite');
  const key = path.basename(out, '.jpg');
  const sidecar = out + '.json';

  if (await exists(out)) {
    if (!spriteFrameCount.has(out)) {
      const info = loadJsonSync(sidecar, { frames });
      spriteFrameCount.set(out, info.frames || frames);
    }
    return { file: out, frames: spriteFrameCount.get(out) };
  }

  // Somebody has opened the player and is watching a spinner. For a cloud file
  // this is ten seeks over the network, so the background sweeps stand aside
  // until the strip is built -- see priority.js for why this, and only this.
  //
  // Not when the framing sweep is the one asking. Nobody is waiting on those,
  // and taking the hold would make the face and fingerprint sweeps stand aside
  // for hours of background work -- the exact opposite of what the hold is for.
  const givePriorityBack = background ? () => {} : priority.hold(path.basename(file));

  return ffLimit(async () => {
    if (await exists(out)) {
      return { file: out, frames: spriteFrameCount.get(out) || frames };
    }

    const tmpDir = path.join(state.CACHE_DIR, 'tmp_' + key);
    await fsp.mkdir(tmpDir, { recursive: true });

    const vf = [
      `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
      `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:black`,
    ].join(',');

    // A cloud file is read over HTTPS, never through its placeholder. Opening
    // the placeholder is what makes Windows download the whole video, so the
    // old path cost a full hydration per preview -- ten times over, in series.
    // Range requests cost a few hundred KB a frame and hydrate nothing.
    const cloud = await cloudSource(file, stat);

    let duration = 0;
    if (cloud) {
      duration = cloud.duration;
      if (!(duration > 0)) {
        // OneDrive had no video facet for this one, so ask ffmpeg -- still over
        // HTTP, because probing the local path would hydrate it.
        try {
          const { stdout } = await run('ffprobe', [
            '-hide_banner', '-loglevel', 'error',
            '-show_entries', 'format=duration', '-of', 'json', cloud.url,
          ]);
          duration = Number(JSON.parse(stdout).format?.duration) || 0;
        } catch { duration = 0; }
      }
    } else {
      const meta = await getMeta(file, stat);
      duration = meta.duration > 0 ? meta.duration : 0;
    }

    try {
      let extracted = [];
      if (cloud) {
        extracted = await cloudFrames(cloud.url, duration, frames, tmpDir, vf);
      } else {
        for (let i = 0; i < frames; i += 1) {
          // Even divisions: a 20-minute video split 10 ways gives 2:00, 4:00, …
          // The last is pulled a second short of the end to avoid a black frame.
          const seek = segmentSeek(duration, i, frames);
          const rawPath = path.join(tmpDir, `raw${i}.jpg`);
          try {
            await run('ffmpeg', [
              '-hide_banner', '-loglevel', 'error',
              '-ss', seek.toFixed(3),
              '-i', file,
              '-frames:v', '1',
              '-vf', vf,
              '-q:v', '4',
              '-y', rawPath,
            ]);
            const st = await fsp.stat(rawPath).catch(() => null);
            if (st && st.size > 0) extracted.push(rawPath);
          } catch {
            // A seek past the last keyframe or a damaged region: skip this tile.
          }
        }
      }

      if (extracted.length === 0) {
        const err = new Error('ffmpeg produced no frames for ' + path.basename(file));
        err.statusCode = 422;
        throw err;
      }

      // ffmpeg's image2 demuxer needs a contiguous %d sequence.
      for (let i = 0; i < extracted.length; i += 1) {
        await fsp.rename(extracted[i], path.join(tmpDir, `f${i}.jpg`));
      }

      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-start_number', '0',
        '-i', path.join(tmpDir, 'f%d.jpg'),
        '-filter_complex', `tile=${extracted.length}x1`,
        '-frames:v', '1',
        '-q:v', '4',
        '-y', out,
      ]);

      spriteFrameCount.set(out, extracted.length);
      await fsp.writeFile(sidecar, JSON.stringify({ frames: extracted.length, tileW, tileH })).catch(() => {});
      noteStrip(out);
      return { file: out, frames: extracted.length };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }).finally(givePriorityBack);
}

/**
 * A single poster frame. One ffmpeg seek instead of ten, so the grid fills
 * ~10x faster than sprite mode when live hovering supplies the motion.
 */
async function ensureThumb(file, stat) {
  const { tileW, tileH } = tileDims();
  const out = await adoptLegacyCache(file, stat, 'thumb');

  if (await exists(out)) return out;

  return ffLimit(async () => {
    if (await exists(out)) return out;
    // A cloud file's one frame comes over HTTPS like the strip's ten do; the
    // placeholder is never opened (see cloudSource).
    const cloud = await cloudSource(file, stat);
    const duration = cloud ? (Number(cloud.duration) || 0) : (await getMeta(file, stat)).duration;
    // A quarter in: past titles and fades, still representative.
    const seek = duration > 0 ? duration * 0.25 : 0;
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', seek.toFixed(3),
      '-i', cloud ? cloud.url : file,
      '-frames:v', '1',
      '-vf', [
        `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
        `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:black`,
      ].join(','),
      '-q:v', '4',
      '-y', out,
    ]);
    const st = await fsp.stat(out).catch(() => null);
    if (!st || st.size === 0) {
      const err = new Error('ffmpeg produced no poster for ' + path.basename(file));
      err.statusCode = 422;
      throw err;
    }
    return out;
  });
}

/**
 * Every strip currently on disk, as a set of file names.
 *
 * One directory listing answers "is this one framed?" for the whole library.
 * Asking the filesystem per video is what the framing sweep does, and it is
 * fine there -- it walks once, in the background, and is the only thing
 * waiting. A scan has a person waiting on it and 28,000 files to answer for.
 *
 * The name is derived from size and mtime alone, so membership is a lookup.
 * Strips built under the old naming were renamed across once (`cacheNamesV2`),
 * and any that were missed are adopted the next time one is actually drawn.
 */
// Half a minute. The listing is 30,000 names, and every scan, every filtered
// count and every file the framing walk passes asked for it afresh. What this
// app writes is added to the held set as it is written (noteStrip), so the only
// thing the age can hide is a strip another process built -- the command-line
// sweep, or another machine syncing one in -- and for those half a minute late
// is nothing.
const STRIP_NAMES_TTL_MS = 30 * 1000;
let stripNames = null;   // { at, names: Promise<Set> }

function cachedStripNames() {
  if (stripNames && Date.now() - stripNames.at < STRIP_NAMES_TTL_MS) return stripNames.names;
  const names = fsp.readdir(state.CACHE_DIR).then((list) => new Set(list), () => new Set());
  stripNames = { at: Date.now(), names };
  return names;
}

/**
 * A strip just written goes into the held set, rather than throwing the set
 * away: a sweep writes one every second or two, and each would otherwise cost
 * the next scan a fresh read of the whole directory. Added to the promise, so
 * a read still in flight gets it too.
 */
function noteStrip(file) {
  if (!stripNames) return;
  const name = path.basename(file);
  stripNames.names.then((set) => { set.add(name); set.add(`${name}.json`); });
}

/** For anything that renames or removes cache files: read the folder again. */
function forgetStripNames() {
  stripNames = null;
}

/**
 * Renames every cached strip and poster onto its derivable name, once.
 *
 * The lazy rename in adoptLegacyCache covers whatever the app draws, which
 * converts the folders in use but leaves the rest addressable only from here --
 * and the whole point of the new name is that something other than this process
 * can find it. So the roots are walked once, in the background, after the app is
 * already up: a stat per video and a rename per hit, no decoding at all.
 *
 * Runs one time. `cacheNamesV2` in config records that it has.
 */
async function migrateCacheNames() {
  if (state.config.cacheNamesV2) return { skipped: true };
  const started = Date.now();
  let seen = 0;
  let moved = 0;

  for (const root of collapseRoots(state.config.roots)) {
    let videos = [];
    try { videos = await collectVideos(root); } catch { continue; }
    for (const video of videos) {
      seen += 1;
      const stat = { size: video.size, mtimeMs: video.mtimeMs };
      for (const which of ['sprite', 'thumb']) {
        const was = legacyCachePath(video.path, stat, which);
        if (!(await exists(was))) continue;
        await adoptLegacyCache(video.path, stat, which);
        moved += 1;
      }
    }
  }

  state.config.cacheNamesV2 = true;
  saveConfigSoon();
  log(`cache names: ${moved} renamed across ${seen} videos in ${Date.now() - started}ms`);
  return { seen, moved };
}

/**
 * Sweeps up what the rename left behind, once.
 *
 * migrateCacheNames renamed every artefact it could still derive a legacy name
 * for -- but a legacy name hashes the PATH, so a video moved or deleted since
 * its strip was built left that strip unaddressable by anyone, forever. There
 * were 5,029 of them in the sync root when this was written, plus their
 * sidecars, plus the same class of orphan inside the metadata index.
 *
 * So: one walk of the roots to adopt anything still adoptable and to move each
 * live video's metadata onto its new key, and then everything STILL wearing a
 * 40-hex name -- on disk or in the index -- belongs to no video any walk can
 * find. Files go to the Recycle Bin, not deleted: they are previews, but they
 * are previews of videos that may be sitting in the Bin themselves.
 */
async function tidyCache() {
  if (state.config.cacheTidyV3) return { skipped: true };
  const started = Date.now();

  // The cache dir read once; adoption and orphan-hunting are both set lookups.
  let names;
  try { names = new Set(await fsp.readdir(state.CACHE_DIR)); } catch { return { skipped: true }; }

  let seen = 0;
  let adopted = 0;
  let rekeyed = 0;
  for (const root of collapseRoots([...state.config.roots, state.config.homeDir].filter(Boolean))) {
    let videos = [];
    try { videos = await collectVideos(root); } catch { continue; }
    for (const video of videos) {
      seen += 1;
      const stat = { size: video.size, mtimeMs: video.mtimeMs };

      // The metadata of a live video moves onto its portable key.
      const legacy = cacheKey(video.path, stat, 'meta');
      if (metaIndex[legacy]) {
        const key = metaKey(stat);
        if (!metaIndex[key]) metaIndex[key] = metaIndex[legacy];
        delete metaIndex[legacy];
        rekeyed += 1;
      }

      for (const which of ['sprite', 'thumb']) {
        const was = path.basename(legacyCachePath(video.path, stat, which));
        if (!names.has(was)) continue;
        const now = cacheName(stat, which === 'sprite' ? spriteSalt() : thumbSalt());
        if (!names.has(now)) {
          await adoptLegacyCache(video.path, stat, which);
          adopted += 1;
          names.add(now);
        }
        // Renamed across, or redundant beside an already-rebuilt one: either
        // way the old name is spoken for and must not read as an orphan.
        names.delete(was);
        names.delete(`${was}.json`);
      }
    }
  }
  if (rekeyed) saveMetaSoon();

  // Everything still wearing the old name, on disk...
  const orphans = [...names].filter((n) => /^[0-9a-f]{40}\.jpg(\.json)?$/.test(n));
  let bytes = 0;
  for (const name of orphans) {
    try { bytes += (await fsp.stat(path.join(state.CACHE_DIR, name))).size; } catch { /* already gone */ }
  }
  const binned = await recycle(orphans.map((n) => path.join(state.CACHE_DIR, n)));
  const recycled = [...binned.values()].filter((r) => r.ok).length;

  // ...and in the index.
  let dropped = 0;
  for (const key of Object.keys(metaIndex)) {
    if (/^[0-9a-f]{40}$/.test(key)) { delete metaIndex[key]; dropped += 1; }
  }
  if (dropped) saveMetaSoon();

  state.config.cacheTidyV3 = true;
  saveConfigSoon();
  log(`tidied the cache: ${adopted} adopted, ${rekeyed} meta entries rekeyed, `
    + `${dropped} orphaned meta entries dropped, ${recycled} of ${orphans.length} `
    + `legacy files recycled (${Math.round(bytes / 1e6)} MB) `
    + `across ${seen} videos in ${Date.now() - started}ms`);
  return { seen, adopted, rekeyed, dropped, recycled };
}

/**
 * Artefacts are keyed by path + size + mtime, and embedding tags changes both
 * size and mtime — but not a single pixel. Carrying the cache across is the
 * difference between a free operation and re-encoding the file's previews.
 */
async function migrateCache(file, oldStat, newStat) {
  forgetStripNames();
  for (const build of [thumbCachePath, spriteCachePath]) {
    try {
      await fsp.rename(build(file, oldStat), build(file, newStat));
    } catch { /* nothing built for this file at the current settings */ }
  }
  // The strip's sidecar too: it says how many frames actually rendered, and a
  // strip without one is read as the full count -- wrong for a short video, and
  // the framing count tallies strips by their sidecars.
  try {
    await fsp.rename(`${spriteCachePath(file, oldStat)}.json`, `${spriteCachePath(file, newStat)}.json`);
  } catch { /* no sidecar, or no strip */ }
  // The frame count held in memory was for the old name.
  spriteFrameCount.delete(spriteCachePath(file, oldStat));
  const legacy = cacheKey(file, oldStat, 'meta');
  const held = metaIndex[metaKey(oldStat)] || metaIndex[legacy];
  if (held) {
    metaIndex[metaKey(newStat)] = held;
    delete metaIndex[metaKey(oldStat)];
    delete metaIndex[legacy];
    saveMetaSoon();
  }
}

/** Everything cached, gone: the folder emptied, and the index and counts with it. */
async function clearCache() {
  await fsp.rm(state.CACHE_DIR, { recursive: true, force: true });
  await fsp.mkdir(state.CACHE_DIR, { recursive: true });
  metaIndex = {};
  spriteFrameCount.clear();
  forgetStripNames();
}

/** The probed-metadata index, read once at startup. Says how many entries it holds. */
async function loadMetaIndex() {
  try {
    metaIndex = JSON.parse((await fsp.readFile(state.META_FILE, 'utf8')).replace(/^﻿/, ''));
  } catch { metaIndex = {}; }
  return Object.keys(metaIndex).length;
}

module.exports = {
  flushMeta, adoptEmbedded, getMeta, cloudSource, cacheName, spriteSalt, thumbCachePath,
  spriteCachePath, countStrips, adoptLegacyCache, writeCacheManifest,
  cachedMeta, ensureSprite, ensureThumb, cachedStripNames, migrateCacheNames,
  tidyCache, migrateCache, clearCache, loadMetaIndex,
};
