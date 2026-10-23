'use strict';

/**
 * What every library walk agrees not to enter, and how it stats what it finds.
 *
 * There used to be three copies of this -- faces, fingerprints and framing each
 * carried their own -- and they had already drifted: the face sweep knew about
 * fifteen folders that are never a video library, the other two knew three. A
 * walk that skips AppData in one sweep and drowns in it in another is the kind
 * of difference nobody chose. One list, one skip rule, one batch size.
 */

const fsp = require('fs').promises;
const path = require('path');

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

/**
 * How many files are stat'ed at once while walking.
 *
 * Every stat in this library goes through OneDrive's filter driver, so awaiting
 * them one at a time spends the whole walk waiting on round trips. Measured over
 * the real 27,239 videos, interleaved and repeated so a warming cache could not
 * flatter either: one at a time took 2,518ms and then 6,663ms, sixty-four at a
 * time a steady 1,500ms.
 */
const STAT_BATCH = 64;

/** A folder's videos stat'ed together, keyed by path. */
async function statAll(files) {
  const out = new Map();
  for (let i = 0; i < files.length; i += STAT_BATCH) {
    const batch = files.slice(i, i + STAT_BATCH);
    const got = await Promise.all(batch.map((f) => fsp.stat(f).catch(() => null)));
    got.forEach((stat, j) => { if (stat) out.set(batch[j], stat); });
  }
  return out;
}

/**
 * A OneDrive placeholder: a file whose bytes are not here. Windows reports
 * the allocated size in blocks, and a placeholder has (nearly) none.
 */
function isCloudOnly(stat) {
  if (!stat.size) return false;
  return (stat.blocks || 0) * 512 < stat.size * 0.5;
}

/**
 * How many folders are read at once. Each read is a readdir and a batch of
 * stats, both round trips through OneDrive's filter driver; one folder at a
 * time left the disk idle between them. Eight keeps a few in flight without
 * turning a streaming read into a seeking one.
 */
const FOLDERS_AT_ONCE = 8;

/**
 * Every video under `roots`, depth first and in directory order -- the
 * order a one-folder-at-a-time walk gives -- with up to FOLDERS_AT_ONCE
 * folders being read at any moment. Only the reading is bounded: a folder
 * waiting on its subfolders holds no slot, so a deep tree cannot wedge it.
 *
 *   isVideo(entry)         which directory entries count
 *   skip(name, depth)      which folders are not entered
 *   visited                lower-cased folders already entered (junction loops)
 *   describe(full, stat)   what to return per video
 */
async function walkFolders(roots, { isVideo, skip, visited = new Set(), describe }) {
  let reading = 0;
  const queue = [];
  const slot = () => new Promise((resolve) => {
    if (reading < FOLDERS_AT_ONCE) { reading += 1; resolve(); } else queue.push(resolve);
  });
  const free = () => {
    const next = queue.shift();
    if (next) next(); else reading -= 1;
  };

  async function read(dir) {
    await slot();
    try {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
      const stats = await statAll(entries.filter(isVideo).map((e) => path.join(dir, e.name)));
      return { entries, stats };
    } finally {
      free();
    }
  }

  async function walk(dir, depth) {
    const got = await read(dir);
    if (!got) return []; // unreadable folder: skipped, not fatal
    const { entries, stats } = got;
    // Subfolders start reading now, together; their results are placed in
    // entry order below, so the output is the same as a serial walk's.
    const below = new Map();
    for (const e of entries) {
      if (!e.isDirectory() || skip(e.name, depth)) continue;
      const full = path.join(dir, e.name);
      const real = path.resolve(full).toLowerCase();
      if (visited.has(real)) continue;
      visited.add(real);
      below.set(e, walk(full, depth + 1));
    }
    const out = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (below.has(e)) {
        for (const v of await below.get(e)) out.push(v);
      } else if (isVideo(e)) {
        const stat = stats.get(full);
        if (!stat) continue; // gone between the readdir and the stat
        out.push(describe(full, stat));
      }
    }
    return out;
  }

  const out = [];
  for (const root of roots) {
    const real = path.resolve(root).toLowerCase();
    if (visited.has(real)) continue;
    visited.add(real);
    for (const v of await walk(root, 0)) out.push(v);
  }
  return out;
}

module.exports = { skipDir, statAll, isCloudOnly, walkFolders, FOLDERS_AT_ONCE };
