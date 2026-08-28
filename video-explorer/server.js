'use strict';

/**
 * Video Explorer — local hover-preview file browser for MP4 libraries.
 * Zero npm dependencies: Node stdlib + ffmpeg/ffprobe on PATH.
 * Binds to loopback only.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

// Optional: absent or signed-out simply means no cloud thumbnails.
let graph = null;
try {
  graph = require('./graph');
} catch {
  graph = null;
}

const library = require('./library');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Settings live next to the source when run directly. The packaged app points
// this at its per-user data folder, so it never writes inside Program files.
const CONFIG_FILE = process.env.VIDEO_EXPLORER_CONFIG || path.join(APP_DIR, 'config.json');

// Cache lives outside the app folder: this app may sit in OneDrive, and
// syncing thousands of regenerable sprite sheets would be pure waste.
const CACHE_DIR = process.env.VIDEO_EXPLORER_CACHE
  || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'cache');
const META_FILE = path.join(CACHE_DIR, 'meta.json');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);

// Last-resort home folder. %OneDrive% is whichever account signed in first, so
// it is a fallback rather than the answer — see resolveHomeDir().
const ENV_HOME = process.env.OneDrive
  || process.env.OneDriveConsumer
  || process.env.OneDriveCommercial
  || path.join(os.homedir(), 'OneDrive');

const DEFAULT_CONFIG = {
  roots: [],          // folders the user has pointed at (authorises reads)
  homeFollowsAccount: true, // resolve home from the signed-in OneDrive account
  homeDir: '',        // opened on launch, and by the 🏠 button
  // Folder names to show at the default folder, by name rather than path so the
  // list survives the sync folder moving. Empty means show whatever is there.
  homeFolders: [],
  lastDir: '',
  recentDests: [],    // recent move/copy destinations
  previewMode: 'live', // 'live' = seek+play the real file; 'sprite' = pre-rendered stills
  frames: 10,         // preview segments per video
  dwellMs: 1000,      // ms per segment while hovering
  tileWidth: 640,     // poster/sprite tile width; matches the largest card size
  cardWidth: 520,     // largest tile: biggest preview per video
  pageSize: 24,       // videos rendered per page
  volume: 1,          // master playback volume, 0..1 — a preference, not a view
  foldersCollapsed: false,
  recursive: false,   // explorer-style by default: one folder level at a time
  grouped: false,     // the grid split into a section per performer

  scrubWithMouse: false,
  // Highest rated first: your own judgement beats any property of the file.
  // Everything unrated falls below, in name order.
  sort: 'rating',
  sortDir: 'desc',
};

let config = { ...DEFAULT_CONFIG };
let metaIndex = {};   // cacheKey -> probed metadata

// ---------------------------------------------------------------- utilities

function log(...args) {
  console.log('[video-explorer]', ...args);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function loadJsonSync(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

let saveTimer = null;
function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)).catch(() => {});
  }, 300);
}

let metaTimer = null;
function saveMetaSoon() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    fsp.writeFile(META_FILE, JSON.stringify(metaIndex)).catch(() => {});
  }, 1000);
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

// The sync root that Graph paths are resolved against. Starts as the
// environment's guess and is replaced once the real account is identified.
let ONEDRIVE_ROOT = ENV_HOME;
// Files Graph has no thumbnail for, so one 404 isn't retried on every scroll.
const graphMisses = new Set();

// ------------------------------------------------------- OneDrive accounts

/** Which account's folder we settled on, for the UI to explain itself. */
let homeAccount = { email: '', source: 'env', choices: [] };

/**
 * Every account signed into the OneDrive client, with the email and the local
 * folder it syncs to. This is what makes "the signed-in user's OneDrive" a real
 * answer: %OneDrive% names whichever account was set up first, which on a
 * machine with both a personal and a work account is a coin flip.
 */
function oneDriveAccounts() {
  let out = '';
  try {
    out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\OneDrive\\Accounts', '/s'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // not Windows, or the client has never run
  }

  const accounts = [];
  let current = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^HKEY_/i.test(line)) {
      current = { key: line.split('\\').pop(), email: '', folder: '' };
      accounts.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^(UserEmail|UserFolder)\s+REG_SZ\s+(.*)$/i);
    if (m) current[/email/i.test(m[1]) ? 'email' : 'folder'] = m[2].trim();
  }

  // FileCoAuth and similar bookkeeping keys carry no folder.
  return accounts.filter((a) => a.folder && fs.existsSync(a.folder));
}

/** The email of the account this app is signed into via Graph, if any. */
async function graphAccountEmail() {
  if (!graph || !graph.isSignedIn()) return '';
  try {
    // A dead network would otherwise stall startup on a TCP timeout.
    const drive = await Promise.race([
      graph.driveInfo(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    return (drive && drive.owner && drive.owner.user && drive.owner.user.email) || '';
  } catch {
    return '';
  }
}

/**
 * The home folder, resolved from the OneDrive account rather than a fixed path
 * — so it survives the sync folder being moved, and points at the account this
 * app actually reads cloud files from when several are synced.
 */
async function resolveHomeDir() {
  const accounts = oneDriveAccounts();
  if (!accounts.length) return { dir: ENV_HOME, email: '', source: 'env', choices: [] };
  const choices = accounts.map((a) => ({ email: a.email, folder: a.folder }));

  // One account is the common case, and needs no network round trip to confirm.
  if (accounts.length === 1) {
    return { dir: accounts[0].folder, email: accounts[0].email, source: 'account', choices };
  }

  const email = await graphAccountEmail();
  if (email) {
    const match = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (match) return { dir: match.folder, email: match.email, source: 'graph', choices };
  }

  // No Graph sign-in to disambiguate: prefer the personal account, since that
  // is what %OneDrive% usually points at anyway.
  const personal = accounts.find((a) => /^personal/i.test(a.key)) || accounts[0];
  return { dir: personal.folder, email: personal.email, source: 'account', choices };
}

/**
 * Applies the home folder to config, and points Graph path resolution at the
 * same root — addressing a file under the wrong account's folder yields a 404.
 */
async function applyHomeDir() {
  if (config.homeFollowsAccount === false && config.homeDir) {
    homeAccount = { email: '', source: 'fixed', choices: oneDriveAccounts().map((a) => ({ email: a.email, folder: a.folder })) };
  } else {
    const resolved = await resolveHomeDir();
    config.homeDir = resolved.dir;
    homeAccount = { email: resolved.email, source: resolved.source, choices: resolved.choices };
  }
  const account = homeAccount.choices.find((c) => c.email && c.email === homeAccount.email);
  ONEDRIVE_ROOT = (account && account.folder) || ENV_HOME;
  log(`home: ${config.homeDir}${homeAccount.email ? ' (' + homeAccount.email + ')' : ''} [${homeAccount.source}]`);
}

/**
 * Streaming URLs are short-lived but a playing <video> issues many range
 * requests. Without caching, every seek would cost a Graph round trip.
 */
const streamUrlCache = new Map(); // lowercased path -> { url, expiresAt }
const STREAM_URL_TTL_MS = 45 * 60 * 1000;

async function graphStreamUrl(file) {
  if (!graph || !ONEDRIVE_ROOT || !graph.isSignedIn()) return null;

  const key = file.toLowerCase();
  const hit = streamUrlCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.url;

  const url = await graph.getDownloadUrl(file, ONEDRIVE_ROOT);
  if (!url) return null;

  streamUrlCache.set(key, { url, expiresAt: Date.now() + STREAM_URL_TTL_MS });
  return url;
}

/**
 * A poster fetched from OneDrive rather than rendered locally. Costs ~16KB and
 * does NOT hydrate the placeholder, which is the only way to show thumbnails
 * for a cloud-only library without downloading it.
 */
async function graphThumbnail(file) {
  if (!graph || !ONEDRIVE_ROOT) return null;
  if (graphMisses.has(file.toLowerCase())) return null;
  if (!graph.isSignedIn()) return null;

  try {
    const buffer = await graphLimit(() => graph.fetchThumbnail(file, ONEDRIVE_ROOT));
    if (!buffer || buffer.length === 0) {
      graphMisses.add(file.toLowerCase());
      return null;
    }
    return buffer;
  } catch (err) {
    // 404 means no thumbnail exists; anything else is likely transient, so
    // only the definite miss is remembered.
    if (err.statusCode === 404) graphMisses.add(file.toLowerCase());
    return null;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function cacheKey(file, stat, salt) {
  return crypto.createHash('sha1')
    .update([path.resolve(file), stat.size, Math.round(stat.mtimeMs), salt].join('|'))
    .digest('hex');
}

/** Sources must live under a folder the user explicitly opened. */
function isAuthorised(target) {
  const resolved = path.resolve(target);
  return config.roots.some((root) => {
    const r = path.resolve(root);
    return resolved === r || resolved.toLowerCase().startsWith(r.toLowerCase() + path.sep);
  });
}

function authoriseOrThrow(target) {
  if (!isAuthorised(target)) {
    const err = new Error('Path is outside any opened folder: ' + target);
    err.statusCode = 403;
    throw err;
  }
  return path.resolve(target);
}

function rememberRoot(dir) {
  const resolved = path.resolve(dir);
  if (!config.roots.some((r) => path.resolve(r).toLowerCase() === resolved.toLowerCase())) {
    config.roots.push(resolved);
  }
  config.lastDir = resolved;
  saveConfigSoon();
}

// ------------------------------------------------------------------ ffprobe

async function probe(file) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,r_frame_rate,duration',
    '-show_entries', 'format=duration,size,bit_rate',
    // Free to ask for while we have ffprobe open, and it is how tags written
    // into a file on another device find their way into this one's sidecar.
    '-show_entries', 'format_tags=keywords,rating',
    '-of', 'json',
    file,
  ];
  const { stdout } = await run('ffprobe', args);
  const parsed = JSON.parse(stdout || '{}');
  const stream = (parsed.streams && parsed.streams[0]) || {};
  const format = parsed.format || {};

  let fps = 0;
  if (typeof stream.r_frame_rate === 'string' && stream.r_frame_rate.includes('/')) {
    const [num, den] = stream.r_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  }

  const tags = format.tags || {};
  return {
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
    codec: stream.codec_name || '',
    fps: Math.round(fps * 100) / 100,
    duration: Number(format.duration || stream.duration) || 0,
    bitrate: Number(format.bit_rate) || 0,
    embedded: {
      tags: String(tags.keywords || '').split(';').map((t) => t.trim()).filter(Boolean),
      rating: Number(tags.rating) || 0,
    },
  };
}

/**
 * The other half of the round trip: a file carrying tags written on another
 * device seeds this machine's sidecar the first time it is probed. Only when
 * there is no local record, so a rating made here is never overwritten by a
 * staler one baked into the file.
 */
function adoptEmbedded(file, stat, meta) {
  const found = meta && meta.embedded;
  if (!found || library.get(stat)) return;
  if (!found.tags.length && !found.rating) return;
  library.apply(stat, path.basename(file), { tags: found.tags, rating: found.rating });
  log(`adopted embedded tags from ${path.basename(file)}`);
}

async function getMeta(file, stat) {
  const key = cacheKey(file, stat, 'meta');
  if (metaIndex[key]) return metaIndex[key];
  let meta;
  try {
    meta = await ffLimit(() => probe(file));
  } catch (err) {
    meta = { width: 0, height: 0, codec: '', fps: 0, duration: 0, bitrate: 0, error: 'probe failed' };
  }
  metaIndex[key] = meta;
  saveMetaSoon();
  return meta;
}

// ------------------------------------------------------------- sprite sheet

const spriteFrameCount = new Map(); // sprite path -> frames actually rendered

// --- cache paths -----------------------------------------------------------
// One definition per artefact so a route can ask "is this already built?"
// without going through the generator.

function tileDims() {
  const tileW = Math.max(120, Math.min(640, Number(config.tileWidth) || 320));
  return { tileW, tileH: 2 * Math.round((tileW * 9 / 16) / 2) };
}

function thumbCachePath(file, stat) {
  return path.join(CACHE_DIR, cacheKey(file, stat, `thumb:${tileDims().tileW}`) + '.jpg');
}

function spriteCachePath(file, stat) {
  const frames = Math.max(2, Math.min(24, Number(config.frames) || 10));
  // "v2" = even-division spacing; invalidates midpoint-spaced sprites.
  return path.join(CACHE_DIR, cacheKey(file, stat, `sprite-v2:${frames}:${tileDims().tileW}`) + '.jpg');
}

/**
 * Metadata already on disk for this exact file version. Survives OneDrive
 * dehydration: the key is path + size + mtime, none of which change when
 * Windows reclaims the bytes.
 */
function cachedMeta(file, stat) {
  return metaIndex[cacheKey(file, stat, 'meta')] || null;
}

/** Must stay in lockstep with segmentTime() in public/app.js. */
function segmentSeek(duration, index, count) {
  if (!(duration > 0)) return 0;
  const at = (duration * (index + 1)) / count;
  return Math.min(at, Math.max(0, duration - 1));
}

/**
 * Builds an N-wide sprite strip. Every tile is letterboxed to the exact same
 * box, so the client can address frame i with pure percentage maths and
 * portrait videos are never stretched.
 */
async function ensureSprite(file, stat) {
  const frames = Math.max(2, Math.min(24, Number(config.frames) || 10));
  const { tileW, tileH } = tileDims();

  const out = spriteCachePath(file, stat);
  const key = path.basename(out, '.jpg');
  const sidecar = out + '.json';

  if (await exists(out)) {
    if (!spriteFrameCount.has(out)) {
      const info = loadJsonSync(sidecar, { frames });
      spriteFrameCount.set(out, info.frames || frames);
    }
    return { file: out, frames: spriteFrameCount.get(out) };
  }

  return ffLimit(async () => {
    if (await exists(out)) {
      return { file: out, frames: spriteFrameCount.get(out) || frames };
    }

    const meta = await getMeta(file, stat);
    const duration = meta.duration > 0 ? meta.duration : 0;
    const tmpDir = path.join(CACHE_DIR, 'tmp_' + key);
    await fsp.mkdir(tmpDir, { recursive: true });

    const vf = [
      `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
      `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:black`,
    ].join(',');

    try {
      const extracted = [];
      for (let i = 0; i < frames; i += 1) {
        // Even divisions: a 20-minute video split 10 ways gives 2:00, 4:00, …
        // The last is pulled a second short of the end to avoid a black frame.
        const seek = segmentSeek(duration, i, frames);
        const rawPath = path.join(tmpDir, `raw${i}.jpg`);
        try {
          await run('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-ss', seek.toFixed(3),
            '-i', file,
            '-frames:v', '1',
            '-vf', vf,
            '-q:v', '4',
            '-y', rawPath,
          ]);
          const st = await fsp.stat(rawPath).catch(() => null);
          if (st && st.size > 0) extracted.push(rawPath);
        } catch {
          // A seek past the last keyframe or a damaged region: skip this tile.
        }
      }

      if (extracted.length === 0) {
        const err = new Error('ffmpeg produced no frames for ' + path.basename(file));
        err.statusCode = 422;
        throw err;
      }

      // ffmpeg's image2 demuxer needs a contiguous %d sequence.
      for (let i = 0; i < extracted.length; i += 1) {
        await fsp.rename(extracted[i], path.join(tmpDir, `f${i}.jpg`));
      }

      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-start_number', '0',
        '-i', path.join(tmpDir, 'f%d.jpg'),
        '-filter_complex', `tile=${extracted.length}x1`,
        '-frames:v', '1',
        '-q:v', '4',
        '-y', out,
      ]);

      spriteFrameCount.set(out, extracted.length);
      await fsp.writeFile(sidecar, JSON.stringify({ frames: extracted.length, tileW, tileH })).catch(() => {});
      return { file: out, frames: extracted.length };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * A single poster frame. One ffmpeg seek instead of ten, so the grid fills
 * ~10x faster than sprite mode when live hovering supplies the motion.
 */
async function ensureThumb(file, stat) {
  const { tileW, tileH } = tileDims();
  const out = thumbCachePath(file, stat);

  if (await exists(out)) return out;

  return ffLimit(async () => {
    if (await exists(out)) return out;
    const meta = await getMeta(file, stat);
    // A quarter in: past titles and fades, still representative.
    const seek = meta.duration > 0 ? meta.duration * 0.25 : 0;
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', seek.toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', [
        `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease:flags=fast_bilinear`,
        `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:black`,
      ].join(','),
      '-q:v', '4',
      '-y', out,
    ]);
    const st = await fsp.stat(out).catch(() => null);
    if (!st || st.size === 0) {
      const err = new Error('ffmpeg produced no poster for ' + path.basename(file));
      err.statusCode = 422;
      throw err;
    }
    return out;
  });
}

// -------------------------------------------------------------- filesystem

async function listDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ':\\';
    if (await exists(root)) drives.push(root);
  }
  return drives;
}

async function listDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
    dirs.push({ name: entry.name, path: path.join(dir, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return dirs;
}

const SKIP_DIRS = new Set(['.cache', 'node_modules', 'system volume information', '$recycle.bin']);

/**
 * OneDrive "Files On-Demand" placeholders report their full logical size but
 * allocate no blocks on disk. Reading one byte makes Windows download the whole
 * file, so anything that touches pixels must check this first — a 28k-file
 * library is ~4.7TB and would never fit locally.
 */
function isCloudOnly(stat) {
  if (!stat.size) return false;
  return (stat.blocks || 0) * 512 < stat.size * 0.5;
}

async function statWithCloud(file) {
  const stat = await fsp.stat(file);
  return { stat, cloudOnly: isCloudOnly(stat) };
}

function shouldSkipDir(name) {
  // Dot-folders are metadata by convention, and one of them is ours: the
  // ratings file lives in .video-explorer at the sync root.
  return name.startsWith('$') || name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Walks everything under `dir` collecting video paths + cheap stats. No
 * ffprobe here — probing is the expensive step and only the files we
 * actually display get probed.
 */
async function collectVideos(dir) {
  const videos = [];
  const seen = new Set();

  async function walk(current, depth) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable folder — skip rather than abort the whole scan
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 12 || shouldSkipDir(entry.name)) continue;
        const real = path.resolve(full).toLowerCase();
        if (seen.has(real)) continue; // guard against junction loops
        seen.add(real);
        await walk(full, depth + 1);
      } else if (entry.isFile() && VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
        try {
          const stat = await fsp.stat(full);
          videos.push({
            path: full,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            cloudOnly: isCloudOnly(stat),
          });
        } catch {
          // vanished between readdir and stat — ignore
        }
      }
    }
  }

  await walk(dir, 0);
  return videos;
}

/** Immediate subfolders of `dir`, each annotated with what's inside it. */
async function listSubfolders(dir, videos) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const folders = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDir(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const prefix = path.resolve(full).toLowerCase() + path.sep;

    let count = 0;
    let cloudCount = 0;
    let totalSize = 0;
    let latestMtimeMs = 0;
    let cover = null;
    for (const video of videos) {
      if (!path.resolve(video.path).toLowerCase().startsWith(prefix)) continue;
      count += 1;
      if (video.cloudOnly) cloudCount += 1;
      totalSize += video.size;
      if (video.mtimeMs > latestMtimeMs) latestMtimeMs = video.mtimeMs;
      // Only a locally-present file can be a cover; a cloud one would download.
      if (!cover && !video.cloudOnly) cover = video.path;
    }

    folders.push({
      name: entry.name,
      path: full,
      videoCount: count,
      cloudCount,
      totalSize,
      latestMtimeMs,
      cover,
    });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return folders;
}

async function scanDirectory(dir, recursive, includeCloud) {
  const videos = await collectVideos(dir);
  const folders = await listSubfolders(dir, videos);

  const target = path.resolve(dir).toLowerCase();
  const atThisLevel = recursive
    ? videos
    : videos.filter((v) => path.dirname(path.resolve(v.path)).toLowerCase() === target);

  // Default: list only files actually downloaded to this machine.
  const shown = includeCloud ? atThisLevel : atThisLevel.filter((v) => !v.cloudOnly);
  const cloudHidden = atThisLevel.length - shown.length;

  // Deliberately NO ffprobe here. Probing 47 cloud-backed files took 91s and
  // silently downloaded gigabytes. Metadata is fetched per page via /api/meta.
  const files = shown.map((video) => ({
    path: video.path,
    name: path.basename(video.path),
    folder: path.dirname(video.path),
    relFolder: path.relative(dir, path.dirname(video.path)) || '.',
    ext: path.extname(video.path).toLowerCase(),
    size: video.size,
    mtimeMs: video.mtimeMs,
    cloudOnly: video.cloudOnly,
    // Free: the scan already holds the stat these are keyed by, so ratings and
    // tags arrive with the listing rather than costing a second round trip.
    ...library.decorate(video),
  }));

  const cloudBelow = videos.reduce((n, v) => n + (v.cloudOnly ? 1 : 0), 0);
  return { files, folders, totalBelow: videos.length, cloudBelow, cloudHidden };
}

// ------------------------------------------------------- tags into the file

/**
 * Artefacts are keyed by path + size + mtime, and embedding tags changes both
 * size and mtime — but not a single pixel. Carrying the cache across is the
 * difference between a free operation and re-encoding the file's previews.
 */
async function migrateCache(file, oldStat, newStat) {
  for (const build of [thumbCachePath, spriteCachePath]) {
    try {
      await fsp.rename(build(file, oldStat), build(file, newStat));
    } catch { /* nothing built for this file at the current settings */ }
  }
  const from = cacheKey(file, oldStat, 'meta');
  const to = cacheKey(file, newStat, 'meta');
  if (metaIndex[from]) {
    metaIndex[to] = metaIndex[from];
    delete metaIndex[from];
    saveMetaSoon();
  }
}

/**
 * Writes the sidecar's rating and tags into the MP4, so they travel with the
 * file to another device or a different player.
 *
 * This rewrites the whole container — there is no in-place edit for an `moov`
 * atom — which is why it is an explicit action rather than what an edit does by
 * default. Cloud placeholders are refused outright: writing to one would
 * download it first.
 */
async function embedTags(file) {
  const { stat, cloudOnly } = await statWithCloud(file);
  if (cloudOnly) {
    const err = new Error('Cloud-only: download it first, or tags would pull the whole file down');
    err.statusCode = 409;
    throw err;
  }

  const record = library.get(stat) || { rating: 0, tags: [] };
  const tags = record.tags || [];
  const tmp = path.join(CACHE_DIR, `embed-${crypto.randomBytes(6).toString('hex')}${path.extname(file)}`);

  const args = [
    '-v', 'error', '-y',
    '-i', file,
    '-map', '0', '-c', 'copy', '-ignore_unknown',
    // Without this the muxer keeps only the keys it recognises, and drops
    // `rating` on the floor. Verified: with it, both round-trip.
    '-movflags', 'use_metadata_tags',
    '-metadata', `keywords=${tags.join('; ')}`,
    '-metadata', `rating=${record.rating || ''}`,
    tmp,
  ];

  try {
    await ffLimit(() => run('ffmpeg', args));
    // Copy over the original rather than renaming onto it: the file keeps its
    // identity, so OneDrive treats this as an edit instead of a delete plus a
    // create, and the temp never lands in the synced folder.
    await fsp.copyFile(tmp, file);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }

  const after = await fsp.stat(file);
  library.rekey(stat, after, path.basename(file));
  await migrateCache(file, stat, after);
  return { rating: record.rating || 0, tags, size: after.size };
}

// ------------------------------------------------------------ file actions

/** Windows Recycle Bin, so a misclick is always recoverable. */
async function recycle(target) {
  const escaped = target.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    `$p = '${escaped}';`,
    'if (Test-Path -LiteralPath $p -PathType Container) {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '} else {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '}',
  ].join(' ');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

/** Never silently clobber: pick "name (2).mp4" style suffixes instead. */
async function uniqueDestination(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = path.join(dir, base);
  let n = 2;
  while (await exists(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

async function moveFile(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = await uniqueDestination(destDir, path.basename(src));
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dest); // different volume: copy then remove
    await fsp.unlink(src);
  }
  return dest;
}

async function copyFileTo(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const dest = await uniqueDestination(destDir, path.basename(src));
  await fsp.copyFile(src, dest);
  return dest;
}

async function renameFile(src, newName) {
  const clean = path.basename(newName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (!clean) throw new Error('Invalid file name');
  const withExt = path.extname(clean) ? clean : clean + path.extname(src);
  const dest = path.join(path.dirname(src), withExt);
  if (path.resolve(dest).toLowerCase() !== path.resolve(src).toLowerCase() && await exists(dest)) {
    throw new Error('A file with that name already exists');
  }
  await fsp.rename(src, dest);
  return dest;
}

function rememberDest(dir) {
  const resolved = path.resolve(dir);
  config.recentDests = [resolved, ...config.recentDests.filter((d) => d.toLowerCase() !== resolved.toLowerCase())].slice(0, 12);
  saveConfigSoon();
}

// ------------------------------------------------------------------- server

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, relPath) {
  const target = path.join(PUBLIC_DIR, relPath);
  if (!path.resolve(target).startsWith(path.resolve(PUBLIC_DIR))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      // no-store, not no-cache: a revalidating browser can still serve a stale
      // stylesheet from memory cache, which makes UI changes look like they
      // didn't apply. These files are local and tiny.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/** Range-aware streaming so the inline player can seek without downloading everything. */
async function streamVideo(req, res, file) {
  const stat = await fsp.stat(file);
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start = match && match[1] ? Number(match[1]) : 0;
  let end = match && match[2] ? Number(match[2]) : stat.size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  end = Math.min(end, stat.size - 1);

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function handleAction(body) {
  const op = String(body.op || '');
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const results = [];

  for (const raw of paths) {
    const src = authoriseOrThrow(raw);
    try {
      if (op === 'delete') {
        await recycle(src);
        results.push({ path: src, ok: true, message: 'Sent to Recycle Bin' });
      } else if (op === 'move') {
        if (!body.dest) throw new Error('No destination folder given');
        const destDir = path.resolve(body.dest);
        // Moving into the current folder would mint a "name (2).mp4" duplicate
        // rather than doing nothing, so refuse it outright.
        if (path.dirname(src).toLowerCase() === destDir.toLowerCase()) {
          results.push({ path: src, ok: false, message: 'Already in that folder' });
        } else {
          const dest = await moveFile(src, destDir);
          rememberDest(path.dirname(dest));
          results.push({ path: src, ok: true, dest, message: 'Moved' });
        }
      } else if (op === 'copy') {
        if (!body.dest) throw new Error('No destination folder given');
        const dest = await copyFileTo(src, path.resolve(body.dest));
        rememberDest(path.dirname(dest));
        results.push({ path: src, ok: true, dest, message: 'Copied' });
      } else if (op === 'rename') {
        const dest = await renameFile(src, String(body.newName || ''));
        results.push({ path: src, ok: true, dest, message: 'Renamed' });
      } else {
        const err = new Error('Unknown operation: ' + op);
        err.statusCode = 400;
        throw err;
      }
    } catch (err) {
      results.push({ path: src, ok: false, message: err.message || String(err) });
    }
  }

  return results;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(res, route.replace(/^\/+/, ''));
    }

    if (route === '/api/config') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ...config, homeAccount });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          if (key in body) config[key] = body[key];
        }
        // Emptying the path means "go back to following the account", not
        // "open on nothing" — so re-resolve rather than store a blank.
        if ('homeDir' in body || 'homeFollowsAccount' in body) await applyHomeDir();
        saveConfigSoon();
        return sendJson(res, 200, { ...config, homeAccount });
      }
    }

    if (req.method === 'GET' && route === '/api/drives') {
      return sendJson(res, 200, { drives: await listDrives() });
    }

    if (req.method === 'GET' && route === '/api/dirs') {
      const dir = url.searchParams.get('dir') || '';
      if (!dir) return sendJson(res, 200, { dir: '', parent: null, dirs: [], drives: await listDrives() });
      const resolved = path.resolve(dir);
      const parent = path.dirname(resolved);
      return sendJson(res, 200, {
        dir: resolved,
        parent: parent === resolved ? null : parent,
        dirs: await listDirs(resolved),
        drives: await listDrives(),
      });
    }

    if (req.method === 'GET' && route === '/api/scan') {
      const dir = url.searchParams.get('dir') || config.lastDir;
      if (!dir) return sendJson(res, 400, { error: 'No folder specified' });
      const resolved = path.resolve(dir);
      if (!(await exists(resolved))) return sendJson(res, 404, { error: 'Folder not found: ' + resolved });
      const recursive = url.searchParams.get('recursive') === '1';
      rememberRoot(resolved);
      const started = Date.now();
      const atHome = config.homeDir
        && path.resolve(config.homeDir).toLowerCase() === resolved.toLowerCase();
      // Absent means yes: a listing tells you what is in the folder, and
      // narrowing to what is downloaded is the availability filter's job. Only
      // an explicit cloud=0 holds cloud items back.
      const includeCloud = url.searchParams.get('cloud') !== '0';
      const scanned = await scanDirectory(resolved, recursive, includeCloud);

      // The default folder is a home page rather than a directory listing: it is
      // the one place where the sync root's own furniture — Documents, Music,
      // an apps folder — sits beside the libraries. Filtered here rather than in
      // the client so the folder count describes what is on screen.
      const shown = (config.homeFolders || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
      if (atHome && shown.length) {
        scanned.folders = scanned.folders.filter((f) => shown.includes(f.name.toLowerCase()));
      }

      const parent = path.dirname(resolved);
      log(`scanned ${resolved} -> ${scanned.files.length} listed, ${scanned.cloudHidden} cloud hidden, `
        + `${scanned.totalBelow} below (${scanned.cloudBelow} cloud), ${scanned.folders.length} folders `
        + `in ${Date.now() - started}ms`);
      return sendJson(res, 200, {
        dir: resolved,
        parent: parent === resolved ? null : parent,
        recursive,
        includeCloud,
        ...scanned,
      });
    }

    if (req.method === 'GET' && route === '/api/sprite') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { stat, cloudOnly } = await statWithCloud(target);
      if (cloudOnly
          && url.searchParams.get('allowCloud') !== '1'
          && !(await exists(spriteCachePath(target, stat)))) {
        return sendJson(res, 409, { error: 'cloud-only', cloudOnly: true, size: stat.size });
      }
      const { file, frames } = await ensureSprite(target, stat);
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'X-Sprite-Frames': String(frames),
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(data);
    }

    // Probes only the files a page actually shows, and never a cloud file
    // unless the user explicitly asked for it.
    if (req.method === 'POST' && route === '/api/meta') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 250) : [];
      const allowCloud = body.allowCloud === true;
      const meta = {};
      await Promise.all(paths.map(async (raw) => {
        try {
          const target = authoriseOrThrow(raw);
          const { stat, cloudOnly } = await statWithCloud(target);
          // Cached metadata is free and outlives dehydration — always use it.
          const known = cachedMeta(target, stat);
          if (known) {
            meta[raw] = { ...known, cloudOnly };
            return;
          }
          if (cloudOnly && !allowCloud) {
            meta[raw] = { cloudOnly: true, skipped: true };
            return;
          }
          const probed = await getMeta(target, stat);
          adoptEmbedded(target, stat, probed);
          meta[raw] = { ...probed, cloudOnly, ...library.decorate(stat) };
        } catch (err) {
          meta[raw] = { error: err.message || String(err) };
        }
      }));
      return sendJson(res, 200, { meta });
    }

    if (route === '/api/library') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          tags: library.tagCounts(),
          models: library.modelCounts(),
          studios: library.studioCounts(),
          productions: library.productionCounts(),
          favourites: library.favouriteModels(),
          stats: library.stats(),
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const paths = Array.isArray(body.paths) ? body.paths : [];
        const records = {};
        for (const raw of paths) {
          try {
            const target = authoriseOrThrow(raw);
            const stat = await fsp.stat(target);
            records[raw] = library.apply(stat, path.basename(target), body);
          } catch (err) {
            records[raw] = { error: err.message || String(err) };
          }
        }
        return sendJson(res, 200, {
          records,
          tags: library.tagCounts(),
          models: library.modelCounts(),
          studios: library.studioCounts(),
          productions: library.productionCounts(),
        });
      }
    }

    if (req.method === 'POST' && route === '/api/favourites') {
      const body = await readBody(req);
      const favourites = library.setFavouriteModel(body.name, body.on !== false);
      return sendJson(res, 200, { favourites });
    }

    if (req.method === 'POST' && route === '/api/library/embed') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const results = [];
      for (const raw of paths) {
        try {
          const target = authoriseOrThrow(raw);
          const written = await embedTags(target);
          results.push({ path: raw, ok: true, ...written });
        } catch (err) {
          results.push({ path: raw, ok: false, error: err.message || String(err) });
        }
      }
      log(`embedded tags into ${results.filter((r) => r.ok).length} of ${paths.length} files`);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'GET' && route === '/api/graph') {
      if (!graph) return sendJson(res, 200, { available: false, signedIn: false });
      const signedIn = graph.isSignedIn();
      if (!signedIn) return sendJson(res, 200, { available: true, signedIn: false });
      try {
        const me = await graph.whoAmI();
        return sendJson(res, 200, { available: true, signedIn: true, account: me });
      } catch (err) {
        return sendJson(res, 200, { available: true, signedIn: false, error: err.message });
      }
    }

    if (req.method === 'GET' && route === '/api/thumb') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { stat, cloudOnly } = await statWithCloud(target);
      const cachePath = thumbCachePath(target, stat);
      const allowCloud = url.searchParams.get('allowCloud') === '1';

      // Refuse to BUILD locally for a cloud file, but always SERVE one already
      // built — and before giving up, ask OneDrive for the thumbnail it already
      // has, which costs ~16KB and hydrates nothing.
      if (cloudOnly && !allowCloud && !(await exists(cachePath))) {
        const fromGraph = await graphThumbnail(target);
        if (fromGraph) {
          await fsp.mkdir(path.dirname(cachePath), { recursive: true });
          await fsp.writeFile(cachePath, fromGraph);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': fromGraph.length,
            'X-Thumb-Source': 'graph',
            'Cache-Control': 'private, max-age=86400',
          });
          return res.end(fromGraph);
        }
        return sendJson(res, 409, { error: 'cloud-only', cloudOnly: true, size: stat.size });
      }

      const data = await fsp.readFile(await ensureThumb(target, stat));
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(data);
    }

    if (req.method === 'GET' && route === '/api/video') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { cloudOnly } = await statWithCloud(target);

      // Reading a cloud placeholder locally would make Windows download the
      // whole file. Redirect to OneDrive's own range-capable URL instead: the
      // browser streams from the cloud and the placeholder stays empty.
      if (cloudOnly) {
        const streamUrl = await graphStreamUrl(target).catch(() => null);
        if (streamUrl) {
          res.writeHead(302, { Location: streamUrl, 'Cache-Control': 'no-store' });
          return res.end();
        }
        return sendJson(res, 409, {
          error: 'This file is cloud-only and OneDrive streaming is unavailable. '
            + 'Sign in with: node graph-login.js',
          cloudOnly: true,
        });
      }

      return streamVideo(req, res, target);
    }

    if (req.method === 'POST' && route === '/api/action') {
      const body = await readBody(req);
      return sendJson(res, 200, { results: await handleAction(body) });
    }

    if (req.method === 'POST' && route === '/api/cache/clear') {
      await fsp.rm(CACHE_DIR, { recursive: true, force: true });
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      metaIndex = {};
      spriteFrameCount.clear();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Unknown endpoint: ' + route });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) log('ERROR', route, err.message);
    if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
    else res.end();
  }
});

/**
 * Chrome/Edge "--app=" opens a plain window: no tabs, no address bar, its own
 * taskbar button. Closest thing to a native window without bundling a browser.
 */
function findBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  return candidates.find((exe) => exe && fs.existsSync(exe)) || null;
}

function openWindow(url) {
  const browser = process.env.APP_WINDOW === '0' ? null : findBrowser();
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1500,950'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  // No Chromium browser found: fall back to whatever handles http.
  spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function checkFfmpeg() {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      await run(bin, ['-version']);
    } catch {
      log(`WARNING: "${bin}" was not found on PATH. Previews will not generate.`);
      log('  Install with:  winget install Gyan.FFmpeg');
      return false;
    }
  }
  return true;
}

async function main() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  config = { ...DEFAULT_CONFIG, ...loadJsonSync(CONFIG_FILE, {}) };
  // Flattening is a view you reach for, not a mode you live in: reopening the
  // app into 5,682 videos from one folder is jarring, so it starts off.
  config.recursive = false;
  // Same for the ordering: every launch starts on your own judgement, highest
  // first, with the unrated bulk below it. A session can sort however it likes
  // and that choice is still written down -- it just does not decide what you
  // see when you next open the app.
  config.sort = 'rating';
  config.sortDir = 'desc';
  await applyHomeDir();
  const lib = await library.init(ONEDRIVE_ROOT);
  log(`ratings and tags: ${lib.count} records at ${lib.file}`);
  metaIndex = loadJsonSync(META_FILE, {});
  log(`${Object.keys(metaIndex).length} cached metadata entries`);
  await checkFfmpeg();

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    log(`ready at ${url}`);
    log(`cache: ${CACHE_DIR}`);
    if (!process.env.NO_OPEN) openWindow(url);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use. Start with a different one:  set PORT=4400 && node server.js`);
    process.exit(1);
  }
  throw err;
});

main();
