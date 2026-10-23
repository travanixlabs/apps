'use strict';

/* Video Explorer front-end: sprite-scrubbing grid + hover quick actions. */

const $ = (sel) => document.querySelector(sel);

/** The only scrolling element — observers must measure against it, not the page. */
const scrollRoot = document.getElementById('scrollArea');

/**
 * Name order, made once. localeCompare with options builds a collator on every
 * call, and sorting 27,000 videos asks it some four hundred thousand times --
 * the sort spent most of its time setting up rather than comparing.
 *   BY_NAME        numbers in order, case and accents ignored
 *   BY_NAME_EXACT  numbers in order, case still telling two names apart
 *   BY_LETTERS     case and accents ignored, digits read one at a time
 */
const BY_NAME = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
const BY_NAME_EXACT = new Intl.Collator(undefined, { numeric: true }).compare;
const BY_LETTERS = new Intl.Collator(undefined, { sensitivity: 'base' }).compare;

// The facet tables, the filter object and the matcher live in filter.js, which
// the page loads before this file and the server requires. They were here until
// the folder tiles had to say how many videos in a subfolder match -- a question
// only the server can answer, since it is the only one holding those videos.
// Read them as globals below: CHOICES, CHOICE_FACETS, FACETS, LABEL_FACETS,
// NOTHING, SINGLE_VALUED, newAdvFilter, picked, choiceMatch, compileAdvanced,
// matchesAdvanced.

/**
 * The page's last line of defence. Inside the native window there is no
 * console anyone sees, so a throw in a timer or a promise nobody caught
 * used to vanish: the feature just stopped. Said as an error toast (a few a
 * minute at most) and sent to the server, whose daily log is where a report
 * can be read later.
 */
const pageErrors = { stamps: [] };
function reportPageError(what, err) {
  const message = err && err.message ? err.message : String(err || what);
  const stack = err && err.stack ? String(err.stack).slice(0, 2000) : '';
  const now = Date.now();
  pageErrors.stamps = pageErrors.stamps.filter((t) => now - t < 60000);
  if (pageErrors.stamps.length >= 3) return;
  pageErrors.stamps.push(now);
  try { toast(`${what}: ${message}`, 'err'); } catch { /* before the DOM is up */ }
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `${what}: ${message}`, stack }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* nothing left to do */ }
}
window.addEventListener('error', (ev) => {
  // A resource that failed to load (an image, a script) reports on its own
  // element and is not a page fault.
  if (ev.target && ev.target !== window && !(ev.error instanceof Error)) return;
  reportPageError('Something went wrong', ev.error || ev.message);
});
window.addEventListener('unhandledrejection', (ev) => {
  reportPageError('Something went wrong', ev.reason);
});

/**
 * Who the faces say is in each video, for the whole library, by key
 * (size:mtime). Fetched once from /api/faces/suggestions and again whenever
 * the status poll says the set moved; every listing entry is filled from it
 * as it arrives (hydrate), so the listing itself carries none -- at the root
 * they were a third of a 36MB reply, per navigation.
 */
const suggestionsByKey = new Map();
let suggestionsStamp = 0;
let suggestionsLoading = null;

const suggestionsKey = (file) => keyFor({ size: file.size, mtimeMs: file.mtimeMs });

async function loadSuggestions() {
  if (suggestionsLoading) return suggestionsLoading;
  suggestionsLoading = (async () => {
    try {
      const data = await api('/api/faces/suggestions');
      suggestionsByKey.clear();
      for (const [key, list] of Object.entries(data.videos || {})) suggestionsByKey.set(key, list);
      suggestionsStamp = Number(data.stamp) || 0;
      applySuggestions();
    } catch { /* the pills will say the faces are not available */ }
    suggestionsLoading = null;
  })();
  return suggestionsLoading;
}

/** A fresh set onto the listing in hand: changed cards redrawn, the view too if it reads them. */
function applySuggestions() {
  let changed = 0;
  for (const file of state.files) {
    const next = suggestionsByKey.get(suggestionsKey(file)) || [];
    const was = file.suggested || [];
    if (was.length === next.length && was.every((s, i) => s.name === next[i].name && s.score === next[i].score && s.band === next[i].band)) continue;
    file.suggested = next;
    changed += 1;
    if (typeof refreshCardRecord === 'function') refreshCardRecord(file);
  }
  if (!changed) return;
  // Grouped by what they suggest, or filtered on it, the page itself moves;
  // over an open video that waits, like a relist does.
  if (state.grouped === 'suggested' || advActive()) {
    if (typeof relistWhenFree === 'function' && !$('#playerModal').hidden) relistWhenFree();
    else render();
  }
}

/** Called from the status poll: the server's stamp against the one we hold. */
function syncSuggestions(stamp) {
  if (!Number.isFinite(Number(stamp)) || Number(stamp) === suggestionsStamp) return;
  loadSuggestions();
}

const state = {
  config: {},
  files: [],          // videos shown for the current folder
  byPath: new Map(),  // the same, by path -- only ever set through setFiles()
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
  // '' | 'models' | 'dupes' -- off, by who is credited, by copies of the same
  // video. Empty rather than false because everything downstream asks whether
  // it is grouped far more often than it asks how.
  grouped: '',
  groups: [],          // [{ key, name, files }] when grouped, favourites first
  slots: [],           // the grouped layout flattened: a heading or a card
  favourites: [],      // performer names marked a favourite, library-wide
  favSet: new Set(),   // the same, lower-cased, for asking about one video
  tagVocab: [],        // [{ tag, count }] across the whole library
  modelVocab: [],      // the same, for performer names
  tagTargets: [],      // files the open label dialog will edit
  adv: newAdvFilter(), // the advanced filter currently applied
  raceOf: new Map(),   // lower-cased performer name -> the race you gave her
};



/**
 * Which row draws which facet, and what each answer is called.
 *
 * One table rather than a loop each in the renderer: they differed only in
 * their host element and their labels, and every difference between them was a
 * chance for one to drift. Empty while no one-question facet is on the dialog.
 */
const CHOICE_ROWS = [
  ['#advFraming', 'framing', [['done', 'completed'], ['todo', 'not completed']]],
  ['#advFingerprint', 'fingerprint', [['done', 'completed'], ['todo', 'not completed']]],
  ['#advProfiling', 'profiling', [['done', 'completed'], ['todo', 'not completed']]],
  ['#advSuggestions', 'suggestions', [['some', 'suggested'], ['none', 'none suggested']]],
  ['#advStorage', 'storage', [['downloaded', 'downloaded'], ['cloud', 'cloud']]],
];


/**
 * The interface's pictures, in the toolbar's style: a 16-unit box, a 1.4
 * stroke in the text colour, no fill. Colour emoji came out of a different
 * font per machine and shouted over everything beside them.
 */
const svgIcon = (body, size = 14) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" `
  + 'aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" '
  + `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON_PATHS = {
  home: '<path d="M2.5 7.4 8 2.8l5.5 4.6M4 6.3v6.9h3V9.8h2v3.4h3V6.3"/>',
  folder: '<path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6h5.6c.7 0 1.2.5 1.2 1.2v6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z"/>',
  drive: '<rect x="1.8" y="4.5" width="12.4" height="7" rx="1.4"/><path d="M4.5 9h.01M7 9h4.5"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>',
  cloud: '<path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .3-5.6 4 4 0 0 0-7.6-.9A3.3 3.3 0 0 0 4.5 12.5z"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  rename: '<path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2z"/><path d="M9.4 4.1l2.5 2.5"/>',
  move: '<path d="M2.5 8h10M9 4.5 12.5 8 9 11.5"/>',
  trash: '<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.6 8.9h6.4l.6-8.9M6.7 6.8v4M9.3 6.8v4"/>',
  warn: '<path d="M8 2.3 14.2 13H1.8z"/><path d="M8 6.5v3M8 11.2h.01"/>',
};
const ICONS = Object.fromEntries(Object.entries(ICON_PATHS).map(([k, body]) => [k, svgIcon(body)]));

// The two availability icons: a cloud for cloud-only, a tray arrow for on this PC.
const ICON_CLOUD = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 12.5h7.2a2.8 2.8 0 0 0 .3-5.6 4 4 0 0 0-7.6-.9A3.3 3.3 0 0 0 4.5 12.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
const ICON_LOCAL = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5v7M5 6.8 8 9.8l3-3M3 11.5v2h10v-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Download the cloud-only ones, or free up the downloaded ones -- through
 * OneDrive's own pin / unpin, which it carries out in its own time. Only the
 * files that need it are sent. The listing is told straight away and checked
 * again a little later, once OneDrive has had a chance to act.
 */
async function setAvailability(files, want) {
  const todo = files.filter((f) => (want === 'download' ? f.cloudOnly : !f.cloudOnly));
  if (!todo.length) return;
  try {
    const out = await api('/api/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: todo.map((f) => f.path), want }),
    });
    let ok = 0;
    for (const f of todo) {
      if (!(out.results[f.path] || {}).ok) continue;
      ok += 1;
      f.cloudOnly = want === 'cloud';
      const live = fileAt(f.path);
      if (live && live !== f) live.cloudOnly = f.cloudOnly;
    }
    toast(want === 'download'
      ? `Downloading ${ok} video${ok === 1 ? '' : 's'} — OneDrive fetches them in the background`
      : `${ok} video${ok === 1 ? '' : 's'} set to cloud only — OneDrive frees the space shortly`,
    ok === todo.length ? 'ok' : 'err');
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  render();
  updateSelectionBar();
  if (state.playing) syncPlayerAvail(state.playing);
  // relistQuietly draws the page itself, and waits for an open player to close.
  setTimeout(() => relistWhenFree().catch(() => {}), 20000);
}

/** The player's availability button: what this video is, and a click switches it. */
function syncPlayerAvail(file) {
  const btn = $('#playerAvail');
  if (!btn) return;
  const cloud = Boolean(file.cloudOnly);
  btn.innerHTML = (cloud ? ICON_CLOUD : ICON_LOCAL)
    + `<span class="qbtn-label">${cloud ? 'Download' : 'Cloud'}</span>`;
  btn.classList.toggle('is-cloud', cloud);
  btn.title = cloud ? 'Cloud only — click to download to this PC'
    : 'Downloaded — click to free up space (cloud only)';
  btn.setAttribute('aria-label', btn.title);
}

/** Which radio group drives which facet's all/any. */
const MODE_INPUTS = [
  ['height', 'heightMode'], ['bust', 'bustMode'], ['body', 'bodyMode'], ['race', 'raceMode'],
  ['favourites', 'favouritesMode'], ['tags', 'tagMode'], ['models', 'modelMode'],
];

/** The performer rows of the dialog: facet, host, and what its "none" chip says. */
const PERSON_ROWS = [
  ['height', '#advHeight', 'no height'],
  ['bust', '#advBust', 'no bust'],
  ['body', '#advBody', 'no body'],
  ['race', '#advRace', 'no race'],
  ['favourites', '#advFavourites', 'no favourite'],
];

/**
 * How the listing is set up, as opposed to how the app is configured. A refresh
 * puts these back; card size, preview engine and the default folder are
 * preferences and survive it.
 */
// Ratings run 0 (unrated) to RATING_MAX (10, from shared/facets.js). They
// ran to 5 until 2026-10-05; the library doubled every one of them the first
// time it was opened after.
const RATING_VALUES = Array.from({ length: RATING_MAX + 1 }, (_, n) => n);

/** A rating as a filter chip: its stars, half one and all. */
function ratingChipLabel(value) {
  return value === 0 ? 'unrated' : starsNode(value);
}

/**
 * The digit a rating key means, from the physical key -- Shift+3 reports "#"
 * as its key, so the code is read instead. 0-5 only; anything else is null.
 */
function ratingDigit(ev) {
  const m = /^(?:Digit|Numpad)([0-5])$/.exec(ev.code || '');
  return m ? Number(m[1]) : null;
}

/** Shift, Alt or Ctrl held: the digit means that many stars and a half. */
const halfHeld = (ev) => ev.shiftKey || ev.altKey || ev.ctrlKey;

/**
 * Whether a key is a rating key at all. 0-5 alone, 0-4 with a modifier --
 * there is no five and a half.
 */
function isRatingKey(ev) {
  const digit = ratingDigit(ev);
  if (digit === null || ev.metaKey) return false;
  return !(halfHeld(ev) && digit === 5);
}

/**
 * A key as a rating: the digit is the stars, and Shift, Alt or Ctrl adds a
 * half -- Shift+3 is 3½, Shift+0 is ½. 0 alone clears. Pressing the rating a
 * video already has also clears it, the way clicking its lit star does.
 */
function keyRating(ev, files) {
  const digit = ratingDigit(ev);
  const want = digit * 2 + (halfHeld(ev) ? 1 : 0);
  if (!want) return 0;
  const all = files.length && files.every((f) => (Number(f.rating) || 0) === want);
  return all ? 0 : want;
}

/**
 * A stored rating (0-10) drawn as stars: 7 is three whole stars and a half
 * one -- the star glyph with only its left half gold.
 */
function starsNode(rating) {
  const r = Math.max(0, Math.min(RATING_MAX, Math.round(Number(rating) || 0)));
  const run = document.createElement('span');
  run.className = 'star-run';
  for (let i = 1; i <= Math.ceil(r / 2); i += 1) {
    const star = document.createElement('span');
    star.className = 'sr' + (r >= i * 2 ? '' : ' half');
    star.textContent = '\u2605';
    run.appendChild(star);
  }
  return run;
}

// fmtBytes, fmtDuration and starsNumber come from shared/format.js, which
// the phone loads too.

/** Lights a row of five for a value: whole stars, then a half if it is odd. */
function paintStarRow(wrap, value) {
  wrap.querySelectorAll('.star').forEach((star, i) => {
    const full = value >= (i + 1) * 2;
    const half = !full && value === i * 2 + 1;
    star.classList.toggle('on', full);
    star.classList.toggle('half', half);
    star.textContent = full || half ? '\u2605' : '\u2606';
  });
}

/**
 * Five stars, each worth two steps: the left half of a star is the half, the
 * right half the whole. Hovering previews where a click would land; clicking
 * the rating already held clears it.
 *
 * From the keyboard: Enter or Space on a star is the whole star (a keyboard
 * click has no position, and it used to land on the half every time), and
 * Left/Right step the rating by half a star. The row is a radiogroup that
 * says what it holds; each star is a radio that says whether it is lit.
 */
function buildStarRow(current, onPick, className = 'stars') {
  const wrap = document.createElement('span');
  wrap.className = className;
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', current ? `Rating: ${starsNumber(current)} of 5` : 'Rating: none');
  const at = (star, ev) => {
    const i = Number(star.dataset.n);
    // detail is 0 for a click the keyboard made: no pointer, so the whole star.
    if (!ev.detail && !ev.clientX && !ev.clientY) return i * 2;
    const box = star.getBoundingClientRect();
    return ev.clientX - box.left < box.width / 2 ? i * 2 - 1 : i * 2;
  };
  for (let i = 1; i <= RATING_MAX / 2; i += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.dataset.n = String(i);
    star.setAttribute('role', 'radio');
    star.setAttribute('aria-label', `Rate ${i} star${i === 1 ? '' : 's'}`);
    star.setAttribute('aria-checked', String(current >= i * 2 - 1));
    star.addEventListener('pointermove', (ev) => {
      const v = at(star, ev);
      paintStarRow(wrap, v);
      star.title = v === current ? 'Clear rating' : `Rate ${starsNumber(v)}`;
    });
    star.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const v = at(star, ev);
      onPick(v === current ? 0 : v);
    });
    wrap.appendChild(star);
  }
  wrap.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? 1
      : ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -1 : 0;
    if (!step && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    ev.stopPropagation();
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? RATING_MAX
      : Math.max(0, Math.min(RATING_MAX, current + step));
    if (next !== current) onPick(next);
  });
  wrap.addEventListener('pointerleave', () => paintStarRow(wrap, current));
  paintStarRow(wrap, current);
  return wrap;
}


const VIEW_DEFAULTS = { sort: 'rating', sortDir: 'desc', recursive: false, grouped: '' };
const RESET_KEY = 've-reset-home';
// The filters and the search, carried across an F5. Session storage, so it
// lasts exactly as long as this window: a fresh launch starts with none of it.
const VIEW_KEY = 've-view';
// Set by Ctrl+Shift+F5 on the way out: the reload that follows starts clean.
const HARD_KEY = 've-reset-view';

/** Drops filters, search and sort back to the defaults, saving as it goes. */
function resetView() {
  Object.assign(state.config, VIEW_DEFAULTS);
  state.grouped = '';
  syncGroupButton();
  saveConfig({ ...VIEW_DEFAULTS });
  state.adv = newAdvFilter();
  setAdvDraft(newAdvFilter());
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
const filterCtx = () => ({
  favSet: state.favSet, raceOf: state.raceOf,
  traitsOf: state.traits || new Map(), favTiers: state.favTiers || new Map(),
});

/** Whether the filter in force asks about anything that belongs to a performer. */
const personFiltered = () => PERSON_FIELDS.some((f) => state.adv[f] && state.adv[f].size);

// ----------------------------------------------------------------- utilities

// More than this at once is a wall over the grid; the oldest goes first.
const TOAST_CAP = 3;

function toast(message, kind = '', action = null) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.appendChild(text);
  // A toast with a button is an offer, and an offer needs time to be taken.
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-act';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { el.remove(); action.run(); });
    el.appendChild(btn);
  }
  // An error stays until it is read: it fading while you looked elsewhere was
  // how a failed move went unnoticed. So it carries its own way out.
  const sticky = kind === 'err';
  if (sticky) {
    el.setAttribute('role', 'alert');
    const x = document.createElement('button');
    x.className = 'toast-x';
    x.type = 'button';
    x.textContent = '\u00d7';
    x.title = 'Dismiss';
    x.setAttribute('aria-label', 'Dismiss');
    x.addEventListener('click', () => el.remove());
    el.appendChild(x);
  }
  host.appendChild(el);
  while (host.children.length > TOAST_CAP) host.firstElementChild.remove();
  if (sticky) return;
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
    // A message that asks you to do something has to outlast a glance.
  }, action ? 9000 : (kind === 'warn' ? 6000 : 3200));
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

/** A JSON POST, which is most of what the page asks the server. */
function post(url, payload) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
}

/**
 * A listing entry, with everything the server left out put back.
 *
 * Nine tenths of a library has no tags, no models and no rating, and saying so
 * 27,240 times was 8MB of "": [] per listing. The server now omits anything
 * that is merely the default and this puts them back on arrival, so nothing
 * below here has to know the difference.
 *
 * Any metadata the server already had comes with the entry too, which is what
 * spares the page a hundred and nine round trips asking for it.
 */
function hydrate(file) {
  if (file.meta) {
    state.meta.set(file.path, file.meta);
    state.metaAsked.add(file.path);
    delete file.meta;
  }
  // The same list the server slims by: shared/listing.js.
  fillListing(file);
  // The suggestions come by key from the set the page holds, not the listing.
  if (!file.suggested.length) file.suggested = suggestionsByKey.get(suggestionsKey(file)) || [];
  searchHay(file);
  return file;
}

const hydrateAll = (files) => (files || []).map(hydrate);

/**
 * What a bare search term is looked for in, lower-cased once per record rather
 * than once per record per keystroke. Name and subfolder only: the tags and
 * models are edited in place far too often to be safely held here, so the
 * matcher still reads those live. Called again wherever a video is renamed.
 */
function searchHay(file) {
  file._hay = (file.name + ' ' + file.relFolder).toLowerCase();
  return file._hay;
}

/**
 * The listing, and the same videos by path.
 *
 * A path lookup used to be state.files.find(), a walk of up to 27,000 records,
 * made per tile scrolled into view and per metadata chunk. Every replacement of
 * the listing goes through here so the map can never describe a different one;
 * a rename moves its entry by hand (see doAction).
 */
function setFiles(files) {
  state.files = files;
  state.byPath = new Map(files.map((f) => [f.path, f]));
}

/** A video of the current listing, by path; undefined for one that is not in it. */
const fileAt = (path) => state.byPath.get(path);

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
  forgetGroupOrder();

  setStatus('Scanning…');
  setLoadBar(null);
  $('#empty').hidden = true;
  try {
    // The scan always lists everything that is there. Narrowing to what is
    // downloaded is a filter, not a different listing — Advanced filters →
    // Availability — so the count in the heading stays honest about the folder.
    const data = await post('/api/scan', { dir: target, recursive: $('#recursiveToggle').checked });
    state.dir = data.dir;
    state.parent = data.parent;
    if (record) pushHistory(data.dir);
    state.selected.clear();
    state.lastClickedIndex = -1;
    state.meta.clear();
    state.metaAsked.clear();
    clearSprites();
    // After the clears: the listing carries what the server already knew about
    // each video's bytes, and that goes straight into the same store /api/meta
    // would have filled a hundred round trips later.
    setFiles(hydrateAll(data.files));
    state.folders = data.folders || [];
    state.totalBelow = data.totalBelow || 0;
    state.cloudBelow = data.cloudBelow || 0;
    // Which walk this listing came from. A folder served from the last walk of
    // it is confirmed against the disk in the background, and the status poll
    // is where we hear that it came back different.
    state.walkVersion = Number(data.walkVersion) || 0;
    state.walkStale = (Number(data.walkAge) || 0) > 0;
    $('#dirInput').value = data.dir;
    saveConfig({
      lastDir: data.dir,
      recursive: $('#recursiveToggle').checked,
    });
    render();
    if (scrollRoot) scrollRoot.scrollTop = 0;
  } catch (err) {
    setStatus('');
    setLoadBar(1);
    renderEmptyState(state.dir ? 'error' : 'onboarding');
    toast(err.message, 'err');
  }
}

/** Navigating into a folder is just a scan of that folder. */
function navigateTo(dir) {
  $('#dirInput').value = dir;
  scan(dir);
}

// ------------------------------------------------- helpers other files share

// Here rather than where they are mostly used, so a script loaded earlier
// never leans on one loaded after it (see the note in index.html).

function modalOpen() {
  return !$('#playerModal').hidden || !$('#pickerModal').hidden
    || !$('#settingsModal').hidden || !$('#tagModal').hidden || !$('#advModal').hidden
    || !$('#faceModal').hidden || !$('#keysModal').hidden;
}
/** The cards' detail line, on or off, from the setting. */
function syncCardDetails() {
  const grid = $('#grid');
  if (grid) grid.classList.toggle('no-details', !cardDetailsOn());
}
/**
 * The line under a card's name: when, how sharp, and where. The date is the
 * file's; the resolution only once a probe has read it; the subfolder only
 * where there is one to tell apart -- a flattened or recursive listing.
 */
function cardMetaText(file) {
  const info = state.meta.get(file.path) || {};
  const bits = [];
  if (info.duration) bits.push(fmtDuration(info.duration));
  if (info.width && info.height) {
    const lines = Math.min(info.width, info.height);
    bits.push(lines >= 2100 ? '4K' : `${lines}p`);
  }
  if (file.mtimeMs) {
    bits.push(new Date(file.mtimeMs).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    }));
  }
  // The subfolder, only where there is one: "." is the folder itself.
  if (file.relFolder && file.relFolder !== '.') bits.push(file.relFolder);
  return bits.join(' · ');
}

/**
 * The filter in force, under the search: a chip a facet, each with a cross
 * that clears just that facet. The dialog is where a filter is built; this is
 * where you see it, and take a piece of it back, without opening anything.
 */
const FACET_NAMES = {
  tags: 'Tags', ratings: 'Rating', models: 'Models', height: 'Height', bust: 'Bust',
  body: 'Body', race: 'Race', favourites: 'Favourites', framing: 'Framing',
  fingerprint: 'Duplicates', profiling: 'Faces', suggestions: 'Suggested',
  storage: 'Storage', suggestedPct: 'Suggested %', labelledPct: 'Labelled %',
};
const NONE_NAMES = {
  tags: 'no tags', models: 'no models', height: 'no height', bust: 'no bust',
  body: 'no body', race: 'no race', favourites: 'no favourite',
};

function facetValueText(facet, value) {
  if (value === NOTHING) return NONE_NAMES[facet] || 'none';
  if (facet === 'ratings') return value === 0 ? 'unrated' : `${starsNumber(value)}★`;
  if (RANGE_FACETS.includes(facet)) return `${String(value).replace('-', '–')}%`;
  const row = CHOICE_ROWS.find(([, f]) => f === facet);
  if (row) {
    const found = row[2].find(([v]) => v === value);
    return found ? found[1] : String(value);
  }
  return String(value);
}
function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}
/** Windows paths compare case-insensitively, and a trailing slash means nothing. */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
