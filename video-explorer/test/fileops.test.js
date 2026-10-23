'use strict';

// The file actions: what a new name is allowed to be, how a clash is
// avoided, and what the action route answers when something is wrong.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { state } = require('../server/config');
const library = require('../library');
const { cleanFileName, renameFile, uniqueDestination, handleAction } = require('../server/fileops');

test.after(() => sandbox.cleanup());

test('cleanFileName: the extension is kept, trailing dots and spaces go, device names and long names are refused', () => {
  const src = 'C:\\v\\old.mp4';
  assert.strictEqual(path.basename(cleanFileName('new', src)), 'new.mp4', 'extension carried over');
  assert.strictEqual(path.basename(cleanFileName('new.mov', src)), 'new.mov', 'an extension given is kept');
  assert.strictEqual(path.basename(cleanFileName('new. ', src)), 'new.mp4', 'trailing dot and space dropped');
  assert.strictEqual(path.basename(cleanFileName('a<b>c:d', src)), 'a_b_c_d.mp4', 'refused characters replaced');
  for (const bad of ['CON', 'con.mp4', 'NUL', 'COM1', 'lpt9.mov', 'Aux']) {
    assert.throws(() => cleanFileName(bad, src), /reserves/, bad);
  }
  assert.throws(() => cleanFileName('x'.repeat(300), src), /too long/);
  assert.throws(() => cleanFileName('', src), /Invalid/);
  assert.throws(() => cleanFileName('...', src), /Invalid/);
});

test('uniqueDestination suffixes (2), (3) rather than clobbering', async () => {
  const dir = sandbox.tempDir('uniq');
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'a (2).mp4'), 'x');
  assert.strictEqual(await uniqueDestination(dir, 'a.mp4'), path.join(dir, 'a (3).mp4'));
  assert.strictEqual(await uniqueDestination(dir, 'b.mp4'), path.join(dir, 'b.mp4'));
});

test('renameFile: a clash is refused, a case-only rename is allowed', async () => {
  const dir = sandbox.tempDir('ren');
  const a = sandbox.video(dir, 'a.mp4').path;
  sandbox.video(dir, 'b.mp4');
  await assert.rejects(renameFile(a, 'b'), /already exists/);
  const upper = await renameFile(a, 'A.mp4');
  assert.strictEqual(path.basename(upper), 'A.mp4');
  assert.ok(fs.existsSync(upper));
});

test('handleAction: unauthorised source refused, unknown op is an error entry, a move into its own folder is refused', async () => {
  await library.init(sandbox.home);
  const root = sandbox.tempDir('act');
  const other = sandbox.tempDir('elsewhere');
  const v = sandbox.video(root, 'c.mp4');
  state.config.roots = [root];
  state.config.homeDir = sandbox.home;
  state.config.recentDests = [];

  await assert.rejects(handleAction({ op: 'rename', paths: [path.join(other, 'x.mp4')], newName: 'y' }),
    (err) => err.statusCode === 403);

  const unknown = await handleAction({ op: 'explode', paths: [v.path] });
  assert.strictEqual(unknown.length, 1);
  assert.strictEqual(unknown[0].ok, false);
  assert.match(unknown[0].message, /Unknown operation/);

  const same = await handleAction({ op: 'move', paths: [v.path], dest: root });
  assert.strictEqual(same[0].ok, false);
  assert.match(same[0].message, /Already in that folder/);

  const nowhere = await handleAction({ op: 'move', paths: [v.path], dest: other });
  assert.strictEqual(nowhere[0].ok, false, 'a folder nobody chose in the app is not a destination');
  assert.match(nowhere[0].message, /not a folder chosen/);

  const renamed = await handleAction({ op: 'rename', paths: [v.path], newName: 'd' });
  assert.strictEqual(renamed[0].ok, true);
  assert.ok(fs.existsSync(path.join(root, 'd.mp4')));
});
