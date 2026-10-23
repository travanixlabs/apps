'use strict';

/**
 * The labels: a video's record, and the vocabularies -- tags, performers,
 * races, favourites, traits.
 */

const fsp = require('fs').promises;
const path = require('path');

const library = require('../../library');
const faces = require('../../faces');
const { authoriseOrThrow, state } = require('../config');
const labels = require('../labels');
const { sendJson } = require('../http');

const vocabulary = () => ({
  tags: library.tagCounts(),
  models: library.modelCounts(),
  studios: library.studioCounts(),
  productions: library.productionCounts(),
});

const people = () => ({
  favourites: library.favouriteModels(),
  favouriteTiers: library.favouriteTiers(),
  races: library.performerRaces(),
  traits: library.performerTraits(),
});

module.exports = () => [
  ['GET', '/api/library', async ({ res }) => sendJson(res, 200, {
    ...vocabulary(),
    ...people(),
    stats: library.stats(),
  })],

  ['POST', '/api/library', async ({ res, body }) => {
    const { paths: listed, items: listedItems, ...patch } = await body();
    // Either one patch for many videos (`paths` + the patch), or a patch of
    // its own for each (`items`: [{ path, ...patch }]) -- the shape a bulk
    // answer like "All profiled" takes, sent once instead of a request per
    // name.
    const items = Array.isArray(listedItems)
      ? listedItems.filter((it) => it && typeof it.path === 'string')
        .map(({ path: p, ...own }) => ({ raw: p, patch: own }))
      : (Array.isArray(listed) ? listed : []).map((raw) => ({ raw, patch }));
    const records = {};
    const stats = new Map();
    let namesMoved = false;
    for (const { raw, patch: own } of items) {
      try {
        const target = authoriseOrThrow(raw);
        const stat = await fsp.stat(target);
        stats.set(raw, stat);
        const before = (library.decorate(stat).models || []).join('\n');
        // Without `paths`: apply() reads the patch's keys to tell a resume
        // save from a real edit.
        records[raw] = library.apply(stat, path.basename(target), own);
        if ((records[raw].models || []).join('\n') !== before) namesMoved = true;
      } catch (err) {
        records[raw] = { error: err.message || String(err) };
      }
    }
    // Naming someone changes who the averages are built from, so the
    // suggestions are only as current as the labels behind them. Only when
    // a name actually changed: the tag dialog sends its models box with
    // every save, and each rebuild is a full re-score of the library.
    if (namesMoved) faces.rebuildSoon();
    // Turning a name down changes one video's ranking and nobody's average,
    // so it re-scores that video instead of the whole library -- and then
    // says what the ranking became. Without that the client would keep
    // drawing the suggestion it has just refused, since its copy of the
    // listing is only as current as the last reply.
    if (items.some((it) => library.touchesSuggestions(it.patch))) {
      for (const { raw, patch: own } of items) {
        if (!library.touchesSuggestions(own) || (records[raw] && records[raw].error)) continue;
        try {
          const stat = stats.get(raw) || await fsp.stat(authoriseOrThrow(raw));
          faces.rescoreOne(stat);
          records[raw] = { ...records[raw], ...faces.decorate(stat) };
        } catch { /* the record answered above; a missing file is its problem */ }
      }
    }
    return sendJson(res, 200, { records, ...vocabulary() });
  }],

  // The label vocabulary itself: rename it everywhere, take it off
  // everything, or declare one that nothing carries yet. Colours live in the
  // config and go through /api/config like every other preference.
  ['POST', '/api/labels', async ({ res, body }) => {
    const asked = await body();
    const action = String(asked.action || '');
    let out;
    if (action === 'add') out = labels.addLabel(asked.name);
    else if (action === 'rename') out = labels.renameLabel(asked.name, asked.to);
    else if (action === 'delete') out = labels.deleteLabel(asked.name);
    else return sendJson(res, 400, { error: `Unknown action "${action}"` });
    return sendJson(res, 200, { ...out, config: state.config, tags: library.tagCounts() });
  }],

  // A performer renamed, or declared not to be one.
  ['POST', '/api/models', async ({ res, body }) => {
    const asked = await body();
    if (asked.action === 'rename') {
      const out = labels.renamePerformer(asked.name, asked.to);
      return sendJson(res, 200, { ...out, ...people() });
    }
    if (asked.action !== 'not-a-performer') {
      return sendJson(res, 400, { error: `Unknown action "${asked.action}"` });
    }
    const out = await labels.markNotPerformer(asked.name);
    return sendJson(res, 200, {
      ...out, models: library.modelCounts(),
      favourites: library.favouriteModels(), favouriteTiers: library.favouriteTiers(),
    });
  }],

  ['POST', '/api/races', async ({ res, body }) => {
    const asked = await body();
    return sendJson(res, 200, { races: library.setPerformerRace(asked.name, asked.race || '') });
  }],

  ['POST', '/api/favourites', async ({ res, body }) => {
    const asked = await body();
    const favourites = library.setFavouriteModel(asked.name, asked.on !== false, asked.tier);
    return sendJson(res, 200, { favourites, favouriteTiers: library.favouriteTiers() });
  }],

  ['POST', '/api/traits', async ({ res, body }) => {
    const { name, ...patch } = await body();
    return sendJson(res, 200, { traits: library.setPerformerTraits(name, patch) });
  }],
];
