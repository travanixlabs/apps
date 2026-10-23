'use strict';

/**
 * What "matches the advanced filter" means -- in one place, for both sides.
 *
 * The browser has always answered this, because it holds the listing. The
 * folder tiles ask a question the browser cannot answer: how many videos in a
 * subfolder match, when the videos in that subfolder were never sent. Only the
 * server knows those, so the server has to be able to run the same test -- and
 * two implementations of "does this video match" would agree exactly once, on
 * the day the second one was written.
 *
 * So this file is loaded as a plain script by the page and required by the
 * server, and neither owns it. Nothing in here touches the DOM or the app's
 * state: a file is a plain object, and the one thing the matcher cannot work
 * out for itself -- which performers are favourites -- arrives as context.
 */
(function (root, build) {
  // The fixed vocabularies come from shared/facets.js. Under Node that is a
  // require; on a page it is what that script left as globals, so the page
  // must load it first -- and says so if it did not, rather than carrying a
  // second copy of every list that would drift.
  let shared = null;
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    shared = require('../shared/facets.js');
  } else if (root && Array.isArray(root.RACES) && root.PERSON_FACETS
    && typeof root.FACE_FLOOR === 'number') {
    shared = root;
  } else {
    throw new Error('filter.js needs shared/facets.js loaded before it');
  }
  const format = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('../shared/format.js') : root;
  if (typeof format.offeredNames !== 'function') throw new Error('filter.js needs shared/format.js loaded before it');
  const api = build(shared, format);
  if (typeof module === 'object' && module.exports) module.exports = api;
  // A classic script: the page reads these as globals, exactly as it did when
  // they were declared at the top of app.js.
  else Object.assign(root, api);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (shared, format) {

  /**
   * Nothing under a fifth is offered. Half and up is credited on its own when a
   * video is first profiled -- see AUTO_CREDIT in faces.js.
   *
   * This is the question of what is worth showing somebody, and the player, the
   * suggestion strip and the grouping all have to answer it the same way.
   *
   * It lives here rather than in the page because the server loads this file
   * too, and one number in one place is the whole point of the arrangement.
   */
  const FACE_FLOOR = shared.FACE_FLOOR;

  /**
   * The one-question facets, each answer a predicate.
   *
   * Empty now: favourite model, source link, availability, the face index and
   * duplicates have all been taken out of the dialog in turn. The table and the
   * matcher that reads it stay -- they cost nothing while empty, and this is
   * where the next such filter goes rather than a special case in the renderer.
   *
   * Duplicates are still found and still grouped; they are just not a filter.
   */
  const CHOICES = {
    // Sync: what the three sweeps have done to a video, and where it lives.
    // `framed` and `printed` come with the listing; `profiled` and `cloudOnly`
    // always did.
    framing: { done: (f) => f.framed === true, todo: (f) => f.framed !== true },
    fingerprint: { done: (f) => f.printed === true, todo: (f) => f.printed !== true },
    profiling: { done: (f) => f.profiled === true, todo: (f) => f.profiled !== true },
    storage: { downloaded: (f) => !f.cloudOnly, cloud: (f) => Boolean(f.cloudOnly) },
    // Somebody the faces point to at FACE_FLOOR or better, not yet credited
    // and not turned down -- a suggestion still waiting for an answer.
    suggestions: { some: (f) => pendingSuggestions(f) > 0, none: (f) => pendingSuggestions(f) === 0 },
  };

  function pendingSuggestions(f) {
    // The names still waiting: at the floor, neither credited nor refused.
    // One rule, in shared/format.js, for the page, the server and the phone.
    return format.offeredNames(f.suggested, { floor: FACE_FLOOR, refused: f.notModels, credited: f.models }).length;
  }

  const CHOICE_FACETS = Object.keys(CHOICES);

  /**
   * Match % ranges: a video passes when at least one of its names scores
   * within the range. Held like any facet -- a Map with one entry, the range
   * as "min-max" -- so packing, clearing and the chips under the search need
   * nothing of their own.
   *
   *   suggestedPct  a suggestion still waiting: not credited, not turned down
   *   labelledPct   a credited name, scored against her average face
   */
  function scoreOf(f, name) {
    const want = String(name).toLowerCase();
    let best = null;
    for (const s of f.suggested || []) {
      if (String(s.name).toLowerCase() === want && (best === null || s.score > best)) best = s.score;
    }
    if (best !== null) return best;
    for (const [credited, score] of Object.entries(f.credit || {})) {
      if (credited.toLowerCase() === want) return score;
    }
    return null;
  }

  const RANGES = {
    suggestedPct: (f) => {
      const done = new Set([...(f.models || []), ...(f.notModels || [])].map((n) => String(n).toLowerCase()));
      return (f.suggested || []).filter((s) => !done.has(String(s.name).toLowerCase())).map((s) => s.score);
    },
    labelledPct: (f) => (f.models || []).map((m) => scoreOf(f, m)).filter((s) => s !== null),
  };
  const RANGE_FACETS = Object.keys(RANGES);

  // Nothing under the suggestion floor: below 20% a face is not like anyone.
  const RANGE_MIN = 20;

  /** "50-100" as [50, 100], whole percents, low first, at least RANGE_MIN; null when it is not one. */
  function parseRange(value) {
    const m = /^(\d{1,3})-(\d{1,3})$/.exec(String(value));
    if (!m) return null;
    let lo = Number(m[1]);
    let hi = Number(m[2]);
    if (lo > 100 || hi > 100) return null;
    if (lo > hi) [lo, hi] = [hi, lo];
    return [Math.max(RANGE_MIN, lo), Math.max(RANGE_MIN, hi)];
  }

  function rangeMatch(facet, range, file) {
    const [lo, hi] = range;
    return RANGES[facet](file).some((score) => {
      const pct = Math.round(score * 100);
      return pct >= lo && pct <= hi;
    });
  }


  /**
   * Race, as you have labelled each performer -- four answers and no more.
   *
   * Nothing works it out: it is a label given to a PERSON, by hand, and every
   * video credited to her carries it. A video has as many races as it has
   * labelled performers, so it is matched like a tag list, not one value.
   */
  const RACES = shared.RACES;

  /** The races a video carries, from its credited performers, in RACES order. */
  function racesOf(file, ctx) {
    return personValues('race', file, ctx);
  }

  /**
   * What belongs to a performer rather than a file -- height, bust, body, race,
   * and how much of a favourite she is. A video carries whatever its credited
   * performers have, so each is matched like a tag list, in dialog order.
   */
  const PERSON_FACETS = shared.PERSON_FACETS;
  const PERSON_FIELDS = Object.keys(PERSON_FACETS);

  /**
   * One performer facet's values on a video, in that facet's order. The maps
   * arrive as context: raceOf (name -> race), traitsOf (name -> { height, bust,
   * body }), favSet and favTiers (name -> 1..5; a favourite without one is 3).
   */
  function personValues(field, file, ctx) {
    const have = new Set();
    for (const raw of file.models || []) {
      const name = String(raw).trim().toLowerCase();
      if (field === 'race') {
        const race = ctx && ctx.raceOf && ctx.raceOf.get(name);
        if (race) have.add(race);
      } else if (field === 'favourites') {
        if (ctx && ctx.favSet && ctx.favSet.has(name)) {
          const tier = (ctx.favTiers && ctx.favTiers.get(name)) || 3;
          have.add(`Tier ${tier}`);
        }
      } else {
        const traits = ctx && ctx.traitsOf && ctx.traitsOf.get(name);
        const value = traits && traits[field];
        for (const v of Array.isArray(value) ? value : (value ? [value] : [])) have.add(v);
      }
    }
    return PERSON_FACETS[field].filter((v) => have.has(v));
  }

  const FACETS = ['tags', 'models', 'ratings'].concat(PERSON_FIELDS);

  /** The label facets, in the order they appear on a card and in the dialog. */
  const LABEL_FACETS = ['models', 'tags'];

  /** Every facet a filter can hold — the label ones, ratings, and the pickers. */
  const ALL_FACETS = FACETS.concat(CHOICE_FACETS, RANGE_FACETS);

  /**
   * The "no tags" / "no models" chip lives in the same map as the values, under a
   * key no tag can have. A separate field would need its own copying, clearing,
   * counting and emptiness test; a NUL key gets all of that for free, and
   * `picked()` filters it out of the value lists.
   */
  const NOTHING = ' ';

  /**
   * Which facets hold one value per video rather than a list.
   *
   * Empty since studio and production went: both label facets are lists now.
   * Kept rather than deleted because the matcher below reads it, and a facet
   * that holds one value is a thing this could be asked to do again.
   */
  const SINGLE_VALUED = {};

  /**
   * The advanced filter. Each facet is a Map of value → 'in' | 'out': clicking a
   * chip cycles include → exclude → gone. An empty map means "no constraint"
   * rather than "match nothing", so a fresh filter is transparent and the UI never
   * has to special-case "everything is unchecked".
   */
  function newAdvFilter() {
    const adv = {
      tags: new Map(),
      models: new Map(),
      // Per facet, because "all of these tags" and "any of these performers" is a
      // reasonable thing to ask for and one shared switch could not express it.
      // Exclusions are always all-of: "not this" means not this either way.
      mode: { tags: 'all', models: 'all' },
      ratings: new Map(),   // 0 means unrated
    };
    for (const field of PERSON_FIELDS) {
      adv[field] = new Map();
      adv.mode[field] = 'all';
    }
    // The one-question facets -- favourite, source link, availability, where a
    // video stands with the face index, how many names came out of it, what was
    // done about them, whether it is one of several copies -- take their maps
    // from the CHOICES table rather than a line each here.
    //
    // They were listed in both places until a facet was added to the table and
    // not to this list, and the dialog read `undefined.get(...)` the moment it
    // tried to draw the row. Two lists that must agree are one list.
    //
    // All of them were one-of-N pickers once and are maps now, so every row
    // cycles include -> exclude -> off. "Exclude not profiled" is a thing you can
    // want and could not previously say.
    for (const facet of CHOICE_FACETS) adv[facet] = new Map();
    for (const facet of RANGE_FACETS) adv[facet] = new Map();
    return adv;
  }

  /** Whether any facet constrains anything. An empty filter is transparent. */
  function filterActive(adv) {
    if (!adv) return false;
    return ALL_FACETS.some((f) => adv[f] && adv[f].size > 0);
  }

  /**
   * The values a facet includes, or excludes — the two are always read apart, and
   * the emptiness chip is not a value, so it never appears here.
   */
  function picked(facet, want) {
    return [...facet]
      .filter(([value, mode]) => mode === want && value !== NOTHING)
      .map(([value]) => value);
  }

  /**
   * Included if it matches any included answer, and out if it matches an excluded
   * one. Exclusion wins, the way it does for tags: "not this" means not this.
   */
  function choiceMatch(chosen, facet, file, ctx) {
    if (!chosen || !chosen.size) return true;
    const tests = CHOICES[facet];
    let wanted = false;
    let hit = false;
    for (const [value, mode] of chosen) {
      const test = tests[value];
      if (!test) continue;
      const is = test(file, ctx);
      if (mode === 'out' && is) return false;
      if (mode === 'in') { wanted = true; if (is) hit = true; }
    }
    return !wanted || hit;
  }

  /**
   * A filter read once, for asking of many videos.
   *
   * Working out which chips are in and which are out, and lower-casing them, is
   * the same answer for every video in a pass -- and was being worked out again
   * for each of them, per facet: 27,000 videos made a quarter of a million
   * little arrays to say what the dialog already said. Compile once and hand
   * the result to matchesAdvanced in place of the filter.
   *
   * A snapshot of the chips as they stand: a filter edited afterwards needs
   * compiling again, so it is made per pass and not kept.
   */
  const COMPILED = typeof Symbol === 'function' ? Symbol('compiled filter') : '__compiled';

  function compileAdvanced(adv) {
    const lower = (t) => t.toLowerCase();
    const labels = [];
    for (const field of PERSON_FIELDS.concat(LABEL_FACETS)) {
      if (!adv[field] || !adv[field].size) continue;
      labels.push({
        field,
        person: Boolean(PERSON_FACETS[field]),
        nothing: adv[field].get(NOTHING),
        wanted: picked(adv[field], 'in').map(lower),
        any: Boolean(SINGLE_VALUED[field] || (adv.mode || {})[field] === 'any'),
        unwanted: picked(adv[field], 'out').map(lower),
      });
    }
    const ratings = adv.ratings.size
      ? { wanted: picked(adv.ratings, 'in'), unwanted: picked(adv.ratings, 'out') } : null;
    const choices = CHOICE_FACETS.filter((facet) => adv[facet] && adv[facet].size)
      .map((facet) => [facet, adv[facet]]);
    const ranges = [];
    for (const facet of RANGE_FACETS) {
      for (const [value, mode] of adv[facet] || []) {
        const range = parseRange(value);
        if (range) ranges.push({ facet, range, out: mode === 'out' });
      }
    }
    return { [COMPILED]: true, labels, ratings, choices, ranges };
  }

  /**
   * The advanced filter, on top of whatever the quick filter box says. Every
   * populated facet has to match; an empty one is ignored.
   *
   * `adv` is the filter itself or what compileAdvanced made of it; given the
   * filter, it is compiled for this one video, which is the old cost and the
   * old answer.
   */
  function matchesAdvanced(file, adv, ctx) {
    const filter = adv && adv[COMPILED] ? adv : compileAdvanced(adv);
    // Tags and models are matched the same way, but each facet on its own: two
    // models and one tag means "those models AND that tag", not one merged pool.
    // The all/any switch governs the included tags; exclusions are always all-of,
    // since "not this" means not this whichever way that switch is set.
    for (const facet of filter.labels) {
      // Wrapped, so a facet holding a single value would still match here.
      // A performer facet is not on the file: it comes from who is credited.
      const held = facet.person ? personValues(facet.field, file, ctx) : file[facet.field];
      const have = new Set((Array.isArray(held) ? held : (held ? [held] : []))
        .map((t) => t.toLowerCase()));

      // "Has none at all" is its own question, asked before any value is compared:
      // include it to see only the unlabelled, exclude it to drop them.
      if (facet.nothing === 'in' && have.size) return false;
      if (facet.nothing === 'out' && !have.size) return false;

      const { wanted } = facet;
      if (wanted.length) {
        const hit = facet.any ? wanted.some((t) => have.has(t)) : wanted.every((t) => have.has(t));
        if (!hit) return false;
      }
      if (facet.unwanted.some((t) => have.has(t))) return false;
    }

    if (filter.ratings) {
      const rating = file.rating || 0;
      const { wanted } = filter.ratings;
      if (wanted.length && !wanted.includes(rating)) return false;
      if (filter.ratings.unwanted.includes(rating)) return false;
    }

    for (const [facet, chosen] of filter.choices) {
      if (!choiceMatch(chosen, facet, file, ctx)) return false;
    }

    for (const { facet, range, out } of filter.ranges || []) {
      if (rangeMatch(facet, range, file) === out) return false;
    }

    return true;
  }

  // ------------------------------------------------------------ over the wire

  /**
   * A filter as JSON. Maps do not survive JSON.stringify, so each facet travels
   * as its entry pairs -- which keeps a rating's number a number, where an
   * object's keys would have made it the string "3" and quietly matched nothing.
   */
  function packFilter(adv) {
    const out = { mode: { ...(adv.mode || {}) } };
    for (const facet of ALL_FACETS) out[facet] = [...(adv[facet] || new Map())];
    return out;
  }

  /**
   * What a facet will accept as one of its values, once a filter has come in
   * over a socket rather than out of the dialog.
   *
   * Typed rather than taken as sent. A rating has to be a number, because the
   * matcher compares it to one; a label has to be a string, because the matcher
   * lower-cases it, and `null` sent where a tag was expected threw inside the
   * comparison. A one-question facet has to be an answer that facet actually
   * has, or the predicate lookup finds nothing and the chip silently does not
   * apply. Anything else is not a value this filter can hold, so it is dropped.
   */
  function readValue(facet, value) {
    if (facet === 'ratings') {
      // The type is checked before the conversion, because Number(null) and
      // Number('') are both 0 -- which is a real rating here, the one meaning
      // unrated. Converting first would turn a missing value into a filter for
      // every unrated video in the library.
      if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
      if (typeof value !== 'string' || !value.trim()) return undefined;
      const rating = Number(value);
      return Number.isFinite(rating) ? rating : undefined;
    }
    if (CHOICES[facet]) {
      return typeof value === 'string' && CHOICES[facet][value] !== undefined
        ? value : undefined;
    }
    if (RANGES[facet]) {
      const range = parseRange(value);
      return range ? range.join('-') : undefined;
    }
    if (PERSON_FACETS[facet]) {
      return typeof value === 'string' && (value === NOTHING || PERSON_FACETS[facet].includes(value))
        ? value : undefined;
    }
    // A label facet. The emptiness chip lives in the same map under a key no
    // tag can have, and is a string like the rest.
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * The same filter, read back. Anything unrecognised is dropped rather than
   * trusted: this arrives over a socket, and a facet the matcher does not know
   * would either throw or silently widen what counts as a match.
   */
  function unpackFilter(raw) {
    const adv = newAdvFilter();
    if (!raw || typeof raw !== 'object') return adv;
    for (const facet of ALL_FACETS) {
      const pairs = Array.isArray(raw[facet]) ? raw[facet] : [];
      for (const pair of pairs) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [sent, mode] = pair;
        if (mode !== 'in' && mode !== 'out') continue;
        const value = readValue(facet, sent);
        if (value === undefined) continue;
        adv[facet].set(value, mode);
      }
    }
    const mode = raw.mode && typeof raw.mode === 'object' ? raw.mode : {};
    for (const field of ['tags', 'models'].concat(PERSON_FIELDS)) {
      if (mode[field] === 'any' || mode[field] === 'all') adv.mode[field] = mode[field];
    }
    return adv;
  }

  return {
    CHOICES,
    FACE_FLOOR,
    CHOICE_FACETS,
    RANGE_FACETS,
    RANGE_MIN,
    parseRange,
    rangeMatch,
    FACETS,
    LABEL_FACETS,
    ALL_FACETS,
    RACES,
    racesOf,
    PERSON_FACETS,
    PERSON_FIELDS,
    personValues,
    NOTHING,
    SINGLE_VALUED,
    newAdvFilter,
    filterActive,
    picked,
    choiceMatch,
    compileAdvanced,
    matchesAdvanced,
    packFilter,
    readValue,
    unpackFilter,
  };
}));
