'use strict';

// The scoring thread over a shared matrix: a full pass, then rows appended in
// place scored on their own, with the rest left as it was.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DIM = 4;
const BANDS = [
  { band: 'strong', score: 0.55, margin: 0.15 },
  { band: 'faint', score: 0.2, margin: 0 },
];
const unit = (...xs) => { const v = new Float32Array(DIM); xs.forEach((x, i) => { v[i] = x; }); return v; };

function matrix(cap) {
  return {
    mat: new Float32Array(new SharedArrayBuffer(cap * DIM * 4)),
    owner: new Int32Array(new SharedArrayBuffer(cap * 4)),
    person: new Int32Array(new SharedArrayBuffer(cap * 4)),
  };
}

function centroids(names, vecs, countOf) {
  const vec = new Float32Array(names.length * DIM);
  const sum = new Float32Array(names.length * DIM);
  vecs.forEach((v, i) => { vec.set(v, i * DIM); sum.set(v, i * DIM); });
  return {
    names, vec, sum, dim: DIM, countOf: Int32Array.from(countOf),
    memberStart: new Int32Array(names.length + 1), memberOwner: new Int32Array(0),
    minVideos: 3, bands: BANDS, refusals: {},
  };
}

test('the thread shares the matrix, scores a full pass, then only the appended rows', { timeout: 20000 }, async () => {
  const worker = new Worker(path.join(__dirname, '..', 'faces-scorer.js'));
  const replies = [];
  const waiting = [];
  worker.on('message', (m) => { const w = waiting.shift(); if (w) w(m); else replies.push(m); });
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => waiting.push(r)));
  try {
    const m = matrix(8);
    // Three videos, one face each: like A, like B, half way between.
    const rows = [unit(1, 0), unit(0, 1), unit(Math.SQRT1_2, Math.SQRT1_2)];
    rows.forEach((v, r) => { m.mat.set(v, r * DIM); m.owner[r] = r; m.person[r] = 0; });
    worker.postMessage({
      type: 'vectors', version: 1, dim: DIM, nRows: 3, nOwners: 3,
      mat: m.mat.subarray(0, 3 * DIM), owner: m.owner.subarray(0, 3), person: m.person.subarray(0, 3),
    });
    assert.strictEqual((await next()).type, 'ready');

    const cast = centroids(['A', 'B'], [unit(1, 0), unit(0, 1)], [5, 5]);
    worker.postMessage({ type: 'score', run: 1, ...cast, changed: null });
    const full = await next();
    assert.strictEqual(full.type, 'scored');
    assert.strictEqual(full.incremental, false, 'the first pass is a full one');
    const byOwner = new Map(full.out);
    assert.strictEqual(byOwner.get(0)[0].name, 'A');
    assert.strictEqual(byOwner.get(0)[0].band, 'strong');
    assert.strictEqual(byOwner.get(1)[0].name, 'B');

    // A fourth video arrives in the shared memory; the thread is told the count.
    m.mat.set(unit(0, 1), 3 * DIM); m.owner[3] = 3; m.person[3] = 0;
    worker.postMessage({ type: 'append', nRows: 4, nOwners: 4 });
    worker.postMessage({ type: 'score', run: 2, ...cast, changed: [] });
    const incr = await next();
    assert.strictEqual(incr.incremental, true, 'same cast: no full pass');
    const after = new Map(incr.out);
    assert.strictEqual(after.get(3)[0].name, 'B', 'the appended row is ranked');
    assert.strictEqual(after.get(3)[0].band, 'strong');
    assert.strictEqual(after.get(0)[0].name, 'A', 'the old rows kept their answer');

    // A moved: her column is redone for every row, old and new alike.
    const moved = centroids(['A', 'B'], [unit(0, 1), unit(0, 1)], [5, 5]);
    worker.postMessage({ type: 'score', run: 3, ...moved, changed: [0] });
    const col = await next();
    assert.strictEqual(col.incremental, true);
    const names3 = new Map(col.out).get(3).map((s) => s.name).sort();
    assert.deepStrictEqual(names3, ['A', 'B'], 'the appended row now matches both');
  } finally {
    await worker.terminate();
  }
});
