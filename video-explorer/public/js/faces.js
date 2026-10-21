'use strict';

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
  faint: 'faint',
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
 * recogniser offered, which is what the refusal list is read against.
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
const HOVER_CROPS = 12;
const HOVER_STALE_MS = 60000;

// One request per performer rather than per chip: the same name appears on
// video after video and her faces do not change between two of them. Short-
// lived, because the sweep is writing new profiles the whole time.
// Bounded too: a long session of hovering keyed one entry per name per video,
// and a Map keeps its oldest first, so the oldest is the one to let go.
const herFaces = new Map();
const HER_FACES_CAP = 200;

function herLineup(name, file, person) {
  const id = `${name}\u0000${file.path}\u0000${person ?? ''}`;
  const held = herFaces.get(id);
  if (held && Date.now() - held.at < HOVER_STALE_MS) return held.p;
  // Ranked against this video's face, so each of hers comes with how alike.
  const p = api(`/api/faces/lineup?model=${encodeURIComponent(name)}&limit=${HOVER_CROPS + 1}`
    + `&path=${encodeURIComponent(file.path)}&person=${person ?? ''}`)
    .catch(() => { herFaces.delete(id); return null; });
  herFaces.delete(id); // re-set below, so a refreshed entry counts as the newest
  herFaces.set(id, { at: Date.now(), p });
  while (herFaces.size > HER_FACES_CAP) herFaces.delete(herFaces.keys().next().value);
  return p;
}

/**
 * What the hover card needs for a credited name: her suggestion on this video
 * when the faces put her among them, or just the name when they do not.
 */
function creditedSuggestion(file, name) {
  const want = String(name).toLowerCase();
  const found = (file.suggested || []).filter((s) => s.name.toLowerCase() === want)
    .sort((a, b) => b.score - a.score)[0];
  return found || { name, person: null, score: null, credited: true };
}

/**
 * How like `name` this video's faces are, 0..1, or null when nothing says:
 * the ranking's own score when she is in it, else the listing's `credit`
 * (her score on a video credited to her that the ranking left below the floor).
 */
function matchScore(file, name) {
  const want = String(name).toLowerCase();
  let best = null;
  for (const s of file.suggested || []) {
    if (s.name.toLowerCase() === want && (best === null || s.score > best)) best = s.score;
  }
  if (best !== null) return best;
  for (const [credited, score] of Object.entries(file.credit || {})) {
    if (credited.toLowerCase() === want) return score;
  }
  return null;
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

  const own = (person) => `/api/faces/face?path=${encodeURIComponent(file.path)}&person=${person || 0}`;
  $('#faceHoverThis').src = own(sug.person);
  faceHoverLabel(sug.name, 'loading her faces…');
  $('#faceHoverGrid').replaceChildren();

  const pct = Math.round(sug.score * 100);
  const gap = Math.round(sug.margin * 100);
  // Behind is behind: "-4 clear of" made the reader do the sign themselves.
  const pts = (x) => `${x} point${x === 1 ? '' : 's'}`;
  const lead = gap < 0 ? `${pts(-gap)} behind ${sug.runnerUp}` : `${pts(gap)} clear of ${sug.runnerUp}`;
  const verdict = $('#faceHoverVerdict');
  verdict.textContent = sug.score === null
    ? `Credited on this video — not among the names its faces suggest`
    : sug.band === 'near'
      ? `${pct}% alike — below the bar to suggest, so judge it yourself`
      : `${pct}% alike, ${sug.runnerUp ? lead : `${pts(Math.abs(gap))} ${gap < 0 ? 'behind' : 'clear'}`} — ${BAND_LABEL[sug.band]}`;
  verdict.className = `face-hover-verdict band-${sug.band || 'near'}`;
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

  const data = await herLineup(sug.name, file, sug.person);
  if (hover.token !== token) return;
  // A credited name names no face: the server picked the one most like her.
  if (sug.person === null && data && Number.isInteger(data.mine)) $('#faceHoverThis').src = own(data.mine);
  if (!data) { faceHoverLabel(sug.name, 'could not read her faces'); return; }

  // This video is the question, not part of the answer. Nor is a face of hers
  // that barely resembles it: under the floor the suggestions draw, it is
  // noise in a grid meant to show a likeness.
  const others = (data.faces || [])
    .filter((f) => f.key !== keyOf(file))
    .filter((f) => typeof f.score !== 'number' || f.score >= FACE_FLOOR)
    .slice(0, HOVER_CROPS);
  faceHoverLabel(sug.name, others.length
    ? `${others.length} most alike of her ${Number(data.total || 0).toLocaleString()}`
    : (data.faces || []).length ? 'none of her faces is close' : 'no stored faces yet');

  const grid = $('#faceHoverGrid');
  grid.replaceChildren();
  for (const other of others) {
    const cell = document.createElement('div');
    cell.className = 'face-hover-cell';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    // Dimmed rather than dropped, for the reason the big lineup marks them: it
    // counts towards her average whether or not it flatters the picture.
    if (other.agrees !== null && other.agrees < 0.3) img.className = 'face-odd-thumb';
    img.src = `/api/faces/crop?key=${encodeURIComponent(other.key)}&person=0`;
    img.addEventListener('error', () => cell.remove());
    cell.appendChild(img);
    // How like this video's face that one of hers is.
    if (typeof other.score === 'number') {
      const pct = document.createElement('span');
      pct.className = 'face-hover-pct';
      pct.textContent = `${Math.round(other.score * 100)}%`;
      cell.appendChild(pct);
    }
    grid.appendChild(cell);
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

/**
 * Turns one suggested name down on every video in its section that does not
 * already credit her -- the bulk form of the strip's "not her". Credited videos
 * are left alone: there the face agrees with a name you gave.
 */
async function refuseSuggestedGroup(group) {
  const name = group.name;
  const key = name.toLowerCase();
  const paths = [...new Set(group.files
    .filter((f) => !(f.models || []).some((m) => m.toLowerCase() === key))
    .map((f) => f.path))];
  if (!paths.length) { toast(`Every video here already credits ${name}`, 'info'); return; }
  const skipped = new Set(group.files.map((f) => f.path)).size - paths.length;
  if (!window.confirm(`None of these ${paths.length} video${paths.length === 1 ? ' is' : 's are'} ${name}?\n\n`
    + `${name} will not be suggested for them again.`
    + (skipped ? `\n${skipped} that already credit ${name} are left as they are.` : ''))) return;
  for (let i = 0; i < paths.length; i += 200) {
    await editRecords(paths.slice(i, i + 200), { addNotModels: [name] });
  }
  toast(`${name} turned down on ${paths.length} video${paths.length === 1 ? '' : 's'}`, 'ok');
  render();
}

/**
 * "All profiled": on every video in the section, each suggested name that is
 * neither credited nor already turned down is turned down. Credits stay.
 */
/**
 * Where "All profiled" stands for her: every video credited to her -- in any
 * grouping, so the suggested view's section (videos that only look like her)
 * is not what it acts on -- split into those already marked and those not,
 * and how many suggestions are still showing on the unmarked ones.
 */
function pendingOnPerformer(name) {
  const want = String(name).toLowerCase();
  const open = [];
  let settled = 0;
  let pairs = 0;
  for (const file of state.files) {
    if (!(file.models || []).some((m) => m.toLowerCase() === want)) continue;
    if (file.settled) { settled += 1; continue; }
    open.push(file.path);
    const done = new Set([...(file.models || []), ...(file.notModels || [])].map((n) => n.toLowerCase()));
    for (const s of file.suggested || []) {
      const key = String(s.name).toLowerCase();
      if (s.score < FACE_FLOOR || done.has(key)) continue;
      done.add(key);
      pairs += 1;
    }
  }
  return { open, settled, pairs };
}

/**
 * All profiled: her videos, as they stand now, are labelled right. Each one is
 * marked so, and from then on it suggests nobody but the names credited on it
 * -- not the ones showing now, not ones a later sweep would bring up. Videos
 * credited to her later are not marked; pressing it again takes those in.
 */
async function settleGroupSuggestions(group, settle = true) {
  const want = String(group.name).toLowerCase();
  const paths = settle ? pendingOnPerformer(group.name).open
    : state.files.filter((f) => f.settled && (f.models || []).some((m) => m.toLowerCase() === want)).map((f) => f.path);
  if (!paths.length) return;
  const n = `${paths.length.toLocaleString()} video${paths.length === 1 ? '' : 's'}`;
  if (!settle && !window.confirm(`Let ${group.name}'s ${n} be suggested other names again?`)) return;
  const items = paths.map((p) => ({ path: p, settled: settle }));
  for (let i = 0; i < items.length; i += 500) await editRecordsEach(items.slice(i, i + 500));
  toast(settle
    ? `${group.name}: ${n} marked all profiled — no more suggestions on them`
    : `${group.name}: ${n} can be suggested other names again`, 'ok');
  render();
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
// Open or folded, for the session: the strip is redrawn on every edit and
// every video, and the list should stay how it was last left.
let refusedOpen = false;

function appendRefused(host, file, refused) {
  if (!refused.length) return;
  const row = document.createElement('span');
  row.className = 'face-refused';
  // Folded to a count: a video with dozens turned down drew a wall of names
  // under the player. Click to see them, and to put one back.
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'face-refused-toggle';
  toggle.setAttribute('aria-expanded', String(refusedOpen));
  const paint = () => {
    toggle.textContent = `${refusedOpen ? '▾' : '▸'} not · ${refused.length}`;
    toggle.title = refusedOpen ? 'Hide the names turned down here' : `Show the ${refused.length} names turned down here`;
    toggle.setAttribute('aria-expanded', String(refusedOpen));
    for (const el of row.querySelectorAll('.face-refused-name')) el.hidden = !refusedOpen;
  };
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    refusedOpen = !refusedOpen;
    paint();
  });
  row.appendChild(toggle);
  for (const name of refused) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'face-refused-name';
    back.textContent = name;
    back.title = `Turned down here — click to let ${name} be suggested again`;
    back.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      unrefuseSuggestion(file, name);
    });
    row.appendChild(back);
  }
  paint();
  host.appendChild(row);
}

/**
 * The rating as it reads on a tile: the stars it has and no empty ones, in the
 * same badge the running time sits in. A read-out, like everything else on a
 * card -- the player is where a rating is set.
 */
function buildCornerRating(rating) {
  const badge = document.createElement('span');
  badge.className = 'badge badge-rating';
  badge.replaceChildren(starsNode(rating));
  badge.title = `${starsNumber(rating)} out of 5 stars`;
  return badge;
}

// The slider's own range, read from the slider so the two cannot disagree.
const CARD_MIN = 200;
const CARD_MAX = 520;
const CARD_STEP = 20;

/** How wide a tile is now, from the property that actually decides it. */
function cardWidth() {
  const at = getComputedStyle(document.documentElement).getPropertyValue('--card-width');
  return Number(String(at).trim().replace('px', '')) || CARD_MIN;
}

let cardWidthSave = null;

/**
 * Set the tile width everywhere at once: the grid, the slider in settings, and
 * -- when asked -- the saved config.
 *
 * The save is held back until the wheel stops. A notch is one step, so zooming
 * from smallest to largest is sixteen of them, and sixteen writes of a number
 * for one gesture is sixteen too many.
 */
function setCardWidth(px, { save = false } = {}) {
  const want = Math.max(CARD_MIN, Math.min(CARD_MAX, Math.round(px / CARD_STEP) * CARD_STEP));
  const readout = $('#cardWidthLabel');
  if (readout) readout.textContent = `${want}px`;
  if (want === cardWidth() && !save) return want;
  document.documentElement.style.setProperty('--card-width', want + 'px');
  const slider = $('#cardWidth');
  if (slider) slider.value = String(want);
  if (save) {
    clearTimeout(cardWidthSave);
    cardWidthSave = setTimeout(() => saveConfig({ cardWidth: want }), 400);
  }
  return want;
}

/** The demo chip and its picker, from whatever is saved. */
function syncFacetColours() {
  const held = (state.config || {}).facetColours || {};
  for (const [facet, demo] of [['race', '#raceDemo'], ['height', '#heightDemo'],
    ['bust', '#bustDemo'], ['body', '#bodyDemo'], ['models', '#modelsDemo']]) {
    const id = '#colour' + facet[0].toUpperCase() + facet.slice(1);
    const input = $(id);
    const chip = $(demo);
    if (input && held[facet]) input.value = held[facet];
    if (!chip) continue;
    chip.style.removeProperty('--chip-colour');
    if (held[facet]) chip.style.setProperty('--chip-colour', held[facet]);
  }
}

/**
 * A colour picker fires on every step of a drag, and each one used to save the
 * config and rebuild the grid. Now the colour is taken at once, the chips that
 * wear it are repainted where they stand (see repaintChips), and the save goes
 * when the drag has been still for a moment -- one write per config key.
 */
const colourSaves = {};

function saveColoursSoon(key) {
  clearTimeout(colourSaves[key]);
  colourSaves[key] = setTimeout(() => saveConfig({ [key]: state.config[key] }), 300);
}

function setFacetColour(facet, colour) {
  const held = { ...((state.config || {}).facetColours || {}) };
  held[facet] = colour;
  state.config.facetColours = held;
  saveColoursSoon('facetColours');
  syncFacetColours();
  repaintChips(facet);
}

/**
 * Every label, used or not, with what it is on and what colour it wears.
 *
 * A tag exists by being used, so a label you have just made has no videos and
 * would vanish the moment the list was rebuilt -- `spareLabels` is where those
 * live until something carries them.
 */
function labelRows() {
  const counts = new Map();
  for (const entry of state.tagVocab || []) counts.set(entry.tag.toLowerCase(), entry);
  const rows = [...counts.values()].map((e) => ({ tag: e.tag, count: e.count }));
  for (const spare of (state.config || {}).spareLabels || []) {
    if (!counts.has(spare.toLowerCase())) rows.push({ tag: spare, count: 0 });
  }
  return rows.sort((a, b) => BY_LETTERS(a.tag, b.tag));
}

function renderLabelList() {
  const host = $('#labelList');
  if (!host) return;
  const rows = labelRows();
  host.replaceChildren();
  if (!rows.length) {
    const none = document.createElement('div');
    none.className = 'label-empty';
    none.textContent = 'No labels yet. Add one above, or tag a video.';
    host.appendChild(none);
    return;
  }
  for (const { tag, count } of rows) {
    const row = document.createElement('div');
    row.className = 'label-row';

    const colour = document.createElement('input');
    colour.type = 'color';
    colour.value = chipColour('tags', tag) || '#8a94a6';
    colour.title = `Colour for "${tag}"`;
    colour.addEventListener('input', () => setLabelColour(tag, colour.value));
    row.appendChild(colour);

    // A text box rather than a rename button: the name IS the control, and a
    // rename is committed by leaving it or pressing Enter.
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'label-name';
    name.value = tag;
    name.title = 'Rename — every video carrying it is renamed too';
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); name.blur(); }
      if (ev.key === 'Escape') { name.value = tag; name.blur(); }
    });
    name.addEventListener('blur', () => renameLabel(tag, name.value, name));
    row.appendChild(name);

    const on = document.createElement('span');
    on.className = 'label-count';
    on.textContent = count ? `${count} video${count === 1 ? '' : 's'}` : 'unused';
    row.appendChild(on);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'label-drop';
    drop.textContent = '\u2715';
    drop.title = `Delete "${tag}"`;
    drop.addEventListener('click', () => deleteLabel(tag, count));
    row.appendChild(drop);

    host.appendChild(row);
  }
}

function setLabelColour(tag, colour) {
  const held = { ...((state.config || {}).labelColours || {}) };
  held[tag.toLowerCase()] = colour;
  state.config.labelColours = held;
  saveColoursSoon('labelColours');
  repaintChips('tags', tag);
}

/** Talks to the endpoint, then puts the answer back into the page. */
async function labelAction(body) {
  const res = await fetch('/api/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (data.config) state.config = { ...state.config, ...data.config };
  if (data.tags) state.tagVocab = data.tags;
  return data;
}

async function addLabel() {
  const field = $('#labelNew');
  const name = field.value.trim();
  if (!name) return;
  try {
    await labelAction({ action: 'add', name });
    field.value = '';
    renderLabelList();
    toast(`Label "${name}" added`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function renameLabel(from, to, field) {
  const want = String(to || '').trim().replace(/\s+/g, ' ');
  if (!want || want === from) { field.value = from; return; }
  try {
    const { changed } = await labelAction({ action: 'rename', name: from, to: want });
    renderLabelList();
    // The listing in hand still says the old name on every one of them.
    if (changed) await relistQuietly();
    render();
    toast(changed
      ? `"${from}" is now "${want}" on ${changed} video${changed === 1 ? '' : 's'}`
      : `"${from}" is now "${want}"`, 'ok');
  } catch (err) {
    field.value = from;
    toast(err.message, 'err');
  }
}

async function deleteLabel(tag, count) {
  const on = count ? ` It is on ${count} video${count === 1 ? '' : 's'}, and will come off all of them.` : '';
  if (!window.confirm(`Delete the label "${tag}"?${on}`)) return;
  try {
    const { changed } = await labelAction({ action: 'delete', name: tag });
    renderLabelList();
    if (changed) await relistQuietly();
    render();
    toast(changed ? `"${tag}" removed from ${changed} video${changed === 1 ? '' : 's'}`
      : `"${tag}" deleted`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** The card's heading: her name as a name, and the count beside it, dimmer. */
function faceHoverLabel(name, note) {
  const label = $('#faceHoverLabel');
  const who = document.createElement('span');
  who.className = 'face-hover-name';
  who.textContent = name;
  const what = document.createElement('span');
  what.className = 'face-hover-count';
  what.textContent = note;
  label.replaceChildren(who, what);
}

function closeFaceHover() {
  clearTimeout(hover.in);
  hover.token = null;
  const card = $('#faceHover');
  if (card) card.hidden = true;
}


// The floor lives in filter.js, which the page loads first: the count filters
// have to draw their line in the same place this row does, and they cannot do
// that from a second copy of the number.

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
      ? `${Math.abs(Math.round(sug.margin * 100))} point${Math.abs(Math.round(sug.margin * 100)) === 1 ? '' : 's'} `
        + `${sug.margin < 0 ? 'behind' : 'clear of'} the next name`
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
  const current = fileAt(file.path) || file;
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

  // What the row is, before the row: the tiles look like the similar videos
  // under them, and the difference is the whole point.
  host.appendChild(rowLead('Looks like'));

  // Every name shown here turned down in one go -- for a video whose performer
  // is already credited, where the rest are only lookalikes. Credits stay. At
  // the end of the row, after the evidence, and quiet: an answer, not an alarm.
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'suggest-none';
  dismiss.textContent = 'None of these are the performer';
  dismiss.title = `Turn down all ${suggested.length} suggested here; anyone credited stays credited`;
  dismiss.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    dismiss.disabled = true;
    await editRecords([current.path], { addNotModels: suggested.map((s) => s.name) });
    toast(`${suggested.length} suggestion${suggested.length === 1 ? '' : 's'} turned down`, 'ok');
    if (state.playing) buildPlayerSuggestions(state.playing);
    else host.replaceChildren();
  });
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
  host.appendChild(dismiss);
  appendRefused(host, current, refused);
}

/** The small capitals ahead of a row of tiles, saying what the row is. */
function rowLead(text) {
  const el = document.createElement('span');
  el.className = 'face-lead row-lead';
  el.textContent = text;
  return el;
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
  host.appendChild(rowLead('Similar videos'));
  // The tiles scroll inside this, so the label stays put beside them.
  const scroller = document.createElement('div');
  scroller.className = 'similar-scroll';
  host.appendChild(scroller);
  const row = document.createElement('div');
  row.className = 'similar-row';
  scroller.appendChild(row);
  addSimilarTiles(row, found.videos);
  syncEdgeFades(scroller);
}

/**
 * Fades at whichever edge has more beyond it, in place of a scrollbar: the
 * row reads as continuing without a bar's worth of chrome under it.
 */
function syncEdgeFades(scroller) {
  if (!scroller) return;
  const max = scroller.scrollWidth - scroller.clientWidth;
  scroller.classList.toggle('more-left', scroller.scrollLeft > 2);
  scroller.classList.toggle('more-right', scroller.scrollLeft < max - 2);
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
  const scroller = host && host.querySelector('.similar-scroll');
  const row = scroller && scroller.querySelector('.similar-row');
  if (!row || similar.loading || similar.shown >= similar.total) return;
  if (!state.playing || state.playing.path !== similar.path) return;
  // Within a tile's width of the end, so the next page is arriving as the last
  // one comes into view rather than after you have hit the wall.
  if (scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 140) return;

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
  syncEdgeFades(scroller);
}

/**
 * Bound once, to the host that outlives every row. Scroll does not bubble, so
 * it is caught on the way down instead. With the scrollbar gone, the wheel
 * and a drag are the ways along: the wheel's up and down become left and
 * right, and a drag pulls the row -- a drag that moved swallows the click it
 * ends in, so letting go over a tile does not open it.
 */
function watchSimilarScroll() {
  const host = $('#playerSimilar');
  if (!host) return;
  const scrollerOf = (ev) => ev.target.closest && ev.target.closest('.similar-scroll');
  host.addEventListener('scroll', (ev) => {
    if (ev.target.classList && ev.target.classList.contains('similar-scroll')) syncEdgeFades(ev.target);
    extendSimilar();
  }, { passive: true, capture: true });
  host.addEventListener('wheel', (ev) => {
    const scroller = scrollerOf(ev);
    if (!scroller || ev.ctrlKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    ev.preventDefault();
    scroller.scrollLeft += ev.deltaY;
  }, { passive: false });
  const drag = { scroller: null, x: 0, left: 0, moved: false };
  host.addEventListener('pointerdown', (ev) => {
    const scroller = scrollerOf(ev);
    if (!scroller || ev.button !== 0 || ev.pointerType === 'touch') return;
    Object.assign(drag, { scroller, x: ev.clientX, left: scroller.scrollLeft, moved: false });
  });
  window.addEventListener('pointermove', (ev) => {
    if (!drag.scroller) return;
    const dx = ev.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    drag.moved = true;
    drag.scroller.classList.add('dragging');
    drag.scroller.scrollLeft = drag.left - dx;
  });
  window.addEventListener('pointerup', () => {
    if (!drag.scroller) return;
    drag.scroller.classList.remove('dragging');
    drag.scroller = null;
  });
  host.addEventListener('click', (ev) => {
    if (!drag.moved) return;
    drag.moved = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
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
    other.rating ? `${starsNumber(other.rating)} out of 5 stars` : null,
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
    stars.appendChild(starsNode(other.rating));
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
    const inView = fileAt(other.path);
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

  // Nothing under a fifth is offered -- FACE_FLOOR, the same line the
  // suggestion row draws.
  const near = uncredited(file, (info.near || []).filter((n) => n.score >= FACE_FLOOR));
  if (!near.length) return;

  const pictures = await picturesFor(file, near.map((n) => n.name));
  if (!state.playing || state.playing.path !== file.path) return;
  host.replaceChildren();
  host.appendChild(rowLead('Closest'));

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
  // Not in the editor: the player's strip is where a face is put to a name.
  host.hidden = true;
  return;
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
        draftAdd('models', name);
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
 * What a sweep pill says on hover -- as a card, not a `title`.
 *
 * The three pills are polled every two seconds and their numbers move the
 * whole time, which a native tooltip cannot follow: the browser reads the
 * attribute once, when the tooltip opens, and shows that text for as long as
 * the pointer stays on the element. So a card opened at 52/103 still said 52
 * several minutes later, and only a reload appeared to fix it -- because a
 * reload is another first hover.
 *
 * This is the same shared card the folder tiles use, for the same reasons
 * (one is hovered at a time, and the toolbar clips its own overflow), with one
 * addition: every poll repaints it while it is open, so the card counts up
 * alongside the pill it belongs to.
 */
const pillPop = { for: null };

/**
 * Hand a pill the lines it would have put in a `title`.
 *
 * Falsy entries drop out, exactly as the `.filter(Boolean).join('\n')` they
 * replace did, so each render can keep listing conditional lines inline.
 */
function setPillPop(pill, lines) {
  if (!pill) return;
  pill.popLines = lines.filter(Boolean);
  if (pillPop.for === pill) paintPillPop();
}

function paintPillPop() {
  const pop = $('#pillPop');
  const pill = pillPop.for;
  if (!pop || !pill || !pill.popLines || pill.hidden) { hidePillPop(); return; }
  pop.replaceChildren();
  pill.popLines.forEach((line, i) => {
    const el = document.createElement('div');
    // The first line is what it is doing right now -- the answer to the
    // question the hover was asking. The rest is detail.
    el.className = i === 0 ? 'folder-pop-title'
      : (typeof line === 'object' && line.dim ? 'folder-pop-none' : 'folder-pop-head');
    el.textContent = typeof line === 'object' ? line.text : line;
    pop.appendChild(el);
  });
  placePop(pop, pill);
}

function showPillPop(pill) {
  pillPop.for = pill;
  paintPillPop();
}

function hidePillPop() {
  pillPop.for = null;
  const pop = $('#pillPop');
  if (pop) pop.hidden = true;
}

/** Hover or tab to it and the card opens; leave and it closes. */
function watchPill(pill) {
  if (!pill) return;
  pill.addEventListener('pointerenter', () => showPillPop(pill));
  pill.addEventListener('pointerleave', hidePillPop);
  pill.addEventListener('focus', () => showPillPop(pill));
  pill.addEventListener('blur', hidePillPop);
}


/**
 * The same readout for duplicate fingerprinting, left of the faces one.
 *
 * Two long backfills run side by side and each answers "how far in are you",
 * so they read the same way: a fraction, one word for what it is doing, and
 * the finding on the end. Clicking pauses, as it does for faces.
 */
let framingStatus = null;
/**
 * The three sweeps and the walk, in one ask.
 *
 * Three routes polled every two seconds was ninety requests a minute whatever
 * the app was doing, and each face reply counted twenty-three thousand
 * profiles from scratch. One route now, and the rate follows the work: two
 * seconds while something is actually running, fifteen when everything is
 * paused and the numbers cannot move on their own.
 */
const POLL_BUSY_MS = 2000;
const POLL_IDLE_MS = 15000;
// Minimised or behind another window: nobody can read the pills, so they are
// not repainted and the server is asked once a minute rather than every two
// seconds. Coming back asks at once (see the visibilitychange in init).
const POLL_HIDDEN_MS = 60000;
let pollTimer = null;

/**
 * ffmpeg missing, or a sweep that stopped because it could not be started:
 * said once, as a sticky error, with the install line. Without this a fresh
 * machine showed a grid of black tiles and three pills reading "paused".
 */
let ffmpegWarned = '';

function warnIfFfmpegMissing(all) {
  if (!all) return;
  const reason = all.ffmpeg && !all.ffmpeg.ok ? all.ffmpeg.reason
    : [all.faces, all.dupes, all.framing].map((s) => s && s.blocked).find(Boolean) || '';
  if (!reason || reason === ffmpegWarned) return;
  ffmpegWarned = reason;
  toast(`ffmpeg is not working, so previews and the sweeps are off. ${reason}`, 'err');
}

function sweepRunning(status) {
  return Boolean(status && (status.running || status.walking || status.counting));
}

async function pollStatus() {
  let all = null;
  try {
    all = await api('/api/status');
  } catch { /* the server is restarting, or gone: the pills say so below */ }

  faceStatus = all ? all.faces : null;
  dupeStatus = all ? all.dupes : null;
  framingStatus = all ? all.framing : null;
  warnIfFfmpegMissing(all);
  if (!document.hidden) {
    renderFacePill();
    renderDupePill();
    renderFramingPill();
  }

  // A folder served from the last walk of it is confirmed against the disk
  // behind the listing. When that comes back different, this is where we hear
  // about it -- and the listing quietly redraws rather than waiting for the
  // next time you happen to open the folder.
  if (all && state.walkStale && Number(all.walkVersion) !== state.walkVersion) {
    state.walkStale = false;
    relistWhenFree();
  }

  const busy = all && [all.faces, all.dupes, all.framing].some(sweepRunning);
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollStatus,
    document.hidden ? POLL_HIDDEN_MS : (busy ? POLL_BUSY_MS : POLL_IDLE_MS));
}

/**
 * A relist nobody asked for -- the walk came back different, OneDrive caught up
 * with a download -- waits while a video is open. The redraw under the player
 * cost a frame or two of the playthrough and moved the arrows' idea of next;
 * the listing can catch up the moment the player closes (see closePlayer).
 */
let relistDeferred = false;

function relistWhenFree() {
  if (!$('#playerModal').hidden) { relistDeferred = true; return Promise.resolve(); }
  relistDeferred = false;
  return relistQuietly();
}

/**
 * Re-lists the current folder without the scan's furniture: no spinner, no
 * history entry, no jump to the top, and the scroll position left alone.
 */
async function relistQuietly() {
  if (!state.dir) return;
  try {
    const recursive = $('#recursiveToggle').checked ? '1' : '0';
    const data = await api(
      `/api/scan?dir=${encodeURIComponent(state.dir)}&recursive=${recursive}`,
    );
    if (data.dir !== state.dir) return; // moved on while we were asking
    setFiles(hydrateAll(data.files));
    state.folders = data.folders || [];
    state.totalBelow = data.totalBelow || 0;
    state.cloudBelow = data.cloudBelow || 0;
    state.walkVersion = Number(data.walkVersion) || 0;
    // The view has not changed, so render() puts the page back on the card that
    // was at the top and draws a chunk under it; the rest comes in as you
    // scroll, as it does after any other edit.
    render();
  } catch { /* a folder that has gone is the next scan's problem, not a toast */ }
}

/** What a sweep pill counts, ahead of its numbers: three pills of bare figures read alike. */
function pillNoun(word) {
  const el = document.createElement('span');
  el.className = 'faces-noun';
  el.textContent = word;
  return el;
}

function renderFramingPill() {
  const pill = $('#framingPill');
  const text = $('#framingText');
  if (!pill || !text) return;
  if (!framingStatus || !framingStatus.available) {
    pill.hidden = true;
    // A pill that disappears takes its card with it, rather than leaving the
    // last numbers it had floating over the toolbar.
    if (pillPop.for === pill) hidePillPop();
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
    waiting: 'idle',
    paused: 'paused',
    stopped: 'stopped',
  };
  // Idle before the library has been counted is not "nothing left": it is
  // the count still to come, and the pill and its card both say so.
  const uncounted = !counted && (doing === 'waiting' || doing === 'counting');
  text.appendChild(pillNoun('Frames'));
  const main = document.createElement('span');
  main.textContent = counted && downloaded ? `${n(framed)} / ${n(downloaded)}` : `${n(framed)}`;
  text.appendChild(main);

  const stateEl = document.createElement('span');
  stateEl.className = 'faces-doing';
  stateEl.textContent = ' ' + (finished && !busy ? 'all framed'
    : uncounted ? said.counting : (said[doing] || 'framed'));
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

  setPillPop(pill, [
    doing === 'framing' ? `Building the preview frames for ${current}`
      : uncounted ? 'Counting the library\u2026'
        : doing === 'standing aside' ? 'Waiting for a preview you are looking at'
          : doing === 'waiting' ? 'Idle \u2014 nothing left to frame'
            : doing === 'paused' ? 'Paused \u2014 click to build the preview frames'
              : 'Not running',
    counted && downloaded
      ? `${n(framed)} of ${n(downloaded)} downloaded videos framed`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : counted
        ? 'No videos on this machine to read' + (cached ? ` — ${n(cached)} were done before going to the cloud` : '')
        : `${n(framed)} framed, still counting the library`,
    done ? `${n(done)} built this session${rate ? ` \u00b7 about ${n(rate)}/hour` : ''}` : '',
    failed ? `${n(failed)} could not be read` : '',
    { text: 'Ten frames per video, so opening one shows them at once instead of building them.', dim: true },
    { text: 'Cloud videos are framed as you browse them, not here.', dim: true },
  ]);
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

function renderDupePill() {
  const pill = $('#dupesPill');
  const text = $('#dupesText');
  if (!pill || !text) return;
  if (!dupeStatus || !dupeStatus.available) {
    pill.hidden = true;
    // A pill that disappears takes its card with it, rather than leaving the
    // last numbers it had floating over the toolbar.
    if (pillPop.for === pill) hidePillPop();
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
    waiting: 'idle',
    paused: 'paused',
    stopped: 'stopped',
  };
  const uncounted = !counted && (doing === 'waiting' || doing === 'counting');
  text.appendChild(pillNoun('Prints'));
  const main = document.createElement('span');
  main.textContent = counted && downloaded
    ? `${n(fingerprintedOnDisk)} / ${n(downloaded)}`
    : `${n(fingerprinted)}`;
  text.appendChild(main);

  const state = document.createElement('span');
  state.className = 'faces-doing';
  state.textContent = ' ' + (finished && !busy ? 'all fingerprinted'
    : uncounted ? said.counting : (said[doing] || 'fingerprinted'));
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

  setPillPop(pill, [
    doing === 'reading' ? `Fingerprinting ${current}`
      : doing === 'matching' ? 'Comparing what has been read so far\u2026'
        : doing === 'loading' ? 'Reading back what has already been fingerprinted\u2026'
          : uncounted ? 'Counting the library\u2026'
            : doing === 'waiting' ? 'Idle \u2014 it reads a video whenever you pause for a moment'
              : doing === 'paused' ? 'Paused'
                : 'Not running',
    counted && downloaded
      ? `${n(fingerprintedOnDisk)} of ${n(downloaded)} downloaded videos fingerprinted`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : counted
        ? 'No videos on this machine to read'
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
    dupeStatus.dismissedSets
      ? `${n(dupeStatus.dismissedSets)} set${dupeStatus.dismissedSets === 1 ? '' : 's'} `
        + 'set aside as not duplicates'
      : null,
    done ? `${n(done)} read this session${rate ? `, about ${n(rate)} an hour` : ''}` : null,
    { text: 'Advanced filters \u2192 Duplicates to see them', dim: true },
    { text: enabled ? 'Click to pause' : 'Click to resume', dim: true },
  ]);
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

function renderFacePill() {
  const pill = $('#facesPill');
  const text = $('#facesText');
  if (!pill || !text) return;
  if (!faceStatus || !faceStatus.available) {
    pill.hidden = true;
    // A pill that disappears takes its card with it, rather than leaving the
    // last numbers it had floating over the toolbar.
    if (pillPop.for === pill) hidePillPop();
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
    waiting: 'idle',
    paused: 'paused',
    stopped: 'stopped',
  };
  const uncounted = !counted && (doing === 'waiting' || doing === 'counting');
  text.appendChild(pillNoun('Faces'));
  const main = document.createElement('span');
  main.textContent = counted && downloaded
    ? `${n(profiledOnDisk)} / ${n(downloaded)}`
    : `${n(profiled)}`;
  text.appendChild(main);

  const state = document.createElement('span');
  state.className = 'faces-doing';
  state.textContent = ' ' + (finished && !busy ? 'all profiled'
    : uncounted ? said.counting : (said[doing] || 'profiled'));
  text.appendChild(state);

  if (cached > 0) {
    const kept = document.createElement('span');
    kept.className = 'faces-cached';
    kept.textContent = ` \u00b7 ${n(cached)} cached`;
    text.appendChild(kept);
  }

  setPillPop(pill, [
    doing === 'reading' ? `Reading ${current}`
      : doing === 'loading' ? 'Reading back what has already been profiled…'
        : uncounted ? 'Counting the library…'
        : doing === 'waiting' ? 'Idle — it reads a video whenever you pause for a moment'
          : doing === 'paused' ? 'Paused'
            : 'Not running',
    counted && downloaded
      ? `${n(profiledOnDisk)} of ${n(downloaded)} videos on this machine profiled`
        + (remaining ? `, ${n(remaining)} to go` : '')
      : counted
        ? 'No videos on this machine to read'
        : `${n(profiled)} videos profiled, still counting the library`,
    cached > 0
      ? `${n(cached)} more were profiled before being freed up to the cloud, and still work`
      : null,
    done ? `${n(done)} read this session${rate ? `, about ${n(rate)} an hour` : ''}` : null,
    lastRead && doing !== 'reading' ? `Last read ${lastRead}` : null,
    `${n(performers)} performer${performers === 1 ? '' : 's'} recognisable so far`,
    { text: enabled ? 'Click to pause' : 'Click to resume', dim: true },
  ]);
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

