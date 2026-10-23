'use strict';

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

/**
 * The path box, shown in the breadcrumb's place while a path is typed. The
 * crumbs come back with the next listing (renderBreadcrumb), or on Escape.
 */
function openPathEdit() {
  $('#breadcrumb').hidden = true;
  const edit = $('#pathEdit');
  edit.hidden = false;
  const input = $('#dirInput');
  input.value = state.dir || input.value;
  input.focus();
  input.select();
}

function closePathEdit() {
  if (!state.dir) return;
  $('#pathEdit').hidden = true;
  $('#breadcrumb').hidden = false;
  $('#dirInput').value = state.dir;
}

function renderBreadcrumb() {
  const bar = $('#breadcrumb');
  const edit = $('#pathEdit');
  if (!state.dir) { bar.hidden = true; edit.hidden = false; return; }
  bar.hidden = false;
  edit.hidden = true;
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
    homeBtn.innerHTML = ICONS.home;
    homeBtn.setAttribute('aria-label', 'Default folder');
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

  // The trail sits in a box that reads as the path field it replaces, with
  // "edit" and "Browse" at its right end: edit brings the typed-path box
  // back in its place, Browse opens the folder picker.
  const box = document.createElement('div');
  box.className = 'crumb-box';
  box.title = 'Click a folder to go there; edit to type a path';
  bar.appendChild(box);

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
      box.appendChild(sep);
    }
    const isCurrent = index === parts.length - 1;
    const crumb = document.createElement('button');
    crumb.className = 'crumb' + (isCurrent ? ' current' : '');
    crumb.textContent = part;
    crumb.title = target;
    crumb.addEventListener('click', () => navigateTo(target));
    // The current folder is not a drop target — files are already in it.
    if (!isCurrent) attachDropTarget(crumb, target, part);
    box.appendChild(crumb);
  });

  const tail = document.createElement('span');
  tail.className = 'crumb-tail';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'crumb-tail-btn';
  editBtn.textContent = 'edit';
  editBtn.title = 'Type a path';
  editBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openPathEdit(); });
  tail.appendChild(editBtn);
  tail.appendChild(document.createTextNode(' · '));
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'crumb-tail-btn';
  browse.textContent = 'Browse';
  browse.title = 'Pick a folder';
  browse.addEventListener('click', (ev) => {
    ev.stopPropagation();
    pickFolder('Choose a video folder', (dest) => { $('#dirInput').value = dest; scan(dest); });
  });
  tail.appendChild(browse);
  box.appendChild(tail);
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
  // A performer facet's answer changes when somebody is labelled, without the
  // filter itself changing, so the labelling's version is part of the key.
  const raced = personFiltered() ? '\u0000r' + (state.raceVersion || 0) : '';
  return state.dir + '\u0000' + JSON.stringify(packFilter(state.adv)) + raced;
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

/**
 * The count on a folder card, and the quieter fraction after it.
 *
 * Unfiltered: "1,204", then "· 37 on disk" only when that is neither none nor
 * all of them -- a folder entirely here or entirely in the cloud has nothing
 * to add. Filtered: "3 / 91", how many survive the filter of how many there
 * are. The size moved to the hover card: "how big is this" is a question you
 * ask of one folder, not of forty.
 */
function folderTallyText(folder) {
  const { total, downloaded, matched, waiting } = folderTally(folder);
  const n = (x) => x.toLocaleString();
  if (folderCounts.key) {
    const left = matched === null ? (waiting ? '…' : '?') : n(matched);
    return { count: `${left} / ${n(total)}`, extra: '' };
  }
  const partial = downloaded > 0 && downloaded < total;
  return { count: n(total), extra: partial ? `· ${n(downloaded)} on disk` : '' };
}

/**
 * Whether the band is folded in this folder. Remembered per folder, under the
 * lowercased path, because the folder that needs its forty subfolders out of
 * the way is not the one whose three you want to see.
 */
function bandFoldedHere() {
  const held = state.config.bandFolded;
  return Boolean(held && state.dir && held[state.dir.toLowerCase()]);
}

function setBandFolded(folded) {
  if (!state.dir) return;
  const key = state.dir.toLowerCase();
  const held = { ...(state.config.bandFolded || {}) };
  if (folded) held[key] = true;
  else delete held[key];
  state.config.bandFolded = held;
  saveConfig({ bandFolded: held });
  syncBand();
}

/** The band's fold state and its one-line summary, from what is known now. */
function syncBand() {
  const section = $('#foldersSection');
  const folded = bandFoldedHere();
  section.classList.toggle('collapsed', folded);
  const head = $('#foldersCollapse');
  head.setAttribute('aria-expanded', String(!folded));
  head.title = folded ? 'Show the subfolders' : 'Hide the subfolders';
  const n = (x) => Number(x || 0).toLocaleString();
  const bits = [];
  if ($('#recursiveToggle').checked) bits.push('flattened');
  if (state.files.length) bits.push(`${n(state.files.length)} video${state.files.length === 1 ? '' : 's'}`);
  else if (state.totalBelow) bits.push(`${n(state.totalBelow)} below`);
  $('#bandSummary').textContent = bits.length ? `· ${bits.join(' · ')}` : '';
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
  // With no videos listed, folders are the listing: a wrapping grid rather
  // than one row, and the window is theirs.
  section.classList.toggle('expanded', state.files.length === 0);
  // The home folder's few libraries get the whole width, with a wide cover.
  section.classList.toggle('home', Boolean(state.config.homeDir) && samePath(state.config.homeDir, state.dir));
  syncBand();
  // A new folder's row starts at its own left edge rather than wherever the
  // last one was scrolled to.
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;
  const n = (x) => x.toLocaleString();
  $('#folderCount').textContent = folders.length === state.folders.length
    ? `${n(state.folders.length)} subfolder${state.folders.length === 1 ? '' : 's'}`
    : `${n(folders.length)} of ${n(state.folders.length)} subfolders`;

  for (const folder of folders) {
    const tile = document.createElement('button');
    tile.className = 'folder-tile' + (folder.videoCount === 0 ? ' no-videos' : '');
    tile.setAttribute('role', 'listitem');
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
      cover.innerHTML = svgIcon(ICON_PATHS.folder, 22);
    }
    tile.appendChild(cover);

    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = folder.name;
    tile.appendChild(name);

    const meta = document.createElement('span');
    meta.className = 'folder-meta';
    if (folder.videoCount === 0) {
      meta.textContent = 'no videos';
    } else {
      const { count, extra } = folderTallyText(folder);
      meta.textContent = count;
      if (extra) {
        const more = document.createElement('span');
        more.className = 'folder-meta-extra';
        more.textContent = ' ' + extra;
        meta.appendChild(more);
      }
      meta.classList.toggle('filtered', folderCounts.key !== '');
    }
    tile.appendChild(meta);
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

  placePop(pop, tile);
}

function hideFolderPop() {
  const pop = $('#folderPop');
  if (pop) pop.hidden = true;
}

/**
 * Put a hover card under the thing it belongs to, or over it near the bottom.
 *
 * Measured after filling, because the height depends on what was just written,
 * and clamped to the window on both axes: these cards are positioned against
 * the window rather than their anchor, so nothing else keeps them on screen.
 */
function placePop(pop, anchor) {
  pop.hidden = false;
  const box = anchor.getBoundingClientRect();
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

