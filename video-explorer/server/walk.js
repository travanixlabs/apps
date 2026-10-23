'use strict';

/**
 * Listings: what a folder holds, remembered between visits, described the way
 * the page wants it, and counted against the advanced filter per subfolder.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const priority = require('../priority');
const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');
// The cache-name arithmetic, shared with the headless strip builder so the two
// cannot drift apart. See strips.js.
const strips = require('../strips');
// The same file the page loads as a script. What "matches the advanced
// filter" means is one definition, not two that would have to agree.
const filter = require('../public/filter');

const { log } = require('./util');
const { shouldSkipDir, collectVideos } = require('./files');
const { cacheName, spriteSalt, cachedMeta, cachedStripNames } = require('./cache');

/**
 * What the three sweeps have done to one video -- cloud or not.
 *
 * Deliberately NOT skipping placeholders. The sweeps decline to *build* for a
 * cloud file, since that would mean downloading it, and it is tempting to read
 * that as "a placeholder has nothing to show". It is the opposite: all three
 * stores are keyed by size and mtime, and freeing a file to the cloud changes
 * neither, so everything learned while it was downloaded is still here and
 * still correct. Skipping them hid the folders that were 100% done.
 */
function sweepState(video, strips, printsReady) {
  // What the faces know, kept whole: the listing entry reads the same
  // answer (filterView) rather than asking twice per video.
  const faced = faces.decorate(video);
  return {
    framed: strips.has(cacheName(video, spriteSalt())),
    // Only meaningful once the index is in. It is nine thousand small files
    // read one at a time, so a scan in the first seconds of a session would
    // otherwise report a fraction of the fingerprints that exist and show it
    // as a half-finished folder rather than as an answer not ready yet.
    printed: printsReady ? dupes.has(dupes.keyFor(video)) : null,
    profiled: faced.profiled === true,
    faced,
  };
}

/** Immediate subfolders of `dir`, each annotated with what's inside it. */
/**
 * The immediate subfolders of `dir`, each with the prefix that says whether a
 * video lives somewhere beneath it. Shared by the listing and by the filtered
 * count, which would otherwise each decide for themselves which folders are
 * worth showing -- and the count would be attached to a folder that is not
 * there, or missing from one that is.
 */
async function subfolderEntries(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const subs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    const full = path.join(dir, entry.name);
    subs.push({
      name: entry.name,
      path: full,
      prefix: path.resolve(full).toLowerCase() + path.sep,
    });
  }
  subs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return subs;
}

/**
 * The videos of a walk, bucketed by the immediate subfolder of `dir` each
 * sits under (lower-cased name -> indices). One pass over the walk instead
 * of one per subfolder: at the library root that was folders x 27,000
 * startsWith tests.
 */
function bucketBySubfolder(dir, videos) {
  const base = path.resolve(dir).toLowerCase() + path.sep;
  const buckets = new Map();
  videos.forEach((video, i) => {
    const lower = path.resolve(video.path).toLowerCase();
    if (!lower.startsWith(base)) return;
    const cut = lower.indexOf(path.sep, base.length);
    if (cut < 0) return; // directly in dir, under no subfolder
    const name = lower.slice(base.length, cut);
    let list = buckets.get(name);
    if (!list) { list = []; buckets.set(name, list); }
    list.push(i);
  });
  return buckets;
}

async function listSubfolders(dir, videos, strips = new Set(), states = null) {
  const subs = await subfolderEntries(dir);

  // Worked out once per video rather than once per (folder, video) pair: the
  // outer loop below already costs folders x videos, and three index lookups
  // inside it would multiply by that again. The caller may hand the states
  // in, worked out once for the listing as well.
  const printsReady = dupes.status().ready === true;
  const done = states || videos.map((video) => sweepState(video, strips, printsReady));
  const buckets = bucketBySubfolder(dir, videos);

  const folders = [];
  for (const sub of subs) {
    let count = 0;
    let cloudCount = 0;
    let totalSize = 0;
    let latestMtimeMs = 0;
    let cover = null;
    let framed = 0;
    let printed = 0;
    let profiled = 0;
    for (const i of buckets.get(sub.name.toLowerCase()) || []) {
      const video = videos[i];
      count += 1;
      if (video.cloudOnly) cloudCount += 1;
      totalSize += video.size;
      if (video.mtimeMs > latestMtimeMs) latestMtimeMs = video.mtimeMs;
      // Only a locally-present file can be a cover; a cloud one would download.
      if (!cover && !video.cloudOnly) cover = video.path;
      if (done[i].framed) framed += 1;
      if (done[i].printed) printed += 1;
      if (done[i].profiled) profiled += 1;
    }

    folders.push({
      name: sub.name,
      path: sub.path,
      videoCount: count,
      cloudCount,
      totalSize,
      latestMtimeMs,
      cover,
      // How far the three sweeps have got through this folder, out of
      // videoCount -- every video in it, cloud or not. What was learned about a
      // file does not go away when the bytes do.
      framed,
      // null, not 0, while the fingerprint index is still being read: a folder
      // saying "not yet counted" is honest, and one saying "none" is not.
      printed: printsReady ? printed : null,
      profiled,
    });
  }

  return folders;
}

/**
 * One video as a listing entry.
 *
 * Factored out because the duplicates view needs the same shape for a file in
 * a folder nobody has opened -- and two builders that had to agree would not
 * have, the first time one of them gained a field.
 */
/**
 * Everything about a video that a filter can ask about, and nothing else.
 *
 * Split out of describeVideo because counting a folder needs exactly this and
 * none of the rest: no name, no folder, and in particular no notePath -- a
 * count is not a listing, and telling the face index that 28,000 videos were
 * just "seen" because a checkbox changed would be a lie it then acts on.
 */
function filterView(video, strips = null, known = null) {
  return {
    path: video.path,
    size: video.size,
    mtimeMs: video.mtimeMs,
    cloudOnly: video.cloudOnly,
    // Framed and fingerprinted, for the Sync filter -- when the caller has the
    // cache directory's names in hand, which a listing always does. `known`
    // is the sweep state the folder tally already worked out for this video.
    ...(known ? { framed: known.framed, printed: known.printed === true }
      : strips ? {
        framed: strips.has(cacheName(video, spriteSalt())),
        printed: dupes.status().ready === true && dupes.has(dupes.keyFor(video)),
      } : {}),
    // Free: the scan already holds the stat these are keyed by, so ratings and
    // tags arrive with the listing rather than costing a second round trip.
    ...library.decorate(video),
    // Likewise for who the faces look like, so "has a suggestion" is a filter
    // the listing can answer on its own.
    ...(known ? known.faced : faces.decorate(video)),
    // And whether this is one of several copies of the same video.
    ...dupes.decorate(video),
  };
}

/**
 * The same entry with everything that is merely a default left out.
 *
 * Nine tenths of a library has no tags, no models, no marks, no studio and no
 * rating, and saying so 27,240 times cost 8MB of JSON per listing -- for
 * fields that are empty. Absent means the default, which the page fills in on
 * arrival, so nothing downstream has to test for missing.
 */
// One list, shared with the page's hydrate: shared/listing.js.
const { LISTING_DEFAULTS } = require('../shared/listing.js');

function slim(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    if (!(key in LISTING_DEFAULTS)) { out[key] = value; continue; }
    const fallback = LISTING_DEFAULTS[key];
    if (Array.isArray(fallback)) { if (value && value.length) out[key] = value; continue; }
    if (fallback === null) { if (value) out[key] = value; continue; }
    // null is a value in its own right ("not counted yet" for printed), and
    // is kept; only the default itself is dropped.
    if (value !== fallback) out[key] = value;
  }
  return out;
}

/**
 * What is already known about a video's bytes: how long, how big a picture,
 * what codec.
 *
 * It is in hand -- keyed by the same size and modified time the scan just
 * read -- so sending it with the listing costs nothing. Without it the page
 * turned round and asked for the lot in batches of 250, which on the library
 * root was 109 further round trips and 27,240 repeated stats of files the walk
 * had only just finished stat'ing.
 */
function knownMeta(video) {
  const held = cachedMeta(video.path, video) || {};
  const { duration, width, height, fps, codec, bitrate } = held;
  const out = {};
  if (duration) out.duration = duration;
  if (width) out.width = width;
  if (height) out.height = height;
  if (fps) out.fps = fps;
  if (codec) out.codec = codec;
  if (bitrate) out.bitrate = bitrate;
  // Nothing probed, but it may still have been fingerprinted -- and a cloud-only
  // video can never be probed, so for most of the library this is the only
  // running time there will ever be. Never overrides a real probe.
  if (!out.duration) {
    const secs = dupes.secsFor(video);
    if (secs) out.duration = secs;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * One suggestion as the listing sends it: the fields the page reads, and no
 * others.
 *
 * Every entry carries every name the faces put at 20% or more, so this is
 * most of the listing's weight at the library root. `rank` is the ranking's
 * own bookkeeping and nothing on the page reads it -- `band` already says
 * which are the faint ones. Scores are rounded to three places where they are
 * made; rounded again here so a ranking adopted from an older file cannot
 * carry seventeen digits into every listing.
 */
const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
// Only what the grid, the filters and the grouping read. The margin, the
// runner-up and her video count are read when a face is actually opened --
// a hover card, a strip tile, the face dialog -- and come from
// /api/faces/suggested then. They were a third of a 36MB root listing.
function listedSuggestion(s) {
  return {
    name: s.name,
    score: round3(s.score),
    band: s.band,
    person: s.person,
  };
}

function describeVideo(video, dir, stripSet = null, known = null) {
  // Every listing teaches the face index where its profiled videos are, which
  // is what lets "more of her" offer a thumbnail you can click. Free: the scan
  // is already holding this stat.
  faces.notePath(video, video.path);
  const meta = knownMeta(video);
  const entry = filterView(video, stripSet, known);
  if (entry.suggested && entry.suggested.length) {
    entry.suggested = entry.suggested.map(listedSuggestion);
  }
  // No `ext`: the page never read it, and the name it came from is right here.
  return slim({
    name: path.basename(video.path),
    folder: path.dirname(video.path),
    relFolder: dir ? (path.relative(dir, path.dirname(video.path)) || '.') : '',
    ...entry,
    ...(meta ? { meta } : {}),
  });
}

/**
 * How many videos under each subfolder of `dir` the filter keeps.
 *
 * The page cannot work this out: it holds the videos of the folder it is
 * standing in, and this is a question about the ones it was never sent. So the
 * filter comes here and runs against the same matcher the page uses, over the
 * walk the scan already did.
 */
function countUnderFolders(dir, videos, subs, adv, strips = null) {
  const favSet = new Set(library.favouriteModels().map((n) => String(n).toLowerCase()));
  const raceOf = new Map(Object.entries(library.performerRaces()));
  const traitsOf = new Map(Object.entries(library.performerTraits()));
  const favTiers = new Map(Object.entries(library.favouriteTiers()));
  const ctx = { favSet, raceOf, traitsOf, favTiers };
  // Compiled once, not once per video.
  const compiled = filter.compileAdvanced(adv);
  const counts = {};
  for (const sub of subs) counts[sub.path] = 0;
  for (const video of videos) {
    const lower = path.resolve(video.path).toLowerCase();
    // Cheapest test first: most videos are under none of these when the page is
    // standing in a folder that holds its own files.
    let hit = null;
    for (const sub of subs) {
      if (lower.startsWith(sub.prefix)) { hit = sub; break; }
    }
    if (!hit) continue;
    if (!filter.matchesAdvanced(filterView(video, strips), compiled, ctx)) continue;
    counts[hit.path] += 1;
  }
  return counts;
}

/**
 * What the last scan walked, so a filter change can be counted against the same
 * snapshot the tiles were drawn from.
 *
 * The walk is the scan's whole cost -- 28,000 stats at the library root -- and
 * changing a filter is not a rescan. Counting against the snapshot is also the
 * honest answer: the tiles beside the count came from it too.
 */
let lastWalk = { key: '', videos: [] };

/**
 * The last walk of each folder, served while a fresh one runs behind it.
 *
 * Walking the library root is 27,240 stats: two seconds with the machine to
 * itself and eighteen with the face sweep reading. Nothing about that changes
 * between one visit to a folder and the next, so the answer is kept and handed
 * over at once, and the disk work happens where nobody is sitting waiting for
 * it. A walk that comes back different bumps `walkVersion`, which the page
 * notices on its next status poll and quietly re-lists.
 *
 * Deliberately not a cache with a long life: a minute old is fine to show for
 * the instant it takes to confirm, and anything older than WALK_KEEP_MS is not
 * worth showing at all. A minute rather than ten seconds because every
 * navigation older than this re-walks behind the answer, and at the library
 * root that is 27,000 stats competing with the sweeps for the disk.
 */
const WALK_FRESH_MS = 60 * 1000;
const WALK_KEEP_MS = 30 * 60 * 1000;
const walks = new Map();
let walkVersion = 0;
const walkKey = (dir) => path.resolve(dir).toLowerCase();

/** A signature that changes when the folder's contents do. */
function walkShape(videos) {
  let h = 2166136261;
  for (const v of videos) {
    for (const part of [v.path, String(v.size), String(Math.round(v.mtimeMs))]) {
      for (let i = 0; i < part.length; i += 1) {
        h = Math.imul(h ^ part.charCodeAt(i), 16777619);
      }
    }
  }
  return `${videos.length}:${(h >>> 0).toString(36)}`;
}

/**
 * One walk of `dir`. A walk somebody is waiting on takes the priority hold,
 * so the sweeps stand aside for it; a background refresh does not. Nobody is
 * waiting on that one -- the page already has its answer -- and taking the
 * hold for it paused every sweep on nearly every navigation, for work whose
 * only output is "nothing changed".
 */
async function walkNow(dir, { background = false } = {}) {
  const giveBack = background ? () => {} : priority.hold('scan ' + path.basename(dir));
  try {
    return await collectVideos(dir);
  } finally {
    giveBack();
  }
}

/**
 * Bumped by forgetWalks. A walk that was already reading the disk when this
 * app changed it -- a delete, a move -- finishes with the old answer, and
 * storing it would put a deleted video straight back in every listing until
 * the next refresh happened to notice. So a walk only lands if no forget came
 * in while it ran.
 */
let walkEpoch = 0;

function refreshWalk(dir) {
  const key = walkKey(dir);
  const held = walks.get(key);
  if (!held || held.refreshing) return;
  held.refreshing = true;
  const epoch = walkEpoch;
  // Deliberately unawaited: whoever asked already has an answer.
  walkNow(dir, { background: true }).then((videos) => {
    if (epoch !== walkEpoch) return; // the disk moved under it; forgotten anyway
    const shape = walkShape(videos);
    const changed = shape !== held.shape;
    walks.set(key, { videos, shape, at: Date.now(), refreshing: false });
    if (changed) {
      walkVersion += 1;
      log(`${path.basename(dir)} changed underneath: ${videos.length} videos`);
    }
  }).catch(() => {
    held.refreshing = false;
  });
}

/** Everything the folder holds -- from the last walk when there is a usable one. */
async function walkOf(dir, fresh) {
  const key = walkKey(dir);
  const held = walks.get(key);
  const age = held ? Date.now() - held.at : Infinity;
  if (!fresh && held && age < WALK_KEEP_MS) {
    if (age > WALK_FRESH_MS) refreshWalk(dir);
    return { videos: held.videos, age };
  }
  // Walked again when this app changed the disk while it ran (see walkEpoch):
  // the answer would list what was just deleted or moved away.
  let videos;
  for (let tries = 0; ; tries += 1) {
    const epoch = walkEpoch;
    videos = await walkNow(dir);
    if (epoch === walkEpoch) {
      walks.set(key, { videos, shape: walkShape(videos), at: Date.now(), refreshing: false });
      break;
    }
    if (tries >= 2) break; // answered, not stored; the next listing walks again
  }
  return { videos, age: 0 };
}

/**
 * Forgets every remembered walk.
 *
 * Called whenever this app is the one that changed the disk -- a move, a
 * delete, tags written into a file -- because then the stale answer is one we
 * put there ourselves and showing it would be plainly wrong.
 */
function forgetWalks() {
  walks.clear();
  walkVersion += 1;
  walkEpoch += 1;
}

async function scanDirectory(dir, recursive, includeCloud, fresh = false) {
  const walk = await walkOf(dir, fresh);
  const videos = walk.videos;
  lastWalk = { key: walkKey(dir), videos };
  const strips = await cachedStripNames();
  // Each video's sweep state once, for the folder tally and the entries both.
  const printsReady = dupes.status().ready === true;
  const states = videos.map((video) => sweepState(video, strips, printsReady));
  const folders = await listSubfolders(dir, videos, strips, states);

  const target = path.resolve(dir).toLowerCase();
  const indices = videos.map((unused, i) => i);
  const atThisLevel = recursive
    ? indices
    : indices.filter((i) => path.dirname(path.resolve(videos[i].path)).toLowerCase() === target);

  // Default: list only files actually downloaded to this machine.
  const shown = includeCloud ? atThisLevel : atThisLevel.filter((i) => !videos[i].cloudOnly);
  const cloudHidden = atThisLevel.length - shown.length;

  // Deliberately NO ffprobe here. Probing 47 cloud-backed files took 91s and
  // silently downloaded gigabytes. Metadata is fetched per page via /api/meta.
  const files = shown.map((i) => describeVideo(videos[i], dir, strips, states[i]));

  const cloudBelow = videos.reduce((n, v) => n + (v.cloudOnly ? 1 : 0), 0);
  return {
    files,
    folders,
    totalBelow: videos.length,
    cloudBelow,
    cloudHidden,
    // How old the walk behind this listing is, and what the page should watch
    // for to know a fresher one has landed.
    walkAge: walk.age,
    walkVersion,
  };
}

/** The last walk, for the filtered count to run against. */
const getLastWalk = () => lastWalk;
/** Bumped when a remembered walk turns out to be stale. */
const getWalkVersion = () => walkVersion;

module.exports = {
  subfolderEntries, describeVideo, countUnderFolders, walkOf, forgetWalks, listedSuggestion,
  scanDirectory, getLastWalk, getWalkVersion, slim,
};
