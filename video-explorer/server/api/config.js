'use strict';

/**
 * The settings, the one status poll, and the shutdown.
 */

const fs = require('fs');
const path = require('path');
const faces = require('../../faces');
const dupes = require('../../dupes');
const framing = require('../../framing');
const priority = require('../../priority');
const tree = require('../../tree');
const { userSettings, saveConfigSoon, applyHomeDir, state } = require('../config');
const { writeCacheManifest } = require('../cache');
const { getWalkVersion } = require('../walk');
const { sendJson } = require('../http');
const { log } = require('../util');

// Which build this is: the app folder's creation time. The native build copies
// the source into a new folder every time, so a rebuild changes it; the page
// starts clean on the first launch of a new build (and only then).
const BUILD = (() => {
  try { return String(Math.round(fs.statSync(path.join(__dirname, '..', '..')).birthtimeMs)); } catch { return ''; }
})();

const withAccount = () => ({ ...state.config, homeAccount: state.homeAccount, build: BUILD });

module.exports = (flushAll) => [
  ['GET', '/api/config', async ({ res }) => sendJson(res, 200, withAccount())],

  ['POST', '/api/config', async ({ res, body }) => {
    // Only the keys a person may set, each the shape its default has; the
    // server's own bookkeeping in the same object is not for a request to
    // write (see USER_SETTINGS in config.js).
    const patch = userSettings(await body());
    Object.assign(state.config, patch);
    // Emptying the path means "go back to following the account", not
    // "open on nothing" -- so re-resolve rather than store a blank.
    if ('homeDir' in patch || 'homeFollowsAccount' in patch) await applyHomeDir();
    // Tile width and frame count are both in the cache names, so a reader
    // outside this process needs to be told when they move.
    if ('tileWidth' in patch || 'frames' in patch) await writeCacheManifest();
    saveConfigSoon({ user: true });
    return sendJson(res, 200, withAccount());
  }],

  // The three sweeps in one answer.
  //
  // They were polled separately every two seconds, which was ninety requests
  // a minute for a window nobody was looking at -- and each face reply walked
  // all 23,000 profiles three times to count them. One route, one walk, and
  // the page slows to a crawl of its own accord when nothing is running.
  ['GET', '/api/status', async ({ res }) => sendJson(res, 200, {
    faces: faces.status(),
    dupes: dupes.status(),
    framing: framing.status(),
    // Whether ffmpeg could be started at launch; the page says so once.
    ffmpeg: state.ffmpeg,
    // Who, if anyone, the sweeps are standing aside for right now.
    priority: priority.status(),
    // The shared library walk the sweeps read: how old, and how many times
    // the disk has actually been walked this session.
    tree: tree.status(),
    // Bumped when a folder is found to have changed underneath a listing
    // that was served from the last walk of it.
    walkVersion: getWalkVersion(),
  })],

  // A fault the page caught (window.onerror, an unhandled rejection), into
  // the daily log: the native window has no console anyone reads.
  ['POST', '/api/log', async ({ res, body }) => {
    const asked = await body();
    const message = String(asked.message || '').slice(0, 2000);
    const stack = String(asked.stack || '').slice(0, 2000);
    if (message) log(`page: ${message}${stack ? '\n' + stack : ''}`);
    return sendJson(res, 200, { ok: true });
  }],

  // The window is closing: everything held in memory goes to disk before the
  // host ends the process, which it does without a signal.
  ['POST', '/api/shutdown', async ({ res, body }) => {
    const asked = await body().catch(() => ({}));
    await flushAll();
    sendJson(res, 200, { ok: true });
    // `exit: true` (stop.cmd) ends the process itself once the answer is
    // out; the native host kills the process after this reply instead.
    if (asked && asked.exit === true) setTimeout(() => process.exit(0), 150).unref();
    return undefined;
  }],
];
