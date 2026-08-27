'use strict';

/* Video Explorer front-end: sprite-scrubbing grid + hover quick actions. */

const $ = (sel) => document.querySelector(sel);

/** The only scrolling element — observers must measure against it, not the page. */
const scrollRoot = document.getElementById('scrollArea');

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
  playing: null,      // file open in the player modal
  playingAnchor: null, // the slot it held, once a filter drops it from the view
  selected: new Set(),
  lastClickedIndex: -1,
  sprites: new Map(),  // path -> { url, frames }
  thumbs: new Map(),   // path -> poster blob URL
  pending: new Map(),  // path -> in-flight poster/sprite promise
  failed: new Set(),
  picker: null,        // { dir, onConfirm, title }
  tagVocab: [],        // [{ tag, count }] across the whole library
  modelVocab: [],      // the same, for performer names
  studioVocab: [],     // and for production houses, of which a video has one
  tagTargets: [],      // files the open label dialog will edit
  adv: newAdvFilter(), // the advanced filter currently applied
};

/**
 * The advanced filter. Each facet is a Map of value → 'in' | 'out': clicking a
 * chip cycles include → exclude → gone. An empty map means "no constraint"
 * rather than "match nothing", so a fresh filter is transparent and the UI never
 * has to special-case "everything is unchecked".
 */
function newAdvFilter() {
  return {
    text: '',
    tags: new Map(),
    models: new Map(),
    studio: new Map(),
    // Per facet, because "all of these tags" and "any of these performers" is a
    // reasonable thing to ask for and one shared switch could not express it.
    // Exclusions are always all-of: "not this" means not this either way.
    // Studio is absent on purpose — one studio per video makes all-of empty.
    mode: { tags: 'all', models: 'all' },
    ratings: new Map(),   // 0 means unrated
    link: 'all',          // 'all' | 'yes' | 'no' — whether a source url is stored
    cloud: 'all',         // 'all' | 'downloaded' | 'cloud'
  };
}

const FACETS = ['tags', 'models', 'studio', 'ratings'];

/** The label facets, in the order they appear on a card and in the dialog. */
const LABEL_FACETS = ['studio', 'models', 'tags'];

/** Which radio group drives which facet's all/any. Studio has none. */
const MODE_INPUTS = [['tags', 'tagMode'], ['models', 'modelMode']];

/**
 * The "no tags" / "no models" chip lives in the same map as the values, under a
 * key no tag can have. A separate field would need its own copying, clearing,
 * counting and emptiness test; a NUL key gets all of that for free, and
 * `picked()` filters it out of the value lists.
 */
const NOTHING = '\u0000';

/**
 * The values a facet includes, or excludes — the two are always read apart, and
 * the emptiness chip is not a value, so it never appears here.
 */
function picked(facet, want) {
  return [...facet]
    .filter(([value, mode]) => mode === want && value !== NOTHING)
    .map(([value]) => value);
}

/**
 * How the listing is set up, as opposed to how the app is configured. A refresh
 * puts these back; card size, preview engine and the default folder are
 * preferences and survive it.
 */
const VIEW_DEFAULTS = { sort: 'rating', sortDir: 'desc', recursive: false };
const RESET_KEY = 've-reset-home';

/** Drops filters, search and sort back to the defaults, saving as it goes. */
function resetView() {
  Object.assign(state.config, VIEW_DEFAULTS);
  saveConfig({ ...VIEW_DEFAULTS });
  state.adv = newAdvFilter();
  advDraft = newAdvFilter();
  // Chromium restores form values across a reload, so these are cleared rather
  // than assumed empty.
  $('#searchInput').value = '';
  $('#advText').value = '';
  syncAdvBadge();
}

function advActive(adv = state.adv) {
  return Boolean(adv.text) || adv.cloud !== 'all' || adv.link !== 'all'
    || FACETS.some((f) => adv[f].size > 0);
}

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
  }, kind === 'err' ? 6000 : 3200);
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

function renderFolders() {
  const section = $('#foldersSection');
  const wrap = $('#folders');
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
  section.scrollTop = 0;
  $('#folderCount').textContent = folders.length === state.folders.length
    ? `(${state.folders.length})`
    : `(${folders.length} of ${state.folders.length})`;

  for (const folder of folders) {
    const downloaded = folder.videoCount - (folder.cloudCount || 0);
    const tile = document.createElement('button');
    tile.className = 'folder-tile' + (folder.videoCount === 0 ? ' no-videos' : '');
    tile.title = `${folder.path}\nDrop videos here to move them · hold Ctrl to copy`;
    tile.addEventListener('click', () => navigateTo(folder.path));
    attachDropTarget(tile, folder.path, folder.name);

    const cover = document.createElement('div');
    cover.className = 'folder-cover';
    if (folder.cover) {
      cover.dataset.path = folder.cover;
      folderObserver.observe(cover);
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
    } else if (folder.cloudCount) {
      // Lead with what's actually usable offline.
      meta.textContent = `${downloaded.toLocaleString()} downloaded of ${folder.videoCount.toLocaleString()}`;
      meta.title = `${folder.cloudCount.toLocaleString()} cloud-only · ${fmtBytes(folder.totalSize)} total`;
    } else {
      meta.textContent = `${folder.videoCount.toLocaleString()} video${folder.videoCount === 1 ? '' : 's'} · ${fmtBytes(folder.totalSize)}`;
    }
    body.appendChild(meta);

    tile.appendChild(body);
    wrap.appendChild(tile);
  }
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

/**
 * The advanced filter, on top of whatever the quick filter box says. Every
 * populated facet has to match; an empty one is ignored.
 */
function matchesAdvanced(file, adv) {
  if (adv.text) {
    const hay = (file.name + ' ' + file.relFolder).toLowerCase();
    if (!adv.text.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false;
  }

  // Tags and models are matched the same way, but each facet on its own: two
  // models and one tag means "those models AND that tag", not one merged pool.
  // The all/any switch governs the included tags; exclusions are always all-of,
  // since "not this" means not this whichever way that switch is set.
  for (const field of LABEL_FACETS) {
    if (!adv[field].size) continue;
    // The studio is one value rather than a list, so it is wrapped.
    const held = file[field];
    const have = new Set((Array.isArray(held) ? held : (held ? [held] : []))
      .map((t) => t.toLowerCase()));

    // "Has none at all" is its own question, asked before any value is compared:
    // include it to see only the unlabelled, exclude it to drop them.
    const nothing = adv[field].get(NOTHING);
    if (nothing === 'in' && have.size) return false;
    if (nothing === 'out' && !have.size) return false;

    const wanted = picked(adv[field], 'in').map((t) => t.toLowerCase());
    if (wanted.length) {
      // A video holds one studio, so several of them can only mean "any".
      const any = field === 'studio' || (adv.mode || {})[field] === 'any';
      const hit = any ? wanted.some((t) => have.has(t)) : wanted.every((t) => have.has(t));
      if (!hit) return false;
    }
    if (picked(adv[field], 'out').map((t) => t.toLowerCase()).some((t) => have.has(t))) return false;
  }

  if (adv.ratings.size) {
    const rating = file.rating || 0;
    const wanted = picked(adv.ratings, 'in');
    if (wanted.length && !wanted.includes(rating)) return false;
    if (picked(adv.ratings, 'out').includes(rating)) return false;
  }

  if (adv.link === 'yes' && !file.url) return false;
  if (adv.link === 'no' && file.url) return false;

  if (adv.cloud === 'downloaded' && file.cloudOnly) return false;
  if (adv.cloud === 'cloud' && !file.cloudOnly) return false;

  return true;
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
  if (advActive()) list = list.filter((f) => matchesAdvanced(f, state.adv));

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
  if (player && player.controls) {
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
  advDraft = {
    ...state.adv,
    tags: new Map(state.adv.tags),
    models: new Map(state.adv.models),
    studio: new Map(state.adv.studio),
    ratings: new Map(state.adv.ratings),
    mode: { ...state.adv.mode },
  };
  $('#advText').value = advDraft.text;
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

  // Same shape as Availability directly below it: one of three, not a cycle,
  // because "has a link" and "has none" already cover the whole listing.
  const link = $('#advLink');
  link.innerHTML = '';
  for (const [value, label] of [['all', 'everything'], ['yes', 'has a link'], ['no', 'no link']]) {
    link.appendChild(chipToggle(label, advDraft.link === value, () => {
      advDraft.link = value;
      renderAdvanced();
    }));
  }

  const cloud = $('#advCloud');
  cloud.innerHTML = '';
  for (const [value, label] of [['all', 'everything'], ['downloaded', 'downloaded only'], ['cloud', 'cloud only ☁']]) {
    cloud.appendChild(chipToggle(label, advDraft.cloud === value, () => {
      advDraft.cloud = value;
      renderAdvanced();
    }));
  }


  for (const [field, el, empty, none] of [
    ['studio', '#advStudio', 'No studios yet — the import writes them.', 'no studio'],
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
  say('models', 'model', 'models', ` (${advDraft.mode.models})`);
  say('tags', 'tag', 'tags', ` (${advDraft.mode.tags})`);
  say('ratings', 'rating');
  if (advDraft.link === 'yes') bits.push('linked');
  if (advDraft.link === 'no') bits.push('unlinked');
  if (advDraft.cloud !== 'all') bits.push(advDraft.cloud);
  if (advDraft.text) bits.push(`"${advDraft.text}"`);
  el.textContent = bits.join(' · ');
}

/**
 * Which videos the ranking is allowed to count, by tag.
 *
 * A Map of tag → 'in' | 'out' with the NUL key for "has no tags at all" — the
 * same shape as a facet of the advanced filter, so the chips, the cycling and
 * the all/any switch are the ones already built. It lives out here so a filter
 * survives closing the panel: it is a question about the library, not a piece of
 * the panel's furniture.
 */
let favTags = new Map();
let favTagMode = 'all';

/** Chips can be pressed faster than the server can answer; only the last reply counts. */
let favRun = 0;

/** The ranking request for the tags currently picked. */
function favQuery() {
  const params = new URLSearchParams({ limit: '20', tagMode: favTagMode });
  // Repeated params, not one joined list: a tag is free text and may hold a comma.
  for (const tag of picked(favTags, 'in')) params.append('tag', tag);
  for (const tag of picked(favTags, 'out')) params.append('notTag', tag);
  const none = favTags.get(NOTHING);
  if (none) params.set('noTags', none);
  return `/api/top-models?${params}`;
}

const favFiltered = () => favTags.size > 0;

/**
 * What the filter is doing, in words — because a re-ranked list looks exactly
 * like an unfiltered one, and "why is she not first any more" deserves an answer
 * on the panel rather than in someone's memory.
 */
function favScope() {
  if (!favFiltered()) return '';
  const bits = [];
  const none = favTags.get(NOTHING);
  if (none === 'in') bits.push('with no tags at all');
  if (none === 'out') bits.push('with at least one tag');
  const wanted = picked(favTags, 'in');
  if (wanted.length) bits.push(`tagged ${wanted.join(favTagMode === 'any' ? ' or ' : ' and ')}`);
  const banned = picked(favTags, 'out');
  if (banned.length) bits.push(`not tagged ${banned.join(' or ')}`);
  return ` Counting only videos ${bits.join(', ')} — so this is the top twenty for that.`;
}

/**
 * The best-rated performers, and one click to go and watch them.
 *
 * The ranking comes from the server because it is a fact about the library
 * rather than about the listing: computing it from state.files would rank only
 * what the current folder and filter happen to show.
 */
async function openFavourites() {
  $('#favModal').hidden = false;
  renderFavTags();
  await loadFavourites();
}

/** The tag chips above the ranking. Every press re-ranks, so there is no Apply. */
function renderFavTags() {
  for (const radio of document.querySelectorAll('input[name="favTagMode"]')) {
    radio.checked = radio.value === favTagMode;
  }
  $('#favClear').hidden = !favFiltered();

  const box = $('#favTags');
  box.innerHTML = '';

  // First, because "who has untagged work" is a question about the whole
  // library rather than one more tag in it.
  const gap = chipCycle('no tags', favTags.get(NOTHING), () => {
    cycleIn(favTags, NOTHING);
    renderFavTags();
    loadFavourites();
  });
  gap.classList.add('chip-none');
  box.appendChild(gap);

  const vocab = vocabByName('tags');
  if (!vocab.length) {
    box.insertAdjacentHTML('beforeend', '<span class="dim">No tags yet — add some from a card first.</span>');
  }
  for (const entry of vocab) {
    box.appendChild(chipCycle(`${entry.tag} · ${entry.count}`, favTags.get(entry.tag), () => {
      cycleIn(favTags, entry.tag);
      renderFavTags();
      loadFavourites();
    }));
  }
}

async function loadFavourites() {
  const list = $('#favList');
  const run = ++favRun;
  list.innerHTML = '<li class="fav-loading">Counting…</li>';

  let models = [];
  try {
    models = (await api(favQuery())).models || [];
  } catch (err) {
    if (run !== favRun) return;
    list.innerHTML = '';
    $('#favHint').textContent = err.message;
    return;
  }
  if (run !== favRun) return; // a later press already asked a different question

  const weights = 'A five-star video is worth a thousand points, a four-star a hundred,'
    + ' a three-star ten, everything else nothing.';
  $('#favHint').textContent = models.length
    ? `${weights}${favScope()} Pick a name to list their videos, or a still to play it.`
    : favFiltered()
      ? 'Nobody has a rated video matching those tags.'
      : 'Nothing to rank yet — rate a few videos three stars or better and name who is in them.';

  list.innerHTML = '';
  for (const [index, entry] of models.entries()) {
    const row = document.createElement('li');
    row.className = 'fav-row';

    const line = document.createElement('div');
    line.className = 'fav-line';
    row.appendChild(line);

    const rank = document.createElement('span');
    rank.className = 'fav-rank';
    rank.textContent = String(index + 1);
    line.appendChild(rank);

    const name = document.createElement('span');
    name.className = 'fav-name';
    name.textContent = entry.name;
    line.appendChild(name);

    // The score, then what it is made of — so the order explains itself without
    // anyone having to remember the weights.
    const score = document.createElement('span');
    score.className = 'fav-score';
    score.textContent = entry.points.toLocaleString();
    line.appendChild(score);

    const stars = document.createElement('span');
    stars.className = 'fav-stars';
    for (const star of [5, 4, 3]) {
      const n = entry.counts[star];
      if (!n) continue;
      const bit = document.createElement('span');
      bit.className = 'fav-bucket';
      bit.textContent = `${n}×${'★'.repeat(star)}`;
      stars.appendChild(bit);
    }
    line.appendChild(stars);

    const total = document.createElement('span');
    total.className = 'fav-total';
    total.textContent = `${entry.videos} video${entry.videos === 1 ? '' : 's'}`;
    line.appendChild(total);

    // Every video that earned the score, not a sample of them.
    const shots = entry.top || [];
    if (shots.length) row.appendChild(buildStrip(shots, entry.name));

    line.addEventListener('click', () => showModel(entry.name));
    list.appendChild(row);
  }
}

/**
 * A performer's stills, with arrows when there are more than fit.
 *
 * Someone with thirty four-star videos gets thirty stills, so the row has to
 * scroll — and a bare scrollbar under each of twenty rows is both ugly and hard
 * to hit. The arrows appear only when there is somewhere to go, and each press
 * moves most of a screen, which keeps a frame or two of context.
 */
function buildStrip(videos, modelName) {
  const wrap = document.createElement('div');
  wrap.className = 'fav-strip';

  const strip = document.createElement('div');
  strip.className = 'fav-shots';

  for (const video of videos) {
    const shot = document.createElement('div');
    shot.className = 'fav-shot';
    shot.dataset.path = video.path;
    shot.title = `${video.name}\n${'★'.repeat(video.rating)} · ${fmtBytes(video.size)}`
      + `${video.cloudOnly ? ' · not downloaded' : ''}\nClick to play it`;

    const badge = document.createElement('span');
    badge.className = 'fav-shot-rating';
    badge.textContent = video.rating;
    shot.appendChild(badge);

    shot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showModelVideo(modelName, video.path);
    });
    favObserver.observe(shot);
    strip.appendChild(shot);
  }
  wrap.appendChild(strip);

  const arrow = (where, glyph) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `fav-arrow ${where}`;
    btn.textContent = glyph;
    btn.tabIndex = -1;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const step = Math.max(120, strip.clientWidth * 0.8);
      strip.scrollBy({ left: where === 'next' ? step : -step, behavior: 'smooth' });
    });
    wrap.appendChild(btn);
    return btn;
  };
  const back = arrow('prev', '‹');
  const on = arrow('next', '›');

  // An arrow with nowhere to go is worse than no arrow: it invites a press that
  // does nothing. Both are hidden until the strip has actually overflowed, and
  // rechecked as it scrolls, since either end can run out.
  const sync = () => {
    const room = strip.scrollWidth - strip.clientWidth;
    back.hidden = strip.scrollLeft < 4;
    on.hidden = room < 4 || strip.scrollLeft > room - 4;
  };
  strip.addEventListener('scroll', sync);
  // After layout: scrollWidth is meaningless while the row is still being built.
  requestAnimationFrame(sync);
  wrap.__syncArrows = sync;

  return wrap;
}

/**
 * Everything by one performer, best first, from the top of the library down.
 *
 * Deliberately jumps to the sync root with the subfolders flattened: a
 * performer's videos are spread across studio folders, so the answer to "show
 * me theirs" is never inside the folder you happen to be standing in.
 */
/**
 * A still is a video, so clicking one opens it.
 *
 * The listing is narrowed to its performer first, and only then does the player
 * open — so the arrows in it walk that performer's videos rather than whatever
 * folder happened to be on screen when the overlay was opened.
 */
async function showModelVideo(name, videoPath) {
  await showModel(name);
  const file = state.files.find((f) => f.path === videoPath);
  if (!file) {
    toast('That video is not where the ranking said it was', 'err');
    return;
  }
  playFile(file);
}

async function showModel(name) {
  $('#favModal').hidden = true;

  const adv = newAdvFilter();
  adv.models.set(name, 'in');
  // Carried over: arriving from "the top twenty for this tag" and landing on
  // everything they have ever done would contradict the ranking that sent you.
  adv.tags = new Map(favTags);
  adv.mode.tags = favTagMode;
  state.adv = adv;
  advDraft = newAdvFilter();
  syncAdvBadge();
  $('#searchInput').value = '';

  // Best first, since that is the whole point of arriving from a ranking.
  $('#sortSelect').value = 'rating';
  await saveConfig({ sort: 'rating', sortDir: 'desc' });
  syncSortButton();

  const root = state.config.homeDir || 'C:\\Users\\User\\OneDrive';
  $('#recursiveToggle').checked = true;
  $('#dirInput').value = root;
  await scan(root);
  const scoped = favFiltered() ? ' matching those tags' : '';
  toast(`${state.view.length.toLocaleString()} by ${name}${scoped}, best first`, 'ok');
}

/**
 * Narrows the listing to whatever state.adv now says.
 *
 * A filter can only narrow what has been scanned, and a scan is one level deep
 * -- so filtering below a folder whose videos live in subfolders would find
 * nothing, exactly as a search there used to. Clearing the filter does not
 * switch back: that would silently undo a flatten the user can see.
 */
async function commitFilter() {
  const needsRecursive = advActive() && state.totalBelow > state.files.length;
  if (needsRecursive && !$('#recursiveToggle').checked) {
    $('#recursiveToggle').checked = true;
    await scan(state.dir, { record: false });
  } else {
    render();
  }

  const shown = state.view.length;
  toast(advActive() ? `${shown} match${shown === 1 ? '' : 'es'}` : 'Filters cleared', 'ok');
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
  $('#advText').value = '';
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
  advDraft.text = $('#advText').value.trim();
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
  $('#advText').value = '';
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
    for (const [filePath, record] of Object.entries(data.records || {})) {
      if (record.error) { toast(record.error, 'err'); continue; }
      const file = state.files.find((f) => f.path === filePath);
      if (!file) continue;
      file.rating = record.rating;
      file.tags = record.tags;
      file.models = record.models;
      file.studio = record.studio;
      file.url = record.url;
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
    const keep = matchesQuery(file, terms) && (!advActive() || matchesAdvanced(file, state.adv));
    if (!keep) gone.add(path);
  }
  if (!gone.size) return;

  // Remember where the open video sat before it goes, so the player's arrows
  // still know which way is next.
  if (state.playing && gone.has(state.playing.path)) {
    const at = state.view.findIndex((f) => f.path === state.playing.path);
    state.playingAnchor = at >= 0 ? at : null;
  }

  state.view = state.view.filter((f) => !gone.has(f.path));
  for (const path of gone) {
    state.selected.delete(path);
    const card = document.querySelector(`.card[data-path="${CSS.escape(path)}"]`);
    if (!card) continue;
    card.remove();
    state.rendered = Math.max(0, state.rendered - 1); // one fewer of state.view on screen
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
      playFile(state.view[Math.min(at, state.view.length - 1)]);
      moved = true;
    }
  }

  const many = gone.size === 1 ? 'es' : '';
  toast(`${gone.size} no longer match${many} the filter`
    + (moved ? ' — on to the next' : ''), 'ok');
}

/** Repaints just the stars and chips, so an edit never disturbs a playing hover. */
function refreshCardRecord(file) {
  const card = document.querySelector(`.card[data-path="${CSS.escape(file.path)}"]`);
  if (card) {
    const row = card.querySelector('.record-row');
    if (row) row.replaceWith(buildRecordRow(file));
    // The source link lives on the folder line, so a url arriving by edit has
    // nowhere to appear unless that line is rebuilt too.
    const line = card.querySelector('.folder-line');
    if (line) line.replaceWith(buildFolderLine(file));
  }
  // The player shows the same row, so an edit made in either place has to land
  // in both — otherwise the footer keeps showing the rating you just changed.
  if (state.playing && state.playing.path === file.path) buildPlayerRecord(file);
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
    single: true,
  },
};

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
  const vocab = { models: state.modelVocab, studio: state.studioVocab }[field] || state.tagVocab;
  return vocab.slice().sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { numeric: true, sensitivity: 'base' }));
}

function syncTagVocab() {
  // The favourites panel draws its chips from the same vocabulary, so a panel
  // opened before it arrived — or open while a tag is renamed — is redrawn here
  // rather than being left showing "no tags yet".
  if (!$('#favModal').hidden) renderFavTags();

  for (const [field, id] of [['tags', '#tagVocab'], ['models', '#modelVocab'], ['studio', '#studioVocab']]) {
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
  // Across several videos a shared studio is a sensible starting point; a mixed
  // selection starts blank, so Add leaves each one's own studio alone.
  const studios = new Set(files.map((f) => f.studio || ''));
  $('#studioInput').value = studios.size === 1 ? [...studios][0] : '';
  $('#tagHint').textContent = single
    ? 'Add appends, Replace overwrites — every section at once. Right-click a chip on the card to remove one.'
    : `Add appends to each video's existing tags and models. Replace overwrites all ${files.length}.`;
  $('#tagReplace').textContent = single ? 'Replace' : `Replace on ${files.length}`;
  $('#tagAdd').textContent = single ? 'Add' : `Add to ${files.length}`;

  syncTagVocab();
  renderTagSuggestions();
  $('#tagModal').hidden = false;
  $('#tagInput').focus();
  $('#tagInput').select();
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
    const extra = { models: ' chip-model', studio: ' chip-studio' }[field] || '';
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
  const paths = state.tagTargets.map((f) => f.path);

  $('#tagModal').hidden = true;
  // One request for every field: separate ones would mean separate saves,
  // separate vocabulary refreshes, and a window where a card shows half the
  // edit. Add leaves a blank studio box alone, since there is nothing to append
  // to a field that holds one value; Replace sends it either way, so clearing
  // the box is how you clear the studio.
  await editRecords(paths, mode === 'add'
    ? { addTags: tags, addModels: models, ...(studio ? { studio } : {}) }
    : { tags, models, studio });

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

const spriteObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    spriteObserver.unobserve(entry.target);
    loadPoster(entry.target);
  }
}, { root: scrollRoot, rootMargin: '400px 0px' });

/**
 * Folder covers fetch the same poster but apply it themselves. applyThumb() is
 * written for the 16:9 video tiles — letting it style a 62x36 cover box is what
 * made cover-bearing folder rows taller than plain ones.
 */
/**
 * The favourites overlay can ask for thirty performers' worth of thumbnails at
 * once, which is three hundred requests for a panel showing two rows. They load
 * as they come into view instead, the same way folder covers do.
 */
const favObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    favObserver.unobserve(el);
    // allowCloud stays off: a cloud file gets OneDrive's own thumbnail, which
    // costs ~16KB and hydrates nothing, or it stays a plain tile.
    loadThumb(el.dataset.path, null).then((url) => {
      if (!url) return;
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.classList.add('has-shot');
    });
  }
}, { root: document.getElementById('favBody'), rootMargin: '200px 0px' });

const folderObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    folderObserver.unobserve(el);
    loadThumb(el.dataset.path, null).then((url) => {
      if (!url) return;
      el.style.backgroundImage = `url("${url}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    });
  }
}, { rootMargin: '300px 0px' });

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

  const request = (async () => {
    try {
      const res = await fetch(`/api/sprite?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `sprite failed (${res.status})`);
      }
      const frames = Number(res.headers.get('X-Sprite-Frames')) || 10;
      const blob = await res.blob();
      const entry = { url: URL.createObjectURL(blob), frames };
      state.sprites.set(filePath, entry);
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
    Number(state.config.dwellMs) || 1000,
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
    }, Number(state.config.dwellMs) || 1000);
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
    state.files = state.files.filter((f) => !removed.has(f.path));
    removed.forEach((p) => state.selected.delete(p));
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

function playFile(file) {
  stopLive(); // free the hover decoder before opening a second one
  state.playing = file;
  state.playingAnchor = null; // this one is in the listing until told otherwise
  buildPlayerActions(file);
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
  const list = state.view;
  if (!state.playing || !list.length) return;
  const at = list.findIndex((f) => f.path === state.playing.path);

  // An edit can filter the open video out of the listing while you are watching
  // it. The arrows then work from the slot it vacated: forward lands on whatever
  // slid into that slot, back on the one before it.
  const target = at >= 0
    ? at + step
    : (state.playingAnchor === null ? null : state.playingAnchor + (step > 0 ? 0 : -1));
  if (target === null) return;

  playFile(list[((target % list.length) + list.length) % list.length]);
}

function syncPlayerNav() {
  const list = state.view;
  const at = state.playing ? list.findIndex((f) => f.path === state.playing.path) : -1;
  const adrift = Boolean(at < 0 && state.playing && state.playingAnchor !== null && list.length);
  const usable = (at >= 0 && list.length > 1) || adrift;
  $('#playerPrev').hidden = !usable;
  $('#playerNext').hidden = !usable;

  // Reads as a sentence rather than "3 / 2112", since it now sits in the
  // details popup instead of beside the arrows.
  const pos = $('#playerPos');
  pos.hidden = !state.playing;
  if (at >= 0) {
    pos.textContent = `${(at + 1).toLocaleString()} of ${list.length.toLocaleString()} in this listing`;
  } else if (adrift) {
    pos.textContent = `filtered out · ${list.length.toLocaleString()} still listed`;
  } else {
    pos.textContent = '';
  }
}

/**
 * The player opens on the same 10-segment preview the thumbnail shows, just
 * bigger — so you can tell what a video is before committing to watching it.
 * Playback starts only when you press ▶.
 *
 * The native controls stay hidden until then. They would be scrubbing a
 * preview rather than a playthrough, and their play button would be
 * indistinguishable from the seeking this does to render each segment.
 */
const preview = { timer: null, index: 0, count: 10 };

function startPlayerPreview() {
  stopPlayerPreview();
  const player = $('#player');
  preview.count = Math.max(2, Number(state.config.frames) || 10);
  preview.index = 0;

  player.controls = false;
  player.muted = true; // a preview that blares audio is not a preview
  player.loop = false;
  $('#playerPlay').hidden = false;
  $('#playerBadge').hidden = false;

  const show = (index) => {
    preview.index = index;
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
    if (duration <= 0) return; // metadata not in yet; the timer retries
    const at = segmentTime(duration, index, preview.count);
    try { player.currentTime = at; } catch { return; }
    const played = player.play();
    if (played && played.catch) played.catch(() => {});
    $('#playerBadge').textContent = `${index + 1}/${preview.count} · ${fmtDuration(at)}`;
  };

  player.addEventListener('loadedmetadata', () => show(0), { once: true });
  if (player.readyState >= 1) show(0);

  preview.timer = setInterval(
    () => show((preview.index + 1) % preview.count),
    Number(state.config.dwellMs) || 1000,
  );
}

function stopPlayerPreview() {
  clearInterval(preview.timer);
  preview.timer = null;
}

/**
 * ▶ turns the preview into a real playthrough: controls back, from the top,
 * and audible only if the session has sound. A muted playthrough is still the
 * whole video rather than ten sampled seconds, and the native controls are
 * there to unmute if that is what you meant.
 */
function beginPlayback() {
  stopPlayerPreview();
  const player = $('#player');
  $('#playerPlay').hidden = true;
  $('#playerBadge').hidden = true;
  player.controls = true;
  player.muted = !soundOn;
  player.volume = masterVolume();
  try { player.currentTime = 0; } catch { /* not seekable yet; it will start at 0 anyway */ }
  const played = player.play();
  if (played && played.catch) played.catch(() => {});
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
  folderObserver.disconnect();
  grid.innerHTML = '';

  renderBreadcrumb();
  renderFolders();

  state.rendered = 0;
  $('#filesSection').hidden = state.files.length === 0;
  appendPage();

  updateSelectionBar();
  renderEmptyState();
  updateStatusLine();
}

function pageSize() {
  return Math.max(4, Number(state.config.pageSize) || 24);
}

/** Renders the next page only. Nothing below the fold costs anything. */
function appendPage() {
  const grid = $('#grid');
  const start = state.rendered;
  const end = Math.min(state.view.length, start + pageSize());
  const batch = [];

  for (let index = start; index < end; index += 1) {
    const file = state.view[index];
    grid.appendChild(buildCard(file, index));
    batch.push(file);
  }
  state.rendered = end;

  syncFileCount();
  renderPager();
  fetchMetaFor(batch);   // probe just this page, local files only
  updateStatusLine();
}

/** Loaded of matching, or matching of scanned — whichever the listing is short of. */
function syncFileCount() {
  $('#fileCount').textContent = state.rendered < state.view.length
    ? `(${state.rendered} of ${state.view.length})`
    : `(${state.view.length}${state.view.length === state.files.length ? '' : ' of ' + state.files.length})`;
}

function renderPager() {
  let pager = $('#pager');
  if (pager) pager.remove();

  const remaining = state.view.length - state.rendered;
  if (remaining <= 0) return;

  pager = document.createElement('div');
  pager.id = 'pager';
  pager.className = 'pager';

  const btn = document.createElement('button');
  btn.className = 'btn btn-primary';
  btn.textContent = `Load ${Math.min(remaining, pageSize())} more`;
  btn.addEventListener('click', () => appendPage());
  pager.appendChild(btn);

  const note = document.createElement('span');
  note.className = 'hint';
  note.textContent = `${remaining} not loaded yet`;
  pager.appendChild(note);

  $('#filesSection').appendChild(pager);

  // Auto-load when the pager scrolls into view, so scrolling just works.
  pagerObserver.disconnect();
  pagerObserver.observe(pager);
}

const pagerObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      pagerObserver.unobserve(entry.target);
      appendPage();
    }
  }
}, { root: scrollRoot, rootMargin: '200px 0px' });

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

/** One batched probe per page. Cloud files are skipped so nothing downloads. */
async function fetchMetaFor(files) {
  // Cloud files included: the server answers from cache when it has an entry
  // and returns {skipped} otherwise, so this never causes a download.
  const paths = files
    .filter((f) => !state.metaAsked.has(f.path))
    .map((f) => f.path);
  if (!paths.length) return;

  paths.forEach((p) => state.metaAsked.add(p));
  try {
    const { meta } = await api('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    for (const [filePath, info] of Object.entries(meta)) {
      if (!info || info.error || info.skipped) continue;
      state.meta.set(filePath, info);
      updateCardMeta(filePath);
    }
  } catch (err) {
    toast('Metadata failed: ' + err.message, 'err');
  }
}

/** Fills in duration/resolution once a probe lands, without a full re-render. */
function updateCardMeta(filePath) {
  const card = document.querySelector(`.card[data-path="${CSS.escape(filePath)}"]`);
  if (!card) return;
  const file = state.files.find((f) => f.path === filePath);
  if (!file) return;

  const info = state.meta.get(filePath) || {};
  const line = card.querySelector('.meta-line');
  if (line) line.innerHTML = metaLineHtml(file, info);

  const badge = card.querySelector('.badge-duration');
  if (badge && info.duration) badge.textContent = fmtDuration(info.duration);

  const preview = card.querySelector('.preview');
  if (preview && info.duration) preview.dataset.duration = String(info.duration);
}

function renderEmptyState() {
  const empty = $('#empty');
  if (state.files.length || state.folders.length) { empty.hidden = true; return; }
  empty.hidden = false;
  empty.innerHTML = '<p class="empty-title">Nothing here.</p><p>No videos and no subfolders in this folder.</p>';
}

function buildCard(file, index) {
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
    playFile(file);
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
    if (!selecting) { playFile(file); return; }
    if (ev.shiftKey) ev.preventDefault(); // stop shift-click text selection
    toggleSelect(file.path, index, ev.shiftKey);
  });

  selectMark.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    toggleSelect(file.path, index, ev.shiftKey);
  });
  selectMark.title = 'Select';

  attachHover(preview, file);
  // Cloud tiles are observed too: the server serves an already-cached poster
  // and answers 409 when there is none, so nothing gets downloaded either way.
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

/** Explicit, per-file consent to hydrate a cloud placeholder. */
async function optInCloud(file, card) {
  if (!window.confirm(
    `"${file.name}" is not downloaded.\n\n`
    + `Generating a preview makes OneDrive download the whole file (${fmtBytes(file.size)}).\n\nContinue?`,
  )) return;

  state.cloudOptIn.add(file.path);
  const preview = card.querySelector('.preview');
  if (preview) preview.classList.add('loading');

  await loadThumb(file.path, preview, true);

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
  toast('Downloaded — hover now previews it', 'ok');
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

// ---------------------------------------------------------------- selection

function toggleSelect(filePath, index, shiftKey) {
  if (shiftKey && state.lastClickedIndex >= 0) {
    const [from, to] = [state.lastClickedIndex, index].sort((a, b) => a - b);
    for (let i = from; i <= to; i += 1) state.selected.add(state.view[i].path);
  } else if (state.selected.has(filePath)) {
    state.selected.delete(filePath);
  } else {
    state.selected.add(filePath);
  }
  state.lastClickedIndex = index;
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

// -------------------------------------------------------------- build queue

/** The button does different work per engine, so it says which. */
function syncBuildAllLabel() {
  const btn = $('#buildAllBtn');
  if (!btn) return;
  const sprite = state.config.previewMode === 'sprite';
  btn.textContent = sprite ? 'Build all previews' : 'Build all thumbnails';
  btn.title = sprite
    ? 'Pre-render the 10-frame sprite strip for every video listed, instead of waiting for each hover'
    : 'Pre-render the still thumbnail for every video listed, instead of waiting to scroll to each one. Hover previews need no pre-building.';
}

async function buildAllPreviews() {
  const sprite = state.config.previewMode === 'sprite';
  const have = sprite ? state.sprites : state.thumbs;
  // Cloud files are skipped — building one would download it.
  const targets = state.view
    .filter((f) => !f.cloudOnly && !have.has(f.path) && !state.failed.has(f.path))
    .map((f) => f.path);

  const skipped = state.view.filter((f) => f.cloudOnly).length;
  if (!targets.length) {
    toast(skipped ? `Nothing to build — ${skipped} are cloud-only` : 'Already built', 'ok');
    return;
  }
  if (targets.length > 200 && !window.confirm(
    `Build ${targets.length} ${sprite ? 'previews' : 'posters'}?\n\n`
    + `Roughly ${Math.ceil(targets.length * (sprite ? 0.9 : 0.1) / 60)} min of processing.`,
  )) return;

  const btn = $('#buildAllBtn');
  btn.disabled = true;
  let done = 0;
  const CONCURRENCY = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const filePath = targets[cursor];
      cursor += 1;
      const el = document.querySelector(`.preview[data-path="${CSS.escape(filePath)}"]`);
      if (sprite) await loadSprite(filePath, el);
      else await loadThumb(filePath, el);
      done += 1;
      setStatus(`Building ${sprite ? 'previews' : 'posters'}… ${done}/${targets.length}`);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  btn.disabled = false;
  const failures = targets.filter((p) => state.failed.has(p)).length;
  render();
  toast(failures ? `Built ${done - failures}, ${failures} failed` : `Built ${done}`, failures ? 'err' : 'ok');
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
    if (!player.controls) return; // a preview mutes itself; that is not a choice
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

  $('#buildAllBtn').addEventListener('click', buildAllPreviews);
  syncBuildAllLabel();

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
  $('#advText').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyAdvanced(); });
  for (const btn of document.querySelectorAll('[data-clear]')) {
    btn.addEventListener('click', () => {
      const what = btn.dataset.clear;
      if (what === 'cloud' || what === 'link') advDraft[what] = 'all';
      else advDraft[what === 'rating' ? 'ratings' : what].clear();
      renderAdvanced();
    });
  }

  // settings
  $('#favBtn').addEventListener('click', openFavourites);

  // The tag filter re-ranks on every change: there is nothing to apply, since
  // the list underneath *is* the result.
  for (const radio of document.querySelectorAll('input[name="favTagMode"]')) {
    radio.addEventListener('change', () => {
      favTagMode = radio.value;
      renderFavTags();
      loadFavourites();
    });
  }
  $('#favClear').addEventListener('click', () => {
    favTags = new Map();
    favTagMode = 'all';
    renderFavTags();
    loadFavourites();
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#setPreviewMode').value = state.config.previewMode === 'sprite' ? 'sprite' : 'live';
    $('#setPageSize').value = state.config.pageSize || 24;
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
    const pageSize = Math.max(4, Math.min(200, Number($('#setPageSize').value) || 24));
    const changed = frames !== state.config.frames
      || tileWidth !== state.config.tileWidth
      || previewMode !== state.config.previewMode
      || pageSize !== state.config.pageSize;

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
      frames, tileWidth, previewMode, pageSize, homeDir, homeFollowsAccount, homeFolders,
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
      syncBuildAllLabel();
      render();
      toast(previewMode === 'live' ? 'Live hover previews active' : 'Cached stills will build as you scroll', 'ok');
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
  $('#playerPlay').addEventListener('click', beginPlayback);
  $('#playerPrev').addEventListener('click', () => playSibling(-1));
  $('#playerNext').addEventListener('click', () => playSibling(1));

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
    || !$('#settingsModal').hidden || !$('#tagModal').hidden || !$('#advModal').hidden;
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
    if (!$('#volMenu').hidden) { toggleVolumeMenu(false); return; }
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
  // started the bare arrows belong to the video element, which seeks with them,
  // so from then on stepping needs Shift.
  if (!ev.ctrlKey && !ev.metaKey && !$('#playerModal').hidden
      && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    const previewing = !$('#playerPlay').hidden;
    if (previewing || ev.shiftKey) {
      ev.preventDefault();
      playSibling(ev.key === 'ArrowLeft' ? -1 : 1);
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
      previewMode: 'live', frames: 10, dwellMs: 1000, tileWidth: 640, cardWidth: 520,
      pageSize: 24, recursive: false, sortDir: 'desc', sort: 'rating',
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
  $('#sortSelect').value = state.config.sort || 'name';
  syncSortButton();
  $('#cardWidth').value = state.config.cardWidth || 520;
  document.documentElement.style.setProperty('--card-width', (state.config.cardWidth || 520) + 'px');
  syncVolumeUI();
  $('#dwellMs').value = state.config.dwellMs || 1000;
  $('#dwellLabel').textContent = ((state.config.dwellMs || 1000) / 1000).toFixed(1) + 's';

  // The vocabularies are library-wide, so they load once rather than per scan.
  api('/api/library').then((data) => {
    state.tagVocab = data.tags || [];
    // Both vocabularies, or the dialog's Models section sits empty until an edit
    // happens to bring the second one back with its response.
    state.modelVocab = data.models || [];
    state.studioVocab = data.studios || [];
    syncTagVocab();
  }).catch(() => {});

  if (start) scan(start);
}

init();
