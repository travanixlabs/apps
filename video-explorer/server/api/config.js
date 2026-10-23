'use strict';

/**
 * The settings, the one status poll, and the shutdown.
 */

const faces = require('../../faces');
const dupes = require('../../dupes');
const framing = require('../../framing');
const priority = require('../../priority');
const tree = require('../../tree');
const { userSettings, saveConfigSoon, applyHomeDir, state } = require('../config');
const { writeCacheManifest } = require('../cache');
const { getWalkVersion } = require('../walk');
const { sendJson } = require('../http');

const withAccount = () => ({ ...state.config, homeAccount: state.homeAccount });

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

  // The window is closing: everything held in memory goes to disk before the
  // host ends the process, which it does without a signal.
  ['POST', '/api/shutdown', async ({ res }) => {
    await flushAll();
    return sendJson(res, 200, { ok: true });
  }],
];
