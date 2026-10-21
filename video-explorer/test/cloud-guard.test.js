'use strict';

// A cloud-only placeholder is never opened as a fallback, and a move or copy
// only lands somewhere chosen in the app.

const os = require('node:os');
const path = require('node:path');
process.env.VIDEO_EXPLORER_LOG_DIR = process.env.VIDEO_EXPLORER_LOG_DIR
  || path.join(os.tmpdir(), 've-test-logs');
// No sign-in here: Graph must be unable to answer, and the real token must
// not be touched.
process.env.GRAPH_TOKEN_FILE = path.join(os.tmpdir(), 've-test-no-token.json');

const test = require('node:test');
const assert = require('node:assert');

const { state } = require('../server/config');
const { cloudSource } = require('../server/cache');
const { authoriseDestination, differentVolume } = require('../server/fileops');

test('cloudSource: a local file reads as itself; a placeholder with no Graph is refused with 409', async () => {
  const local = { size: 1000, blocks: 8 };          // 4KB on disk: hydrated
  const placeholder = { size: 1000, blocks: 0 };    // nothing on disk
  assert.strictEqual(await cloudSource('C:\\x\\a.mp4', local), null);
  await assert.rejects(cloudSource('C:\\x\\a.mp4', placeholder), (err) => err.statusCode === 409 && err.cloudOnly === true);
});

test('authoriseDestination: roots, home, recent destinations and browsed folders only', () => {
  const held = { roots: state.config.roots, homeDir: state.config.homeDir, recentDests: state.config.recentDests };
  const browsed = new Set(state.browsed || []);
  try {
    state.config.roots = ['C:\\Videos'];
    state.config.homeDir = 'C:\\Users\\me\\OneDrive';
    state.config.recentDests = ['D:\\Sorted\\Best'];
    state.browsed = new Set(['e:\\picked']);
    for (const ok of ['C:\\Videos', 'C:\\Videos\\sub\\deeper', 'C:\\Users\\me\\OneDrive\\Folder 1', 'D:\\Sorted\\Best', 'E:\\Picked']) {
      assert.strictEqual(authoriseDestination(ok), path.resolve(ok), ok);
    }
    for (const bad of ['C:\\Videos2', 'D:\\Sorted', 'E:\\Picked\\child', 'C:\\Windows\\System32', '']) {
      assert.throws(() => authoriseDestination(bad), (err) => err.statusCode === 403, bad);
    }
  } finally {
    Object.assign(state.config, held);
    state.browsed = browsed;
  }
});

test('differentVolume: drive letters decide', () => {
  assert.strictEqual(differentVolume('C:\\a\\b.mp4', 'c:\\c'), false);
  assert.strictEqual(differentVolume('C:\\a\\b.mp4', 'D:\\c'), true);
});
