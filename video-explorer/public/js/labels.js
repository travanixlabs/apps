'use strict';

function buildStars(current, onPick, { compact = false, edit = true } = {}) {
  const cls = 'stars' + (compact ? ' compact' : '') + (edit ? '' : ' stars-read');
  if (edit) return buildStarRow(current, onPick, cls);
  // Read-only: show what the rating IS, not five slots waiting to be clicked --
  // its whole stars and a half if it has one. An unrated video shows nothing at
  // all, which is the caller's job to skip.
  const wrap = document.createElement('span');
  wrap.className = cls;
  const r = Math.max(0, Math.min(RATING_MAX, Math.round(Number(current) || 0)));
  for (let i = 1; i <= Math.ceil(r / 2); i += 1) {
    const star = document.createElement('span');
    star.className = 'star ' + (r >= i * 2 ? 'on' : 'half');
    star.textContent = '\u2605';
    wrap.appendChild(star);
  }
  wrap.title = `${starsNumber(r)} out of 5 stars`;
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
};

// Which of them hold one value rather than a list -- the matcher's list, read
// here rather than restated, because that is a fact about the data and not
// about this dialog. None of them do, since studio and production went.
for (const [field, spec] of Object.entries(LABEL_FIELDS)) {
  spec.single = SINGLE_VALUED[field] === true;
}

/**
 * `add` puts an editing affordance on the row. Only tags carry one: two on a
 * row meant two buttons opening the same dialog, and the model names are
 * reachable from it either way. A card asks for none of them -- the tiles are
 * for looking through, and a "+ tag" on every one of them is noise. The player
 * keeps it, which is where a tag actually gets typed.
 */
/**
 * The colour a chip should wear, or '' for the default.
 *
 * A label carries its own, because a vocabulary is what you are telling apart
 * at a glance. A performer is one value per video, so the KIND is what gets a
 * colour and every name shares it.
 */
function chipColour(field, value) {
  const config = state.config || {};
  if (field === 'tags') return (config.labelColours || {})[String(value).toLowerCase()] || '';
  return (config.facetColours || {})[field] || '';
}

/**
 * Wears it, or leaves the stylesheet's default alone.
 *
 * Every chip painted here says what it is a chip of, so a colour changed in
 * Settings can find exactly the chips that wear it without a redraw.
 */
function paintChip(el, field, value) {
  el.dataset.chipField = field;
  el.dataset.chipValue = String(value).toLowerCase();
  const colour = chipColour(field, value);
  if (colour) el.style.setProperty('--chip-colour', colour);
  return el;
}

/** One colour's chips, repainted where they stand. A label names its value. */
function repaintChips(field, value = null) {
  const want = value == null ? null : String(value).toLowerCase();
  for (const el of document.querySelectorAll(`[data-chip-field="${field}"]`)) {
    if (want !== null && el.dataset.chipValue !== want) continue;
    const colour = chipColour(field, el.dataset.chipValue);
    if (colour) el.style.setProperty('--chip-colour', colour);
    else el.style.removeProperty('--chip-colour');
  }
}

function buildLabelChips(file, field, { add: withAdd = true, edit = true } = {}) {
  const spec = LABEL_FIELDS[field];
  const Field = field[0].toUpperCase() + field.slice(1);
  const chips = document.createElement('span');
  chips.className = 'chips';

  let values = field === 'models' ? orderedModels(spec.values(file)) : spec.values(file);
  // Credited names go most alike first, each led by how alike: "(90%) Li
  // Rongrong" -- in the player and on the cards alike. Names with no score
  // keep their order, last.
  const scoreOf = field === 'models'
    ? new Map(values.map((v) => [v, matchScore(file, v)])) : null;
  if (scoreOf) {
    values = values.map((v, i) => [v, i])
      .sort(([a, i], [b, j]) => {
        const x = scoreOf.get(a);
        const y = scoreOf.get(b);
        if (x === null && y === null) return i - j;
        if (x === null) return 1;
        if (y === null) return -1;
        return y - x || i - j;
      })
      .map(([v]) => v);
  }
  for (const value of values) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = spec.chip + (edit ? ' has-x' : '');
    paintChip(chip, field, value);
    chip.title = edit
      ? `Filter by "${value}" — the cross takes it off this video`
      : `Filter by "${value}"`;
    chip.addEventListener('click', (ev) => {
      ev.stopPropagation();
      filterByLabel(field, value);
    });
    // In the player, a credited name shows her faces most like this video's.
    if (edit && field === 'models' && state.playing) attachFaceHover(chip, file, creditedSuggestion(file, value));

    const drop = () => editRecords(
      [file.path],
      spec.single ? { [field]: '' } : { ['remove' + Field]: [value] },
    );

    // Filtering is navigation, so it stays everywhere. Removing is an edit, and
    // a cross on a tile you were only looking at is exactly what "the grid does
    // not edit" is meant to stop -- so it is drawn where editing is allowed,
    // which is the player.
    // How alike, ahead of the name and quieter than it: "75% Nicolove".
    const score = scoreOf ? scoreOf.get(value) : null;
    const named = () => {
      const text = document.createElement('span');
      text.className = 'chip-text';
      if (score !== null && score !== undefined) {
        const pct = document.createElement('span');
        pct.className = 'chip-pct';
        pct.textContent = `${Math.round(score * 100)}% `;
        text.appendChild(pct);
      }
      text.appendChild(document.createTextNode(value));
      return text;
    };
    if (!edit) {
      chip.appendChild(named());
    } else {
      // The label is its own element now, because the cross has to sit beside
      // it rather than inside the run of text the ellipsis trims.
      chip.appendChild(named());

      // A span, not a button: a button inside a button is invalid HTML, and
      // this one is reached by the mouse. The chip itself is still a real
      // button, and right-click still removes.
      const cross = document.createElement('span');
      cross.className = 'chip-x';
      cross.textContent = '\u2715';
      cross.title = `Remove "${value}" from this video`;
      cross.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        drop();
      });
      chip.appendChild(cross);

      // Kept: it was the only way to do this, and fingers remember.
      chip.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        drop();
      });
    }
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

function buildRecordRow(file, { edit = true } = {}) {
  const row = document.createElement('div');
  row.className = 'record-row' + (edit ? '' : ' record-read');

  // Only the player rates. On a card the rating is a badge in the corner of the
  // picture -- see buildCornerRating -- so the row below the name is labels
  // alone, and an unlabelled video draws nothing at all.
  if (edit) {
    row.appendChild(buildStars(
      file.rating || 0,
      (rating) => editRecords([file.path], { rating }),
      { compact: true },
    ));
  }

  // Race, height, bust and body are not shown here: they belong to a person and
  // are set, seen and filtered from her section's heading and the filters.
  // Names show when there are names; nothing sits there inviting you to add one.
  if ((file.models || []).length) row.appendChild(buildLabelChips(file, 'models', { add: false, edit }));
  // With no add button and no tags there is nothing to draw, and an empty
  // chip row would still take its gap in the layout.
  if (edit || (file.tags || []).length) {
    row.appendChild(buildLabelChips(file, 'tags', { add: edit, edit }));
  }
  return row;
}

/**
 * The vocabulary by name, for the dialog. It arrives most-used first, which
 * answers "what do I tag with" -- but adding a tag is the other question, "is
 * `nurse` already in here", and for that you look the word up rather than scan
 * for it. The count stays on each chip, so nothing is lost by reordering.
 */
/**
 * What has been typed into each list's search box.
 *
 * Held here rather than read off the input, so a redraw of the dialog keeps
 * what was typed.
 */
const chipFind = { advTags: '', advModels: '' };

/**
 * The vocabulary a box is currently showing.
 *
 * Plain substring, case-insensitive. Not a fuzzy match: with 5,400 performers
 * a loose one puts the name you typed somewhere in the middle of the results,
 * which is worse than nothing when you already know what you are looking for.
 *
 * Chips you have picked are NOT kept in view. They live in the draft rather
 * than in the list, so nothing is lost by filtering them out of sight, and the
 * line at the foot of the dialog goes on counting them.
 */
function vocabFound(field, which) {
  const vocab = vocabByName(field);
  const want = String(chipFind[which] || '').trim().toLowerCase();
  if (!want) return vocab;
  return vocab.filter((entry) => entry.tag.toLowerCase().includes(want));
}

/**
 * Sorted once per vocabulary rather than once per keystroke: 5,400 performers
 * is a sort worth not repeating. Keyed on the array itself, which every update
 * replaces rather than edits, so a new vocabulary is a new sort.
 */
const vocabSorted = new WeakMap();

function vocabByName(field) {
  const vocab = field === 'models' ? state.modelVocab : state.tagVocab;
  let sorted = vocabSorted.get(vocab);
  if (!sorted) {
    sorted = vocab.slice().sort((a, b) => BY_NAME(a.tag, b.tag));
    vocabSorted.set(vocab, sorted);
  }
  return sorted;
}

/** Which input holds which field, so the two sections stay symmetrical. */
const LABEL_INPUTS = {
  tags: { input: '#tagInput', suggest: '#tagSuggest', picked: '#tagPicked' },
  models: { input: '#modelInput', suggest: '#modelSuggest', picked: '#modelPicked' },
};

/**
 * What the editor will save, per field, as a list -- not the text in a box.
 *
 * The box used to BE the value: a comma-separated string you edited by hand,
 * which left every name you had picked sitting in it as text. Now picked
 * labels are pills with a cross, and the box is only for finding the next one.
 */
const labelDraft = { tags: [], models: [] };

/** Puts a label in the draft once, in the vocabulary's own spelling if known. */
function draftAdd(field, raw) {
  const value = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!value) return false;
  const known = (field === 'models' ? state.modelVocab : state.tagVocab)
    .find((e) => e.tag.toLowerCase() === value.toLowerCase());
  const name = known ? known.tag : value;
  if (labelDraft[field].some((t) => t.toLowerCase() === name.toLowerCase())) return false;
  labelDraft[field].push(name);
  return true;
}

function draftDrop(field, name) {
  labelDraft[field] = labelDraft[field].filter((t) => t.toLowerCase() !== name.toLowerCase());
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
    labelDraft[field] = single ? [...(files[0][field] || [])] : [];
    $(LABEL_INPUTS[field].input).value = '';
  }
  $('#tagHint').textContent = single
    ? 'Pick from the list or type a new one and press Enter. The cross on a pill takes it off. Add appends, Replace saves exactly these.'
    : `Pick or type labels, then Add puts them on all ${files.length}. Replace overwrites all ${files.length} with exactly these.`;
  $('#tagReplace').textContent = single ? 'Replace' : `Replace on ${files.length}`;
  $('#tagAdd').textContent = single ? 'Add' : `Add to ${files.length}`;

  // One video starts from its own rating. Across several there is no shared
  // one, so nothing is picked and the save leaves each video's rating alone
  // unless a star is clicked.
  tagRating = single ? (Number(files[0].rating) || 0) : null;
  renderTagRating();

  renderTagSuggestions();
  renderDialogSuggestions(files);
  $('#tagModal').hidden = false;

  // The dialog opens at the top, with the caret in the models box -- naming
  // who is in it is usually the first thing to do. Focused without the scroll,
  // and the body put back to the top in case anything else moved it.
  $('#modelInput').focus({ preventScroll: true });
  $('#tagModal .tag-body').scrollTop = 0;
}

/** The rating the editor will save; null means "leave it as it is". */
let tagRating = null;

function renderTagRating() {
  const box = $('#tagRating');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(buildStars(tagRating || 0, (n) => { tagRating = n; renderTagRating(); }));
  if (tagRating === null) {
    box.insertAdjacentHTML('beforeend', '<span class="dim">unchanged</span>');
  }
}

/** The existing vocabulary as one-click chips — faster than typing, and it
 *  keeps names from splintering into near-duplicates. */
function renderTagSuggestions() {
  for (const field of LABEL_FACETS) {
    const { input, suggest, picked } = LABEL_INPUTS[field];
    const extra = field === 'models' ? ' chip-model' : '';

    // The pills: what will be saved, each with its own way off.
    const pills = $(picked);
    pills.innerHTML = '';
    for (const name of labelDraft[field]) {
      const pill = document.createElement('span');
      pill.className = 'chip has-x' + extra;
      paintChip(pill, field, name);
      const text = document.createElement('span');
      text.className = 'chip-text';
      text.textContent = name;
      const cross = document.createElement('button');
      cross.type = 'button';
      cross.className = 'chip-x';
      cross.textContent = '\u2715';
      cross.title = `Take off ${name}`;
      cross.addEventListener('click', () => { draftDrop(field, name); renderTagSuggestions(); });
      pill.append(text, cross);
      pills.appendChild(pill);
    }
    pills.hidden = !labelDraft[field].length;

    const box = $(suggest);
    box.innerHTML = '';
    // The list is for finding the next one: what is typed narrows it, and what
    // is already a pill is not offered twice.
    const want = $(input).value.trim().toLowerCase();
    const used = new Set(labelDraft[field].map((t) => t.toLowerCase()));
    // Every value, not the first 60. The cap was invisible: with 778 performers
    // the box looked complete and simply had no more to scroll to, which is the
    // one thing a truncated list must never look like. `.tag-suggest` already
    // scrolls, so the length costs nothing but the height it is clamped to.
    // What the video already has comes first, as in the filter dialog: with
    // five thousand performers its own names are otherwise somewhere far down.
    // Performers are found by typing: five thousand names as a wall of pills
    // was more to scroll past than to pick from.
    const found = field === 'models' && !want ? [] : vocabByName(field)
      .filter((entry) => !used.has(entry.tag.toLowerCase())
        && (!want || entry.tag.toLowerCase().includes(want)));
    box.hidden = field === 'models' && !want;
    for (const entry of found) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip suggest' + extra;
      // In the colour Settings gave it, as on a card: the editor is where a
      // label is chosen, and it should look like what it will become.
      paintChip(chip, field, entry.tag);
      chip.textContent = `${entry.tag} · ${entry.count}`;
      chip.addEventListener('click', () => {
        draftAdd(field, entry.tag);
        // Picked: the search is done with, so the box empties for the next.
        $(input).value = '';
        renderTagSuggestions();
        $(input).focus({ preventScroll: true });
      });
      box.appendChild(chip);
    }
    if (!found.length && want) {
      box.insertAdjacentHTML('beforeend',
        '<span class="dim">Nothing by that name \u2014 press Enter to add it as new.</span>');
    }
  }
}

async function commitTags(mode) {
  // Something typed but not yet Entered still counts: pressing Add with a name
  // in the box means that name.
  for (const field of ['tags', 'models']) {
    const box = $(LABEL_INPUTS[field].input);
    if (draftAdd(field, box.value)) box.value = '';
  }
  const tags = [...labelDraft.tags];
  const models = [...labelDraft.models];
  const paths = state.tagTargets.map((f) => f.path);

  $('#tagModal').hidden = true;
  // One request for both fields: separate ones would mean separate saves,
  // separate vocabulary refreshes, and a window where a card shows half the
  // edit.
  const rating = tagRating === null ? {} : { rating: tagRating };
  await editRecords(paths, mode === 'add'
    ? { addTags: tags, addModels: models, ...rating }
    : { tags, models, ...rating });

  const say = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const videos = say(paths.length, 'video');
  toast(mode === 'add'
    ? `Added ${say(tags.length, 'tag')} and ${say(models.length, 'model')} to ${videos}`
    : `Tags and models set on ${videos}`, 'ok');
}

