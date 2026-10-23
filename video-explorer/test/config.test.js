'use strict';

// The settings file: writes land one at a time through a temp file and
// leave none behind; a file that will not parse is copied aside, the
// colours recovered from colours.json, and nothing written back until a
// setting actually changes.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../server/config');
const { state, CONFIG_FILE, loadConfig, saveConfigSoon, flushConfig, userSettings } = config;

test.after(() => sandbox.cleanup());

test('rapid saves land serially with no .tmp left behind', async () => {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ cardWidth: 200 }));
  loadConfig();
  for (let i = 1; i <= 6; i += 1) {
    state.config.cardWidth = 200 + i;
    saveConfigSoon({ user: true });
    await flushConfig();
  }
  assert.strictEqual(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).cardWidth, 206);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(CONFIG_FILE)).filter((n) => n.includes('.tmp')), []);
});

test('a config that will not parse is copied aside, colours recovered, and not written over until a setting changes', async () => {
  fs.mkdirSync(state.CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(state.CACHE_DIR, 'colours.json'), JSON.stringify({ version: 1, labels: { solo: '#abcdef' }, facets: { models: '#111111' }, spare: ['Spare one'] }));
  fs.writeFileSync(CONFIG_FILE, '{"roots": ["C:\\\\v"], "cardWidth": 3');
  const out = loadConfig();
  assert.ok(out.broken, 'reported');
  const copies = fs.readdirSync(path.dirname(CONFIG_FILE)).filter((n) => n.startsWith(path.basename(CONFIG_FILE) + '.broken-'));
  assert.strictEqual(copies.length, 1, 'the bad file is kept beside itself');
  assert.deepStrictEqual(state.config.roots, [], 'defaults');
  assert.deepStrictEqual(state.config.labelColours, { solo: '#abcdef' }, 'colours from the phone copy');
  assert.deepStrictEqual(state.config.spareLabels, ['Spare one']);

  // Bookkeeping must not replace the file...
  saveConfigSoon();
  await flushConfig();
  assert.strictEqual(fs.readFileSync(CONFIG_FILE, 'utf8'), '{"roots": ["C:\\\\v"], "cardWidth": 3', 'still the broken original');
  // ...a setting somebody changed does.
  state.config.cardWidth = 260;
  saveConfigSoon({ user: true });
  await flushConfig();
  assert.strictEqual(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).cardWidth, 260);
});

test('userSettings keeps only user keys of the right shape', () => {
  const out = userSettings({ roots: ['C:\\'], rootsSeen: {}, cacheNamesV2: true, dwellMs: 1500, dwellMs2: 1, sort: 7, homeFolders: ['a'], labelColours: [], facetColours: { models: '' }, lastDir: 'C:\\x' });
  assert.deepStrictEqual(out, { dwellMs: 1500, homeFolders: ['a'], facetColours: { models: '' }, lastDir: 'C:\\x' });
  assert.deepStrictEqual(userSettings(null), {});
  assert.deepStrictEqual(userSettings('x'), {});
});
