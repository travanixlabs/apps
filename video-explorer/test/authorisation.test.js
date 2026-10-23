'use strict';

// What the app may read: a root grants its subtree and nothing beside it, a
// folder above home is narrowed to home, nested roots collapse, and the
// pruning at launch forgets what is gone or unopened for two months -- but
// never the home folder or the folder about to open.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../server/config');
const { state, isAuthorised, clampRoot, collapseRoots, pruneRoots } = config;

test.after(() => sandbox.cleanup());

test('isAuthorised: a root covers its subtree, not a sibling with the same prefix', () => {
  state.config.roots = ['C:\\v'];
  assert.strictEqual(isAuthorised('C:\\v'), true);
  assert.strictEqual(isAuthorised('C:\\v\\a\\b.mp4'), true);
  assert.strictEqual(isAuthorised('c:\\V\\x.mp4'), true, 'case does not matter');
  assert.strictEqual(isAuthorised('C:\\v2\\x.mp4'), false);
  assert.strictEqual(isAuthorised('C:\\'), false);
  state.config.roots = ['D:\\'];
  assert.strictEqual(isAuthorised('D:\\anything\\at\\all.mp4'), true, 'a drive root covers the drive');
  assert.strictEqual(isAuthorised('E:\\x.mp4'), false);
});

test('clampRoot: an ancestor of home stands at home; anything else is itself', () => {
  state.config.homeDir = 'C:\\Users\\me\\OneDrive';
  assert.strictEqual(clampRoot('C:\\Users\\me'), 'C:\\Users\\me\\OneDrive');
  assert.strictEqual(clampRoot('C:\\'), 'C:\\Users\\me\\OneDrive');
  assert.strictEqual(clampRoot('C:\\Users\\me\\OneDrive\\Videos'), 'C:\\Users\\me\\OneDrive\\Videos');
  assert.strictEqual(clampRoot('D:\\Elsewhere'), 'D:\\Elsewhere');
});

test('collapseRoots: nested roots fold into the outer one, duplicates by case fold too', () => {
  state.config.homeDir = 'C:\\Users\\me\\OneDrive';
  const out = collapseRoots(['C:\\Users\\me\\OneDrive\\A\\B', 'C:\\Users\\me\\OneDrive\\A', 'D:\\x', 'd:\\X', 'C:\\Users']);
  assert.deepStrictEqual(out.map((r) => r.toLowerCase()).sort(), ['c:\\users\\me\\onedrive', 'd:\\x']);
});

test('pruneRoots: gone and stale roots are forgotten; home and the folder about to open never are', async () => {
  const home = sandbox.tempDir('home');
  const live = path.join(home, 'Live');
  const stale = path.join(home, 'Stale');
  const other = sandbox.tempDir('other');
  const gone = sandbox.tempDir('gone');
  fs.rmSync(gone, { recursive: true, force: true });
  fs.mkdirSync(live); fs.mkdirSync(stale);
  const old = Date.now() - 90 * 86400000;
  state.config.homeDir = home;
  state.config.lastDir = stale;
  state.config.roots = [live, stale, gone, other];
  state.config.rootsSeen = {
    [live.toLowerCase()]: Date.now(),
    [stale.toLowerCase()]: old,
    [other.toLowerCase()]: old,
    [gone.toLowerCase()]: Date.now(),
  };
  const out = await pruneRoots();
  const kept = state.config.roots.map((r) => r.toLowerCase());
  assert.ok(kept.includes(live.toLowerCase()), 'a folder opened lately is kept');
  assert.ok(kept.includes(stale.toLowerCase()), 'the folder about to open is kept however old its stamp');
  assert.ok(!kept.includes(gone.toLowerCase()), 'a folder that no longer exists is forgotten');
  assert.ok(!kept.includes(other.toLowerCase()), 'a folder unopened for ninety days is forgotten');
  assert.strictEqual(out.gone.length, 1);
  assert.strictEqual(out.stale.length, 1);
  assert.ok(!Object.keys(state.config.rootsSeen).includes(gone.toLowerCase()), 'its timestamp goes too');
});
