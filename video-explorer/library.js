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
const os = require('os');

// Models are kept separate from tags rather than being a tag convention: they
// are a different kind of fact, they want their own filter facet, and a
// performer named "anal" would otherwise be indistinguishable from the tag.
// The studio is a single value, not a list: a video comes from one production
// house. Kept out of tags for the same reason models are — one allowed answer is
// a different shape of fact from "any number of these apply".
const EMPTY = { rating: 0, tags: [], models: [], studio: '', production: '', url: '' };

const LIST_FIELDS = ['tags', 'models'];

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

// The record count last written, so the next write can notice a collapse.
let lastWritten = 0;

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
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'library.json');
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
  } catch (err) {
    if (err.code !== 'ENOENT') {
      readOnly = `${path.basename(FILE)} could not be read (${err.code || err.message})`;
    }
    data = { version: 1, records: {} };
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.records) data = parsed;
      else readOnly = `${path.basename(FILE)} has no records in it`;
    } catch (err) {
      readOnly = `${path.basename(FILE)} is not valid JSON (${err.message})`;
    }
  }
  // A file written before favourites existed has no list; the rest of the module
  // may then assume there is one.
  if (!Array.isArray(data.favourites)) data.favourites = [];
  lastWritten = Object.keys(data.records).length;
  // Today's copy, taken before this session can change anything.
  if (!readOnly && raw !== null) await dailyBackup(raw);
  return { file: FILE, count: lastWritten, readOnly };
}

/** Whether edits will be accepted, and why not when they will not. */
function status() {
  return { file: FILE, readOnly, records: lastWritten };
}

const backupDir = () => path.join(path.dirname(FILE), 'backups');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function backupNames() {
  try {
    const names = await fsp.readdir(backupDir());
    // An ISO timestamp sorts chronologically as text, which is the whole reason
    // for naming them that way.
    return names.filter((n) => /^library-.+\.json$/.test(n)).sort();
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

function keyFor(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
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
    // The production house, one per video.
    studio: record.studio || '',
    // The reference's letter code — the series within that house.
    production: record.production || '',
    // Where this video came from, when that is known: a page about it rather
    // than a copy of it.
    url: record.url || '',
    // When the labels last changed. Travels with the listing so "date modified"
    // can mean the video *or* what is known about it, whichever happened later.
    updated: record.updated || 0,
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
 * rename is refused -- OneDrive does occasionally hold a handle open -- it
 * falls back to writing in place, which is what this always used to do.
 */
async function writeNow() {
  if (readOnly) return { file: FILE, records: 0, readOnly };
  const body = JSON.stringify(data, null, 1);
  const count = Object.keys(data.records).length;

  if (lastWritten && count < lastWritten * (1 - BIG_DROP)) {
    const was = await fsp.readFile(FILE).catch(() => null);
    if (was) await snapshot(was);
  }

  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.writing`;
  try {
    await fsp.writeFile(temp, body);
    await fsp.rename(temp, FILE);
  } catch {
    await fsp.unlink(temp).catch(() => {});
    await fsp.writeFile(FILE, body);
  }
  lastWritten = count;
  return { file: FILE, records: count };
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // A read-only or offline sync folder must not break editing.
    writeNow().catch(() => {});
  }, 400);
}

/**
 * Writes now rather than in 400ms, for a batch job that is about to exit — the
 * debounce is there to coalesce a burst of clicks, not to survive a process.
 */
async function flush() {
  clearTimeout(timer);
  return writeNow();
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
 * `tags` replaces outright; `addTags`/`removeTags` merge, which is what a
 * multi-select edit needs — tagging 10 files must not wipe the tags each
 * already has.
 */
function apply(stat, name, patch) {
  refuseIfReadOnly();
  const key = keyFor(stat);
  const current = data.records[key] || { rating: 0, tags: [], models: [], name };
  const next = { ...current, name: name || current.name, updated: Date.now() };

  if (patch.rating !== undefined) {
    next.rating = Math.max(0, Math.min(5, Math.round(Number(patch.rating) || 0)));
  }

  if (patch.studio !== undefined) {
    // One value, and blanking it is how you clear it.
    next.studio = String(patch.studio || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  if (patch.production !== undefined) {
    // The reference's letter code — MD, RS, MCY. Upper-cased, since that is how
    // the site writes it and a code that differs only in case is the same code.
    next.production = String(patch.production || '')
      .trim().replace(/\s+/g, ' ').slice(0, 24).toUpperCase();
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

  // An empty record is noise in a file that syncs; drop it instead.
  if (!next.rating && !(next.tags || []).length && !(next.models || []).length
    && !next.studio && !next.production && !next.url) {
    delete data.records[key];
    save();
    return { ...EMPTY };
  }

  data.records[key] = next;
  save();
  return {
    rating: next.rating || 0,
    tags: next.tags || [],
    models: next.models || [],
    studio: next.studio || '',
    production: next.production || '',
    url: next.url || '',
    updated: next.updated,
  };
}

/**
 * Follows a record onto a file whose bytes changed — which happens exactly once
 * per file, when its tags are written into it and the size grows.
 */
function rekey(oldStat, newStat, name) {
  if (readOnly) return;
  const from = keyFor(oldStat);
  const to = keyFor(newStat);
  if (from === to) return;
  const record = data.records[from];
  if (!record) return;
  data.records[to] = { ...record, name: name || record.name, updated: Date.now() };
  delete data.records[from];
  save();
}

/** Everything in use for a field, most-used first — the autocomplete vocabulary. */
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
 * Ranked by the count of five-star videos, then four, and so on down: a
 * performer with twelve fives outranks one with forty threes, which is what
 * "top" means here. A plain average would put someone with a single five above
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

/** Marks or unmarks one performer, and returns the whole list as it now stands. */
function setFavouriteModel(name, on) {
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
  save();
  return list.slice();
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
  init, keyFor, get, all, decorate, apply, rekey, flush, status, snapshot,
  counts, tagCounts, modelCounts, studioCounts, productionCounts, stats, normaliseTags,
  favouriteModels, isFavouriteModel, setFavouriteModel,
};
