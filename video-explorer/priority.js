/* Who gets the machine when somebody is waiting on a screen.
 *
 * The background sweeps deliberately do NOT stand aside for ordinary use --
 * that was tried, on an activity clock, and playback is a range request every
 * few seconds, so the sweeps stopped for the whole viewing. See the comment on
 * the loop in faces.js.
 *
 * This is the narrow exception. Opening the player builds a ten-frame preview
 * strip, and for a cloud-backed video that means ten seeks over the network
 * with a person watching a spinner. It is short, it is blocking, and it is the
 * one piece of work in the app that a human is actually waiting on. So for the
 * length of that build -- and no longer -- the sweeps hold off.
 *
 * A hold is a lease, not a switch: it always expires. A cloud read that hangs
 * must not be able to pause profiling forever, so every hold carries its own
 * deadline and lets go on its own if the work never reports back.
 */
const MAX_HOLD_MS = 3 * 60 * 1000;

let held = 0;              // how many builds are in flight
let since = 0;             // when the first of them started
let label = '';            // what we are waiting on, for the status readout
const waiters = [];        // resolve functions for sweeps parked on settled()

function release() {
  held -= 1;
  if (held > 0) return;
  held = 0;
  since = 0;
  label = '';
  // Everyone waiting goes at once: they are separate loops, and the point is
  // to let them all resume, not to hand the machine to whichever asked first.
  const waking = waiters.splice(0, waiters.length);
  for (const wake of waking) wake();
}

/**
 * Take the lease. Returns the function that gives it back -- call it in a
 * `finally`, and call it exactly once; a second call is ignored rather than
 * dropping somebody else's hold.
 */
function hold(what) {
  if (!held) { since = Date.now(); label = what || ''; }
  held += 1;

  let done = false;
  const give = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    release();
  };
  // The safety net. If the build never finishes -- a stalled hydration, a
  // dropped connection -- the sweeps get the machine back anyway.
  const timer = setTimeout(give, MAX_HOLD_MS);
  if (timer.unref) timer.unref();
  return give;
}

/** Is anything holding right now? Cheap enough to ask every loop iteration. */
function busy() {
  return held > 0;
}

/**
 * Resolves when the last hold is given back. Resolves immediately if there is
 * nothing to wait for, so a caller can await it unconditionally.
 */
function settled() {
  if (!held) return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}

function status() {
  return { holding: held > 0, holds: held, waitingFor: label, sinceMs: since ? Date.now() - since : 0 };
}

module.exports = { hold, busy, settled, status, MAX_HOLD_MS };
