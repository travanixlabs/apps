'use strict';

// ---------------------------------------------------------------- rendering

/**
 * The first heading or card showing at the top of the page, and how far down
 * the window it sits -- so after a redraw the page can be put back on it.
 */
function pageAnchor() {
  if (!scrollRoot) return null;
  const top = scrollRoot.getBoundingClientRect().top;
  // Cards first: a heading pinned at the top reports where it is pinned, not
  // where it sits in the page, and putting the page back on it would jump to
  // the start of its section. A heading only when no card is in view (every
  // section folded).
  let head = null;
  for (const el of $('#grid').children) {
    const box = el.getBoundingClientRect();
    if (box.bottom <= top) continue;
    if (el.classList.contains('group-head')) {
      if (!head) head = { id: 'h' + el.dataset.group, offset: box.top - top };
      continue;
    }
    if (el.dataset.path) return { id: 'c' + el.dataset.path + '\u0000' + (el.dataset.group || ''), offset: box.top - top };
  }
  return head;
}

function findAnchor(id) {
  for (const el of $('#grid').children) {
    const mine = el.classList.contains('group-head') ? 'h' + el.dataset.group
      : el.dataset.path ? 'c' + el.dataset.path + '\u0000' + (el.dataset.group || '') : null;
    if (mine === id) return el;
  }
  return null;
}

function render() {
  // The same view drawn again -- a label, a tier, a rating changed -- stays
  // where it was. Only a different view starts again from the top.
  const same = heldView === viewSignature() && scrollRoot && scrollRoot.scrollTop > 0;
  const anchor = same ? pageAnchor() : null;
  const was = same ? { top: scrollRoot.scrollTop, drawn: state.rendered } : null;
  renderListing();
  heldView = viewSignature();
  if (!was) return;
  const source = pageSource().length;
  let el = anchor ? findAnchor(anchor.id) : null;
  while (anchor && !el && state.rendered < source && state.rendered < was.drawn + CHUNK) {
    appendPage();
    el = findAnchor(anchor.id);
  }
  // Only as far as the card at the top of the page and one chunk under it --
  // enough to fill the window below. Rebuilding everything that had been drawn
  // made every label or rating cost as much as scrolling there had, all in one
  // task; the tail marker brings the rest back in as the scroll reaches it.
  // An anchor that has gone was looked for past everything drawn before, so
  // the old offset has cards under it either way; with no anchor at all, the
  // old offset is all there is and it needs the old depth.
  if (el && state.rendered < source) appendPage();
  if (!anchor) while (state.rendered < was.drawn && state.rendered < source) appendPage();
  if (el) pinAnchor(el, anchor.offset);
  else scrollRoot.scrollTop = was.top;
}

let heldView = null;
let pinned = null;

/**
 * Puts the card back where it sat and keeps it there for a moment: posters,
 * durations and chips above it fill in after the redraw and would otherwise
 * push it down the page. Let go as soon as the page is scrolled by hand.
 */
function pinAnchor(el, offset) {
  if (pinned) pinned.stop();
  const place = () => {
    if (!el.isConnected) { stop(); return; }
    const drift = el.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - offset;
    if (Math.abs(drift) >= 1) scrollRoot.scrollTop += drift;
  };
  const watcher = new ResizeObserver(place);
  watcher.observe($('#grid'));
  const letGo = () => stop();
  const events = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  for (const name of events) window.addEventListener(name, letGo, { passive: true, capture: true });
  const timer = setTimeout(() => stop(), 3000);
  function stop() {
    watcher.disconnect();
    clearTimeout(timer);
    for (const name of events) window.removeEventListener(name, letGo, { capture: true });
    if (pinned && pinned.stop === stop) pinned = null;
  }
  pinned = { stop };
  place();
}

function renderListing() {
  applyFilterSort();
  const grid = $('#grid');
  // Detach the live player and drop observations on nodes we're discarding.
  stopLive();
  spriteObserver.disconnect();
  // The cards these were waiting for are about to stop existing. What is
  // already in flight lands in the cache and costs the new grid nothing.
  posters.queue.length = 0;
  posters.queued.clear();
  dropPrebuilds();
  if (gridTailWatcher) gridTailWatcher.disconnect();
  grid.innerHTML = '';
  // Every card it held has just left the page. cardsFor() drops them as it
  // trips over them, but only for paths it is asked about -- the rest of a
  // folder's worth stayed reachable from here for the whole session.
  cardIndex.clear();

  renderBreadcrumb();
  // Asked before the tiles are drawn, so they show this folder's state rather
  // than the last one's numbers. Does nothing unless the folder or the filter
  // has actually changed.
  const counting = folderCountsStale();
  renderFolders();
  if (counting) fetchFolderCounts();

  state.rendered = 0;
  $('#filesSection').hidden = state.files.length === 0;
  // Where a file lives is only worth a mark on every tile when the listing has
  // both kinds: all-cloud or all-local, the mark says the same thing each time.
  const anyCloud = state.files.some((f) => f.cloudOnly);
  const anyLocal = state.files.some((f) => !f.cloudOnly);
  grid.classList.toggle('avail-mixed', anyCloud && anyLocal);
  syncCardDetails();
  appendPage();
  syncRovingCard();

  updateSelectionBar();
  renderEmptyState();
  updateStatusLine();
  // A new filter, sort or search moves the open video's place in the listing
  // -- or takes the listing away from under it.
  if (state.playing) syncPlayerNav();
  renderHomeRows();
}

/**
 * The home folder's two rows under its libraries: what was opened lately,
 * and what was labelled lately. Both come from the server (/api/recent), and
 * both are drawn as ordinary cards inside the grid, so a click, a hover and
 * the arrows work on them exactly as they do on a listing. Only at the home
 * folder, and only once the listing there (which is folders) is drawn.
 */
let homeRowsToken = 0;

function atHome() {
  return Boolean(state.dir && state.config.homeDir && samePath(state.config.homeDir, state.dir));
}

async function renderHomeRows() {
  const mine = ++homeRowsToken;
  const grid = $('#grid');
  for (const old of grid.querySelectorAll('.home-row')) old.remove();
  $('#filesSection').classList.remove('home-mode');
  if (!atHome() || state.files.length) return;
  let rows;
  try {
    rows = await api('/api/recent?limit=12');
  } catch { return; }
  // The folder changed while the rows were coming.
  if (mine !== homeRowsToken || !atHome()) return;
  const n = (x) => x.toLocaleString();
  const section = (title, lead, files, kind) => {
    if (!files.length) return;
    const row = document.createElement('section');
    row.className = `home-row home-${kind}`;
    const head = document.createElement('div');
    head.className = 'home-row-head';
    const h = document.createElement('h3');
    h.textContent = title;
    head.appendChild(h);
    const sub = document.createElement('span');
    sub.className = 'home-row-lead';
    sub.textContent = lead;
    head.appendChild(sub);
    row.appendChild(head);
    const strip = document.createElement('div');
    strip.className = 'home-row-cards';
    files.forEach((file, i) => {
      const card = buildCard(file, i);
      const preview = card.querySelector('.preview');
      const when = document.createElement('span');
      when.className = 'badge badge-when';
      when.textContent = fmtWhen(kind === 'opened' ? file.opened : file.updated);
      preview.appendChild(when);
      // Where it was left: a bar along the foot of the picture.
      const info = state.meta.get(file.path) || {};
      if (kind === 'opened' && file.resume && info.duration) {
        const bar = document.createElement('span');
        bar.className = 'resume-bar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(2, Math.min(100, Math.round((file.resume / info.duration) * 100)))}%`;
        bar.appendChild(fill);
        preview.appendChild(bar);
      }
      strip.appendChild(card);
    });
    row.appendChild(strip);
    grid.appendChild(row);
  };
  const opened = hydrateAll(rows.opened);
  const labelled = hydrateAll(rows.labelled);
  section('Recently opened', 'Enter resumes where you stopped', opened, 'opened');
  section('Recently labelled', 'ratings, names and tags you added · newest first', labelled, 'labelled');
  $('#filesSection').hidden = !(opened.length || labelled.length);
  $('#filesSection').classList.toggle('home-mode', Boolean(opened.length || labelled.length));
  if (opened.length || labelled.length) {
    $('#empty').hidden = true;
    $('#fileCount').textContent = `(${n(opened.length + labelled.length)} recent)`;
  }
  for (const card of grid.querySelectorAll('.home-row .card')) spriteObserver.observe(card.querySelector('.preview'));
  fetchMetaFor([...opened, ...labelled]);
  syncRovingCard();
}

/**
 * How many cards one go of the renderer builds.
 *
 * There is still no paging and no button: everything the filters leave is in
 * the listing and will be drawn, just not all in the same frame. Drawing the
 * library root in one go built 27,240 cards and 990,000 nodes in a single
 * blocking task -- eleven seconds in which the window did nothing at all, and
 * a page that stayed a million nodes heavy for the rest of the session. A
 * couple of hundred at a time paints the first screen immediately and the rest
 * arrive under the scroll, which is the only place they can be looked at.
 */
const CHUNK = 240;

/**
 * Renders the next chunk of the listing.
 *
 * The append shape is kept -- start at what is already there -- so a listing
 * that grows underneath can still be topped up without rebuilding the grid.
 */
function appendPage() {
  const grid = $('#grid');
  const source = pageSource();
  const start = state.rendered;
  const end = Math.min(source.length, start + CHUNK);
  if (start >= end) { syncGridTail(); setLoadBar(1); return; }
  const batch = [];

  // Built off-document and attached once: 240 separate appends to a live grid
  // is 240 chances for the browser to lay the whole thing out again.
  const frag = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    if (state.grouped) {
      const slot = state.slots[index];
      // A heading costs a slot of the page, so a section of one video does not
      // arrive with the next twenty-three crammed under it.
      if (slot.head) { frag.appendChild(buildGroupHead(slot.head)); continue; }
      frag.appendChild(buildCard(slot.file, slot.at, slot.group, slot.seq));
      batch.push(slot.file);
      continue;
    }
    const file = state.view[index];
    frag.appendChild(buildCard(file, index));
    batch.push(file);
  }
  state.rendered = end;
  grid.appendChild(frag);
  syncGridTail();

  syncFileCount();
  fetchMetaFor(batch);
  updateStatusLine();
  // The bar under the toolbar: how much of the listing is drawn. Full, it goes.
  setLoadBar(source.length ? end / source.length : 1);
}

/**
 * The two-pixel bar under the toolbar. A fraction fills it that far and
 * clears it once full; `null` is a folder being read, which has no fraction
 * yet, so the bar sweeps instead.
 */
function setLoadBar(fraction) {
  const bar = $('#loadBar');
  if (!bar) return;
  const fill = bar.firstElementChild;
  bar.classList.toggle('busy', fraction === null);
  if (fraction === null) { fill.style.width = ''; return; }
  const done = fraction >= 1;
  fill.style.width = done ? '100%' : `${Math.round(fraction * 100)}%`;
  bar.classList.toggle('done', done);
}

/**
 * The marker that pulls the next chunk in.
 *
 * Kept as the grid's last child and watched from 1200px away, so the cards are
 * there before the scroll reaches where they go rather than after. Nothing
 * else needs the drawn/undrawn distinction: the player's arrows and the
 * selection walk state.view and state.cards, which are the whole listing
 * whatever the grid has got round to building.
 */
let gridTailWatcher = null;

function syncGridTail() {
  const grid = $('#grid');
  if (!grid) return;
  let tail = $('#gridTail');
  const more = state.rendered < pageSource().length;
  if (!more) { if (tail) tail.remove(); return; }
  if (!gridTailWatcher) {
    gridTailWatcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) appendPage();
    }, { root: scrollRoot, rootMargin: '1200px 0px' });
  }
  if (!tail) {
    tail = document.createElement('div');
    tail.id = 'gridTail';
    tail.className = 'grid-tail';
    // Only ever one marker, and a rebuild leaves the old one detached: dropping
    // every observation first is cheaper than tracking which are still live.
    gridTailWatcher.disconnect();
  }
  // Always last: a chunk was just appended after it.
  grid.appendChild(tail);
  gridTailWatcher.observe(tail);
}

/**
 * One performer's heading: the heart that marks them, their name, and how many
 * of the current listing are theirs.
 *
 * The heart writes to the library rather than to any video, so it takes effect
 * everywhere at once — including the order of these very sections, which is why
 * pressing it re-renders rather than just repainting itself.
 */
/**
 * "Not duplicates" on a set of copies.
 *
 * The matcher is confident and still wrong sometimes -- two scenes cut from one
 * shoot, the same trailer on the front of two films -- and until now the only
 * answers were to delete a video that is not a copy or to scroll past the set
 * forever. This is the third answer, and it is remembered by what is in the
 * set rather than by where the set sat in the last matching run.
 */
function buildDupeDismiss(group) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'linkish group-dismiss';
  btn.textContent = 'Not duplicates';
  btn.title = 'Set this aside: these stop being marked as copies of each other';
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const first = group.files[0];
    if (!first) return;
    try {
      const out = await api('/api/dupes/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: first.path }),
      });
      // The endpoint hands back the counts it has just changed, so the pill is
      // right immediately rather than at the next poll.
      setDupeStatus(out.status);
      await refreshDupeFlags();
      render();
      renderDupePill();
      toast(`${out.copies} videos are no longer marked as copies`, 'ok', {
        label: 'Undo',
        run: async () => {
          const back = await api('/api/dupes/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ signature: out.signature }),
          });
          setDupeStatus(back.status);
          await refreshDupeFlags();
          render();
          renderDupePill();
          toast('Put back', 'ok');
        },
      });
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  return btn;
}

/**
 * A section's heading, in two deliberate lines.
 *
 * The first says who this is: the fold, the heart, the name and the numbers,
 * with the rare answers -- not a performer, all profiled, none are -- folded
 * into a menu at its end. The second is the four traits as one strip of equal
 * cells. Laid out as one long run of pills, it wrapped onto anything from one
 * to four rows depending on the window, and no two headings lined up.
 */
function buildGroupHead(group) {
  const head = document.createElement('div');
  const folded = foldedGroups.has(group.key);
  head.className = 'group-head' + (group.unnamed ? ' group-unnamed' : '') + (folded ? ' folded' : '');
  head.dataset.group = group.key;
  const person = !group.unnamed && !group.dupe;

  const line = document.createElement('div');
  line.className = 'group-line';
  head.appendChild(line);

  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'group-fold';
  fold.textContent = folded ? '▸' : '▾';
  fold.title = folded ? 'Expand this section' : 'Collapse this section';
  fold.setAttribute('aria-label', fold.title);
  fold.setAttribute('aria-expanded', String(!folded));
  fold.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (foldedGroups.has(group.key)) foldedGroups.delete(group.key);
    else foldedGroups.add(group.key);
    relayoutGroups(group.key);
  });
  line.appendChild(fold);

  if (person) {
    const tier = favouriteTier(group.name);
    const heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'group-fav' + (tier ? ` on tier-${tier}` : '');
    heart.textContent = tier ? '♥' : '♡';
    if (tier) {
      const badge = document.createElement('span');
      badge.className = 'group-fav-tier';
      badge.textContent = String(tier);
      heart.appendChild(badge);
    }
    heart.title = tier
      ? `${group.name} is a tier ${tier} favourite — click to change or remove`
      : `Mark ${group.name} a favourite`;
    heart.setAttribute('aria-label', heart.title);
    heart.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openFavouritePopup(heart, group.name);
    });
    line.appendChild(heart);
  }

  // A heading, so the outline reads h1 app, h2 Videos, h3 each performer.
  const name = document.createElement('h3');
  name.className = 'group-name';
  name.textContent = group.unnamed ? (group.label || 'Nobody named') : group.name;
  name.title = name.textContent;
  line.appendChild(name);

  if (person) {
    const score = document.createElement('span');
    score.className = 'group-score';
    score.textContent = `${group.points.toLocaleString()} pts`;
    score.title = 'Points per video: 5★ 10,000 · 4.5★ 7,500 · 4★ 5,000 · 3.5★ 2,500 · 3★ 1,000'
      + ' · 2.5★ 500 · 2★ 250 · 1.5★ 100 · 1★ 75 · 0.5★ 50 — counting only what is in this listing.';
    line.appendChild(score);
  }

  // A duplicate section already says how many copies it holds in its name, so
  // it gets what deleting one would give back instead.
  const count = document.createElement('span');
  count.className = 'group-count';
  const many = group.files.length;
  count.textContent = group.dupe
    ? (group.recover ? `${fmtBytes(group.recover)} could go` : 'nothing to choose between here')
    : `${many.toLocaleString()} video${many === 1 ? '' : 's'}`;
  if (group.dupe) {
    count.title = group.recover
      ? 'Keeping the largest copy and deleting the rest would recover this'
      : 'The other copies are somewhere else — flatten the subfolders, or '
        + 'clear the filters, to bring them together';
  }
  line.appendChild(count);

  // How much of this performer the face index has actually read. Only shown
  // once something has been, so the row stays quiet on a library with the
  // feature switched off.
  const profiled = group.files.reduce((n, f) => n + (f.profiled ? 1 : 0), 0);
  if (profiled) {
    const read = document.createElement('span');
    read.className = 'group-profiled' + (profiled === many ? ' all' : '');
    read.textContent = `${profiled.toLocaleString()} profiled`;
    read.title = profiled === many
      ? `All ${many.toLocaleString()} have been read for faces`
      : `${profiled.toLocaleString()} of ${many.toLocaleString()} read for faces so far`;
    line.appendChild(read);
  }

  if (!group.unnamed && group.dupe) line.appendChild(buildDupeDismiss(group));

  // The answers given once in a while, out of the way of the ones given on
  // every heading. Each still asks before it touches anything.
  if (person) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'group-more';
    more.textContent = '…';
    more.title = `More for ${group.name}`;
    more.setAttribute('aria-label', more.title);
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openGroupMenu(more, group);
    });
    line.appendChild(more);
  }

  // Height, bust, body and race, as you label them: one cell each, the
  // current choices lit. Clicking a lit one takes it off again. Body can hold
  // several. Not drawn for a folded section: the line above is all it shows.
  if (person && !folded) {
    const strip = document.createElement('div');
    strip.className = 'group-strip';
    const held = traitsOfName(group.name);
    const cell = (label, values, current, pick) => {
      const box = document.createElement('div');
      box.className = 'group-cell' + (current.length ? '' : ' empty');
      const lead = document.createElement('span');
      lead.className = 'group-cell-lead';
      lead.textContent = label;
      box.appendChild(lead);
      const opts = document.createElement('span');
      opts.className = 'group-cell-opts';
      for (const value of values) {
        const lit = current.includes(value);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'group-race-opt' + (lit ? ' on' : '');
        btn.setAttribute('aria-pressed', String(lit));
        btn.textContent = value;
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          pick(value, lit);
        });
        opts.appendChild(btn);
      }
      box.appendChild(opts);
      strip.appendChild(box);
      return opts;
    };
    for (const [label, field, multi] of [['Height', 'height', false], ['Bust', 'bust', false], ['Body', 'body', true]]) {
      const current = multi ? (held[field] || []) : (held[field] ? [held[field]] : []);
      const opts = cell(label, TRAITS[field], current, (value, lit) => {
        const next = multi
          ? (lit ? current.filter((v) => v !== value) : [...current, value])
          : (lit ? '' : value);
        setPerformerTraits(group, { [field]: next });
      });
      for (const btn of opts.children) {
        const value = btn.textContent;
        const lit = current.includes(value);
        if (lit) paintChip(btn, field, value);
        btn.title = lit ? `Take ${value} off ${group.name}` : `${group.name}: ${label.toLowerCase()} ${value}`;
      }
    }
    const race = raceOfName(group.name);
    const raceOpts = cell('Race', RACES, race ? [race] : [], (value, lit) => {
      setPerformerRace(group, lit ? '' : value);
    });
    for (const btn of raceOpts.children) {
      const value = btn.textContent;
      if (value === race) paintChip(btn, 'race', value);
      btn.title = value === race ? `Take ${value} off ${group.name}` : `${group.name} is ${value}`;
    }
    head.appendChild(strip);
  }

  return head;
}

/**
 * The heading's "…": the three answers that end a performer's section rather
 * than label it. Drawn in the favourite popup's frame -- one popup at a time
 * shares its open and close -- so it dismisses the same way.
 */
function openGroupMenu(anchor, group) {
  closeFavouritePopup();
  const pop = document.createElement('div');
  pop.className = 'fav-pop group-menu';
  pop.setAttribute('role', 'menu');
  const title = document.createElement('div');
  title.className = 'fav-pop-title';
  title.textContent = group.name;
  pop.appendChild(title);
  const acts = [
    ['Not a performer', `"${group.name}" is not a person: take the name off every video`, () => notAPerformer(group.name)],
    // Her videos are labelled right as they stand: each is marked, and
    // suggests nobody else from then on. Says what it would do, so a press
    // that has nothing to do is visible before it is made.
    (() => {
      const { open, pairs } = pendingOnPerformer(group.name);
      if (!open.length) return ['All profiled ✓', `Every one of ${group.name}'s videos is marked all profiled`, null];
      const say = `${open.length.toLocaleString()} video${open.length === 1 ? '' : 's'}`;
      return [pairs ? `All profiled · ${pairs.toLocaleString()} pending` : `All profiled · ${say}`,
        `Mark ${say} of ${group.name}'s as all profiled: no suggestions on them from now on`,
        () => settleGroupSuggestions(group)];
    })(),
  ];
  {
    const { settled } = pendingOnPerformer(group.name);
    if (settled) {
      acts.push([`Suggest again · ${settled.toLocaleString()}`,
        `Undo All profiled on ${group.name}'s ${settled} marked videos`,
        () => settleGroupSuggestions(group, false)]);
    }
  }
  // Grouped by suggestion: every video here only looks like her. Turn the
  // name down on all of them at once.
  if (state.grouped === 'suggested') {
    acts.push(['None are the performer',
      `None of these videos is ${group.name}: turn the suggestion down on every one`,
      () => refuseSuggestedGroup(group)]);
  }
  for (const [label, hint, run] of acts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-row';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.title = hint;
    btn.disabled = !run;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!run) return;
      closeFavouritePopup();
      run();
    });
    pop.appendChild(btn);
  }
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  // Tabbing out of the popup closes it, as clicking away does. Only when the
  // focus is known to have landed somewhere else: a null relatedTarget is a
  // click on a disabled row, which must not close what it sits in.
  pop.addEventListener('focusout', (ev) => {
    if (ev.relatedTarget instanceof Element && !pop.contains(ev.relatedTarget)) closeFavouritePopup();
  });
  document.body.appendChild(pop);

  const box = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width))}px`;
  pop.style.top = `${box.bottom + 6}px`;
  pop.querySelector('.menu-row').focus({ preventScroll: true });

  favPop.el = pop;
  favPop.away = (ev) => { if (!pop.contains(ev.target)) closeFavouritePopup(); };
  favPop.key = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeFavouritePopup();
      anchor.focus({ preventScroll: true });
    }
  };
  setTimeout(() => {
    if (favPop.el !== pop) return;
    document.addEventListener('mousedown', favPop.away, true);
    document.addEventListener('keydown', favPop.key, true);
    window.addEventListener('scroll', closeFavouritePopup, { capture: true, once: true });
  }, 0);
}

/** Takes a credited name off every video in the library, after asking. */
async function notAPerformer(name) {
  const on = (state.modelVocab || []).find((m) => m.tag.toLowerCase() === name.toLowerCase());
  const count = on ? on.count : 0;
  const where = count ? ` It comes off ${count.toLocaleString()} video${count === 1 ? '' : 's'}` : ' It comes off every video';
  if (!window.confirm(`"${name}" is not a performer?${where} in the library, and will not be suggested again.`)) return;
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'not-a-performer', name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.modelVocab = data.models || state.modelVocab;
    setFavourites(data.favourites, data.favouriteTiers);
    setRaces(data.races);
    setTraits(data.traits);
    // The listing in hand still credits the name on every one of them.
    await relistQuietly();
    // The fresh listing still carries her as a suggestion until the faces are
    // rescored, which would leave her section standing under "Only pending".
    const gone = name.toLowerCase();
    for (const file of state.files) {
      if ((file.suggested || []).some((s) => String(s.name).toLowerCase() === gone)) {
        file.suggested = file.suggested.filter((s) => String(s.name).toLowerCase() !== gone);
      }
    }
    render();
    toast(`"${name}" removed from ${data.changed.toLocaleString()} video${data.changed === 1 ? '' : 's'}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** Loaded of matching, or matching of scanned — whichever the listing is short of. */
function syncFileCount() {
  syncGroupsFold();
  // Grouped, the honest number is cards rather than videos: the same video is on
  // screen once per performer in it, and "12 of 9" would look like a bug.
  const total = slotCards();
  const loaded = state.grouped ? state.rendered - headsBefore(state.rendered) : state.rendered;
  const n = (x) => x.toLocaleString();
  $('#fileCount').textContent = loaded < total
    ? `(${n(loaded)} of ${n(total)})`
    : `(${n(total)}${total === state.files.length ? '' : ' of ' + n(state.files.length)})`;
}

/**
 * How many headings sit in the first `n` slots. A binary search of where they
 * are, because the count of cards drawn is asked after every chunk, and
 * counting them meant copying and walking everything drawn so far each time.
 */
function headsBefore(n) {
  const heads = state.headSlots || [];
  let lo = 0;
  let hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid] < n) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function updateStatusLine() {
  const bits = [];
  if (state.files.length) {
    const n = (x) => x.toLocaleString();
    const shown = state.view.length === state.files.length
      ? `${n(state.files.length)} video${state.files.length === 1 ? '' : 's'} here`
      : `${n(state.view.length)} of ${n(state.files.length)} shown`;
    bits.push(state.rendered < state.view.length ? `${shown} · ${n(state.rendered)} loaded` : shown);
  }
  if (!state.config.recursive && state.totalBelow > state.files.length) {
    bits.push(`${state.totalBelow.toLocaleString()} below`);
  }
  if (state.selected.size) bits.unshift(`${state.selected.size.toLocaleString()} selected`);
  setStatus(bits.join(' · '));
  // The band's one-line summary says the same count, where the band is.
  if (typeof syncBand === 'function' && !$('#foldersSection').hidden) syncBand();
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
        updateCardMeta(filePath, fileAt(filePath));
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
function updateCardMeta(filePath, known) {
  const file = known || fileAt(filePath);
  if (!file) return;
  const info = state.meta.get(filePath) || {};

  // Every copy: one probe answers for the video, and grouped it is on screen
  // once per performer in it.
  for (const card of cardsFor(filePath)) {
    // The corner no longer falls back to a file size, so an unprobed tile has
    // no duration badge at all -- it has to be made when the probe lands, and
    // put in front of the rating rather than after it.
    if (info.duration) {
      let badge = card.querySelector('.badge-duration');
      if (!badge) {
        const corner = card.querySelector('.badge-corner');
        if (corner) {
          badge = document.createElement('span');
          badge.className = 'badge badge-duration';
          corner.prepend(badge);
        }
      }
      if (badge) badge.textContent = fmtDuration(info.duration);
    }

    const preview = card.querySelector('.preview');
    if (preview && info.duration) preview.dataset.duration = String(info.duration);
    // The duration and the resolution arrive with the probe.
    const meta = card.querySelector('.card-meta');
    if (meta) meta.replaceWith(buildCardMeta(file));
  }
}

/**
 * The line under a card's name: "12:34 · 1080p · 26 Aug 2025" on the left,
 * the stars on the right. The facts give way first (ellipsis); the stars are
 * short and keep their place.
 */
function buildCardMeta(file) {
  const row = document.createElement('span');
  row.className = 'card-meta';
  const facts = document.createElement('span');
  facts.className = 'card-meta-text';
  facts.textContent = cardMetaText(file);
  facts.title = facts.textContent;
  row.appendChild(facts);
  if (file.rating) row.appendChild(buildCornerRating(file.rating));
  return row;
}

/**
 * The block where the grid would be, when there is none: before any folder
 * is open (how to start), an open folder with nothing in it, or a folder
 * that could not be read. Each says its own thing; a failed scan used to
 * show whatever the previous listing had left there.
 */
function renderEmptyState(mode = null) {
  const empty = $('#empty');
  let which = mode || (state.dir ? 'empty' : 'onboarding');
  if (!mode) {
    // Videos here, none left by the filter or the search: a different
    // message, with the way out of it.
    if (state.files.length && !state.view.length) which = 'filtered';
    else if (state.files.length || state.folders.length) { empty.hidden = true; return; }
  }
  empty.hidden = false;
  empty.classList.toggle('is-error', which === 'error');
  const n = (x) => Number(x || 0).toLocaleString();
  const facets = (() => {
    let c = 0;
    for (const f of ALL_FACETS) if (state.adv[f] && state.adv[f].size) c += 1;
    return c;
  })();
  const said = {
    onboarding: {
      title: 'Point me at a folder of MP4s.',
      text: 'Type or browse to a path, then press Open. Hover any tile to play through 10 points in the video.',
      action: ['Browse…', () => pickFolder('Choose a video folder', (dest) => { $('#dirInput').value = dest; scan(dest); })],
    },
    error: {
      title: 'Folder not found',
      text: `${state.dir || 'That folder'} could not be opened. Check the path, or browse to another one.`,
      action: ['Choose a folder', () => pickFolder('Choose a video folder', (dest) => { $('#dirInput').value = dest; scan(dest); })],
    },
    filtered: {
      title: 'Nothing matches',
      text: `${facets ? `${facets} filter${facets === 1 ? '' : 's'}` : 'The search'}, 0 of ${n(state.files.length)} videos.`
        + (facets ? ' Try dropping one.' : ' Try a shorter term.'),
      action: facets ? ['Edit filter', () => openAdvanced()] : ['Clear search', () => { $('#searchInput').value = ''; searchNow(); }],
    },
    empty: {
      title: 'This folder is empty',
      text: 'No videos here' + (state.folders.length ? '. Subfolders, if any, are in the band above.' : ' and no subfolders.'),
      action: state.parent ? ['Go up', () => navigateTo(state.parent)] : null,
    },
  }[which];
  empty.replaceChildren();
  const title = document.createElement('h2');
  title.className = 'empty-title';
  title.textContent = said.title;
  empty.appendChild(title);
  const text = document.createElement('p');
  text.textContent = said.text;
  empty.appendChild(text);
  if (said.action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = said.action[0];
    btn.addEventListener('click', said.action[1]);
    empty.appendChild(btn);
  }
}

function buildCard(file, index, group = null, seq = null) {
  const card = document.createElement('article');
  card.className = 'card' + (state.selected.has(file.path) ? ' selected' : '');
  card.dataset.path = file.path;
  // One card at a time is in the Tab order (see rovingCard); the arrows move
  // between them, Enter plays, Space selects (onGridKey). Every card used to
  // be a Tab stop, with its quick-bar buttons after it: thousands of stops.
  card.tabIndex = -1;
  card.setAttribute('aria-label', file.name);
  if (group && group.key != null) card.dataset.group = group.key;
  indexCard(file.path, card);
  cardArgs.set(card, { file, index, group, seq });

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

  // A button, so it is announced as one and says whether it is pressed; it
  // still looks like the ring it always was.
  const selectMark = document.createElement('button');
  selectMark.type = 'button';
  selectMark.className = 'select-mark';
  selectMark.textContent = '✓';
  selectMark.setAttribute('aria-pressed', String(state.selected.has(file.path)));
  selectMark.setAttribute('aria-label', 'Select');
  preview.appendChild(selectMark);

  // Bottom right holds what the video is and what you made of it. The rating
  // sits here rather than under the name because the corner was showing a file
  // size, which is the least interesting fact about a video, and the row below
  // was carrying a control on a page you only scroll through.
  const corner = document.createElement('div');
  corner.className = 'badge-corner';
  // How long it runs, when that is known. No size fallback: a video's weight in
  // megabytes told you nothing you wanted while looking for something to watch,
  // and a tile whose duration has not been read yet is better blank than
  // padded out with it.
  if (info.duration) {
    const durationBadge = document.createElement('span');
    durationBadge.className = 'badge badge-duration';
    durationBadge.textContent = fmtDuration(info.duration);
    corner.appendChild(durationBadge);
  }
  // The rating sits on the meta line under the name now, so the picture
  // carries only the duration and the tick row.
  preview.appendChild(corner);

  // Grouped by suggested performer, how like her the faces are. Only there:
  // grouped by credited performer her name is a pill on the card, and the pill
  // carries the number -- "(90%) Qin Kexin" -- the way the player's does.
  if (group && !group.unnamed && state.grouped === 'suggested') {
    const score = matchScore(file, group.name);
    if (score !== null) {
      const match = document.createElement('span');
      match.className = 'match-mark';
      match.textContent = `${Math.round(score * 100)}%`;
      match.title = `${Math.round(score * 100)}% like ${group.name}'s average face`;
      preview.appendChild(match);
    }
  }

  // Where the file lives, top right, on every tile.
  const avail = document.createElement('span');
  avail.className = 'avail-mark' + (file.cloudOnly ? ' is-cloud' : '');
  avail.innerHTML = file.cloudOnly ? ICON_CLOUD : ICON_LOCAL;
  avail.title = file.cloudOnly ? 'Cloud only' : 'Downloaded to this PC';
  preview.appendChild(avail);

  if (file.cloudOnly) {
    const cloudMark = document.createElement('div');
    cloudMark.className = 'cloud-mark';
    cloudMark.innerHTML = `<span class="cloud-ico">${svgIcon(ICON_PATHS.cloud, 26)}</span>`;
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
  preview.appendChild(playBtn);

  preview.appendChild(buildQuickbar(file, card));

  // The picture, the play button and the ring answer clicks through the grid
  // (see onGridClick), and so does dragging the card.
  selectMark.title = 'Select';

  attachHover(preview, file);
  // Its picture is asked for once it nears the window -- including the tiles
  // already in it, which the observer reports on its first pass. Cloud tiles
  // are asked for too: the server serves an already-cached poster and answers
  // 409 when there is none, so nothing gets downloaded either way.
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

  // One quiet line of how long, how sharp and when, with the rating at its
  // right end -- switchable in Settings, for anyone who wants the cards back
  // to name and labels only. The rating stays either way.
  details.appendChild(buildCardMeta(file));

  // Below that, the rating and the labels. The running time is on the picture,
  // cloud-only has its own mark there, and the size and codec are in the
  // player and the hover bar.
  details.appendChild(buildRecordRow(file, { edit: false }));

  card.appendChild(details);
  card.draggable = true;
  markGroupChip(card);
  return card;
}

/**
 * Grouped by credited performer, the name the card is filed under stands out
 * among the names on it -- a video credited to three is under each of them.
 */
function markGroupChip(card) {
  if (state.grouped !== 'models' || !card.dataset.group) return;
  for (const chip of card.querySelectorAll('.record-row [data-chip-field="models"]')) {
    chip.classList.toggle('is-group', chip.dataset.chipValue === card.dataset.group);
  }
}

/**
 * What each card was built for: the video, its place in its list, its section
 * and its seat in the reading order -- what the one set of grid listeners below
 * needs to act on a card. Kept with the element rather than looked up by path:
 * the duplicates view draws copies from other folders that are not in this
 * listing at all, and a weak map lets a discarded card go with its entry.
 */
const cardArgs = new WeakMap();

function cardAt(target) {
  const card = target && target.closest ? target.closest('.card') : null;
  const args = card ? cardArgs.get(card) : null;
  return args ? { card, ...args } : null;
}

/**
 * Clicks on a card, for every card at once.
 *
 * Three listeners on each of a few thousand cards were thousands of closures
 * made per chunk and dropped per redraw; one on the grid does the same job.
 * Anything inside a card that must not reach here -- the quick bar, the label
 * chips -- already stops its click on the way up, as it had to before.
 *
 * The thumbnail plays; the ring selects. Watching something is the common case,
 * so a bare click does that. Once a selection exists you are plainly in the
 * middle of picking things, and a click adds to it rather than interrupting with
 * a player -- so building a selection stays a one-click-per-item job after the
 * first. The first item therefore has to come from the ring, which is the only
 * unambiguous way to say "select" rather than "play".
 */
function onGridClick(ev) {
  const at = cardAt(ev.target);
  if (!at) return;
  const { file, index, group, seq } = at;
  if (ev.target.closest('.select-mark')) {
    ev.stopPropagation();
    ev.preventDefault();
    toggleSelect(file.path, index, ev.shiftKey, group);
    return;
  }
  if (ev.target.closest('.play-center')) {
    ev.stopPropagation();
    ev.preventDefault();
    playFile(file, seq);
    return;
  }
  if (!ev.target.closest('.preview') || ev.target.closest('.quickbar')) return;
  const selecting = state.selected.size > 0 || ev.shiftKey;
  if (!selecting) { playFile(file, seq); return; }
  if (ev.shiftKey) ev.preventDefault(); // stop shift-click text selection
  toggleSelect(file.path, index, ev.shiftKey, group);
}

/**
 * A focused card answers the two keys a tile needs: Enter plays it, Space
 * selects it. Only the card itself -- a key pressed in the rename box or on a
 * quick-bar button inside it is that control's.
 */
/** The cards on screen, in reading order -- what the arrow keys move over. */
function tabbableCards() {
  return [...grid.querySelectorAll('.card')].filter((c) => c.offsetParent !== null);
}

/** How many cards sit in a row of the grid as it is laid out now. */
function gridColumns() {
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

/**
 * One card carries tabIndex 0 and the rest -1, so Tab enters the grid once
 * (at the card last used) and leaves it once. Its quick-bar buttons are in
 * the Tab order only while their card has the focus, so the bar is one stop
 * inside the card rather than eight stops per tile.
 */
function rovingCard(card) {
  const was = grid.querySelector('.card[tabindex="0"]');
  if (was && was !== card) {
    was.tabIndex = -1;
    for (const b of was.querySelectorAll('.quickbar .qbtn')) b.tabIndex = -1;
  }
  if (card) {
    card.tabIndex = 0;
    for (const b of card.querySelectorAll('.quickbar .qbtn')) b.tabIndex = 0;
  }
}

/** After a render: if no card is in the Tab order, the first one is. */
function syncRovingCard() {
  if (grid.querySelector('.card[tabindex="0"]')) return;
  const first = tabbableCards()[0];
  if (first) rovingCard(first);
}

function onGridKey(ev) {
  if (!ev.target.classList || !ev.target.classList.contains('card')) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const at = cardAt(ev.target);
  if (!at) return;
  const arrows = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: gridColumns(), ArrowUp: -gridColumns() };
  if (ev.key in arrows || ev.key === 'Home' || ev.key === 'End') {
    const cards = tabbableCards();
    const here = cards.indexOf(ev.target);
    if (here < 0) return;
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? cards.length - 1
      : Math.max(0, Math.min(cards.length - 1, here + arrows[ev.key]));
    ev.preventDefault();
    ev.stopPropagation();
    rovingCard(cards[next]);
    cards[next].focus({ preventScroll: false });
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    ev.stopPropagation();
    playFile(at.file, at.seq);
  } else if (ev.key === ' ') {
    ev.preventDefault();
    ev.stopPropagation();
    toggleSelect(at.file.path, at.index, ev.shiftKey, at.group);
  }
}

/** Wires the grid once; the cards themselves carry no click or drag listeners. */
function attachGridHandlers() {
  const grid = $('#grid');
  grid.addEventListener('click', onGridClick);
  grid.addEventListener('keydown', onGridKey);
  // The card the focus lands on -- by click, by arrow, by Shift+Tab back in
  // -- becomes the one Tab stop.
  grid.addEventListener('focusin', (ev) => {
    const card = ev.target instanceof Element ? ev.target.closest('.card') : null;
    if (card && card.tabIndex !== 0) rovingCard(card);
  });
  grid.addEventListener('dragstart', (ev) => {
    const at = cardAt(ev.target);
    if (at) cardDragStart(ev, at.file, at.index);
  });
  grid.addEventListener('dragend', (ev) => {
    if (cardAt(ev.target)) cardDragEnd();
  });
}

/** The host, without the www, which is all the room there is for it. */
function sourceLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') + ' \u2197';
  } catch {
    return 'source \u2197';
  }
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
    // Where this came from. A link rather than a button, so it opens in the
    // real browser exactly as the one on the card used to -- and first in the
    // row, because it is the only one that does not touch the file.
    ...(file.url ? [{
      icon: ICONS.link,
      label: 'Source',
      title: `Open ${sourceLabel(file.url).replace(/ ↗$/, '')} — ${file.url}`,
      href: file.url,
    }] : []),
    ...(file.cloudOnly ? [{
      icon: ICONS.cloud,
      label: 'Preview',
      title: `Fetch preview — downloads ${fmtBytes(file.size)} from OneDrive`,
      run: () => optInCloud(file, cardFor()),
    }] : []),
    // Card-only: the player footer carries the rating and tag row itself, so
    // this would be a second way to reach what is already sitting next to it.
    ...(inPlayer ? [] : [
      {
        icon: ICONS.tag,
        label: 'Tags',
        title: 'Tags',
        run: () => openTagDialog([fileAt(file.path) || file]),
      },
    ]),
    {
      icon: ICONS.rename,
      label: 'Rename',
      title: 'Rename',
      run: () => (inPlayer ? renameFromPlayer(file) : startRename(file, cardFor())),
    },
    {
      icon: ICONS.move,
      label: 'Move',
      title: 'Move to…',
      run: () => pickFolder('Move to folder', async (dest) => {
        if (inPlayer) releasePlayer();
        const results = await doAction('move', [file.path], { dest });
        if (inPlayer && results.some((r) => r.ok)) closePlayer();
        else if (inPlayer) reopenPlayer(file);
      }),
    },
    {
      icon: ICONS.trash,
      label: 'Delete',
      title: 'Delete (Recycle Bin)',
      danger: true,
      run: async () => {
        // Chosen before the delete, while the listing still has this video in
        // it to say where "next" is.
        const after = inPlayer ? afterRemoval(file) : null;
        if (inPlayer) releasePlayer();
        const deleted = await confirmDelete([file.path]);
        if (inPlayer && deleted) moveOnFrom(file, after);
        else if (inPlayer) reopenPlayer(file);
      },
    },
  ];
}

/**
 * One action as something you can press.
 *
 * An anchor when the action is a link and a button otherwise: a link has to be
 * a real one for the shell to hand it to the browser, and preventing its
 * default is exactly what would stop that.
 */
function buildActionButton(action, { labelled = false } = {}) {
  const el = document.createElement(action.href ? 'a' : 'button');
  el.className = 'qbtn' + (action.danger ? ' danger' : '') + (labelled ? ' qbtn-labelled' : '');
  // Every action's icon is one of ICONS, drawn markup rather than a glyph.
  el.innerHTML = action.icon;
  // In the player there is room for the word, and a row of words reads
  // faster than a row of glyphs you have to hover.
  if (labelled && action.label) {
    const word = document.createElement('span');
    word.className = 'qbtn-label';
    word.textContent = action.label;
    el.appendChild(word);
  }
  el.title = action.title;
  el.setAttribute('aria-label', action.title);
  // In the Tab order only while the card has the focus (see rovingCard).
  el.tabIndex = -1;
  if (action.href) {
    el.href = action.href;
    el.target = '_blank';
    el.rel = 'noopener noreferrer';
    // A click on the card plays the video, and one on the stage pauses it.
    el.addEventListener('click', (ev) => ev.stopPropagation());
    return el;
  }
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    action.run();
  });
  return el;
}

function buildQuickbar(file, card) {
  const bar = document.createElement('div');
  bar.className = 'quickbar';
  for (const action of actionsFor(file, { card })) bar.appendChild(buildActionButton(action));
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

/** A card picked up: reached through the grid (see attachGridHandlers). */
function cardDragStart(ev, file, index) {
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
}

function cardDragEnd() {
  document.body.classList.remove('dragging');
  removeDragGhost();
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
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

// Sections folded away, by key. Every grouping starts with all of them open:
// cleared when the grouping changes, and never saved.
const foldedGroups = new Set();

/**
 * Rebuilds the grouped page in place after a fold, keeping as much loaded as
 * before -- and at least down to the heading that was clicked -- so the page
 * stays where it was rather than jumping back to the top.
 */
function relayoutGroups(key) {
  if (!state.grouped) return;
  const loaded = state.rendered;
  buildSlots();
  const at = key ? state.slots.findIndex((s) => s.head && s.head.key === key) : -1;
  $('#grid').innerHTML = '';
  cardIndex.clear();
  state.rendered = 0;
  const want = Math.min(state.slots.length, Math.max(loaded, at + 1));
  while (state.rendered < want) appendPage();
  syncFileCount();
  if (state.playing) syncPlayerNav();
}

function syncGroupsFold() {
  const only = $('#groupsOnly');
  if (only) {
    const mode = state.grouped;
    only.hidden = !(mode in groupOnly);
    if (!only.hidden) {
      $('#groupsOnlyBox').checked = groupOnly[mode];
      $('#groupsOnlyText').textContent = mode === 'suggested'
        ? 'Only pending — not yet added or turned down'
        : 'Only videos with duplicates';
    }
  }
  const btn = $('#groupsFold');
  if (!btn) return;
  btn.hidden = !state.grouped || !state.groups.length;
  const all = state.groups.length && state.groups.every((g) => foldedGroups.has(g.key));
  btn.textContent = all ? 'Expand all' : 'Collapse all';
}

/**
 * The groupings, as the menu offers them: what each is called in full, and the
 * word the toolbar button wears while it is in force.
 */
const GROUP_LABELS = {
  '': { long: 'None', short: '' },
  models: { long: 'Credited performer', short: 'Credited' },
  suggested: { long: 'Suggested performer', short: 'Suggested' },
  dupes: { long: 'Duplicates', short: 'Duplicates' },
};

/**
 * Groups the listing one way, or (mode '') not at all. No toast: the button and
 * the Videos heading both say which grouping is in force.
 */
async function setGrouped(mode) {
  if (!GROUP_MODES.includes(mode)) mode = '';
  if (mode === state.grouped) return;
  state.grouped = mode;
  foldedGroups.clear();
  syncGroupButton();
  const sorted = syncSortToGrouping();
  if (sorted) saveConfig(sorted);
  // The whole set, not the part of it in this folder.
  if (state.grouped === 'dupes') await fetchOtherCopies();
  else forgetOtherCopies();
  await saveConfig({ grouped: state.grouped });
  render();
}

/** A menu like the sort one: four rows, the grouping in force ticked. */
function renderGroupMenu() {
  const menu = $('#groupMenu');
  menu.replaceChildren();
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = 'Group by';
  menu.appendChild(head);
  for (const mode of GROUP_MODES) {
    const on = mode === state.grouped;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'menu-row' + (on ? ' on' : '');
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(on));
    const label = document.createElement('span');
    label.textContent = GROUP_LABELS[mode].long;
    row.appendChild(label);
    const tick = document.createElement('span');
    tick.className = 'menu-arrow';
    tick.textContent = on ? '✓' : '';
    row.appendChild(tick);
    row.title = {
      '': 'The plain listing',
      models: 'A section per credited performer, best rated first',
      suggested: 'A section per performer the faces point to, 20% and up, less names turned down',
      dupes: 'A section per video, with every copy of it side by side',
    }[mode];
    row.addEventListener('click', () => {
      toggleGroupMenu(false);
      setGrouped(mode);
    });
    menu.appendChild(row);
  }
}

function toggleGroupMenu(open) {
  const menu = $('#groupMenu');
  const show = open === undefined ? menu.hidden : open;
  if (show) { toggleVolumeMenu(false); toggleSortMenu(false); renderGroupMenu(); }
  menu.hidden = !show;
  $('#groupBtn').setAttribute('aria-expanded', String(show));
  if (show) {
    const current = menu.querySelector('.menu-row.on') || menu.querySelector('.menu-row');
    if (current) current.focus({ preventScroll: true });
  }
}

function syncGroupButton() {
  const btn = $('#groupBtn');
  if (!btn) return;
  const mode = state.grouped || '';
  const names = GROUP_LABELS[mode] || GROUP_LABELS[''];
  btn.classList.toggle('on', Boolean(mode));
  // Each grouping keeps its own colour, so the state reads without the menu.
  btn.classList.toggle('by-dupes', mode === 'dupes');
  btn.classList.toggle('by-suggested', mode === 'suggested');
  btn.title = mode ? `Grouped by ${names.long.toLowerCase()} — click to change` : 'Group by…';
  btn.setAttribute('aria-label', mode ? `Group by: ${names.long}` : 'Group by');
  const label = $('#groupBtnLabel');
  if (label) label.textContent = mode ? names.short : 'Off';
  // The heading over the grid says it too, where the sections are.
  const echo = $('#groupEcho');
  if (echo) {
    echo.textContent = mode ? `· grouped by ${names.long.toLowerCase()}` : '';
    echo.hidden = !mode;
  }
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
    const on = state.selected.has(card.dataset.path);
    card.classList.toggle('selected', on);
    const ring = card.querySelector('.select-mark');
    if (ring) ring.setAttribute('aria-pressed', String(on));
  }
  updateSelectionBar();
}

function updateSelectionBar() {
  const count = state.selected.size;
  // The strip at the foot says "2 selected" too; it reads the selection.
  if (typeof updateStatusLine === 'function' && state.files.length) updateStatusLine();
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
  holder.replaceChildren(buildStars(uniform ? first : 0,
    (rating) => editRecords(selectedPaths(), { rating })));
  // Download for any cloud-only among them, Cloud for any downloaded.
  $('#batchDownload').hidden = !picked.some((f) => f.cloudOnly);
  $('#batchCloud').hidden = !picked.some((f) => !f.cloudOnly);
}

/** All selected files, including any hidden by the current filter — so the
 *  count in the selection bar always matches what an action will touch. */
function selectedPaths() {
  return state.files.filter((f) => state.selected.has(f.path)).map((f) => f.path);
}

