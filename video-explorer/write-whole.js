'use strict';

/**
 * A file written whole or not at all.
 *
 * Everything the face index and the fingerprint store write lives in the sync
 * root, and a plain writeFile truncates first: a kill, a crash or a full disk
 * part way through leaves a torn file that OneDrive then faithfully uploads,
 * and the phone reads as nothing. Through a temporary name and a rename the old
 * version stays whole until the new one is complete. The temporary name carries
 * the pid and a sequence number so two writes of the same file -- a timer and a
 * shutdown flush -- cannot interleave inside one temporary file.
 *
 * OneDrive holds a handle on a synced file now and then and lets go a moment
 * later, so a refused rename is retried, as the label store's is. Still refused,
 * the old file is left alone and the caller hears about it.
 *
 * Moved here out of faces.js so the fingerprint store could use the same one
 * rather than a second copy; the label store keeps its own, because it also
 * merges and reschedules, which is its business and not this one's.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let tempSeq = 0;
const tempFor = (file) => {
  tempSeq += 1;
  return `${file}.${process.pid}-${tempSeq}.tmp`;
};

/**
 * The bytes are forced to the disk before the rename: without the fsync the
 * rename can be journalled ahead of the data, and a power cut in between
 * leaves the new name pointing at a file of zeros -- the one outcome the
 * temp-and-rename is there to prevent.
 */
async function writeSynced(temp, body) {
  const fh = await fsp.open(temp, 'w');
  try {
    await fh.writeFile(body);
    await fh.sync().catch(() => {}); // a filesystem that refuses is still a write
  } finally {
    await fh.close();
  }
}

async function writeWhole(file, body) {
  const temp = tempFor(file);
  await writeSynced(temp, body);
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rename(temp, file);
      return;
    } catch (err) {
      last = err;
      await new Promise((resolve) => { setTimeout(resolve, 60 * (i + 1)); });
    }
  }
  await fsp.unlink(temp).catch(() => {});
  throw last || new Error(`could not replace ${path.basename(file)}`);
}

/**
 * The same, for the few writes that have to finish before their caller returns.
 * No waiting between attempts -- there is no sleeping in synchronous code worth
 * doing -- so a refusal is tried again straight away, and then reported.
 */
function writeWholeSync(file, body) {
  const temp = tempFor(file);
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, body);
    try { fs.fsyncSync(fd); } catch { /* see writeSynced */ }
  } finally {
    fs.closeSync(fd);
  }
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (err) {
      last = err;
    }
  }
  try { fs.unlinkSync(temp); } catch { /* already gone */ }
  throw last || new Error(`could not replace ${path.basename(file)}`);
}

module.exports = { writeWhole, writeWholeSync, writeSynced };
