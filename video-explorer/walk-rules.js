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

module.exports = { NEVER_WALK, skipDir, STAT_BATCH, statAll };
