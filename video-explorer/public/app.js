'use strict';

/* Video Explorer front-end: sprite-scrubbing grid + hover quick actions. */

const $ = (sel) => document.querySelector(sel);

/** The only scrolling element — observers must measure against it, not the page. */
const scrollRoot = document.getElementById('scrollArea');

// The facet tables, the filter object and the matcher live in filter.js, which
// the page loads before this file and the server requires. They were here until
// the folder tiles had to say how many videos in a subfolder match -- a question
// only the server can answer, since it is the only one holding those videos.
// Read them as globals below: CHOICES, CHOICE_FACETS, FACETS, LABEL_FACETS,
// NOTHING, SINGLE_VALUED, newAdvFilter, picked, choiceMatch, matchesAdvanced.

const state = {
  config: {},
  files: [],          // videos shown for the current folder
  folders: [],        // immediate subfolders of the current folder
  view: [],           // filtered + sorted
  dir: '',
  parent: null,
  history: [],        // folders visited, oldest first
  historyIndex: -1,   // where we currently sit in that list
  totalBelow: 0,
  cloudBelow: 0,
  rendered: 0,        // how many of state.view are on screen (pagination)
  meta: new Map(),    // path -> probed metadata, filled in per page
  metaAsked: new Set(),
  cloudOptIn: new Set(), // cloud files the user explicitly chose to fetch
  cards: [],           // grouped: every card in reading order, for the player
  playing: null,      // file open in the player modal
  playingAnchor: null, // the slot it held, once a filter drops it from the view
  // Which card it was opened from, grouped: the same video sits in a section per
  // performer, so "the next one" depends on which copy you clicked.
  playingCard: null,
  selected: new Set(),
  lastClickedIndex: -1,
  rangeList: null,     // which list that index was into: a section, or the view
  sprites: new Map(),  // path -> { url, frames }
  thumbs: new Map(),   // path -> poster blob URL
  pending: new Map(),  // path -> in-flight poster/sprite promise
  failed: new Set(),
  picker: null,        // { dir, onConfirm, title }
  // '' | 'models' | 'suggested' -- off, by who is credited, by who the faces
  // look like. Empty rather than false because everything downstream asks
  // whether it is grouped far more often than it asks how.
  grouped: '',
  groups: [],          // [{ key, name, files }] when grouped, favourites first
  slots: [],           // the grouped layout flattened: a heading or a card
  favourites: [],      // performer names marked a favourite, library-wide
  favSet: new Set(),   // the same, lower-cased, for asking about one video
  tagVocab: [],        // [{ tag, count }] across the whole library
  modelVocab: [],      // the same, for performer names
  studioVocab: [],     // and for production houses, of which a video has one
  productionVocab: [], // and for reference codes — MD, RS, MCY — likewise one
  tagTargets: [],      // files the open label dialog will edit
  adv: newAdvFilter(), // the advanced filter currently applied
};



/**
 * Which row draws which facet, and what each answer is called.
 *
 * One table rather than six near-identical loops in the renderer: they differed
 * only in their host element and their labels, and every difference between
 * them was a chance for one to drift.
 */
const CHOICE_ROWS = [
  ['#advFav', 'favourite', [
    ['yes', 'a favourite is in it'],
    ['no', 'nobody marked'],
  ]],
  ['#advSuggested', 'suggested', [
    ['match', 'profiled with matching model',
      'read for faces, and every performer recognised in it is already named on '
      + 'it \u2014 nothing left to do'],
    ['nomatch', 'profiled without matching model',
      'read for faces, and someone recognised in it is not named on it. Videos '
      + 'that held no usable face are not in here'],
    ['faceless', 'no usable face',
      'read for faces and none came out usable \u2014 shot from behind, too dark, '
      + 'or too few faces to be sure they are one person'],
    ['unprofiled', 'not profiled', 'not read for faces yet'],
  ]],
  ['#advSuggestedCount', 'suggestedCount', [
    ['one', 'one model suggested',
      'the faces in it were matched to exactly one performer'],
    ['many', 'multiple models suggested',
      'the faces clustered into several people and each found a name. With '
      + '"profiled without matching model", this is the missing co-star'],
  ]],
  ['#advSuggestedAct', 'suggestedAct', [
    ['accepted', 'accepted (incl. already matched)',
      'a suggested name is credited on it \u2014 whether you took it or it was '
      + 'already there'],
    ['rejected', 'rejected',
      'a name has been turned down on it, so the recogniser stopped offering her'],
    ['pending', 'pending',
      'a name is still offered and not credited \u2014 a decision you have not made '
      + 'yet. Videos with nothing suggested are not in here; there is nothing '
      + 'pending on those'],
  ]],
  ['#advLink', 'link', [
    ['yes', 'has a link'],
    ['no', 'no link'],
  ]],
  ['#advCloud', 'cloud', [
    ['downloaded', 'downloaded only'],
    ['cloud', 'cloud only \u2601'],
  ]],
  ['#advDupe', 'duplicate', [
    ['both', 'both match',
      'the soundtrack AND the picture both found the same other video, and '
      + 'agreed on the same offset between them. As certain as this gets'],
    ['sound', 'sound matches',
      'the soundtrack lines up with another video. Finds a copy that was '
      + 're-cropped, letterboxed or watermarked, which the picture would miss'],
    ['picture', 'video matches',
      'the frames and the shot-change rhythm line up with another video. Finds '
      + 'a copy that was re-dubbed, re-scored or muted, which the sound '
      + 'would miss'],
    ['no', 'the only copy',
      'read and found unique. Cloud videos are not in here, because nothing '
      + 'has been read of them and neither answer would be true'],
  ]],
];

/** Which radio group drives which facet's all/any. Studio has none. */
const MODE_INPUTS = [['tags', 'tagMode'], ['models', 'modelMode']];

/**
 * How the listing is set up, as opposed to how the app is configured. A refresh
 * puts these back; card size, preview engine and the default folder are
 * preferences and survive it.
 */
const VIEW_DEFAULTS = { sort: 'rating', sortDir: 'desc', recursive: false, grouped: '' };
const RESET_KEY = 've-reset-home';

/** Drops filters, search and sort back to the defaults, saving as it goes. */
function resetView() {
  Object.assign(state.config, VIEW_DEFAULTS);
  state.grouped = '';
  syncGroupButton();
  saveConfig({ ...VIEW_DEFAULTS });
  state.adv = newAdvFilter();
  advDraft = newAdvFilter();
  // Chromium restores form values across a reload, so this is cleared rather
  // than assumed empty.
  $('#searchInput').value = '';
  syncAdvBadge();
}

/** The applied filter, unless asked about another one -- the draft, usually. */
function advActive(adv = state.adv) {
  return filterActive(adv);
}

/**
 * The one fact the shared matcher cannot work out from a video: which
 * performers are marked as favourites. The server reads the same list off the
 * library when it counts a folder, so both sides answer "a favourite is in it"
 * the same way.
 */
const filterCtx = () => ({ favSet: state.favSet });

// ----------------------------------------------------------------- utilities

function fmtBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function fmtBitrate(bps) {
  if (!bps) return null;
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
    // A message that asks you to do something has to outlast a glance.
  }, kind === 'err' || kind === 'warn' ? 6000 : 3200);
}

function setStatus(text) {
  $('#status').textContent = text || '';
}

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

async function saveConfig(patch) {
  Object.assign(state.config, patch);
  try {
    state.config = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    toast('Could not save settings: ' + err.message, 'err');
  }
}

// ------------------------------------------------------------------ scanning

async function scan(dir, { record = true } = {}) {
  const target = (dir || $('#dirInput').value).trim();
  if (!target) { toast('Enter a folder path first', 'err'); return; }

  setStatus('Scanning…');
  $('#empty').hidden = true;
  try {
    // The scan always lists everything that is there. Narrowing to what is
    // downloaded is a filter, not a different listing — Advanced filters →
    // Availability — so the count in the heading stays honest about the folder.
    const recursive = $('#recursiveToggle').checked ? '1' : '0';
    const data = await api(
      `/api/scan?dir=${encodeURIComponent(target)}&recursive=${recursive}`,
    );
    state.dir = data.dir;
    state.parent = data.parent;
    if (record) pushHistory(data.dir);
    state.files = data.files;
    state.folders = data.folders || [];
    state.totalBelow = data.totalBelow || 0;
    state.cloudBelow = data.cloudBelow || 0;
    state.selected.clear();
    state.lastClickedIndex = -1;
    state.meta.clear();
    state.metaAsked.clear();
    clearSprites();
    $('#dirInput').value = data.dir;
    saveConfig({
      lastDir: data.dir,
      recursive: $('#recursiveToggle').checked,
    });
    render();
    if (scrollRoot) scrollRoot.scrollTop = 0;
  } catch (err) {
    setStatus('');
    $('#empty').hidden = false;
    toast(err.message, 'err');
  }
}

/** Navigating into a folder is just a scan of that folder. */
function navigateTo(dir) {
  $('#dirInput').value = dir;
  scan(dir);
}

// ------------------------------------------------------------------ history

/**
 * Browser-style history. Visiting a folder after going back discards the
 * forward entries, exactly as a browser does.
 */
function pushHistory(dir) {
  if (state.history[state.historyIndex] === dir) return; // re-scan, not a move
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(dir);
  state.historyIndex = state.history.length - 1;
}

function canGoBack() {
  return state.historyIndex > 0;
}

function canGoForward() {
  return state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;
}

function goBack() {
  if (!canGoBack()) return;
  state.historyIndex -= 1;
  const dir = state.history[state.historyIndex];
  $('#dirInput').value = dir;
  scan(dir, { record: false });
}

function goForward() {
  if (!canGoForward()) return;
  state.historyIndex += 1;
  const dir = state.history[state.historyIndex];
  $('#dirInput').value = dir;
  scan(dir, { record: false });
}

function renderBreadcrumb() {
  const bar = $('#breadcrumb');
  if (!state.dir) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';

  const backBtn = document.createElement('button');
  backBtn.className = 'crumb-nav btn btn-icon';
  backBtn.textContent = '←';
  backBtn.disabled = !canGoBack();
  backBtn.title = canGoBack()
    ? 'Back to ' + baseName(state.history[state.historyIndex - 1]) + '   (Alt+←)'
    : 'Nothing to go back to';
  backBtn.addEventListener('click', goBack);
  bar.appendChild(backBtn);

  const fwdBtn = document.createElement('button');
  fwdBtn.className = 'crumb-nav btn btn-icon';
  fwdBtn.textContent = '→';
  fwdBtn.disabled = !canGoForward();
  fwdBtn.title = canGoForward()
    ? 'Forward to ' + baseName(state.history[state.historyIndex + 1]) + '   (Alt+→)'
    : 'Nothing to go forward to';
  fwdBtn.addEventListener('click', goForward);
  bar.appendChild(fwdBtn);

  const home = state.config.homeDir;
  if (home) {
    const homeBtn = document.createElement('button');
    homeBtn.className = 'crumb-nav btn btn-icon';
    homeBtn.textContent = '🏠';
    const atHome = samePath(home, state.dir);
    homeBtn.title = atHome ? 'Already in the default folder' : 'Default folder: ' + home;
    homeBtn.disabled = atHome;
    homeBtn.addEventListener('click', () => navigateTo(home));
    if (!atHome) attachDropTarget(homeBtn, home, baseName(home) || home);
    bar.appendChild(homeBtn);
  }

  const upBtn = document.createElement('button');
  upBtn.className = 'crumb-up btn btn-icon';
  upBtn.textContent = '↑';
  upBtn.title = state.parent ? 'Up to ' + state.parent : 'Already at the top';
  upBtn.disabled = !state.parent;
  upBtn.addEventListener('click', () => state.parent && navigateTo(state.parent));
  if (state.parent) attachDropTarget(upBtn, state.parent, baseName(state.parent) || state.parent);
  bar.appendChild(upBtn);

  // Split "C:\a\b" into a clickable trail: C:\ > a > b
  const parts = state.dir.split(/[\\/]/).filter(Boolean);
  let accumulated = '';
  parts.forEach((part, index) => {
    accumulated = index === 0 ? part + '\\' : accumulated.replace(/\\$/, '') + '\\' + part;
    const target = accumulated;
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      bar.appendChild(sep);
    }
    const isCurrent = index === parts.length - 1;
    const crumb = document.createElement('button');
    crumb.className = 'crumb' + (isCurrent ? ' current' : '');
    crumb.textContent = part;
    crumb.title = target;
    crumb.addEventListener('click', () => navigateTo(target));
    // The current folder is not a drop target — files are already in it.
    if (!isCurrent) attachDropTarget(crumb, target, part);
    bar.appendChild(crumb);
  });
}

/**
 * How many videos in each subfolder survive the advanced filter.
 *
 * The page cannot work this out. It holds the videos of the folder it is
 * standing in; a subfolder's videos were never sent, and at the library root
 * there are 28,000 of them. So the filter goes to the server, which is holding
 * the walk the scan already did, and comes back as one number per folder.
 *
 * `key` is the folder and the filter together: a render that changed neither
 * costs nothing, and one that changed either asks again exactly once. `counts`
 * being null with a key set means the answer is still in flight -- which the
 * tile says, rather than showing a number it does not have yet.
 */
const folderCounts = { key: '', counts: null };

/** The folder and filter a count would be for, or '' when nothing is filtered. */
function folderCountKey() {
  if (!advActive()) return '';
  return state.dir + '\u0000' + JSON.stringify(packFilter(state.adv));
}

/**
 * Whether the question has changed, and an answer has to be fetched.
 *
 * Separate from the fetching, and called BEFORE the tiles are drawn, because
 * the store still holds the last folder's answer at that point -- counts filed
 * under paths that are no longer on screen. Drawing first showed every tile as
 * uncounted for a frame before the request even went out.
 */
function folderCountsStale() {
  const key = folderCountKey();
  if (key === folderCounts.key) return false;
  folderCounts.key = key;
  folderCounts.counts = null;
  // Nothing filtered: every video in a folder matches, and the tile already
  // knows how many that is. No request at all.
  return key !== '';
}

async function fetchFolderCounts() {
  const key = folderCounts.key;
  let counts = null;
  try {
    const data = await api('/api/folders/counts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: state.dir, filter: packFilter(state.adv) }),
    });
    counts = data.counts || {};
  } catch {
    // A folder that cannot be counted says so on its tile. Nothing else about
    // the listing depends on this, so a failure here is not worth a toast.
    counts = null;
  }
  // Another folder, or another filter, was asked for while this was in the air.
  if (folderCounts.key !== key) return;
  folderCounts.counts = counts;
  renderFolders();
}

/**
 * What a folder's tile and card say about how many videos are in it.
 *
 * Three numbers, always in the same order: how many match, how many there are,
 * and how many of those are on this machine. With no filter applied the first
 * two are the same number -- deliberately, so the shape of the line never
 * changes and the total is always the one on the right.
 */
function folderTally(folder) {
  const total = folder.videoCount;
  const downloaded = total - (folder.cloudCount || 0);
  if (!folderCounts.key) return { total, downloaded, matched: total, waiting: false };
  const counts = folderCounts.counts;
  if (!counts) return { total, downloaded, matched: null, waiting: true };
  const matched = counts[folder.path];
  return {
    total,
    downloaded,
    matched: typeof matched === 'number' ? matched : null,
    waiting: false,
  };
}

/** "3 / 91 (12 DL)" — matching, of everything in it, of which this many are here. */
function folderTallyText(folder) {
  const { total, downloaded, matched, waiting } = folderTally(folder);
  const left = matched === null ? (waiting ? '…' : '?') : matched.toLocaleString();
  return `${left} / ${total.toLocaleString()} (${downloaded.toLocaleString()} DL)`;
}

function renderFolders() {
  const section = $('#foldersSection');
  const wrap = $('#folders');
  // The tile it belongs to is about to stop existing, and pointerleave does not
  // fire for an element that was removed from under the cursor.
  hideFolderPop();
  wrap.innerHTML = '';

  // The filter box narrows folders by name too, not just videos. A folder has
  // no tags, so a `#tag` term can never match one — searching for a tag hides
  // the folder section rather than leaving an unfiltered row above the results.
  const terms = parseQuery($('#searchInput').value.trim().toLowerCase());
  const folders = terms.length
    ? state.folders.filter((f) => terms.every((t) => !t.field && f.name.toLowerCase().includes(t.value)))
    : state.folders;

  if (!folders.length) { section.hidden = true; return; }
  section.hidden = false;
  section.classList.toggle('collapsed', state.config.foldersCollapsed === true);
  // With no videos listed, folders get the full window rather than 38vh.
  section.classList.toggle('expanded', state.files.length === 0);
  // The grid is the thing that scrolls now -- three rows of it, then a bar --
  // so a new folder starts at its own top rather than wherever the last one
  // was left.
  section.scrollTop = 0;
  wrap.scrollTop = 0;
  $('#folderCount').textContent = folders.length === state.folders.length
    ? `(${state.folders.length})`
    : `(${folders.length} of ${state.folders.length})`;

  for (const folder of folders) {
    const tile = document.createElement('button');
    tile.className = 'folder-tile' + (folder.videoCount === 0 ? ' no-videos' : '');
    // No `title`: the hover card below says all of this and more, and a native
    // tooltip would fade in on top of it a second later.
    tile.addEventListener('click', () => navigateTo(folder.path));
    attachDropTarget(tile, folder.path, folder.name);

    const cover = document.createElement('div');
    cover.className = 'folder-cover';
    if (folder.cover) {
      cover.dataset.path = folder.cover;
      loadFolderCover(cover);
    } else {
      cover.textContent = '📁';
    }
    tile.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'folder-body';

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    body.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'folder-meta';
    if (folder.videoCount === 0) {
      meta.textContent = 'no videos';
    } else {
      // One shape whether or not anything is filtered and whether or not any of
      // it is downloaded, so the total is always the number on the right and
      // the line never has to be re-read. The size moved to the hover card:
      // "how big is this" is a question you ask of one folder, not of forty.
      meta.textContent = folderTallyText(folder);
      meta.classList.toggle('filtered', folderCounts.key !== '');
    }
    body.appendChild(meta);

    tile.appendChild(body);
    tile.addEventListener('pointerenter', () => showFolderPop(tile, folder));
    tile.addEventListener('pointerleave', hideFolderPop);
    wrap.appendChild(tile);
  }
}

/**
 * What the three sweeps have done to a folder, on hover.
 *
 * The same three facts the toolbar pills carry for the whole library, asked of
 * one folder -- because "how far along is this?" is a question you have while
 * looking at a folder, and the toolbar can only answer it for everything at
 * once. Same order and same dot colours as the pills, so the two read as one
 * thing seen at two scales.
 *
 * Cloud or downloaded does not change whether this appears, and it does not
 * change the denominator either. The sweeps decline to BUILD for a placeholder
 * -- framing one would download it, and so would the other two -- but all three
 * stores are keyed by size and mtime, and freeing a file to the cloud changes
 * neither. So a folder swept before it was freed reads as finished, which it
 * is: counting only the downloaded ones hid the most complete folders there
 * were.
 *
 * One shared card rather than one per tile: the tile clips its own overflow and
 * so does the scrolling strip they sit in, so this is positioned against the
 * window, and a library of two hundred folders builds one of these, not two
 * hundred.
 */
function showFolderPop(tile, folder) {
  const pop = $('#folderPop');
  if (!pop) return;
  const { total: allOfThem, downloaded, matched } = folderTally(folder);

  pop.replaceChildren();
  const line = (text, cls = 'folder-pop-head') => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    pop.appendChild(el);
    return el;
  };

  line(folder.name, 'folder-pop-title');
  if (folder.videoCount === 0) {
    line('No videos in here.', 'folder-pop-none');
  } else {
    const total = allOfThem;
    // The tile's line, spelled out: which of these numbers is which is obvious
    // here and has to be remembered there.
    if (folderCounts.key) {
      line(matched === null
        ? `counting ${total.toLocaleString()} against the filter…`
        : `${matched.toLocaleString()} of ${total.toLocaleString()} match the filter`,
      'folder-pop-match');
    }
    line(folder.cloudCount
      ? `${downloaded.toLocaleString()} downloaded · ${folder.cloudCount.toLocaleString()} cloud-only`
      : `${total.toLocaleString()} downloaded`);
    line(fmtBytes(folder.totalSize) + ' total');

    // Out of every video in the folder, cloud or not. A file freed up to the
    // cloud keeps everything already learned about it -- the three stores are
    // keyed by size and mtime, and neither changes when the bytes go -- so a
    // folder swept before it was freed reads as finished, which it is.
    let short = 0;
    for (const [kind, label, raw] of [
      ['framing', 'framed', folder.framed],
      ['prints', 'fingerprinted', folder.printed],
      ['faces', 'profiled', folder.profiled],
    ]) {
      // null means the store behind it had not finished loading when this was
      // scanned. Saying "none" would be a different and wrong answer.
      const waiting = raw === null || raw === undefined;
      const count = waiting ? 0 : Number(raw);
      if (!waiting && count < total) short = Math.max(short, total - count);

      const row = document.createElement('div');
      row.className = `folder-pop-row ${kind}`
        + (!waiting && count >= total ? ' done' : '')
        + (waiting ? ' waiting' : '');

      const dot = document.createElement('span');
      dot.className = 'faces-dot ' + kind;
      row.appendChild(dot);

      const what = document.createElement('span');
      what.className = 'folder-pop-what';
      what.textContent = label;
      row.appendChild(what);

      const num = document.createElement('span');
      num.className = 'folder-pop-num';
      num.textContent = waiting
        ? 'still loading…'
        : `${count.toLocaleString()} / ${total.toLocaleString()}`;
      row.appendChild(num);

      const bar = document.createElement('span');
      bar.className = 'folder-pop-bar';
      const fill = document.createElement('span');
      fill.style.width = waiting ? '0%' : `${Math.min(100, (count / total) * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);

      pop.appendChild(row);
    }

    // The one thing the bars cannot say: what is missing here cannot be swept
    // from here. A sweep will not download a placeholder to read it, so those
    // have to come back down before the gap can close.
    if (short > 0 && folder.cloudCount >= short) {
      line('What is missing is cloud-only — download it to sweep it.',
        'folder-pop-none');
    }
  }
  line(folder.path, 'folder-pop-path');
  line('Drop videos here to move them · hold Ctrl to copy', 'folder-pop-none');

  // Below the tile if it fits, above it if it does not, and never off either
  // side. Measured after filling: the height depends on what was just written.
  pop.hidden = false;
  const box = tile.getBoundingClientRect();
  const own = pop.getBoundingClientRect();
  const gap = 8;
  const below = box.bottom + gap;
  const top = below + own.height > window.innerHeight - 8
    ? Math.max(8, box.top - gap - own.height)
    : below;
  const left = Math.min(window.innerWidth - own.width - 8,
    Math.max(8, box.left + (box.width - own.width) / 2));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function hideFolderPop() {
  const pop = $('#folderPop');
  if (pop) pop.hidden = true;
}

// -------------------------------------------------------------- filter/sort

/**
 * Space-separated terms that must all match. A bare term matches the filename,
 * the subfolder, or any tag; prefixing it with `#` or `tag:` restricts it to
 * tags, which is what you want when a tag word also appears in filenames —
 * `#hd` finds what you tagged, `hd` finds everything named that way too.
 *
 * A tag with a space in it still works from bare terms, since each word only
 * has to match somewhere: "beach day" matches the tag "beach day".
 */
function parseQuery(query) {
  return query.split(/\s+/).filter(Boolean).map((raw) => {
    let field = null;
    let value = raw;
    if (raw.startsWith('#') || raw.startsWith('tag:')) {
      field = 'tags';
      value = raw.replace(/^(#|tag:)/, '');
    } else if (raw.startsWith('@') || raw.startsWith('model:')) {
      field = 'models';
      value = raw.replace(/^(@|model:)/, '');
    } else if (raw.startsWith('studio:')) {
      field = 'studio';
      value = raw.replace(/^studio:/, '');
    }
    return value ? { value, field } : null;
  }).filter(Boolean);
}

/** Whether anyone named in this video is marked a favourite. */
const isFavouriteModel = (name) => state.favSet.has(String(name || '').trim().toLowerCase());

/** Keeps the lower-cased lookup set in step with the list the server sent. */
function setFavourites(list) {
  state.favourites = Array.isArray(list) ? list : [];
  state.favSet = new Set(state.favourites.map((n) => String(n).toLowerCase()));
}

/**
 * Marks or unmarks one performer. The server owns the list, so its answer is
 * what the app then believes — two windows can be open on one library.
 */
async function toggleFavouriteModel(name) {
  const on = !isFavouriteModel(name);
  try {
    const data = await api('/api/favourites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, on }),
    });
    setFavourites(data.favourites);
  } catch (err) {
    toast(err.message, 'err');
    return isFavouriteModel(name);
  }
  return on;
}

function matchesQuery(file, terms) {
  const haystack = (file.name + ' ' + file.relFolder).toLowerCase();
  // The studio is one value rather than a list, so it is wrapped instead of
  // being iterated -- a string would otherwise be walked character by character.
  const values = (field) => {
    const held = file[field];
    return (Array.isArray(held) ? held : (held ? [held] : [])).map((t) => t.toLowerCase());
  };
  return terms.every((term) => {
    if (term.field) return values(term.field).some((t) => t.includes(term.value));
    // A bare term searches everything: name, subfolder, tags, models, studio.
    return haystack.includes(term.value)
      || values('tags').some((t) => t.includes(term.value))
      || values('models').some((t) => t.includes(term.value))
      || values('studio').some((t) => t.includes(term.value));
  });
}

/**
 * A search means the whole subtree, not the folder you happen to be standing in.
 *
 * Filtering could only ever see what had been scanned, and a scan is one level
 * deep -- so searching from a folder whose videos all live in subfolders found
 * nothing at all. That reads as "search is broken for cloud items", because a
 * cloud library is exactly the one that sits in subfolders rather than here.
 *
 * So the first search below an unflattened folder switches the scan to
 * recursive, the same move the advanced filter already makes when you pick a
 * folder. The Flatten box ticks itself, so the mode is visible rather than
 * silently different, and clearing the search leaves it on: switching back would
 * cost another scan to return you to where you could not find anything.
 */
let searchScan = null;

async function searchNow() {
  const query = $('#searchInput').value.trim();
  const missing = state.totalBelow - state.files.length;

  if (query && !$('#recursiveToggle').checked && missing > 0 && !searchScan) {
    $('#recursiveToggle').checked = true;
    setStatus(`Searching ${state.totalBelow.toLocaleString()} videos below…`);
    searchScan = scan(state.dir, { record: false }).finally(() => { searchScan = null; });
    await searchScan;
    toast(`Searching everything below ${baseName(state.dir) || state.dir}`, 'ok');
    return; // the scan renders
  }
  render();
}

function applyFilterSort() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const key = $('#sortSelect').value;
  const dir = state.config.sortDir === 'desc' ? -1 : 1;

  let list = state.files;
  const terms = parseQuery(query);
  if (terms.length) list = list.filter((f) => matchesQuery(f, terms));
  if (advActive()) list = list.filter((f) => matchesAdvanced(f, state.adv, filterCtx()));

  list = list.slice().sort((a, b) => {
    let cmp;
    if (key === 'name' || key === 'relFolder') {
      cmp = String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0 && key === 'relFolder') {
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true });
      }
    } else if (key === 'duration') {
      // Duration arrives from the lazy probe, not the scan.
      const av = Number((state.meta.get(a.path) || {}).duration) || 0;
      const bv = Number((state.meta.get(b.path) || {}).duration) || 0;
      cmp = av - bv;
    } else if (key === 'mtimeMs') {
      cmp = touchedAt(a) - touchedAt(b);
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else if (key === 'rating') {
      cmp = (Number(a.rating) || 0) - (Number(b.rating) || 0);
      // The name tiebreak is returned unflipped: within one rating band, names
      // should read A→Z whichever way the ratings are pointing. Multiplying it
      // by dir would put the unrated bulk in reverse alphabetical order.
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else if (LABEL_SORTS[key]) {
      // Sorting by a label sorts by its first value: a video has one studio but
      // any number of performers, and "her name comes first alphabetically" is
      // the only ordering a list of them has.
      //
      // Unlabelled goes last whichever way the arrow points, like the unrated
      // do — reversing brings the labelled tail to the top, which is the half
      // you asked to see, not a wall of blanks. Names break the ties unflipped,
      // for the same reason as the ratings.
      const av = LABEL_SORTS[key](a);
      const bv = LABEL_SORTS[key](b);
      if (!av && !bv) return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (!av) return 1;
      if (!bv) return -1;
      cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else {
      cmp = (Number(a[key]) || 0) - (Number(b[key]) || 0);
    }
    return cmp * dir;
  });

  state.view = list;
  buildSlots();
}

/**
 * What a rating is worth to a performer's standing — the Top performers weights,
 * client side. A five is worth ten fours and a four ten threes, so no pile of
 * watchable videos outranks one good one.
 *
 * Scored from the listing rather than from the whole library on purpose: this is
 * a view of what is in front of you, so filtering to one studio should reorder
 * the sections by who is best *in that studio*.
 */
const STAR_POINTS = [0, 0, 0, 10, 100, 1000];

/**
 * The current listing, split into one section per performer.
 *
 * A video with three performers belongs to three sections, so the same card is
 * built three times — that is the point of the view rather than a flaw in it:
 * you are looking at each video once per person in it. Videos with nobody named
 * are collected at the end instead of being dropped, or switching views would
 * quietly hide part of the listing.
 *
 * Favourites lead, then alphabetical. Ordering by how many videos each has would
 * move a section every time the filter changed.
 */
function buildModelGroups(list, mode = 'models') {
  const groups = new Map();
  const unnamed = [];
  const suggested = mode === 'suggested';

  for (const file of list) {
    // The credited names, or the ones the recogniser put forward. Same shape of
    // view over a different question: who is in this, against who might be.
    const names = (suggested
      ? (file.suggested || []).map((s) => s.name)
      : (file.models || [])).map((n) => String(n).trim()).filter(Boolean);
    if (!names.length) { unnamed.push(file); continue; }
    const rating = Math.max(0, Math.min(5, Math.round(Number(file.rating) || 0)));
    for (const name of names) {
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = { key, name, files: [], points: 0, good: 0 };
        groups.set(key, group);
      }
      group.files.push(file);
      group.points += STAR_POINTS[rating];
      if (rating >= 4) group.good += 1;
    }
  }

  const out = [...groups.values()].sort((a, b) => {
    const fa = isFavouriteModel(a.name) ? 0 : 1;
    const fb = isFavouriteModel(b.name) ? 0 : 1;
    // Marked first — that is what makes this a favourites view rather than a
    // leaderboard — then Top performers order among the rest. Ties go to whoever
    // has more well-rated videos, since ten fours and one five score alike, and
    // a name settles the rest so the order never wobbles between renders.
    return fa - fb
      || b.points - a.points
      || b.good - a.good
      || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  if (unnamed.length) {
    out.push({
      key: '',
      name: '',
      files: unnamed,
      unnamed: true,
      // Not the same absence: one is nobody credited, the other is nobody the
      // recogniser could put a name to -- including every video it has not read.
      label: suggested ? 'Nobody suggested' : 'Nobody named',
    });
  }
  return out;
}


/**
 * One section per set of copies, so a pair sits side by side.
 *
 * The whole point of the grouping: filtered to duplicates a pair can be forty
 * cards apart, sorted by whatever the sort happens to be, and comparing two
 * videos you cannot see at once is not comparing them.
 *
 * Ordered by how much a decision is worth -- the biggest file in the set, since
 * that is what deleting one recovers -- and the copies within a section by size
 * too, so the fullest is first and the runt beside it is the obvious candidate.
 */
/**
 * The copies that are not in the folder you are looking at.
 *
 * A set of copies is recorded across the whole library, but a listing is one
 * folder -- so grouping by duplicate would show half a pair and have to explain
 * itself. Fetching the rest is one request, answered from an index already in
 * memory on the server, and it is only made while this grouping is on.
 *
 * Held until the next scan or edit, because the same set is regrouped on every
 * render and re-fetching per keystroke would be absurd.
 */
let elsewhere = { at: 0, files: [] };

async function fetchOtherCopies() {
  try {
    const { files } = await api('/api/dupes/files');
    elsewhere = { at: Date.now(), files: files || [] };
  } catch {
    elsewhere = { at: Date.now(), files: [] };
  }
}

function forgetOtherCopies() {
  elsewhere = { at: 0, files: [] };
}

/**
 * This listing, plus any copy of anything in it that lives somewhere else.
 *
 * Matched on path so a video already on screen keeps the record the listing
 * gave it -- its rating and tags are the same either way, but the one from the
 * scan carries the folder it was found in.
 */
function withOtherCopies(list) {
  if (!elsewhere.files.length) return list;
  const here = new Set(list.map((f) => f.path));
  const groups = new Set(list.filter((f) => f.duplicate).map((f) => f.group));
  const extra = elsewhere.files.filter((f) => !here.has(f.path) && groups.has(f.group));
  return extra.length ? [...list, ...extra] : list;
}

function buildDupeGroups(list) {
  const groups = new Map();
  const alone = [];
  for (const file of list) {
    if (!file.duplicate || file.group === undefined) { alone.push(file); continue; }
    let group = groups.get(file.group);
    if (!group) {
      group = {
        key: `dupe-${file.group}`, name: '', files: [], bytes: 0, total: 0, both: false,
        // The heading is built for performers and has to be told this is not
        // one: no favourite heart, no points, no "her videos" link.
        dupe: true, points: 0,
      };
      groups.set(file.group, group);
    }
    group.files.push(file);
    group.bytes = Math.max(group.bytes, Number(file.size) || 0);
    // How big the set is across the whole library, which is not the same as how
    // much of it is in front of you.
    group.total = Math.max(group.total, Number(file.copies) || 0);
    if (file.dupeKinds && file.dupeKinds.both) group.both = true;
  }

  const out = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  for (const group of out) {
    group.files.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    const n = group.files.length;
    // The heading has to carry the finding, because the section IS the finding:
    // how many copies, and how sure the matcher was about them.
    // A set that has lost members until one is left is not a set: the server
    // dissolves it on deletion, so this only shows while a fetch is in flight.
    group.partial = group.total > n;
    group.name = `${n} cop${n === 1 ? 'y' : 'ies'}`;
    if (!group.both) group.name += ' \u2014 one signal only';
    group.label = group.name;
    // Everything but the largest: what keeping one of these would give back.
    // Nothing, when only one copy is here to choose between.
    group.recover = group.files.slice(1)
      .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  }
  if (alone.length) {
    out.push({
      key: '',
      name: '',
      files: alone,
      unnamed: true,
      label: 'No copy found',
    });
  }
  return out;
}

/**
 * The grouped layout as one flat list, so the grid keeps paging the way it does
 * flat: each entry is either a section heading or one card under it. Without
 * this, paging would have to understand sections, and a section of six hundred
 * videos would render in one go.
 */
function buildSlots() {
  state.groups = !state.grouped ? []
    : state.grouped === 'dupes' ? buildDupeGroups(withOtherCopies(state.view))
      : buildModelGroups(state.view, state.grouped);
  state.slots = [];
  state.cards = [];
  if (!state.grouped) return;
  for (const group of state.groups) {
    state.slots.push({ head: group });
    for (const [at, file] of group.files.entries()) {
      // `seq` is the card's place in reading order across the whole page, which
      // is what the player's arrows follow. It is not the same as `at`, the
      // position within this section, which is what a shift-range uses.
      const slot = { file, group, at, seq: state.cards.length };
      state.slots.push(slot);
      state.cards.push(slot);
    }
  }
}

/** The cards in the order they appear, which is state.view unless grouped. */
function visibleCards() {
  return state.grouped ? state.cards : state.view;
}

/** Where the open video sits in that order, or -1. */
function playingAt() {
  const list = visibleCards();
  if (!state.playing) return -1;
  // Grouped, the same video appears several times, so the copy it was opened
  // from is the one to walk from — falling back to the first if that card has
  // since gone.
  if (state.grouped) {
    const seq = state.playingCard;
    if (seq !== null && list[seq] && list[seq].file.path === state.playing.path) return seq;
    return list.findIndex((slot) => slot.file.path === state.playing.path);
  }
  return list.findIndex((f) => f.path === state.playing.path);
}

/** How many cards the current view holds — more than the videos, once grouped. */
function slotCards() {
  return state.grouped ? state.slots.length - state.groups.length : state.view.length;
}

/** What paging walks: sections and cards when grouped, plain videos when not. */
function pageSource() {
  return state.grouped ? state.slots : state.view;
}

// -------------------------------------------------------------------- sort

/**
 * When this video was last touched — the file itself, or what is known about it,
 * whichever came later.
 *
 * Tagging a video does not change the file, so a listing sorted by date left
 * the work you had just done wherever the file happened to sit. What the date is
 * being asked for is "what have I dealt with lately", and rating or naming
 * someone is dealing with it.
 */
function touchedAt(file) {
  return Math.max(Number(file.mtimeMs) || 0, Number(file.updated) || 0);
}

/** Which label a sort key reads, and what it reads out of it. */
const LABEL_SORTS = {
  studio: (f) => (f.studio || '').trim(),
  // One value per video, like the studio -- the series within the house, so
  // sorting by it groups a production's shoots together and the numbering
  // inside a group falls out of the numeric name tiebreak.
  production: (f) => (f.production || '').trim(),
  models: (f) => firstAlphabetically(f.models),
  tags: (f) => firstAlphabetically(f.tags),
};

/**
 * The name a list sorts under: the alphabetically first, taken by comparing
 * rather than by reading element zero. The library does store these sorted, so
 * the two agree today — but a record written by hand, or by an older version,
 * would otherwise sort under whatever happened to be typed first.
 */
function firstAlphabetically(values) {
  let best = '';
  for (const raw of values || []) {
    const value = String(raw).trim();
    if (!value) continue;
    if (!best || value.localeCompare(best, undefined, { sensitivity: 'base' }) < 0) best = value;
  }
  return best;
}

const SORT_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'mtimeMs', label: 'Date modified' },
  { value: 'size', label: 'File size' },
  { value: 'duration', label: 'Duration' },
  { value: 'rating', label: 'Rating' },
  { value: 'studio', label: 'Studio' },
  { value: 'production', label: 'Production' },
  { value: 'models', label: 'Model' },
  { value: 'tags', label: 'Tag' },
  { value: 'relFolder', label: 'Folder' },
];

/**
 * A dropdown rather than a select, so the toolbar keeps one icon instead of a
 * labelled control plus a direction button. Picking the field you are already
 * sorted by flips the direction — the same gesture as a spreadsheet column
 * header, and it saves a second control.
 */
function renderSortMenu() {
  const menu = $('#sortMenu');
  const current = $('#sortSelect').value;
  const descending = state.config.sortDir === 'desc';
  menu.innerHTML = '';

  for (const field of SORT_FIELDS) {
    const on = field.value === current;
    const row = document.createElement('button');
    row.className = 'menu-row' + (on ? ' on' : '');
    row.type = 'button';

    const label = document.createElement('span');
    label.textContent = field.label;
    row.appendChild(label);

    const arrow = document.createElement('span');
    arrow.className = 'menu-arrow';
    arrow.textContent = on ? (descending ? '↓' : '↑') : '';
    row.appendChild(arrow);

    row.title = on
      ? `Sorted by ${field.label} — click to reverse`
      : `Sort by ${field.label}`;
    row.addEventListener('click', () => {
      if (on) {
        const next = descending ? 'asc' : 'desc';
        saveConfig({ sortDir: next });
      } else {
        $('#sortSelect').value = field.value;
        saveConfig({ sort: field.value });
      }
      renderSortMenu();
      syncSortButton();
      render();
    });
    menu.appendChild(row);
  }
}

/** The icon carries the direction, so the current order is readable at a glance. */
function syncSortButton() {
  const field = SORT_FIELDS.find((f) => f.value === $('#sortSelect').value) || SORT_FIELDS[0];
  const descending = state.config.sortDir === 'desc';
  $('#sortBtn').title = `Sort: ${field.label}, ${descending ? 'descending' : 'ascending'}`;
  $('#sortBtn').classList.toggle('flip', descending);
}

function toggleSortMenu(open) {
  const menu = $('#sortMenu');
  const show = open === undefined ? menu.hidden : open;
  if (show) { toggleVolumeMenu(false); renderSortMenu(); }
  menu.hidden = !show;
  $('#sortBtn').classList.toggle('on', show);
}

// -------------------------------------------------------------------- volume

/**
 * Sound is opted into, once, for the run of the app.
 *
 * Only ever by hand: the toolbar switch, the volume slider, or unmuting the
 * video's own controls. Pressing play is not that -- it says which video you
 * want to watch, and taking it as consent to sound meant a session could go
 * loud without anyone having asked. Once on it stays on, for every video the
 * session opens after it.
 *
 * Deliberately not saved to the config file. Launching the app, or reloading
 * it, is quiet again: opening something loud by surprise is the thing the
 * preview was mute for in the first place.
 */
let soundOn = false;

/**
 * The session switch. Turning it off mid-session mutes what is playing too --
 * the icon would otherwise claim silence over an audible video. A preview is
 * left alone either way, since it is silent by its own rules.
 */
function setSoundOn(next) {
  soundOn = Boolean(next);
  const player = $('#player');
  if (player && watching()) {
    player.muted = !soundOn;
    if (soundOn) player.volume = masterVolume();
  }
  syncVolumeUI();
}

/**
 * One volume for the whole app, set from the toolbar and used by every video
 * that opens. The player's own slider writes back to it, so there is one number
 * rather than a toolbar setting and a per-video one drifting apart.
 */
function masterVolume() {
  const raw = Number(state.config.volume);
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
}

function setMasterVolume(value, { save = true } = {}) {
  const next = Math.max(0, Math.min(1, value));
  state.config.volume = next;
  if (save) saveVolumeSoon(next);
  const player = $('#player');
  // Never unmute the hover-style preview: it is silent by design, and the
  // volume is what playback will use once you press play.
  if (player && !player.muted) player.volume = next;
  syncVolumeUI();
}

// The slider fires per pixel of travel; the config file does not need that.
let volumeSaveTimer = null;
function saveVolumeSoon(value) {
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => saveConfig({ volume: value }), 250);
}

function syncVolumeUI() {
  const value = masterVolume();
  const percent = Math.round(value * 100);
  // The slider is the level sound will play at, which is worth knowing while
  // muted -- so it keeps showing the number even when nothing can be heard.
  $('#volRange').value = String(percent);
  $('#volBtn').classList.toggle('on', !$('#volMenu').hidden);

  // Two things, not one: the level, and whether this session has sound at all.
  // Reporting only the level is what made a silent app read "100%".
  const audible = soundOn && percent > 0;
  $('#volLabel').textContent = soundOn ? `${percent}%` : 'muted';
  $('#volBtn').title = audible ? `Volume: ${percent}%` : 'Muted — turn sound on here';
  $('#volMute').textContent = soundOn ? 'Mute this session' : 'Turn sound on';
  $('#volHint').textContent = soundOn
    ? 'Every video opens at this level.'
    : 'Videos play muted until you turn sound on. It lasts until you close the app.';

  // The icon says it without opening the menu: crossed out while muted, one wave
  // up to half, both above it. Toggled through style.display, since an SVG
  // element ignores the HTML hidden attribute -- which is why the first cut drew
  // the cross over the waves at every level.
  $('#volCross').style.display = audible ? 'none' : '';
  $('#volWaves').style.display = audible ? '' : 'none';
  $('#volWave2').style.display = audible && percent > 50 ? '' : 'none';
}

function toggleVolumeMenu(open) {
  const menu = $('#volMenu');
  const show = open === undefined ? menu.hidden : open;
  if (show) toggleSortMenu(false);
  menu.hidden = !show;
  syncVolumeUI();
}

// -------------------------------------------------------- advanced filters

// Edited in the dialog and only copied onto state.adv on Apply, so closing
// without applying changes nothing.
let advDraft = newAdvFilter();

function openAdvanced() {
  // Every Map copied, not listed by hand. The draft has to be editable without
  // touching the filter in force -- Cancel has to mean cancel -- and a list of
  // facets to clone is a list that goes stale the moment a new one is added.
  advDraft = { ...state.adv, mode: { ...state.adv.mode } };
  for (const [key, value] of Object.entries(state.adv)) {
    if (value instanceof Map) advDraft[key] = new Map(value);
  }
  for (const [field, name] of MODE_INPUTS) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.checked = radio.value === advDraft.mode[field];
    }
  }
  $('#advModal').hidden = false;
  renderAdvanced();
}

function renderAdvanced() {
  // Rating, 0 standing for unrated — a facet in its own right, since "never
  // been looked at" is a thing you want to list.
  const ratings = $('#advRating');
  ratings.innerHTML = '';
  for (const value of [0, 1, 2, 3, 4, 5]) {
    ratings.appendChild(chipCycle(
      value === 0 ? 'unrated' : '★'.repeat(value),
      advDraft.ratings.get(value),
      () => { cycleIn(advDraft.ratings, value); renderAdvanced(); },
    ));
  }

  // Every one of these cycles include -> exclude -> off, the same as the label
  // rows above it. They were one-of-N pickers with an "everything" chip, which
  // could not express "anything except not profiled" -- and that is a thing
  // worth being able to say. Empty means no constraint, so nothing is lost.
  for (const [host, facet, options] of CHOICE_ROWS) {
    const row = $(host);
    if (!row) continue;
    row.innerHTML = '';
    for (const [value, label, hint] of options) {
      const chip = chipCycle(label, advDraft[facet].get(value), () => {
        cycleIn(advDraft[facet], value);
        renderAdvanced();
      });
      if (hint) chip.title = `${chip.title}\n${hint}`;
      row.appendChild(chip);
    }
  }
  for (const [field, el, empty, none] of [
    ['studio', '#advStudio', 'No studios yet — the import writes them.', 'no studio'],
    ['production', '#advProduction', 'No production codes yet — the import writes them.',
      'no production'],
    ['models', '#advModels', 'No models yet — name someone from a card first.', 'no models'],
    ['tags', '#advTags', 'No tags yet — add some from a card first.', 'no tags'],
  ]) {
    const box = $(el);
    // Alphabetical, like the editor: a facet is picked by looking a word up.
    const vocab = vocabByName(field);
    box.innerHTML = '';

    // First, because "which of these have nothing" is a question about the whole
    // listing rather than one more value in it.
    const gap = chipCycle(none, advDraft[field].get(NOTHING), () => {
      cycleIn(advDraft[field], NOTHING);
      renderAdvanced();
    });
    gap.classList.add('chip-none');
    box.appendChild(gap);

    if (!vocab.length) box.insertAdjacentHTML('beforeend', `<span class="dim">${empty}</span>`);
    for (const entry of vocab) {
      box.appendChild(chipCycle(`${entry.tag} · ${entry.count}`, advDraft[field].get(entry.tag), () => {
        cycleIn(advDraft[field], entry.tag);
        renderAdvanced();
      }));
    }
  }

  updateAdvMatch();
}

/**
 * How many videos the draft would show, counted against the whole tree rather
 * than the current page — otherwise the number moves as you scroll.
 */
function updateAdvMatch() {
  const el = $('#advMatch');
  if (!advActive(advDraft)) { el.textContent = 'no filters — showing everything'; return; }
  // Included and excluded are counted apart, since "2 tags" would otherwise
  // read the same whether they were wanted or banned.
  const bits = [];
  const say = (facet, one, many = one + 's', extra = '') => {
    const inn = picked(advDraft[facet], 'in').length;
    const out = picked(advDraft[facet], 'out').length;
    if (inn) bits.push(`${inn} ${inn === 1 ? one : many}${extra}`);
    if (out) bits.push(`without ${out} ${out === 1 ? one : many}`);
    // The emptiness chip reads as a phrase, not a count.
    const nothing = advDraft[facet].get(NOTHING);
    if (nothing === 'in') bits.push(`no ${many} at all`);
    if (nothing === 'out') bits.push(`some ${many}`);
  };
  say('studio', 'studio', 'studios');
  say('production', 'production code', 'production codes');
  say('models', 'model', 'models', ` (${advDraft.mode.models})`);
  say('tags', 'tag', 'tags', ` (${advDraft.mode.tags})`);
  say('ratings', 'rating');
  // The one-question rows, read from the same table the chips are drawn from,
  // so a new answer shows up in the summary without being listed twice.
  for (const [, facet, options] of CHOICE_ROWS) {
    for (const [value, label] of options) {
      const mode = advDraft[facet].get(value);
      if (mode === 'in') bits.push(label);
      if (mode === 'out') bits.push(`not ${label}`);
    }
  }
  el.textContent = bits.join(' · ');
}

/**
 * Narrows the listing to whatever state.adv now says.
 *
 * A filter can only narrow what has been scanned, and a scan is one level deep,
 * so filtering below a folder whose videos live in subfolders finds little or
 * nothing. This used to tick Flatten on your behalf and rescan -- but a box
 * that ticks itself is a box you can no longer trust, and the listing then
 * covered a different scope than the one you were standing in. So the scope is
 * yours: the filter runs over what is scanned, and when that leaves nothing
 * while there are videos further down, it says so and names the box to tick.
 */
async function commitFilter() {
  render();

  const shown = state.view.length;
  if (!advActive()) { toast('Filters cleared', 'ok'); return; }

  const below = state.totalBelow - state.files.length;
  if (shown === 0 && below > 0) {
    toast(`No matches in this folder — ${below.toLocaleString()} more videos are `
      + 'in subfolders. Tick Flatten to include them.', 'warn');
    return;
  }
  toast(`${shown} match${shown === 1 ? '' : 'es'}`, 'ok');
}

/**
 * Clicking a pill is a filter, not a search.
 *
 * It used to type `@name` into the quick search box, which worked but left the
 * advanced dialog describing filters that were not the ones in force -- and the
 * two then stacked, so a pill clicked under an existing filter showed a
 * narrower listing than the pill promised. Now the pill IS the filter: exactly
 * that one value, in its own facet, and everything else cleared.
 */
async function filterByLabel(field, value) {
  const adv = newAdvFilter();
  adv[field].set(value, 'in');
  state.adv = adv;
  $('#searchInput').value = '';
  syncAdvBadge();
  await commitFilter();
}

function chipToggle(label, on, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip' + (on ? ' on' : '');
  chip.textContent = label;
  chip.addEventListener('click', onClick);
  return chip;
}

/**
 * Three states from one click target: include, exclude, off. A separate
 * "exclude" control would double the width of every row for a choice that is
 * only ever one of three.
 */
function chipCycle(label, mode, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip tri' + (mode ? ' ' + mode : '');
  chip.title = mode === 'in' ? 'Included — click to exclude'
    : mode === 'out' ? 'Excluded — click to clear'
      : 'Click to include, again to exclude';
  const mark = document.createElement('span');
  mark.className = 'tri-mark';
  mark.textContent = mode === 'in' ? '+' : mode === 'out' ? '−' : '';
  chip.appendChild(mark);
  chip.appendChild(document.createTextNode(label));
  chip.addEventListener('click', onClick);
  return chip;
}

function cycleIn(map, value) {
  const mode = map.get(value);
  if (!mode) map.set(value, 'in');
  else if (mode === 'in') map.set(value, 'out');
  else map.delete(value);
}

async function applyAdvanced() {
  for (const [field, name] of MODE_INPUTS) {
    const picked = document.querySelector(`input[name="${name}"]:checked`);
    advDraft.mode[field] = picked ? picked.value : 'all';
  }

  state.adv = advDraft;
  $('#advModal').hidden = true;
  syncAdvBadge();
  await commitFilter();
}

/**
 * Clears every facet and means it. Both footer buttons commit — having to press
 * Reset and then Apply to say "show me everything" was one click too many, and
 * the dialog closing is what makes the emptied listing visible.
 *
 * The quick search box is left alone: it is not one of these filters, and this
 * button belongs to this dialog.
 */
async function resetAdvanced() {
  advDraft = newAdvFilter();
  renderAdvanced();

  state.adv = advDraft;
  $('#advModal').hidden = true;
  syncAdvBadge();
  await commitFilter();
}

function syncAdvBadge() {
  $('#advDot').hidden = !advActive();
  $('#advBtn').classList.toggle('on', advActive());
}

// --------------------------------------------------------- ratings and tags

/**
 * Ratings and tags live in a sidecar the server keys by size + modified time,
 * so an edit costs a few hundred bytes and works identically for a cloud file
 * that has never been downloaded. Nothing here touches the video itself —
 * that only happens via "Write into files", which is deliberate.
 */
async function editRecords(paths, patch) {
  if (!paths.length) return;
  try {
    const data = await api('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, ...patch }),
    });
    state.tagVocab = data.tags || state.tagVocab;
    state.modelVocab = data.models || state.modelVocab;
    state.studioVocab = data.studios || state.studioVocab;
    state.productionVocab = data.productions || state.productionVocab;
    for (const [filePath, record] of Object.entries(data.records || {})) {
      if (record.error) { toast(record.error, 'err'); continue; }
      // The open video first, and before the listing lookup: it is watchable
      // from outside the current listing -- an anchor, a sibling walked past a
      // filter -- and its timeline must redraw either way.
      if (state.playing && state.playing.path === filePath) {
        if (record.marks !== undefined) state.playing.marks = record.marks;
        drawMarks();
      }
      const file = state.files.find((f) => f.path === filePath);
      if (!file) continue;
      file.rating = record.rating;
      file.tags = record.tags;
      file.models = record.models;
      // Names turned down on this video. Without copying it the refusal would
      // be stored and invisible: the strip reads this to list what it is not
      // suggesting, and to offer each one back.
      if (record.notModels !== undefined) file.notModels = record.notModels;
      // And the ranking, when the reply carried a new one -- refusing a name
      // changes what this video suggests, and the chip would otherwise stay.
      if (record.suggested !== undefined) file.suggested = record.suggested;
      if (record.people !== undefined) file.people = record.people;
      file.studio = record.studio;
      file.production = record.production;
      file.url = record.url;
      // Bookmarked moments. Copied back so the timeline redraws from the store
      // rather than from what the click optimistically assumed.
      if (record.marks !== undefined) file.marks = record.marks;
      file.updated = record.updated || 0;
      refreshCardRecord(file);
    }
    pruneFiltered(Object.keys(data.records || {}));
    syncTagVocab();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/**
 * An edit can take a video out of the filter that found it: rate something 3
 * while listing four stars only, and it no longer belongs on screen. The card
 * leaves rather than sitting there contradicting the filter.
 *
 * Only the edited files are re-tested and only removal is acted on — a full
 * re-render would rebuild every thumbnail and lose the scroll position, and
 * re-sorting would make cards jump under the cursor mid-edit.
 */
function pruneFiltered(paths) {
  const terms = parseQuery($('#searchInput').value.trim().toLowerCase());
  if (!paths.length || (!terms.length && !advActive())) return;

  const gone = new Set();
  for (const path of paths) {
    const file = state.files.find((f) => f.path === path);
    if (!file) continue;
    const keep = matchesQuery(file, terms) && (!advActive() || matchesAdvanced(file, state.adv, filterCtx()));
    if (!keep) gone.add(path);
  }
  if (!gone.size) return;

  // Remember where the open video sat before it goes, so the player's arrows
  // still know which way is next.
  if (state.playing && gone.has(state.playing.path)) {
    const at = playingAt();
    state.playingAnchor = at >= 0 ? at : null;
  }

  state.view = state.view.filter((f) => !gone.has(f.path));
  for (const path of gone) {
    state.selected.delete(path);
    // Grouped, one video holds a card per performer in it, so every copy goes.
    for (const card of cardsFor(path)) {
      card.remove();
      state.rendered = Math.max(0, state.rendered - 1); // one fewer slot on screen
    }
  }

  // The sections are derived from the view, so the counts in their headings and
  // the slots paging walks are both stale now. Rebuilt in place, keeping roughly
  // as much loaded as before so the scroll position survives.
  if (state.grouped) {
    const loaded = state.rendered;
    buildSlots();
    $('#grid').innerHTML = '';
    state.rendered = 0;
    while (state.rendered < Math.min(loaded, state.slots.length)) appendPage();
    // The rebuild renumbered every card, so the remembered one is stale.
    state.playingCard = state.playing
      ? state.cards.findIndex((slot) => slot.file.path === state.playing.path)
      : null;
    if (state.playingCard < 0) state.playingCard = null;
  }

  syncFileCount();
  updateSelectionBar();
  updateStatusLine();
  syncPlayerNav();
  renderEmptyState();

  // The open video failing the filter means you have just finished with it —
  // rating it while listing the unrated, tagging it while listing the untagged.
  // Moving on is what you were about to do anyway, so the player follows the
  // listing instead of sitting on something no longer in it. The slot it
  // vacated is the one to take, which is where the next video slid to.
  let moved = false;
  if (state.playing && gone.has(state.playing.path) && !$('#playerModal').hidden) {
    if (!state.view.length) closePlayer();
    else {
      const at = state.playingAnchor === null ? 0 : state.playingAnchor;
      const walk = visibleCards();
      const seq = Math.max(0, Math.min(at, walk.length - 1));
      const next = walk[seq];
      if (next) playFile(state.grouped ? next.file : next, state.grouped ? seq : null);
      moved = true;
    }
  }

  const many = gone.size === 1 ? 'es' : '';
  toast(`${gone.size} no longer match${many} the filter`
    + (moved ? ' — on to the next' : ''), 'ok');
}

/** Every card for one path. Grouped, a video appears once per performer in it. */
function cardsFor(filePath) {
  return document.querySelectorAll(`.card[data-path="${CSS.escape(filePath)}"]`);
}

/** Repaints just the stars and chips, so an edit never disturbs a playing hover. */
function refreshCardRecord(file) {
  for (const card of cardsFor(file.path)) {
    const row = card.querySelector('.record-row');
    if (row) row.replaceWith(buildRecordRow(file));
    // The source link lives on the folder line, so a url arriving by edit has
    // nowhere to appear unless that line is rebuilt too.
    const line = card.querySelector('.folder-line');
    if (line) line.replaceWith(buildFolderLine(file));
  }
  // The player shows the same row, so an edit made in either place has to land
  // in both — otherwise the footer keeps showing the rating you just changed.
  if (state.playing && state.playing.path === file.path) {
    buildPlayerRecord(file);
    // A name added from the strip turns that chip into a tick.
    buildPlayerSuggestions(file);
  }
}

/** The card's rating and label row, repeated in the player footer. */
function buildPlayerRecord(file) {
  const holder = $('#playerRecord');
  if (!holder) return;
  // Prefer the live entry: editing elsewhere mutates that, not the snapshot the
  // player was opened with.
  const current = state.files.find((f) => f.path === file.path) || file;
  holder.replaceChildren(buildRecordRow(current));
}

// ------------------------------------------------------------ familiar faces

/**
 * Who the faces in a video look like.
 *
 * The server ranks each video against the average face of every performer named
 * in at least a few others, and sends the winners with the listing. Nothing here
 * writes a label on its own: a suggestion is a button, and pressing it is the
 * decision.
 */
const BAND_LABEL = {
  strong: 'strong match',
  likely: 'likely',
  maybe: 'possible',
  near: 'below the bar',
};

/**
 * Drops the names already credited on the video.
 *
 * A suggestion is a recommendation, and recommending somebody already on the
 * video is not one -- it was a tile that could not be clicked, taking up a
 * place in a row where every other tile was a decision waiting to be made.
 *
 * Only the display is thinned. `file.suggested` still holds every name the
 * recogniser offered, which is what the "a suggested name is credited" filter
 * and the grouped-by-suggested listing are counting.
 */
function uncredited(file, list) {
  const named = new Set((file.models || []).map((m) => m.toLowerCase()));
  return (list || []).filter((s) => !named.has(String(s.name).toLowerCase()));
}

/** One suggestion: the face it came from, the name, and how sure it is. */
function buildFaceChip(file, sug, { onPick, showFace = true } = {}) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `face-chip band-${sug.band}`;
  const already = (file.models || []).some((m) => m.toLowerCase() === sug.name.toLowerCase());
  if (already) chip.classList.add('confirmed');

  if (showFace) {
    // Part of the chip rather than a button inside it. Comparing used to cost a
    // click on a 22px circle; it now costs nothing, so the chip has one action
    // and the face is decoration that happens to also be the evidence.
    const look = document.createElement('span');
    look.className = 'face-look';
    const img = document.createElement('img');
    img.className = 'face-thumb';
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/faces/face?path=${encodeURIComponent(file.path)}&person=${sug.person || 0}`;
    // No stored crop is not an error worth showing; the name still stands.
    img.addEventListener('error', () => look.remove());
    look.appendChild(img);
    chip.appendChild(look);
  }

  const name = document.createElement('span');
  name.className = 'face-name';
  name.textContent = sug.name;
  chip.appendChild(name);

  // The number, because "who" without "how sure" is not something you can act
  // on. It is the similarity to that performer's average face, not a
  // probability, and the tooltip says so.
  const pct = document.createElement('span');
  pct.className = 'face-pct';
  pct.textContent = `${Math.round(sug.score * 100)}%`;
  chip.appendChild(pct);

  const mark = document.createElement('span');
  mark.className = 'face-band';
  mark.textContent = already ? '\u2713' : '+';
  chip.appendChild(mark);

  chip.title = [
    `${Math.round(sug.score * 100)}% like ${sug.name}'s average face, `
      + `across the ${sug.videos} videos she is named in`,
    'Hover to compare her other faces',
    `${Math.round(sug.margin * 100)} points clear of the next name (${sug.runnerUp}) `
      + `\u2014 ${BAND_LABEL[sug.band]}`,
    already ? 'Already credited on this video' : 'Click to add her',
  ].filter(Boolean).join('\n');
  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (!already) onPick(sug.name);
  });
  attachFaceHover(chip, file, sug);
  return chip;
}

/**
 * Her other faces, on hover, for every suggestion there is.
 *
 * A name beside a 22px thumbnail asks to be taken on trust, and asking for the
 * comparison used to mean finding and clicking that thumbnail. Reversing it is
 * the point: the card comes up on its own, for one suggestion or four, and at
 * 90% as readily as at 38% — a confident wrong answer is exactly the one worth
 * looking at. Clicking now only ever credits her.
 */
const HOVER_IN_MS = 170;
const HOVER_OUT_MS = 160;
const HOVER_CROPS = 6;
const HOVER_STALE_MS = 60000;

// One request per performer rather than per chip: the same name appears on
// video after video and her faces do not change between two of them. Short-
// lived, because the sweep is writing new profiles the whole time.
const herFaces = new Map();

function herLineup(name) {
  const held = herFaces.get(name);
  if (held && Date.now() - held.at < HOVER_STALE_MS) return held.p;
  const p = api(`/api/faces/lineup?model=${encodeURIComponent(name)}&limit=12`)
    .catch(() => { herFaces.delete(name); return null; });
  herFaces.set(name, { at: Date.now(), p });
  return p;
}

const hover = { in: 0, out: 0, token: null, held: null };

function attachFaceHover(chip, file, sug) {
  chip.addEventListener('mouseenter', () => {
    clearTimeout(hover.out);
    clearTimeout(hover.in);
    // A pause before showing, or brushing along the strip on the way to
    // something else flashes four cards and fires four requests.
    hover.in = setTimeout(() => openFaceHover(chip, file, sug), HOVER_IN_MS);
  });
  chip.addEventListener('mouseleave', () => {
    clearTimeout(hover.in);
    hover.out = setTimeout(closeFaceHover, HOVER_OUT_MS);
  });
  // Keyboard gets it at once: tabbing onto a chip is already deliberate.
  chip.addEventListener('focus', () => {
    clearTimeout(hover.out);
    openFaceHover(chip, file, sug);
  });
  chip.addEventListener('blur', () => { hover.out = setTimeout(closeFaceHover, HOVER_OUT_MS); });
}

async function openFaceHover(anchor, file, sug) {
  const card = $('#faceHover');
  if (!card) return;
  // Anything already in flight is for a chip the pointer has since left.
  const token = {};
  hover.token = token;
  hover.held = { file, sug };

  $('#faceHoverThis').src =
    `/api/faces/face?path=${encodeURIComponent(file.path)}&person=${sug.person || 0}`;
  $('#faceHoverLabel').textContent = `${sug.name} · loading her faces…`;
  $('#faceHoverGrid').replaceChildren();

  const pct = Math.round(sug.score * 100);
  const gap = Math.round(sug.margin * 100);
  const verdict = $('#faceHoverVerdict');
  verdict.textContent = sug.band === 'near'
    ? `${pct}% alike — below the bar to suggest, so judge it yourself`
    : `${pct}% alike, ${gap} clear of ${sug.runnerUp} — ${BAND_LABEL[sug.band]}`;
  verdict.className = `face-hover-verdict band-${sug.band}`;
  $('#faceHoverMore').textContent = `See all of ${sug.name}'s faces`;
  const no = $('#faceHoverNo');
  const credited = (file.models || []).some((m) => m.toLowerCase() === sug.name.toLowerCase());
  no.textContent = `Not ${sug.name}`;
  no.title = credited
    ? `${sug.name} is credited on this video. This says she is not in it: the `
      + 'credit is removed and she stops being suggested here'
    : `Stop suggesting ${sug.name} for this video. Remembered with the labels, `
      + 'so re-reading the file will not bring her back';

  card.hidden = false;
  placeFaceHover(anchor);

  const data = await herLineup(sug.name);
  if (hover.token !== token) return;
  if (!data) { $('#faceHoverLabel').textContent = `Could not read ${sug.name}'s faces`; return; }

  // This video is the question, not part of the answer.
  const others = (data.faces || []).filter((f) => f.key !== keyOf(file)).slice(0, HOVER_CROPS);
  $('#faceHoverLabel').textContent = others.length
    ? `${sug.name} · ${others.length} of her ${data.total} read`
    : `No stored faces for ${sug.name} yet`;

  const grid = $('#faceHoverGrid');
  grid.replaceChildren();
  for (const other of others) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    // Dimmed rather than dropped, for the reason the big lineup marks them: it
    // counts towards her average whether or not it flatters the picture.
    if (other.agrees !== null && other.agrees < 0.3) img.className = 'face-odd-thumb';
    img.src = `/api/faces/crop?key=${encodeURIComponent(other.key)}&person=0`;
    img.addEventListener('error', () => img.remove());
    grid.appendChild(img);
  }
  // The grid was empty when this was first placed, so it is a different height
  // now and 'above the chip' means somewhere else.
  placeFaceHover(anchor);
}

/**
 * Against the chip, above it where there is room.
 *
 * The suggestion strip sits low in the player, so above is usually right and
 * below is the fallback rather than the default.
 */
function placeFaceHover(anchor) {
  const card = $('#faceHover');
  const at = anchor.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(
    at.left + (at.width / 2) - (box.width / 2),
    window.innerWidth - box.width - pad,
  ));
  const above = at.top - box.height - 8;
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(above < pad ? at.bottom + 8 : above)}px`;
}

/**
 * Turning a suggestion down, and putting it back.
 *
 * Stored with the labels rather than with the index, because that is what it
 * is: your answer, not a measurement. The index is discarded and rebuilt
 * whenever the recogniser or the sampling changes, and a rejection has to
 * outlive that -- otherwise the same wrong name returns every few weeks and
 * refusing it becomes a chore rather than a decision.
 */
async function refuseSuggestion(file, name) {
  // She can be credited AND the closest face -- a suggestion on a credited
  // video is a confirmation, and "not her" contradicts it. Leaving both would
  // be an incoherent record: named in the video and refused for it. So the
  // credit goes with the refusal, since that is what the words mean.
  const credited = (file.models || []).some((m) => m.toLowerCase() === name.toLowerCase());
  await editRecords([file.path], credited
    ? { addNotModels: [name], removeModels: [name] }
    : { addNotModels: [name] });
  toast(credited
    ? `${name} uncredited, and will not be suggested for this video`
    : `${name} will not be suggested for this video`, 'ok');
  if (state.playing) buildPlayerSuggestions(state.playing);
}

async function unrefuseSuggestion(file, name) {
  await editRecords([file.path], { removeNotModels: [name] });
  toast(`${name} can be suggested again`, 'ok');
  if (state.playing) buildPlayerSuggestions(state.playing);
}

/**
 * The names this video has turned down, after the ones it is offered.
 *
 * Shown because a rejection is otherwise invisible: a suggestion that stops
 * appearing looks exactly like a recogniser with nothing to say, and there
 * would be no way back from one made by mistake. Clicking a name restores it.
 */
function appendRefused(host, file, refused) {
  if (!refused.length) return;
  const row = document.createElement('span');
  row.className = 'face-refused';
  const lead = document.createElement('span');
  lead.textContent = 'not';
  row.appendChild(lead);
  for (const name of refused) {
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = name;
    back.title = `Turned down here \u2014 click to let ${name} be suggested again`;
    back.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      unrefuseSuggestion(file, name);
    });
    row.appendChild(back);
  }
  host.appendChild(row);
}

function closeFaceHover() {
  clearTimeout(hover.in);
  hover.token = null;
  const card = $('#faceHover');
  if (card) card.hidden = true;
}


/**
 * Nothing under half is offered in the recognise row.
 *
 * The recogniser's own bands reach down to 0.38, and they stay there -- they
 * decide what counts as a suggestion at all, which the filters and the
 * grouping are both built on. This is a separate question: what is worth
 * putting a picture on and inviting a click. The row of related videos draws
 * its line at the same place, so the two rows agree.
 */
const FACE_FLOOR = 0.50;

/**
 * A suggested performer, as a tile.
 *
 * The same shape as a tile in the row below, because it answers the same
 * question. The picture is her video that most resembles this one, so the row
 * reads as "here is who, and here is what that looks like" rather than as a
 * list of names to be taken on trust.
 *
 * Three pictures are tried in turn: her most-like-this video's poster; that
 * video's stored face crop; and failing both, the face in THIS video that she
 * was matched against, which always exists because it is what made the
 * suggestion.
 */
function buildFaceTile(file, sug, { onPick, best }) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = `similar-tile face-tile band-${sug.band || 'near'}`;

  const shot = document.createElement('span');
  shot.className = 'similar-shot preview';
  tile.appendChild(shot);
  const ownFace = () => {
    shot.classList.add('face-only');
    shot.style.backgroundImage = `url("/api/faces/face?path=${encodeURIComponent(file.path)}`
      + `&person=${sug.person || 0}")`;
  };
  if (best && best.path) {
    loadThumb(best.path, shot).then((got) => {
      if (got) return;
      // Her video had no poster to be had; her face from it is the next best
      // picture, and this video's face is the one after that.
      const probe = new Image();
      const at = `/api/faces/crop?key=${encodeURIComponent(best.key)}`
        + `&person=${Number(best.person) || 0}`;
      probe.onload = () => {
        shot.classList.add('face-only');
        shot.style.backgroundImage = `url("${at}")`;
      };
      probe.onerror = ownFace;
      probe.src = at;
    });
  } else {
    ownFace();
  }

  const pct = document.createElement('span');
  pct.className = 'similar-pct';
  pct.textContent = `${Math.round(sug.score * 100)}%`;
  shot.appendChild(pct);

  // On the picture, where the row can be read at a glance. Always a plus:
  // every tile here is a name not yet on the video, because uncredited() took
  // the rest out before the row was built.
  const mark = document.createElement('span');
  mark.className = 'similar-mark';
  mark.textContent = '+';
  shot.appendChild(mark);

  const name = document.createElement('span');
  name.className = 'similar-name';
  name.textContent = sug.name;
  tile.appendChild(name);

  tile.title = [
    sug.videos
      ? `${Math.round(sug.score * 100)}% like ${sug.name}'s average face, `
        + `across the ${sug.videos} videos she is named in`
      : `${Math.round(sug.score * 100)}% like ${sug.name} \u2014 below the bar, `
        + 'so not suggested',
    sug.margin
      ? `${Math.round(sug.margin * 100)} points clear of the next name`
        + (sug.runnerUp ? ` (${sug.runnerUp})` : '')
        + (sug.band ? ` \u2014 ${BAND_LABEL[sug.band]}` : '')
      : null,
    best && best.path ? `Pictured: ${best.name}, her video most like this one` : null,
    'Hover to compare the faces',
    'Click to add her',
  ].filter(Boolean).join('\n');

  tile.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    onPick(sug.name);
  });
  attachFaceHover(tile, file, sug);
  return tile;
}

/**
 * The pictures for a set of names, in one request.
 *
 * Asked for all of them at once rather than per tile: it is one pass over the
 * vectors either way, and a row of four would otherwise do that pass four
 * times.
 */
async function picturesFor(file, names) {
  if (!names.length) return {};
  try {
    const got = await api(`/api/faces/best?path=${encodeURIComponent(file.path)}`
      + `&models=${encodeURIComponent(names.join('\n'))}`);
    return got.best || {};
  } catch {
    return {};
  }
}

/**
 * The suggestion strip under the player.
 *
 * Only names that are not on the video yet. The recogniser still ranks a
 * credited performer and still agrees with the label -- that agreement is just
 * not a recommendation, and a tile you cannot click was taking a place in a row
 * where every other one is a decision waiting to be made.
 *
 * A row of thumbnails, like the one below it. No heading: every tile is a name
 * to add, and how many there are is the row's length. A video whose faces are
 * all credited falls through to the near-misses below the bar, if there are
 * any, which is the next useful thing it could say.
 */
async function buildPlayerSuggestions(file) {
  const host = $('#playerSuggest');
  if (!host) return;
  const current = state.files.find((f) => f.path === file.path) || file;
  const suggested = uncredited(
    current, (current.suggested || []).filter((s) => s.score >= FACE_FLOOR));
  // These chips are about to be replaced, and a card left open would be
  // anchored to one that no longer exists.
  closeFaceHover();
  host.replaceChildren();
  host.hidden = false;

  // Nothing to show is three different situations -- not read yet, read and no
  // face found, read and nobody matched -- and showing nothing for all of them
  // reads as the feature being broken. The answer is fetched per video because
  // it costs a ranking; the strip says so while it is coming.
  // Turned down here. Listed in both states, because a video whose only
  // suggestion was refused now looks like one the recogniser could not read.
  const refused = current.notModels || [];

  if (!suggested.length) {
    if (!current.profiled) { appendRefused(host, current, refused); return; }
    await explainNothing(host, current);
    appendRefused(host, current, refused);
    return;
  }

  const pictures = await picturesFor(current, suggested.map((s) => s.name));
  // The player moves on faster than a fetch returns when the arrow key is held
  // down, and somebody else's suggestions under this video would be a lie.
  if (!state.playing || state.playing.path !== file.path) return;
  host.replaceChildren();

  const row = document.createElement('div');
  row.className = 'similar-row';
  host.appendChild(row);
  for (const sug of suggested) {
    row.appendChild(buildFaceTile(current, sug, {
      best: pictures[sug.name],
      onPick: async (name) => {
        await editRecords([current.path], { addModels: [name] });
        // Accepting a name can take the video out of the filter that found it,
        // and the player then moves to the next one. Redrawing the strip for
        // the video that was open would put its tiles over somebody else's --
        // so whatever is playing NOW is what the strip is rebuilt for.
        if (state.playing) buildPlayerSuggestions(state.playing);
        else host.replaceChildren();
      },
    }));
  }
  appendRefused(host, current, refused);
}


/**
 * Where else this face is.
 *
 * The suggestion strip above puts names to the faces in this video. This puts
 * videos to them -- and it does so without using a name at all: the match is
 * one video's face vector against another's, so it finds her in videos nobody
 * has credited, in videos credited to a second spelling of her name, and for
 * performers with too few videos for an average to exist.
 *
 * Nothing is computed from the file. Every vector was written when the video
 * was profiled for the recogniser; this is that index asked a different
 * question, and the answer takes about three milliseconds.
 */
const PAGE = 12;

/**
 * What the row is currently showing, so scrolling can extend it.
 *
 * Keyed by the video it belongs to as well as by a token: the token catches a
 * fetch that lands after the player has moved on, and the path catches a
 * scroll event arriving for a row that has since been replaced.
 */
const similar = { token: 0, path: '', shown: 0, total: 0, loading: false };

async function buildPlayerSimilar(file) {
  const host = $('#playerSimilar');
  if (!host) return;
  const mine = ++similar.token;
  similar.path = file.path;
  similar.shown = 0;
  similar.total = 0;
  similar.loading = true;
  host.replaceChildren();
  host.hidden = false;
  host.scrollLeft = 0;
  const waiting = say(host, 'face-note', 'looking\u2026');

  let found;
  try {
    found = await api(`/api/faces/similar?path=${encodeURIComponent(file.path)}`
      + `&limit=${PAGE}`);
  } catch {
    similar.loading = false;
    if (mine === similar.token) waiting.textContent = 'could not look';
    return;
  }
  similar.loading = false;
  // The player moves on faster than a fetch returns when you hold the arrow
  // key down, and a row of somebody else's videos under this one is worse than
  // no row at all.
  if (mine !== similar.token || !state.playing || state.playing.path !== file.path) return;

  host.replaceChildren();
  if (!found.profiled) { host.hidden = true; return; }
  if (!found.videos.length) {
    // Four different silences, and only one of them is a fact about the
    // library. Saying which is the difference between a feature that has
    // nothing to show and a feature that looks broken -- and with the bar set
    // where it is, about half of all videos take this path.
    const note = say(host, 'face-note', !found.people
      ? 'no usable face to go on'
      : !found.located
        ? 'still finding where the library is \u2014 open a folder, or give the '
          + 'sweep a minute'
        : found.unreachable
          ? `${found.unreachable} match${found.unreachable === 1 ? '' : 'es'} found, `
            + 'still working out where they live'
          : found.closest
            ? `no other video is clearly her \u2014 closest is `
              + `${Math.round(found.closest * 100)}%`
            : 'her face is in no other video that has been read');
    if (found.closest && found.people && found.located) {
      note.title = 'Only videos at 50% and above are shown, strongest first. '
        + 'Below that the match is little better than a coincidence.';
    }
    return;
  }

  similar.total = found.total;
  const row = document.createElement('div');
  row.className = 'similar-row';
  host.appendChild(row);
  addSimilarTiles(row, found.videos);
}

function addSimilarTiles(row, videos) {
  for (const other of videos) row.appendChild(buildSimilarTile(other));
  similar.shown += videos.length;
}

/**
 * The next twelve, once you have scrolled to the end of the last twelve.
 *
 * Bound once, at startup, to the container rather than to each row -- the
 * player is opened hundreds of times in a session and a listener per opening
 * is a leak per opening.
 */
async function extendSimilar() {
  const host = $('#playerSimilar');
  const row = host && host.querySelector('.similar-row');
  if (!row || similar.loading || similar.shown >= similar.total) return;
  if (!state.playing || state.playing.path !== similar.path) return;
  // Within a tile's width of the end, so the next page is arriving as the last
  // one comes into view rather than after you have hit the wall.
  if (host.scrollLeft + host.clientWidth < host.scrollWidth - 140) return;

  const mine = similar.token;
  const from = similar.shown;
  similar.loading = true;
  let more;
  try {
    more = await api(`/api/faces/similar?path=${encodeURIComponent(similar.path)}`
      + `&limit=${PAGE}&offset=${from}`);
  } catch {
    similar.loading = false;
    return;
  }
  similar.loading = false;
  // Deleting a copy, or a sweep finishing, can shorten the ranking under us --
  // so the page that comes back is trusted about where it starts, not the
  // count we asked from.
  if (mine !== similar.token || more.offset !== from) return;
  similar.total = more.total;
  addSimilarTiles(row, more.videos);
}

function watchSimilarScroll() {
  const host = $('#playerSimilar');
  if (!host) return;
  host.addEventListener('scroll', () => { extendSimilar(); }, { passive: true });
}

/**
 * When no poster can be had, the face itself.
 *
 * A 112px crop was saved for every profiled video, so there is a picture even
 * for a file in the cloud that has no thumbnail anywhere. It is also the very
 * face this match was made on, which for this row is arguably the more honest
 * illustration.
 */
function showTheFace(shot, other) {
  if (!other.key) { shot.classList.add('cloud'); return; }
  const at = `/api/faces/crop?key=${encodeURIComponent(other.key)}`
    + `&person=${Number(other.person) || 0}`;
  // Loaded before it is applied: a background that 404s leaves an empty box
  // with no way to know it happened, where the cloud mark at least says why.
  const probe = new Image();
  probe.onload = () => {
    shot.classList.add('face-only');
    shot.style.backgroundImage = `url("${at}")`;
  };
  probe.onerror = () => shot.classList.add('cloud');
  probe.src = at;
}

/**
 * One video in the row.
 *
 * The percentage is on the picture rather than beside it: it is the reason the
 * tile is there, and reading a row of them is how you tell a certain match from
 * a hopeful one at a glance.
 */
function buildSimilarTile(other) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = `similar-tile band-${other.band || 'maybe'}`;
  const credited = (other.models || []).join(', ');
  tile.title = [
    other.name,
    `${Math.round(other.score * 100)}% like a face in this video`,
    credited ? `credited: ${credited}` : 'nobody credited on it',
    other.rating ? `${'\u2605'.repeat(other.rating)}` : null,
    other.folder,
  ].filter(Boolean).join('\n');

  const shot = document.createElement('span');
  shot.className = 'similar-shot preview';
  tile.appendChild(shot);
  // Asked for even when the file is in the cloud. The route never builds a
  // poster from a cloud file -- that would download it -- but it will serve one
  // built while the file was here, and failing that ask OneDrive for the
  // thumbnail it already holds, which is sixteen kilobytes and hydrates
  // nothing. Only when both come to nothing does the face stand in.
  loadThumb(other.path, shot).then((got) => { if (!got) showTheFace(shot, other); });

  const pct = document.createElement('span');
  pct.className = 'similar-pct';
  pct.textContent = `${Math.round(other.score * 100)}%`;
  shot.appendChild(pct);

  if (other.rating) {
    const stars = document.createElement('span');
    stars.className = 'similar-stars';
    stars.textContent = '\u2605'.repeat(other.rating);
    shot.appendChild(stars);
  }

  const name = document.createElement('span');
  name.className = 'similar-name';
  name.textContent = credited || other.name;
  tile.appendChild(name);

  // Playing it rebuilds this row for the new video, so the row is a way of
  // travelling through the library by who is in it.
  tile.addEventListener('click', () => {
    // If it happens to be in the listing, play THAT object: it is the one the
    // grid, the arrows and the rating keys are all already pointing at.
    const inView = state.files.find((f) => f.path === other.path);
    playFile(inView || other);
  });
  return tile;
}

/** A label in the strip, and the element back so it can be replaced. */
function say(host, className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  host.appendChild(el);
  return el;
}

/**
 * Why a profiled video suggested nobody.
 *
 * A near miss and an empty video look identical from outside, and the first is
 * worth seeing: the closest name and how far short it fell says whether the
 * performer is simply not in the index yet or whether the video is unreadable.
 * The near misses open the lineup rather than adding anyone -- they did not
 * clear the bar, so the one useful action is to look.
 */
/**
 * Why a profiled video suggested nobody, and who came closest.
 *
 * A near miss and an empty video look identical from outside, and the first is
 * worth seeing: a name that fell just short says the performer is in the index
 * but the evidence was thin, where nothing at all says the video is unreadable.
 *
 * The near misses are tiles like any other. Being below the bar is a statement
 * about how sure the recogniser is, not about what you are allowed to do, so
 * clicking one credits her exactly as clicking a suggestion does.
 */
async function explainNothing(host, file) {
  let info;
  try {
    info = await api(`/api/faces/standing?path=${encodeURIComponent(file.path)}`);
  } catch {
    host.replaceChildren();
    return;
  }
  // The player may have moved on while that was in the air.
  if (!state.playing || state.playing.path !== file.path) return;
  host.replaceChildren();
  if (!info.profiled || !info.people) return;

  // Nothing under half is offered. The bands themselves go down to 0.38, which
  // was defensible when the answer was a name in a line of text; a picture
  // invites a click, and a 40% face is not worth inviting one on. The row
  // below draws its line in the same place.
  const near = uncredited(file, (info.near || []).filter((n) => n.score >= FACE_FLOOR));
  if (!near.length) return;

  const pictures = await picturesFor(file, near.map((n) => n.name));
  if (!state.playing || state.playing.path !== file.path) return;
  host.replaceChildren();

  const row = document.createElement('div');
  row.className = 'similar-row';
  host.appendChild(row);
  for (const one of near) {
    const sug = {
      name: one.name,
      score: one.score,
      margin: one.margin,
      band: 'near',
      person: 0,
      videos: 0,
      runnerUp: '',
    };
    row.appendChild(buildFaceTile(file, sug, {
      best: pictures[one.name],
      onPick: (name) => {
        closeFaceHover();
        editRecords([file.path], { addModels: [name] })
          .then(() => { if (state.playing) buildPlayerSuggestions(state.playing); });
      },
    }));
  }
}

/**
 * The same suggestions inside the label dialog, where the names are actually
 * typed. Across a selection they are pooled: one chip per name, adding it to the
 * box rather than to the files, so Add and Replace still mean what they say.
 */
function renderDialogSuggestions(files) {
  const host = $('#modelFaces');
  if (!host) return;
  host.replaceChildren();
  const single = files.length === 1;
  const pooled = new Map();
  for (const file of files) {
    // Across a selection nobody is "already credited" -- a name can be on one
    // of them and wanted on the rest -- so only a single file is thinned.
    for (const sug of (single ? uncredited(file, file.suggested) : file.suggested || [])) {
      const seen = pooled.get(sug.name);
      if (!seen || sug.score > seen.sug.score) pooled.set(sug.name, { file, sug });
    }
  }
  host.hidden = !pooled.size;
  if (!pooled.size) return;

  const label = document.createElement('span');
  label.className = 'face-lead';
  label.textContent = single ? 'Looks like' : `Looks like \u00b7 across ${files.length}`;
  host.appendChild(label);
  for (const { file, sug } of [...pooled.values()].sort((a, b) => b.sug.score - a.sug.score)) {
    host.appendChild(buildFaceChip(single ? file : { ...file, models: [] }, sug, {
      showFace: single,
      onPick: (name) => {
        const box = $('#modelInput');
        const have = box.value.split(',').map((t) => t.trim()).filter(Boolean);
        if (!have.some((t) => t.toLowerCase() === name.toLowerCase())) have.push(name);
        box.value = have.join(', ');
        renderTagSuggestions();
      },
    }));
  }
}

/**
 * The lineup: is this her?
 *
 * A name beside a 22px thumbnail asks to be taken on trust. The same face
 * beside eight of hers does not -- it shows the comparison the ranking already
 * made instead of asserting the result of it, and same-person-or-not is then a
 * two-second judgement rather than an act of faith.
 *
 * The runner-up is named too. When it is a close call, who else it nearly was
 * tells you as much as who it was.
 */
let lineupFor = null;

async function openFaceLineup(file, sug, onPick) {
  lineupFor = { file, sug, onPick };
  const already = (file.models || []).some((m) => m.toLowerCase() === sug.name.toLowerCase());

  $('#faceTitle').textContent = already
    ? `${sug.name} — does the face agree?`
    : `Is this ${sug.name}?`;
  $('#faceThis').src =
    `/api/faces/face?path=${encodeURIComponent(file.path)}&person=${sug.person || 0}`;
  $('#faceThisName').textContent = file.name;
  $('#faceHerLabel').textContent = 'Loading her other videos…';
  $('#faceHer').replaceChildren();
  $('#faceHerNote').textContent = '';

  const pct = Math.round(sug.score * 100);
  const gap = Math.round(sug.margin * 100);
  $('#faceVerdict').textContent = sug.band === 'near'
    ? `${pct}% alike — below the bar to suggest, so judge it yourself.`
    : `${pct}% alike, ${gap} points clear of ${sug.runnerUp} — ${BAND_LABEL[sug.band]}.`;
  $('#faceVerdict').className = `face-verdict band-${sug.band}`;

  $('#faceAdd').textContent = already ? 'Already credited' : `Add ${sug.name}`;
  $('#faceAdd').disabled = already;
  // Every video she is credited with, which is what the button actually does --
  // not the smaller number of hers that have been read for faces.
  const credited = (state.modelVocab.find(
    (v) => v.tag.toLowerCase() === sug.name.toLowerCase(),
  ) || {}).count;
  $('#faceOnly').textContent = credited
    ? `See her ${credited} video${credited === 1 ? '' : 's'}`
    : 'See her videos';
  $('#faceModal').hidden = false;

  let data;
  try {
    data = await api(`/api/faces/lineup?model=${encodeURIComponent(sug.name)}&limit=8`);
  } catch (err) {
    $('#faceHerLabel').textContent = 'Could not load her other faces';
    return;
  }
  // The dialog may have been closed, or reopened on someone else, while that
  // request was in the air.
  if (!lineupFor || lineupFor.sug.name !== sug.name) return;

  const others = (data.faces || []).filter((f) => f.key !== keyOf(file));
  // What is on the right is what has been read, not everything she is in --
  // those are different numbers and saying the larger one over the smaller set
  // reads as missing pictures.
  $('#faceHerLabel').textContent = others.length
    ? `${sug.name} — ${others.length} of her ${data.total} read so far`
    : `No stored faces for ${sug.name} yet`;
  $('#faceHerNote').textContent = data.contributing
    ? `Her average is built from ${data.contributing} of them`
      + (data.odd ? `, ${data.odd} of which look unlike the rest — likely a co-star.` : '.')
    : '';

  const grid = $('#faceHer');
  grid.replaceChildren();
  // A profile can exist without a picture -- the vector is what matters and the
  // crop is a courtesy -- so the grid can end up empty even when she has
  // videos. Saying so beats an unexplained blank next to "9 videos".
  let showing = others.length;
  const noteWhenEmpty = () => {
    showing -= 1;
    if (showing > 0) return;
    $('#faceHerLabel').textContent = `No stored faces for ${sug.name} yet`;
    $('#faceHerNote').textContent = 'They are written as the sweep reaches her videos.';
  };
  for (const other of others) {
    const cell = document.createElement('figure');
    // Marked, not hidden: it counts towards her average either way, and a
    // lineup that quietly drops its awkward evidence is not a lineup.
    cell.className = 'face-cell'
      + (other.agrees !== null && other.agrees < 0.3 ? ' face-odd' : '');
    if (other.agrees !== null && other.agrees < 0.3) {
      cell.title = 'This face looks unlike her others — probably a co-star picked '
        + 'from a video with few faces in it';
    }
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = `/api/faces/crop?key=${encodeURIComponent(other.key)}&person=0`;
    img.addEventListener('error', () => { cell.remove(); noteWhenEmpty(); });
    // A profile written before filenames were recorded has no caption of its
    // own; the listing usually holds the same video and can supply one.
    const known = other.name
      || (state.files.find((f) => keyOf(f) === other.key) || {}).name || '';
    const cap = document.createElement('figcaption');
    cap.textContent = known || '—';
    cap.title = known;
    cell.appendChild(img);
    cell.appendChild(cap);
    grid.appendChild(cell);
  }
}

function closeFaceLineup() {
  lineupFor = null;
  $('#faceModal').hidden = true;
}

/** The library's key for a file, so a lineup can leave this video out of it. */
function keyOf(file) {
  return `${file.size}:${Math.round(file.mtimeMs)}`;
}


/**
 * The same readout for duplicate fingerprinting, left of the faces one.
 *
 * Two long backfills run side by side and each answers "how far in are you",
 * so they read the same way: a fraction, one word for what it is doing, and
 * the finding on the end. Clicking pauses, as it does for faces.
 */
let framingStatus = null;
async function pollFramingStatus() {
  try {
    framingStatus = await api('/api/framing/status');
  } catch {
    framingStatus = null;
  }
  renderFramingPill();
}

function renderFramingPill() {
  const pill = $('#framingPill');
  const text = $('#framingText');
  if (!pill || !text) return;
  if (!framingStatus || !framingStatus.available) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const {
    framed, downloaded, counted, cached, remaining, doing, current, done, rate, failed,
  } = framingStatus;
  const n = (x) => Number(x || 0).toLocaleString();

  const finished = counted && !remaining && downloaded > 0 && framed >= downloaded;
  const busy = doing === 'framing' || doing === 'counting';

  pill.classList.toggle('working', busy);
  pill.classList.toggle('waiting', doing === 'waiting');
  pill.classList.toggle('paused', doing === 'paused' || doing === 'stopped');
  pill.classList.toggle('done', finished && !busy);

  text.replaceChildren();
  const said = {
    counting: 'counting the library\u2026',
    framing: 'framing\u2026',
    'standing aside': 'standing aside\u2026',
    waiting: 'waiting',
    paused: 'paused',
    stopped: 'stopped',
  };
  const main = document.createElement('span');
  main.textContent = counted && downloaded ? `${n(framed)} / ${n(downloaded)}` : `${n(framed)}`;
  text.appendChild(main);

  const stateEl = document.createElement('span');
  stateEl.className = 'faces-doing';
  stateEl.textContent = ' ' + (finished && !busy ? 'all framed' : (said[doing] || 'framed'));
  text.appendChild(stateEl);

  // Strips kept for videos that have since gone back to the cloud: work that
  // still counts for something, but not against this denominator. The pills
  // either side of this one report their own the same way.
  if (cached > 0) {
    const kept = document.createElement('span');
    kept.className = 'faces-cached';
    kept.textContent = ` \u00b7 ${n(cached)} cached`;
    text.appendChild(kept);
  }

  pill.title = [
    doing === 'framing' ? `Building the preview frames for ${current}`
      : doing === 'counting' ? 'Counting the library\u2026'
        : doing === 'standing aside' ? 'Waiting for a preview you are looking at'
          : doing === 'waiting' ? 'Ready \u2014 nothing left to frame'
            : doing === 'paused' ? 'Paused \u2014 click to build the preview frames'
              : 'Not running',
    counted && downloaded
      ? `${n(framed)} of ${n(downloaded)} downloaded videos framed`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : `${n(framed)} framed, still counting the library`,
    done ? `${n(done)} built this session${rate ? ` \u00b7 about ${n(rate)}/hour` : ''}` : '',
    failed ? `${n(failed)} could not be read` : '',
    'Ten frames per video, so opening one shows them at once instead of building them.',
    'Cloud videos are framed as you browse them, not here.',
  ].filter(Boolean).join('\n');
}

async function toggleFramingSweep() {
  if (!framingStatus) return;
  try {
    framingStatus = await api('/api/framing/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !framingStatus.enabled }),
    });
    renderFramingPill();
    toast(framingStatus.enabled ? 'Framing resumed' : 'Framing paused');
  } catch (err) {
    toast(err.message, 'err');
  }
}

let dupeStatus = null;
async function pollDupeStatus() {
  try {
    dupeStatus = await api('/api/dupes/status');
  } catch {
    dupeStatus = null;
  }
  renderDupePill();
}

function renderDupePill() {
  const pill = $('#dupesPill');
  const text = $('#dupesText');
  if (!pill || !text) return;
  if (!dupeStatus || !dupeStatus.available) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const {
    fingerprinted, fingerprintedOnDisk, cached, downloaded, counted, remaining,
    doing, current, groups, copies, possible, done, rate, enabled,
  } = dupeStatus;
  const n = (x) => Number(x || 0).toLocaleString();

  const finished = counted && !remaining && downloaded > 0
    && fingerprintedOnDisk >= downloaded;
  const busy = doing === 'reading' || doing === 'counting' || doing === 'matching';

  pill.classList.toggle('working', busy);
  pill.classList.toggle('waiting', doing === 'waiting');
  pill.classList.toggle('paused', doing === 'paused' || doing === 'stopped');
  pill.classList.toggle('done', finished && !busy);

  text.replaceChildren();
  const said = {
    loading: 'opening the fingerprints\u2026',
    counting: 'counting the library\u2026',
    reading: 'fingerprinting\u2026',
    matching: 'comparing\u2026',
    waiting: 'waiting for you to pause',
    paused: 'paused',
    stopped: 'stopped',
  };
  const main = document.createElement('span');
  main.textContent = counted && downloaded
    ? `${n(fingerprintedOnDisk)} / ${n(downloaded)}`
    : `${n(fingerprinted)}`;
  text.appendChild(main);

  const state = document.createElement('span');
  state.className = 'faces-doing';
  state.textContent = ' ' + (finished && !busy
    ? 'all fingerprinted' : (said[doing] || 'fingerprinted'));
  text.appendChild(state);

  // Read exactly as the faces pill reads: work done on videos that have since
  // gone back to the cloud, kept and still counting for something. How many
  // copies could be deleted is a finding rather than progress, so it moves to
  // the tooltip, where the pill beside this one keeps its findings too.
  if (cached > 0) {
    const kept = document.createElement('span');
    kept.className = 'faces-cached';
    kept.textContent = ` \u00b7 ${n(cached)} cached`;
    text.appendChild(kept);
  }

  pill.title = [
    doing === 'reading' ? `Fingerprinting ${current}`
      : doing === 'matching' ? 'Comparing what has been read so far\u2026'
        : doing === 'loading' ? 'Reading back what has already been fingerprinted\u2026'
          : doing === 'counting' ? 'Counting the library\u2026'
            : doing === 'waiting' ? 'Ready \u2014 it reads a video whenever you pause for a moment'
              : doing === 'paused' ? 'Paused'
                : 'Not running',
    counted && downloaded
      ? `${n(fingerprintedOnDisk)} of ${n(downloaded)} downloaded videos fingerprinted`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : `${n(fingerprinted)} fingerprinted, still counting the library`,
    cached > 0
      ? `${n(cached)} more were fingerprinted before being freed up to the cloud, `
        + 'and still count as copies'
      : null,
    'Cloud-only videos are never fingerprinted \u2014 reading one would download it',
    groups
      ? `${n(groups)} set${groups === 1 ? '' : 's'} of copies found, `
        + `${n(copies)} file${copies === 1 ? '' : 's'} could go`
      : 'No duplicates found yet',
    possible ? `${n(possible)} more where only one of sound and picture agreed` : null,
    done ? `${n(done)} read this session${rate ? `, about ${n(rate)} an hour` : ''}` : null,
    'Advanced filters \u2192 Duplicates to see them',
    enabled ? 'Click to pause' : 'Click to resume',
  ].filter(Boolean).join('\n');
}

async function toggleDupeSweep() {
  if (!dupeStatus) return;
  try {
    dupeStatus = await api('/api/dupes/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !dupeStatus.enabled }),
    });
    renderDupePill();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/**
 * How far the backfill has got, in the toolbar.
 *
 * Polled rather than pushed: the sweep runs for hours and a websocket for one
 * number would be a lot of machinery for a line of text. Clicking it pauses.
 */
let faceStatus = null;
async function pollFaceStatus() {
  try {
    faceStatus = await api('/api/faces/status');
  } catch {
    faceStatus = null;
  }
  renderFacePill();
}

function renderFacePill() {
  const pill = $('#facesPill');
  const text = $('#facesText');
  if (!pill || !text) return;
  if (!faceStatus || !faceStatus.available) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  const {
    profiled, profiledOnDisk, cached, downloaded, counted, remaining,
    performers, current, lastRead, enabled, doing, done, rate,
  } = faceStatus;
  const n = (x) => Number(x || 0).toLocaleString();

  // "Finished" has to mean finished: counted the library, nothing queued, and
  // nothing left over. A green pill over an untouched library is worse than no
  // pill, and that is what a bare "profiled >= downloaded" gave when the count
  // itself was wrong.
  const finished = counted && !remaining && downloaded > 0
    && profiledOnDisk >= downloaded && doing !== 'counting';
  const busy = doing === 'reading' || doing === 'counting';

  pill.classList.toggle('working', busy);
  pill.classList.toggle('waiting', doing === 'waiting');
  pill.classList.toggle('paused', doing === 'paused' || doing === 'stopped');
  pill.classList.toggle('done', finished && !busy);

  // What it is doing comes first, because that is the question being asked of
  // it. The fraction is the answer to a different one.
  text.replaceChildren();
  const said = {
    loading: 'opening the face index…',
    counting: 'counting the library…',
    reading: 'reading…',
    waiting: 'waiting for you to pause',
    paused: 'paused',
    stopped: 'stopped',
  };
  const main = document.createElement('span');
  main.textContent = counted && downloaded
    ? `${n(profiledOnDisk)} / ${n(downloaded)}`
    : `${n(profiled)}`;
  text.appendChild(main);

  const state = document.createElement('span');
  state.className = 'faces-doing';
  state.textContent = ' ' + (finished && !busy ? 'all profiled' : (said[doing] || 'profiled'));
  text.appendChild(state);

  if (cached > 0) {
    const kept = document.createElement('span');
    kept.className = 'faces-cached';
    kept.textContent = ` \u00b7 ${n(cached)} cached`;
    text.appendChild(kept);
  }

  pill.title = [
    doing === 'reading' ? `Reading ${current}`
      : doing === 'loading' ? 'Reading back what has already been profiled…'
        : doing === 'counting' ? 'Counting the library…'
        : doing === 'waiting' ? 'Ready — it reads a video whenever you pause for a moment'
          : doing === 'paused' ? 'Paused'
            : 'Not running',
    counted && downloaded
      ? `${n(profiledOnDisk)} of ${n(downloaded)} videos on this machine profiled`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : `${n(profiled)} videos profiled, still counting the library`,
    cached > 0
      ? `${n(cached)} more were profiled before being freed up to the cloud, and still work`
      : null,
    done ? `${n(done)} read this session${rate ? `, about ${n(rate)} an hour` : ''}` : null,
    lastRead && doing !== 'reading' ? `Last read ${lastRead}` : null,
    `${performers} performer${performers === 1 ? '' : 's'} recognisable so far`,
    enabled ? 'Click to pause' : 'Click to resume',
  ].filter(Boolean).join('\n');
}

async function toggleFaceSweep() {
  if (!faceStatus) return;
  try {
    faceStatus = await api('/api/faces/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !faceStatus.enabled }),
    });
    renderFacePill();
    toast(faceStatus.enabled ? 'Face profiling resumed' : 'Face profiling paused');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function buildStars(current, onPick, { compact = false } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'stars' + (compact ? ' compact' : '');
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star' + (n <= current ? ' on' : '');
    star.textContent = n <= current ? '★' : '☆';
    // Clicking the rating you already have clears it — otherwise there is no
    // way back to unrated without a separate control.
    star.title = n === current ? 'Clear rating' : `Rate ${n}`;
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onPick(n === current ? 0 : n);
    });
    wrap.appendChild(star);
  }
  return wrap;
}

/**
 * Tags and models are the same shape on a card, so one builder covers both. They
 * are separate fields rather than a tag naming convention: a performer's name
 * colliding with a tag would make both ambiguous, and one dialog edits the pair.
 */
const LABEL_FIELDS = {
  tags: { empty: '+ tag', chip: 'chip', values: (f) => f.tags || [] },
  models: { empty: '+ model', chip: 'chip chip-model', values: (f) => f.models || [] },
  // One allowed answer, so it reads a single value rather than a list, and
  // removing it means clearing the field instead of dropping one entry.
  studio: {
    empty: '+ studio',
    chip: 'chip chip-studio',
    values: (f) => (f.studio ? [f.studio] : []),
  },
  // The series within a house: Model Media ships MD, MDX, MCY, TZ and MSD, and
  // "which of those is this" is a question the studio cannot answer.
  production: {
    empty: '+ production',
    chip: 'chip chip-production',
    values: (f) => (f.production ? [f.production] : []),
  },
};

// Which of them hold one value rather than a list -- the matcher's list, read
// here rather than restated, because "several studios can only mean any" is a
// fact about the data and not about this dialog.
for (const [field, spec] of Object.entries(LABEL_FIELDS)) {
  spec.single = SINGLE_VALUED[field] === true;
}

/**
 * `add` puts an editing affordance on the row. Only tags carry one: two on a card
 * meant two buttons opening the same dialog, and the model names are reachable
 * from it either way.
 */
function buildLabelChips(file, field, { add: withAdd = true } = {}) {
  const spec = LABEL_FIELDS[field];
  const Field = field[0].toUpperCase() + field.slice(1);
  const chips = document.createElement('span');
  chips.className = 'chips';

  for (const value of spec.values(file)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = spec.chip;
    chip.textContent = value;
    chip.title = `Filter by "${value}" — right-click to remove it from this video`;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      filterByLabel(field, value);
    });
    chip.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      editRecords([file.path], spec.single ? { [field]: '' } : { ['remove' + Field]: [value] });
    });
    chips.appendChild(chip);
  }

  if (withAdd) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = spec.chip + ' chip-add';
    add.textContent = spec.values(file).length ? '+' : spec.empty;
    add.title = 'Edit tags and models';
    add.addEventListener('click', (ev) => { ev.stopPropagation(); openTagDialog([file]); });
    chips.appendChild(add);
  }

  return chips;
}

function buildRecordRow(file) {
  const row = document.createElement('div');
  row.className = 'record-row';

  row.appendChild(buildStars(file.rating || 0, (rating) => editRecords([file.path], { rating }), { compact: true }));

  // The studio leads: it is the one fact there can only be one of, so it reads
  // as a heading for the names rather than another entry among them.
  if (file.studio) row.appendChild(buildLabelChips(file, 'studio', { add: false }));
  if (file.production) row.appendChild(buildLabelChips(file, 'production', { add: false }));

  // Names show when there are names; nothing sits there inviting you to add one.
  if ((file.models || []).length) row.appendChild(buildLabelChips(file, 'models', { add: false }));
  row.appendChild(buildLabelChips(file, 'tags'));
  return row;
}

/**
 * The vocabulary by name, for the dialog. It arrives most-used first, which
 * answers "what do I tag with" -- but adding a tag is the other question, "is
 * `nurse` already in here", and for that you look the word up rather than scan
 * for it. The count stays on each chip, so nothing is lost by reordering.
 */
function vocabByName(field) {
  const vocab = { models: state.modelVocab, studio: state.studioVocab,
    production: state.productionVocab }[field] || state.tagVocab;
  return vocab.slice().sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { numeric: true, sensitivity: 'base' }));
}

function syncTagVocab() {
  for (const [field, id] of [['tags', '#tagVocab'], ['models', '#modelVocab'],
    ['studio', '#studioVocab'], ['production', '#productionVocab']]) {
    const list = $(id);
    if (!list) continue;
    list.innerHTML = '';
    for (const entry of vocabByName(field)) {
      const option = document.createElement('option');
      option.value = entry.tag;
      option.label = `${entry.count}`;
      list.appendChild(option);
    }
  }
}

/** Which input holds which field, so the two sections stay symmetrical. */
const LABEL_INPUTS = {
  tags: { input: '#tagInput', suggest: '#tagSuggest' },
  models: { input: '#modelInput', suggest: '#modelSuggest' },
  studio: { input: '#studioInput', suggest: '#studioSuggest' },
  production: { input: '#productionInput', suggest: '#productionSuggest' },
};

function parseTags(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * One dialog, two sections. They were separate dialogs reached from separate
 * buttons, which meant naming a performer and tagging the same video was two
 * trips — and the two fields are almost always edited together.
 */
function openTagDialog(files) {
  if (!files.length) return;
  state.tagTargets = files;
  const single = files.length === 1;

  $('#tagTitle').textContent = single
    ? `Tags and models · ${files[0].name}`
    : `Tags and models · ${files.length} videos`;
  // Pre-filling with one file's values makes Replace a sensible edit. Across
  // many files there is no shared starting point, so the boxes start empty and
  // Add is the safe verb.
  for (const field of ['tags', 'models']) {
    $(LABEL_INPUTS[field].input).value = single ? (files[0][field] || []).join(', ') : '';
  }
  // Across several videos a shared value is a sensible starting point; a mixed
  // selection starts blank, so Add leaves each one's own alone.
  for (const field of ['studio', 'production']) {
    const shared = new Set(files.map((f) => f[field] || ''));
    $(LABEL_INPUTS[field].input).value = shared.size === 1 ? [...shared][0] : '';
  }
  $('#tagHint').textContent = single
    ? 'Add appends, Replace overwrites — every section at once. Right-click a chip on the card to remove one.'
    : `Add appends to each video's existing tags and models. Replace overwrites all ${files.length}.`;
  $('#tagReplace').textContent = single ? 'Replace' : `Replace on ${files.length}`;
  $('#tagAdd').textContent = single ? 'Add' : `Add to ${files.length}`;

  syncTagVocab();
  renderTagSuggestions();
  renderDialogSuggestions(files);
  $('#tagModal').hidden = false;

  // The dialog opens at the top. Focusing the tag box scrolls it into view, and
  // with four sections that means opening halfway down with Studio and
  // Production above the fold — so the caret goes there without the scroll, and
  // the body is put back to the top explicitly in case anything else moved it.
  $('#tagInput').focus({ preventScroll: true });
  $('#tagInput').select();
  $('#tagModal .tag-body').scrollTop = 0;
}

/** The existing vocabulary as one-click chips — faster than typing, and it
 *  keeps names from splintering into near-duplicates. */
function renderTagSuggestions() {
  for (const field of LABEL_FACETS) {
    const { input, suggest } = LABEL_INPUTS[field];
    const box = $(suggest);
    box.innerHTML = '';
    const single = LABEL_FIELDS[field].single;
    const used = new Set(parseTags($(input).value).map((t) => t.toLowerCase()));
    const extra = { models: ' chip-model', studio: ' chip-studio',
      production: ' chip-production' }[field] || '';
    // Every value, not the first 60. The cap was invisible: with 778 performers
    // the box looked complete and simply had no more to scroll to, which is the
    // one thing a truncated list must never look like. `.tag-suggest` already
    // scrolls, so the length costs nothing but the height it is clamped to.
    for (const entry of vocabByName(field)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip suggest' + extra + (used.has(entry.tag.toLowerCase()) ? ' on' : '');
      chip.textContent = `${entry.tag} · ${entry.count}`;
      chip.addEventListener('click', () => {
        // A one-value field swaps rather than accumulates: picking a second
        // studio replaces the first, and picking the current one clears it.
        if (single) {
          const now = $(input).value.trim().toLowerCase();
          $(input).value = now === entry.tag.toLowerCase() ? '' : entry.tag;
          renderTagSuggestions();
          return;
        }
        const current = parseTags($(input).value);
        const at = current.findIndex((t) => t.toLowerCase() === entry.tag.toLowerCase());
        if (at >= 0) current.splice(at, 1);
        else current.push(entry.tag);
        $(input).value = current.join(', ');
        renderTagSuggestions();
      });
      box.appendChild(chip);
    }
  }
}

async function commitTags(mode) {
  const tags = parseTags($('#tagInput').value);
  const models = parseTags($('#modelInput').value);
  const studio = $('#studioInput').value.trim();
  const production = $('#productionInput').value.trim();
  const paths = state.tagTargets.map((f) => f.path);

  $('#tagModal').hidden = true;
  // One request for every field: separate ones would mean separate saves,
  // separate vocabulary refreshes, and a window where a card shows half the
  // edit. Add leaves a blank studio box alone, since there is nothing to append
  // to a field that holds one value; Replace sends it either way, so clearing
  // the box is how you clear the studio.
  await editRecords(paths, mode === 'add'
    ? {
      addTags: tags,
      addModels: models,
      ...(studio ? { studio } : {}),
      ...(production ? { production } : {}),
    }
    : { tags, models, studio, production });

  const say = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const videos = say(paths.length, 'video');
  toast(mode === 'add'
    ? `Added ${say(tags.length, 'tag')} and ${say(models.length, 'model')} to ${videos}`
    : `Tags and models set on ${videos}`, 'ok');
}

/**
 * The other direction: push the sidecar into the files themselves. This
 * rewrites each container, so it warns with the real byte count first and
 * refuses cloud-only files rather than downloading them.
 */
async function embedSelection() {
  const files = state.files.filter((f) => state.selected.has(f.path));
  const local = files.filter((f) => !f.cloudOnly);
  const cloud = files.length - local.length;
  const tagged = local.filter((f) => f.rating || (f.tags || []).length);

  if (!tagged.length) {
    toast(cloud ? `Nothing to write — ${cloud} are cloud-only` : 'None of these have a rating or tags yet', 'err');
    return;
  }

  const bytes = tagged.reduce((n, f) => n + f.size, 0);
  const warning = `Write ratings and tags into ${tagged.length} video${tagged.length === 1 ? '' : 's'}?\n\n`
    + `Each file is rebuilt to carry the tags, so ${fmtBytes(bytes)} gets rewritten and re-uploaded to OneDrive.\n`
    + 'Previews are carried over, not rebuilt.'
    + (cloud ? `\n\n${cloud} cloud-only file${cloud === 1 ? '' : 's'} will be skipped.` : '');
  if (!window.confirm(warning)) return;

  setStatus(`Writing tags into ${tagged.length} file${tagged.length === 1 ? '' : 's'}…`);
  try {
    const data = await api('/api/library/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: tagged.map((f) => f.path) }),
    });
    const ok = data.results.filter((r) => r.ok);
    const failed = data.results.filter((r) => !r.ok);
    for (const result of ok) {
      const file = state.files.find((f) => f.path === result.path);
      if (file) file.size = result.size; // the file grew by the tag block
    }
    toast(failed.length
      ? `Wrote ${ok.length}, failed ${failed.length}: ${failed[0].error}`
      : `Wrote tags into ${ok.length} file${ok.length === 1 ? '' : 's'}`, failed.length ? 'err' : 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
  }
  updateStatusLine();
}

// ------------------------------------------------------------------ sprites

/**
 * Every tile's picture is fetched, on screen or not: the listing arrives whole,
 * so the pictures do too.
 *
 * Six at a time and in the order the cards were built, so the top of the grid
 * fills first and the server's own ffmpeg limit is matched rather than buried
 * under a thousand simultaneous requests.
 */
// `queued` is membership only. Scanning the array for it would be a linear
// search per card, and a listing of twenty-six thousand does that twenty-six
// thousand times before a single picture lands.
const posters = { queue: [], queued: new Set(), running: 0, limit: 6 };

/**
 * `urgent` is "this one is on screen".
 *
 * The queue is in card order, which is the right order to work through a
 * library in but the wrong one to answer a scroll with: a cloud file's picture
 * is a round trip to OneDrive, so a listing of twenty-six thousand of them is
 * half an hour of work, and a tile four thousand cards down would have waited
 * most of it out reading "cloud only". What you are looking at goes first.
 */
function queuePoster(previewEl, urgent = false) {
  if (posters.queued.has(previewEl)) {
    if (!urgent) return;               // already waiting its turn
    const at = posters.queue.indexOf(previewEl);
    if (at <= 0) return;               // already at the front, or in flight
    posters.queue.splice(at, 1);
  } else {
    posters.queued.add(previewEl);
  }
  if (urgent) posters.queue.unshift(previewEl);
  else posters.queue.push(previewEl);
  drainPosters();
}

/**
 * Puts a tile back in the queue after OneDrive has asked us to wait.
 *
 * Three goes at widening intervals and then it is left alone: a service that is
 * still saying no after half a minute of asking is not going to be talked round
 * by a fourth request, and the tile can be filled by scrolling back to it.
 */
const retried = new Map(); // path -> how many times

function retryPoster(previewEl, filePath, seconds) {
  const goes = retried.get(filePath) || 0;
  if (goes >= 3 || !previewEl) return;
  retried.set(filePath, goes + 1);
  setTimeout(() => {
    // Its card may be long gone by now -- a different folder, or a filter.
    if (previewEl.isConnected) queuePoster(previewEl);
  }, Math.min(seconds * (goes + 1), 30) * 1000);
}

function drainPosters() {
  while (posters.running < posters.limit && posters.queue.length) {
    const el = posters.queue.shift();
    posters.queued.delete(el);
    // Its card left the grid before its turn came -- a re-render, or a filter.
    if (!el.isConnected) continue;
    posters.running += 1;
    Promise.resolve(loadPoster(el))
      .catch(() => { /* a failed tile marks itself; the queue carries on */ })
      .then(() => { posters.running -= 1; drainPosters(); });
  }
}

/**
 * Prebuilding a cloud video's strip is still driven by what you can see. In
 * live mode the tile only ever wanted one frame, and a strip is ten of them
 * over about twelve seconds of range requests -- so doing the whole library's
 * worth the moment a folder opens is a different thing from loading it.
 */
const spriteObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    spriteObserver.unobserve(entry.target);
    // On screen, or 400px from it: its picture jumps the queue. Everything is
    // still fetched -- this only decides what is fetched next.
    queuePoster(entry.target, true);
    // Build its strip now, while nobody is waiting on it, so opening it later
    // costs a read from disk.
    const queued = state.files.find((f) => f.path === entry.target.dataset.path);
    if (queued) queuePrebuild(queued);
  }
}, { root: scrollRoot, rootMargin: '400px 0px' });

/**
 * Folder covers fetch the same poster but apply it themselves. applyThumb() is
 * written for the 16:9 video tiles — letting it style a 62x36 cover box is what
 * made cover-bearing folder rows taller than plain ones.
 *
 * Fetched outright rather than when the row scrolls into view: one folder is
 * one poster, and there are never enough of them for that to be worth deferring.
 */
function loadFolderCover(el) {
  loadThumb(el.dataset.path, null).then((url) => {
    if (!url) return;
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  });
}

/** Frees blob URLs so repeated rescans don't grow memory forever. */
function clearSprites() {
  for (const entry of state.sprites.values()) URL.revokeObjectURL(entry.url);
  for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
  state.sprites.clear();
  state.thumbs.clear();
  state.failed.clear();
}

/**
 * Resolves to the sprite for a file, sharing a single request when several
 * callers (the observer and a hover) ask for the same file at once.
 */
function loadSprite(filePath, previewEl) {
  if (!filePath) return Promise.resolve(null);

  const cached = state.sprites.get(filePath);
  if (cached) {
    if (previewEl) applySprite(previewEl, cached);
    return Promise.resolve(cached);
  }
  if (state.failed.has(filePath)) return Promise.resolve(null);

  const inFlight = state.pending.get(filePath);
  if (inFlight) {
    return inFlight.then((entry) => {
      if (entry && previewEl) applySprite(previewEl, entry);
      return entry;
    });
  }

  if (previewEl) previewEl.classList.add('loading');

  // Building a strip for a cloud file means several round trips to OneDrive,
  // and the tile would sit empty for all of them. OneDrive already has a poster
  // for it -- one small image, no download -- so show that in the meantime.
  // Fire and forget: nothing below waits on it.
  let stripLanded = false;
  // Cloud only. A downloaded file builds its strip locally in well under a
  // second, and asking for a poster would just add an ffmpeg run per tile.
  if (previewEl && state.cloudOptIn.has(filePath)) {
    const already = state.thumbs.get(filePath);
    if (already) applyThumb(previewEl, already);
    else {
      fetch(`/api/thumb?path=${encodeURIComponent(filePath)}`)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          // The strip is what was asked for; if it beat us, leave it alone.
          if (!blob || stripLanded) return;
          const url = URL.createObjectURL(blob);
          state.thumbs.set(filePath, url);
          if (!stripLanded) applyThumb(previewEl, url);
        })
        .catch(() => { /* no poster is simply no placeholder */ });
    }
  }

  const request = (async () => {
    try {
      // Cloud-only files are refused unless we say the user asked for this one.
      const allow = state.cloudOptIn.has(filePath) ? '&allowCloud=1' : '';
      const res = await fetch(`/api/sprite?path=${encodeURIComponent(filePath)}${allow}`);
      if (res.status === 409) {
        // Cloud-only and nobody has asked for this one: a refusal, not a
        // failure. Recording it as a failure is what stopped the player ever
        // getting a strip for a file whose tile had scrolled past first.
        if (previewEl) previewEl.classList.remove('loading');
        return null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `sprite failed (${res.status})`);
      }
      const frames = Number(res.headers.get('X-Sprite-Frames')) || 10;
      const blob = await res.blob();
      const entry = { url: URL.createObjectURL(blob), frames };
      state.sprites.set(filePath, entry);
      stripLanded = true;
      return entry;
    } catch (err) {
      state.failed.add(filePath);
      markPreviewFailed(filePath, err.message);
      return null;
    } finally {
      state.pending.delete(filePath);
    }
  })();

  state.pending.set(filePath, request);
  return request.then((entry) => {
    if (entry && previewEl) applySprite(previewEl, entry);
    return entry;
  });
}

function markPreviewFailed(filePath, message) {
  const el = document.querySelector(`.preview[data-path="${CSS.escape(filePath)}"]`);
  if (!el) return;
  el.classList.remove('loading');
  if (el.querySelector('.preview-fail')) return;
  const fail = document.createElement('div');
  fail.className = 'preview-fail';
  const head = document.createElement('div');
  head.textContent = '⚠ No preview';
  const why = document.createElement('div');
  why.textContent = String(message || '').slice(0, 90);
  fail.append(head, why);
  el.appendChild(fail);
}

function applySprite(previewEl, entry) {
  previewEl.classList.remove('loading');
  previewEl.dataset.frames = String(entry.frames);
  previewEl.style.backgroundImage = `url("${entry.url}")`;
  previewEl.style.backgroundSize = `${entry.frames * 100}% 100%`;
  previewEl.style.backgroundPositionX = '0%';
  buildTicks(previewEl, entry.frames);
}

/** Single poster frame — used as the still image in live mode. */
function loadThumb(filePath, previewEl, allowCloud = false) {
  if (!filePath) return Promise.resolve(null);

  const cached = state.thumbs.get(filePath);
  if (cached) {
    applyThumb(previewEl, cached);
    return Promise.resolve(cached);
  }
  if (state.failed.has(filePath)) return Promise.resolve(null);

  const inFlight = state.pending.get(filePath);
  if (inFlight) return inFlight.then((url) => { if (url) applyThumb(previewEl, url); return url; });

  if (previewEl) previewEl.classList.add('loading');

  const request = (async () => {
    try {
      const query = `path=${encodeURIComponent(filePath)}${allowCloud ? '&allowCloud=1' : ''}`;
      const res = await fetch(`/api/thumb?${query}`);
      if (res.status === 409) {
        // Cloud-only and not opted in: leave the tile as-is, no download.
        if (previewEl) previewEl.classList.remove('loading');
        return null;
      }
      if (res.status === 503) {
        // OneDrive is throttling, not refusing: it has a picture for this one.
        // Asked for again shortly rather than left blank for the session, which
        // is what a whole library asking at once used to come to.
        if (previewEl) previewEl.classList.remove('loading');
        const body = await res.json().catch(() => ({}));
        retryPoster(previewEl, filePath, Number(body.retryAfter) || 5);
        return null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `poster failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      state.thumbs.set(filePath, url);
      return url;
    } catch (err) {
      state.failed.add(filePath);
      markPreviewFailed(filePath, err.message);
      return null;
    } finally {
      state.pending.delete(filePath);
    }
  })();

  state.pending.set(filePath, request);
  return request.then((url) => { if (url) applyThumb(previewEl, url); return url; });
}

function applyThumb(previewEl, url) {
  if (!previewEl) return;
  previewEl.classList.remove('loading');
  previewEl.style.backgroundImage = `url("${url}")`;
  previewEl.style.backgroundSize = 'cover';
  previewEl.style.backgroundPosition = 'center';
  buildTicks(previewEl, Math.max(2, Number(state.config.frames) || 10));
  // A cached poster arrived for a cloud file — drop the "cloud-only" placard,
  // the ☁ note in the details row still says it isn't downloaded.
  const placard = previewEl.querySelector('.cloud-mark');
  if (placard) placard.remove();
}

/**
 * Strips built ahead of being wanted, so opening a cloud video is instant.
 *
 * Building one takes about twelve seconds and cannot be made faster -- the
 * concurrency is already at its measured optimum. It can only be made earlier.
 * Since the result is cached on disk forever, doing it while a tile is merely
 * on screen turns every later opening into a 1ms read.
 *
 * Strictly one at a time: a single build is already four parallel range
 * requests to one host, and stacking them collects connection refusals.
 */
const prebuild = { queue: [], seen: new Set(), running: false };

function queuePrebuild(file, urgent = false) {
  if (!file || !file.cloudOnly) return;
  if (prebuild.seen.has(file.path)) {
    // Already queued or done -- but a hover still deserves to jump the queue.
    if (!urgent) return;
    const at = prebuild.queue.findIndex((f) => f.path === file.path);
    if (at > 0) prebuild.queue.unshift(...prebuild.queue.splice(at, 1));
    return;
  }
  if (state.sprites.has(file.path)) return; // this session already has it
  prebuild.seen.add(file.path);
  if (urgent) prebuild.queue.unshift(file);
  else prebuild.queue.push(file);
  runPrebuild();
}

async function runPrebuild() {
  if (prebuild.running) return;
  prebuild.running = true;
  try {
    while (prebuild.queue.length) {
      const file = prebuild.queue.shift();
      // Watching is not required to build it, and building downloads nothing.
      state.cloudOptIn.add(file.path);
      state.failed.delete(file.path);
      try { await loadSprite(file.path, null); } catch { /* try the next one */ }
    }
  } finally {
    prebuild.running = false;
  }
}

/**
 * Asks the server to resolve a cloud file's streaming URL before it is needed.
 *
 * Once per file per session: the server caches the answer for 45 minutes, and
 * a second request would only confirm what it already knows. Failures are
 * ignored on purpose -- this is an optimisation, and /api/video still does the
 * lookup itself if this never ran.
 */
const warmed = new Set();
function warmStream(file) {
  if (!file || !file.cloudOnly || warmed.has(file.path)) return;
  warmed.add(file.path);
  fetch(`/api/warm?path=${encodeURIComponent(file.path)}`).catch(() => {
    // Let it be tried again: the click may still be seconds away.
    warmed.delete(file.path);
  });
}

/** Dispatches to whichever engine is active. */
function loadPoster(previewEl) {
  return state.config.previewMode === 'sprite'
    ? loadSprite(previewEl.dataset.path, previewEl)
    : loadThumb(previewEl.dataset.path, previewEl);
}

// --------------------------------------------------------- segment indicator

function buildTicks(previewEl, count) {
  const ticks = previewEl.querySelector('.ticks');
  if (!ticks || ticks.children.length === count) return;
  ticks.innerHTML = '';
  for (let i = 0; i < count; i += 1) {
    const tick = document.createElement('span');
    tick.className = 'tick' + (i === 0 ? ' on' : '');
    ticks.appendChild(tick);
  }
}

function markSegment(previewEl, index, count, atSeconds) {
  const ticks = previewEl.querySelector('.ticks');
  if (ticks) {
    for (let t = 0; t < ticks.children.length; t += 1) {
      ticks.children[t].classList.toggle('on', t === index);
    }
  }
  const badge = previewEl.querySelector('.badge-frame');
  if (badge) {
    const at = atSeconds > 0 ? ' · ' + fmtDuration(atSeconds) : '';
    badge.textContent = `${index + 1}/${count}${at}`;
  }
}

/**
 * Even divisions of the running time: for a 20-minute video split 10 ways,
 * segment 1 is at 2:00, segment 2 at 4:00, and so on. The last one is pulled a
 * second short of the end, since an exact-EOF seek yields a black frame.
 */
function segmentTime(duration, index, count) {
  if (!(duration > 0)) return 0;
  const at = (duration * (index + 1)) / count;
  return Math.min(at, Math.max(0, duration - 1));
}

// ------------------------------------------------------- live hover previews

/**
 * One shared <video> that hops between tiles. Browsers cap concurrent video
 * decoders, and only one tile is ever hovered, so a pool of one is correct.
 */
const live = { video: null, el: null, timer: null, index: 0 };

function ensureLiveVideo() {
  if (live.video) return live.video;
  const video = document.createElement('video');
  video.className = 'live-layer';
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.disablePictureInPicture = true;
  video.addEventListener('error', () => stopLive());
  live.video = video;
  return video;
}

function startLive(previewEl, file) {
  stopLive();
  // Never scrub behind a dialog. The player sits over the grid, so a preview
  // that kept cycling would be competing with the thing you actually opened.
  if (modalOpen()) return;

  const count = Math.max(2, Number(state.config.frames) || 10);
  const video = ensureLiveVideo();
  live.el = previewEl;
  live.index = 0;

  buildTicks(previewEl, count);
  previewEl.appendChild(video);

  const show = (index) => {
    live.index = index;
    // The element is the authority on duration — no ffprobe needed, and it's
    // correct even for files the scan never probed.
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    if (duration <= 0) return; // metadata not in yet; the interval will retry

    const at = segmentTime(duration, index, count);
    try {
      video.currentTime = at;
    } catch {
      return;
    }
    const played = video.play();
    if (played && played.catch) played.catch(() => {});
    markSegment(previewEl, index, count, at);

    // Cache the duration so the tile's badge and details can use it.
    if (!state.meta.has(file.path)) state.meta.set(file.path, { duration });
    previewEl.dataset.duration = String(duration);
  };

  video.onloadedmetadata = () => {
    previewEl.classList.add('live-on'); // reveal only once there are real pixels
    show(0);
  };
  video.src = `/api/video?path=${encodeURIComponent(file.path)}`;

  live.timer = setInterval(
    () => show((live.index + 1) % count),
    Number(state.config.dwellMs) || 2000,
  );
}

function stopLive() {
  clearInterval(live.timer);
  live.timer = null;

  const video = live.video;
  if (video) {
    video.onloadedmetadata = null;
    video.pause();
    video.removeAttribute('src');
    video.load(); // drops the decoder and any buffered data
    if (video.parentNode) video.parentNode.removeChild(video);
  }

  if (live.el) {
    live.el.classList.remove('live-on');
    const count = live.el.querySelectorAll('.tick').length || 1;
    const duration = Number(live.el.dataset.duration) || 0;
    markSegment(live.el, 0, count, segmentTime(duration, 0, count));
  }
  live.el = null;
}

// -------------------------------------------------------------- hover logic

function attachHover(previewEl, file) {
  let timer = null;
  let index = 0;

  const stopSprite = () => {
    clearInterval(timer);
    timer = null;
    index = 0;
    showSpriteFrame(previewEl, 0);
  };

  previewEl.addEventListener('mouseenter', async () => {
    // Before anything else, and whether or not previews are opted into: get the
    // streaming URL resolved now. Playing a cloud file needs a Graph lookup
    // worth about three seconds, and hovering is the warning that it is coming.
    warmStream(file);
    // The strongest hint about what is about to be clicked.
    queuePrebuild(file, true);
    // Hovering must never trigger a multi-hundred-MB download.
    if (file.cloudOnly && !state.cloudOptIn.has(file.path)) return;
    // Opening the player moves the cursor onto the modal, which fires mouseenter
    // on whatever sits underneath it. Without this, watching something starts a
    // second preview behind the dialog.
    if (modalOpen()) return;

    if (state.config.previewMode !== 'sprite') {
      startLive(previewEl, file);
      return;
    }

    const entry = state.sprites.get(previewEl.dataset.path)
      || await loadSprite(previewEl.dataset.path, previewEl);
    if (!entry || state.config.scrubWithMouse) return;

    index = 0;
    showSpriteFrame(previewEl, 0);
    clearInterval(timer);
    timer = setInterval(() => {
      index = (index + 1) % (Number(previewEl.dataset.frames) || 1);
      showSpriteFrame(previewEl, index);
    }, Number(state.config.dwellMs) || 2000);
  });

  previewEl.addEventListener('pointermove', (ev) => {
    if (state.config.previewMode !== 'sprite' || !state.config.scrubWithMouse) return;
    const frames = Number(previewEl.dataset.frames) || 0;
    if (!frames) return;
    const rect = previewEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    showSpriteFrame(previewEl, Math.floor(ratio * frames));
  });

  previewEl.addEventListener('mouseleave', () => {
    if (state.config.previewMode === 'sprite') stopSprite();
    else if (live.el === previewEl) stopLive();
  });
}

function showSpriteFrame(previewEl, index) {
  const frames = Number(previewEl.dataset.frames) || 0;
  if (frames <= 0) return;
  const i = Math.max(0, Math.min(frames - 1, index));
  // Percentage positioning with background-size N*100% maps frame i exactly.
  previewEl.style.backgroundPositionX = frames > 1 ? `${(i / (frames - 1)) * 100}%` : '0%';
  const duration = Number(previewEl.dataset.duration) || 0;
  markSegment(previewEl, i, frames, segmentTime(duration, i, frames));
}

// ------------------------------------------------------------------ actions

async function doAction(op, paths, extra = {}) {
  if (!paths.length) return [];
  const { results } = await api('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, paths, ...extra }),
  });

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (ok.length) toast(`${ok[0].message}${ok.length > 1 ? ` — ${ok.length} files` : ': ' + baseName(ok[0].path)}`, 'ok');
  for (const r of bad) toast(`${baseName(r.path)}: ${r.message}`, 'err');

  // Reflect the filesystem change locally instead of a full rescan.
  const removed = new Set(ok.filter((r) => op === 'delete' || op === 'move').map((r) => r.path));
  if (removed.size) {
    // A copy may have been deleted from either side: one in this folder, or one
    // fetched in from another. Both are on screen in the duplicates view, so
    // neither can be the only case handled.
    const wasCopy = state.files.some((f) => removed.has(f.path) && f.duplicate)
      || elsewhere.files.some((f) => removed.has(f.path));
    state.files = state.files.filter((f) => !removed.has(f.path));
    removed.forEach((p) => state.selected.delete(p));
    forgetOtherCopies();
    if (wasCopy) await refreshDupeFlags();
  }
  const renamed = ok.filter((r) => op === 'rename' && r.dest);
  for (const r of renamed) {
    const file = state.files.find((f) => f.path === r.path);
    if (file) {
      const sprite = state.sprites.get(file.path);
      if (sprite) { state.sprites.delete(file.path); state.sprites.set(r.dest, sprite); }
      file.path = r.dest;
      file.name = baseName(r.dest);
    }
    state.selected.delete(r.path);
  }
  if (removed.size || renamed.length) render();
  if (op === 'copy' && ok.length) setStatus(`Copied ${ok.length} file${ok.length === 1 ? '' : 's'}`);
  return results;
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

/**
 * Delete one copy and the other stops being one.
 *
 * Asked of the server rather than worked out here. The page can only see the
 * folder it is showing, and in the duplicates view the copy you delete is very
 * often the one fetched from somewhere else -- deleting that left the survivor
 * still wearing its badge, in a section headed "1 copy", which is precisely the
 * thing this feature exists to avoid.
 *
 * The server forgets the key and dissolves any set that drops below two, so its
 * answer is the answer. A localhost round trip is a millisecond.
 */
async function refreshDupeFlags() {
  let members = [];
  try {
    ({ files: members } = await api('/api/dupes/files'));
  } catch {
    return;
  }
  const byPath = new Map(members.map((f) => [f.path, f]));
  const sizes = new Map();
  for (const f of members) sizes.set(f.group, (sizes.get(f.group) || 0) + 1);

  for (const file of state.files) {
    const now = byPath.get(file.path);
    if (now && sizes.get(now.group) > 1) {
      file.duplicate = true;
      file.group = now.group;
      file.copies = sizes.get(now.group);
      file.dupeKinds = now.dupeKinds;
    } else if (file.duplicate) {
      file.duplicate = false;
      file.copies = 0;
      file.dupeKinds = null;
      file.group = undefined;
    }
  }
  // The fetched siblings are the same answer, so keep them rather than asking
  // twice for one deletion.
  elsewhere = { at: Date.now(), files: members };
}

/**
 * Following the account means the path is derived, not chosen — so the box goes
 * read-only and the hint says which account it came from.
 */
function syncHomeFields() {
  const follow = $('#setHomeFollow').checked;
  const account = state.config.homeAccount || {};
  $('#setHomeDir').readOnly = follow;
  $('#setHomeDir').classList.toggle('readonly', follow);
  if (follow && account.email) {
    $('#homeHint').textContent = `Following the OneDrive account ${account.email}`
      + `, which syncs to ${state.config.homeDir}. Moving or renaming that folder is followed automatically.`;
  } else if (follow) {
    $('#homeHint').textContent = 'No OneDrive account detected, so this falls back to '
      + (state.config.homeDir || 'your user folder') + '.';
  } else {
    $('#homeHint').textContent = 'A fixed folder: the app opens here on launch and the 🏠 button goes here, '
      + 'whichever OneDrive account is signed in.';
  }
}

/** Windows paths compare case-insensitively, and a trailing slash means nothing. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** Resolves true only if files were actually recycled. */
async function confirmDelete(paths) {
  const label = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} files`;
  if (!window.confirm(`Send ${label} to the Recycle Bin?\n\nYou can restore from the Recycle Bin if this was a mistake.`)) {
    return false;
  }
  const results = await doAction('delete', paths);
  return results.some((r) => r.ok);
}

function pickFolder(title, onConfirm) {
  state.picker = { onConfirm, title };
  $('#pickerTitle').textContent = title;
  $('#pickerModal').hidden = false;
  openPickerAt(state.config.lastDir || state.dir || '');
  renderRecentDests();
}

async function openPickerAt(dir) {
  try {
    const data = await api(`/api/dirs?dir=${encodeURIComponent(dir || '')}`);
    state.picker.dir = data.dir;
    $('#pickerPath').value = data.dir;
    $('#pickerHint').textContent = data.dir ? '' : 'Pick a drive to start';
    const list = $('#pickerList');
    list.innerHTML = '';

    const rows = data.dir
      ? data.dirs.map((d) => ({ label: d.name, path: d.path, ico: '📁' }))
      : data.drives.map((d) => ({ label: d, path: d, ico: '💽' }));

    if (!rows.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="hint">No subfolders here</span>';
      list.appendChild(li);
    }
    for (const row of rows) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="ico">${row.ico}</span><span></span>`;
      li.lastElementChild.textContent = row.label;
      li.addEventListener('click', () => openPickerAt(row.path));
      list.appendChild(li);
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderRecentDests() {
  const wrap = $('#pickerRecent');
  wrap.innerHTML = '';
  const recents = state.config.recentDests || [];
  for (const dest of recents.slice(0, 8)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = dest;
    chip.title = dest;
    chip.addEventListener('click', () => openPickerAt(dest));
    wrap.appendChild(chip);
  }
}

function closePicker() {
  $('#pickerModal').hidden = true;
  state.picker = null;
}

/** Drops the stream so the OS lets go of the file, keeping the modal open. */
function releasePlayer() {
  const player = $('#player');
  stopPlayerPreview(); // a timer left running would seek a released element
  hidePlayerBar();
  // The captured frames belong to the file that is going away, and the second
  // video would otherwise hold a stream open behind a closed dialog.
  releaseBarPreview();
  scrub.path = null;
  player.pause();
  player.removeAttribute('src');
  player.load();
}

/** Re-attaches the stream after a cancelled or failed destructive action. */
function reopenPlayer(file) {
  const player = $('#player');
  player.src = `/api/video?path=${encodeURIComponent(file.path)}`;
  player.play().catch(() => {});
}

async function renameFromPlayer(file) {
  const next = window.prompt('Rename file', file.name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === file.name) return;

  releasePlayer(); // rename fails while the read stream holds the file
  const results = await doAction('rename', [file.path], { newName: trimmed });
  const ok = results.find((r) => r.ok && r.dest);

  if (!ok) { reopenPlayer(file); return; }

  const renamed = state.files.find((f) => f.path === ok.dest) || { ...file, path: ok.dest, name: baseName(ok.dest) };
  state.playing = renamed;
  $('#playerTitle').textContent = renamed.name;
  buildPlayerActions(renamed);
  reopenPlayer(renamed);
}

function buildPlayerActions(file) {
  buildPlayerRecord(file);
  const bar = $('#playerActions');
  bar.innerHTML = '';
  for (const action of actionsFor(file, { inPlayer: true })) {
    const btn = document.createElement('button');
    btn.className = 'qbtn' + (action.danger ? ' danger' : '');
    btn.textContent = action.icon;
    btn.title = action.title;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      action.run();
    });
    bar.appendChild(btn);
  }
}

function playFile(file, seq = null) {
  stopLive(); // free the hover decoder before opening a second one
  state.playing = file;
  state.playingAnchor = null; // this one is in the listing until told otherwise
  state.playingCard = seq;
  buildPlayerActions(file);
  buildPlayerSuggestions(file);
  buildPlayerSimilar(file);
  $('#playerTitle').textContent = file.name;
  const info = state.meta.get(file.path) || {};
  $('#playerMeta').textContent = [
    info.duration ? fmtDuration(info.duration) : null,
    info.width ? `${info.width}×${info.height}` : null,
    info.fps ? `${info.fps} fps` : null,
    info.codec || null,
    fmtBytes(file.size),
    file.cloudOnly ? '☁ streaming from OneDrive' : null,
  ].filter(Boolean).join('  ·  ');
  const player = $('#player');
  // The element knows its own duration; use it if no probe has landed yet.
  player.onloadedmetadata = () => {
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    if (!duration) return;
    const known = state.meta.get(file.path) || {};
    if (!known.duration) {
      state.meta.set(file.path, { ...known, duration });
      updateCardMeta(file.path);
    }
    $('#playerMeta').textContent = [
      fmtDuration(duration),
      known.width ? `${known.width}×${known.height}` : `${player.videoWidth}×${player.videoHeight}`,
      known.fps ? `${known.fps} fps` : null,
      known.codec || null,
      fmtBytes(file.size),
    ].filter(Boolean).join('  ·  ');
  };
  // Something to look at while the browser fetches the moov atom. For a cloud
  // file that is a round trip to the end of the file, and the stage was simply
  // black for all of it.
  const known = state.thumbs.get(file.path);
  if (known) player.poster = known;
  else {
    player.removeAttribute('poster');
    fetch(`/api/thumb?path=${encodeURIComponent(file.path)}`)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        state.thumbs.set(file.path, url);
        // Only if this is still the video on screen, and only while it has
        // nothing of its own to show yet.
        if (state.playing && state.playing.path === file.path && player.readyState < 2) {
          player.poster = url;
        }
      })
      .catch(() => { /* a missing poster is just the old black stage */ });
  }

  player.src = `/api/video?path=${encodeURIComponent(file.path)}`;
  player.volume = masterVolume();
  $('#playerModal').hidden = false;
  syncPlayerNav();
  // Once you have asked for sound, opening a video means watching it.
  if (soundOn) beginPlayback();
  else startPlayerPreview();
}

/**
 * Walks the listing you can see -- state.view, so the arrows follow the current
 * filter and sort rather than the folder on disk. Wraps at both ends, which
 * keeps the buttons live instead of leaving one dead at each edge.
 */
function playSibling(step) {
  const list = visibleCards();
  if (!state.playing || !list.length) return;
  const at = playingAt();

  // An edit can filter the open video out of the listing while you are watching
  // it. The arrows then work from the slot it vacated: forward lands on whatever
  // slid into that slot, back on the one before it.
  const target = at >= 0
    ? at + step
    : (state.playingAnchor === null ? null : state.playingAnchor + (step > 0 ? 0 : -1));
  if (target === null) return;

  const seq = ((target % list.length) + list.length) % list.length;
  const next = list[seq];
  // Flat, there are no cards to number, so nothing is remembered.
  playFile(state.grouped ? next.file : next, state.grouped ? seq : null);
}

function syncPlayerNav() {
  const list = visibleCards();
  const at = playingAt();
  const adrift = Boolean(at < 0 && state.playing && state.playingAnchor !== null && list.length);
  const usable = (at >= 0 && list.length > 1) || adrift;
  $('#playerPrev').hidden = !usable;
  $('#playerNext').hidden = !usable;

  // Reads as a sentence rather than "3 / 2112", since it now sits in the
  // details popup instead of beside the arrows.
  const pos = $('#playerPos');
  pos.hidden = !state.playing;
  if (at >= 0) {
    // "shown" rather than "in this listing" when grouped: the number counts
    // cards, and a video in three sections is three of them.
    const of = state.grouped ? 'shown' : 'in this listing';
    pos.textContent = `${(at + 1).toLocaleString()} of ${list.length.toLocaleString()} ${of}`;
  } else if (adrift) {
    pos.textContent = `filtered out · ${list.length.toLocaleString()} still listed`;
  } else {
    pos.textContent = '';
  }
}

/**
 * The player opens on the same 10-segment preview the thumbnail shows, just
 * bigger — so you can tell what a video is before committing to watching it.
 * Clicking the picture starts the real thing.
 *
 * The native controls stay hidden until then. They would be scrubbing a
 * preview rather than a playthrough, and their play button would be
 * indistinguishable from the seeking this does to render each segment.
 */
/**
 * `mode` is which of the two previews owns the stage: 'live' seeks and plays the
 * video itself, 'strip' paints a picture over it and the video must be still.
 * Nothing may play while it is 'strip' -- that is a playing video behind a
 * photograph, which is neither of the two things the stage is meant to show.
 */
const preview = { timer: null, index: 0, count: 10, onMeta: null, onPlay: null, mode: null };

/**
 * Whether the ten segments are still cycling.
 *
 * Asked of the timer that cycles them. It used to be asked of whether a play
 * button was hidden, which worked only for as long as there was a button --
 * and the button was standing in for this all along.
 */
const previewing = () => preview.timer !== null;

/**
 * Hides the strip and gives the stage back to the video.
 *
 * One or the other has the stage, never both: the strip is up and the video is
 * not on screen, or the video is and the strip is gone. Everything that takes
 * the stage for the strip goes through startStripPreview, and everything that
 * gives it back goes through here.
 */
function hidePlayerStrip() {
  const player = $('#player');
  if (player) player.style.visibility = '';
  const strip = $('#playerStrip');
  if (!strip) return;
  strip.hidden = true;
  strip.style.backgroundImage = '';
  strip.style.clipPath = '';
}

/**
 * Puts frame `index` of a strip on the player's stage, at the frame's own shape.
 *
 * The grid's tiles are 16:9 boxes and the strip fills them exactly, which is why
 * `applySprite` can size the sprite in percentages. The stage is not: it is
 * whatever the window leaves between the title and the footer, and the <video>
 * on it letterboxes itself with `object-fit: contain`. Filling the stage the
 * same way stretched every frame to that shape, so the preview and the
 * playthrough showed one picture at two proportions.
 *
 * So the tile is fitted and centred in pixels here, which is what `contain`
 * would do to it. Measured on each paint: the window can be resized mid-preview.
 */
function paintStripFrame(strip, index, frames) {
  const box = strip.getBoundingClientRect();
  // The shape the builder cut them at, by the arithmetic in strips.js.
  const tileW = Math.max(120, Math.min(640, Number(state.config.tileWidth) || 320));
  const tileH = 2 * Math.round((tileW * 9 / 16) / 2);
  const aspect = tileH > 0 ? tileW / tileH : 16 / 9;

  if (!(box.width > 0) || !(box.height > 0)) {
    // Not laid out yet. Fill it, as this used to, rather than paint nothing.
    strip.style.backgroundSize = `${frames * 100}% 100%`;
    strip.style.backgroundPosition = frames > 1
      ? `${(index / (frames - 1)) * 100}% center`
      : '0% center';
    strip.style.clipPath = '';
    return;
  }

  let w = box.width;
  let h = w / aspect;
  if (h > box.height) { h = box.height; w = h * aspect; }

  const x = (box.width - w) / 2;
  const y = (box.height - h) / 2;
  strip.style.backgroundSize = `${frames * w}px ${h}px`;
  strip.style.backgroundPosition = `${x - index * w}px ${y}px`;
  // The image is ten frames wide and the box is the whole stage, so fitting one
  // frame into the middle of it leaves the frames AFTER it sitting in the margin
  // to the right -- three or four small pictures along the top of a wide window,
  // over a video playing behind them. Cropped to the one frame.
  strip.style.clipPath = x > 0.5 || y > 0.5
    ? `inset(${y}px ${box.width - w - x}px ${box.height - h - y}px ${x}px)`
    : '';
}

/**
 * The preview as a strip of frames rather than ten seeks.
 *
 * Resolves true if it took over the stage. False means there was no strip to
 * show -- a file whose frames have not been built yet, or a build that failed
 * -- and the caller falls back to seeking the video.
 */
async function startStripPreview(file) {
  const strip = $('#playerStrip');
  if (!strip) return false;

  // Watching a file is consent enough to build its frames: the strip is read
  // over HTTPS and downloads nothing, so there is no placeholder to protect.
  state.cloudOptIn.add(file.path);
  // A refusal recorded before consent says nothing about this request.
  state.failed.delete(file.path);

  const entry = await loadSprite(file.path, null);
  // A slow build can outlive the modal, or land after the next video opened.
  if (!entry || !state.playing || state.playing.path !== file.path) return false;
  // Clicking the picture during the build turns this into a real playthrough.
  // Taking the stage back then would pause what somebody chose to watch.
  if (!previewing()) return false;
  // The live preview may have been running while this was built. Take the
  // stage from it rather than leaving two things driving the same badge.
  clearInterval(preview.timer);
  preview.timer = null;
  preview.mode = 'strip';
  // And take its listener off with it. A cloud file reports its duration late
  // -- often after the strip has already landed -- and that late event ran the
  // live show(), which seeks and plays. That was the video playing on behind
  // the picture: the strip owned the stage and something else was still
  // driving the element underneath it.
  if (preview.onMeta) {
    $('#player').removeEventListener('loadedmetadata', preview.onMeta);
    preview.onMeta = null;
  }

  strip.style.backgroundImage = `url("${entry.url}")`;
  strip.hidden = false;

  preview.count = entry.frames;
  preview.index = 0;
  const video = $('#player');
  // Stop it seeking the network behind the strip.
  try { video.pause(); } catch { /* nothing playing yet */ }
  // And take it off the stage. Pausing is not enough: the strip is cropped to
  // the one frame it is showing, so everything the crop does not cover is the
  // video underneath, still there, still the wrong picture. Hidden rather than
  // removed, so it goes on buffering for the click that is coming.
  video.style.visibility = 'hidden';
  // And hold it still. Buffering behind the strip is the point -- the click is
  // meant to be instant -- but nothing may start it playing while a picture is
  // over it, whoever asks and however late.
  preview.onPlay = () => {
    if (preview.mode === 'strip') video.pause();
  };
  video.addEventListener('play', preview.onPlay);
  const duration = Number(video.duration) > 0 ? video.duration : 0;

  const show = (index) => {
    preview.index = index;
    paintStripFrame(strip, index, entry.frames);
    const at = segmentTime(duration || Number(state.meta.get(file.path)?.duration) || 0,
      index, entry.frames);
    $('#playerBadge').textContent = `${index + 1}/${entry.frames}`
      + (at > 0 ? ` · ${fmtDuration(at)}` : '');
  };
  show(0);
  preview.timer = setInterval(
    () => show((preview.index + 1) % entry.frames),
    Number(state.config.dwellMs) || 2000,
  );
  return true;
}

function startPlayerPreview() {
  stopPlayerPreview();
  const player = $('#player');
  preview.count = Math.max(2, Number(state.config.frames) || 10);
  preview.index = 0;
  preview.mode = 'live';   // until a strip arrives and takes the stage

  player.controls = false;
  // A preview is not a playthrough: no bar over it, and the picture itself is
  // the only thing to click.
  hidePlayerBar();
  player.muted = true; // a preview that blares audio is not a preview
  player.loop = false;
  $('#playerBadge').hidden = false;
  // The whole picture is the button, so it should say so on the way past.
  const stage = player.closest('.player-stage');
  if (stage) {
    stage.classList.add('previewing');
    stage.title = 'Click to play from the start';
  }

  const show = (index) => {
    // Nobody is previewing any more -- the picture has been clicked and this is
    // a playthrough. A seek from here would drag it back to a tenth of the way
    // in, which is what "pressing play jumps to the second frame" was.
    if (!previewing()) return;
    // Or the strip took the stage while this was waiting its turn. Seeking and
    // playing now would put a moving video behind a still picture.
    if (preview.mode !== 'live') return;
    preview.index = index;
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    if (duration <= 0) return; // metadata not in yet; the timer retries
    const at = segmentTime(duration, index, preview.count);
    try { player.currentTime = at; } catch { return; }
    const played = player.play();
    if (played && played.catch) played.catch(() => {});
    $('#playerBadge').textContent = `${index + 1}/${preview.count} · ${fmtDuration(at)}`;
  };

  // A cloud file is seeked over the network, and every position of the first
  // pass is a cold range request -- which is the juddering. Show the strip
  // instead; the video keeps loading behind it for when the picture is clicked.
  // A cloud file is seeked over the network, and every position of the first
  // pass is a cold range request -- which is the juddering. The strip fixes it,
  // but building one the first time takes about twelve seconds, so start the
  // live preview now and let the strip take over the moment it arrives. Once
  // built it is cached, and the handover is immediate on every later opening.
  const file = state.playing;
  if (file && file.cloudOnly) startStripPreview(file);

  // The timer goes on first so that `previewing()` is already true by the time
  // either path below calls show() -- both are guarded on it.
  preview.timer = setInterval(
    () => show((preview.index + 1) % preview.count),
    Number(state.config.dwellMs) || 2000,
  );

  // A cloud file can take several seconds to report its duration, which is
  // easily long enough to click the picture first. Held so it can be taken off
  // again: a listener that never fires is never removed by `once`, and one per
  // opening would pile up.
  preview.onMeta = () => show(0);
  player.addEventListener('loadedmetadata', preview.onMeta, { once: true });
  if (player.readyState >= 1) show(0);
}

function stopPlayerPreview() {
  clearInterval(preview.timer);
  preview.timer = null;
  preview.mode = null;
  const player = $('#player');
  if (preview.onMeta) {
    player.removeEventListener('loadedmetadata', preview.onMeta);
    preview.onMeta = null;
  }
  if (preview.onPlay) {
    player.removeEventListener('play', preview.onPlay);
    preview.onPlay = null;
  }
  hidePlayerStrip();
}

// ------------------------------------------------------------ the control bar

/**
 * Our own bar, because the browser's will not say where your pointer is.
 *
 * Chromium's native controls are a closed shadow tree: there is no event, no
 * measurement, no way to ask "which second is under the cursor" -- so a seek
 * bar you can preview has to be one we draw. Everything the native bar did is
 * here: play/pause, scrub, time, volume, mute, fullscreen, and the keys.
 *
 * `shots` is the reason a second pass over the same stretch is instant: every
 * exact frame that renders is captured once and kept for the life of the
 * opening, keyed by the second it came from.
 */
const scrub = {
  video: null,        // the second <video>, which seeks so the first need not
  path: null,         // the file it is pointed at
  strip: null,        // { url, frames } -- the coarse preview, always available
  shots: new Map(),   // second -> object URL of an exact frame already rendered
  want: null,         // the time the pointer is asking for right now
  timer: null,        // rest-before-seek
  idle: null,         // fade the bar out while the video runs
  dragging: false,
  onSeeked: null,
  canCapture: true,   // false once a cross-origin stream has tainted a canvas
};

/** Whether this is a playthrough rather than a preview. */
const watching = () => !$('#playerBar').hidden;

/**
 * True if `video` already holds the bytes for `time`.
 *
 * This is the whole answer to "use the download where there is one". A cloud
 * video is streamed, not downloaded, but the part of it that has come over the
 * wire is exactly what `buffered` describes -- so the stretch you can preview
 * frame-accurately grows as you watch, and the strip covers the rest.
 */
function bufferedHas(video, time) {
  if (!video) return false;
  const ranges = video.buffered;
  for (let i = 0; i < ranges.length; i += 1) {
    // A hair inside each end: seeking to the exact boundary asks for the next
    // byte, which is the round trip this test exists to avoid.
    if (time >= ranges.start(i) + 0.15 && time <= ranges.end(i) - 0.15) return true;
  }
  return false;
}

function playerDuration() {
  const player = $('#player');
  const live = Number(player.duration);
  if (Number.isFinite(live) && live > 0) return live;
  const known = state.playing && state.meta.get(state.playing.path);
  return Number(known && known.duration) || 0;
}

/**
 * Shows the bar and keeps it shown until the video is running and settled.
 *
 * The strip is fetched here rather than on the first hover so the preview is
 * ready before it is wanted -- it is one small image already on disk.
 */
function showPlayerBar() {
  const bar = $('#playerBar');
  if (!bar) return;
  bar.hidden = false;
  barSync();
  drawMarks();
  wakeBar();

  const file = state.playing;
  if (!file) return;
  if (scrub.path !== file.path) releaseBarPreview();
  scrub.path = file.path;
  // Watching a file is consent enough to build its frames, the same rule the
  // stage preview goes by.
  state.cloudOptIn.add(file.path);
  state.failed.delete(file.path);
  loadSprite(file.path, null).then((entry) => {
    if (state.playing && state.playing.path === file.path) scrub.strip = entry;
  }).catch(() => { /* no strip is just no coarse preview */ });
}

function hidePlayerBar() {
  const bar = $('#playerBar');
  if (bar) bar.hidden = true;
  hideHover();
  closeMarkMenu();
  clearTimeout(scrub.idle);
  scrub.idle = null;
  scrub.dragging = false;
  const seek = $('#pbSeek');
  if (seek) seek.classList.remove('dragging');
}

/** Drops the second video and every captured frame. Called when the file changes. */
function releaseBarPreview() {
  clearTimeout(scrub.timer);
  scrub.timer = null;
  scrub.want = null;
  scrub.strip = null;
  scrub.canCapture = true; // the next file may well be one we can read back
  if (scrub.video) {
    if (scrub.onSeeked) scrub.video.removeEventListener('seeked', scrub.onSeeked);
    scrub.video.removeAttribute('src');
    // And forget what it was pointed at, or reopening the same file would find
    // the name still matching and never re-attach the stream it just dropped.
    delete scrub.video.dataset.for;
    scrub.video.load();
  }
  scrub.onSeeked = null;
  for (const url of scrub.shots.values()) URL.revokeObjectURL(url);
  scrub.shots.clear();
  const shot = $('#pbHoverVideo');
  if (shot) shot.hidden = true;
}

/**
 * The bar fades while the video is running, and never while it is not.
 *
 * It sits over the bottom of the picture, so leaving it up permanently would
 * cost a strip of every video. Anything that counts as using it -- moving the
 * pointer over the stage, pausing, dragging -- brings it back and restarts the
 * count.
 */
function wakeBar() {
  const stage = $('#player').closest('.player-stage');
  if (!stage) return;
  stage.classList.remove('bar-idle');
  clearTimeout(scrub.idle);
  scrub.idle = null;
  if (!watching()) return;
  const player = $('#player');
  // Paused, scrubbing, or in the middle of writing a bookmark: all three are
  // the bar being used, and one that faded out from under any of them would
  // take the thing you were using with it.
  if (player.paused || scrub.dragging || !$('#pbMarkMenu').hidden) return;
  scrub.idle = setTimeout(() => {
    const now = $('#player');
    if (watching() && !now.paused && !scrub.dragging && $('#pbMarkMenu').hidden) {
      stage.classList.add('bar-idle');
    }
  }, 2500);
}

/** Times, fill widths, and which of the paired glyphs is drawn. */
function barSync() {
  if (!watching()) return;
  const player = $('#player');
  const duration = playerDuration();
  const at = Number(player.currentTime) || 0;

  $('#pbNow').textContent = fmtDuration(at);
  $('#pbDur').textContent = duration > 0 ? fmtDuration(duration) : '--:--';

  const done = duration > 0 ? Math.min(1, at / duration) : 0;
  $('#pbPlayed').style.width = `${done * 100}%`;
  $('#pbKnob').style.left = `${done * 100}%`;

  // How much of it is here. For a cloud file this is the line that grows as it
  // streams, and it is the same measurement the exact preview is gated on.
  let ahead = 0;
  if (duration > 0) {
    for (let i = 0; i < player.buffered.length; i += 1) {
      if (player.buffered.start(i) <= at && player.buffered.end(i) >= at) {
        ahead = player.buffered.end(i) / duration;
        break;
      }
    }
  }
  $('#pbBuffered').style.width = `${Math.min(1, Math.max(done, ahead)) * 100}%`;

  const seek = $('#pbSeek');
  seek.setAttribute('aria-valuemax', String(Math.round(duration)));
  seek.setAttribute('aria-valuenow', String(Math.round(at)));
  seek.setAttribute('aria-valuetext', fmtDuration(at));

  const stage = player.closest('.player-stage');
  if (stage) stage.classList.toggle('paused', player.paused);
  $('#pbPlay').setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
  $('#playerBar').classList.toggle('muted', player.muted || player.volume === 0);
  const vol = $('#pbVol');
  if (document.activeElement !== vol) {
    vol.value = String(Math.round((player.muted ? 0 : player.volume) * 100));
  }
}

/** Where on the track a pointer sits, as a fraction of the running time. */
function seekFractionAt(clientX) {
  const box = $('#pbSeek').getBoundingClientRect();
  if (!(box.width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
}

function hideHover() {
  const hover = $('#pbHover');
  if (hover) hover.hidden = true;
  clearTimeout(scrub.timer);
  scrub.timer = null;
  scrub.want = null;
}

/**
 * Paints the coarse frame -- the one from the cached strip -- for a time.
 *
 * Ten frames across the whole video means each covers a tenth of it, so this
 * says which part you are landing in rather than which moment. It is instant
 * and it works for a file that has never been streamed at all, which is why it
 * is what shows first and what everything falls back to.
 */
function paintHoverStrip(time, duration) {
  const shot = $('#pbHoverShot');
  const entry = scrub.strip;
  if (!entry || !(duration > 0)) {
    shot.style.backgroundImage = '';
    return;
  }
  const frames = Math.max(1, entry.frames);
  // segmentTime puts frame i at duration*(i+1)/frames, so invert that.
  const index = Math.min(frames - 1,
    Math.max(0, Math.round((time * frames) / duration) - 1));
  shot.style.backgroundImage = `url("${entry.url}")`;
  shot.style.backgroundSize = `${frames * 100}% 100%`;
  shot.style.backgroundPosition = frames > 1
    ? `${(index / (frames - 1)) * 100}% center`
    : '0% center';
}

/**
 * Moves the preview to wherever the pointer is and asks for the best frame
 * available there.
 */
function showHoverAt(clientX) {
  const duration = playerDuration();
  const hover = $('#pbHover');
  const seek = $('#pbSeek');
  if (!hover || !(duration > 0)) return;

  const fraction = seekFractionAt(clientX);
  const time = fraction * duration;
  const box = seek.getBoundingClientRect();
  const shotW = $('#pbHoverShot').getBoundingClientRect().width || 168;

  // Centred on the pointer, but never hanging off either end of the track.
  const half = shotW / 2;
  const left = Math.min(box.width - half, Math.max(half, fraction * box.width));
  hover.style.left = `${left}px`;
  hover.style.transform = 'translateX(-50%)';
  hover.hidden = false;
  $('#pbHoverTime').textContent = fmtDuration(time);

  paintHoverStrip(time, duration);
  wantExactFrame(time);
}

/**
 * Upgrades the coarse frame to the real one, where the bytes are already here.
 *
 * Three sources, cheapest first: a frame captured on an earlier pass, the
 * stretch the player has buffered, and -- for a file that is genuinely on this
 * machine -- anywhere at all, since a local seek costs nothing. A cloud video
 * outside its buffer keeps the strip: fetching a fresh range for every hover is
 * the juddering this whole preview exists to avoid.
 */
function wantExactFrame(time) {
  const shot = $('#pbHoverVideo');
  const second = Math.round(time);
  scrub.want = time;

  // A frame rendered earlier is painted as the tile's own picture, over the
  // strip frame paintHoverStrip just put there. The video element is for a
  // frame being fetched now; a still we already hold needs no decoder.
  const had = scrub.shots.get(second);
  if (had) {
    const tile = $('#pbHoverShot');
    tile.style.backgroundImage = `url("${had}")`;
    tile.style.backgroundSize = 'cover';
    tile.style.backgroundPosition = 'center';
    shot.hidden = true;
    clearTimeout(scrub.timer);
    scrub.timer = null;
    return;
  }

  const file = state.playing;
  const player = $('#player');
  const reachable = (file && !file.cloudOnly) || bufferedHas(player, time);
  if (!reachable) {
    shot.hidden = true;
    clearTimeout(scrub.timer);
    scrub.timer = null;
    return;
  }

  // Rest first. Sweeping the pointer across an hour-long video would otherwise
  // ask for a hundred seeks nobody looked at.
  clearTimeout(scrub.timer);
  scrub.timer = setTimeout(() => seekExactFrame(time), 140);
}

function ensureHoverVideo() {
  const shot = $('#pbHoverVideo');
  if (!shot || !state.playing) return null;
  if (scrub.video !== shot) {
    scrub.video = shot;
    shot.muted = true;
    shot.volume = 0;
  }
  const want = `/api/video?path=${encodeURIComponent(state.playing.path)}`;
  if (shot.dataset.for !== state.playing.path) {
    shot.dataset.for = state.playing.path;
    shot.src = want;
  }
  return shot;
}

function seekExactFrame(time) {
  const shot = ensureHoverVideo();
  if (!shot || scrub.want === null) return;
  if (scrub.onSeeked) shot.removeEventListener('seeked', scrub.onSeeked);

  scrub.onSeeked = () => {
    shot.removeEventListener('seeked', scrub.onSeeked);
    scrub.onSeeked = null;
    // The pointer moved on while this was in flight; that frame is not the one
    // being asked about any more.
    if (scrub.want === null || Math.abs(scrub.want - time) > 0.75) return;
    shot.hidden = false;
    captureFrame(shot, Math.round(time));
  };
  shot.addEventListener('seeked', scrub.onSeeked);
  try { shot.currentTime = time; } catch { /* not seekable yet */ }
}

/**
 * Keeps a rendered frame so the second pass over the same stretch is free.
 *
 * Bounded, and oldest-first: scrubbing back and forth across a long video would
 * otherwise accumulate a bitmap per second of it.
 */
function captureFrame(video, second) {
  if (!scrub.canCapture || scrub.shots.has(second) || !(video.videoWidth > 0)) return;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = Math.max(1, Math.round((320 * video.videoHeight) / video.videoWidth));
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob || scrub.shots.has(second)) return;
      // Bounded, oldest first: scrubbing back and forth across a long video
      // would otherwise accumulate a bitmap per second of it.
      if (scrub.shots.size >= 240) {
        const oldest = scrub.shots.keys().next().value;
        URL.revokeObjectURL(scrub.shots.get(oldest));
        scrub.shots.delete(oldest);
      }
      scrub.shots.set(second, URL.createObjectURL(blob));
    }, 'image/jpeg', 0.72);
  } catch {
    // A cloud file is streamed straight from OneDrive, which is another origin,
    // and that taints the canvas for good. Reading frames back is a local-file
    // luxury; the cloud path simply re-seeks, which is what it was doing anyway.
    scrub.canCapture = false;
  }
}

// ---------------------------------------------------------------- bookmarks

/**
 * The icons a bookmark can be given, and the names they answer to.
 *
 * Loaded from public/icons.json rather than written here, so replacing the set
 * is a data change and not a code one. A bookmark stores the icon's NAME --
 * `star`, not the character it is drawn with -- so swapping the artwork
 * restyles every bookmark ever made rather than leaving old ones frozen as
 * whatever was on screen the day they were saved.
 *
 * Search matches the name, the id, and the keywords, so "star" finds Star,
 * Gold star and Sparkle without any of them having to be called the same thing.
 */
const markIcons = { list: [], byId: new Map(), loaded: null };

// Enough to draw a bookmark before the file arrives, or if it never does.
const FALLBACK_ICON = { id: 'star', name: 'Star', glyph: '★', keywords: [] };

function loadMarkIcons() {
  if (markIcons.loaded) return markIcons.loaded;
  markIcons.loaded = fetch('icons.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const list = (data && Array.isArray(data.icons) ? data.icons : [])
        .filter((icon) => icon && icon.id)
        .map((icon) => ({
          id: String(icon.id),
          name: String(icon.name || icon.id),
          glyph: icon.glyph ? String(icon.glyph) : '',
          src: icon.src ? String(icon.src) : '',
          keywords: (Array.isArray(icon.keywords) ? icon.keywords : []).map(String),
        }))
        .map((icon) => ({ ...icon, words: iconWords(icon) }));
      markIcons.list = list.length ? list : [FALLBACK_ICON];
      markIcons.byId = new Map(markIcons.list.map((icon) => [icon.id, icon]));
    })
    .catch(() => {
      markIcons.list = [FALLBACK_ICON];
      markIcons.byId = new Map([[FALLBACK_ICON.id, FALLBACK_ICON]]);
    });
  return markIcons.loaded;
}

/**
 * The icon an id names.
 *
 * An id with no entry still draws: the id itself is used as the character,
 * which is what makes a bookmark saved under an icon that has since been
 * removed a slightly odd-looking pip rather than an invisible one.
 */
function iconFor(id) {
  return markIcons.byId.get(id)
    || { id, name: id, glyph: id, src: '', keywords: [], words: [] };
}

/** Puts an icon's picture inside an element, as an image or as a character. */
function paintIcon(el, icon) {
  el.innerHTML = '';
  if (icon.src) {
    const img = document.createElement('img');
    img.src = icon.src;
    img.alt = icon.name;
    el.appendChild(img);
  } else {
    el.textContent = icon.glyph || icon.id;
  }
}

/** Everything an icon can be found by, as separate words: name, id, keywords. */
function iconWords(icon) {
  return `${icon.name} ${icon.id} ${(icon.keywords || []).join(' ')}`
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The icons matching what has been typed, the closest first.
 *
 * Matched at the START of a word rather than anywhere inside one. Anywhere
 * inside is what makes "art" offer Start and Heart, which is noise — where
 * word-start means half a word finds what you are reaching for as you type it.
 *
 * A word that matches something exactly outranks one that merely begins it, so
 * "star" puts Star, Star outline and Gold star above Start. Every typed word
 * has to match something, so a second word narrows rather than widens.
 */
function findIcons(query) {
  const wanted = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!wanted.length) return markIcons.list;

  const hits = [];
  for (const icon of markIcons.list) {
    const have = icon.words || iconWords(icon);
    if (!wanted.every((word) => have.some((had) => had.startsWith(word)))) continue;
    hits.push({ icon, exact: wanted.filter((word) => have.includes(word)).length });
  }
  // Sort is stable, so within a rank the file's own order is kept -- which is
  // the order whoever wrote the icon set chose.
  return hits.sort((a, b) => b.exact - a.exact).map((hit) => hit.icon);
}

/** The bookmarks on the open video, earliest first. */
function playerMarks() {
  const file = state.playing;
  return (file && Array.isArray(file.marks) ? file.marks : []).slice()
    .sort((a, b) => a.t - b.t);
}

/**
 * Draws a pip per bookmark on the track.
 *
 * Rebuilt rather than patched: there are a handful of these, the list arrives
 * whole from the store, and a diff would be more code than the thing it saved.
 */
function drawMarks() {
  const host = $('#pbMarks');
  if (!host) return;
  host.innerHTML = '';
  const duration = playerDuration();
  if (!(duration > 0)) return;

  for (const mark of playerMarks()) {
    const icon = iconFor(mark.icon);
    const pip = document.createElement('button');
    pip.type = 'button';
    pip.className = 'pb-mark';
    pip.style.left = `${Math.min(100, Math.max(0, (mark.t / duration) * 100))}%`;
    paintIcon(pip, icon);
    pip.dataset.at = String(mark.t);
    pip.title = `${icon.name} at ${fmtDuration(mark.t)}  (right-click to change)`;
    pip.setAttribute('aria-label', pip.title);
    host.appendChild(pip);
  }
}

/** The bookmark at a second, if there is one. */
function markAt(seconds) {
  return playerMarks().find((m) => Math.abs(m.t - seconds) < 0.06) || null;
}

/**
 * Opens the picker over a moment.
 *
 * The same panel both bookmarks a new moment and edits one that is already
 * there — an existing mark fills in its icon and note and grows a Remove
 * button, so there is one thing to learn rather than two.
 */
function openMarkMenu(seconds, clientX) {
  const menu = $('#pbMarkMenu');
  if (!menu || !(playerDuration() > 0)) return;
  hideHover();

  const existing = markAt(seconds);
  const at = existing ? existing.t : Math.round(seconds * 10) / 10;
  menu.dataset.at = String(at);

  $('#pbMarkTime').textContent = fmtDuration(at);
  $('#pbMarkWhat').textContent = existing ? 'Change this bookmark' : 'Bookmark this moment';
  $('#pbMarkDrop').hidden = !existing;
  // A fresh search every time it opens: the last thing you looked for is rarely
  // the next thing, and a box that opens holding an old word looks empty of
  // icons rather than filtered.
  $('#pbMarkFind').value = '';
  drawIconChoices();
  // Usually already in hand -- the fetch runs at startup and the promise is
  // kept -- but on the very first opening of a cold session this is what fills
  // the grid a tick later rather than leaving it empty.
  loadMarkIcons().then(() => { if (!$('#pbMarkMenu').hidden) drawIconChoices(); });

  // Held inside the track, the same way the hover preview is.
  const box = $('#pbSeek').getBoundingClientRect();
  const half = menu.offsetWidth ? menu.offsetWidth / 2 : 118;
  const wanted = clientX === undefined ? (at / playerDuration()) * box.width : clientX - box.left;
  menu.style.left = `${Math.min(box.width - half, Math.max(half, wanted))}px`;
  menu.style.transform = 'translateX(-50%)';
  menu.hidden = false;
  wakeBar();
  // The search is where a choice starts, so the cursor is already in it.
  $('#pbMarkFind').focus();
}

/**
 * Fills the grid with whatever the search box leaves.
 *
 * Rebuilt on every keystroke. The set is small enough that the honest thing is
 * cheaper than anything clever, and it keeps one path for both "opened fresh"
 * and "narrowed to two".
 */
function drawIconChoices() {
  const host = $('#pbMarkIcons');
  const menu = $('#pbMarkMenu');
  if (!host || !menu) return;

  const at = Number(menu.dataset.at);
  const chosen = markAt(at);
  const found = findIcons($('#pbMarkFind').value);

  host.innerHTML = '';
  for (const icon of found) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = icon.name;
    btn.setAttribute('aria-label', icon.name);
    paintIcon(btn, icon);
    if (chosen && chosen.icon === icon.id) btn.classList.add('on');
    btn.addEventListener('click', () => saveMark(at, icon.id));
    host.appendChild(btn);
  }
  $('#pbMarkNone').hidden = found.length > 0;
}

function closeMarkMenu() {
  const menu = $('#pbMarkMenu');
  if (menu) menu.hidden = true;
}

/** Writes one bookmark and closes up. */
function saveMark(at, icon) {
  const file = state.playing;
  if (!file) return;
  editRecords([file.path], { setMark: { t: at, icon: icon || FALLBACK_ICON.id } });
  closeMarkMenu();
}

function removeMark(at) {
  const file = state.playing;
  if (!file) return;
  editRecords([file.path], { removeMark: at });
  closeMarkMenu();
}

/** Jumps to a bookmark and keeps playing if it was playing. */
function goToMark(at) {
  const player = $('#player');
  try { player.currentTime = at; } catch { /* not seekable yet */ }
  barSync();
  wakeBar();
}

function togglePlayback() {
  const player = $('#player');
  if (player.paused) {
    const played = player.play();
    if (played && played.catch) played.catch(() => {});
  } else {
    player.pause();
  }
  wakeBar();
}

function seekBy(seconds) {
  const player = $('#player');
  const duration = playerDuration();
  if (!(duration > 0)) return;
  const next = Math.min(duration - 0.05, Math.max(0, (Number(player.currentTime) || 0) + seconds));
  try { player.currentTime = next; } catch { /* not seekable yet */ }
  barSync();
  wakeBar();
}

function toggleFullscreen() {
  const stage = $('#player').closest('.player-stage');
  if (!stage) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen().catch(() => {});
}

/**
 * A click on the picture turns the preview into a real playthrough: the bar
 * appears, from the top, and audible only if the session has sound. A muted
 * playthrough is still the whole video rather than ten sampled seconds, and the
 * bar is there to unmute if that is what you meant.
 */
function beginPlayback() {
  stopPlayerPreview();
  const player = $('#player');
  $('#playerBadge').hidden = true;
  const stage = player.closest('.player-stage');
  if (stage) {
    stage.classList.remove('previewing');
    stage.title = '';
  }
  // The native bar stays off for good: it cannot be asked where the pointer is,
  // and two sets of controls over one video is worse than either.
  player.controls = false;
  player.muted = !soundOn;
  player.volume = masterVolume();
  try { player.currentTime = 0; } catch { /* not seekable yet; it will start at 0 anyway */ }
  const played = player.play();
  if (played && played.catch) played.catch(() => {});
  showPlayerBar();
}

function closePlayer() {
  $('#player').onloadedmetadata = null;
  releasePlayer();
  $('#playerActions').innerHTML = '';
  state.playing = null;
  state.playingAnchor = null;
  $('#playerModal').hidden = true;
}

// ---------------------------------------------------------------- rendering

function render() {
  applyFilterSort();
  const grid = $('#grid');
  // Detach the live player and drop observations on nodes we're discarding.
  stopLive();
  spriteObserver.disconnect();
  // The cards these were waiting for are about to stop existing. What is
  // already in flight lands in the cache and costs the new grid nothing.
  posters.queue.length = 0;
  posters.queued.clear();
  grid.innerHTML = '';

  renderBreadcrumb();
  // Asked before the tiles are drawn, so they show this folder's state rather
  // than the last one's numbers. Does nothing unless the folder or the filter
  // has actually changed.
  const counting = folderCountsStale();
  renderFolders();
  if (counting) fetchFolderCounts();

  state.rendered = 0;
  $('#filesSection').hidden = state.files.length === 0;
  appendPage();

  updateSelectionBar();
  renderEmptyState();
  updateStatusLine();
}

/**
 * Renders the whole listing. There is no paging: every video the filters leave
 * gets a card and a picture, however many that is, because a library you have
 * to keep pressing "load more" to see is a library you cannot scan.
 *
 * The append shape is kept -- start at what is already there -- so a listing
 * that grows underneath can still be topped up without rebuilding the grid.
 */
function appendPage() {
  const grid = $('#grid');
  const source = pageSource();
  const start = state.rendered;
  const end = source.length;
  const batch = [];

  for (let index = start; index < end; index += 1) {
    if (state.grouped) {
      const slot = state.slots[index];
      // A heading costs a slot of the page, so a section of one video does not
      // arrive with the next twenty-three crammed under it.
      if (slot.head) { grid.appendChild(buildGroupHead(slot.head)); continue; }
      grid.appendChild(buildCard(slot.file, slot.at, slot.group, slot.seq));
      batch.push(slot.file);
      continue;
    }
    const file = state.view[index];
    grid.appendChild(buildCard(file, index));
    batch.push(file);
  }
  state.rendered = end;

  syncFileCount();
  fetchMetaFor(batch);
  updateStatusLine();
}

/**
 * One performer's heading: the heart that marks them, their name, and how many
 * of the current listing are theirs.
 *
 * The heart writes to the library rather than to any video, so it takes effect
 * everywhere at once — including the order of these very sections, which is why
 * pressing it re-renders rather than just repainting itself.
 */
function buildGroupHead(group) {
  const head = document.createElement('div');
  head.className = 'group-head' + (group.unnamed ? ' group-unnamed' : '');
  head.dataset.group = group.key;

  if (!group.unnamed && !group.dupe) {
    const marked = isFavouriteModel(group.name);
    const heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'group-fav' + (marked ? ' on' : '');
    heart.textContent = marked ? '\u2665' : '\u2661';
    heart.title = marked
      ? `${group.name} is a favourite — click to unmark`
      : `Mark ${group.name} a favourite`;
    heart.setAttribute('aria-label', heart.title);
    heart.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const on = await toggleFavouriteModel(group.name);
      toast(on ? `${group.name} marked a favourite` : `${group.name} unmarked`, 'ok');
      // Favourites lead the sections, so the page is rebuilt to put this one
      // where it now belongs rather than just recolouring the heart.
      render();
    });
    head.appendChild(heart);
  }

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.unnamed ? (group.label || 'Nobody named') : group.name;
  head.appendChild(name);

  if (!group.unnamed && !group.dupe) {
    const score = document.createElement('span');
    score.className = 'group-score';
    score.textContent = group.points.toLocaleString();
    score.title = 'A five-star video is worth a thousand points, a four-star a hundred,'
      + ' a three-star ten — counting only what is in this listing.';
    head.appendChild(score);
  }

  // A duplicate section already says how many copies it holds in its name, so
  // it gets what deleting one would give back instead.
  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = group.dupe
    ? (group.recover ? `${fmtBytes(group.recover)} could go` : 'nothing to choose between here')
    : `${group.files.length} video${group.files.length === 1 ? '' : 's'}`;
  if (group.dupe) {
    count.title = group.recover
      ? 'Keeping the largest copy and deleting the rest would recover this'
      : 'The other copies are somewhere else \u2014 flatten the subfolders, or '
        + 'clear the filters, to bring them together';
  }
  head.appendChild(count);

  // How much of this performer the face index has actually read. Only shown
  // once something has been, so the row stays quiet on a library with the
  // feature switched off.
  const profiled = group.files.reduce((n, f) => n + (f.profiled ? 1 : 0), 0);
  if (profiled) {
    const read = document.createElement('span');
    read.className = 'group-profiled' + (profiled === group.files.length ? ' all' : '');
    read.textContent = `${profiled} profiled`;
    read.title = profiled === group.files.length
      ? `All ${group.files.length} have been read for faces`
      : `${profiled} of ${group.files.length} read for faces so far`;
    head.appendChild(read);
  }

  if (!group.unnamed) {
    // Straight to the flat listing for this one performer, the way a pill on a
    // card behaves: the grouped view is for finding someone, not for working
    // through them.
    //
    // Grouped by suggestion it lands somewhere else on purpose -- what is
    // actually credited to her, rather than what looks like her -- and there is
    // no filter for the latter to send it to. So it says which, instead of
    // reading as "only this section" and quietly showing a different set.
    if (group.dupe) return head;   // no performer to filter down to
    const guessed = state.grouped === 'suggested';
    const only = document.createElement('button');
    only.type = 'button';
    only.className = 'linkish group-only';
    only.textContent = guessed ? 'her credited videos' : 'only this one';
    if (guessed) {
      only.title = `Everything credited to ${group.name}, which is not the same `
        + 'set as the videos that look like her';
    }
    only.addEventListener('click', (ev) => {
      ev.stopPropagation();
      filterByLabel('models', group.name);
    });
    head.appendChild(only);
  }

  return head;
}

/** Loaded of matching, or matching of scanned — whichever the listing is short of. */
function syncFileCount() {
  // Grouped, the honest number is cards rather than videos: the same video is on
  // screen once per performer in it, and "12 of 9" would look like a bug.
  const total = slotCards();
  const loaded = state.grouped
    ? state.slots.slice(0, state.rendered).filter((s) => s.file).length
    : state.rendered;
  $('#fileCount').textContent = loaded < total
    ? `(${loaded} of ${total})`
    : `(${total}${total === state.files.length ? '' : ' of ' + state.files.length})`;
}

function updateStatusLine() {
  const bits = [];
  if (state.files.length) {
    const shown = state.view.length === state.files.length
      ? `${state.files.length} video${state.files.length === 1 ? '' : 's'} here`
      : `${state.view.length} of ${state.files.length} shown`;
    bits.push(state.rendered < state.view.length ? `${shown} · ${state.rendered} loaded` : shown);
  }
  if (!state.config.recursive && state.totalBelow > state.files.length) {
    bits.push(`${state.totalBelow.toLocaleString()} below`);
  }
  setStatus(bits.join('  ·  '));
}

/**
 * Probes every file the listing holds. Cloud files are skipped server-side so
 * nothing downloads.
 *
 * In chunks, because /api/meta answers for 250 paths a call and drops the rest
 * on the floor -- which, now that a listing arrives whole rather than 24 at a
 * time, would leave every video past the 250th without a duration forever.
 */
const META_CHUNK = 250;

async function fetchMetaFor(files) {
  // Cloud files included: the server answers from cache when it has an entry
  // and returns {skipped} otherwise, so this never causes a download.
  const paths = files
    .filter((f) => !state.metaAsked.has(f.path))
    .map((f) => f.path);
  if (!paths.length) return;

  paths.forEach((p) => state.metaAsked.add(p));

  // One chunk at a time: each is already 250 probes against a server that runs
  // a handful at once, and the grid fills top-down rather than all at the end.
  for (let at = 0; at < paths.length; at += META_CHUNK) {
    const chunk = paths.slice(at, at + META_CHUNK);
    try {
      const { meta } = await api('/api/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: chunk }),
      });
      for (const [filePath, info] of Object.entries(meta)) {
        if (!info || info.error || info.skipped) continue;
        state.meta.set(filePath, info);
        updateCardMeta(filePath);
      }
    } catch (err) {
      // This chunk and everything behind it went unanswered, so let a later
      // render ask again rather than leaving them marked as already asked.
      paths.slice(at).forEach((p) => state.metaAsked.delete(p));
      toast('Metadata failed: ' + err.message, 'err');
      return;
    }
  }
}

/** Fills in duration/resolution once a probe lands, without a full re-render. */
function updateCardMeta(filePath) {
  const file = state.files.find((f) => f.path === filePath);
  if (!file) return;
  const info = state.meta.get(filePath) || {};

  // Every copy: one probe answers for the video, and grouped it is on screen
  // once per performer in it.
  for (const card of cardsFor(filePath)) {
    const line = card.querySelector('.meta-line');
    if (line) line.innerHTML = metaLineHtml(file, info);

    const badge = card.querySelector('.badge-duration');
    if (badge && info.duration) badge.textContent = fmtDuration(info.duration);

    const preview = card.querySelector('.preview');
    if (preview && info.duration) preview.dataset.duration = String(info.duration);
  }
}

function renderEmptyState() {
  const empty = $('#empty');
  if (state.files.length || state.folders.length) { empty.hidden = true; return; }
  empty.hidden = false;
  empty.innerHTML = '<p class="empty-title">Nothing here.</p><p>No videos and no subfolders in this folder.</p>';
}

function buildCard(file, index, group = null, seq = null) {
  const card = document.createElement('article');
  card.className = 'card' + (state.selected.has(file.path) ? ' selected' : '');
  card.dataset.path = file.path;

  // ---- preview -------------------------------------------------------
  const info = state.meta.get(file.path) || {};
  const preview = document.createElement('div');
  preview.className = 'preview' + (file.cloudOnly ? ' cloud' : '');
  preview.dataset.path = file.path;
  preview.dataset.duration = String(info.duration || 0);
  // No title attribute: a browser tooltip covers the very preview you hovered to
  // watch. The path is still on the folder line, and the controls explain
  // themselves through their own tooltips.

  const ticks = document.createElement('div');
  ticks.className = 'ticks';
  preview.appendChild(ticks);

  const selectMark = document.createElement('div');
  selectMark.className = 'select-mark';
  selectMark.textContent = '✓';
  preview.appendChild(selectMark);

  const durationBadge = document.createElement('span');
  durationBadge.className = 'badge badge-duration';
  durationBadge.textContent = info.duration ? fmtDuration(info.duration) : fmtBytes(file.size);
  preview.appendChild(durationBadge);

  if (file.cloudOnly) {
    const cloudMark = document.createElement('div');
    cloudMark.className = 'cloud-mark';
    cloudMark.innerHTML = '<span class="cloud-ico">☁</span>';
    const label = document.createElement('span');
    label.className = 'cloud-label';
    label.textContent = 'cloud-only';
    cloudMark.appendChild(label);
    preview.appendChild(cloudMark);
  }

  if (file.duplicate) {
    // The count, not just a mark: "3 copies" says how much of a decision this
    // is before anything has been opened.
    const dupeBadge = document.createElement('span');
    dupeBadge.className = 'badge badge-dupe';
    const kinds = file.dupeKinds || {};
    const how = kinds.both ? '' : (kinds.sound ? ' sound' : ' video');
    dupeBadge.textContent = `${file.copies} copies${how}`;
    dupeBadge.classList.toggle('one-signal', !kinds.both);
    dupeBadge.title = (kinds.both
      ? 'The soundtrack and the picture both match another video here.'
      : kinds.sound
        ? 'The soundtrack matches another video here, but the picture does not '
          + '\u2014 worth an eye.'
        : 'The picture matches another video here, but the soundtrack does not '
          + '\u2014 worth an eye.')
      + ' Group by duplicate to see them together.';
    preview.appendChild(dupeBadge);
  }

  const frameBadge = document.createElement('span');
  frameBadge.className = 'badge badge-frame';
  preview.appendChild(frameBadge);

  const playBtn = document.createElement('button');
  playBtn.className = 'play-center';
  playBtn.type = 'button';
  playBtn.textContent = '▶';
  playBtn.title = 'View in player';
  playBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    playFile(file, seq);
  });
  preview.appendChild(playBtn);

  preview.appendChild(buildQuickbar(file, card));

  /**
   * The thumbnail plays; the ring selects.
   *
   * Watching something is the common case, so a bare click does that. Once a
   * selection exists you are plainly in the middle of picking things, and a
   * click adds to it rather than interrupting with a player — so building a
   * selection stays a one-click-per-item job after the first.
   *
   * The first item therefore has to come from the ring, which is the only
   * unambiguous way to say "select" rather than "play".
   */
  preview.addEventListener('click', (ev) => {
    if (ev.target.closest('.quickbar') || ev.target.closest('.play-center')) return;
    if (ev.target.closest('.select-mark')) return; // the ring handles itself

    const selecting = state.selected.size > 0 || ev.shiftKey;
    if (!selecting) { playFile(file, seq); return; }
    if (ev.shiftKey) ev.preventDefault(); // stop shift-click text selection
    toggleSelect(file.path, index, ev.shiftKey, group);
  });

  selectMark.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    toggleSelect(file.path, index, ev.shiftKey, group);
  });
  selectMark.title = 'Select';

  attachHover(preview, file);
  // Cloud tiles are asked for too: the server serves an already-cached poster
  // and answers 409 when there is none, so nothing gets downloaded either way.
  queuePoster(preview);
  spriteObserver.observe(preview);
  card.appendChild(preview);

  // ---- details below the preview -------------------------------------
  const details = document.createElement('div');
  details.className = 'details';

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.name;
  details.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  meta.innerHTML = metaLineHtml(file, info);
  details.appendChild(meta);

  details.appendChild(buildRecordRow(file));

  details.appendChild(buildFolderLine(file));

  card.appendChild(details);
  attachDrag(card, file, index);
  return card;
}

/**
 * Date, subfolder, and — pushed to the right — a link to wherever this video is
 * catalogued, when the record carries one. Opening it is the point of storing
 * it, so it is an anchor rather than text: the native shell hands target=_blank
 * to the system browser.
 */
function buildFolderLine(file) {
  const line = document.createElement('div');
  line.className = 'folder-line';

  const where = document.createElement('span');
  where.className = 'folder-where';
  where.title = file.folder;

  // The same date the sort uses, or a list ordered by date would look wrong on
  // screen. Where the two differ, the tooltip gives both — the file's own date
  // is a fact about the file and worth not hiding.
  const when = document.createElement('span');
  when.textContent = fmtDate(touchedAt(file));
  const edited = (Number(file.updated) || 0) > (Number(file.mtimeMs) || 0);
  when.title = edited
    ? `Labelled ${fmtDate(file.updated)} · file modified ${fmtDate(file.mtimeMs)}`
    : `File modified ${fmtDate(file.mtimeMs)}`;
  if (edited) when.className = 'when-labelled';
  where.appendChild(when);
  where.appendChild(document.createTextNode('  •  '));

  // The folder is a way of getting there, not merely a note of where this came
  // from — most useful with the subfolders flattened, where the listing is the
  // only place that name appears. Clicking it scans that folder, exactly as
  // clicking its tile would. Nothing to go to when the file is already here.
  if (file.relFolder === '.') {
    where.appendChild(document.createTextNode('this folder'));
  } else {
    const jump = document.createElement('a');
    jump.className = 'folder-jump';
    jump.href = '#';
    jump.textContent = file.relFolder;
    jump.title = `Open ${file.folder}`;
    jump.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();   // a card click plays the video; this one must not
      navigateTo(file.folder);
    });
    where.appendChild(jump);
  }

  line.appendChild(where);

  if (file.url) {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = file.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = sourceLabel(file.url);
    link.title = file.url;
    // A card click plays the video; this one must not.
    link.addEventListener('click', (ev) => ev.stopPropagation());
    line.appendChild(link);
  }

  return line;
}

/** The host, without the www, which is all the room there is for it. */
function sourceLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') + ' \u2197';
  } catch {
    return 'source \u2197';
  }
}

/** Size and date come from the cheap scan; the rest waits on a probe. */
function metaLineHtml(file, info) {
  const bits = [];
  if (info.duration) bits.push(`<b>${fmtDuration(info.duration)}</b>`);
  if (info.width) bits.push(`${info.width}×${info.height}`);
  if (info.fps) bits.push(`${info.fps} fps`);
  bits.push(fmtBytes(file.size));
  const rate = fmtBitrate(info.bitrate);
  if (rate) bits.push(rate);
  if (info.codec) bits.push(info.codec);
  if (file.cloudOnly) bits.push('<span class="cloud-tag">☁ not downloaded</span>');
  else if (!info.duration) bits.push('<span class="pending">reading…</span>');
  return bits.join('<span class="sep">·</span>');
}

/**
 * The single definition of a file's actions, shared by the hover bar and the
 * player overlay. In the player, destructive ops release the stream first — not
 * because Windows requires it (libuv opens with FILE_SHARE_DELETE, so renames
 * and deletes succeed regardless) but so playback stops instead of continuing
 * from a file that has just been recycled or moved.
 */
function actionsFor(file, { card = null, inPlayer = false } = {}) {
  const cardFor = () => card || document.querySelector(`.card[data-path="${CSS.escape(file.path)}"]`);

  return [
    ...(file.cloudOnly ? [{
      icon: '☁',
      title: `Fetch preview — downloads ${fmtBytes(file.size)} from OneDrive`,
      run: () => optInCloud(file, cardFor()),
    }] : []),
    // Card-only: the player footer carries the rating and tag row itself, so
    // this would be a second way to reach what is already sitting next to it.
    ...(inPlayer ? [] : [
      {
        icon: '⌗',
        title: 'Tags',
        run: () => openTagDialog([state.files.find((f) => f.path === file.path) || file]),
      },
    ]),
    {
      icon: '✎',
      title: 'Rename',
      run: () => (inPlayer ? renameFromPlayer(file) : startRename(file, cardFor())),
    },
    {
      icon: '➜',
      title: 'Move to…',
      run: () => pickFolder('Move to folder', async (dest) => {
        if (inPlayer) releasePlayer();
        const results = await doAction('move', [file.path], { dest });
        if (inPlayer && results.some((r) => r.ok)) closePlayer();
        else if (inPlayer) reopenPlayer(file);
      }),
    },
    {
      icon: '🗑',
      title: 'Delete (Recycle Bin)',
      danger: true,
      run: async () => {
        if (inPlayer) releasePlayer();
        const deleted = await confirmDelete([file.path]);
        if (inPlayer && deleted) closePlayer();
        else if (inPlayer) reopenPlayer(file);
      },
    },
  ];
}

function buildQuickbar(file, card) {
  const bar = document.createElement('div');
  bar.className = 'quickbar';

  for (const action of actionsFor(file, { card })) {
    const btn = document.createElement('button');
    btn.className = 'qbtn' + (action.danger ? ' danger' : '');
    btn.textContent = action.icon;
    btn.title = action.title;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      action.run();
    });
    bar.appendChild(btn);
  }
  return bar;
}

/**
 * Explicit, per-file consent to build a preview for a cloud file.
 *
 * This used to hydrate the placeholder -- hence the warning it used to show.
 * It no longer does: the frames are seeked over HTTPS, the poster is the one
 * OneDrive already holds, and the details are ffprobed over the same URL. What
 * is being consented to now is the network traffic, not a download.
 */
async function optInCloud(file, card) {
  if (!window.confirm(
    `"${file.name}" is not downloaded.\n\n`
    + `Its preview will be built by reading a few frames straight from OneDrive `
    + `(${fmtBytes(file.size)} stays in the cloud — nothing is downloaded).\n\n`
    + `It takes a few seconds. Continue?`,
  )) return;

  state.cloudOptIn.add(file.path);
  const preview = card.querySelector('.preview');
  if (preview) preview.classList.add('loading');

  // NOT allowCloud: that flag means "build one locally", which is the thing
  // that downloads. Without it the poster route hands back OneDrive's own
  // thumbnail instead, for about 16KB.
  await loadThumb(file.path, preview);

  try {
    const { meta } = await api('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [file.path], allowCloud: true }),
    });
    const info = meta[file.path];
    if (info && !info.error) {
      state.meta.set(file.path, info);
      updateCardMeta(file.path);
    }
  } catch (err) {
    toast(err.message, 'err');
  }

  const mark = card.querySelector('.cloud-mark');
  if (mark) mark.remove();
  if (preview) preview.classList.remove('cloud');
  // Deliberately not "Downloaded": it is still a cloud file, and saying
  // otherwise is how somebody ends up believing their library is local.
  toast('Preview ready — still in the cloud', 'ok');
}


function startRename(file, card) {
  const nameEl = card.querySelector('.file-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.value = file.name;
  nameEl.replaceWith(input);
  input.focus();
  const dot = file.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : file.name.length);

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (commit && value && value !== file.name) {
      await doAction('rename', [file.path], { newName: value });
    }
    render();
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') finish(true);
    if (ev.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------ drag and drop

const DRAG_TYPE = 'application/x-video-explorer-paths';
let dragGhost = null;

/** A tally chip used as the drag image, so 10 files don't drag 10 thumbnails. */
function makeDragGhost(count) {
  removeDragGhost();
  dragGhost = document.createElement('div');
  dragGhost.className = 'drag-ghost';
  dragGhost.textContent = count === 1 ? '1 video' : `${count} videos`;
  document.body.appendChild(dragGhost);
  return dragGhost;
}

function removeDragGhost() {
  if (dragGhost && dragGhost.parentNode) dragGhost.parentNode.removeChild(dragGhost);
  dragGhost = null;
}

function attachDrag(card, file, index) {
  card.draggable = true;

  card.addEventListener('dragstart', (ev) => {
    // Dragging an unselected tile makes it the selection, so what moves is
    // always exactly what's highlighted.
    if (!state.selected.has(file.path)) {
      state.selected.clear();
      state.selected.add(file.path);
      state.lastClickedIndex = index;
      syncSelectionUI();
    }

    const paths = selectedPaths();
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    ev.dataTransfer.setData('text/plain', paths.join('\n'));
    ev.dataTransfer.setDragImage(makeDragGhost(paths.length), 18, 16);
    document.body.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    document.body.classList.remove('dragging');
    removeDragGhost();
    document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  });
}

function readDragPaths(ev) {
  try {
    const raw = ev.dataTransfer.getData(DRAG_TYPE);
    const paths = raw ? JSON.parse(raw) : [];
    return Array.isArray(paths) ? paths : [];
  } catch {
    return [];
  }
}

/** Turns any element into a folder drop zone. Ctrl held = copy, else move. */
function attachDropTarget(el, destPath, label) {
  el.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
    el.classList.add('drop-target');
  });

  el.addEventListener('dragleave', (ev) => {
    // dragleave also fires moving between children — ignore those.
    if (el.contains(ev.relatedTarget)) return;
    el.classList.remove('drop-target');
  });

  el.addEventListener('drop', async (ev) => {
    if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
    ev.preventDefault();
    ev.stopPropagation();
    el.classList.remove('drop-target');
    await dropOnto(readDragPaths(ev), destPath, ev.ctrlKey, label);
  });
}

async function dropOnto(paths, destPath, copy, label) {
  if (!paths.length) return;
  const op = copy ? 'copy' : 'move';
  setStatus(`${copy ? 'Copying' : 'Moving'} ${paths.length} to ${label}…`);

  const results = await doAction(op, paths, { dest: destPath });
  if (results.some((r) => r.ok)) {
    state.selected.clear();
    await scan(state.dir); // folder counts changed, so re-read them
  } else {
    updateStatusLine();
  }
}

/**
 * Groups the grid by performer, or puts it back.
 *
 * A view of the same listing rather than a different listing: the filters, the
 * search and the sort all still apply, and every video in it is still there —
 * just once per person named in it.
 */
const GROUP_MODES = ['', 'models', 'suggested', 'dupes'];

async function toggleGrouped() {
  // Off, credited, suggested, duplicates, off. The plain listing is never more
  // than one more press away, whichever grouping you are in.
  state.grouped = GROUP_MODES[(GROUP_MODES.indexOf(state.grouped) + 1) % GROUP_MODES.length];
  syncGroupButton();
  // The whole set, not the part of it in this folder.
  if (state.grouped === 'dupes') await fetchOtherCopies();
  else forgetOtherCopies();
  await saveConfig({ grouped: state.grouped });
  render();
  if (!state.grouped) return;
  const named = state.groups.filter((g) => !g.unnamed).length;
  const marked = state.groups.filter((g) => !g.unnamed && isFavouriteModel(g.name)).length;
  if (state.grouped === 'dupes') {
    const sets = state.groups.filter((g) => !g.unnamed).length;
    const extra = state.groups.filter((g) => !g.unnamed)
      .reduce((n, g) => n + g.files.length - 1, 0);
    toast(sets
      ? `${sets} set${sets === 1 ? '' : 's'} of copies, ${extra} file${extra === 1 ? '' : 's'} could go`
      : 'No copies found in this listing', sets ? 'ok' : 'info');
    return;
  }
  if (state.grouped === 'suggested') {
    toast(named
      ? `${named} performer${named === 1 ? '' : 's'} the faces look like, best rated first`
      : 'Nobody suggested in this listing', 'ok');
    return;
  }
  toast(named
    ? `${named} performer${named === 1 ? '' : 's'}, best rated first`
      + (marked ? ` — ${marked} marked` : '')
    : 'Nobody named in this listing', 'ok');
}

function syncGroupButton() {
  const btn = $('#groupBtn');
  if (!btn) return;
  btn.classList.toggle('on', Boolean(state.grouped));
  // Two different groupings behind one button, so the state has to be
  // legible without pressing it: the heart changes colour as well as filling.
  btn.classList.toggle('by-suggested', state.grouped === 'suggested');
  btn.classList.toggle('by-dupes', state.grouped === 'dupes');
  btn.title = {
    '': 'Ungrouped — click to group this listing by credited performer',
    models: 'Grouped by credited performer — click to group by suggested performer',
    suggested: 'Grouped by suggested performer, from the face index '
      + '— click to group copies of the same video together',
    dupes: 'Grouped by duplicate — each section is one video and every copy of '
      + 'it, side by side — click for the plain listing',
  }[state.grouped];
}

// ---------------------------------------------------------------- selection

/**
 * `group` is the section a card sits in, when the grid is grouped by performer.
 *
 * A shift-range then means "these videos of hers", not a slice of the flat
 * listing — the indexes a grouped card carries are positions within its own
 * section, so ranging over state.view would select the wrong videos entirely.
 * A range that starts in one section and ends in another is refused rather than
 * guessed at.
 */
function toggleSelect(filePath, index, shiftKey, group = null) {
  const within = group ? group.files : state.view;
  const sameList = state.rangeList === within;
  if (shiftKey && state.lastClickedIndex >= 0 && sameList) {
    const [from, to] = [state.lastClickedIndex, index].sort((a, b) => a - b);
    for (let i = from; i <= to; i += 1) {
      if (within[i]) state.selected.add(within[i].path);
    }
  } else if (state.selected.has(filePath)) {
    state.selected.delete(filePath);
  } else {
    state.selected.add(filePath);
  }
  state.lastClickedIndex = index;
  state.rangeList = within;
  syncSelectionUI();
}

function syncSelectionUI() {
  for (const card of document.querySelectorAll('.card')) {
    card.classList.toggle('selected', state.selected.has(card.dataset.path));
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = state.selected.size;
  $('#selectionBar').hidden = count === 0;
  $('#selectionCount').textContent = `${count} selected`;
  if (!count) return;

  // Shows a filled rating only when the whole selection agrees, so a shared
  // value reads back but a mixed one does not claim otherwise.
  const picked = state.files.filter((f) => state.selected.has(f.path));
  if (!picked.length) return;
  const first = picked[0].rating || 0;
  const uniform = picked.every((f) => (f.rating || 0) === first);
  const holder = $('#batchStars');
  holder.replaceChildren(...buildStars(uniform ? first : 0,
    (rating) => editRecords(selectedPaths(), { rating })).childNodes);
}

/** All selected files, including any hidden by the current filter — so the
 *  count in the selection bar always matches what an action will touch. */
function selectedPaths() {
  return state.files.filter((f) => state.selected.has(f.path)).map((f) => f.path);
}

// ---------------------------------------------------------------- listeners

function wireEvents() {
  $('#scanBtn').addEventListener('click', () => scan());
  $('#dirInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') scan(); });
  $('#recursiveToggle').addEventListener('change', () => scan());

  $('#foldersCollapse').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const pane = $('#foldersSection');
    pane.classList.toggle('collapsed');
    saveConfig({ foldersCollapsed: pane.classList.contains('collapsed') });
  });

  $('#browseBtn').addEventListener('click', () => {
    pickFolder('Choose a video folder', (dest) => { $('#dirInput').value = dest; scan(dest); });
  });

  let searchTimer = null;
  $('#searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchNow, 140);
  });

  $('#sortBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSortMenu();
  });
  // Any click elsewhere dismisses it, which is what a menu is expected to do.
  $('#volBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleVolumeMenu();
  });
  $('#volRange').addEventListener('input', (ev) => {
    const level = Number(ev.target.value) / 100;
    setMasterVolume(level);
    // Moving the slider up is a request for sound in itself, so it need not be
    // two gestures -- turn it on, then set the level.
    if (level > 0 && !soundOn) setSoundOn(true);
  });
  $('#volMute').addEventListener('click', () => setSoundOn(!soundOn));
  // The player's own slider is the same setting seen from inside a video, so it
  // writes back rather than being a second, private volume.
  $('#player').addEventListener('volumechange', () => {
    const player = $('#player');
    barSync();
    if (!watching()) return; // a preview mutes itself; that is not a choice
    if (player.muted !== !soundOn) { setSoundOn(!player.muted); return; }
    if (player.muted) return;
    if (Math.abs(player.volume - masterVolume()) < 0.005) return;
    setMasterVolume(player.volume);
  });

  // Each menu closes on a click anywhere outside its own host -- testing for any
  // .menu-host would leave the sort menu open behind the volume popover.
  document.addEventListener('click', (ev) => {
    const host = ev.target.closest('.menu-host');
    for (const [menu, close] of [['#volMenu', toggleVolumeMenu], ['#sortMenu', toggleSortMenu]]) {
      const el = $(menu);
      if (!el.hidden && (!host || !host.contains(el))) close(false);
    }
  });

  $('#cardWidth').addEventListener('input', (ev) => {
    document.documentElement.style.setProperty('--card-width', ev.target.value + 'px');
  });
  $('#cardWidth').addEventListener('change', (ev) => saveConfig({ cardWidth: Number(ev.target.value) }));

  $('#dwellMs').addEventListener('input', (ev) => {
    $('#dwellLabel').textContent = (Number(ev.target.value) / 1000).toFixed(1) + 's';
  });
  $('#dwellMs').addEventListener('change', (ev) => saveConfig({ dwellMs: Number(ev.target.value) }));

  // batch actions
  for (const btn of document.querySelectorAll('[data-batch]')) {
    btn.addEventListener('click', () => {
      const paths = selectedPaths();
      if (!paths.length) return;
      const op = btn.dataset.batch;
      if (op === 'tags') return openTagDialog(state.files.filter((f) => state.selected.has(f.path)));
      if (op === 'embed') return embedSelection();
      if (op === 'delete') return confirmDelete(paths);
      if (op === 'move') return pickFolder('Move to folder', (dest) => doAction('move', paths, { dest }));
      return doAction(op, paths);
    });
  }
  $('#clearSelection').addEventListener('click', () => {
    state.selected.clear();
    syncSelectionUI();
  });

  // tag editor
  $('#tagAdd').addEventListener('click', () => commitTags('add'));
  $('#tagReplace').addEventListener('click', () => commitTags('replace'));
  // Both sections behave the same way, including Enter -- which commits the
  // dialog rather than just its own field, since the two are saved together.
  for (const field of ['tags', 'models']) {
    const input = $(LABEL_INPUTS[field].input);
    input.addEventListener('input', renderTagSuggestions);
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      // Enter does the safe thing for the context: replacing one video's labels
      // is what the pre-filled boxes imply, but across a selection it appends.
      commitTags(state.tagTargets.length === 1 ? 'replace' : 'add');
    });
  }

  // picker
  $('#pickerUp').addEventListener('click', async () => {
    const data = await api(`/api/dirs?dir=${encodeURIComponent(state.picker.dir || '')}`);
    openPickerAt(data.parent || '');
  });
  $('#pickerGo').addEventListener('click', () => openPickerAt($('#pickerPath').value.trim()));
  $('#pickerPath').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') openPickerAt($('#pickerPath').value.trim());
  });
  $('#pickerConfirm').addEventListener('click', () => {
    const dest = $('#pickerPath').value.trim();
    if (!dest) { toast('Pick a folder first', 'err'); return; }
    const cb = state.picker && state.picker.onConfirm;
    closePicker();
    if (cb) cb(dest);
  });

  // advanced filters
  $('#advBtn').addEventListener('click', openAdvanced);
  $('#advApply').addEventListener('click', applyAdvanced);
  $('#advReset').addEventListener('click', resetAdvanced);
  for (const btn of document.querySelectorAll('[data-clear]')) {
    btn.addEventListener('click', () => {
      const what = btn.dataset.clear;
      // One label, one clear, so all three of the section's rows go with it.
      if (what === 'suggested') {
        advDraft.suggested.clear();
        advDraft.suggestedCount.clear();
        advDraft.suggestedAct.clear();
      } else if (CHOICE_FACETS.includes(what)) advDraft[what].clear();
      else advDraft[what === 'rating' ? 'ratings' : what].clear();
      renderAdvanced();
    });
  }

  $('#facesPill').addEventListener('click', toggleFaceSweep);
  $('#dupesPill').addEventListener('click', toggleDupeSweep);
  $('#framingPill').addEventListener('click', toggleFramingSweep);
  $('#faceAdd').addEventListener('click', () => {
    if (!lineupFor) return;
    const { sug, onPick } = lineupFor;
    closeFaceLineup();
    onPick(sug.name);
  });
  $('#faceOnly').addEventListener('click', () => {
    if (!lineupFor) return;
    const { sug } = lineupFor;
    closeFaceLineup();
    // Her videos, and nothing else -- the same thing a pill on a card does.
    $('#playerModal').hidden = true;
    $('#tagModal').hidden = true;
    filterByLabel('models', sug.name);
  });

  // Crossing into the card must not dismiss it: its footer is a real target.
  const hoverCard = $('#faceHover');
  hoverCard.addEventListener('mouseenter', () => clearTimeout(hover.out));
  hoverCard.addEventListener('mouseleave', () => {
    hover.out = setTimeout(closeFaceHover, HOVER_OUT_MS);
  });
  $('#faceHoverNo').addEventListener('click', () => {
    if (!hover.held) return;
    const { file, sug } = hover.held;
    closeFaceHover();
    refuseSuggestion(file, sug.name);
  });
  $('#faceHoverMore').addEventListener('click', () => {
    if (!hover.held) return;
    const { file, sug } = hover.held;
    closeFaceHover();
    // The full lineup still holds her whole set and the way to her videos. It
    // is now somewhere you go on purpose, not the only way to compare.
    openFaceLineup(file, sug, (picked) => editRecords([file.path], { addModels: [picked] })
      .then(() => { if (state.playing) buildPlayerSuggestions(state.playing); }));
  });

  $('#faceModal').addEventListener('click', (ev) => {
    if (ev.target.id === 'faceModal' || ev.target.closest('.modal-close')) closeFaceLineup();
  });
  pollFaceStatus();
  setInterval(pollFaceStatus, 2000);
  pollDupeStatus();
  setInterval(pollDupeStatus, 2000);
  pollFramingStatus();
  setInterval(pollFramingStatus, 2000);

  // settings
  $('#groupBtn').addEventListener('click', toggleGrouped);

  $('#settingsBtn').addEventListener('click', () => {
    $('#setPreviewMode').value = state.config.previewMode === 'sprite' ? 'sprite' : 'live';
    $('#setFrames').value = state.config.frames;
    $('#setTileWidth').value = state.config.tileWidth;
    $('#setScrub').checked = !!state.config.scrubWithMouse;
    $('#setHomeDir').value = state.config.homeDir || '';
    $('#setHomeFolders').value = (state.config.homeFolders || []).join(', ');
    $('#setHomeFollow').checked = state.config.homeFollowsAccount !== false;
    syncHomeFields();
    $('#settingsModal').hidden = false;
  });
  $('#setHomeFollow').addEventListener('change', syncHomeFields);
  $('#setHomeBrowse').addEventListener('click', () => {
    pickFolder('Choose the default folder', (dest) => {
      $('#setHomeDir').value = dest;
      // Picking a folder by hand is an explicit override of the account.
      $('#setHomeFollow').checked = false;
      syncHomeFields();
    });
  });
  $('#settingsSave').addEventListener('click', async () => {
    const frames = Math.max(2, Math.min(24, Number($('#setFrames').value) || 10));
    const tileWidth = Math.max(120, Math.min(640, Number($('#setTileWidth').value) || 320));
    const previewMode = $('#setPreviewMode').value === 'sprite' ? 'sprite' : 'live';
    const changed = frames !== state.config.frames
      || tileWidth !== state.config.tileWidth
      || previewMode !== state.config.previewMode;

    const homeDir = $('#setHomeDir').value.trim();
    const homeFolders = $('#setHomeFolders').value.split(',').map((n) => n.trim()).filter(Boolean);
    const homeFollowsAccount = $('#setHomeFollow').checked;
    const wasFollowing = state.config.homeFollowsAccount !== false;
    const homeChanged = homeFollowsAccount !== wasFollowing
      || (!homeFollowsAccount && !samePath(homeDir, state.config.homeDir));

    // A changed folder list only shows once the listing is fetched again, since
    // the server is the one applying it.
    const foldersChanged = (state.config.homeFolders || []).join('|') !== homeFolders.join('|');

    await saveConfig({
      frames, tileWidth, previewMode, homeDir, homeFollowsAccount, homeFolders,
      scrubWithMouse: $('#setScrub').checked,
    });
    $('#settingsModal').hidden = true;
    if (foldersChanged && samePath(state.dir, state.config.homeDir)) scan(state.dir, { record: false });
    if (homeChanged) {
      renderBreadcrumb();
      // Following the account re-resolves server-side, so report what was
      // actually kept rather than what was typed.
      toast('Default folder: ' + state.config.homeDir, 'ok');
    }
    if (changed) {
      clearSprites();
      render();
      toast(previewMode === 'live' ? 'Live hover previews active' : 'Cached stills will build for every video listed', 'ok');
    }
  });
  $('#clearCacheBtn').addEventListener('click', async () => {
    if (!window.confirm('Delete all cached previews and metadata? They rebuild on demand.')) return;
    try {
      await api('/api/cache/clear', { method: 'POST' });
      clearSprites();
      render();
      toast('Preview cache cleared', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // player
  // The preview itself is what you click to start watching. Guarded on the
  // preview still running: afterwards the element belongs to the native
  // controls, and a click meaning "pause" must not mean "start again from the
  // beginning".
  $('#playerModal .player-stage').addEventListener('click', (ev) => {
    if (previewing()) { beginPlayback(); return; }
    // Clicking the bar is not clicking the picture.
    if (ev.target.closest('.player-bar')) return;
    if (watching()) togglePlayback();
  });
  $('#playerPrev').addEventListener('click', () => playSibling(-1));
  $('#playerNext').addEventListener('click', () => playSibling(1));

  // ---- the control bar ----------------------------------------------------

  const player = $('#player');
  // Everything the bar draws comes from the element, so the element is what it
  // listens to -- rather than a timer guessing at the same numbers.
  for (const type of ['timeupdate', 'progress', 'durationchange', 'play',
    'pause', 'seeked', 'ended', 'loadedmetadata']) {
    player.addEventListener(type, barSync);
  }
  player.addEventListener('play', wakeBar);
  player.addEventListener('pause', wakeBar);
  // Moving over the picture is asking for the controls back.
  $('#playerModal .player-stage').addEventListener('pointermove', wakeBar);
  $('#playerBar').addEventListener('pointerenter', wakeBar);

  $('#pbPlay').addEventListener('click', togglePlayback);
  $('#pbFull').addEventListener('click', toggleFullscreen);
  $('#pbMute').addEventListener('click', () => setSoundOn(!soundOn));
  $('#pbVol').addEventListener('input', (ev) => {
    const level = Number(ev.target.value) / 100;
    setMasterVolume(level);
    if (level > 0 && !soundOn) setSoundOn(true);
    else if (level === 0 && soundOn) setSoundOn(false);
    wakeBar();
  });

  // ---- scrubbing, with a preview of where you would land -------------------

  const seekEl = $('#pbSeek');
  const commitSeek = (clientX) => {
    const duration = playerDuration();
    if (!(duration > 0)) return;
    try { player.currentTime = seekFractionAt(clientX) * duration; } catch { /* not seekable */ }
    barSync();
  };

  // ---- bookmarks ----------------------------------------------------------

  // Right-click the timeline to bookmark the second under the pointer; right-
  // click an existing pip to edit or remove it. The browser menu is not useful
  // over a seek bar, so this takes its place rather than sitting beside it.
  seekEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const duration = playerDuration();
    if (!(duration > 0)) return;
    const pip = ev.target.closest('.pb-mark');
    openMarkMenu(pip ? Number(pip.dataset.at) : seekFractionAt(ev.clientX) * duration,
      ev.clientX);
  });
  // A left-click on a pip goes there. It is on the track, so without this it
  // would seek to roughly the same place -- roughly is not what a bookmark is.
  seekEl.addEventListener('click', (ev) => {
    const pip = ev.target.closest('.pb-mark');
    if (!pip) return;
    ev.stopPropagation();
    goToMark(Number(pip.dataset.at));
  });
  // The panel is inside the track, so without this every click in it would
  // scrub the video underneath.
  $('#pbMarkMenu').addEventListener('pointerdown', (ev) => ev.stopPropagation());
  $('#pbMarkMenu').addEventListener('click', (ev) => ev.stopPropagation());
  $('#pbMarkDrop').addEventListener('click', () => {
    removeMark(Number($('#pbMarkMenu').dataset.at));
  });
  // Narrowing the grid as you type, rather than on a button.
  $('#pbMarkFind').addEventListener('input', drawIconChoices);
  $('#pbMarkFind').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      // Typed a name and there is only one thing it can mean: take it, rather
      // than making you move to the mouse to click the single square left.
      ev.preventDefault();
      const found = findIcons($('#pbMarkFind').value);
      if (found.length) saveMark(Number($('#pbMarkMenu').dataset.at), found[0].id);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeMarkMenu();
    }
  });
  // Anywhere else closes it, including the picture behind it.
  document.addEventListener('pointerdown', (ev) => {
    if (!$('#pbMarkMenu').hidden && !ev.target.closest('#pbMarkMenu')) closeMarkMenu();
  });
  // Redraw when the video's own length finally arrives: the pips are placed as
  // a fraction of it, and before it lands there is nothing to be a fraction of.
  player.addEventListener('durationchange', drawMarks);
  player.addEventListener('loadedmetadata', drawMarks);
  // And once the icon set is in, so a pip drawn before it landed stops showing
  // its own name and starts showing its picture.
  loadMarkIcons().then(() => { if (watching()) drawMarks(); });

  seekEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    // A pip is a button in its own right; scrubbing starts on the track.
    if (ev.target.closest('.pb-mark')) return;
    ev.preventDefault();
    scrub.dragging = true;
    seekEl.classList.add('dragging');
    // Captured, so a drag that leaves the track keeps scrubbing rather than
    // stopping wherever the pointer crossed the edge.
    seekEl.setPointerCapture(ev.pointerId);
    commitSeek(ev.clientX);
    showHoverAt(ev.clientX);
    wakeBar();
  });
  seekEl.addEventListener('pointermove', (ev) => {
    // The picker sits inside the track, so moving across it must not put a
    // preview thumbnail over the top of what you are reading.
    if (!$('#pbMarkMenu').hidden && ev.target.closest('#pbMarkMenu')) return;
    showHoverAt(ev.clientX);
    if (scrub.dragging) commitSeek(ev.clientX);
    wakeBar();
  });
  seekEl.addEventListener('pointerup', (ev) => {
    if (!scrub.dragging) return;
    scrub.dragging = false;
    seekEl.classList.remove('dragging');
    if (seekEl.hasPointerCapture(ev.pointerId)) seekEl.releasePointerCapture(ev.pointerId);
    commitSeek(ev.clientX);
    wakeBar();
  });
  seekEl.addEventListener('pointerleave', () => {
    if (!scrub.dragging) hideHover();
  });
  seekEl.addEventListener('keydown', (ev) => {
    const duration = playerDuration();
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekBy(-5); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); seekBy(5); }
    else if (ev.key === 'Home') { ev.preventDefault(); seekBy(-duration); }
    else if (ev.key === 'End') { ev.preventDefault(); seekBy(duration); }
    else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); togglePlayback(); }
  });

  // Leaving fullscreen any way at all -- Escape, the button, the OS -- has to
  // put the bar back where it belongs.
  document.addEventListener('fullscreenchange', wakeBar);

  // modal chrome
  for (const btn of document.querySelectorAll('.modal-close')) {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal');
      if (modal.id === 'playerModal') closePlayer();
      else if (modal.id === 'pickerModal') closePicker();
      else modal.hidden = true;
    });
  }
  for (const modal of document.querySelectorAll('.modal')) {
    modal.addEventListener('click', (ev) => {
      if (ev.target !== modal) return;
      if (modal.id === 'playerModal') closePlayer();
      else if (modal.id === 'pickerModal') closePicker();
      else modal.hidden = true;
    });
  }

  document.addEventListener('keydown', onKeyDown);

  // Side buttons on a mouse: 3 = back, 4 = forward.
  window.addEventListener('mouseup', (ev) => {
    if (ev.button !== 3 && ev.button !== 4) return;
    if (modalOpen()) return;
    ev.preventDefault();
    if (ev.button === 3) goBack(); else goForward();
  });
  // Chromium fires this for the same buttons; suppressing it stops the
  // WebView trying to navigate its own history out from under us.
  window.addEventListener('auxclick', (ev) => {
    if (ev.button === 3 || ev.button === 4) ev.preventDefault();
  });
}

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function modalOpen() {
  return !$('#playerModal').hidden || !$('#pickerModal').hidden
    || !$('#settingsModal').hidden || !$('#tagModal').hidden || !$('#advModal').hidden
    || !$('#faceModal').hidden;
}

/**
 * The player is the frontmost thing, so a shortcut aimed at the open video is
 * safe to fire. A dialog opened over the top of it — tags, filters, the folder
 * picker — owns the keyboard instead, and one of those is where a bare digit
 * most likely belongs to something being typed.
 */
function playerHasKeys() {
  return !$('#playerModal').hidden && $('#pickerModal').hidden
    && $('#settingsModal').hidden && $('#tagModal').hidden && $('#advModal').hidden;
}

function onKeyDown(ev) {
  // Escape always unwinds one layer: topmost modal first, then the selection.
  if (ev.key === 'Escape') {
    // Fullscreen is a layer of its own, and the outermost one. Closing the
    // player from under it would leave the screen owned by a dialog that is
    // no longer there.
    if (!$('#pbMarkMenu').hidden) { closeMarkMenu(); return; }
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    if (!$('#volMenu').hidden) { toggleVolumeMenu(false); return; }
    // The lineup opens over the player and over the label dialog, so it is the
    // first layer Escape takes off.
    if (!$('#faceModal').hidden) return closeFaceLineup();
    if (!$('#pickerModal').hidden) return closePicker();
    if (!$('#tagModal').hidden) { $('#tagModal').hidden = true; return; }
    if (!$('#advModal').hidden) { $('#advModal').hidden = true; return; }
    if (!$('#playerModal').hidden) return closePlayer();
    if (!$('#settingsModal').hidden) { $('#settingsModal').hidden = true; return; }
    if (isTyping()) { document.activeElement.blur(); return; }
    if (state.selected.size) {
      state.selected.clear();
      syncSelectionUI();
    }
    return;
  }

  // Ctrl+Shift+R starts over: home folder, no filters, default sort. The flag
  // survives the reload that follows, and is read once on the way back up.
  // preventDefault is belt and braces — if the shell reloads anyway, the flag
  // is already set and the outcome is the same.
  if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'r' || ev.key === 'R')) {
    ev.preventDefault();
    sessionStorage.setItem(RESET_KEY, '1');
    location.reload();
    return;
  }

  // Alt+arrows navigate history, as in a browser or File Explorer.
  if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    if (modalOpen()) return;
    ev.preventDefault();
    if (ev.key === 'ArrowLeft') goBack(); else goForward();
    return;
  }

  // Arrows step through the listing while the player is open. Once playback has
  // started the bare arrows seek the video instead, as they always did when the
  // browser owned the controls, so from then on stepping needs Shift.
  if (!ev.ctrlKey && !ev.metaKey && !$('#playerModal').hidden
      && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    if (previewing() || ev.shiftKey) {
      ev.preventDefault();
      playSibling(ev.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (watching() && !isTyping()) {
      ev.preventDefault();
      seekBy(ev.key === 'ArrowLeft' ? -5 : 5);
      return;
    }
  }

  // What the native bar answered for, now that it is ours to answer: space or K
  // to hold it, M for sound, F for the whole screen. Skipped when the focus is
  // on one of the bar's own buttons, where space is already that button.
  if (playerHasKeys() && watching() && !isTyping()
      && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const onButton = document.activeElement
      && document.activeElement.closest('.player-bar button');
    if ((ev.key === ' ' || ev.key === 'k' || ev.key === 'K') && !onButton) {
      ev.preventDefault();
      togglePlayback();
      return;
    }
    if (ev.key === 'm' || ev.key === 'M') {
      ev.preventDefault();
      setSoundOn(!soundOn);
      return;
    }
    if (ev.key === 'f' || ev.key === 'F') {
      ev.preventDefault();
      toggleFullscreen();
      return;
    }
  }

  // A digit rates the open video, the way it rates the selection in the grid.
  // Deliberately the open video and not the selection: what is selected behind
  // the player is not what you are looking at, and rating one as you finish
  // watching it is the whole reason the shortcut is wanted here.
  if (playerHasKeys() && !isTyping() && !ev.ctrlKey && !ev.metaKey && !ev.altKey
      && ev.key >= '0' && ev.key <= '5') {
    ev.preventDefault();
    if (state.playing) editRecords([state.playing.path], { rating: Number(ev.key) });
    return;
  }

  if (isTyping() || modalOpen()) return;

  // Backspace goes up a level, matching File Explorer.
  if (ev.key === 'Backspace') {
    ev.preventDefault();
    if (state.parent) navigateTo(state.parent);
    return;
  }

  // Select every video in the current listing.
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
    ev.preventDefault();
    state.view.forEach((f) => state.selected.add(f.path));
    syncSelectionUI();
    return;
  }

  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

  if (ev.key === '/') {
    ev.preventDefault();
    $('#searchInput').focus();
    return;
  }

  // The rest act on the current selection.
  const paths = selectedPaths();
  if (!paths.length) return;

  if (ev.key >= '0' && ev.key <= '5') {
    ev.preventDefault();
    editRecords(paths, { rating: Number(ev.key) });
  } else if (ev.key === 't' || ev.key === 'T') {
    ev.preventDefault();
    openTagDialog(state.files.filter((f) => state.selected.has(f.path)));
  } else if (ev.key === 'Delete') {
    ev.preventDefault();
    confirmDelete(paths);
  } else if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    pickFolder('Move to folder', (dest) => doAction('move', paths, { dest }));
  }
}

// -------------------------------------------------------------------- init

async function init() {
  wireEvents();
  try {
    state.config = await api('/api/config');
  } catch {
    state.config = {
      previewMode: 'live', frames: 10, dwellMs: 2000, tileWidth: 640, cardWidth: 200,
      recursive: false, grouped: '', sortDir: 'desc', sort: 'rating',
    };
  }

  // Three ways in, and they differ only in where you land:
  //
  //   cold launch    the default folder, keeping how you had the view set up
  //   F5             the folder you were in, with the view back to defaults
  //   Ctrl+Shift+R   the default folder, with the view back to defaults
  //
  // A refresh is what you press when the view has got away from you, so both
  // reload paths drop the filters and the sort. Only the folder is at stake
  // between them, which is why Ctrl+Shift+R needs nothing more than a flag.
  const reloaded = (performance.getEntriesByType('navigation')[0] || {}).type === 'reload';
  const toHome = sessionStorage.getItem(RESET_KEY) === '1';
  sessionStorage.removeItem(RESET_KEY);

  if (reloaded || toHome) resetView();

  const start = (reloaded && !toHome ? state.config.lastDir : '')
    || state.config.homeDir || state.config.lastDir || '';
  $('#dirInput').value = start;
  $('#recursiveToggle').checked = state.config.recursive === true;
  // `true` is what this was before there were two groupings.
  state.grouped = state.config.grouped === true ? 'models'
    : (GROUP_MODES.includes(state.config.grouped) ? state.config.grouped : '');
  syncGroupButton();
  // The mode is remembered across launches, so the fetch has to happen on the
  // way in as well as on the click.
  if (state.grouped === 'dupes') fetchOtherCopies().then(() => render());
  $('#sortSelect').value = state.config.sort || 'name';
  syncSortButton();
  $('#cardWidth').value = state.config.cardWidth || 200;
  document.documentElement.style.setProperty('--card-width', (state.config.cardWidth || 200) + 'px');
  syncVolumeUI();
  // Bound once. The row that pages as you scroll is rebuilt for every video
  // played, and a listener added with it would be a listener leaked with it.
  watchSimilarScroll();
  $('#dwellMs').value = state.config.dwellMs || 2000;
  $('#dwellLabel').textContent = ((state.config.dwellMs || 2000) / 1000).toFixed(1) + 's';

  // The vocabularies are library-wide, so they load once rather than per scan.
  api('/api/library').then((data) => {
    state.tagVocab = data.tags || [];
    // Both vocabularies, or the dialog's Models section sits empty until an edit
    // happens to bring the second one back with its response.
    state.modelVocab = data.models || [];
    state.studioVocab = data.studios || [];
    state.productionVocab = data.productions || [];
    setFavourites(data.favourites);
    syncTagVocab();
  }).catch(() => {});

  if (start) scan(start);
}

init();
