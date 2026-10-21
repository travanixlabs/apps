'use strict';

// The modules under test now log to the daily file; here that goes to a temp
// folder rather than into the real log on this machine.
process.env.VIDEO_EXPLORER_LOG_DIR = process.env.VIDEO_EXPLORER_LOG_DIR
  || require('node:path').join(require('node:os').tmpdir(), 've-test-logs');

// writeNow's crash safety: when the rename that makes a write land is refused,
// the old file is left whole, the temporary file is cleaned up, and the write is
// tried again shortly -- never written in place.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const library = require('../library.js');

test('a refused rename leaves the old file intact, no temp behind, and a retry scheduled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-crash-test-'));
  const file = path.join(dir, 'library.json');
  const before = JSON.stringify({
    version: 1, ratingScale: 10,
    records: { '1:1': { rating: 4, tags: ['kept'], models: [], name: 'a.mp4', updated: 1 } },
  });
  fs.writeFileSync(file, before);
  process.env.VIDEO_EXPLORER_LIBRARY = file;
  await library.init();

  // library.js holds fs.promises itself, so stubbing the shared object is seen.
  const realRename = fs.promises.rename;
  let refused = 0;
  fs.promises.rename = async () => {
    refused += 1;
    const err = new Error('EPERM: operation not permitted, rename');
    err.code = 'EPERM';
    throw err;
  };
  try {
    library.apply({ size: 1, mtimeMs: 1 }, 'a.mp4', { rating: 9 });
    const result = await library.flush();
    assert.ok(result.deferred, `deferred: ${JSON.stringify(result)}`);
    assert.strictEqual(refused, 5, 'retried five times before giving up for now');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'old file whole');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.writing')), [], 'temp removed');
  } finally {
    fs.promises.rename = realRename;
  }

  // The retry was scheduled (two seconds out): with renames working again it
  // lands on its own, without anybody asking.
  await new Promise((resolve) => { setTimeout(resolve, 2600); });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.records['1:1'].rating, 9, 'the retry wrote the edit');
  assert.deepStrictEqual(after.records['1:1'].tags, ['kept']);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.writing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
