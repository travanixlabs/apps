'use strict';

/**
 * The small things every part of the server leans on: the log, a file test, a
 * forgiving JSON read, the concurrency limiters and the one way a child process
 * is run. Nothing here knows about videos.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const util = require('util');
const { execFile } = require('child_process');

// ---------------------------------------------------------------- utilities

/**
 * The log, on the disk as well as the console.
 *
 * The app runs inside a native window with no console anyone can see, so a
 * line printed there is a line nobody reads -- and the ones that matter most,
 * a crash or a 500, are exactly the ones that are gone by the time anybody
 * asks. One file per day under %LOCALAPPDATA%, never the sync root: a log is
 * this machine's business and rewriting it there would mean an upload per
 * line. A week is kept; anything older is deleted at launch.
 *
 * Appended synchronously. There are a few lines a minute, it is a local disk,
 * and a line written by an uncaught exception has to be on the disk before the
 * process can be trusted to still be there.
 */
const { LOG_DIR } = require('./paths');
const LOG_KEEP_DAYS = 7;
let logDirReady = false;

function localDay(when) {
  const d = new Date(when);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// A day's file stops growing past this. Seven to forty KB is a normal day;
// a page stuck in a loop, or something hammering the loopback port with
// refused requests, must not fill the disk before anybody looks.
const LOG_CAP_BYTES = 50 * 1024 * 1024;
let logLines = 0;
let logCapped = '';

function logToFile(text) {
  try {
    if (!logDirReady) { fs.mkdirSync(LOG_DIR, { recursive: true }); logDirReady = true; }
    const now = new Date();
    const file = path.join(LOG_DIR, `server-${localDay(now)}.log`);
    if (logCapped === file) return;
    logLines += 1;
    if (logLines % 500 === 0) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { size = 0; }
      if (size > LOG_CAP_BYTES) {
        fs.appendFileSync(file, `${now.toISOString()} log capped at ${LOG_CAP_BYTES} bytes for today; nothing more until tomorrow\n`);
        logCapped = file;
        return;
      }
    }
    fs.appendFileSync(file, `${now.toISOString()} ${text}\n`);
  } catch { /* a log that cannot be written must not take the server with it */ }
}

/** Last week's files and older, gone. Run once at launch. */
function pruneLogs() {
  const oldest = localDay(Date.now() - (LOG_KEEP_DAYS - 1) * 24 * 3600 * 1000);
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return; }
  for (const name of names) {
    const m = /^server-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
    if (m && m[1] < oldest) {
      try { fs.unlinkSync(path.join(LOG_DIR, name)); } catch { /* still open elsewhere */ }
    }
  }
}

function log(...args) {
  console.log('[video-explorer]', ...args);
  logToFile(util.format(...args));
}

/**
 * A failure, with its stack in the file. The console keeps the one-line
 * message it always printed; the stack is for whoever reads the log later.
 */
function logFailure(what, err) {
  console.log('[video-explorer]', what, err && err.message ? err.message : String(err));
  logToFile(`${what} ${err && err.stack ? err.stack : String(err)}`);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Reads a JSON file, forgiving a byte-order mark.
 *
 * JSON.parse refuses one, and a UTF-8 BOM is what several perfectly ordinary
 * Windows tools leave behind -- PowerShell's `Set-Content -Encoding utf8`
 * among them. The failure is silent and total: the file parses as nothing, the
 * fallback is returned, and every setting in it is quietly discarded while the
 * app carries on looking fine.
 */
function loadJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/** Bounded-concurrency runner so we never fork 200 ffmpeg processes at once. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

const ffLimit = createLimiter(Math.max(2, Math.min(6, (os.cpus().length || 4) - 2)));
// Graph work is network-bound, not CPU-bound, and wants its own modest cap so a
// page of tiles doesn't fire 24 simultaneous requests at Microsoft.
const graphLimit = createLimiter(6);

/** Seconds to wait, from what the service asked for, or a widening guess. */
function waitFor(err, attempt = 2) {
  const asked = Number(err && err.retryAfter);
  if (Number.isFinite(asked) && asked > 0) return Math.min(asked, 30);
  return [2, 5, 10][Math.min(attempt, 2)];
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // A time limit on every child: one hung ffmpeg otherwise holds its sweep,
    // or a slot of the shared limiter, for the rest of the session.
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 10 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

module.exports = {
  pruneLogs, log, logFailure, exists, loadJsonSync, createLimiter, ffLimit,
  graphLimit, waitFor, sleep, run,
};
