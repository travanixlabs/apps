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
const EMPTY = { rating: 0, tags: [], models: [], studio: '', url: '' };

const LIST_FIELDS = ['tags', 'models'];

let FILE = '';
let data = { version: 1, records: {} };
let timer = null;

/**
 * Lives in OneDrive by design — unlike the preview cache, which is regenerable
 * bulk. This file is a few hundred KB of irreplaceable hand-entered judgement,
 * and putting it in the sync root is what makes ratings show up on every device
 * running the app.
 */
function resolveFile(oneDriveRoot) {
  if (process.env.VIDEO_EXPLORER_LIBRARY) return process.env.VIDEO_EXPLORER_LIBRARY;
  if (oneDriveRoot) return path.join(oneDriveRoot, '.video-explorer', 'library.json');
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'library.json');
}

async function init(oneDriveRoot) {
  FILE = resolveFile(oneDriveRoot);
  try {
    const parsed = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    if (parsed && parsed.records) data = parsed;
  } catch {
    data = { version: 1, records: {} };
  }
  return { file: FILE, count: Object.keys(data.records).length };
}

function keyFor(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function get(stat) {
  return data.records[keyFor(stat)] || null;
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
    // Where this video came from, when that is known: a page about it rather
    // than a copy of it.
    url: record.url || '',
  };
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await fsp.mkdir(path.dirname(FILE), { recursive: true });
      await fsp.writeFile(FILE, JSON.stringify(data, null, 1));
    } catch { /* a read-only or offline sync folder must not break editing */ }
  }, 400);
}

/**
 * Writes now rather than in 400ms, for a batch job that is about to exit — the
 * debounce is there to coalesce a burst of clicks, not to survive a process.
 */
async function flush() {
  clearTimeout(timer);
  await fsp.mkdir(path.dirname(FILE), { recursive: true });
  await fsp.writeFile(FILE, JSON.stringify(data, null, 1));
  return { file: FILE, records: Object.keys(data.records).length };
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
    && !next.studio && !next.url) {
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
    url: next.url || '',
  };
}

/**
 * Follows a record onto a file whose bytes changed — which happens exactly once
 * per file, when its tags are written into it and the size grows.
 */
function rekey(oldStat, newStat, name) {
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
  const found = new Map();
  for (const record of Object.values(data.records)) {
    const studio = (record.studio || '').trim();
    if (!studio) continue;
    const lower = studio.toLowerCase();
    const hit = found.get(lower);
    if (hit) hit.count += 1;
    else found.set(lower, { tag: studio, count: 1 });
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
function topModels(limit = 10) {
  const found = new Map();
  for (const record of Object.values(data.records)) {
    for (const raw of record.models || []) {
      const name = String(raw).trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      let entry = found.get(lower);
      if (!entry) {
        entry = { name, counts: [0, 0, 0, 0, 0, 0], videos: 0, rated: 0 };
        found.set(lower, entry);
      }
      const rating = Math.max(0, Math.min(5, Math.round(Number(record.rating) || 0)));
      entry.counts[rating] += 1;
      entry.videos += 1;
      if (rating) entry.rated += 1;
    }
  }

  const ranked = [...found.values()].sort((a, b) => {
    for (let star = 5; star >= 1; star -= 1) {
      if (b.counts[star] !== a.counts[star]) return b.counts[star] - a.counts[star];
    }
    // Nothing rated on either side: whoever you have more of, then by name.
    return b.videos - a.videos || a.name.localeCompare(b.name);
  });

  return ranked.filter((e) => e.rated > 0).slice(0, limit);
}

function stats() {
  const records = Object.values(data.records);
  return {
    file: FILE,
    videos: records.length,
    rated: records.filter((r) => r.rating).length,
    tagged: records.filter((r) => (r.tags || []).length).length,
    linked: records.filter((r) => r.url).length,
    studios: records.filter((r) => r.studio).length,
    named: records.filter((r) => (r.models || []).length).length,
  };
}

module.exports = {
  init, keyFor, get, decorate, apply, rekey, flush,
  counts, tagCounts, modelCounts, studioCounts, topModels, stats, normaliseTags,
};
