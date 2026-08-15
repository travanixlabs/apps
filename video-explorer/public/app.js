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
  cloudHidden: 0,
  rendered: 0,        // how many of state.view are on screen (pagination)
  meta: new Map(),    // path -> probed metadata, filled in per page
  metaAsked: new Set(),
  cloudOptIn: new Set(), // cloud files the user explicitly chose to fetch
  playing: null,      // file open in the player modal
  selected: new Set(),
  lastClickedIndex: -1,
  sprites: new Map(),  // path -> { url, frames }
  thumbs: new Map(),   // path -> poster blob URL
  pending: new Map(),  // path -> in-flight poster/sprite promise
  failed: new Set(),
  picker: null,        // { dir, onConfirm, title }
  tagVocab: [],        // [{ tag, count }] across the whole library
  modelVocab: [],      // the same, for performer names
  tagTargets: [],      // files the open label dialog will edit
  labelField: 'tags',  // which field that dialog is editing
  adv: newAdvFilter(), // the advanced filter currently applied
  advTree: null,       // { folders, total } for the folder picker, loaded on open
};

/**
 * The advanced filter. Empty sets mean "no constraint" rather than "match
 * nothing", so a fresh filter is transparent and the UI never has to
 * special-case "everything is unchecked".
 */
function newAdvFilter() {
  return {
    text: '',
    folders: new Set(),   // relative folder paths, '.' being the scanned folder
    tags: new Set(),
    models: new Set(),
    tagMode: 'all',
    ratings: new Set(),   // 0 means unrated
    cloud: 'all',         // 'all' | 'downloaded' | 'cloud'
  };
}

function advActive(adv = state.adv) {
  return Boolean(adv.text) || adv.folders.size || adv.tags.size || adv.models.size
    || adv.ratings.size || adv.cloud !== 'all';
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
    const recursive = $('#recursiveToggle').checked ? '1' : '0';
    const cloud = $('#cloudToggle').checked ? '1' : '0';
    const data = await api(
      `/api/scan?dir=${encodeURIComponent(target)}&recursive=${recursive}&cloud=${cloud}`,
    );
    state.dir = data.dir;
    state.parent = data.parent;
    if (record) pushHistory(data.dir);
    state.files = data.files;
    state.folders = data.folders || [];
    state.totalBelow = data.totalBelow || 0;
    state.cloudBelow = data.cloudBelow || 0;
    state.cloudHidden = data.cloudHidden || 0;
    state.selected.clear();
    state.lastClickedIndex = -1;
    state.meta.clear();
    state.metaAsked.clear();
    clearSprites();
    $('#dirInput').value = data.dir;
    saveConfig({
      lastDir: data.dir,
      recursive: $('#recursiveToggle').checked,
      showCloud: $('#cloudToggle').checked,
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
    const relevant = state.config.showCloud ? folder.videoCount : downloaded;
    const tile = document.createElement('button');
    tile.className = 'folder-tile' + (relevant === 0 ? ' no-videos' : '');
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

  if (adv.folders.size) {
    // A selected folder includes everything beneath it, so picking a parent is
    // not silently narrower than picking its children.
    const rel = file.relFolder === '.' ? '' : file.relFolder.toLowerCase();
    const under = [...adv.folders].some((sel) => {
      const s = sel === '.' ? '' : sel.toLowerCase();
      return s === '' || rel === s || rel.startsWith(s + '\\') || rel.startsWith(s + '/');
    });
    if (!under) return false;
  }

  // Tags and models are matched the same way. The all/any switch governs both,
  // but each facet is checked on its own: picking two models and one tag means
  // "those models AND that tag", not one big pool.
  for (const field of ['tags', 'models']) {
    if (!adv[field].size) continue;
    const have = new Set((file[field] || []).map((t) => t.toLowerCase()));
    const wanted = [...adv[field]].map((t) => t.toLowerCase());
    const hit = adv.tagMode === 'any'
      ? wanted.some((t) => have.has(t))
      : wanted.every((t) => have.has(t));
    if (!hit) return false;
  }

  if (adv.ratings.size && !adv.ratings.has(file.rating || 0)) return false;

  if (adv.cloud === 'downloaded' && file.cloudOnly) return false;
  if (adv.cloud === 'cloud' && !file.cloudOnly) return false;

  return true;
}

function matchesQuery(file, terms) {
  const haystack = (file.name + ' ' + file.relFolder).toLowerCase();
  const values = (field) => (file[field] || []).map((t) => t.toLowerCase());
  return terms.every((term) => {
    if (term.field) return values(term.field).some((t) => t.includes(term.value));
    // A bare term searches everything: name, subfolder, tags and models.
    return haystack.includes(term.value)
      || values('tags').some((t) => t.includes(term.value))
      || values('models').some((t) => t.includes(term.value));
  });
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
    } else if (key === 'rating') {
      cmp = (Number(a.rating) || 0) - (Number(b.rating) || 0);
      // The name tiebreak is returned unflipped: within one rating band, names
      // should read A→Z whichever way the ratings are pointing. Multiplying it
      // by dir would put the unrated bulk in reverse alphabetical order.
      if (cmp === 0) return a.name.localeCompare(b.name, undefined, { numeric: true });
    } else {
      cmp = (Number(a[key]) || 0) - (Number(b[key]) || 0);
    }
    return cmp * dir;
  });

  state.view = list;
}

// -------------------------------------------------------------------- sort

const SORT_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'mtimeMs', label: 'Date modified' },
  { value: 'size', label: 'File size' },
  { value: 'duration', label: 'Duration' },
  { value: 'rating', label: 'Rating' },
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
  if (show) renderSortMenu();
  menu.hidden = !show;
  $('#sortBtn').classList.toggle('on', show);
}

// -------------------------------------------------------- advanced filters

// Edited in the dialog and only copied onto state.adv on Apply, so closing
// without applying changes nothing.
let advDraft = newAdvFilter();

async function openAdvanced() {
  advDraft = {
    ...state.adv,
    folders: new Set(state.adv.folders),
    tags: new Set(state.adv.tags),
    models: new Set(state.adv.models),
    ratings: new Set(state.adv.ratings),
  };
  $('#advText').value = advDraft.text;
  for (const radio of document.querySelectorAll('input[name="tagMode"]')) {
    radio.checked = radio.value === advDraft.tagMode;
  }
  $('#advModal').hidden = false;
  renderAdvanced();

  // The folder tree is a full walk of everything below here, so it is fetched
  // when the dialog opens rather than kept current on every scan.
  $('#advFolderCount').textContent = 'loading…';
  try {
    state.advTree = await api(`/api/folders?dir=${encodeURIComponent(state.dir)}`);
  } catch (err) {
    state.advTree = { folders: [], total: 0 };
    toast(err.message, 'err');
  }
  renderAdvanced();
}

function renderAdvanced() {
  // Rating, 0 standing for unrated — a facet in its own right, since "never
  // been looked at" is a thing you want to list.
  const ratings = $('#advRating');
  ratings.innerHTML = '';
  for (const value of [0, 1, 2, 3, 4, 5]) {
    ratings.appendChild(chipToggle(
      value === 0 ? 'unrated' : '★'.repeat(value),
      advDraft.ratings.has(value),
      () => { toggleIn(advDraft.ratings, value); renderAdvanced(); },
    ));
  }

  const cloud = $('#advCloud');
  cloud.innerHTML = '';
  for (const [value, label] of [['all', 'everything'], ['downloaded', 'downloaded only'], ['cloud', 'cloud only ☁']]) {
    cloud.appendChild(chipToggle(label, advDraft.cloud === value, () => {
      advDraft.cloud = value;
      renderAdvanced();
    }));
  }


  for (const [field, el, empty] of [
    ['models', '#advModels', 'No models yet — name someone from a card first.'],
    ['tags', '#advTags', 'No tags yet — add some from a card first.'],
  ]) {
    const box = $(el);
    const vocab = vocabFor(field);
    box.innerHTML = vocab.length ? '' : `<span class="dim">${empty}</span>`;
    for (const entry of vocab) {
      box.appendChild(chipToggle(`${entry.tag} · ${entry.count}`, advDraft[field].has(entry.tag), () => {
        toggleIn(advDraft[field], entry.tag);
        renderAdvanced();
      }));
    }
  }

  renderAdvFolders();
  updateAdvMatch();
}

function renderAdvFolders() {
  const wrap = $('#advFolders');
  wrap.innerHTML = '';
  const tree = state.advTree;
  if (!tree) { $('#advFolderCount').textContent = 'loading…'; return; }

  const find = $('#advFolderFind').value.trim().toLowerCase();
  const list = find
    ? tree.folders.filter((f) => f.rel.toLowerCase().includes(find))
    : tree.folders;

  $('#advFolderCount').textContent = list.length === tree.folders.length
    ? `(${tree.folders.length})`
    : `(${list.length} of ${tree.folders.length})`;

  if (!list.length) {
    wrap.innerHTML = '<span class="dim">No folders with videos below here.</span>';
    return;
  }

  for (const folder of list) {
    const row = document.createElement('label');
    row.className = 'folder-check';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = advDraft.folders.has(folder.rel);
    box.addEventListener('change', () => {
      toggleIn(advDraft.folders, folder.rel);
      updateAdvMatch();
    });
    row.appendChild(box);

    const name = document.createElement('span');
    name.className = 'fc-name';
    name.textContent = folder.rel === '.' ? 'this folder' : folder.rel;
    name.title = folder.rel;
    row.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'fc-meta';
    const downloaded = folder.count - folder.cloudCount;
    meta.textContent = folder.cloudCount
      ? `${downloaded} of ${folder.count}`
      : `${folder.count}`;
    meta.title = `${folder.count} videos · ${fmtBytes(folder.totalSize)}`;
    row.appendChild(meta);

    wrap.appendChild(row);
  }
}

/**
 * How many videos the draft would show, counted against the whole tree rather
 * than the current page — otherwise the number moves as you scroll.
 */
function updateAdvMatch() {
  const el = $('#advMatch');
  if (!advActive(advDraft)) { el.textContent = 'no filters — showing everything'; return; }
  const bits = [];
  if (advDraft.folders.size) bits.push(`${advDraft.folders.size} folder${advDraft.folders.size === 1 ? '' : 's'}`);
  if (advDraft.models.size) bits.push(`${advDraft.models.size} model${advDraft.models.size === 1 ? '' : 's'}`);
  if (advDraft.tags.size) bits.push(`${advDraft.tags.size} tag${advDraft.tags.size === 1 ? '' : 's'} (${advDraft.tagMode})`);
  if (advDraft.ratings.size) bits.push(`${advDraft.ratings.size} rating${advDraft.ratings.size === 1 ? '' : 's'}`);
  if (advDraft.cloud !== 'all') bits.push(advDraft.cloud);
  if (advDraft.text) bits.push(`"${advDraft.text}"`);
  el.textContent = bits.join(' · ');
}

function chipToggle(label, on, onClick) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip' + (on ? ' on' : '');
  chip.textContent = label;
  chip.addEventListener('click', onClick);
  return chip;
}

function toggleIn(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

async function applyAdvanced() {
  advDraft.text = $('#advText').value.trim();
  const mode = document.querySelector('input[name="tagMode"]:checked');
  advDraft.tagMode = mode ? mode.value : 'all';

  state.adv = advDraft;
  $('#advModal').hidden = true;
  syncAdvBadge();

  // Filtering by folder is meaningless against a single-level listing, so
  // selecting one switches the scan to recursive. Clearing the filter does not
  // switch back — that would silently undo a flatten the user asked for.
  const needsRecursive = state.adv.folders.size > 0;
  if (needsRecursive && !$('#recursiveToggle').checked) {
    $('#recursiveToggle').checked = true;
    await scan(state.dir, { record: false });
  } else {
    render();
  }

  const shown = state.view.length;
  toast(advActive() ? `${shown} match${shown === 1 ? '' : 'es'}` : 'Filters cleared', 'ok');
}

function resetAdvanced() {
  advDraft = newAdvFilter();
  $('#advText').value = '';
  $('#advFolderFind').value = '';
  renderAdvanced();
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
    for (const [filePath, record] of Object.entries(data.records || {})) {
      if (record.error) { toast(record.error, 'err'); continue; }
      const file = state.files.find((f) => f.path === filePath);
      if (!file) continue;
      file.rating = record.rating;
      file.tags = record.tags;
      file.models = record.models;
      refreshCardRecord(file);
    }
    syncTagVocab();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Repaints just the stars and chips, so an edit never disturbs a playing hover. */
function refreshCardRecord(file) {
  const card = document.querySelector(`.card[data-path="${CSS.escape(file.path)}"]`);
  if (card) {
    const row = card.querySelector('.record-row');
    if (row) row.replaceWith(buildRecordRow(file));
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
 * Models and tags are the same shape, so one builder covers both. They stay
 * separate fields rather than a tag naming convention: a performer wants their
 * own filter facet, and a name that collides with a tag would be ambiguous.
 */
const LABEL_FIELDS = {
  tags: { prefix: '#', empty: '+ tag', edit: 'Edit tags', chip: 'chip' },
  models: { prefix: '@', empty: '+ model', edit: 'Edit models', chip: 'chip chip-model' },
};

function buildLabelChips(file, field) {
  const spec = LABEL_FIELDS[field];
  const Field = field[0].toUpperCase() + field.slice(1);
  const chips = document.createElement('span');
  chips.className = 'chips';

  for (const value of file[field] || []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = spec.chip;
    chip.textContent = value;
    chip.title = `Filter by "${value}" — right-click to remove it from this video`;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // The prefix scopes the search to this field, so clicking "hd" does not
      // also drag in every file merely named that way.
      $('#searchInput').value = spec.prefix + value;
      render();
    });
    chip.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      editRecords([file.path], { ['remove' + Field]: [value] });
    });
    chips.appendChild(chip);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = spec.chip + ' chip-add';
  add.textContent = (file[field] || []).length ? '+' : spec.empty;
  add.title = spec.edit;
  add.addEventListener('click', (ev) => { ev.stopPropagation(); openLabelDialog([file], field); });
  chips.appendChild(add);

  return chips;
}

function buildRecordRow(file) {
  const row = document.createElement('div');
  row.className = 'record-row';

  row.appendChild(buildStars(file.rating || 0, (rating) => editRecords([file.path], { rating }), { compact: true }));

  row.appendChild(buildLabelChips(file, 'models'));
  row.appendChild(buildLabelChips(file, 'tags'));
  return row;
}

function vocabFor(field) {
  return field === 'models' ? state.modelVocab : state.tagVocab;
}

function syncTagVocab() {
  const list = $('#tagVocab');
  if (!list) return;
  list.innerHTML = '';
  for (const entry of vocabFor(state.labelField)) {
    const option = document.createElement('option');
    option.value = entry.tag;
    option.label = `${entry.count}`;
    list.appendChild(option);
  }
}

function parseTags(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

/** One dialog for both fields — only the wording and the vocabulary differ. */
function openLabelDialog(files, field = 'tags') {
  if (!files.length) return;
  state.tagTargets = files;
  state.labelField = field;
  const single = files.length === 1;
  const noun = field === 'models' ? 'model' : 'tag';

  $('#tagTitle').textContent = single
    ? `${field === 'models' ? 'Models' : 'Tags'} · ${files[0].name}`
    : `${field === 'models' ? 'Models' : 'Tags'} · ${files.length} videos`;
  // Pre-filling with one file's values makes Replace a sensible edit. Across
  // many files there is no shared starting point, so the box starts empty and
  // Add is the safe verb.
  $('#tagInput').value = single ? (files[0][field] || []).join(', ') : '';
  $('#tagInput').placeholder = field === 'models' ? 'performer names, comma separated' : 'comma separated';
  $('#tagHint').textContent = single
    ? `Add appends, Replace overwrites. Right-click a chip on the card to remove one ${noun}.`
    : `Add appends to each video's existing ${noun}s. Replace overwrites all ${files.length}.`;
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
  const box = $('#tagSuggest');
  box.innerHTML = '';
  const used = new Set(parseTags($('#tagInput').value).map((t) => t.toLowerCase()));
  for (const entry of vocabFor(state.labelField).slice(0, 60)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip suggest' + (used.has(entry.tag.toLowerCase()) ? ' on' : '');
    chip.textContent = `${entry.tag} · ${entry.count}`;
    chip.addEventListener('click', () => {
      const current = parseTags($('#tagInput').value);
      const at = current.findIndex((t) => t.toLowerCase() === entry.tag.toLowerCase());
      if (at >= 0) current.splice(at, 1);
      else current.push(entry.tag);
      $('#tagInput').value = current.join(', ');
      renderTagSuggestions();
    });
    box.appendChild(chip);
  }
}

async function commitTags(mode) {
  const values = parseTags($('#tagInput').value);
  const paths = state.tagTargets.map((f) => f.path);
  const field = state.labelField;
  const Field = field[0].toUpperCase() + field.slice(1);
  const noun = field === 'models' ? 'model' : 'tag';

  $('#tagModal').hidden = true;
  await editRecords(paths, mode === 'add' ? { ['add' + Field]: values } : { [field]: values });
  toast(mode === 'add'
    ? `Added ${values.length} ${noun}${values.length === 1 ? '' : 's'} to ${paths.length} video${paths.length === 1 ? '' : 's'}`
    : `${Field} set on ${paths.length} video${paths.length === 1 ? '' : 's'}`, 'ok');
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
  $('#playerModal').hidden = false;
  syncPlayerNav();
  startPlayerPreview();
}

/**
 * Walks the listing you can see -- state.view, so the arrows follow the current
 * filter and sort rather than the folder on disk. Wraps at both ends, which
 * keeps the buttons live instead of leaving one dead at each edge.
 */
function playSibling(step) {
  const list = state.view;
  if (!state.playing || list.length < 2) return;
  const at = list.findIndex((f) => f.path === state.playing.path);
  if (at < 0) return; // an edit filtered the open video out of the listing
  playFile(list[(at + step + list.length) % list.length]);
}

function syncPlayerNav() {
  const list = state.view;
  const at = state.playing ? list.findIndex((f) => f.path === state.playing.path) : -1;
  const usable = list.length > 1 && at >= 0;
  $('#playerPrev').hidden = !usable;
  $('#playerNext').hidden = !usable;
  // Reads as a sentence rather than "3 / 2112", since it now sits in the
  // details popup instead of beside the arrows.
  const pos = $('#playerPos');
  pos.hidden = at < 0;
  pos.textContent = at < 0
    ? ''
    : `${(at + 1).toLocaleString()} of ${list.length.toLocaleString()} in this listing`;
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

/** ▶ turns the preview into a real playthrough: sound on, controls back, from the top. */
function beginPlayback() {
  stopPlayerPreview();
  const player = $('#player');
  $('#playerPlay').hidden = true;
  $('#playerBadge').hidden = true;
  player.controls = true;
  player.muted = false;
  try { player.currentTime = 0; } catch { /* not seekable yet; it will start at 0 anyway */ }
  const played = player.play();
  if (played && played.catch) played.catch(() => {});
}

function closePlayer() {
  $('#player').onloadedmetadata = null;
  releasePlayer();
  $('#playerActions').innerHTML = '';
  state.playing = null;
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

  $('#fileCount').textContent = state.rendered < state.view.length
    ? `(${state.rendered} of ${state.view.length})`
    : `(${state.view.length}${state.view.length === state.files.length ? '' : ' of ' + state.files.length})`;

  renderPager();
  fetchMetaFor(batch);   // probe just this page, local files only
  updateStatusLine();
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
  if (state.cloudHidden) {
    bits.push(`${state.cloudHidden.toLocaleString()} cloud items hidden ☁`);
  }
  if (!state.config.recursive && state.totalBelow > state.files.length + state.cloudHidden) {
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

  const folderLine = document.createElement('div');
  folderLine.className = 'folder-line';
  folderLine.textContent = `${fmtDate(file.mtimeMs)}  •  ${file.relFolder === '.' ? 'this folder' : file.relFolder}`;
  folderLine.title = file.folder;
  details.appendChild(folderLine);

  card.appendChild(details);
  attachDrag(card, file, index);
  return card;
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
    // Card-only: the player footer carries the rating and label row itself, so
    // these would be a second way to reach what is already sitting next to them.
    ...(inPlayer ? [] : [
      {
        icon: '⌗',
        title: 'Tags',
        run: () => openLabelDialog([state.files.find((f) => f.path === file.path) || file], 'tags'),
      },
      {
        icon: '☺',
        title: 'Models',
        run: () => openLabelDialog([state.files.find((f) => f.path === file.path) || file], 'models'),
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
  $('#cloudToggle').addEventListener('change', () => scan());

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
    searchTimer = setTimeout(render, 140);
  });

  $('#sortBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSortMenu();
  });
  // Any click elsewhere dismisses it, which is what a menu is expected to do.
  document.addEventListener('click', (ev) => {
    if (!$('#sortMenu').hidden && !ev.target.closest('.menu-host')) toggleSortMenu(false);
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
      if (op === 'tags') return openLabelDialog(state.files.filter((f) => state.selected.has(f.path)), 'tags');
      if (op === 'models') return openLabelDialog(state.files.filter((f) => state.selected.has(f.path)), 'models');
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
  $('#tagInput').addEventListener('input', renderTagSuggestions);
  $('#tagInput').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    // Enter does the safe thing for the context: replacing one video's tags is
    // what the pre-filled box implies, but across a selection it must append.
    commitTags(state.tagTargets.length === 1 ? 'replace' : 'add');
  });

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
  $('#advFolderFind').addEventListener('input', renderAdvFolders);
  $('#advText').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyAdvanced(); });
  for (const btn of document.querySelectorAll('[data-clear]')) {
    btn.addEventListener('click', () => {
      const what = btn.dataset.clear;
      if (what === 'cloud') advDraft.cloud = 'all';
      else advDraft[what === 'rating' ? 'ratings' : what].clear();
      renderAdvanced();
    });
  }

  // settings
  $('#settingsBtn').addEventListener('click', () => {
    $('#setPreviewMode').value = state.config.previewMode === 'sprite' ? 'sprite' : 'live';
    $('#setPageSize').value = state.config.pageSize || 24;
    $('#setFrames').value = state.config.frames;
    $('#setTileWidth').value = state.config.tileWidth;
    $('#setScrub').checked = !!state.config.scrubWithMouse;
    $('#setHomeDir').value = state.config.homeDir || '';
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
    const homeFollowsAccount = $('#setHomeFollow').checked;
    const wasFollowing = state.config.homeFollowsAccount !== false;
    const homeChanged = homeFollowsAccount !== wasFollowing
      || (!homeFollowsAccount && !samePath(homeDir, state.config.homeDir));

    await saveConfig({
      frames, tileWidth, previewMode, pageSize, homeDir, homeFollowsAccount,
      scrubWithMouse: $('#setScrub').checked,
    });
    $('#settingsModal').hidden = true;
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

function onKeyDown(ev) {
  // Escape always unwinds one layer: topmost modal first, then the selection.
  if (ev.key === 'Escape') {
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
    openLabelDialog(state.files.filter((f) => state.selected.has(f.path)), 'tags');
  } else if (ev.key === 'n' || ev.key === 'N') {
    ev.preventDefault();
    openLabelDialog(state.files.filter((f) => state.selected.has(f.path)), 'models');
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
      pageSize: 24, showCloud: true, recursive: false, sortDir: 'desc', sort: 'rating',
    };
  }

  // A cold launch opens the default folder: starting somewhere predictable beats
  // resuming somewhere forgotten, and the last folder is a click deep from home
  // anyway. A refresh is the opposite case — you are already somewhere and only
  // want the page rebuilt — so it resumes the folder you were in.
  const reloaded = (performance.getEntriesByType('navigation')[0] || {}).type === 'reload';
  const start = (reloaded ? state.config.lastDir : '')
    || state.config.homeDir || state.config.lastDir || '';
  $('#dirInput').value = start;
  $('#recursiveToggle').checked = state.config.recursive === true;
  $('#cloudToggle').checked = state.config.showCloud === true;
  $('#sortSelect').value = state.config.sort || 'name';
  syncSortButton();
  $('#cardWidth').value = state.config.cardWidth || 520;
  document.documentElement.style.setProperty('--card-width', (state.config.cardWidth || 520) + 'px');
  $('#dwellMs').value = state.config.dwellMs || 1000;
  $('#dwellLabel').textContent = ((state.config.dwellMs || 1000) / 1000).toFixed(1) + 's';

  // The tag vocabulary is library-wide, so it loads once rather than per scan.
  api('/api/library').then((data) => {
    state.tagVocab = data.tags || [];
    syncTagVocab();
  }).catch(() => {});

  if (start) scan(start);
}

init();
