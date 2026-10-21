'use strict';

/**
 * Things done to files: tags written into the MP4, the carry-over of labels and
 * profiles onto a copy that came back under a new modified time, and the move,
 * copy, rename and delete the page asks for.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');

// The key every store agrees on: size and modified time.
const { keyFor } = require('../shared/facets.js');

const { log, exists, ffLimit, run } = require('./util');
const { authoriseOrThrow, collapseRoots, rememberDest, state } = require('./config');
const { statWithCloud, recycle } = require('./files');
const { migrateCache } = require('./cache');
const { forgetWalks } = require('./walk');
const tree = require('../tree');

// ------------------------------------------------------- tags into the file

/**
 * Writes the sidecar's rating and tags into the MP4, so they travel with the
 * file to another device or a different player.
 *
 * This rewrites the whole container — there is no in-place edit for an `moov`
 * atom — which is why it is an explicit action rather than what an edit does by
 * default. Cloud placeholders are refused outright: writing to one would
 * download it first.
 */
async function embedTags(file) {
  const { stat, cloudOnly } = await statWithCloud(file);
  if (cloudOnly) {
    const err = new Error('Cloud-only: download it first, or tags would pull the whole file down');
    err.statusCode = 409;
    throw err;
  }

  const record = library.get(stat) || { rating: 0, tags: [] };
  const tags = record.tags || [];
  const tmp = path.join(state.CACHE_DIR, `embed-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);

  const args = [
    '-v', 'error', '-y',
    '-i', file,
    '-map', '0', '-c', 'copy', '-ignore_unknown',
    // Without this the muxer keeps only the keys it recognises, and drops
    // `rating` on the floor. Verified: with it, both round-trip.
    '-movflags', 'use_metadata_tags',
    '-metadata', `keywords=${tags.join('; ')}`,
    '-metadata', `rating=${record.rating || ''}`,
    '-metadata', 'rating_scale=10',
    tmp,
  ];

  try {
    await ffLimit(() => run('ffmpeg', args));
    // Copy over the original rather than renaming onto it: the file keeps its
    // identity, so OneDrive treats this as an edit instead of a delete plus a
    // create, and the temp never lands in the synced folder.
    await fsp.copyFile(tmp, file);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }

  const after = await fsp.stat(file);
  library.rekey(stat, after, path.basename(file));
  await migrateCache(file, stat, after);
  return { rating: record.rating || 0, tags, size: after.size };
}

// ------------------------------------------------------------ carry-over

/**
 * The same video, back under a new modified time.
 *
 * Everything known about a video -- labels, face profile, fingerprint, preview
 * frames -- is keyed by its size and modified time. A move between OneDrive
 * accounts is a copy and a delete, and the copy can come back with a new
 * modified time: to every store that is a brand-new video, and what was known
 * about the old one is stranded.
 *
 * So, every so often: every key some store knows that no file on disk has any
 * more ("gone"), against every file no store knows ("fresh"). Same size, to the
 * byte, is the test -- and then the same file name, or failing that the only
 * gone and the only fresh file of that size. Anything less certain is left
 * alone. Every carry is written to .video-explorer/carried-over.jsonl.
 */
let carrying = false;

/**
 * Which gone key each fresh file is, if it is certainly one -- the decision on
 * its own, with no disk and no stores, so it can be tested.
 *
 * `known` is every key some store holds, to the file name it was last seen
 * under ('' when only a face profile knows it); `present` is every key on disk,
 * to its video. Returns [[fromKey, video]]: a name match first, then the only
 * gone and the only unmatched fresh file of a size. Two candidates either way
 * and nothing is paired -- a wrong carry would put one video's labels on
 * another.
 */
function pairCarryOver(known, present) {
  const sizeOf = (key) => Number(key.split(':')[0]);
  const gone = new Map();  // size -> [{ key, name }]
  for (const [key, name] of known) {
    if (present.has(key)) continue;
    const size = sizeOf(key);
    if (!gone.has(size)) gone.set(size, []);
    gone.get(size).push({ key, name: String(name).toLowerCase() });
  }
  const fresh = new Map(); // size -> [video]
  for (const [key, v] of present) {
    if (known.has(key) || !gone.has(v.size)) continue;
    if (!fresh.has(v.size)) fresh.set(v.size, []);
    fresh.get(v.size).push(v);
  }

  const pairs = [];
  for (const [size, newcomers] of fresh) {
    const olds = gone.get(size).slice();
    const left = [];
    for (const v of newcomers) {
      const at = olds.findIndex((o) => o.name && o.name === path.basename(v.path).toLowerCase());
      if (at >= 0) pairs.push([olds.splice(at, 1)[0].key, v]);
      else left.push(v);
    }
    if (left.length === 1 && olds.length === 1) pairs.push([olds[0].key, left[0]]);
  }
  return pairs;
}

async function carryOver({ dry = false } = {}) {
  if (carrying) return { skipped: true };
  const faceKeys = faces.knownKeys();
  const printKeys = dupes.knownKeys();
  // Not until both stores have loaded: a key they have not read yet looks fresh.
  if (!faceKeys || !printKeys) return { skipped: true };
  carrying = true;
  try {
    const present = new Map();
    // The shared walk (tree.js), the same one the sweeps read.
    const videos = await tree.videos({ home: state.config.homeDir, roots: state.config.roots });
    for (const v of videos) {
      const entry = { path: v.path, size: v.stat.size, mtimeMs: v.stat.mtimeMs, cloudOnly: v.cloudOnly };
      present.set(keyFor(entry), entry);
    }
    if (!present.size) return { moved: 0 };

    const known = new Map(); // key -> the name it was last seen under, if any
    for (const [key, record] of Object.entries(library.all())) known.set(key, record.name || '');
    for (const [key, name] of printKeys) if (!known.get(key)) known.set(key, name);
    for (const key of faceKeys) if (!known.has(key)) known.set(key, '');

    const pairs = pairCarryOver(known, present);

    if (dry) return { dry: true, pairs: pairs.map(([from, v]) => ({ from, file: v.path })) };
    const lines = [];
    for (const [from, v] of pairs) {
      const oldStat = { size: v.size, mtimeMs: Number(from.split(':')[1]) };
      const newStat = { size: v.size, mtimeMs: v.mtimeMs };
      const to = keyFor(v);
      const had = { labels: Boolean(library.all()[from]) };
      library.rekey(oldStat, newStat, path.basename(v.path));
      had.profile = await faces.rekey(from, to);
      had.fingerprint = await dupes.rekey(from, to);
      await migrateCache(v.path, oldStat, newStat);
      lines.push(JSON.stringify({ when: new Date().toISOString(), from, to, file: v.path, ...had }));
      log(`carried over ${path.basename(v.path)} (${from} -> ${to})`);
    }
    if (lines.length) {
      await fsp.appendFile(path.join(state.ONEDRIVE_ROOT, '.video-explorer', 'carried-over.jsonl'),
        lines.join('\n') + '\n').catch(() => {});
    }
    return { moved: pairs.length };
  } finally {
    carrying = false;
  }
}

// ------------------------------------------------------------ file actions

/** Never silently clobber: pick "name (2).mp4" style suffixes instead. */
async function uniqueDestination(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = path.join(dir, base);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

/**
 * Where a move or copy may land. The source is held to the opened folders;
 * the destination to those, the home folder, a recent destination, or a
 * folder the picker opened this session -- the one explicit step a person
 * takes before choosing it. Anything else is a path nobody chose in the app.
 */
function authoriseDestination(dir) {
  const resolved = path.resolve(String(dir || ''));
  const lower = resolved.toLowerCase();
  const under = (root) => {
    const r = path.resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r + path.sep);
  };
  const ok = [...(state.config.roots || []), state.config.homeDir].filter(Boolean).some(under)
    || (state.config.recentDests || []).some((d) => path.resolve(d).toLowerCase() === lower)
    || (state.browsed && state.browsed.has(lower));
  if (!ok) {
    const err = new Error('Destination is not a folder chosen in the app: ' + resolved);
    err.statusCode = 403;
    throw err;
  }
  return resolved;
}

/** Different drive: a move is a copy and a delete, so a placeholder would be fetched whole. */
function differentVolume(a, b) {
  return path.parse(path.resolve(a)).root.toLowerCase() !== path.parse(path.resolve(b)).root.toLowerCase();
}

async function moveFile(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = await uniqueDestination(destDir, path.basename(src));
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest); // different volume: copy then remove
    await fsp.unlink(src);
  }
  return dest;
}

async function copyFileTo(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = await uniqueDestination(destDir, path.basename(src));
  await fsp.copyFile(src, dest);
  return dest;
}

async function renameFile(src, newName) {
  const clean = path.basename(newName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!clean) throw new Error('Invalid file name');
  const withExt = path.extname(clean) ? clean : clean + path.extname(src);
  const dest = path.join(path.dirname(src), withExt);
  if (path.resolve(dest).toLowerCase() !== path.resolve(src).toLowerCase() && await exists(dest)) {
    throw new Error('A file with that name already exists');
  }
  await fsp.rename(src, dest);
  return dest;
}

async function handleAction(body) {
  try {
    return await actOn(body);
  } finally {
    // And again once it is done: a listing asked for while the Recycle Bin
    // was still working read the folder as it was.
    forgetWalks();
    tree.invalidate();
  }
}

async function actOn(body) {
  const op = String(body.op || '');
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const results = [];
  // Whatever happens below moves or removes files, so every remembered walk is
  // about to describe a folder that no longer looks like that.
  forgetWalks();
  tree.invalidate();

  // Deletes go as one batch through one shell -- see recycle(). Twenty files
  // used to be twenty PowerShell launches in a row.
  if (op === 'delete') {
    const srcs = paths.map((raw) => authoriseOrThrow(raw));
    // Keys first: they are size and modified time, and neither can be had once
    // a file is in the Recycle Bin.
    const keys = new Map();
    for (const src of srcs) {
      try { keys.set(src, dupes.keyFor(await fsp.stat(src))); } catch { /* already gone */ }
    }
    const binned = await recycle(srcs);
    for (const src of srcs) {
      const got = binned.get(src);
      if (!got || !got.ok) {
        results.push({ path: src, ok: false, message: (got && got.message) || 'Recycle failed' });
        continue;
      }
      const key = keys.get(src);
      // A pair minus one member is not a pair -- the survivor must stop being
      // called a copy, or the Duplicates filter keeps listing it. And the file
      // is no longer anywhere, so it must stop being offered as somewhere else
      // this face can be found. Its profile is kept: restore it from the Bin
      // and the key is unchanged, so everything known comes back with it.
      if (key) dupes.forget(key);
      if (key) faces.forgetPath(key);
      results.push({ path: src, ok: true, message: 'Sent to Recycle Bin' });
    }
    return results;
  }

  for (const raw of paths) {
    const src = authoriseOrThrow(raw);
    try {
      if (op === 'move') {
        if (!body.dest) throw new Error('No destination folder given');
        const destDir = authoriseDestination(body.dest);
        // Moving into the current folder would mint a "name (2).mp4" duplicate
        // rather than doing nothing, so refuse it outright.
        if (path.dirname(src).toLowerCase() === destDir.toLowerCase()) {
          results.push({ path: src, ok: false, message: 'Already in that folder' });
        } else if (differentVolume(src, destDir) && (await statWithCloud(src)).cloudOnly) {
          // Across drives a move copies the bytes, and a placeholder has none
          // here -- Windows would fetch the whole film first.
          results.push({ path: src, ok: false, message: 'Cloud-only: it would be downloaded whole. Download it first.' });
        } else {
          const dest = await moveFile(src, destDir);
          rememberDest(path.dirname(dest));
          results.push({ path: src, ok: true, dest, message: 'Moved' });
        }
      } else if (op === 'copy') {
        if (!body.dest) throw new Error('No destination folder given');
        const destDir = authoriseDestination(body.dest);
        if ((await statWithCloud(src)).cloudOnly) {
          results.push({ path: src, ok: false, message: 'Cloud-only: it would be downloaded whole. Download it first.' });
          continue;
        }
        const dest = await copyFileTo(src, destDir);
        rememberDest(path.dirname(dest));
        results.push({ path: src, ok: true, dest, message: 'Copied' });
      } else if (op === 'rename') {
        const dest = await renameFile(src, String(body.newName || ''));
        results.push({ path: src, ok: true, dest, message: 'Renamed' });
      } else {
        const err = new Error('Unknown operation: ' + op);
        err.statusCode = 400;
        throw err;
      }
    } catch (err) {
      results.push({ path: src, ok: false, message: err.message || String(err) });
    }
  }

  return results;
}

module.exports = {
  embedTags, pairCarryOver, carryOver, handleAction, authoriseDestination, differentVolume,
};
