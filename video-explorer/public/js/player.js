'use strict';

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
  const said = `${ok.length ? ok[0].message : ''}${ok.length > 1 ? ` — ${ok.length} files` : (ok.length ? ': ' + baseName(ok[0].path) : '')}`;
  // A move can be taken back: each file goes home to the folder it left. The
  // undo is itself a move, so it must not offer to undo the undo forever.
  if (ok.length && op === 'move' && !extra.isUndo) {
    const homes = new Map();
    for (const r of ok) {
      const from = r.path.replace(/[\\/][^\\/]*$/, '');
      if (!homes.has(from)) homes.set(from, []);
      homes.get(from).push(r.dest);
    }
    toast(said, 'ok', {
      label: 'Undo',
      run: async () => {
        for (const [home, files] of homes) {
          await doAction('move', files, { dest: home, isUndo: true });
        }
      },
    });
  } else if (ok.length) {
    toast(said, 'ok');
  }
  for (const r of bad) toast(`${baseName(r.path)}: ${r.message}`, 'err');

  // Reflect the filesystem change locally instead of a full rescan.
  const removed = new Set(ok.filter((r) => op === 'delete' || op === 'move').map((r) => r.path));
  if (removed.size) {
    // A copy may have been deleted from either side: one in this folder, or one
    // fetched in from another. Both are on screen in the duplicates view, so
    // neither can be the only case handled.
    const wasCopy = state.files.some((f) => removed.has(f.path) && f.duplicate)
      || elsewhere.files.some((f) => removed.has(f.path));
    setFiles(state.files.filter((f) => !removed.has(f.path)));
    removed.forEach((p) => state.selected.delete(p));
    forgetOtherCopies();
    if (wasCopy) await refreshDupeFlags();
  }
  const renamed = ok.filter((r) => op === 'rename' && r.dest);
  for (const r of renamed) {
    const file = fileAt(r.path);
    if (file) {
      const sprite = state.sprites.get(file.path);
      if (sprite) { state.sprites.delete(file.path); state.sprites.set(r.dest, sprite); }
      state.byPath.delete(file.path);
      file.path = r.dest;
      file.name = baseName(r.dest);
      state.byPath.set(file.path, file);
      searchHay(file);
    }
    state.selected.delete(r.path);
  }
  if (removed.size || renamed.length) render();
  if (op === 'copy' && ok.length) setStatus(`Copied ${ok.length} file${ok.length === 1 ? '' : 's'}`);
  return results;
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
  noteOtherCopies(members);
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
    $('#homeHint').textContent = 'A fixed folder: the app opens here on launch and the home button goes here, '
      + 'whichever OneDrive account is signed in.';
  }
}

/** Resolves true only if files were actually recycled. */
async function confirmDelete(paths) {
  const label = paths.length === 1 ? `"${baseName(paths[0])}"` : `${paths.length} files`;
  if (!window.confirm(`Send ${label} to the Recycle Bin?\n\nYou can restore from the Recycle Bin if this was a mistake.`)) {
    return false;
  }
  // Gone from the grid the moment it is confirmed -- every copy of the card,
  // since grouped by performer a video sits under each of hers. The Recycle
  // Bin goes through a PowerShell that takes a second or more to start, and
  // the card sat there for all of it. Anything the delete refuses comes back.
  const hidden = paths.flatMap((p) => [...cardsFor(p)]);
  for (const card of hidden) card.style.display = 'none';
  let results = [];
  try {
    results = await doAction('delete', paths);
  } catch (err) {
    toast(err.message, 'err');
  }
  const gone = new Set(results.filter((r) => r.ok).map((r) => r.path));
  for (const card of hidden) {
    if (card.isConnected && !gone.has(card.dataset.path)) card.style.display = '';
  }
  return gone.size > 0;
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
    const data = await post('/api/dirs', { dir: dir || '' });
    state.picker.dir = data.dir;
    $('#pickerPath').value = data.dir;
    $('#pickerHint').textContent = data.dir ? '' : 'Pick a drive to start';
    const list = $('#pickerList');
    list.innerHTML = '';

    const rows = data.dir
      ? data.dirs.map((d) => ({ label: d.name, path: d.path, ico: ICONS.folder }))
      : data.drives.map((d) => ({ label: d, path: d, ico: ICONS.drive }));

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

/**
 * The video to show once `file` has gone from the listing: the next one along,
 * or -- at the end, without Repeat -- the one before. Another copy of the same
 * video (grouped views list one under each name) does not count.
 */
function afterRemoval(file) {
  const list = visibleCards().map((c) => (state.grouped ? c.file : c));
  const at = playingAt();
  if (at < 0) return null;
  const other = (f) => f && f.path !== file.path;
  for (let i = at + 1; i < list.length; i += 1) if (other(list[i])) return list[i];
  if (playMode.repeat) {
    for (let i = 0; i < at; i += 1) if (other(list[i])) return list[i];
  }
  for (let i = at - 1; i >= 0; i -= 1) if (other(list[i])) return list[i];
  return null;
}

/** After a delete in the player: on to the next video, or closed if none is left. */
function moveOnFrom(file, after) {
  if (playMode.random) {
    // Random's history must not lead back to a file that is not there any more.
    playMode.seen = playMode.seen.filter((f) => f.path !== file.path);
    playMode.at = playMode.seen.length - 1;
    const before = state.playing;
    randomStep(1);
    if (state.playing === before) closePlayer(); // every video in the round has played
    return;
  }
  const still = after && fileAt(after.path);
  if (still) playFile(still);
  else closePlayer();
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

  const renamed = fileAt(ok.dest) || { ...file, path: ok.dest, name: baseName(ok.dest) };
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
    bar.appendChild(buildActionButton(action));
  }
}

function playFile(file, seq = null) {
  stopLive(); // free the hover decoder before opening a second one
  clearLoop(); // a loop is about a moment in the video that is going away
  // Where the arrows were, so a video opened without a card -- from the similar
  // strip -- is walked from the section you were already in.
  const from = state.grouped && state.playingCard !== null ? state.cards[state.playingCard] || null : null;
  state.playing = file;
  state.playingAnchor = null; // this one is in the listing until told otherwise
  state.playingCard = seq !== null ? seq : nearestCard(file, from);
  buildPlayerActions(file);
  syncPlayerAvail(file);
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
    file.cloudOnly ? 'streaming from OneDrive' : null,
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
        keepThumb(file.path, url);
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
  // Every video opens on its frames, the next one included -- even straight
  // after one that was playing. Clicking the picture is what starts it.
  startPlayerPreview();
}

/**
 * Walks the listing you can see -- state.view, so the arrows follow the current
 * filter and sort rather than the folder on disk. Wraps at both ends, which
 * keeps the buttons live instead of leaving one dead at each edge.
 */
/**
 * The music-player rule for the back button: more than fifteen seconds in,
 * back means "this one, from the top"; pressed again inside those fifteen
 * seconds it means the previous video. Only the BUTTON behaves this way --
 * the arrow keys and a swipe keep their plain meaning, since stepping through
 * a listing is what they are for.
 */
function playerBack() {
  const player = $('#player');
  if (watching() && (Number(player.currentTime) || 0) > 15) {
    try { player.currentTime = 0; } catch { /* not seekable yet */ }
    barSync();
    wakeBar();
    return;
  }
  playSibling(-1);
}

// Random and Repeat, for this time the player is open. Both start off, and
// closing the player turns them off again -- they are a way of watching, not a
// setting. `seen` is what Random has played, in order, so back retraces it.
const playMode = { random: false, repeat: false, seen: [], at: -1 };

function resetPlayMode() {
  playMode.random = false;
  playMode.repeat = false;
  playMode.seen = [];
  playMode.at = -1;
  syncPlayMode();
}

function syncPlayMode() {
  for (const [id, on] of [['#playerRandom', playMode.random], ['#playerRepeat', playMode.repeat]]) {
    const btn = $(id);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  syncPlayerNav();
}

function toggleRandom() {
  playMode.random = !playMode.random;
  // Starts from here: what is playing now is the first thing back would reach.
  playMode.seen = playMode.random && state.playing ? [state.playing] : [];
  playMode.at = playMode.seen.length - 1;
  // No toast: the button lights, and says so to a screen reader too.
  syncPlayMode();
}

function toggleRepeat() {
  playMode.repeat = !playMode.repeat;
  syncPlayMode();
}

/**
 * Random's next: forward through what it already played if you went back,
 * otherwise a video from the listing it has not played yet. When every one has
 * played it stops -- or, with Repeat on, starts a fresh round.
 */
function randomStep(step) {
  if (step < 0) {
    if (playMode.at <= 0) return;
    playMode.at -= 1;
    playFile(playMode.seen[playMode.at]);
    return;
  }
  if (playMode.at + 1 < playMode.seen.length) {
    playMode.at += 1;
    playFile(playMode.seen[playMode.at]);
    return;
  }
  const files = [...new Map(visibleCards().map((c) => {
    const f = state.grouped ? c.file : c;
    return [f.path, f];
  })).values()];
  const current = state.playing && state.playing.path;
  const played = new Set(playMode.seen.map((f) => f.path));
  let pool = files.filter((f) => !played.has(f.path) && f.path !== current);
  if (!pool.length) {
    if (!playMode.repeat) { toast('Every video in this listing has played', 'ok'); return; }
    playMode.seen = state.playing ? [state.playing] : [];
    playMode.at = playMode.seen.length - 1;
    pool = files.filter((f) => f.path !== current);
    if (!pool.length) return;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  playMode.seen.push(pick);
  playMode.at = playMode.seen.length - 1;
  playFile(pick);
}

function playSibling(step) {
  if (playMode.random) { randomStep(step); return; }
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
  // Past either end of the listing: start again only with Repeat on.
  if (!playMode.repeat && (target < 0 || target >= list.length)) return;

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
  if (playMode.random) {
    $('#playerPrev').hidden = playMode.at <= 0;
    $('#playerNext').hidden = list.length < 2;
  } else {
    // Without Repeat the listing has ends, and an arrow off the end is gone.
    $('#playerPrev').hidden = !usable || (!playMode.repeat && at === 0);
    $('#playerNext').hidden = !usable || (!playMode.repeat && at === list.length - 1);
  }

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
  setPlayerCount(at >= 0 ? `${(at + 1).toLocaleString()} of ${list.length.toLocaleString()}`
    : state.playing && list.length ? `filtered out · ${list.length.toLocaleString()} left` : '');

  // Full window, the grid is out of sight behind the player. A filter that
  // leaves it nothing at all has nothing to go on to, so the player gives the
  // screen back to the (empty) grid rather than sitting on a video that is no
  // longer in it. After the render that got here has finished, not inside it.
  if (playerExpanded && state.playing && !list.length && !$('#playerModal').hidden) {
    queueMicrotask(() => {
      if (state.playing && !visibleCards().length) closePlayer();
    });
  }
}

/** Where you are in the listing, left of the title. */
function setPlayerCount(text) {
  const el = $('#playerCount');
  el.textContent = text;
  el.hidden = !text;
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
const preview = { timer: null, index: 0, count: 10, onMeta: null, onPlay: null, mode: null, show: null };

/** The slideshow's tick: the next frame every dwell. */
function runPreviewTimer() {
  preview.timer = setInterval(
    () => preview.show && preview.show((preview.index + 1) % preview.count),
    Number(state.config.dwellMs) || 2000,
  );
}

/**
 * Up/Down on the frames: one frame along, then held there five seconds before
 * the slideshow carries on from it. The hold keeps `preview.timer` set, so the
 * stage still counts as previewing throughout.
 */
function stepPreviewFrame(step) {
  if (!previewing() || !preview.show) return;
  clearInterval(preview.timer);
  clearTimeout(preview.timer);
  preview.show(((preview.index + step) % preview.count + preview.count) % preview.count);
  preview.timer = setTimeout(runPreviewTimer, 5000);
}

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
  preview.show = show;
  show(0);
  runPreviewTimer();
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
  preview.show = show;
  runPreviewTimer();

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
  clearTimeout(preview.timer);
  preview.timer = null;
  preview.show = null;
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

// ------------------------------------------------- speed, loops and what's next

/**
 * One rate for the session, like the volume: a speed you chose is a statement
 * about how you watch, not about one file. Reloading the app puts it back to
 * real time, the same way it puts the sound back to muted.
 */
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let playRate = 1;

function setRate(next) {
  playRate = RATES.includes(next) ? next : 1;
  const player = $('#player');
  // Only a playthrough follows the rate. The ten-frame preview cycles on its
  // own clock, and speeding THAT up would just make the sampling twitchy.
  if (watching()) player.playbackRate = playRate;
  const label = $('#pbRate');
  if (label) {
    label.textContent = playRate === 1 ? '1×' : `${playRate}×`;
    label.classList.toggle('on', playRate !== 1);
  }
}

function stepRate(step) {
  const at = RATES.indexOf(playRate);
  setRate(RATES[Math.max(0, Math.min(RATES.length - 1, at + step))]);
  wakeBar();
}

/**
 * Loops. L, or the bar's button, replays the whole video; [ and ] pin the two
 * ends of a stretch and playback circles it. Everything clears when another
 * video opens -- a loop is about a moment in THIS one.
 */
const loop = { on: false, a: null, b: null };

function syncAutoNext() {
  const btn = $('#pbAuto');
  if (btn) btn.classList.toggle('on', state.config.autoNext === true);
}

function syncLoopUI() {
  const btn = $('#pbLoop');
  if (!btn) return;
  const ab = loop.a !== null && loop.b !== null;
  btn.classList.toggle('on', loop.on || loop.a !== null);
  const tag = $('#pbLoopAB');
  if (tag) {
    tag.hidden = loop.a === null;
    tag.textContent = ab ? 'A–B' : 'A–';
  }
  $('#player').loop = loop.on && !ab;
}

function toggleLoop() {
  if (loop.a !== null || loop.b !== null) {
    // A pinned stretch outranks the plain toggle, so the button also serves as
    // the way OUT of an A-B loop.
    loop.a = null;
    loop.b = null;
    loop.on = false;
  } else {
    loop.on = !loop.on;
  }
  syncLoopUI();
  wakeBar();
}

function pinLoopEnd(which) {
  const player = $('#player');
  if (!watching()) return;
  const at = Number(player.currentTime) || 0;
  loop[which] = at;
  // Ends pinned backwards are meant the right way round.
  if (loop.a !== null && loop.b !== null && loop.b <= loop.a) {
    [loop.a, loop.b] = [loop.b, loop.a];
  }
  loop.on = false; // the stretch takes over from the whole-video loop
  syncLoopUI();
  wakeBar();
}

/** Rides timeupdate: past B means back to A. */
function holdLoop() {
  if (loop.a === null || loop.b === null) return;
  const player = $('#player');
  if (player.currentTime >= loop.b) {
    try { player.currentTime = loop.a; } catch { /* not seekable */ }
  }
}

function clearLoop() {
  loop.on = false;
  loop.a = null;
  loop.b = null;
  syncLoopUI();
}

// The up-next card is gone: it sat over the picture while paused and in the
// last fifteen seconds, and it was in the way more than it was useful. The ➡
// key and the end-of-video handover still move to the next video.

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
  $('#playerModal').classList.remove('bar-idle');
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
    if (watching() && !now.paused && !scrub.dragging && $('#pbMarkMenu').hidden
      && !$('#playerModal .modal-foot').matches(':hover')) {
      stage.classList.add('bar-idle');
      $('#playerModal').classList.add('bar-idle');
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

  holdLoop();

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
        .map((icon) => ({ ...icon, text: iconText(icon) }));
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
    || { id, name: id, glyph: id, src: '', keywords: [], text: '' };
}

/** Puts an icon's picture inside an element, as an image or as a character. */
function paintIcon(el, icon) {
  el.innerHTML = '';
  if (icon.src) {
    const img = document.createElement('img');
    img.src = icon.src;
    img.alt = icon.name;
    // The grid holds every icon there is, and the panel shows four rows of it.
    // Decoding the rest on the way past would be several hundred megabytes of
    // bitmap for pictures nobody has scrolled to yet.
    img.loading = 'lazy';
    img.decoding = 'async';
    el.appendChild(img);
  } else {
    el.textContent = icon.glyph || icon.id;
  }
}

/**
 * Everything an icon can be found by, as one flat string: name, id, keywords.
 *
 * Punctuation becomes a space on both sides of the comparison, so "face-to-
 * face", "face to face" and "Face To Face" are the same thing to search for,
 * and a keyword that is itself a phrase stays one.
 */
function iconText(icon) {
  return flattenWords(`${icon.name} ${icon.id} ${(icon.keywords || []).join(' ')}`);
}

/** Lower case, and anything that is not a letter or a digit is a space. */
function flattenWords(text) {
  return ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * The icons matching what has been typed, the closest first.
 *
 * Every typed word has to appear somewhere in the icon's text, ANYWHERE inside
 * it and in any order — so "car have" finds "I have a car" and "I don't have a
 * car" alike, and half a word finds what you are reaching for as you type it.
 * A second word narrows rather than widens.
 *
 * Position does not decide whether an icon matches, only how high it comes: a
 * word matched whole beats one matched from its start, which beats one found
 * in the middle, and an icon actually CALLED what was typed beats all of them.
 * That last part is what keeps "star" opening on Star rather than on Star wars
 * — both hold the whole word, and only one of them is the thing being asked
 * for by name.
 */
function findIcons(query) {
  const asked = flattenWords(query);
  const wanted = asked.split(' ').filter(Boolean);
  if (!wanted.length) return markIcons.list;

  const hits = [];
  for (const icon of markIcons.list) {
    const have = icon.text || iconText(icon);
    if (!wanted.every((word) => have.includes(word))) continue;
    let rank = flattenWords(icon.name) === asked ? 3 : 0;
    for (const word of wanted) {
      if (have.includes(` ${word} `)) rank += 2;
      else if (have.includes(` ${word}`)) rank += 1;
    }
    hits.push({ icon, rank });
  }
  // Sort is stable, so within a rank the file's own order is kept -- which is
  // the order whoever wrote the icon set chose.
  return hits.sort((a, b) => b.rank - a.rank).map((hit) => hit.icon);
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

  const marks = playerMarks();
  // The icon set is fetched the first time a bookmark has to be drawn, rather
  // than at startup for a session that may never open a bookmarked video. The
  // pips are drawn with their names meanwhile, and again once it lands.
  if (marks.length && !markIcons.loaded) {
    loadMarkIcons().then(() => { if (watching()) drawMarks(); });
  }
  for (const mark of marks) {
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
  // Usually already in hand -- the first bookmarked video to open starts the
  // fetch and the promise is kept -- but on the very first opening of a session
  // with none yet this is what fills the grid a tick later rather than leaving
  // it empty.
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
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

/**
 * Fullscreen is the whole page, not the stage, with the player dressed to
 * cover it. The stage alone took the footer away -- the labels, the names, the
 * look-alikes -- and anything that opens over the player (the label editor, the
 * face lineup) would have opened outside the fullscreen layer, where it cannot
 * be seen. The page as the layer keeps all of them; the class does the look.
 */
function syncFullscreen() {
  const on = Boolean(document.fullscreenElement) && !$('#playerModal').hidden;
  $('#playerModal').classList.toggle('fs', on);
  syncFootHeight();
  wakeBar();
}

/** The control bar sits on top of the footer in fullscreen, so it needs its height. */
function syncFootHeight() {
  const foot = $('#playerModal .modal-foot');
  if (!foot) return;
  $('#playerModal').style.setProperty('--foot-h', `${foot.offsetHeight}px`);
  const head = $('#playerModal .modal-head');
  if (head) $('#playerModal').style.setProperty('--head-h', `${head.offsetHeight}px`);
}

// The player filling the app window instead of floating over the grid. Held
// for as long as the app runs -- every video opens that way until it is
// switched back -- and not across a restart: the app opens on the usual view.
let playerExpanded = false;

function setPlayerExpanded(on) {
  playerExpanded = Boolean(on);
  $('#playerModal').classList.toggle('expanded', playerExpanded);
  const btn = $('#playerExpand');
  btn.setAttribute('aria-pressed', String(playerExpanded));
  btn.title = playerExpanded ? 'Back to the usual view' : 'Full window';
  btn.setAttribute('aria-label', btn.title);
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
  player.playbackRate = playRate;
  syncLoopUI();
  // Always from the top. It used to pick up where the last session left off,
  // which was more surprising than useful.
  try { player.currentTime = 0; } catch { /* not seekable yet; it starts at 0 anyway */ }
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
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  resetPlayMode();
  if (relistDeferred) relistWhenFree();
}

