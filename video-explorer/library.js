'use strict';

/**
 * Ratings and tags for videos, stored beside the library rather than inside the
 * files.
 *
 * Writing a tag into an MP4 means rebuilding its `moov` atom, which rewrites the
 * entire file: 76MB of disk for a 20-byte tag, and for a cloud placeholder a
 * full download followed by a full re-upload. With 92% of this library in the
 * cloud, tagging in place is not a viable default — so edits land here, costing
 * nothing, and `embedTags()` in server.js pushes them into the file only when
 * asked.
 *
 * Records are keyed by size + modified time, not by path. That means a rename or
 * a move — inside the app or in Explorer — keeps the rating and tags attached,
 * and OneDrive dehydration doesn't disturb them either, since freeing a file's
 * bytes changes neither value.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
// The races, traits, tiers, rating scale and the key itself, shared with the
// filter, the face index and the phone so the lists cannot drift apart.
const {
  RACES, TRAITS, TIERS, DEFAULT_TIER, RATING_MAX, keyFor,
} = require('./shared/facets.js');
// Through the file log: these are the lines that say the labels were merged,
// refused, or left read-only, in an app with no console anyone can see.
const { log } = require('./server/util');
const { writeSynced } = require('./write-whole');
const { LOCAL_DIR } = require('./server/paths');

// Models are kept separate from tags rather than being a tag convention: they
// are a different kind of fact, they want their own filter facet, and a
// performer named "anal" would otherwise be indistinguishable from the tag.
// The studio is a single value, not a list: a video comes from one production
// house. Kept out of tags for the same reason models are — one allowed answer is
// a different shape of fact from "any number of these apply".
const EMPTY = {
  rating: 0, tags: [], models: [], studio: '', production: '', url: '', notModels: [],
  marks: [], settled: 0,
};

// A bookmark is a second and an icon. Kept here rather than in a file of its
// own because it is the same question the rating and the tags answer -- what do
// I know about this video -- and because this store is keyed by size and mtime,
// so a bookmark survives the file being renamed, moved, or freed up to the
// cloud, which a timestamp in a sidecar would not.
const MARK_LIMIT = 200;

/**
 * One bookmark, or null if there is nothing usable in it.
 *
 * The time is the identity: two marks at the same second are one mark, so
 * setting one twice swaps the icon rather than stacking a second pip nobody
 * can click.
 *
 * The icon is stored as a NAME, not as the picture -- `star`, not the character
 * or the file it is drawn with. public/icons.json decides what a name looks
 * like, so replacing the artwork restyles every bookmark ever made instead of
 * leaving old ones frozen as whatever was on screen the day they were saved.
 */
function normaliseMark(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.t);
  if (!Number.isFinite(at) || at < 0) return null;
  const icon = String(raw.icon || '').trim().slice(0, 40) || 'star';
  return { t: Math.round(at * 10) / 10, icon };
}

function normaliseMarks(list) {
  const byTime = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    const mark = normaliseMark(raw);
    if (mark) byTime.set(mark.t, mark);
  }
  return [...byTime.values()]
    .sort((a, b) => a.t - b.t)
    .slice(0, MARK_LIMIT);
}

// notModels is the answer to a suggestion: not who is in this video, but who
// the recogniser was told is not. It behaves like the other lists -- add,
// remove, replace -- so it costs nothing to carry here.
const LIST_FIELDS = ['tags', 'models', 'notModels'];

let FILE = '';
let data = { version: 1, records: {} };
let timer = null;

// How many daily snapshots to keep. At about 2MB each that is 30MB to hold a
// fortnight of history for the one thing here that cannot be regenerated from
// anything.
const KEEP_BACKUPS = 14;

// A write that loses this share of the records is treated as a mistake and the
// outgoing file backed up before it lands. A tenth of six thousand records is
// six hundred: far more than any editing session legitimately deletes, and
// exactly what a Replace-mode slip looks like from in here.
const BIG_DROP = 0.1;

// ...or this many, whatever the share. A tenth of 22,700 records is 2,270, and
// a slip that wipes a thousand labelled videos is not made safe by the library
// being big: past this many lost at once, the outgoing file is kept regardless.
const BIG_DROP_RECORDS = 200;

// The record count last written, so the next write can notice a collapse.
let lastWritten = 0;

// The file as this process last read or wrote it: the bytes, and the size and
// modified time they had on disk. Another writer -- the phone, this library
// open on a second PC, OneDrive restoring a version -- shows up as a stamp that
// no longer matches, and its changes are merged rather than written over.
let baseRaw = null;
let diskStamp = null;

// Writes run one at a time: two overlapping writes once shared a temp file and
// left a truncated library behind.
let writing = Promise.resolve();
let tempSeq = 0;

// Why writing is refused, or '' when it is fine. Set when the file exists but
// could not be read: an unreadable sidecar must not be silently replaced by the
// empty one this module would otherwise start from.
let readOnly = '';

/**
 * Lives in OneDrive by design: a couple of megabytes of irreplaceable
 * hand-entered judgement, and putting it in the sync root is what makes ratings
 * show up on every device running the app.
 *
 * The preview cache and the face profiles sit beside it now, in the same
 * .video-explorer folder. They were once kept local as regenerable bulk, which
 * undersold them — regenerating a preview means decoding the video again, and
 * for one since freed up to the cloud, downloading it first.
 */
function resolveFile(oneDriveRoot) {
  if (process.env.VIDEO_EXPLORER_LIBRARY) return process.env.VIDEO_EXPLORER_LIBRARY;
  if (oneDriveRoot) return path.join(oneDriveRoot, '.video-explorer', 'library.json');
  return path.join(LOCAL_DIR, 'library.json');
}

/**
 * Loads the sidecar, and decides whether it is safe to write.
 *
 * The distinction that matters is between a sidecar that is *absent* and one
 * that is merely *unreadable*. Absent means a new library: starting empty is
 * correct, and the first rating creates the file. Unreadable -- a half-synced
 * copy, a lock held by OneDrive, a truncated write -- means the records are
 * still there and this process simply cannot see them. Starting empty then is
 * indistinguishable from starting correct, right up until the first edit
 * replaces six thousand records with one.
 *
 * So an unreadable file leaves the module read-only. Browsing works; editing
 * says why it cannot. Restarting once the file reads again is the fix, and
 * nothing is lost in the meantime.
 */
async function init(oneDriveRoot) {
  FILE = resolveFile(oneDriveRoot);
  readOnly = '';
  let raw = null;
  try {
    raw = await fsp.readFile(FILE, 'utf8');
    baseRaw = raw;
    diskStamp = await stampOf(FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      readOnly = `${path.basename(FILE)} could not be read (${err.code || err.message})`;
    }
    data = { version: 1, records: {} };
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      // The same test adoptDisk makes: a records map, not a list or a string.
      if (parsed && parsed.records && typeof parsed.records === 'object' && !Array.isArray(parsed.records)) data = parsed;
      else readOnly = `${path.basename(FILE)} has no records in it`;
    } catch (err) {
      readOnly = `${path.basename(FILE)} is not valid JSON (${err.message})`;
    }
  }
  // OneDrive's own conflict copies, made when two machines rewrote the file
  // inside one sync window: nothing read them, so whatever the losing machine
  // labelled since its last merge was simply gone. Each is merged in now and
  // moved aside, so it is read exactly once.
  if (!readOnly) await adoptForks();
  // A file written before favourites existed has no list; the rest of the module
  // may then assume there is one.
  if (!Array.isArray(data.favourites)) data.favourites = [];
  if (!data.races || typeof data.races !== 'object' || Array.isArray(data.races)) data.races = {};
  lastWritten = Object.keys(data.records).length;
  await noteStaleTemps();
  // Today's copy, taken before this session can change anything.
  if (!readOnly && raw !== null) await dailyBackup(raw);
  // Five stars became ten. Done once, on whichever device reads the file
  // first: every rating doubles and the file says so, so a second reader --
  // the phone, or this app tomorrow -- finds nothing left to do. A copy of
  // the file as it was goes into backups first, whatever the daily one did.
  if (!readOnly && raw !== null && data.ratingScale !== RATING_MAX) {
    await snapshot(raw);
    let moved = 0;
    for (const record of Object.values(data.records)) {
      const was = Math.round(Number(record.rating) || 0);
      if (was > 0) {
        record.rating = Math.min(RATING_MAX, was * 2);
        moved += 1;
      }
    }
    data.ratingScale = RATING_MAX;
    save();
    log(`library: ratings moved ${moved} to the ten-star scale`);
  }
  return { file: FILE, count: lastWritten, readOnly };
}

/**
 * A temporary file left beside the library by a write that never finished --
 * the process died between writing it and renaming it across.
 *
 * Said out loud and otherwise left alone. It is not adopted: the library itself
 * is whole (that is what the rename buys), and a half-written temporary file
 * is either a torn copy or an older one, neither of which should replace it.
 * It is not deleted either, in case it is the only copy of something.
 */
async function noteStaleTemps() {
  let names = [];
  try { names = await fsp.readdir(path.dirname(FILE)); } catch { return; }
  const base = path.basename(FILE).toLowerCase();
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(base + '.') && lower.endsWith('.writing')) {
      log(`library: found ${name} from a write that did not finish -- left as it is`);
    }
  }
}

const backupDir = () => path.join(path.dirname(FILE), 'backups');

// "library-DESKTOP-Q5R7O53.json": what OneDrive leaves beside the file when
// another machine's write lost the race. And the two names this module gives
// a file it refused to read, which belong with the backups rather than beside
// the live one.
const FORK_NAME = /^library-[^.]+\.json$/i;
const REFUSED_NAME = /^library\.(BROKEN|CORRUPT)-.*\.json$/i;

/**
 * Merges every conflict copy beside the file into what is held, then moves
 * it under backups/. A union with the newest edit winning: the copy is an
 * older line of the same library, so the base is taken as empty -- with
 * ours as the base, every record the copy lacks would read as a deletion.
 */
async function adoptForks() {
  const dir = path.dirname(FILE);
  let names;
  try { names = await fsp.readdir(dir); } catch { return 0; }
  const forks = names.filter((n) => FORK_NAME.test(n) && n.toLowerCase() !== path.basename(FILE).toLowerCase());
  const refused = names.filter((n) => REFUSED_NAME.test(n));
  if (!forks.length && !refused.length) return 0;
  await fsp.mkdir(backupDir(), { recursive: true });
  let taken = 0;
  for (const name of forks) {
    const from = path.join(dir, name);
    let fork = null;
    try { fork = JSON.parse(await fsp.readFile(from, 'utf8')); } catch { /* unreadable: kept, below */ }
    if (fork && fork.records && typeof fork.records === 'object' && !Array.isArray(fork.records)) {
      const before = Object.keys(data.records).length;
      const merged = mergeLibraries({ records: {} }, data, fork);
      const changed = Object.entries(merged.records)
        .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data.records[k])).length;
      Object.assign(data.records, merged.records);
      for (const [k, v] of Object.entries(merged)) if (k !== 'records') data[k] = v;
      log(`library: merged conflict copy ${name} (${Object.keys(fork.records).length} records; `
        + `${changed} added or newer, ${Object.keys(data.records).length - before} new)`);
      if (changed) taken += 1;
    } else {
      log(`library: conflict copy ${name} could not be read -- kept in backups/`);
    }
    await fsp.rename(from, path.join(backupDir(), `fork-${name}`)).catch(() => {});
  }
  for (const name of refused) {
    await fsp.rename(path.join(dir, name), path.join(backupDir(), name)).catch(() => {});
  }
  if (taken) save();
  return taken;
}

// Ratings run 0 (unrated) to 10 -- RATING_MAX, in shared/facets.js. They ran
// to 5 until 2026-10-05.

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * The automatic snapshots, oldest first -- and only those.
 *
 * The pattern used to be any library-*.json, which counted a copy made by hand
 * (library-before-the-import.json) as one of the fourteen, and pruned it as the
 * oldest. A copy somebody took on purpose is theirs to delete, so only the
 * dated names this module writes are counted or pruned.
 */
const AUTO_BACKUP = /^library-\d{4}-\d{2}-\d{2}T.*\.json$/;

async function backupNames() {
  try {
    const names = await fsp.readdir(backupDir());
    // An ISO timestamp sorts chronologically as text, which is the whole reason
    // for naming them that way.
    return names.filter((n) => AUTO_BACKUP.test(n)).sort();
  } catch {
    return [];
  }
}

/**
 * Copies the sidecar as it currently stands into `backups/`.
 *
 * Always handed the bytes that are on disk rather than `data` -- by the time a
 * dangerous write is noticed, `data` is already the version being protected
 * against. Failures are swallowed: a backup that cannot be taken must not stop
 * the edit that prompted it.
 */
async function snapshot(bytes) {
  try {
    const dir = backupDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `library-${stamp()}.json`), bytes);
    const names = await backupNames();
    for (const old of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
      await fsp.unlink(path.join(dir, old)).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One snapshot a day, taken at startup.
 *
 * The cheap insurance: whatever a session does, there is a copy from before it
 * began. Days are counted in UTC, which in Sydney turns over mid-morning -- it
 * makes the filename slightly surprising and the interval exactly a day, and
 * the interval is the part that matters.
 */
async function dailyBackup(raw) {
  const today = new Date().toISOString().slice(0, 10);
  const names = await backupNames();
  if (names.some((n) => n.slice(8, 18) === today)) return false;
  return snapshot(raw);
}

async function stampOf(file) {
  try {
    const st = await fsp.stat(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

const sameStamp = (a, b) => Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);

/**
 * Three ways to one library: what both sides started from, ours, theirs.
 *
 * Per record (and per entry of races, traits and favourite tiers): changed on
 * one side only, that side wins; changed on both, the later `updated` wins and
 * ours on a tie -- except that an edit always beats a deletion, because a
 * deleted record is an empty one and labels are the thing not to lose.
 * Favourites merge by name the same way. The phone carries a copy of this.
 */
// One copy, shared with the phone: shared/merge.js.
const { mergeLibraries, mergeRecord } = require('./shared/merge.js');

/**
 * Takes in what another writer put on disk, if anything did.
 *
 * In place, so anything holding `data.records` (the face index reads it
 * directly) sees the merged records rather than an orphaned map.
 */
async function adoptDisk() {
  const now = await stampOf(FILE);
  if (!now || sameStamp(now, diskStamp)) return false;
  let theirsRaw;
  let theirs;
  try {
    theirsRaw = await fsp.readFile(FILE, 'utf8');
    theirs = JSON.parse(theirsRaw);
  } catch {
    return false; // half-synced or locked: the next look will do
  }
  if (!theirs || !theirs.records || typeof theirs.records !== 'object') return false;
  if (theirsRaw === baseRaw) { diskStamp = now; return false; }
  let base = { records: {} };
  try { if (baseRaw) base = JSON.parse(baseRaw); } catch { /* treat as empty */ }
  const merged = mergeLibraries(base, data, theirs);
  // The same collapse guard the write has, applied before another device's
  // version is let in. To the merge, a record we hold that theirs lacks is one
  // they deleted -- which is also exactly what an older file looks like: a
  // version OneDrive restored, or a PC that was offline for a week writing its
  // stale copy. The merge cannot tell the two apart, so a big drop is backed up
  // (ours, as it stands) before it lands, and said out loud. Without this the
  // count below was reset before the write's guard could see the drop.
  const before = Object.keys(data.records).length;
  const after = Object.keys(merged.records).length;
  const dropped = before - after;
  if (before && dropped > 0 && (dropped >= BIG_DROP_RECORDS || dropped >= before * BIG_DROP)) {
    const kept = await snapshot(JSON.stringify(data));
    log(`library: the file on disk drops ${dropped} of ${before} records `
      + `(an older version restored?) -- ours ${kept ? 'backed up to backups/ first' : 'COULD NOT be backed up'}`);
  }
  for (const key of Object.keys(data.records)) if (!(key in merged.records)) delete data.records[key];
  Object.assign(data.records, merged.records);
  for (const [k, v] of Object.entries(merged)) if (k !== 'records') data[k] = v;
  baseRaw = theirsRaw;
  diskStamp = now;
  lastWritten = Object.keys(data.records).length;
  log(`library: merged changes written by another device (${lastWritten} records)`);
  return true;
}

function get(stat) {
  return data.records[keyFor(stat)] || null;
}

/**
 * Every record, by key.
 *
 * The face index needs to look records up by key rather than by stat -- it holds
 * keys, not the files they came from -- so it reads the map directly. Returned
 * as-is: this is read-only by convention, and copying six thousand records on
 * every rebuild would cost more than the convention is worth.
 */
function all() {
  return data.records;
}

/** Always safe to spread onto a file entry, even with no record. */
function decorate(stat) {
  const record = get(stat);
  if (!record) return EMPTY;
  return {
    rating: record.rating || 0,
    tags: record.tags || [],
    models: record.models || [],
    // Names turned down on this video, so the strip can show what it is not
    // suggesting and let you put one back.
    notModels: record.notModels || [],
    // The production house, one per video.
    studio: record.studio || '',
    // The reference's letter code — the series within that house.
    production: record.production || '',
    // Where this video came from, when that is known: a page about it rather
    // than a copy of it.
    url: record.url || '',
    // Bookmarked moments, earliest first, so the player can draw them on the
    // timeline the instant it opens rather than asking for them separately.
    marks: record.marks || [],
    // Where playback stood when this was last closed, on any device.
    resume: record.resume || 0,
    // When the labels last changed. Travels with the listing so "date modified"
    // can mean the video *or* what is known about it, whichever happened later.
    updated: record.updated || 0,
    // When it was marked all profiled: its credits are the whole answer, and
    // the faces suggest nobody else on it from then on.
    settled: record.settled || 0,
  };
}

/**
 * The one place the sidecar is written.
 *
 * Two guards around an otherwise ordinary write. A sudden collapse in the
 * record count gets the outgoing file copied into `backups/` first -- both
 * accidental Replace-mode wipes looked exactly like this from here, and by the
 * time either was noticed the previous contents were already gone. And the new
 * version lands through a temporary file and a rename, so a crash or a pulled
 * cable mid-write leaves the old file whole rather than a truncated one. If the
 * rename is refused -- OneDrive does occasionally hold a handle open -- it is
 * retried, and failing that the write is tried again a little later; it never
 * writes the file in place.
 */
async function writeNow() {
  if (readOnly) return { file: FILE, records: 0, readOnly };
  // Somebody else wrote since we last looked: theirs merged in first, so this
  // write carries both rather than replacing theirs with ours.
  await adoptDisk();
  // Compact, not indented. The indentation was 740KB of spaces and newlines in
  // a 3.8MB file that lives in the sync root and is re-uploaded whole after
  // every burst of edits -- and that a phone downloads to read one rating.
  const body = JSON.stringify(data);
  const count = Object.keys(data.records).length;

  const dropped = lastWritten - count;
  if (lastWritten && dropped > 0
    && (dropped >= BIG_DROP_RECORDS || dropped >= lastWritten * BIG_DROP)) {
    const was = await fsp.readFile(FILE).catch(() => null);
    if (was) await snapshot(was);
  }

  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  tempSeq += 1;
  const temp = `${FILE}.${process.pid}-${tempSeq}.writing`;
  // Forced to the disk before the rename (see write-whole.js).
  await writeSynced(temp, body);

  // The rename is the whole of the atomicity, so a refusal is retried rather
  // than worked around. OneDrive holds a handle on the target now and then and
  // lets go a moment later.
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rename(temp, FILE);
      lastWritten = count;
      baseRaw = body;
      diskStamp = await stampOf(FILE);
      return { file: FILE, records: count };
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 60 * (i + 1)); });
    }
  }

  // Still refused. This used to fall back to writing FILE in place, which
  // truncates it first -- and a process that dies in that window leaves a
  // truncated file or an empty one. Two bulk runs died exactly there and took
  // the library with them. So the old file is left whole, and the write is
  // tried again shortly -- the edits are still here in memory.
  await fsp.unlink(temp).catch(() => {});
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; writeSerial().catch(() => {}); }, 2000);
  return { file: FILE, records: count, deferred: 'rename refused; trying again' };
}

/** One write at a time, each starting from the one before. */
function writeSerial() {
  writing = writing.then(writeNow, writeNow);
  return writing;
}

// A burst of clicks lands as one write, this long after the first of them.
const SAVE_MS = 400;
// A write nobody is waiting on -- the face sweep crediting a name -- waits far
// longer: every write re-uploads the whole file to OneDrive, and a night's
// sweep was a thousand of them. What is pending still lands at shutdown.
const LAZY_SAVE_MS = 45000;
let timerDue = 0;

function save(delayMs = SAVE_MS) {
  const due = Date.now() + delayMs;
  // Something sooner is already on its way: this rides with it. A click
  // during a lazy wait pulls the write forward to the click's own delay.
  if (timer && timerDue <= due) return;
  clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(() => {
    timer = null;
    timerDue = 0;
    // A read-only or offline sync folder must not break editing.
    writeSerial().catch(() => {});
  }, delayMs);
}

/**
 * Another device's edits, picked up while this one sits idle. Only when no
 * write of ours is waiting -- that write merges anyway.
 */
async function refreshFromDisk() {
  if (!FILE || timer) return false;
  // Read-only because the file could not be read at launch -- a half-synced
  // copy, a lock -- is a condition that passes. Try it again: readable now,
  // and the records come in and editing is allowed from here on, with no
  // restart. Only whole-file success clears it; the empty `data` is never
  // written while it stands.
  if (readOnly) {
    let raw;
    let parsed;
    try {
      raw = await fsp.readFile(FILE, 'utf8');
      parsed = JSON.parse(raw);
    } catch { return false; }
    if (!parsed || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) return false;
    data = parsed;
    if (!Array.isArray(data.favourites)) data.favourites = [];
    if (!data.races || typeof data.races !== 'object' || Array.isArray(data.races)) data.races = {};
    baseRaw = raw;
    diskStamp = await stampOf(FILE);
    lastWritten = Object.keys(data.records).length;
    log(`library: ${path.basename(FILE)} reads again (${lastWritten} records) -- no longer read-only`);
    readOnly = '';
    return true;
  }
  let changed = false;
  writing = writing.then(async () => { changed = await adoptDisk(); }, async () => { changed = await adoptDisk(); });
  await writing;
  return changed;
}

/**
 * Writes now rather than in 400ms, for a batch job that is about to exit — the
 * debounce is there to coalesce a burst of clicks, not to survive a process.
 */
async function flush() {
  const pending = timer !== null;
  clearTimeout(timer);
  timer = null;
  if (!pending) { await writing.catch(() => {}); return { file: FILE, records: lastWritten }; }
  return writeSerial();
}

/**
 * Refuses an edit this module cannot safely persist, and says why.
 *
 * 503 rather than 500: the file is expected back, and the message says what to
 * do about it.
 */
function refuseIfReadOnly() {
  if (!readOnly) return;
  const err = new Error(`Labels are read-only: ${readOnly}. Restart once it reads again.`);
  err.statusCode = 503;
  throw err;
}

/** Case-insensitive dedupe, but the casing you typed is what gets stored. */
function normaliseTags(tags) {
  const seen = new Map();
  for (const raw of tags || []) {
    const tag = String(raw).trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (!seen.has(lower)) seen.set(lower, tag);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * A record with nothing in it. A rejection counts as content: "not her" is a
 * decision, and dropping the record would hand the same suggestion straight
 * back. So does a bookmark: it is a place somebody chose to remember.
 */
function isEmptyRecord(r) {
  return !r.rating && !(r.tags || []).length && !(r.models || []).length
    && !(r.notModels || []).length && !(r.marks || []).length
    && !r.studio && !r.production && !r.url && !r.resume && !r.settled;
}

/**
 * `tags` replaces outright; `addTags`/`removeTags` merge, which is what a
 * multi-select edit needs — tagging 10 files must not wipe the tags each
 * already has.
 */
function apply(stat, name, patch, { lazy = false } = {}) {
  refuseIfReadOnly();
  const key = keyFor(stat);
  const current = data.records[key] || { rating: 0, tags: [], models: [], name };
  // Where playback stood is bookkeeping, not labelling: a record whose ONLY
  // change is the resume point keeps its updated stamp, or merely watching
  // something would push it to the top of the date sort as though it had been
  // worked on.
  const onlyResume = Object.keys(patch).every((k) => k === 'resume');
  const next = {
    ...current,
    name: name || current.name,
    updated: onlyResume ? (current.updated || 0) : Date.now(),
  };

  if (patch.resume !== undefined) {
    // Seconds into the video, shared between the desktop and the phone through
    // this file exactly like the rating. Zero clears it -- a finished video
    // starts from the top next time.
    const at = Math.max(0, Math.round(Number(patch.resume) || 0));
    if (at > 0) next.resume = at;
    else delete next.resume;
  }

  if (patch.rating !== undefined) {
    next.rating = Math.max(0, Math.min(RATING_MAX, Math.round(Number(patch.rating) || 0)));
  }

  if (patch.studio !== undefined) {
    // One value, and blanking it is how you clear it.
    next.studio = String(patch.studio || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  if (patch.production !== undefined) {
    // The reference's letter code — MD, RS, MCY. Upper-cased, since that is how
    // the site writes it and a code that differs only in case is the same code.
    // 60 rather than 24. The field was cut for a reference code and 24 was
    // generous for AVJI; it is not generous for a series name, and Japan HDV
    // has eight that were being truncated mid-word.
    next.production = String(patch.production || '')
      .trim().replace(/\s+/g, ' ').slice(0, 60).toUpperCase();
  }

  // All profiled: true stamps it, false lets suggestions back.
  if (patch.settled !== undefined) {
    if (patch.settled) next.settled = Date.now();
    else delete next.settled;
  }

  if (patch.url !== undefined) {
    const url = String(patch.url || '').trim();
    // Only http(s), and nothing with a scheme the shell would act on: this ends
    // up as an href in a page that can open a browser.
    next.url = /^https?:\/\//i.test(url) ? url : '';
  }

  // tags/addTags/removeTags and models/addModels/removeModels behave
  // identically, so they share one implementation rather than two that drift.
  for (const field of LIST_FIELDS) {
    const Field = field[0].toUpperCase() + field.slice(1);
    if (Array.isArray(patch[field])) next[field] = normaliseTags(patch[field]);
    if (Array.isArray(patch['add' + Field]) && patch['add' + Field].length) {
      next[field] = normaliseTags([...(next[field] || []), ...patch['add' + Field]]);
    }
    if (Array.isArray(patch['remove' + Field]) && patch['remove' + Field].length) {
      const drop = new Set(patch['remove' + Field].map((t) => String(t).trim().toLowerCase()));
      next[field] = (next[field] || []).filter((t) => !drop.has(t.toLowerCase()));
    }
  }

  // Bookmarks. `marks` replaces the lot; setMark and removeMark move one, which
  // is what the timeline does -- sending the whole list back for every pip
  // would lose any mark added from another window between read and write.
  if (Array.isArray(patch.marks)) next.marks = normaliseMarks(patch.marks);
  if (patch.setMark) {
    const mark = normaliseMark(patch.setMark);
    if (mark) {
      next.marks = normaliseMarks([
        ...(next.marks || []).filter((m) => Math.abs(m.t - mark.t) > 0.05),
        mark,
      ]);
    }
  }
  if (patch.removeMark !== undefined) {
    const at = Number(patch.removeMark);
    if (Number.isFinite(at)) {
      next.marks = (next.marks || []).filter((m) => Math.abs(m.t - at) > 0.05);
    }
  }

  // An empty record is noise in a file that syncs; drop it instead.
  if (isEmptyRecord(next)) {
    delete data.records[key];
    save(lazy ? LAZY_SAVE_MS : SAVE_MS);
    return { ...EMPTY };
  }

  data.records[key] = next;
  save(lazy ? LAZY_SAVE_MS : SAVE_MS);
  return {
    rating: next.rating || 0,
    tags: next.tags || [],
    models: next.models || [],
    notModels: next.notModels || [],
    studio: next.studio || '',
    production: next.production || '',
    url: next.url || '',
    marks: next.marks || [],
    resume: next.resume || 0,
    updated: next.updated,
    settled: next.settled || 0,
  };
}

/**
 * Names turned down on one video, by its library key.
 *
 * By key rather than by stat because the face index works in keys and never
 * holds the stat -- and the key is the whole point of the scheme: it survives a
 * rename, a move, and a file being freed up to the cloud.
 */
function notModelsByKey(key) {
  return ((data.records[key] || {}).notModels || []).map((n) => n.toLowerCase());
}

/**
 * Follows a record onto a file whose bytes changed — which happens exactly once
 * per file, when its tags are written into it and the size grows — or onto a
 * copy that came back with a new modified time (the carry-over).
 *
 * The keys it was known by go with it, newest first, in `aliases`. Nothing
 * looks a record up by them; they are the history, so a move that was wrong can
 * be traced back to where the labels came from. Capped, since a record that has
 * moved twenty times has a history nobody is going to read past.
 */
const ALIAS_LIMIT = 20;

function rekey(oldStat, newStat, name) {
  if (readOnly) return;
  const from = keyFor(oldStat);
  const to = keyFor(newStat);
  if (from === to) return;
  const record = data.records[from];
  if (!record) return;
  const aliases = [...new Set([from, ...(Array.isArray(record.aliases) ? record.aliases : [])])]
    .filter((k) => k !== to)
    .slice(0, ALIAS_LIMIT);
  const moved = { ...record, name: name || record.name, updated: Date.now(), aliases };
  // A record already under the new key -- a second copy of the same bytes --
  // is merged with, not written over: both are somebody's labels.
  const held = data.records[to];
  data.records[to] = held ? mergeRecord({}, moved, held) : moved;
  delete data.records[from];
  save();
}

/** Everything in use for a field, most-used first — the autocomplete vocabulary. */
/**
 * Rename a label everywhere at once.
 *
 * The per-video edit cannot do this: it takes a list of paths, and "every video
 * with this tag" is not a list the dialog has. Renaming by hand meant finding
 * them, selecting them, adding the new one and removing the old -- four steps
 * to fix a typo.
 *
 * Matching is case-insensitive, because that is how the tag vocabulary is
 * counted and deduped everywhere else; the casing you type is what gets
 * stored. A rename onto a tag that already exists merges the two, which is the
 * only sane reading of it and is often the point.
 */
function renameTag(from, to, field = 'tags') {
  refuseIfReadOnly();
  const want = String(from || '').trim().toLowerCase();
  const named = String(to || '').trim().replace(/\s+/g, ' ');
  if (!want || !named) return { changed: 0 };
  let changed = 0;
  for (const record of Object.values(data.records)) {
    const held = record[field] || [];
    if (!held.some((t) => String(t).toLowerCase() === want)) continue;
    record[field] = normaliseTags(held.map((t) => (String(t).toLowerCase() === want ? named : t)));
    record.updated = Date.now();
    changed += 1;
  }
  if (changed) save();
  return { changed };
}

/** Take a label off every video that carries it. */
function removeTagEverywhere(name, field = 'tags') {
  refuseIfReadOnly();
  const want = String(name || '').trim().toLowerCase();
  if (!want) return { changed: 0 };
  let changed = 0;
  for (const [key, record] of Object.entries(data.records)) {
    const held = record[field] || [];
    if (!held.some((t) => String(t).toLowerCase() === want)) continue;
    record[field] = held.filter((t) => String(t).toLowerCase() !== want);
    record.updated = Date.now();
    // The label was all it had: the empty record goes, as an edit's would.
    if (isEmptyRecord(record)) delete data.records[key];
    changed += 1;
  }
  if (changed) save();
  return { changed };
}

/**
 * One performer becomes another, everywhere this file knows her: credits,
 * refusals, race, traits and favourite tier. The target keeps what it already
 * has -- a race or tier set on the new name is not overwritten by the old
 * one's -- and the old name is cleared. One save at the end.
 */
function renamePerformer(from, to) {
  refuseIfReadOnly();
  const name = String(from || '').trim().replace(/\s+/g, ' ');
  const named = String(to || '').trim().replace(/\s+/g, ' ');
  if (!name || !named) return { credited: 0, refused: 0 };
  const credited = renameTag(name, named, 'models').changed;
  const refused = renameTag(name, named, 'notModels').changed;
  const race = performerRaces()[name.toLowerCase()];
  if (race && !performerRaces()[named.toLowerCase()]) setPerformerRace(named, race);
  setPerformerRace(name, '');
  const traits = performerTraits()[name.toLowerCase()];
  if (traits && !performerTraits()[named.toLowerCase()]) setPerformerTraits(named, traits);
  setPerformerTraits(name, { height: '', bust: '', body: [] });
  if (isFavouriteModel(name)) {
    const tier = favouriteTiers()[name.toLowerCase()];
    setFavouriteModel(name, false);
    if (!isFavouriteModel(named)) setFavouriteModel(named, true, tier);
  }
  return { credited, refused };
}

/**
 * Whether a patch changes what the faces may suggest for the video: a name
 * turned down (or put back), or the video marked all profiled. Those re-score
 * that one video; nothing else in a patch does.
 */
function touchesSuggestions(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return patch.notModels !== undefined || patch.addNotModels !== undefined
    || patch.removeNotModels !== undefined || patch.settled !== undefined;
}

function counts(field = 'tags') {
  const found = new Map();
  for (const record of Object.values(data.records)) {
    for (const tag of record[field] || []) {
      const lower = tag.toLowerCase();
      const hit = found.get(lower);
      if (hit) hit.count += 1;
      else found.set(lower, { tag, count: 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const tagCounts = () => counts('tags');
const modelCounts = () => counts('models');

/** The studio vocabulary. A single value per record, so it counts itself. */
function studioCounts() {
  return singleCounts('studio');
}

function productionCounts() {
  return singleCounts('production');
}

/** How often each value of a one-per-video field appears, commonest first. */
function singleCounts(field) {
  const found = new Map();
  for (const record of Object.values(data.records)) {
    const value = (record[field] || '').trim();
    if (!value) continue;
    const lower = value.toLowerCase();
    const hit = found.get(lower);
    if (hit) hit.count += 1;
    else found.set(lower, { tag: value, count: 1 });
  }
  return [...found.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * The performers with the most well-rated videos, best first.
 *
 * Ranked by the count of ten-star videos, then nine, and so on down: a
 * performer with twelve tens outranks one with forty sixes, which is what
 * "top" means here. A plain average would put someone with a single ten above
 * them both, and a plain total would rank by how much you happen to own.
 *
 * Read from the sidecar rather than a listing, so it describes the whole
 * library however the app is currently filtered.
 */
/**
 * Favourite performers, by name.
 *
 * Beside the records rather than inside them, because a favourite belongs to a
 * person and a record belongs to a file: one performer spans hundreds of videos,
 * so marking her would otherwise mean writing to every one of them — and a
 * performer with no videos on disk yet could not be marked at all.
 */
function favouriteModels() {
  return (data.favourites || []).slice();
}

function isFavouriteModel(name) {
  const key = String(name || '').trim().toLowerCase();
  return !!key && (data.favourites || []).some((m) => String(m).toLowerCase() === key);
}

/**
 * How much of a favourite each one is: lower-cased name -> 1 to 5, tier 1
 * the most. Only for names on the list, and a favourite with no tier recorded
 * -- every one marked before tiers existed, or marked on the phone -- is a 3.
 * TIERS and DEFAULT_TIER are in shared/facets.js.
 */
function favouriteTiers() {
  const held = data.favouriteTiers || {};
  const out = {};
  for (const name of data.favourites || []) {
    const key = String(name).toLowerCase();
    out[key] = TIERS.includes(held[key]) ? held[key] : DEFAULT_TIER;
  }
  return out;
}

/**
 * Marks or unmarks one performer, and returns the whole list as it now stands.
 * `tier` places a favourite; left out, a favourite keeps the tier it had.
 */
function setFavouriteModel(name, on, tier) {
  refuseIfReadOnly();
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) return favouriteModels();
  const key = clean.toLowerCase();
  // Filter then push, so a second marking cannot duplicate a name and the
  // spelling most recently used is the one kept.
  const list = (data.favourites || []).filter((m) => String(m).toLowerCase() !== key);
  if (on) list.push(clean);
  list.sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
  data.favourites = list;
  const tiers = { ...(data.favouriteTiers || {}) };
  if (on && TIERS.includes(Number(tier))) tiers[key] = Number(tier);
  else if (!on) delete tiers[key];
  data.favouriteTiers = tiers;
  save();
  return list.slice();
}

/**
 * Race, per performer: lower-cased name -> one of RACES (shared/facets.js).
 *
 * Beside the favourites and for the same reason: it belongs to a person, not a
 * file. Given by hand -- nothing here infers it -- and read by the phone from
 * the same file.
 */

function performerRaces() {
  return { ...(data.races || {}) };
}

/** Sets or clears one performer's race, and returns the whole map. */
function setPerformerRace(name, race) {
  refuseIfReadOnly();
  const key = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key) return performerRaces();
  const races = { ...(data.races || {}) };
  if (RACES.includes(race)) races[key] = race;
  else delete races[key];
  data.races = races;
  save();
  return performerRaces();
}

/**
 * Height, bust and body, per performer: lower-cased name -> { height, bust,
 * body: [] }. Beside the races and for the same reason -- a person, not a file.
 * Height and bust are one answer each; body can be several. The answers are
 * TRAITS, in shared/facets.js.
 */

function performerTraits() {
  return JSON.parse(JSON.stringify(data.traits || {}));
}

/** Sets the fields named in `patch` (blank or empty clears one); returns the whole map. */
function setPerformerTraits(name, patch) {
  refuseIfReadOnly();
  const key = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key || !patch) return performerTraits();
  const traits = { ...(data.traits || {}) };
  const now = { ...(traits[key] || {}) };
  for (const field of ['height', 'bust']) {
    if (patch[field] === undefined) continue;
    if (TRAITS[field].includes(patch[field])) now[field] = patch[field];
    else delete now[field];
  }
  if (patch.body !== undefined) {
    const want = new Set(Array.isArray(patch.body) ? patch.body : []);
    const body = TRAITS.body.filter((b) => want.has(b));
    if (body.length) now.body = body;
    else delete now.body;
  }
  if (Object.keys(now).length) traits[key] = now;
  else delete traits[key];
  data.traits = traits;
  save();
  return performerTraits();
}

function stats() {
  const records = Object.values(data.records);
  return {
    file: FILE,
    videos: records.length,
    rated: records.filter((r) => r.rating).length,
    tagged: records.filter((r) => (r.tags || []).length).length,
    linked: records.filter((r) => r.url).length,
    favourites: (data.favourites || []).length,
    readOnly,
    studios: records.filter((r) => r.studio).length,
    productions: records.filter((r) => r.production).length,
    named: records.filter((r) => (r.models || []).length).length,
  };
}

module.exports = {
  init, keyFor, get, all, decorate, apply, rekey, flush,
  refreshFromDisk, mergeLibraries,
  notModelsByKey,
  tagCounts, modelCounts, studioCounts, productionCounts, stats, normaliseTags,
  renameTag, removeTagEverywhere, renamePerformer, touchesSuggestions,
  favouriteModels, isFavouriteModel, setFavouriteModel, favouriteTiers,
  performerRaces, setPerformerRace, performerTraits, setPerformerTraits,
};
