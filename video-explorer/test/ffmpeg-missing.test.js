'use strict';

// ffmpeg that cannot be started is an error, not an empty answer: a sweep
// that wrote "no sound, no faces" for every video while ffmpeg was off PATH
// marked the whole library done, in the stores every machine shares.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-ffmpeg-test-'));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Runs fn with no ffmpeg reachable, and puts PATH back whatever happens. */
async function withoutFfmpeg(fn) {
  const held = process.env.PATH;
  process.env.PATH = tempDir(); // an empty folder: nothing can be started from it
  try { return await fn(); } finally { process.env.PATH = held; }
}

test('dupe-engine: a fingerprint rejects with FFMPEG_MISSING when ffmpeg cannot start', async () => {
  const engine = require('../dupe-engine.js');
  const file = path.join(tempDir(), 'a.mp4');
  fs.writeFileSync(file, 'not a video');
  await withoutFfmpeg(async () => {
    await assert.rejects(engine.fingerprint(file), (err) => err.code === 'FFMPEG_MISSING');
  });
});

test('face-engine: a harvest rejects with FFMPEG_MISSING when ffmpeg cannot start', async () => {
  const engine = require('../face-engine.js');
  const file = path.join(tempDir(), 'a.mp4');
  fs.writeFileSync(file, 'not a video');
  await withoutFfmpeg(async () => {
    await assert.rejects(engine.facesIn(file), (err) => err.code === 'FFMPEG_MISSING');
  });
});

test('dupes: a print with no runtime and no gaps is left out of the index, to be read again', async () => {
  const dupes = require('../dupes.js');
  const root = tempDir();
  // The snapshot lives under LOCALAPPDATA; pointed at the temp root so the
  // real one is neither read nor written.
  const heldLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    const dir = dupes.init({ cacheDir: root, roots: [], home: root });
    const entries = path.join(dir, 'v');
    const good = { gaps: [1, 2, 3], secs: 120, cuts: [5], name: 'good.mp4', path: 'x', at: 1 };
    const empty = { gaps: [], secs: 0, cuts: [], name: 'empty.mp4', path: 'y', at: 1 };
    fs.writeFileSync(path.join(entries, '100_1.json'), JSON.stringify(good));
    fs.writeFileSync(path.join(entries, '200_1.json'), JSON.stringify(empty));
    await dupes.loadIndex();
    assert.strictEqual(dupes.has('100:1'), true, 'a real print is indexed');
    assert.strictEqual(dupes.has('200:1'), false, 'an empty one is not, so the video is queued again');
  } finally {
    process.env.LOCALAPPDATA = heldLocal;
  }
});
