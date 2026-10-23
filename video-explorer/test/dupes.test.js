'use strict';

// The fingerprint store without ffmpeg: the digest read back (singletons
// dropped, missing signals noted), a set set aside and put back by a
// signature that does not depend on key order, a video forgotten out of its
// pair, and a rekey that carries the print.

const sandbox = require('./_sandbox');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dupes = require('../dupes');
const S = dupes.__forTest.state;

const store = path.join(sandbox.home, '.video-explorer');

test.before(() => { dupes.init({ cacheDir: store, roots: [], home: sandbox.home }); });
test.after(() => sandbox.cleanup());

test('loadDigest: a group of one is not a group; a pair with no signals asks to be matched again', async () => {
  fs.writeFileSync(path.join(store, 'dupes', 'duplicates.json'), JSON.stringify({
    groups: [
      [{ key: '1:1', name: 'a.mp4', secs: 10, kinds: { both: true } }, { key: '1:2', name: 'b.mp4', secs: 10, kinds: { both: true } }],
      [{ key: '9:9', name: 'lonely.mp4', secs: 5 }],
      [{ key: '3:1', name: 'c.mp4', secs: 20 }, { key: '3:2', name: 'd.mp4', secs: 20 }],
    ],
    confirmed: [{ a: '1:1', b: '1:2', signals: { both: true } }, { a: '3:1', b: '3:2' }],
    matchedAt: 5,
  }));
  // A stale conflict copy beside it is dropped.
  fs.writeFileSync(path.join(store, 'dupes', 'duplicates-DESKTOP-XYZ.json'), '{}');
  const body = await dupes.loadDigest();
  assert.ok(body);
  assert.strictEqual(S.groups.length, 2, 'the singleton is gone');
  assert.ok(S.light.has('1:1') && S.light.has('3:2'), 'names from the digest fill the light index');
  assert.ok(!S.light.has('9:9'));
  assert.strictEqual(S.needsMatch, true, 'a pair without signals');
  assert.ok(!fs.existsSync(path.join(store, 'dupes', 'duplicates-DESKTOP-XYZ.json')));
  assert.strictEqual(dupes.decorate({ size: 1, mtimeMs: 1 }).duplicate, true);
  assert.strictEqual(dupes.decorate({ size: 1, mtimeMs: 1 }).copies, 2);
  assert.strictEqual(dupes.decorate({ size: 9, mtimeMs: 9 }).duplicate, false);
});

test('dismissGroup and restoreDismissed: the signature is the sorted keys, whichever member names it', () => {
  const byA = dupes.dismissGroup('1:2');
  assert.strictEqual(byA.dismissed, true);
  assert.strictEqual(byA.copies, 2);
  assert.strictEqual(byA.signature, '1:1|1:2');
  const again = dupes.dismissGroup('1:1');
  assert.strictEqual(again.dismissed, false, 'already set aside');
  assert.strictEqual(again.signature, byA.signature);
  assert.strictEqual(dupes.status().groups, 1, 'a dismissed set is not a finding');
  assert.ok(fs.existsSync(path.join(store, 'dupes', 'not-duplicates.json')));
  const back = dupes.restoreDismissed(byA.signature);
  assert.strictEqual(back.restored, 1);
  assert.strictEqual(dupes.status().groups, 2);
  assert.deepStrictEqual(dupes.restoreDismissed(''), { restored: 0, sets: 0 });
});

test('forget dissolves a pair; rekey carries the print and asks for a match', async () => {
  const out = dupes.forget('3:1');
  assert.strictEqual(out.changed, true);
  assert.deepStrictEqual(out.survivors, ['3:2']);
  assert.strictEqual(dupes.decorate({ size: 3, mtimeMs: 2 }).duplicate, false, 'a pair minus one is not a pair');
  assert.strictEqual(S.groups.length, 1);
  assert.deepStrictEqual(dupes.forget('nope'), { changed: false, survivors: [] });

  S.light.set('7:1', { gaps: [1, 2], secs: 30, cuts: 2, name: 'e.mp4' });
  fs.writeFileSync(path.join(store, 'dupes', 'v', '7_1.json'), '{}');
  S.needsMatch = false;
  assert.strictEqual(await dupes.rekey('7:1', '7:2'), true);
  assert.ok(S.light.has('7:2') && !S.light.has('7:1'));
  assert.ok(fs.existsSync(path.join(store, 'dupes', 'v', '7_2.json')));
  assert.strictEqual(S.needsMatch, true);
  assert.strictEqual(await dupes.rekey('7:1', '7:3'), false);
  assert.strictEqual(dupes.secsFor({ size: 7, mtimeMs: 2 }), 30);
});
