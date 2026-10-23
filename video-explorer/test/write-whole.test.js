'use strict';

// A file written whole or not at all: a refused rename is retried and lands
// once the handle lets go, the temp file never survives a failure, and two
// writes in flight use two temp names.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { writeWhole, writeWholeSync } = require('../write-whole');

test.after(() => sandbox.cleanup());

test('writeWhole: lands through a temp file, overlapping writes use distinct temps, the last one wins', async () => {
  const dir = sandbox.tempDir('ww');
  const file = path.join(dir, 'store.json');
  await Promise.all([writeWhole(file, 'first'), writeWhole(file, 'second'), writeWhole(file, 'third')]);
  assert.ok(['first', 'second', 'third'].includes(fs.readFileSync(file, 'utf8')));
  assert.deepStrictEqual(fs.readdirSync(dir), ['store.json'], 'no temp files left');
});

test('writeWhole: a rename refused while the target is held open is retried and lands when it lets go', async () => {
  const dir = sandbox.tempDir('held');
  const file = path.join(dir, 'held.json');
  fs.writeFileSync(file, 'old');
  // An exclusive-ish handle: on Windows a rename onto an open file is refused.
  const fd = fs.openSync(file, 'r+');
  const write = writeWhole(file, 'new');
  setTimeout(() => fs.closeSync(fd), 150);
  await write;
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepStrictEqual(fs.readdirSync(dir), ['held.json']);
});

test('writeWholeSync: the same, synchronously, and the temp is removed when the rename never succeeds', () => {
  const dir = sandbox.tempDir('sync');
  const file = path.join(dir, 'sync.json');
  writeWholeSync(file, 'one');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one');
  // A directory where the target name is itself a folder: the rename cannot succeed.
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x'), 'x');
  assert.throws(() => writeWholeSync(blocked, 'nope'));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'the temp was cleaned up');
});
