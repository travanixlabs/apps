'use strict';

/**
 * The shape of a listing entry: every field a video carries and what it is
 * when the server leaves it out.
 *
 * Nine tenths of a library has no tags, no models and no rating, and saying
 * so 27,240 times was 8MB of "": [] per listing. So the server omits anything
 * that is merely the default (walk.js slim) and the page puts it back on
 * arrival (core.js hydrate). Those were two hand-written lists that had
 * already drifted -- studio, production, settled, framed and printed were in
 * one and not the other -- and the next non-falsy default would have arrived
 * on the page as undefined with nothing to say so. One list, read by both.
 *
 * Loaded by the server with require() and by the page as a plain script
 * (assigned onto globalThis), like shared/facets.js.
 */
(function (root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LISTING_DEFAULTS = Object.freeze({
    rating: 0,
    tags: [],
    models: [],
    notModels: [],
    studio: '',
    production: '',
    url: '',
    marks: [],
    resume: 0,
    updated: 0,
    settled: 0,
    suggested: [],
    people: 0,
    profiled: false,
    // Framed and fingerprinted by the sweeps. `printed` is null, not false,
    // while the fingerprint index is still being read: "not counted yet".
    framed: false,
    printed: false,
    cloudOnly: false,
    duplicate: false,
    copies: 0,
    dupeKinds: null,
  });

  /** A fresh default for a field: arrays are never shared between entries. */
  const defaultFor = (key) => {
    const d = LISTING_DEFAULTS[key];
    return Array.isArray(d) ? [] : d;
  };

  /** The entry with every missing field put back. In place. */
  function fillListing(entry) {
    for (const key of Object.keys(LISTING_DEFAULTS)) {
      if (entry[key] === undefined) entry[key] = defaultFor(key);
    }
    return entry;
  }

  return { LISTING_DEFAULTS, defaultFor, fillListing };
}));
