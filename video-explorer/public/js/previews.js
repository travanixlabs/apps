'use strict';

// ------------------------------------------------------------------ sprites

/**
 * A tile's picture is fetched as it comes within 400px of the window (see
 * spriteObserver), not when its card is built. Queuing every card at build
 * time meant a chunk drawn under the scroll asked for 240 pictures nobody was
 * yet near, ahead of the ones being scrolled to.
 *
 * Six at a time, so the server's own ffmpeg limit is matched rather than buried
 * under a thousand simultaneous requests.
 */
// `queued` is membership only. Scanning the array for it would be a linear
// search per card, and a listing of twenty-six thousand does that twenty-six
// thousand times before a single picture lands.
const posters = { queue: [], queued: new Set(), running: 0, limit: 6 };

/**
 * `urgent` is "this one is on screen".
 *
 * The queue is in card order, which is the right order to work through a
 * library in but the wrong one to answer a scroll with: a cloud file's picture
 * is a round trip to OneDrive, so a listing of twenty-six thousand of them is
 * half an hour of work, and a tile four thousand cards down would have waited
 * most of it out reading "cloud only". What you are looking at goes first.
 */
function queuePoster(previewEl, urgent = false) {
  if (posters.queued.has(previewEl)) {
    if (!urgent) return;               // already waiting its turn
    const at = posters.queue.indexOf(previewEl);
    if (at <= 0) return;               // already at the front, or in flight
    posters.queue.splice(at, 1);
  } else {
    posters.queued.add(previewEl);
  }
  if (urgent) posters.queue.unshift(previewEl);
  else posters.queue.push(previewEl);
  drainPosters();
}

/**
 * Puts a tile back in the queue after OneDrive has asked us to wait.
 *
 * Three goes at widening intervals and then it is left alone: a service that is
 * still saying no after half a minute of asking is not going to be talked round
 * by a fourth request, and the tile can be filled by scrolling back to it.
 */
const retried = new Map(); // path -> how many times

function retryPoster(previewEl, filePath, seconds) {
  const goes = retried.get(filePath) || 0;
  if (goes >= 3 || !previewEl) return;
  retried.set(filePath, goes + 1);
  setTimeout(() => {
    // Its card may be long gone by now -- a different folder, or a filter.
    if (previewEl.isConnected) queuePoster(previewEl);
  }, Math.min(seconds * (goes + 1), 30) * 1000);
}

function drainPosters() {
  while (posters.running < posters.limit && posters.queue.length) {
    const el = posters.queue.shift();
    posters.queued.delete(el);
    // Its card left the grid before its turn came -- a re-render, or a filter.
    if (!el.isConnected) continue;
    posters.running += 1;
    Promise.resolve(loadPoster(el))
      .catch(() => { /* a failed tile marks itself; the queue carries on */ })
      .then(() => { posters.running -= 1; drainPosters(); });
  }
}

/**
 * Prebuilding a cloud video's strip is still driven by what you can see. In
 * live mode the tile only ever wanted one frame, and a strip is ten of them
 * over about twelve seconds of range requests -- so doing the whole library's
 * worth the moment a folder opens is a different thing from loading it.
 */
const spriteObserver = new IntersectionObserver((entries) => {
  // Bottom up, since each one goes to the front of the queue: the top-left tile
  // of what has just come into view ends up first in line.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry.isIntersecting) continue;
    spriteObserver.unobserve(entry.target);
    // On screen, or 400px from it: its picture is fetched now, ahead of
    // anything queued from further back up the page.
    queuePoster(entry.target, true);
    // Build its strip now, while nobody is waiting on it, so opening it later
    // costs a read from disk.
    const queued = fileAt(entry.target.dataset.path);
    if (queued) queuePrebuild(queued);
  }
}, { root: scrollRoot, rootMargin: '400px 0px' });

/**
 * Folder covers fetch the same poster but apply it themselves. applyThumb() is
 * written for the 16:9 video tiles — letting it style a 62x36 cover box is what
 * made cover-bearing folder rows taller than plain ones.
 *
 * Fetched outright rather than when the row scrolls into view: one folder is
 * one poster, and there are never enough of them for that to be worth deferring.
 */
function loadFolderCover(el) {
  loadThumb(el.dataset.path, null).then((url) => {
    if (!url) return;
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  });
}

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

  // Building a strip for a cloud file means several round trips to OneDrive,
  // and the tile would sit empty for all of them. OneDrive already has a poster
  // for it -- one small image, no download -- so show that in the meantime.
  // Fire and forget: nothing below waits on it.
  let stripLanded = false;
  // Cloud only. A downloaded file builds its strip locally in well under a
  // second, and asking for a poster would just add an ffmpeg run per tile.
  if (previewEl && state.cloudOptIn.has(filePath)) {
    const already = state.thumbs.get(filePath);
    if (already) applyThumb(previewEl, already);
    else {
      fetch(`/api/thumb?path=${encodeURIComponent(filePath)}`)
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => {
          // The strip is what was asked for; if it beat us, leave it alone.
          if (!blob || stripLanded) return;
          const url = URL.createObjectURL(blob);
          keepThumb(filePath, url);
          if (!stripLanded) applyThumb(previewEl, url);
        })
        .catch(() => { /* no poster is simply no placeholder */ });
    }
  }

  const request = (async () => {
    try {
      // Cloud-only files are refused unless we say the user asked for this one.
      const allow = state.cloudOptIn.has(filePath) ? '&allowCloud=1' : '';
      const res = await fetch(`/api/sprite?path=${encodeURIComponent(filePath)}${allow}`);
      if (res.status === 409) {
        // Cloud-only and nobody has asked for this one: a refusal, not a
        // failure. Recording it as a failure is what stopped the player ever
        // getting a strip for a file whose tile had scrolled past first.
        if (previewEl) previewEl.classList.remove('loading');
        return null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `sprite failed (${res.status})`);
      }
      const frames = Number(res.headers.get('X-Sprite-Frames')) || 10;
      const blob = await res.blob();
      const entry = { url: URL.createObjectURL(blob), frames };
      state.sprites.set(filePath, entry);
      trimSprites();
      stripLanded = true;
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
  head.className = 'preview-fail-head';
  head.innerHTML = ICONS.warn;
  head.append(' No preview');
  const why = document.createElement('div');
  why.textContent = String(message || '').slice(0, 90);
  fail.append(head, why);
  el.appendChild(fail);
}

/**
 * How many preview strips are kept in memory at once.
 *
 * A strip is about 170KB of decoded image held behind a blob URL, and every
 * card that scrolls past asks for one: a long browse of the library root was
 * heading for gigabytes, all of it for cards nobody can see any more. Only
 * strips whose cards have left the grid are let go, and the one playing is
 * never let go at all.
 */
const SPRITE_CAP = 400;

function trimSprites() {
  const spare = state.sprites.size - SPRITE_CAP;
  if (spare <= 0) return;
  const playing = state.playing ? state.playing.path : '';
  let freed = 0;
  for (const [filePath, entry] of state.sprites) {
    if (freed >= spare) break;
    if (filePath === playing) continue;
    // Still on screen somewhere, or about to be: revoking it now would blank a
    // tile that is drawn from this very URL.
    if (cardsFor(filePath).length) continue;
    URL.revokeObjectURL(entry.url);
    state.sprites.delete(filePath);
    freed += 1;
  }
}

function applySprite(previewEl, entry) {
  previewEl.classList.remove('loading');
  previewEl.dataset.frames = String(entry.frames);
  previewEl.style.backgroundImage = `url("${entry.url}")`;
  previewEl.style.backgroundSize = `${entry.frames * 100}% 100%`;
  previewEl.style.backgroundPositionX = '0%';
  buildTicks(previewEl, entry.frames);
}

/**
 * How many posters are kept behind blob URLs at once.
 *
 * Each tile's picture was held for the rest of the session, and so was every
 * one the player's rows of similar videos and faces fetched along the way.
 * Over the cap the oldest go, unless something on the page is drawn from
 * them: a card in the grid, a folder cover, a tile in the player, or the
 * player's own poster. Trimmed well below the cap, so the walk runs once per
 * couple of hundred pictures rather than once per picture.
 */
const THUMB_CAP = 1500;

function keepThumb(filePath, url) {
  state.thumbs.set(filePath, url);
  if (state.thumbs.size > THUMB_CAP) trimThumbs();
}

function trimThumbs() {
  const spare = state.thumbs.size - (THUMB_CAP - 200);
  if (spare <= 0) return;
  const keep = new Set();
  if (state.playing) keep.add(state.playing.path);
  for (const el of document.querySelectorAll('.folder-cover[data-path]')) keep.add(el.dataset.path);
  // The player's tiles are drawn from a poster of some other video, often one
  // that is not in this listing at all, so they are asked by the URL they show.
  const shown = [...document.querySelectorAll('.similar-shot')]
    .map((el) => el.style.backgroundImage).join(' ');
  let freed = 0;
  for (const [filePath, url] of state.thumbs) {
    if (freed >= spare) break;
    if (keep.has(filePath) || cardsFor(filePath).length || shown.includes(url)) continue;
    URL.revokeObjectURL(url);
    state.thumbs.delete(filePath);
    freed += 1;
  }
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
      if (res.status === 503) {
        // OneDrive is throttling, not refusing: it has a picture for this one.
        // Asked for again shortly rather than left blank for the session, which
        // is what a whole library asking at once used to come to.
        if (previewEl) previewEl.classList.remove('loading');
        const body = await res.json().catch(() => ({}));
        retryPoster(previewEl, filePath, Number(body.retryAfter) || 5);
        return null;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `poster failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      keepThumb(filePath, url);
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

/**
 * Strips built ahead of being wanted, so opening a cloud video is instant.
 *
 * Building one takes about twelve seconds and cannot be made faster -- the
 * concurrency is already at its measured optimum. It can only be made earlier.
 * Since the result is cached on disk forever, doing it while a tile is merely
 * on screen turns every later opening into a 1ms read.
 *
 * Strictly one at a time: a single build is already four parallel range
 * requests to one host, and stacking them collects connection refusals.
 */
const prebuild = { queue: [], seen: new Set(), running: false };

function queuePrebuild(file, urgent = false) {
  if (!file || !file.cloudOnly) return;
  if (prebuild.seen.has(file.path)) {
    // Already queued or done -- but a hover still deserves to jump the queue.
    if (!urgent) return;
    const at = prebuild.queue.findIndex((f) => f.path === file.path);
    if (at > 0) prebuild.queue.unshift(...prebuild.queue.splice(at, 1));
    return;
  }
  if (state.sprites.has(file.path)) return; // this session already has it
  prebuild.seen.add(file.path);
  if (urgent) prebuild.queue.unshift(file);
  else prebuild.queue.push(file);
  runPrebuild();
}

async function runPrebuild() {
  if (prebuild.running) return;
  prebuild.running = true;
  try {
    while (prebuild.queue.length) {
      const file = prebuild.queue.shift();
      // Watching is not required to build it, and building downloads nothing.
      state.cloudOptIn.add(file.path);
      state.failed.delete(file.path);
      try { await loadSprite(file.path, null); } catch { /* try the next one */ }
    }
  } finally {
    prebuild.running = false;
  }
}

/**
 * Asks the server to resolve a cloud file's streaming URL before it is needed.
 *
 * Once per file per session: the server caches the answer for 45 minutes, and
 * a second request would only confirm what it already knows. Failures are
 * ignored on purpose -- this is an optimisation, and /api/video still does the
 * lookup itself if this never ran.
 */
const warmed = new Set();
function warmStream(file) {
  if (!file || !file.cloudOnly || warmed.has(file.path)) return;
  warmed.add(file.path);
  fetch(`/api/warm?path=${encodeURIComponent(file.path)}`).catch(() => {
    // Let it be tried again: the click may still be seconds away.
    warmed.delete(file.path);
  });
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
    Number(state.config.dwellMs) || 2000,
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
  // Which visit this is. The sprite can take seconds to arrive, and a pointer
  // that has passed over the tile and gone in the meantime left an interval
  // cycling frames on a tile nobody was hovering -- forever, since the
  // mouseleave that clears it had already been and gone.
  let visit = 0;

  const stopSprite = () => {
    clearInterval(timer);
    timer = null;
    index = 0;
    showSpriteFrame(previewEl, 0);
  };

  previewEl.addEventListener('mouseenter', async () => {
    const mine = ++visit;
    // Before anything else, and whether or not previews are opted into: get the
    // streaming URL resolved now. Playing a cloud file needs a Graph lookup
    // worth about three seconds, and hovering is the warning that it is coming.
    warmStream(file);
    // The strongest hint about what is about to be clicked.
    queuePrebuild(file, true);
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
    if (mine !== visit) return; // left while it loaded

    index = 0;
    showSpriteFrame(previewEl, 0);
    clearInterval(timer);
    timer = setInterval(() => {
      index = (index + 1) % (Number(previewEl.dataset.frames) || 1);
      showSpriteFrame(previewEl, index);
    }, Number(state.config.dwellMs) || 2000);
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
    visit += 1;
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

