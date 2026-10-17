'use strict';

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

/** Whether anyone named in this video is marked a favourite. */
const isFavouriteModel = (name) => state.favSet.has(String(name || '').trim().toLowerCase());

/** Keeps the lower-cased lookup set in step with the list the server sent. */
function setFavourites(list, tiers) {
  state.favourites = Array.isArray(list) ? list : [];
  state.favSet = new Set(state.favourites.map((n) => String(n).toLowerCase()));
  if (tiers && typeof tiers === 'object') state.favTiers = new Map(Object.entries(tiers));
  state.raceVersion = (state.raceVersion || 0) + 1;
}

/** A favourite's tier, 1 (the most) to 3; 0 for somebody who is not one. */
function favouriteTier(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!state.favSet.has(key)) return 0;
  return (state.favTiers && state.favTiers.get(key)) || 3;
}

/** Height, bust and body, per performer, as the server holds them. */
const TRAITS = {
  height: ['Tall', 'Average', 'Small'],
  bust: ['Massive', 'Big', 'Average', 'Small'],
  body: ['Athletic', 'Tattoos', 'Curvy', 'Average', 'Petite'],
};

function setTraits(map) {
  state.traits = new Map(Object.entries(map && typeof map === 'object' ? map : {}));
  state.raceVersion = (state.raceVersion || 0) + 1;
}

const traitsOfName = (name) => (state.traits && state.traits.get(String(name || '').trim().toLowerCase())) || {};

/** Sets some of a performer's traits and repaints her heading. */
async function setPerformerTraits(group, patch) {
  try {
    const out = await api('/api/traits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: group.name, ...patch }),
    });
    setTraits(out.traits);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  // With a performer filter on, the listing itself may have changed.
  if (personFiltered()) { render(); return; }
  for (const head of document.querySelectorAll('.group-head')) {
    if (head.dataset.group === group.key) head.replaceWith(buildGroupHead(group));
  }
}

/** The performers' races as the server holds them. */
function setRaces(map) {
  state.raceOf = new Map(Object.entries(map && typeof map === 'object' ? map : {}));
  state.raceVersion = (state.raceVersion || 0) + 1;
}

const raceOfName = (name) => state.raceOf.get(String(name || '').trim().toLowerCase()) || '';

/**
 * Gives a performer a race, or takes it away, and repaints what shows it: her
 * section's heading and every card she is credited on. Not the whole grid --
 * labelling is done section after section, and a rebuild would throw the
 * scroll back to the top each time. With a race filter on, though, the
 * listing itself may have changed, so then it is rebuilt.
 */
async function setPerformerRace(group, race) {
  try {
    const out = await api('/api/races', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: group.name, race }),
    });
    setRaces(out.races);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  if (personFiltered()) { render(); return; }
  for (const head of document.querySelectorAll('.group-head')) {
    if (head.dataset.group === group.key) head.replaceWith(buildGroupHead(group));
  }
  for (const file of group.files) refreshCardRecord(file);
}

/**
 * Places one performer in a favourite tier, or (tier 0) takes her off the
 * list. The server owns the list, so its answer is what the app then believes
 * -- two windows can be open on one library.
 */
async function setFavouriteTier(name, tier) {
  try {
    const data = await api('/api/favourites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, on: tier > 0, tier }),
    });
    setFavourites(data.favourites, data.favouriteTiers);
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
  return true;
}

/**
 * The heart's popup: Tier 1 to 5, and -- for a favourite already -- Remove.
 * Clicking outside it, or Escape, discards it with nothing changed.
 */
function openFavouritePopup(anchor, name) {
  closeFavouritePopup();
  const now = favouriteTier(name);
  const pop = document.createElement('div');
  pop.className = 'fav-pop';
  pop.setAttribute('role', 'dialog');
  const title = document.createElement('div');
  title.className = 'fav-pop-title';
  title.textContent = now ? `${name} — tier ${now}` : `Favourite ${name}`;
  pop.appendChild(title);
  const choose = async (tier) => {
    closeFavouritePopup();
    if (tier === now) return;
    if (!(await setFavouriteTier(name, tier))) return;
    toast(tier ? `${name}: favourite, tier ${tier}` : `${name} is no longer a favourite`, 'ok');
    // Favourites lead the sections, by tier, so the page is rebuilt to put this
    // one where it now belongs rather than just recolouring the heart.
    render();
  };
  const row = document.createElement('div');
  row.className = 'fav-pop-tiers';
  for (const tier of [1, 2, 3, 4, 5]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-pop-tier' + (tier === now ? ' on' : '');
    btn.textContent = `Tier ${tier}`;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); choose(tier); });
    row.appendChild(btn);
  }
  pop.appendChild(row);
  const foot = document.createElement('div');
  foot.className = 'fav-pop-foot';
  if (now) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fav-pop-remove';
    remove.textContent = 'Remove favourite';
    remove.addEventListener('click', (ev) => { ev.stopPropagation(); choose(0); });
    foot.appendChild(remove);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'fav-pop-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', (ev) => { ev.stopPropagation(); closeFavouritePopup(); });
  foot.appendChild(cancel);
  pop.appendChild(foot);
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  document.body.appendChild(pop);

  const box = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.left))}px`;
  pop.style.top = `${box.bottom + 6}px`;

  favPop.el = pop;
  favPop.away = (ev) => { if (!pop.contains(ev.target)) closeFavouritePopup(); };
  favPop.key = (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeFavouritePopup(); }
  };
  // Next tick, or the click that opened it would close it on the way up.
  setTimeout(() => {
    if (favPop.el !== pop) return;
    document.addEventListener('mousedown', favPop.away, true);
    document.addEventListener('keydown', favPop.key, true);
    window.addEventListener('scroll', closeFavouritePopup, { capture: true, once: true });
  }, 0);
}

const favPop = { el: null, away: null, key: null };

function closeFavouritePopup() {
  if (!favPop.el) return;
  favPop.el.remove();
  favPop.el = null;
  document.removeEventListener('mousedown', favPop.away, true);
  document.removeEventListener('keydown', favPop.key, true);
  window.removeEventListener('scroll', closeFavouritePopup, { capture: true });
}

function matchesQuery(file, terms) {
  const haystack = file._hay || searchHay(file);
  // Wrapped rather than iterated, so a field holding a single string is not
  // walked character by character. Asked as it goes rather than lower-casing
  // the whole list first: the first hit settles it.
  const has = (field, value) => {
    const held = file[field];
    return (Array.isArray(held) ? held : (held ? [held] : []))
      .some((t) => t.toLowerCase().includes(value));
  };
  return terms.every((term) => {
    if (term.field) return has(term.field, term.value);
    // A bare term searches everything: name, subfolder, tags, models.
    return haystack.includes(term.value)
      || has('tags', term.value)
      || has('models', term.value);
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
  if (advActive()) {
    // Read once for the pass, not once per video: see compileAdvanced.
    const adv = compileAdvanced(state.adv);
    const ctx = filterCtx();
    list = list.filter((f) => matchesAdvanced(f, adv, ctx));
  }

  list = list.slice().sort((a, b) => {
    let cmp;
    if (key === 'name' || key === 'relFolder') {
      cmp = BY_NAME(String(a[key]), String(b[key]));
      if (cmp === 0 && key === 'relFolder') {
        cmp = BY_NAME_EXACT(a.name, b.name);
      }
    } else if (key === 'duration') {
      // Duration arrives from the lazy probe, not the scan.
      const av = Number((state.meta.get(a.path) || {}).duration) || 0;
      const bv = Number((state.meta.get(b.path) || {}).duration) || 0;
      cmp = av - bv;
    } else if (key === 'mtimeMs') {
      cmp = touchedAt(a) - touchedAt(b);
      if (cmp === 0) return BY_NAME_EXACT(a.name, b.name);
    } else if (key === 'rating') {
      cmp = (Number(a.rating) || 0) - (Number(b.rating) || 0);
      // The name tiebreak is returned unflipped: within one rating band, names
      // should read A→Z whichever way the ratings are pointing. Multiplying it
      // by dir would put the unrated bulk in reverse alphabetical order.
      if (cmp === 0) return BY_NAME_EXACT(a.name, b.name);
    } else if (LABEL_SORTS[key]) {
      // Sorting by a label sorts by its first value: "her name comes first
      // alphabetically" is the only ordering a list of them has.
      //
      // Unlabelled goes last whichever way the arrow points, like the unrated
      // do — reversing brings the labelled tail to the top, which is the half
      // you asked to see, not a wall of blanks. Names break the ties unflipped,
      // for the same reason as the ratings.
      const av = LABEL_SORTS[key](a);
      const bv = LABEL_SORTS[key](b);
      if (!av && !bv) return BY_NAME_EXACT(a.name, b.name);
      if (!av) return 1;
      if (!bv) return -1;
      cmp = BY_NAME(av, bv);
      if (cmp === 0) return BY_NAME_EXACT(a.name, b.name);
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
 * client side. Every rating counts for something, rising steeply at the top:
 * a ten is twice an eight and ten times a six.
 *
 * Scored from the listing rather than from the whole library on purpose: this is
 * a view of what is in front of you, so filtering to one tag should reorder
 * the sections by who is best *in that tag*.
 */
// Points per rating, unrated to ten stars.
const STAR_POINTS = [0, 50, 75, 100, 250, 500, 1000, 2500, 5000, 7500, 10000];

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
/**
 * Who the faces in a video look like: every suggestion at FACE_FLOOR or above,
 * less the names turned down on that video.
 */
function suggestedNames(file) {
  const refused = new Set((file.notModels || []).map((n) => String(n).toLowerCase()));
  // Pending only: a name already credited has been dealt with, so it goes too.
  const credited = groupOnly.suggested
    ? new Set((file.models || []).map((n) => String(n).toLowerCase())) : new Set();
  return (file.suggested || [])
    .filter((s) => s.score >= FACE_FLOOR && !refused.has(String(s.name).toLowerCase())
      && !credited.has(String(s.name).toLowerCase()))
    .map((s) => s.name);
}

/**
 * The checkbox beside Collapse all, per grouping, for this app session.
 *   suggested  only suggestions still to add or turn down
 *   dupes      only videos with a copy found
 */
const groupOnly = { suggested: false, dupes: false };

function buildModelGroups(list, namesOf = (file) => file.models || [], emptyLabel = 'Nobody named') {
  const groups = new Map();
  const unnamed = [];

  for (const file of list) {
    // Who is credited on it -- or, grouped by suggestion, who it looks like.
    const names = namesOf(file).map((n) => String(n).trim()).filter(Boolean);
    if (!names.length) { unnamed.push(file); continue; }
    const rating = Math.max(0, Math.min(RATING_MAX, Math.round(Number(file.rating) || 0)));
    for (const name of names) {
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = { key, name, files: [], points: 0, good: 0 };
        groups.set(key, group);
      }
      group.files.push(file);
      group.points += STAR_POINTS[rating];
      if (rating >= 8) group.good += 1;
    }
  }

  // Asked once per section rather than twice per comparison: a few thousand
  // performers sort in some fifty thousand comparisons.
  for (const group of groups.values()) group.tier = favouriteTier(group.name) || 6;
  const out = [...groups.values()].sort((a, b) => {
    const fa = a.tier;
    const fb = b.tier;
    // Marked first, tier 1 ahead of 2, on down to 5 — that is what makes this a
    // favourites view rather than a leaderboard — then Top performers order
    // within each tier and among the rest. Ties go to whoever
    // has more well-rated videos, since ten fours and one five score alike, and
    // a name settles the rest so the order never wobbles between renders.
    return fa - fb
      || b.points - a.points
      || b.good - a.good
      || BY_NAME(a.name, b.name);
  });
  if (unnamed.length) {
    out.push({
      key: '',
      name: '',
      files: unnamed,
      unnamed: true,
      label: emptyLabel,
    });
  }
  return out;
}

/**
 * Every credited performer's standing in this listing: favourite tier first,
 * then points -- the order the performer grouping puts its sections in. Used to
 * order the names on a card in any grouped view.
 */
function rankModels(list) {
  const points = new Map();
  for (const file of list) {
    const rating = Math.max(0, Math.min(RATING_MAX, Math.round(Number(file.rating) || 0)));
    for (const name of file.models || []) {
      const key = String(name).trim().toLowerCase();
      points.set(key, (points.get(key) || 0) + STAR_POINTS[rating]);
    }
  }
  state.modelPoints = points;
}

/** Names in tier-then-points order, the way the performer sections run. */
function orderedModels(names) {
  if (!state.grouped || !state.modelPoints) return names;
  const at = (n) => String(n).trim().toLowerCase();
  return [...names].sort((a, b) => (favouriteTier(a) || 6) - (favouriteTier(b) || 6)
    || (state.modelPoints.get(at(b)) || 0) - (state.modelPoints.get(at(a)) || 0)
    || BY_NAME(String(a), String(b)));
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
/**
 * What the listing is a view of: folder, search, sort, grouping and filters.
 * Labelling a video changes none of these, so while this stays the same the
 * sections keep their order and the page keeps its place.
 */
function viewSignature() {
  return [state.dir, $('#recursiveToggle').checked, $('#searchInput').value.trim().toLowerCase(),
    $('#sortSelect').value, state.config.sortDir, state.grouped, groupOnly[state.grouped] || false,
    advActive() ? JSON.stringify(packFilter(state.adv)) : ''].join('\u0000');
}

/**
 * The order the sections were last drawn in. A favourite tier, a height or a
 * rating would move a section up or down the page; until the view changes,
 * or is refreshed, it stays where it was so the page does not shift under
 * whoever is working down it.
 */
let heldGroups = null;

function holdGroupOrder() {
  if (!state.grouped) { heldGroups = null; return; }
  const sig = viewSignature();
  if (heldGroups && heldGroups.sig === sig) {
    const at = heldGroups.order;
    const place = (g) => (at.has(g.key) ? at.get(g.key) : Infinity);
    // Stable: a section new since then keeps its own place among the others
    // new, below the ones already there; the catch-all stays last.
    state.groups.sort((a, b) => (a.unnamed ? 1 : 0) - (b.unnamed ? 1 : 0) || place(a) - place(b));
  }
  heldGroups = { sig, order: new Map(state.groups.map((g, i) => [g.key, i])) };
}

function buildSlots() {
  // Which copy of the open video the arrows were walking from, before every
  // card is renumbered. Rating a video from the player re-sorts the sections,
  // and a video credited to three performers sits in three of them.
  const was = state.grouped && state.playing && state.playingCard !== null
    ? state.cards[state.playingCard] || null : null;

  if (state.grouped) rankModels(state.view);
  state.groups = !state.grouped ? []
    : state.grouped === 'dupes' ? buildDupeGroups(withOtherCopies(state.view))
      : state.grouped === 'suggested' ? buildModelGroups(state.view, suggestedNames, 'Nobody suggested')
        : buildModelGroups(state.view);
  // Narrowed to what still needs doing: the catch-all section at the end --
  // "Nobody suggested", "No copy found" -- is exactly what that leaves out.
  if (groupOnly[state.grouped]) state.groups = state.groups.filter((g) => !g.unnamed);
  holdGroupOrder();
  state.slots = [];
  state.cards = [];
  state.headSlots = [];
  if (!state.grouped) { state.playingCard = null; return; }
  for (const group of state.groups) {
    // Where each heading sits, in order, so the count of cards drawn so far is
    // a search of the headings rather than a walk of everything drawn.
    state.headSlots.push(state.slots.length);
    state.slots.push({ head: group });
    // Folded: the heading stays, the cards go -- from the page and from what
    // the player's arrows walk, since a hidden video is not one you are on.
    if (foldedGroups.has(group.key)) continue;
    for (const [at, file] of group.files.entries()) {
      // `seq` is the card's place in reading order across the whole page, which
      // is what the player's arrows follow. It is not the same as `at`, the
      // position within this section, which is what a shift-range uses.
      const slot = { file, group, at, seq: state.cards.length };
      state.slots.push(slot);
      state.cards.push(slot);
    }
  }
  if (!state.playing) { state.playingCard = null; return; }

  // The arrows go on from the section you were in. Not from the video's first
  // copy, which is whichever of its performers happens to sort highest and
  // felt random from where you sat.
  const copies = state.cards.filter((slot) => slot.file.path === state.playing.path);
  const same = was ? copies.find((slot) => slot.group.key === was.group.key) : null;
  if (same) { state.playingCard = same.seq; return; }
  if (!was) { state.playingCard = copies.length ? copies[0].seq : null; return; }
  state.playingCard = null;
  // Still listed, but out of the section you were walking -- its credit to this
  // performer was just taken off. The slot it left is where next is, as when a
  // filter drops it; a video gone from the view entirely is the caller's to
  // anchor, with the position it had before the view changed.
  if (copies.length && state.cards.length) {
    state.playingAnchor = Math.min(was.seq, state.cards.length - 1);
  }
}

/**
 * The card to walk from when a video is opened without one -- from the
 * "similar" strip, say -- grouped. The copy in the section you were already
 * in, if it has one; else the nearest copy to where you were; else the first.
 */
function nearestCard(file, near) {
  if (!state.grouped || !file) return null;
  const copies = state.cards.filter((slot) => slot.file.path === file.path);
  if (!copies.length) return null;
  if (!near) return copies[0].seq;
  const same = copies.find((slot) => slot.group.key === near.group.key);
  if (same) return same.seq;
  return copies.reduce((best, slot) =>
    (Math.abs(slot.seq - near.seq) < Math.abs(best.seq - near.seq) ? slot : best)).seq;
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
    // Adrift on purpose: the video left the section the arrows were walking,
    // and the slot it left is where to go on from, not its copy elsewhere.
    if (state.playingAnchor !== null) return -1;
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
    if (!best || BY_LETTERS(value, best) < 0) best = value;
  }
  return best;
}

const SORT_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'mtimeMs', label: 'Date modified' },
  { value: 'size', label: 'File size' },
  { value: 'duration', label: 'Duration' },
  { value: 'rating', label: 'Rating' },
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
  if (show) { toggleVolumeMenu(false); toggleGroupMenu(false); renderSortMenu(); }
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
  if (show) { toggleSortMenu(false); toggleGroupMenu(false); }
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
  // Additional options start folded, and open only when one of them is in use.
  $('#advMore').open = ['framing', 'fingerprint', 'profiling', 'suggestions', 'storage']
    .some((f) => advDraft[f] && advDraft[f].size);
  $('#advModal').hidden = false;
  renderAdvanced();
}

/**
 * A performer row -- height, bust, body, race, favourite tier: its answers and
 * a "none" chip, in their own order, each cycling include -> exclude -> off.
 */
function renderPersonRow(box, values, facet, none, redraw) {
  if (!box) return;
  box.innerHTML = '';
  for (const value of values) {
    box.appendChild(chipCycle(value, facet.get(value), () => { cycleIn(facet, value); redraw(); }));
  }
  const gap = chipCycle(none, facet.get(NOTHING), () => { cycleIn(facet, NOTHING); redraw(); });
  gap.classList.add('chip-none');
  box.appendChild(gap);
}

function renderAdvanced() {
  for (const [field, host, none] of PERSON_ROWS) {
    renderPersonRow($(host), PERSON_FACETS[field], advDraft[field], none, () => renderAdvanced());
  }
  // Rating, 0 standing for unrated — a facet in its own right, since "never
  // been looked at" is a thing you want to list.
  const ratings = $('#advRating');
  ratings.innerHTML = '';
  for (const value of RATING_VALUES) {
    ratings.appendChild(chipCycle(
      ratingChipLabel(value),
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
  // How many there are to find, since only the picked ones are listed until
  // something is typed.
  const performers = (state.modelVocab || []).length;
  $('#advModelsFind').placeholder = performers
    ? `Type to find one of ${performers.toLocaleString()} performers` : 'Type to find a performer';
  for (const [field, el, empty, none] of [
    ['models', '#advModels', 'No models yet — name someone from a card first.', 'no models'],
    ['tags', '#advTags', 'No tags yet — add some from a card first.', 'no tags'],
  ]) {
    const box = $(el);
    const which = el.replace('#', '');
    // Alphabetical, like the editor: a facet is picked by looking a word up.
    const vocab = vocabFound(field, which);
    const searching = Boolean(String(chipFind[which] || '').trim());
    box.innerHTML = '';

    // First, because "which of these have nothing" is a question about the whole
    // listing rather than one more value in it. Not while searching: it answers
    // a different question and would sit there matching nothing you typed.
    if (!searching) {
      const gap = chipCycle(none, advDraft[field].get(NOTHING), () => {
        cycleIn(advDraft[field], NOTHING);
        renderAdvanced();
      });
      gap.classList.add('chip-none');
      box.appendChild(gap);
    }

    if (!vocab.length) {
      box.insertAdjacentHTML('beforeend',
        `<span class="dim">${searching ? 'Nothing matches that.' : empty}</span>`);
    }
    // What you have picked comes first, included before excluded, each still in
    // alphabetical order. Over five thousand names, a chip you clicked at the
    // letter S is otherwise gone from sight the moment you scroll, and the
    // only record of your choice is the count at the foot of the dialog.
    const picked = advDraft[field];
    const rank = (entry) => (picked.get(entry.tag) === 'in' ? 0 : picked.get(entry.tag) === 'out' ? 1 : 2);
    // Models: only the picked ones until something is typed to find another.
    const shown = field === 'models' && !searching ? vocab.filter((entry) => picked.has(entry.tag)) : vocab;
    const ordered = shown.map((entry, i) => [entry, i])
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
      .map(([entry]) => entry);
    for (const entry of ordered) {
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
  say('height', 'height', 'heights', ` (${advDraft.mode.height || 'all'})`);
  say('bust', 'bust', 'busts', ` (${advDraft.mode.bust || 'all'})`);
  say('body', 'body type', 'body types', ` (${advDraft.mode.body || 'all'})`);
  say('race', 'race', 'races', ` (${advDraft.mode.race || 'all'})`);
  say('favourites', 'favourite tier', 'favourite tiers', ` (${advDraft.mode.favourites || 'all'})`);
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
 * narrower listing than the pill promised. Now the pill IS the filter for its
 * own facet: exactly that one value, replacing whatever that facet held. The
 * other facets stay -- a performer's pill clicked under "4 stars and up"
 * means her good ones, not a fresh start -- and the quick search is dropped,
 * since it is the one thing that cannot be seen in the dialog.
 */
async function filterByLabel(field, value) {
  const adv = { ...state.adv, mode: { ...state.adv.mode } };
  for (const [key, held] of Object.entries(state.adv)) {
    if (held instanceof Map) adv[key] = new Map(held);
  }
  adv[field].clear();
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
  chip.appendChild(typeof label === 'string' ? document.createTextNode(label) : label);
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
  const facets = renderActiveFilters();
  const badge = $('#advDot');
  badge.hidden = !facets;
  badge.textContent = facets ? String(facets) : '';
  $('#advBtn').classList.toggle('on', Boolean(facets));
  $('#advBtn').setAttribute('aria-label', facets
    ? `Advanced filters, ${facets} in force` : 'Advanced filters');
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
  return sendRecordEdits({ paths, ...patch });
}

/**
 * A different edit for each video, in one request: `items` is
 * [{ path, ...patch }]. A bulk answer that would otherwise be hundreds of
 * calls -- one per name, each re-reading the labels -- is a single one.
 */
async function editRecordsEach(items) {
  if (!items.length) return;
  return sendRecordEdits({ items });
}

async function sendRecordEdits(body) {
  try {
    const data = await api('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.tagVocab = data.tags || state.tagVocab;
    state.modelVocab = data.models || state.modelVocab;
    // Which sections each edited video sits in, before the edit lands: taking
    // a name off it has to take its card out of her section (and adding one
    // put it in another), which refreshing the card in place cannot do.
    const sectionsOf = (file) => (state.grouped === 'models' ? (file.models || [])
      : state.grouped === 'suggested' ? suggestedNames(file) : [])
      .map((n) => String(n).trim().toLowerCase()).filter(Boolean).sort().join('\n');
    const before = new Map();
    if (state.grouped === 'models' || state.grouped === 'suggested') {
      for (const filePath of Object.keys(data.records || {})) {
        const file = fileAt(filePath);
        if (file) before.set(filePath, sectionsOf(file));
      }
    }
    for (const [filePath, record] of Object.entries(data.records || {})) {
      if (record.error) { toast(record.error, 'err'); continue; }
      // The open video first, and before the listing lookup: it is watchable
      // from outside the current listing -- an anchor, a sibling walked past a
      // filter -- and its timeline must redraw either way.
      if (state.playing && state.playing.path === filePath) {
        if (record.marks !== undefined) state.playing.marks = record.marks;
        if (record.resume !== undefined) state.playing.resume = record.resume;
        drawMarks();
      }
      const file = fileAt(filePath);
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
      file.url = record.url;
      // Bookmarked moments. Copied back so the timeline redraws from the store
      // rather than from what the click optimistically assumed.
      if (record.marks !== undefined) file.marks = record.marks;
      if (record.resume !== undefined) file.resume = record.resume;
      file.updated = record.updated || 0;
      refreshCardRecord(file);
    }
    pruneFiltered(Object.keys(data.records || {}));
    // Redrawn where it was: the sections keep their order (holdGroupOrder) and
    // the page its place (render's anchor); only the moved cards change.
    const moved = [...before].some(([p, was]) => fileAt(p) && sectionsOf(fileAt(p)) !== was);
    if (moved) render();
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
  const adv = advActive() ? compileAdvanced(state.adv) : null;
  const ctx = filterCtx();
  for (const path of paths) {
    const file = fileAt(path);
    if (!file) continue;
    const keep = matchesQuery(file, terms) && (!adv || matchesAdvanced(file, adv, ctx));
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
    cardIndex.clear();
    state.rendered = 0;
    while (state.rendered < Math.min(loaded, state.slots.length)) appendPage();
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
  const held = cardIndex.get(filePath);
  if (!held) return [];
  const live = [];
  for (const card of held) {
    if (card.isConnected) live.push(card);
    else held.delete(card);
  }
  if (!held.size) cardIndex.delete(filePath);
  return live;
}

/**
 * path -> the card elements built for it. A selector over the whole document
 * cost ~0.5 ms per call once every video in the library is on screen (about a
 * million nodes), and the metadata fill makes one call per video -- which kept
 * the page busy for most of every second and left edits waiting behind it.
 * Cards that have left the page are dropped as they are found.
 */
const cardIndex = new Map();

function indexCard(filePath, card) {
  let held = cardIndex.get(filePath);
  if (!held) { held = new Set(); cardIndex.set(filePath, held); }
  held.add(card);
}

/** Repaints just the stars and chips, so an edit never disturbs a playing hover. */
function refreshCardRecord(file) {
  for (const card of cardsFor(file.path)) {
    const row = card.querySelector('.record-row');
    if (row) row.replaceWith(buildRecordRow(file, { edit: false }));
    // The rating is a badge on the picture now, and the row above does not
    // touch it -- so a rating set in the player would leave the tile showing
    // the old one until the listing was rebuilt.
    const corner = card.querySelector('.badge-corner');
    if (corner) {
      const badge = corner.querySelector('.badge-rating');
      if (badge) badge.remove();
      if (file.rating) corner.appendChild(buildCornerRating(file.rating));
    }
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
  const current = fileAt(file.path) || file;
  holder.replaceChildren(buildRecordRow(current));
}

