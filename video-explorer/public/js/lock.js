'use strict';

/**
 * The passcode the app asks for when it opens, and again after five minutes
 * of nobody using it (Tre, 2026-11-01).
 *
 * A screen lock, not encryption: it keeps the window closed to whoever sits at
 * the PC, and the server behind it answers as it always did. The unlock is
 * held in sessionStorage, which a reload (F5, Ctrl+F5) keeps and closing the
 * app throws away; locking again after idling drops it, so a reload of a
 * locked window stays locked.
 *
 * Loaded straight after its own markup and before everything else, so the page
 * underneath is hidden from the first paint rather than flashing up first.
 */
(() => {
  const PASSCODE = '6666';
  const KEY = 've-unlocked';
  // Five minutes without a key, a click, a wheel or the mouse moving. A video
  // playing in the player counts as use: watching is not being away.
  const IDLE_MS = 5 * 60 * 1000;
  const lock = document.getElementById('lock');
  const input = document.getElementById('lockInput');
  const dots = [...document.querySelectorAll('#lockDots span')];
  const note = document.getElementById('lockNote');

  let locked = false;
  let lastUse = Date.now();

  // While locked, no key reaches the app's own shortcuts: Space, the arrows,
  // Delete and the rest are all listened for further down -- and the digits
  // typed here are the rating keys, so even those stop at the window. The box
  // still takes them: stopping the event is not cancelling it.
  const swallow = (ev) => {
    ev.stopImmediatePropagation();
    if (ev.target === input) return;
    if (ev.key !== 'Tab') ev.preventDefault();
    input.focus();
  };

  const paint = () => {
    dots.forEach((dot, i) => dot.classList.toggle('on', i < input.value.length));
  };

  function shut() {
    if (locked) return;
    locked = true;
    try { sessionStorage.removeItem(KEY); } catch { /* fine */ }
    // Nothing goes on playing behind the lock.
    for (const video of document.querySelectorAll('video')) { try { video.pause(); } catch { /* fine */ } }
    input.value = '';
    note.textContent = '';
    lock.classList.remove('wrong');
    paint();
    lock.hidden = false;
    document.documentElement.classList.add('locked');
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    input.focus();
  }

  function unlock() {
    locked = false;
    lastUse = Date.now();
    try { sessionStorage.setItem(KEY, '1'); } catch { /* this load only */ }
    window.removeEventListener('keydown', swallow, true);
    window.removeEventListener('keyup', swallow, true);
    document.documentElement.classList.remove('locked');
    lock.hidden = true;
    input.blur();
  }

  // Focus stays in the box: a click anywhere puts it back.
  lock.addEventListener('mousedown', (ev) => { if (ev.target !== input) { ev.preventDefault(); input.focus(); } });

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, PASSCODE.length);
    note.textContent = '';
    lock.classList.remove('wrong');
    paint();
    if (input.value.length < PASSCODE.length) return;
    if (input.value === PASSCODE) { unlock(); return; }
    note.textContent = 'Wrong passcode';
    void lock.offsetWidth; // restarts the shake on a second wrong try
    lock.classList.add('wrong');
    input.value = '';
    paint();
  });

  // Use, as it happens: one timestamp, nothing else, so the listeners cost
  // nothing on a mouse that moves all the time.
  const used = () => { if (!locked) lastUse = Date.now(); };
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, used, { capture: true, passive: true });
  }
  const watching = () => {
    const player = document.getElementById('player');
    return Boolean(player && !player.paused && !player.ended);
  };
  // Measured against the clock rather than counted down, so a PC that slept
  // through the five minutes is locked when it wakes.
  setInterval(() => {
    if (locked) return;
    if (watching()) { lastUse = Date.now(); return; }
    if (Date.now() - lastUse >= IDLE_MS) shut();
  }, 10 * 1000);

  let open = false;
  try { open = sessionStorage.getItem(KEY) === '1'; } catch { /* asks every load */ }
  if (open) unlock();
  else shut();
  // The window can take focus a moment after the page has loaded.
  window.addEventListener('load', () => { if (locked) input.focus(); });

})();
