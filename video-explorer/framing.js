/**
 * Preview strips, built before anybody asks for one.
 *
 * The third sweep, and the shallowest. Where the face profiler asks who is in a
 * video and the duplicate finder asks whether it is the same video twice, this
 * one only asks for the ten frames the grid and the player already show -- so
 * that opening something is a read from disk rather than a wait.
 *
 * It exists because that wait was the visible one. A strip costs a second or so
 * for a downloaded file and comes back in three milliseconds afterwards, and
 * with 52 of 28,000 videos carrying one, practically every video ever opened
 * was paying the build.
 *
 * Downloaded files only, exactly as the duplicate finder is: a cloud
 * placeholder can be framed over HTTPS, but doing it for 25,712 of them is a
 * quarter of a million range requests at Microsoft that nobody asked for. Those
 * are built as they are browsed instead. What lands on the disk gets picked up
 * here on its own.
 *
 * Nothing here decides what a strip looks like or where it lives. The builder
 * and the has-it-already test are handed in by the server, which owns the cache
 * -- this module owns only the order, the counting and the pill.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const priority = require('./priority');

const log = (msg) => console.log(`[video-explorer] framing: ${msg}`);

const WALK_EVERY_MS = 10 * 60 * 1000;
// Long enough that a failure is not retried in a tight loop, short enough that
// a file which failed because the disk was busy gets another chance in a
// session. Three strikes and it is left alone until a restart.
const MAX_TRIES = 3;

const state = {
  // Paused on load, every load -- the same promise the other two sweeps make.
  // The pill starts it.
  enabled: false,
  running: false,
  walking: false,
  // Parked while the player builds a strip somebody is waiting on. See
  // priority.js: this sweep is the one most likely to be doing the same kind of
  // work as the thing it is standing aside for.
  yielding: false,
  queue: [],
  nextWalk: 0,
  current: '',
  lastBuilt: '',
  done: 0,
  failures: new Map(),
  startedAt: 0,
  // Set by the first walk. Until then a count would be a guess, and a
  // denominator counted from nothing reads worse than no denominator at all.
  counted: false,
  downloaded: 0,
  framed: 0,
  // Strips held for files that are no longer on the disk -- freed up to the
  // cloud, moved away, deleted. Counted apart, because a denominator they are
  // not part of cannot contain them.
  cached: 0,
  build: null,
  hasStrip: null,
  rootsOf: () => [],
  homeOf: () => '',
};

function init({ build, hasStrip, countCached = null, roots = [], home = null }) {
  state.build = build;
  state.hasStrip = hasStrip;
  state.countCached = countCached;
  state.rootsOf = typeof roots === 'function' ? roots : () => roots;
  state.homeOf = typeof home === 'function' ? home : () => home || '';
  return { ok: typeof build === 'function' && typeof hasStrip === 'function' };
}

const isCloudOnly = (s) => (s.size ? (s.blocks || 0) * 512 < s.size * 0.5 : false);

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);
const NEVER_WALK = new Set(['node_modules', 'system volume information', '$recycle.bin']);
const skipDir = (name) => name.startsWith('$') || name.startsWith('.')
  || NEVER_WALK.has(name.toLowerCase());

const keyFor = (stat) => `${stat.size}:${Math.round(stat.mtimeMs)}`;

/**
 * Every downloaded video under the roots, and which of them already has a strip.
 *
 * One walk answers both the queue and the counter, so the pill never needs a
 * second pass over the disk to say where it is up to.
 */
async function walkForWork() {
  const seen = new Set();
  const found = [];
  let downloaded = 0;
  let framed = 0;
  const roots = [...new Set([state.homeOf(), ...state.rootsOf()].filter(Boolean))]
    .map((r) => path.resolve(r));

  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      // A placeholder is left to be framed on demand, over HTTPS, as it is
      // browsed. Reading one here would download it.
      if (isCloudOnly(stat)) continue;
      const key = keyFor(stat);
      if (seen.has(key)) continue;            // the same file reached two ways
      seen.add(key);
      downloaded += 1;
      if (await state.hasStrip(full, stat)) { framed += 1; continue; }
      if ((state.failures.get(key) || 0) >= MAX_TRIES) continue;
      found.push({ file: full, stat, key });
    }
  };

  for (const root of roots) await walk(root);

  state.downloaded = downloaded;
  state.framed = framed;
  state.counted = true;
  if (typeof state.countCached === 'function') {
    try { state.cached = Math.max(0, (await state.countCached()) - framed); } catch { /* leave it */ }
  }
  return found;
}

/** One video's strip. */
async function frame(next) {
  state.current = path.basename(next.file);
  state.lastBuilt = state.current;
  if (!state.startedAt) state.startedAt = Date.now();
  try {
    await state.build(next.file, next.stat);
    state.framed += 1;
    state.done += 1;
    state.failures.delete(next.key);
  } catch {
    // A damaged file, or a seek past the last keyframe. Counted so it is not
    // returned to on every walk for the rest of the session.
    state.failures.set(next.key, (state.failures.get(next.key) || 0) + 1);
  }
  state.current = '';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The sweep: one video at a time, for as long as it is switched on.
 *
 * One at a time because a strip is ten ffmpeg seeks and the server's own
 * limiter is sized for the grid; two of these would spend the browsing budget
 * on work nobody has asked to see yet.
 */
async function loop() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.enabled) {
      // Somebody is waiting on a strip right now. Building one behind them
      // would be competing for exactly the same limiter.
      if (priority.busy()) {
        state.yielding = true;
        state.current = '';
        try { await priority.settled(); } finally { state.yielding = false; }
        continue;
      }

      if (!state.queue.length || Date.now() > state.nextWalk) {
        state.walking = true;
        try {
          state.queue = await walkForWork();
          state.nextWalk = Date.now() + WALK_EVERY_MS;
        } finally { state.walking = false; }
        if (!state.queue.length) {
          state.current = '';
          await wait(60000);
          continue;
        }
      }

      await frame(state.queue.shift());
      // A breath between videos: this is the least important of the three
      // sweeps and should be the easiest to interrupt.
      await wait(200);
    }
  } finally {
    state.running = false;
    state.current = '';
  }
}

function start() {
  if (state.running || !state.enabled) return;
  if (typeof state.build !== 'function') return;
  loop().catch(() => { state.running = false; });
}

function setEnabled(on) {
  state.enabled = Boolean(on);
  if (state.enabled) start();
  else log('paused');
  return status();
}

/** A new folder was opened: the denominator has changed. */
function rootsChanged() {
  state.nextWalk = 0;
}

/**
 * What the sweep has done and what is left.
 *
 * Shaped like the other two, because the pill beside them reads the same way: a
 * fraction of the downloaded library, and one word for what it is doing.
 */
function status() {
  return {
    available: typeof state.build === 'function',
    enabled: state.enabled,
    running: state.running,
    walking: state.walking,
    yielding: state.yielding,
    framed: state.framed,
    downloaded: state.downloaded,
    counted: state.counted,
    cached: state.cached,
    remaining: state.walking ? null : state.queue.length,
    current: state.current,
    lastBuilt: state.lastBuilt,
    doing: !state.enabled ? 'paused'
      : state.yielding ? 'standing aside'
        : state.walking ? 'counting'
          : state.current ? 'framing'
            : state.running ? 'waiting' : 'stopped',
    done: state.done,
    rate: state.done > 2 && state.startedAt
      ? Math.round(state.done / ((Date.now() - state.startedAt) / 3600000))
      : 0,
    failed: state.failures.size,
  };
}

module.exports = { init, start, setEnabled, rootsChanged, status, walkForWork };
