'use strict';

/**
 * Where this app keeps things on this machine, in one place.
 *
 * Three per-user locations, each for a reason:
 *
 *   CONFIG_FILE  the settings. Beside the source when run with `node
 *                server.js`; the packaged app points VIDEO_EXPLORER_CONFIG at
 *                %APPDATA%\Video Explorer\config.json (Roaming, deliberately:
 *                a second PC on the same account inherits the view settings,
 *                and roots that do not exist there are pruned at launch, so
 *                an absolute path that roams does no harm).
 *   LOCAL_DIR    %LOCALAPPDATA%\video-explorer: what is this machine's alone
 *                and would be waste to sync -- the daily logs, the face and
 *                fingerprint snapshots (rebuilt from the sync root if lost),
 *                the 200MB of face models, and the Graph token.
 *   SYNC_DIR     <OneDrive>\.video-explorer: everything that is the user's
 *                data or expensive to make -- library.json, the preview cache,
 *                the face profiles and the fingerprints. Known only once the
 *                account resolves, so it is read through state (config.js)
 *                rather than fixed here.
 *
 * Modules that need one of these take it from here rather than spelling the
 * folder out themselves; the environment variables that override each are
 * named beside it.
 */

const path = require('path');
const os = require('os');

const APP_DIR = path.resolve(__dirname, '..');

// VIDEO_EXPLORER_CONFIG overrides.
const CONFIG_FILE = process.env.VIDEO_EXPLORER_CONFIG || path.join(APP_DIR, 'config.json');

// This machine's own folder. Tests point LOCALAPPDATA at a temp folder.
const LOCAL_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer');

// VIDEO_EXPLORER_LOG_DIR overrides.
const LOG_DIR = process.env.VIDEO_EXPLORER_LOG_DIR || path.join(LOCAL_DIR, 'logs');

// VIDEO_EXPLORER_FACE_MODELS overrides.
const FACE_MODEL_DIR = process.env.VIDEO_EXPLORER_FACE_MODELS || path.join(LOCAL_DIR, 'face-models');

// GRAPH_TOKEN_FILE overrides.
const GRAPH_TOKEN_FILE = process.env.GRAPH_TOKEN_FILE || path.join(LOCAL_DIR, 'graph-token.json');

/** The sync folder's own folder for this app, once the sync root is known. */
const syncDir = (oneDriveRoot) => path.join(oneDriveRoot, '.video-explorer');

module.exports = {
  APP_DIR, CONFIG_FILE, LOCAL_DIR, LOG_DIR, FACE_MODEL_DIR, GRAPH_TOKEN_FILE, syncDir,
};
