'use strict';

// ---------------------------------------------------------------- listeners

/**
 * Every listener on the page, one function per region of it. They were one
 * 600-line function; splitting it changed no behaviour, only where a thing
 * is found. init() calls wireEvents(), which calls each in turn.
 */
function wireEvents() {
  wireToolbar();
  wireDialogs();
  wireFaces();
  wireSettings();
  wirePlayer();
  wireChrome();
}

/** The toolbar and the grid chrome: open, search, sort, volume, tile size. */
function wireToolbar() {
  $('#scanBtn').addEventListener('click', () => scan());
  $('#dirInput').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') scan(); });
  $('#recursiveToggle').addEventListener('change', () => scan());

  $('#groupsFold').addEventListener('click', () => {
    const all = state.groups.length && state.groups.every((g) => foldedGroups.has(g.key));
    foldedGroups.clear();
    if (!all) for (const g of state.groups) foldedGroups.add(g.key);
    relayoutGroups(null);
    window.scrollTo(0, Math.min(window.scrollY, $('#filesSection').offsetTop));
  });
  $('#groupsOnlyBox').addEventListener('change', (ev) => {
    if (!(state.grouped in groupOnly)) return;
    groupOnly[state.grouped] = ev.target.checked;
    render();
  });

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
    for (const [menu, close] of [['#volMenu', toggleVolumeMenu], ['#sortMenu', toggleSortMenu],
      ['#groupMenu', toggleGroupMenu]]) {
      const el = $(menu);
      if (!el.hidden && (!host || !host.contains(el))) close(false);
    }
  });

  $('#cardWidth').addEventListener('input', (ev) => setCardWidth(Number(ev.target.value)));
  // Saved as it changes, like the sliders beside it: the grid behind the
  // dialog is the preview.
  $('#setCardDetails').addEventListener('change', (ev) => setCardDetails(ev.target.checked));
  $('#cardWidth').addEventListener('change', (ev) => saveConfig({ cardWidth: Number(ev.target.value) }));

  // Ctrl and the wheel resize the tiles, the way every other picture viewer
  // does it. Without this the only way to change tile size was to open
  // settings, drag a slider you could not see the effect of, and close it
  // again.
  //
  // On the document rather than on #grid: the grid is zero by zero whenever it
  // is empty -- the folder view, an empty search -- so a listener bound to it
  // would simply not fire there. The whole window answers, and the only thing
  // that changes is the tiles; the app itself never zooms.
  //
  // passive: false because preventDefault is the entire point. Without it the
  // browser zooms the interface instead, which is what this is here to stop.
  //
  // But a wheel listener that can cancel has to be waited on before every
  // scroll the page makes, so it is only there while Control is down: the rest
  // of the time the grid scrolls without asking the page first. Losing the
  // window takes it off too, or a Control released elsewhere would leave it on.
  //
  // A trackpad pinch arrives as a ctrl wheel with no Control key behind it.
  // The passive listener below notices the first such event and puts the real
  // one on for the rest of the gesture -- that first step cannot be cancelled,
  // so a pinch begun cold may nudge the browser's own zoom by one step.
  const zoomWheel = (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    sizeByWheel(ev);
  };
  // Up is bigger. One slider step per notch: the wheel reports its delta in
  // wildly different units between devices, so only the sign is worth reading.
  const sizeByWheel = (ev) => {
    setCardWidth(cardWidth() + (ev.deltaY < 0 ? CARD_STEP : -CARD_STEP), { save: true });
  };
  let zoomWheelOn = false;
  const holdZoomWheel = (on) => {
    if (on === zoomWheelOn) return;
    zoomWheelOn = on;
    if (on) document.addEventListener('wheel', zoomWheel, { passive: false });
    else document.removeEventListener('wheel', zoomWheel);
  };
  // Capturing, so a field that keeps its keys to itself cannot hide either one.
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Control') holdZoomWheel(true); }, true);
  window.addEventListener('keyup', (ev) => { if (ev.key === 'Control') holdZoomWheel(false); }, true);
  window.addEventListener('blur', () => holdZoomWheel(false));
  document.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey || zoomWheelOn) return;
    holdZoomWheel(true);
    sizeByWheel(ev);
  }, { passive: true });

  $('#dwellMs').addEventListener('input', (ev) => {
    $('#dwellLabel').textContent = (Number(ev.target.value) / 1000).toFixed(1) + 's';
  });
  $('#dwellMs').addEventListener('change', (ev) => saveConfig({ dwellMs: Number(ev.target.value) }));
}

/** The dialogs: batch actions, the tag editor, the folder picker, the advanced filter. */
function wireDialogs() {
  // batch actions
  for (const btn of document.querySelectorAll('[data-batch]')) {
    btn.addEventListener('click', () => {
      const paths = selectedPaths();
      if (!paths.length) return;
      const op = btn.dataset.batch;
      if (op === 'tags') return openTagDialog(state.files.filter((f) => state.selected.has(f.path)));
      if (op === 'download' || op === 'cloud') {
        return setAvailability(state.files.filter((f) => state.selected.has(f.path)), op);
      }
      if (op === 'delete') return confirmDelete(paths);
      if (op === 'move') return pickFolder('Move to folder', (dest) => doAction('move', paths, { dest }));
      return doAction(op, paths);
    });
  }
  $('#playerAvail').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const file = state.playing;
    if (!file) return;
    const live = fileAt(file.path) || file;
    setAvailability([live], live.cloudOnly ? 'download' : 'cloud');
  });

  // tag editor
  $('#tagAdd').addEventListener('click', () => commitTags('add'));
  $('#tagReplace').addEventListener('click', () => commitTags('replace'));
  // Both sections behave the same way, including Enter -- which commits the
  // dialog rather than just its own field, since the two are saved together.
  for (const field of ['tags', 'models']) {
    const input = $(LABEL_INPUTS[field].input);
    input.addEventListener('input', () => {
      // A comma still works as "that one's done", for anyone used to typing them.
      if (input.value.includes(',')) {
        const parts = input.value.split(',');
        const rest = parts.pop();
        for (const part of parts) draftAdd(field, part);
        input.value = rest.trimStart();
      }
      renderTagSuggestions();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      // Something typed: add it as a pill and empty the box for the next.
      if (input.value.trim()) {
        draftAdd(field, input.value);
        input.value = '';
        renderTagSuggestions();
        return;
      }
      // An empty box: Enter saves, doing the safe thing for the context --
      // replacing one video's labels is what the pre-filled pills imply, but
      // across a selection it appends.
      commitTags(state.tagTargets.length === 1 ? 'replace' : 'add');
    });
  }

  // picker
  $('#pickerUp').addEventListener('click', async () => {
    const data = await post('/api/dirs', { dir: state.picker.dir || '' });
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
      if (CHOICE_FACETS.includes(what)) advDraft[what].clear();
      else advDraft[what === 'rating' ? 'ratings' : what].clear();
      renderAdvanced();
    });
  }
}

/** Familiar faces: the sweep pills, the hover card, the lineup dialog, the status poll. */
function wireFaces() {
  $('#facesPill').addEventListener('click', toggleFaceSweep);
  $('#dupesPill').addEventListener('click', toggleDupeSweep);
  $('#framingPill').addEventListener('click', toggleFramingSweep);
  for (const id of ['#facesPill', '#dupesPill', '#framingPill']) watchPill($(id));
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
  // The keyboard, too: focus inside the card keeps it open, and it closes
  // once the focus has gone somewhere else. The chip's blur used to start
  // the timer before Tab could reach the card's buttons.
  hoverCard.addEventListener('focusin', () => clearTimeout(hover.out));
  hoverCard.addEventListener('focusout', (ev) => {
    if (ev.relatedTarget instanceof Element && hoverCard.contains(ev.relatedTarget)) return;
    hover.out = setTimeout(closeFaceHover, HOVER_OUT_MS);
  });
  hoverCard.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    const back = hover.anchor;
    closeFaceHover();
    if (back && back.isConnected) back.focus();
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
  // One poll for all three sweeps, which slows itself down when none of them
  // is running. It reschedules itself, so there is no interval to set here.
  pollStatus();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    clearTimeout(pollTimer);
    pollStatus();
  });
}

/** Settings: the group menu, the settings dialog and its fields, labels and colours. */
function wireSettings() {
  // settings
  $('#groupBtn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleGroupMenu();
  });

  $('#settingsBtn').addEventListener('click', () => {
    $('#setPreviewMode').value = state.config.previewMode === 'sprite' ? 'sprite' : 'live';
    $('#setFrames').value = state.config.frames;
    $('#setTileWidth').value = state.config.tileWidth;
    $('#setScrub').checked = !!state.config.scrubWithMouse;
    $('#setHomeDir').value = state.config.homeDir || '';
    $('#setHomeFolders').value = (state.config.homeFolders || []).join(', ');
    $('#setHomeFollow').checked = state.config.homeFollowsAccount !== false;
    $('#setCardDetails').checked = cardDetailsOn();
    syncHomeFields();
    syncFacetColours();
    renderLabelList();
    $('#settingsModal').hidden = false;
  });
  for (const facet of ['race', 'height', 'bust', 'body', 'models']) {
    const id = '#colour' + facet[0].toUpperCase() + facet.slice(1);
    $(id).addEventListener('input', (ev) => setFacetColour(facet, ev.target.value));
  }
  for (const btn of document.querySelectorAll('[data-colour-clear]')) {
    btn.addEventListener('click', () => setFacetColour(btn.dataset.colourClear, ''));
  }
  // Each box narrows its own list. Escape empties it, since a search you have
  // finished with is otherwise a filter you cannot see the effect of.
  for (const [id, which, redraw] of [
    ['#advTagsFind', 'advTags', () => renderAdvanced()],
    ['#advModelsFind', 'advModels', () => renderAdvanced()],
  ]) {
    const box = $(id);
    if (!box) continue;
    box.addEventListener('input', () => { chipFind[which] = box.value; redraw(); });
    box.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !box.value) return;
      // Swallowed: the dialog closes on Escape, and clearing the box is what
      // the first press means while the caret is in it.
      ev.stopPropagation();
      ev.preventDefault();
      box.value = '';
      chipFind[which] = '';
      redraw();
    });
  }

  $('#labelAdd').addEventListener('click', addLabel);
  $('#labelNew').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addLabel(); }
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
}

/** The player: the stage, the control bar, scrubbing and bookmarks. */
function wirePlayer() {
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
  $('#playerPrev').addEventListener('click', playerBack);
  $('#playerNext').addEventListener('click', () => playSibling(1));
  $('#playerRandom').addEventListener('click', toggleRandom);
  $('#playerRepeat').addEventListener('click', toggleRepeat);

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
  // A file that will not play -- moved or deleted outside the app, a format
  // the WebView cannot decode -- opened as a black stage titled "Playing" and
  // nothing else. Said, on the stage and as an error that stays.
  const stage = player.closest('.player-stage');
  player.addEventListener('error', () => {
    // Clearing the source on close also fires this; that one is not a failure.
    if (!state.playing || !player.currentSrc) return;
    const code = player.error ? player.error.code : 0;
    const why = code === 4 ? 'the file is missing, or not a format that plays here'
      : code === 3 ? 'the video could not be decoded'
        : code === 2 ? 'the read was interrupted'
          : 'it could not be played';
    if (stage) stage.classList.add('failed');
    toast(`Could not play ${state.playing.name}: ${why}`, 'err');
  });
  for (const type of ['loadedmetadata', 'emptied']) {
    player.addEventListener(type, () => { if (stage) stage.classList.remove('failed'); });
  }
  // Autoplay next: on by its bar toggle, and never over a loop -- a loop
  // means "stay here", whatever the toggle says.
  player.addEventListener('ended', () => {
    if (!state.config.autoNext || !watching()) return;
    if (loop.on || (loop.a !== null && loop.b !== null)) return;
    playSibling(1);
  });
  // Moving over the picture is asking for the controls back.
  $('#playerModal .player-stage').addEventListener('pointermove', wakeBar);
  $('#playerBar').addEventListener('pointerenter', wakeBar);
  // Over the labels is using them: they stay, and so does the bar above them.
  $('#playerModal .modal-foot').addEventListener('pointermove', wakeBar);
  $('#playerExpand').addEventListener('click', () => setPlayerExpanded(!playerExpanded));
  new ResizeObserver(syncFootHeight).observe($('#playerModal .modal-foot'));

  $('#pbPlay').addEventListener('click', togglePlayback);
  $('#pbFull').addEventListener('click', toggleFullscreen);
  $('#pbRate').addEventListener('click', () => {
    // Click cycles upward and wraps -- the keys < and > step it either way.
    const at = RATES.indexOf(playRate);
    setRate(RATES[(at + 1) % RATES.length]);
    wakeBar();
  });
  $('#pbLoop').addEventListener('click', toggleLoop);
  $('#pbAuto').addEventListener('click', () => {
    saveConfig({ autoNext: !state.config.autoNext });
    syncAutoNext();
    wakeBar();
  });
  $('#pbPip').addEventListener('click', async () => {
    const player = $('#player');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await player.requestPictureInPicture();
    } catch (err) {
      toast('Picture-in-picture is not available here: ' + err.message, 'err');
    }
  });
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
    // These keys belong to the slider, and only while the slider itself has
    // the focus. The bookmark menu is a CHILD of it -- it has to be, to hang
    // in the right place over the timeline -- so its keystrokes bubble through
    // here on the way up. Without this, a space typed into the icon search
    // toggled playback instead of reaching the box, and the arrows seeked the
    // video rather than moving the caret.
    if (ev.target !== seekEl) return;
    const duration = playerDuration();
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); seekBy(-5); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); seekBy(5); }
    else if (ev.key === 'Home') { ev.preventDefault(); seekBy(-duration); }
    else if (ev.key === 'End') { ev.preventDefault(); seekBy(duration); }
    else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); togglePlayback(); }
  });

  // Leaving fullscreen any way at all -- Escape, the button, the OS -- has to
  // put the bar back where it belongs.
  document.addEventListener('fullscreenchange', syncFullscreen);
}

/** Modal chrome, the keyboard, the mouse's side buttons. */
function wireChrome() {
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
  $('#playerKeys').addEventListener('click', (ev) => { ev.stopPropagation(); openKeysSheet(); });
  watchModalFocus();

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

/**
 * The player is the frontmost thing, so a shortcut aimed at the open video is
 * safe to fire. A dialog opened over the top of it — tags, filters, the folder
 * picker — owns the keyboard instead, and one of those is where a bare digit
 * most likely belongs to something being typed.
 */
function playerHasKeys() {
  return !$('#playerModal').hidden && $('#pickerModal').hidden
    && $('#settingsModal').hidden && $('#tagModal').hidden && $('#advModal').hidden
    && $('#keysModal').hidden;
}

/** The keyboard shortcuts sheet, over whatever is open. */
function openKeysSheet() {
  closeFaceHover();
  $('#keysModal').hidden = false;
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
    if (!$('#sortMenu').hidden) { toggleSortMenu(false); $('#sortBtn').focus(); return; }
    if (!$('#groupMenu').hidden) { toggleGroupMenu(false); $('#groupBtn').focus(); return; }
    if (!$('#keysModal').hidden) { $('#keysModal').hidden = true; return; }
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

  // ? is the shortcuts sheet, from anywhere a key is not being typed -- the
  // player included, which is where most of them live.
  if (ev.key === '?' && !isTyping() && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    if ($('#keysModal').hidden) openKeysSheet();
    else $('#keysModal').hidden = true;
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

  // Ctrl+F5 / Ctrl+Shift+F5, the hard refresh: same folder, view back to
  // defaults. A plain F5 is left to the shell, and keeps the view.
  if (ev.key === 'F5' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    sessionStorage.setItem(HARD_KEY, '1');
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

  // Arrows step through the listing while the player is open -- previewing or
  // playing alike. Seeking is the timeline's, while it has the focus.
  // Not while typing, and not with a dialog open over the player: left and
  // right were moving the caret in the label box AND changing the video behind.
  if (!ev.ctrlKey && !ev.metaKey && playerHasKeys() && !isTyping()
      && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    if (ev.target.closest && ev.target.closest('#pbSeek')) return;
    ev.preventDefault();
    playSibling(ev.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  // Up and down move within the video: five seconds either way while it plays,
  // a frame either way on the frames (held five seconds, then the slideshow
  // carries on).
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && playerHasKeys() && !isTyping()
      && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    const step = ev.key === 'ArrowUp' ? 1 : -1;
    if (previewing()) { ev.preventDefault(); stepPreviewFrame(step); return; }
    if (watching()) { ev.preventDefault(); seekBy(step * 5); wakeBar(); return; }
  }

  // Space on the frames is the click on the picture: play it from the top.
  if (ev.key === ' ' && previewing() && playerHasKeys() && !isTyping()
      && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    ev.preventDefault();
    beginPlayback();
    return;
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
    if (ev.key === 'l' || ev.key === 'L') {
      ev.preventDefault();
      toggleLoop();
      return;
    }
    if (ev.key === '[' || ev.key === ']') {
      ev.preventDefault();
      pinLoopEnd(ev.key === '[' ? 'a' : 'b');
      return;
    }
    if ((ev.key === ',' || ev.key === '.') && $('#player').paused) {
      // One frame at a time, the way an editor steps: only while paused, so
      // the keys cannot fight the playback they would be stepping under.
      ev.preventDefault();
      const player = $('#player');
      const fps = Number((state.meta.get(state.playing && state.playing.path) || {}).fps) || 30;
      try { player.currentTime += (ev.key === '.' ? 1 : -1) / fps; } catch { /* not seekable */ }
      barSync();
      wakeBar();
      return;
    }
    if (ev.key === '<') {
      ev.preventDefault();
      stepRate(-1);
      return;
    }
    if (ev.key === '>') {
      ev.preventDefault();
      stepRate(1);
      return;
    }
    if (ev.key === 'j' || ev.key === 'J') {
      ev.preventDefault();
      seekBy(-10);
      return;
    }
  }

  // A digit rates the open video, the way it rates the selection in the grid.
  // Deliberately the open video and not the selection: what is selected behind
  // the player is not what you are looking at, and rating one as you finish
  // watching it is the whole reason the shortcut is wanted here.
  if (playerHasKeys() && !isTyping() && isRatingKey(ev)) {
    ev.preventDefault();
    if (state.playing) editRecords([state.playing.path], { rating: keyRating(ev, [state.playing]) });
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

  // Rating keys come before the modifier bail-out below: a held Shift, Alt or
  // Ctrl is what makes a half.
  if (isRatingKey(ev) && selectedPaths().length) {
    ev.preventDefault();
    editRecords(selectedPaths(), { rating: keyRating(ev, state.files.filter((f) => state.selected.has(f.path))) });
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

  if (ev.key === 't' || ev.key === 'T') {
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

/**
 * Focus follows the dialogs: into one as it opens, back to whatever opened it
 * as it closes.
 *
 * Watched rather than wired into every opener: a dialog is opened and closed
 * from a dozen places, each by flipping its `hidden`, and one observer sees
 * all of them -- including the ones written after this. If the opener did
 * not put the focus somewhere inside itself (the label box, say), the card
 * takes it, so Tab starts from the dialog and not the grid beneath it.
 */
/**
 * Arrow keys walk any open menu -- sort, group by, a heading's "…" -- from
 * whichever row has the focus: Up and Down between rows, wrapping, Home and
 * End to the ends. Escape is handled where each menu is opened. Delegated,
 * since the "…" popup is made afresh each time.
 */
document.addEventListener('keydown', (ev) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
  const menu = ev.target instanceof Element ? ev.target.closest('.menu:not([hidden]), .group-menu') : null;
  if (!menu) return;
  const rows = [...menu.querySelectorAll('.menu-row:not([disabled])')];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement);
  const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? rows.length - 1
    : ev.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  rows[next].focus({ preventScroll: true });
}, true);

function watchModalFocus() {
  const openers = new Map();
  // Open dialogs, oldest first. Everything but the newest is inert, and so is
  // the page behind them all: aria-modal promised that to screen readers, but
  // Tab still walked out of a dialog into the 27,000 cards beneath it.
  const open = [];
  const page = () => ['header.topbar', '#breadcrumb', '#foldersSection', '#scrollArea']
    .map((sel) => document.querySelector(sel)).filter(Boolean);
  const syncInert = () => {
    const top = open[open.length - 1] || null;
    for (const el of page()) el.inert = Boolean(top);
    for (const modal of document.querySelectorAll('.modal')) {
      modal.inert = !modal.hidden && modal !== top;
    }
  };
  const observer = new MutationObserver((records) => {
    for (const { target: modal } of records) {
      const card = modal.querySelector('.modal-card');
      if (!card) continue;
      if (!modal.hidden && !open.includes(modal)) open.push(modal);
      if (modal.hidden && open.includes(modal)) open.splice(open.indexOf(modal), 1);
      syncInert();
      if (!modal.hidden && !openers.has(modal)) {
        const from = document.activeElement;
        openers.set(modal, from && from !== document.body ? from : null);
        // After the opener has had its turn to focus something of its own.
        requestAnimationFrame(() => {
          if (modal.hidden || card.contains(document.activeElement)) return;
          if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
          card.focus({ preventScroll: true });
        });
      } else if (modal.hidden && openers.has(modal)) {
        const back = openers.get(modal);
        openers.delete(modal);
        // Only if the focus was still in the dialog: a dialog closed because
        // something else took the keyboard should not snatch it back.
        const lost = !document.activeElement || document.activeElement === document.body
          || card.contains(document.activeElement);
        if (lost && back && back.isConnected && !back.closest('[hidden]')) {
          back.focus({ preventScroll: true });
        }
      }
    }
  });
  for (const modal of document.querySelectorAll('.modal')) {
    observer.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  }
}

/**
 * Whether the cards carry their detail line. Saved through the config like
 * every other preference -- but the server only keeps the keys it already
 * knows, and drops this one until it learns it, so the answer is also kept in
 * this browser and read from there whenever the config comes back without it.
 */
const DETAILS_KEY = 've-card-details';

function cardDetailsOn() {
  if (typeof state.config.cardDetails === 'boolean') return state.config.cardDetails;
  try { return localStorage.getItem(DETAILS_KEY) !== '0'; } catch { return true; }
}

async function setCardDetails(on) {
  try { localStorage.setItem(DETAILS_KEY, on ? '1' : '0'); } catch { /* the config still has it */ }
  await saveConfig({ cardDetails: on });
  syncCardDetails();
}

function renderActiveFilters() {
  const host = $('#activeFilters');
  if (!host) return;
  host.replaceChildren();
  let facets = 0;
  for (const facet of ALL_FACETS) {
    const held = state.adv[facet];
    if (!held || !held.size) continue;
    facets += 1;
    const chip = document.createElement('span');
    chip.className = 'chip has-x active-chip';
    const label = document.createElement('span');
    label.className = 'chip-text';
    const parts = [...held].map(([value, mode]) => (mode === 'out' ? '−' : '') + facetValueText(facet, value));
    const mode = state.adv.mode && state.adv.mode[facet];
    const how = held.size > 1 && mode === 'any' ? ' (any)' : '';
    label.textContent = `${FACET_NAMES[facet] || facet}: ${parts.join(', ')}${how}`;
    chip.title = label.textContent;
    chip.appendChild(label);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '✕';
    x.title = `Clear ${FACET_NAMES[facet] || facet}`;
    x.setAttribute('aria-label', x.title);
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // A fresh map rather than clearing in place: the dialog's draft may be
      // holding this one, and Cancel there must still mean cancel.
      state.adv = { ...state.adv, [facet]: new Map() };
      syncAdvBadge();
      render();
    });
    chip.appendChild(x);
    host.appendChild(chip);
  }
  if (facets > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'linkish';
    all.textContent = 'Clear all';
    all.addEventListener('click', () => {
      state.adv = newAdvFilter();
      syncAdvBadge();
      render();
    });
    host.appendChild(all);
  }
  host.hidden = facets === 0;
  return facets;
}

// -------------------------------------------------------------------- init

/**
 * How much of the scroller the sticky Videos bar covers, so the section
 * headings pin just beneath it rather than under it.
 */
function syncFilesHeadHeight() {
  const head = document.querySelector('#filesSection > .section-head');
  if (!head) return;
  // The bar sits at top: -16px with 16px of padding above its content.
  const covered = Math.max(0, head.offsetHeight - 16);
  document.documentElement.style.setProperty('--files-head-h', `${covered}px`);
}

async function init() {
  syncFilesHeadHeight();
  const filesHead = document.querySelector('#filesSection > .section-head');
  if (filesHead) new ResizeObserver(syncFilesHeadHeight).observe(filesHead);
  wireEvents();
  attachGridHandlers();
  try {
    state.config = await api('/api/config');
    // The whole library's suggestions, by key, before the first listing is
    // drawn -- or as soon after as they arrive (applySuggestions).
    loadSuggestions();
  } catch {
    state.config = {
      previewMode: 'live', frames: 10, dwellMs: 2000, tileWidth: 640, cardWidth: 200,
      recursive: false, grouped: '', sortDir: 'desc', sort: 'rating',
    };
  }

  // Four ways in:
  //
  //   cold launch     the default folder, the view at its defaults
  //   F5              the folder you were in, the view as you left it
  //   Ctrl+Shift+F5   the folder you were in, the view at its defaults
  //   Ctrl+Shift+R    the default folder, the view at its defaults
  //
  // "The view" is the sort, the grouping, the filters and the search. Sort and
  // grouping live in the saved config, so an F5 keeps them by leaving them be;
  // the filters live only in memory, and ride the reload in session storage.
  const reloaded = (performance.getEntriesByType('navigation')[0] || {}).type === 'reload';
  const toHome = sessionStorage.getItem(RESET_KEY) === '1';
  const hard = sessionStorage.getItem(HARD_KEY) === '1';
  sessionStorage.removeItem(RESET_KEY);
  sessionStorage.removeItem(HARD_KEY);
  let kept = null;
  try { kept = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null'); } catch { kept = null; }
  sessionStorage.removeItem(VIEW_KEY);

  // The folders open out on a launch and on Ctrl+Shift+R; a refresh keeps
  // them however you left them.
  if ((!reloaded || toHome) && state.config.foldersCollapsed) {
    state.config.foldersCollapsed = false;
    saveConfig({ foldersCollapsed: false });
  }
  if (!reloaded || toHome || hard) {
    resetView();
  } else if (kept) {
    state.adv = unpackFilter(kept.adv);
    setAdvDraft(unpackFilter(kept.adv));
    $('#searchInput').value = typeof kept.search === 'string' ? kept.search : '';
    syncAdvBadge();
  }
  // Written on the way out of every reload, unless the reload is the one that
  // is meant to forget it.
  window.addEventListener('pagehide', () => {
    if (sessionStorage.getItem(HARD_KEY) === '1' || sessionStorage.getItem(RESET_KEY) === '1') return;
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({
        adv: packFilter(state.adv), search: $('#searchInput').value,
        recursive: $('#recursiveToggle').checked,
      }));
    } catch { /* storage refused: the reload simply starts clean */ }
  });

  const start = (reloaded && !toHome ? state.config.lastDir : '')
    || state.config.homeDir || state.config.lastDir || '';
  $('#dirInput').value = start;
  $('#recursiveToggle').checked = state.config.recursive === true;
  // Flatten subfolders is part of the view an F5 keeps. It is never saved to
  // the config -- a launch starts with it off -- so it rides the reload with
  // the filters.
  if (reloaded && !toHome && !hard && kept && typeof kept.recursive === 'boolean') {
    $('#recursiveToggle').checked = kept.recursive;
  }
  // `true` is what this was before there were two groupings.
  state.grouped = state.config.grouped === true ? 'models'
    : (GROUP_MODES.includes(state.config.grouped) ? state.config.grouped : '');
  syncGroupButton();
  // The mode is remembered across launches, so the fetch has to happen on the
  // way in as well as on the click.
  if (state.grouped === 'dupes') fetchOtherCopies().then(() => render());
  // A sort saved under a key that has since gone -- studio, production -- would
  // leave the box blank and the listing in whatever order it arrived in.
  if (state.config.sort && !SORT_FIELDS.some((s) => s.value === state.config.sort)) {
    state.config.sort = 'name';
  }
  // Match % belongs to the performer groupings; saved under another, it is Name.
  if (state.config.sort === 'match' && !MATCH_GROUPINGS.includes(state.grouped)) {
    state.config.sort = 'name';
    state.config.sortDir = 'asc';
  }
  $('#sortSelect').value = state.config.sort || 'name';
  syncSortButton();
  setCardWidth(state.config.cardWidth || CARD_MIN);
  syncVolumeUI();
  syncAutoNext();
  // Bound once. The row that pages as you scroll is rebuilt for every video
  // played, and a listener added with it would be a listener leaked with it.
  watchSimilarScroll();
  $('#dwellMs').value = state.config.dwellMs || 2000;
  $('#dwellLabel').textContent = ((state.config.dwellMs || 2000) / 1000).toFixed(1) + 's';
  syncCardDetails();

  // The vocabularies are library-wide, so they load once rather than per scan.
  api('/api/library').then((data) => {
    state.tagVocab = data.tags || [];
    // Both vocabularies, or the dialog's Models section sits empty until an edit
    // happens to bring the second one back with its response.
    state.modelVocab = data.models || [];
    setFavourites(data.favourites, data.favouriteTiers);
    setRaces(data.races);
    setTraits(data.traits);
    // The page already drawn was drawn before anyone's race or tier was known.
    // That only shows in a grouped view -- the sections' order and headings,
    // the order of names on a card -- or under a filter on the performers;
    // a plain listing would be the same page drawn twice on the way in.
    const depends = state.grouped || personFiltered();
    if (depends && state.files.length && (state.raceOf.size || state.favSet.size)) render();
  }).catch(() => {});

  if (start) scan(start);
}

init();
