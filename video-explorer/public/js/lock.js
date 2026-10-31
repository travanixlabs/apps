'use strict';

/**
 * The passcode the app asks for when it opens (Tre, 2026-11-01).
 *
 * A screen lock, not encryption: it keeps the window closed to whoever sits at
 * the PC, and the server behind it answers as it always did. Asked once per
 * launch -- the unlock is held in sessionStorage, which a reload (F5, Ctrl+F5)
 * keeps and closing the app throws away.
 *
 * Loaded straight after its own markup and before everything else, so the page
 * underneath is hidden from the first paint rather than flashing up first.
 */
(() => {
  const PASSCODE = '6894';
  const KEY = 've-unlocked';
  const lock = document.getElementById('lock');
  const input = document.getElementById('lockInput');
  const dots = [...document.querySelectorAll('#lockDots span')];
  const note = document.getElementById('lockNote');

  let open = false;
  try { open = sessionStorage.getItem(KEY) === '1'; } catch { /* asks every load */ }
  if (open) { lock.remove(); return; }

  document.documentElement.classList.add('locked');

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
  window.addEventListener('keydown', swallow, true);
  window.addEventListener('keyup', swallow, true);
  // Focus stays in the box: a click anywhere puts it back.
  lock.addEventListener('mousedown', (ev) => { if (ev.target !== input) { ev.preventDefault(); input.focus(); } });

  const paint = () => {
    dots.forEach((dot, i) => dot.classList.toggle('on', i < input.value.length));
  };

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, PASSCODE.length);
    note.textContent = '';
    lock.classList.remove('wrong');
    paint();
    if (input.value.length < PASSCODE.length) return;
    if (input.value === PASSCODE) {
      try { sessionStorage.setItem(KEY, '1'); } catch { /* this load only */ }
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
      document.documentElement.classList.remove('locked');
      lock.remove();
      return;
    }
    note.textContent = 'Wrong passcode';
    void lock.offsetWidth; // restarts the shake on a second wrong try
    lock.classList.add('wrong');
    input.value = '';
    paint();
  });

  input.focus();
  // The window can take focus a moment after the page has loaded.
  window.addEventListener('load', () => input.focus());
})();
