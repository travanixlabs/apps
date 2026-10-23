'use strict';

/**
 * One walk of the library, shared by everything that needs one.
 *
 * The three sweeps and the carry-over each walked the whole tree on their own
 * timer -- four and a half full walks of 27,000 files every quarter hour, with
 * nobody using the app, each 1.5s with the disk to itself and 18s under a
 * running sweep. They all wanted the same answer: every video under the
 * folders the app covers, with its stat. So it is walked once, kept for ten
 * minutes, and handed to whoever asks; a move or delete made by this app
 * throws it away (see fileops), since then the answer is one we made stale.
 *
 * The listing keeps its own walker (server/walk.js): it walks one folder, with
 * its own skip rules, and a person is waiting on it being fresher than this.
 */

const fsp = require('fs').promises;
const path = require('path');
const { skipDir, walkFolders, isCloudOnly } = require('./walk-rules');

// The union of what any consumer treats as a video; each narrows it itself.
const EXT = /\.(mp4|m4v|mov|mkv|webm)$/i;
const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_DEPTH = 12;

let held = null;    // { key, at, videos }
let walking = null; // { key, promise }
let epoch = 0;      // bumped by invalidate(): a walk begun before it is not kept
let walks = 0;      // how many times the disk was actually walked

const inside = (outer, inner) => {
  const o = path.resolve(outer).toLowerCase();
  const i = path.resolve(inner).toLowerCase();
  return i === o || i.startsWith(o.endsWith(path.sep) ? o : o + path.sep);
};

/**
 * The folders actually walked, from the home folder and the opened roots: a
 * root above the home folder stands at the home folder instead (the whole
 * user profile is hundreds of thousands of files and junction loops), and a
 * root inside another is not walked twice.
 */
function boundRoots({ home = '', roots = [] } = {}) {
  const base = home ? path.resolve(home) : '';
  const out = [];
  const add = (dir) => { if (!out.some((r) => r.toLowerCase() === dir.toLowerCase())) out.push(dir); };
  for (const raw of (roots || []).filter(Boolean)) {
    const root = path.resolve(raw);
    if (base && inside(root, base) && !inside(base, root)) add(base);
    else add(root);
  }
  if (base && !out.length) add(base);
  return out.filter((r) => !out.some((other) => other !== r && inside(other, r)));
}

/**
 * Depth first, in directory order, each folder's videos stat'ed together --
 * and several folders read at once (walkFolders in walk-rules.js). The walk
 * waited on one readdir at a time, so the 64-way stat batching only helped
 * inside a folder with 64 videos; most folders have a handful.
 */
async function walkRoots(roots) {
  const visited = new Set();
  const videos = await walkFolders(roots, {
    isVideo: (e) => e.isFile() && EXT.test(e.name),
    skip: (name, depth) => depth >= MAX_DEPTH || skipDir(name),
    visited,
    describe: (full, stat) => ({ path: full, stat, cloudOnly: isCloudOnly(stat) }),
  });
  walks += 1;
  return videos;
}

/**
 * Every video under the covered folders: [{ path, stat, cloudOnly }], in
 * directory order. From the last walk while that is under maxAgeMs and
 * nothing of ours has moved since; one walk at a time, shared by whoever
 * asks while it runs.
 */
async function videos(scope, { maxAgeMs = MAX_AGE_MS } = {}) {
  const roots = boundRoots(scope);
  const key = roots.map((r) => r.toLowerCase()).join('\n');
  if (held && held.key === key && Date.now() - held.at < maxAgeMs) return held.videos;
  if (walking && walking.key === key) return walking.promise;
  const begun = epoch;
  const promise = walkRoots(roots).then((list) => {
    if (epoch === begun) held = { key, at: Date.now(), videos: list };
    return list;
  }).finally(() => { if (walking && walking.promise === promise) walking = null; });
  walking = { key, promise };
  return promise;
}

/** This app changed the disk: the last walk no longer describes it. */
function invalidate() {
  epoch += 1;
  held = null;
}

function status() {
  return {
    videos: held ? held.videos.length : 0,
    ageMs: held ? Date.now() - held.at : null,
    walking: Boolean(walking),
    walks,
  };
}

module.exports = { videos, invalidate, status, boundRoots, EXT, MAX_AGE_MS };
