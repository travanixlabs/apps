'use strict';

/**
 * What every server-side test needs before it requires a module: every
 * per-user folder pointed at a temp folder of its own, so nothing a test
 * does reaches this machine's library, cache, log, token or face models.
 * Required first, before anything under server/ or the stores.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-test-'));
const home = path.join(root, 'OneDrive');
const local = path.join(root, 'LocalAppData');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(local, { recursive: true });

process.env.LOCALAPPDATA = local;
process.env.OneDrive = home;
process.env.OneDriveConsumer = home;
process.env.OneDriveCommercial = home;
process.env.VIDEO_EXPLORER_CONFIG = path.join(root, 'config.json');
process.env.VIDEO_EXPLORER_LIBRARY = path.join(home, '.video-explorer', 'library.json');
process.env.VIDEO_EXPLORER_CACHE = path.join(home, '.video-explorer', 'cache');
process.env.VIDEO_EXPLORER_LOG_DIR = path.join(root, 'logs');
process.env.VIDEO_EXPLORER_FACE_MODELS = path.join(root, 'no-models');
process.env.GRAPH_TOKEN_FILE = path.join(root, 'no-token.json');
process.env.NO_OPEN = '1';

/** A fresh folder under the sandbox. */
function tempDir(prefix = 'd') {
  return fs.mkdtempSync(path.join(root, `${prefix}-`));
}

/** An 8KB file (so it never reads as a cloud placeholder) with a set mtime. */
function video(dir, name, { mtimeMs = 1700000000000, size = 8192 } = {}) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(size, 1));
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  const st = fs.statSync(full);
  return { path: full, stat: st, key: `${st.size}:${Math.round(st.mtimeMs)}` };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function cleanup() {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* a handle still open */ }
}

module.exports = { root, home, local, tempDir, video, sleep, cleanup };
