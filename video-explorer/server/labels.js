'use strict';

/**
 * The vocabularies as operations: a label added, renamed or deleted; a
 * performer renamed, or declared not to be one. Each used to live inline in a
 * route, which meant it could only be done over HTTP -- so the command-line
 * tools re-implemented them, and the test could not reach them at all.
 */

const path = require('path');

const library = require('../library');
const faces = require('../faces');
const { writeWhole } = require('../write-whole');
const { log, loadJsonSync } = require('./util');
const { saveConfigSoon, state } = require('./config');

const cleanName = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const lower = (s) => String(s).toLowerCase();
const without = (list, drop) => list.filter((t) => lower(t) !== lower(drop));
const spareLabels = () => (Array.isArray(state.config.spareLabels) ? state.config.spareLabels : []);

/** A label that nothing carries yet. Returns how many videos changed (none). */
function addLabel(rawName) {
  const name = cleanName(rawName);
  if (!name) throw badRequest('A label needs a name');
  const spare = spareLabels();
  const used = library.tagCounts().some((t) => lower(t.tag) === lower(name));
  const already = spare.some((t) => lower(t) === lower(name));
  if (!used && !already) {
    state.config.spareLabels = [...spare, name];
    saveConfigSoon({ user: true });
  }
  return { changed: 0 };
}

/**
 * Renamed everywhere: on every video, in the colour table and in the spare
 * list. The colour belongs to the label, so it moves with it, and a spare
 * label is renamed in place rather than left behind as a second one.
 */
function renameLabel(rawFrom, rawTo) {
  const name = cleanName(rawFrom);
  const to = cleanName(rawTo);
  if (!name || !to) throw badRequest('Both names are needed');
  const { changed } = library.renameTag(name, to);
  const colours = { ...(state.config.labelColours || {}) };
  const held = colours[lower(name)];
  delete colours[lower(name)];
  if (held) colours[lower(to)] = held;
  const spare = spareLabels();
  state.config.labelColours = colours;
  state.config.spareLabels = spare.some((t) => lower(t) === lower(name))
    ? [...without(spare, name), to] : spare;
  saveConfigSoon({ user: true });
  return { changed };
}

/** Taken off every video, its colour and spare entry with it. */
function deleteLabel(rawName) {
  const name = cleanName(rawName);
  if (!name) throw badRequest('Which label?');
  const { changed } = library.removeTagEverywhere(name);
  const colours = { ...(state.config.labelColours || {}) };
  delete colours[lower(name)];
  state.config.labelColours = colours;
  state.config.spareLabels = without(spareLabels(), name);
  saveConfigSoon({ user: true });
  return { changed };
}

/**
 * A performer renamed: her credits, the videos she was turned down on, race,
 * height/bust/body and favourite tier all move to the new name, and the face
 * lineups are rebuilt under it.
 */
function renamePerformer(rawFrom, rawTo) {
  const name = cleanName(rawFrom);
  const to = cleanName(rawTo);
  if (!name || !to) throw badRequest('Both names are needed');
  const out = library.renamePerformer(name, to);
  faces.rebuildSoon();
  return out;
}

/**
 * "Not a performer": a credited name that is not a person -- a word out of a
 * filename, a studio, a scene title. It comes off every video in one write,
 * takes its race and favourite mark with it, and goes on the list the
 * filename suggester reads first, so it is never offered again.
 */
async function markNotPerformer(rawName) {
  const name = cleanName(rawName);
  if (!name) throw badRequest('Which name?');
  const { changed } = library.removeTagEverywhere(name, 'models');
  log(`not a performer: "${name}" taken off ${changed} video(s)`);
  // Her average face was built from those credits. Rebuilt without them, she
  // has none, and stops being suggested anywhere.
  faces.rebuildSoon();
  if (library.isFavouriteModel(name)) library.setFavouriteModel(name, false);
  const races = library.setPerformerRace(name, '');
  const traits = library.setPerformerTraits(name, { height: '', bust: '', body: [] });
  try {
    const file = path.join(state.ONEDRIVE_ROOT, '.video-explorer', 'not-model-names.json');
    const held = loadJsonSync(file, null) || { names: [] };
    if (!Array.isArray(held.names)) held.names = [];
    if (!held.names.some((n) => lower(n.name || '') === lower(name))) {
      held.names.push({ name, why: 'marked not a performer in the app', when: new Date().toISOString().slice(0, 10) });
      held.updated = new Date().toISOString();
      await writeWhole(file, JSON.stringify(held, null, 2));
    }
  } catch (err) {
    log(`not-a-performer: could not note "${name}" for the suggester: ${err.message}`);
  }
  return { changed, races, traits };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = { addLabel, renameLabel, deleteLabel, renamePerformer, markNotPerformer };
