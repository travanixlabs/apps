'use strict';

/**
 * The settings, where they live, and what they authorise.
 *
 * Holds the one piece of shared mutable state the server has: `state`, below.
 * The settings object, the cache folder, the metadata file, the sync root and
 * the account behind it are all replaced at startup -- once the home folder is
 * known -- so every other module reads them through `state` rather than
 * holding a copy that would go stale.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const faces = require('../faces');
const dupes = require('../dupes');
const framing = require('../framing');

const { log, exists, sleep } = require('./util');

// Optional: absent or signed-out simply means no cloud thumbnails.
let graph = null;
try {
  graph = require('../graph');
} catch {
  graph = null;
}

// One up from here: server/ holds the code, the app folder holds public/,
// config.json and the rest.
const APP_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// What the page and the server both load -- shared/facets.js. Beside public/
// rather than in it, because the server requires it too and the phone keeps a
// copy; served at /shared/.
const SHARED_DIR = path.join(APP_DIR, 'shared');
// Settings live next to the source when run directly. The packaged app points
// this at its per-user data folder, so it never writes inside Program files.
const CONFIG_FILE = process.env.VIDEO_EXPLORER_CONFIG || path.join(APP_DIR, 'config.json');

/**
 * Previews and face profiles live in OneDrive, beside the labels.
 *
 * They used to be deliberately local, on the reasoning that regenerable bulk is
 * not worth syncing. That reasoning was wrong about the word "regenerable".
 * Rebuilding a preview strip means decoding the video again -- and for a video
 * since freed up to the cloud, downloading it first. A face profile is seven
 * seconds of ffmpeg and inference. Neither is recoverable from nothing; both are
 * simply cheaper to copy than to make.
 *
 * Set beside library.json rather than in a folder of its own so everything this
 * app knows about a library is in one place, and a second machine inherits the
 * lot. Around 600MB once fully populated, against a library measured in
 * terabytes. VIDEO_EXPLORER_CACHE still overrides it.
 */
function defaultCacheDir(oneDriveRoot) {
  if (process.env.VIDEO_EXPLORER_CACHE) return process.env.VIDEO_EXPLORER_CACHE;
  if (oneDriveRoot) return path.join(oneDriveRoot, '.video-explorer', 'cache');
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'cache');
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;

// Last-resort home folder. %OneDrive% is whichever account signed in first, so
// it is a fallback rather than the answer — see resolveHomeDir().
const ENV_HOME = process.env.OneDrive
  || process.env.OneDriveConsumer
  || process.env.OneDriveCommercial
  || path.join(os.homedir(), 'OneDrive');

const DEFAULT_CONFIG = {
  roots: [],          // folders the user has pointed at (authorises reads)
  rootsSeen: {},      // lowercased root -> when it was last opened, so it can expire
  cacheNamesV2: false, // whether cached previews have been renamed to derivable names
  cacheTidyV3: false,  // whether the legacy-named leftovers have been swept up
  homeFollowsAccount: true, // resolve home from the signed-in OneDrive account
  homeDir: '',        // opened on launch, and by the home button
  cardDetails: true,  // the date · resolution · folder line under each card's name
  // Folder names to show at the default folder, by name rather than path so the
  // list survives the sync folder moving. Empty means show whatever is there.
  homeFolders: [],
  lastDir: '',
  recentDests: [],    // recent move/copy destinations
  previewMode: 'live', // 'live' = seek+play the real file; 'sprite' = pre-rendered stills
  frames: 10,         // preview segments per video
  dwellMs: 2000,      // ms per segment while hovering
  tileWidth: 640,     // poster/sprite tile width; matches the largest card size
  cardWidth: 200,     // smallest tile: the most videos on screen at once
  volume: 1,          // master playback volume, 0..1 — a preference, not a view
  autoNext: false,    // when a video ends, play the next one
  foldersCollapsed: false,
  recursive: false,   // explorer-style by default: one folder level at a time
  // '' | 'models' | 'suggested': the grid split into a section per performer,
  // by who is credited or by who the faces look like. `true` from an older
  // build still means 'models'.
  grouped: '',

  // What colour a label is drawn in, by lowercased label. A label with no
  // entry gets the default chip colour, so this stays empty until you pick.
  labelColours: {},
  // Labels you have made but not put on anything yet. A tag otherwise exists
  // only by being used, so without this "add" would have nothing to add to.
  spareLabels: [],
  // One colour each for the three facets that are one value per video. They
  // are a kind, not a vocabulary, so they do not get a colour per value.
  facetColours: { models: '' },

  scrubWithMouse: false,
  // Highest rated first: your own judgement beats any property of the file.
  // Everything unrated falls below, in name order.
  sort: 'rating',
  sortDir: 'desc',
};

/**
 * Everything here that is replaced rather than edited in place, in one object,
 * so every module sees the current value rather than whatever it was when that
 * module was loaded.
 */
const state = {
  // The settings, read from CONFIG_FILE at startup over DEFAULT_CONFIG.
  config: { ...DEFAULT_CONFIG },
  // Moved under the sync root once the account is known -- see main().
  CACHE_DIR: defaultCacheDir(process.env.OneDrive || ''),
  META_FILE: '',
  // The sync root that Graph paths are resolved against. Starts as the
  // environment's guess and is replaced once the real account is identified.
  ONEDRIVE_ROOT: ENV_HOME,
  // Which account's folder we settled on, for the UI to explain itself.
  homeAccount: { email: '', source: 'env', choices: [] },
  // Folders the picker has opened this session, lower-cased: the one step a
  // person takes before choosing one as a destination (see fileops).
  browsed: new Set(),
  // Whether ffmpeg and ffprobe could be started at launch, and if not, why.
  // The sweeps are not started without them -- see server.js -- and the page
  // says what to install.
  ffmpeg: { ok: true, reason: '' },
};
state.META_FILE = path.join(state.CACHE_DIR, 'meta.json');

let saveTimer = null;
function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeConfig();
    writeColours();
  }, 300);
}

/**
 * The config file, written whole and one write at a time.
 *
 * Two writes used to be able to overlap -- the debounce only coalesces calls
 * that land within 300ms of each other, and a slow disk can take longer than
 * that -- and two writeFile calls on the same file interleave: the result was
 * a truncated config.json, which loads as nothing, which is every setting
 * silently back to its default. So writes queue behind one another, and each
 * lands through a temporary file and a rename so a kill mid-write leaves the
 * previous file whole. The body is taken when the write is queued, so the last
 * one queued is the one that ends up on the disk.
 */
let configWriting = Promise.resolve();
function writeConfig() {
  const body = JSON.stringify(state.config, null, 2);
  configWriting = configWriting.then(async () => {
    const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(temp, body);
    for (let i = 0; i < 5; i += 1) {
      try { await fsp.rename(temp, CONFIG_FILE); return; } catch (err) {
        if (i === 4) {
          await fsp.unlink(temp).catch(() => {});
          throw err;
        }
        await sleep(60 * (i + 1));
      }
    }
  }).catch((err) => log('config not saved:', err.message));
  return configWriting;
}

/** For shutdown: a save still waiting on its debounce goes now, and is waited for. */
function flushConfig() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    writeConfig();
  }
  return configWriting;
}

/**
 * The colours Settings picked, where the phone can read them.
 *
 * The config file is this machine's alone -- it lives in %APPDATA%, not in
 * OneDrive -- so the phone had no way to know a label's colour and drew every
 * tag grey. Beside the cache manifest, which it already reads, and only
 * rewritten when the colours actually change, so a synced folder is not
 * re-uploading the same bytes.
 */
async function writeColours() {
  const body = JSON.stringify({
    version: 1,
    labels: state.config.labelColours || {},
    facets: state.config.facetColours || {},
  });
  try {
    const at = path.join(state.CACHE_DIR, 'colours.json');
    if (await fsp.readFile(at, 'utf8').catch(() => '') === body) return;
    await fsp.mkdir(state.CACHE_DIR, { recursive: true });
    await fsp.writeFile(at, body);
  } catch { /* an offline sync folder is not worth an error */ }
}

// ------------------------------------------------------- OneDrive accounts

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
  if (state.config.homeFollowsAccount === false && state.config.homeDir) {
    state.homeAccount = { email: '', source: 'fixed', choices: oneDriveAccounts().map((a) => ({ email: a.email, folder: a.folder })) };
  } else {
    const resolved = await resolveHomeDir();
    state.config.homeDir = resolved.dir;
    state.homeAccount = { email: resolved.email, source: resolved.source, choices: resolved.choices };
  }
  const account = state.homeAccount.choices.find((c) => c.email && c.email === state.homeAccount.email);
  state.ONEDRIVE_ROOT = (account && account.folder) || ENV_HOME;
  log(`home: ${state.config.homeDir}${state.homeAccount.email ? ' (' + state.homeAccount.email + ')' : ''} [${state.homeAccount.source}]`);
}

/** Sources must live under a folder the user explicitly opened. */
function isAuthorised(target) {
  const resolved = path.resolve(target);
  return state.config.roots.some((root) => {
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

/**
 * How long a root outlives the last time you looked at the folder.
 *
 * Listing a folder grants read access to everything under it, and nothing ever
 * took that back. Two months of not opening a folder is a clear enough answer,
 * and reopening it grants access again in the same instant it always did.
 */
const ROOT_DAYS = 60;

const under = (child, parent) => {
  const c = path.resolve(child).toLowerCase();
  const r = path.resolve(parent).toLowerCase();
  return c === r || c.startsWith(r + path.sep);
};

/**
 * Narrows a folder to the home folder when it sits above it.
 *
 * Opening your user folder once — to find a download, to check something — used
 * to authorise reads across the whole profile from then on, permanently, because
 * a root is granted by listing and never withdrawn. Listing does not need the
 * grant, so nothing about browsing changes; what changes is that the grant stops
 * at the sync root instead of swallowing everything above it. The face sweep
 * already clamps its walk exactly here, for exactly this reason.
 *
 * Only ancestors are affected. A folder on another drive, or anywhere else
 * outside home, is authorised as itself.
 */
function clampRoot(dir) {
  const resolved = path.resolve(dir);
  const home = state.config.homeDir || state.ONEDRIVE_ROOT;
  if (home && under(home, resolved) && !under(resolved, home)) return path.resolve(home);
  return resolved;
}

/**
 * Reduces the authorised list to the smallest set that grants the same access.
 *
 * A root inside another root grants nothing the outer one did not already —
 * eight folders under the sync root are one root's worth of permission written
 * down eight times, and each is a line somebody has to read to know what this
 * app can touch. Shortest first, so an ancestor is always seen before the
 * children it absorbs.
 */
function collapseRoots(roots) {
  const seen = new Map();
  for (const raw of roots) {
    const resolved = clampRoot(raw);
    seen.set(resolved.toLowerCase(), resolved);
  }
  const sorted = [...seen.values()].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const root of sorted) {
    if (!kept.some((keeper) => under(root, keeper))) kept.push(root);
  }
  return kept;
}

/**
 * Startup housekeeping on the authorised list: clamp anything above home,
 * forget folders that are gone, forget folders unopened in two months, and
 * collapse what is left.
 *
 * The home folder and the folder the app is about to open are never dropped,
 * whatever the timestamps say — one of them is where you are.
 */
async function pruneRoots() {
  const before = state.config.roots.length;
  const now = Date.now();
  const seen = (state.config.rootsSeen && typeof state.config.rootsSeen === 'object') ? state.config.rootsSeen : {};
  const home = state.config.homeDir || state.ONEDRIVE_ROOT || '';
  const lastDir = state.config.lastDir ? clampRoot(state.config.lastDir) : '';
  const kept = [];
  const gone = [];
  const stale = [];

  // Narrowing is silent in collapseRoots because it happens on every add; at
  // startup it is worth saying out loud, since it is the one change here that
  // takes away access somebody once had.
  const narrowed = state.config.roots.filter((r) => clampRoot(r).toLowerCase() !== path.resolve(r).toLowerCase());
  if (narrowed.length) {
    log(`narrowed ${narrowed.length} folder(s) above home to ${home}: ${narrowed.join(', ')}`);
  }

  for (const root of collapseRoots(state.config.roots)) {
    const key = root.toLowerCase();
    // Where you are, and where you are about to be.
    const spared = (home && under(home, root) && under(root, home))
      || (lastDir && under(lastDir, root));
    if (!spared && !(await exists(root))) { gone.push(root); continue; }
    // A root with no timestamp predates this bookkeeping; today is the honest
    // answer, since the alternative is deleting on a date nobody recorded.
    const last = Number(seen[key]) || now;
    if (!spared && now - last > ROOT_DAYS * 86400000) { stale.push(root); continue; }
    seen[key] = last;
    kept.push(root);
  }

  // Timestamps for roots no longer held are just clutter in the file.
  for (const key of Object.keys(seen)) {
    if (!kept.some((root) => root.toLowerCase() === key)) delete seen[key];
  }

  state.config.roots = kept;
  state.config.rootsSeen = seen;
  if (gone.length) log(`forgot ${gone.length} folder(s) that no longer exist: ${gone.join(', ')}`);
  if (stale.length) log(`forgot ${stale.length} folder(s) unopened for ${ROOT_DAYS} days: ${stale.join(', ')}`);
  if (kept.length !== before) log(`authorised folders: ${before} -> ${kept.length}`);
  if (kept.length !== before || JSON.stringify(state.config.rootsSeen) !== JSON.stringify(seen)) saveConfigSoon();
  return { before, after: kept.length, gone, stale };
}

function rememberRoot(dir) {
  const resolved = path.resolve(dir);
  const root = clampRoot(resolved);
  const had = state.config.roots.length;
  state.config.roots = collapseRoots([...state.config.roots, root]);
  if (!state.config.rootsSeen || typeof state.config.rootsSeen !== 'object') state.config.rootsSeen = {};
  state.config.rootsSeen[root.toLowerCase()] = Date.now();
  // Opening a folder inside one already authorised adds nothing to sweep; only
  // genuinely new ground makes the denominator wrong.
  if (state.config.roots.length !== had) {
    faces.rootsChanged();
    dupes.rootsChanged();
    framing.rootsChanged();
  }
  state.config.lastDir = resolved;
  saveConfigSoon();
}

function rememberDest(dir) {
  const resolved = path.resolve(dir);
  state.config.recentDests = [resolved, ...state.config.recentDests.filter((d) => d.toLowerCase() !== resolved.toLowerCase())].slice(0, 12);
  saveConfigSoon();
}

module.exports = {
  graph, PUBLIC_DIR, SHARED_DIR, CONFIG_FILE, defaultCacheDir, HOST, PORT, DEFAULT_CONFIG,
  saveConfigSoon, flushConfig, writeColours, applyHomeDir, authoriseOrThrow,
  collapseRoots, pruneRoots, rememberRoot, rememberDest, state,
};
