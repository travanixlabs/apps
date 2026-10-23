'use strict';

// The two rankings -- the scoring thread over its shared matrix, and the
// in-process rankFaces it falls back to -- give the same answer for the same
// videos: same names, scores, bands, margins, runners-up and faint list, with
// the leave-one-out rule and a refusal applied on both.

process.env.VIDEO_EXPLORER_LOG_DIR = process.env.VIDEO_EXPLORER_LOG_DIR
  || require('node:path').join(require('node:os').tmpdir(), 've-test-logs');
process.env.LOCALAPPDATA = require('node:path').join(require('node:os').tmpdir(), 've-test-local');

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const faces = require('../faces.js');
const engine = require('../face-engine.js');

const DIM = 6;
const unit = (...xs) => {
  const v = new Float32Array(DIM);
  xs.forEach((x, i) => { v[i] = x; });
  return engine.normalise(v);
};
const mix = (a, b, t) => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) v[i] = a[i] * (1 - t) + b[i] * t;
  return engine.normalise(v);
};

test('the thread and the in-process ranking agree on a six-video fixture', { timeout: 20000 }, async () => {
  const A = unit(1, 0, 0);
  const B = unit(0, 1, 0);
  const C = unit(0, 0, 1);
  // Six videos: two clearly A, one clearly B, one between A and B, one C, one
  // with two faces (A and B). Video 0 and 1 are credited to A, 2 to B, 4 to C,
  // so their own vectors are in those averages and must be left out.
  const videos = [
    { key: 'v0', people: [{ vec: mix(A, B, 0.05) }], models: ['Ann'] },
    { key: 'v1', people: [{ vec: mix(A, C, 0.1) }], models: ['Ann'] },
    { key: 'v2', people: [{ vec: mix(B, A, 0.08) }], models: ['Bea'] },
    { key: 'v3', people: [{ vec: mix(A, B, 0.45) }], models: [] },
    { key: 'v4', people: [{ vec: mix(C, A, 0.1) }], models: ['Cat'] },
    { key: 'v5', people: [{ vec: mix(A, C, 0.2) }, { vec: mix(B, C, 0.15) }], models: [] },
  ];
  // v3 has turned Bea down.
  const refusals = { v3: ['bea'] };

  // Averages from the credited videos, as rebuildCentroids builds them.
  const names = ['Ann', 'Bea', 'Cat', 'Dee'];
  const centroids = new Map();
  const credited = (name) => videos.filter((v) => v.models.includes(name));
  for (const name of names) {
    const own = credited(name);
    const sum = new Float32Array(DIM);
    const keys = new Map();
    for (const v of own) {
      for (let i = 0; i < DIM; i += 1) sum[i] += v.people[0].vec[i];
      keys.set(v.key, v.people[0].vec);
    }
    // Dee: four phantom videos nobody here is in, so she passes minVideos.
    const count = name === 'Dee' ? 4 : own.length;
    if (name === 'Dee') for (let i = 0; i < DIM; i += 1) sum[i] = unit(0, 0, 0, 1)[i] * 4;
    centroids.set(name, { vec: engine.normalise(Float32Array.from(sum)), sum, count, keys });
  }
  const opts = { bands: faces.BANDS, minVideos: 1, topK: faces.TOP_K };

  // In process.
  const local = new Map();
  for (const v of videos) {
    const out = faces.rankFaces(v.key, v.people, centroids, new Set(refusals[v.key] || []), opts);
    if (out.length) local.set(v.key, out);
  }

  // The thread, over the same numbers laid out as its matrix.
  const rows = [];
  videos.forEach((v, owner) => v.people.forEach((p, person) => rows.push({ owner, person, vec: p.vec })));
  const mat = new Float32Array(new SharedArrayBuffer(rows.length * DIM * 4));
  const owner = new Int32Array(new SharedArrayBuffer(rows.length * 4));
  const person = new Int32Array(new SharedArrayBuffer(rows.length * 4));
  rows.forEach((r, i) => { mat.set(r.vec, i * DIM); owner[i] = r.owner; person[i] = r.person; });
  const vec = new Float32Array(names.length * DIM);
  const sum = new Float32Array(names.length * DIM);
  const countOf = new Int32Array(names.length);
  const memberStart = new Int32Array(names.length + 1);
  const members = [];
  names.forEach((name, c) => {
    const acc = centroids.get(name);
    vec.set(acc.vec, c * DIM);
    sum.set(acc.sum, c * DIM);
    countOf[c] = acc.count;
    memberStart[c] = members.length;
    for (const key of acc.keys.keys()) members.push(videos.findIndex((v) => v.key === key));
  });
  memberStart[names.length] = members.length;
  const threadRefusals = {};
  for (const [key, list] of Object.entries(refusals)) threadRefusals[videos.findIndex((v) => v.key === key)] = list;

  const worker = new Worker(path.join(__dirname, '..', 'faces-scorer.js'));
  const replies = [];
  const waiting = [];
  worker.on('message', (m) => { const w = waiting.shift(); if (w) w(m); else replies.push(m); });
  const next = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((r) => waiting.push(r)));
  try {
    worker.postMessage({ type: 'vectors', version: 1, dim: DIM, nRows: rows.length, nOwners: videos.length, mat, owner, person });
    assert.strictEqual((await next()).type, 'ready');
    worker.postMessage({
      type: 'score', run: 1, names, vec, sum, countOf, memberStart,
      memberOwner: Int32Array.from(members), dim: DIM,
      minVideos: 1, bands: faces.BANDS, refusals: threadRefusals, changed: null,
    });
    const answer = await next();
    assert.strictEqual(answer.type, 'scored', JSON.stringify(answer));
    assert.deepStrictEqual(answer.short, [], 'nothing left for the fallback');
    const thread = new Map();
    for (const [o, list] of answer.out) thread.set(videos[o].key, list);

    assert.ok(local.size >= 4, `the fixture ranks something: ${local.size}`);
    assert.deepStrictEqual([...thread.keys()].sort(), [...local.keys()].sort(), 'the same videos ranked');
    for (const key of local.keys()) {
      assert.deepStrictEqual(thread.get(key), local.get(key), `video ${key}`);
    }
    assert.ok(!local.get('v3').some((s) => s.name === 'Bea'), 'the refused name is out on both');
    assert.strictEqual(local.get('v5').length >= 2, true, 'two faces, two names');
  } finally {
    await worker.terminate();
  }
});
