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

const EMPTY = { rating: 0, tags: [] };

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
  return record ? { rating: record.rating || 0, tags: record.tags || [] } : EMPTY;
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
  const current = data.records[key] || { rating: 0, tags: [], name };
  const next = { ...current, name: name || current.name, updated: Date.now() };

  if (patch.rating !== undefined) {
    next.rating = Math.max(0, Math.min(5, Math.round(Number(patch.rating) || 0)));
  }
  if (Array.isArray(patch.tags)) {
    next.tags = normaliseTags(patch.tags);
  }
  if (Array.isArray(patch.addTags) && patch.addTags.length) {
    next.tags = normaliseTags([...(next.tags || []), ...patch.addTags]);
  }
  if (Array.isArray(patch.removeTags) && patch.removeTags.length) {
    const drop = new Set(patch.removeTags.map((t) => String(t).trim().toLowerCase()));
    next.tags = (next.tags || []).filter((t) => !drop.has(t.toLowerCase()));
  }

  // An empty record is noise in a file that syncs; drop it instead.
  if (!next.rating && !(next.tags || []).length) {
    delete data.records[key];
    save();
    return { ...EMPTY };
  }

  data.records[key] = next;
  save();
  return { rating: next.rating || 0, tags: next.tags || [] };
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

/** Every tag in use, most-used first — the vocabulary for autocomplete. */
function tagCounts() {
  const counts = new Map();
  for (const record of Object.values(data.records)) {
    for (const tag of record.tags || []) {
      const lower = tag.toLowerCase();
      const hit = counts.get(lower);
      if (hit) hit.count += 1;
      else counts.set(lower, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function stats() {
  const records = Object.values(data.records);
  return {
    file: FILE,
    videos: records.length,
    rated: records.filter((r) => r.rating).length,
    tagged: records.filter((r) => (r.tags || []).length).length,
  };
}

module.exports = { init, keyFor, get, decorate, apply, rekey, tagCounts, stats, normaliseTags };
