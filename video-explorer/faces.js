'use strict';

/**
 * Face indexing and similarity search.
 *
 * Two ONNX models: YuNet finds faces and their five landmarks, SFace turns an
 * aligned crop into a 128-d vector. Measured over 100 downloaded videos and 345
 * faces, alignment is what makes this work at all — warping by the landmarks
 * separates same-video pairs from different-video pairs 8:1, where a plain
 * bounding-box crop manages 2.4:1.
 *
 * The output is deliberately a ranking, not a decision. A ~1-in-25 false
 * positive rate is useless for automatic clustering, which is why an earlier
 * attempt collapsed into singletons, but it is perfectly workable for "here are
 * the most similar faces, tick the right ones".
 *
 * Everything stays on this machine: models in LOCALAPPDATA, vectors beside the
 * poster cache. Cloud-only files are never touched, so indexing can never
 * trigger a download.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

let ort = null;
try {
  ort = require('onnxruntime-node');
} catch {
  ort = null; // the feature disables itself rather than breaking the app
}

const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer');
const MODEL_DIR = path.join(DATA_DIR, 'models');

// Pinned by hash: these are the exact files the accuracy above was measured on.
const MODELS = {
  detector: {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  },
  embedder: {
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
  },
};

const S = 640;             // YuNet in this export is fixed-size
const CONF = 0.6;          // sqrt(cls*obj); below this is noise
const MIN_FACE = 40;       // px; smaller faces embed badly and poison a track
const FRAMES = 10;         // samples per video
const TRACK_AT = 0.45;     // within one video, faces this close are one person
const MATCH_AT = 0.363;    // SFace's own same-identity threshold

// Where SFace expects the landmarks to land in a 112x112 crop.
const TEMPLATE = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

// ------------------------------------------------------------------- state

let sessions = null;
let store = { version: 1, videos: {} };
let storeFile = '';
let saveTimer = null;

const job = {
  running: false,
  paused: false,
  done: 0,
  total: 0,
  current: '',
  errors: 0,
  cancel: false,
};

function available() {
  return Boolean(ort);
}

function keyFor(stat) {
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

// ------------------------------------------------------------------ models

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(file));
  return hash.digest('hex');
}

/** Downloads a model once, verifying it against the pinned hash. */
async function ensureModel(spec, onProgress) {
  const target = path.join(MODEL_DIR, spec.file);
  if (fs.existsSync(target) && (await sha256(target)) === spec.sha256) return target;

  await fsp.mkdir(MODEL_DIR, { recursive: true });
  if (onProgress) onProgress(`downloading ${spec.file}`);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(target, buf);

  const got = await sha256(target);
  if (got !== spec.sha256) {
    await fsp.unlink(target).catch(() => {});
    throw new Error('model failed its checksum');
  }
  return target;
}

async function ensureSessions(onProgress) {
  if (sessions) return sessions;
  if (!ort) throw new Error('onnxruntime is not installed');
  const [detPath, embPath] = [
    await ensureModel(MODELS.detector, onProgress),
    await ensureModel(MODELS.embedder, onProgress),
  ];
  if (onProgress) onProgress('loading models');
  sessions = {
    det: await ort.InferenceSession.create(detPath),
    emb: await ort.InferenceSession.create(embPath),
  };
  return sessions;
}

function modelsReady() {
  return Object.values(MODELS).every((m) => fs.existsSync(path.join(MODEL_DIR, m.file)));
}

// ------------------------------------------------------------ image plumbing

const run = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 1 << 26, windowsHide: true },
    (err, stdout, stderr) => (err ? rej(new Error(String(stderr).slice(0, 150))) : res(stdout)));
});

/** Letterboxed, not squashed: a stretched face is a much harder face. */
const PAD = `scale=${S}:${S}:force_original_aspect_ratio=decrease,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2`;

async function grabFrame(file, at) {
  const tmp = path.join(os.tmpdir(), `ve-face-${process.pid}-${Math.round(at)}.raw`);
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', file,
      '-frames:v', '1', '-vf', PAD, '-f', 'rawvideo', '-pix_fmt', 'rgb24', tmp]);
    return await fsp.readFile(tmp);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

function nchw(rgb, w, h) {
  const plane = w * h;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    data[i] = rgb[i * 3];
    data[plane + i] = rgb[i * 3 + 1];
    data[2 * plane + i] = rgb[i * 3 + 2];
  }
  return data;
}

/** Boxes plus the five landmarks, which is what makes alignment possible. */
function decode(out) {
  const all = [];
  for (const stride of [8, 16, 32]) {
    const cls = out['cls_' + stride].data;
    const obj = out['obj_' + stride].data;
    const box = out['bbox_' + stride].data;
    const kps = out['kps_' + stride].data;
    const cols = S / stride;
    for (let i = 0; i < cls.length; i += 1) {
      const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
      if (score < CONF) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const w = Math.exp(box[i * 4 + 2]) * stride;
      const h = Math.exp(box[i * 4 + 3]) * stride;
      if (w < MIN_FACE || h < MIN_FACE) continue;
      const points = [];
      for (let k = 0; k < 5; k += 1) {
        points.push([(c + kps[i * 10 + k * 2]) * stride, (r + kps[i * 10 + k * 2 + 1]) * stride]);
      }
      all.push({ score, w, h, x: (c + box[i * 4]) * stride - w / 2, y: (r + box[i * 4 + 1]) * stride - h / 2, points });
    }
  }

  all.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const face of all) {
    const clash = keep.some((k) => {
      const ix = Math.max(0, Math.min(k.x + k.w, face.x + face.w) - Math.max(k.x, face.x));
      const iy = Math.max(0, Math.min(k.y + k.h, face.y + face.h) - Math.max(k.y, face.y));
      const inter = ix * iy;
      return inter / (k.w * k.h + face.w * face.h - inter) > 0.4;
    });
    if (!clash) keep.push(face);
  }
  return keep.slice(0, 4);
}

/**
 * Least-squares 2D similarity transform onto the template. Closed form: a 2x2
 * SVD would give the same answer with more code.
 */
function transformFor(points) {
  const n = points.length;
  const mean = (pts, i) => pts.reduce((s, p) => s + p[i], 0) / n;
  const mx = mean(points, 0);
  const my = mean(points, 1);
  const mu = mean(TEMPLATE, 0);
  const mv = mean(TEMPLATE, 1);

  let sxx = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = points[i][0] - mx;
    const y = points[i][1] - my;
    const u = TEMPLATE[i][0] - mu;
    const v = TEMPLATE[i][1] - mv;
    sxx += x * x + y * y;
    n1 += x * u + y * v;
    n2 += x * v - y * u;
  }
  if (sxx < 1e-6) return null;
  const a = n1 / sxx;
  const b = n2 / sxx;
  return { a, b, tx: mu - (a * mx - b * my), ty: mv - (b * mx + a * my) };
}

function warp(rgb, t) {
  const out = Buffer.alloc(112 * 112 * 3);
  const det = t.a * t.a + t.b * t.b;
  if (det < 1e-9) return out;
  for (let v = 0; v < 112; v += 1) {
    for (let u = 0; u < 112; u += 1) {
      const du = u - t.tx;
      const dv = v - t.ty;
      const x = (t.a * du + t.b * dv) / det;
      const y = (-t.b * du + t.a * dv) / det;
      const o = (v * 112 + u) * 3;
      if (x < 0 || y < 0 || x >= S - 1 || y >= S - 1) continue;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      for (let ch = 0; ch < 3; ch += 1) {
        const p00 = rgb[(y0 * S + x0) * 3 + ch];
        const p10 = rgb[(y0 * S + x0 + 1) * 3 + ch];
        const p01 = rgb[((y0 + 1) * S + x0) * 3 + ch];
        const p11 = rgb[((y0 + 1) * S + x0 + 1) * 3 + ch];
        out[o + ch] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ vectors

function normalise(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return Float32Array.from(vec, (v) => v / norm);
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

const pack = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');
const unpack = (str) => {
  const buf = Buffer.from(str, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
};

/**
 * Collapses a video's faces into one vector per person. Within a single video
 * the lighting and framing barely change, so this is the easy case — and
 * averaging over frames cancels most of the per-frame noise that made
 * face-to-face comparison unreliable.
 */
function toTracks(vectors) {
  const groups = [];
  for (const vec of vectors) {
    let best = null;
    let bestScore = -1;
    for (const group of groups) {
      const s = similarity(vec, group.centroid);
      if (s > bestScore) { bestScore = s; best = group; }
    }
    if (best && bestScore >= TRACK_AT) {
      best.members.push(vec);
      const c = best.centroid;
      for (let i = 0; i < c.length; i += 1) c[i] += (vec[i] - c[i]) / best.members.length;
      best.centroid = normalise(c);
    } else {
      groups.push({ centroid: Float32Array.from(vec), members: [vec] });
    }
  }
  // A track seen once is usually a bad crop rather than a person, unless it is
  // all the video gave us.
  const solid = groups.filter((g) => g.members.length > 1);
  return (solid.length ? solid : groups).map((g) => ({ vec: g.centroid, seen: g.members.length }));
}

// -------------------------------------------------------------------- store

async function init(cacheDir) {
  storeFile = path.join(cacheDir, 'faces.json');
  try {
    const parsed = JSON.parse(await fsp.readFile(storeFile, 'utf8'));
    if (parsed && parsed.videos) store = parsed;
  } catch {
    store = { version: 1, videos: {} };
  }
  return { count: Object.keys(store.videos).length, available: available(), modelsReady: modelsReady() };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(storeFile, JSON.stringify(store)).catch(() => {});
  }, 1500);
}

function isIndexed(stat) {
  return Boolean(store.videos[keyFor(stat)]);
}

// ------------------------------------------------------------------ indexing

async function indexVideo(file, stat, duration) {
  const { det, emb } = await ensureSessions();
  const vectors = [];

  for (let i = 0; i < FRAMES; i += 1) {
    if (job.cancel) break;
    const at = duration > 0 ? (duration * (i + 1)) / (FRAMES + 1) : 60 * (i + 1);
    let rgb;
    try { rgb = await grabFrame(file, at); } catch { continue; }
    if (rgb.length < S * S * 3) continue;

    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', nchw(rgb, S, S), [1, 3, S, S]) });
    for (const face of decode(out)) {
      const t = transformFor(face.points);
      if (!t) continue;
      const crop = warp(rgb, t);
      const result = await emb.run({
        [emb.inputNames[0]]: new ort.Tensor('float32', nchw(crop, 112, 112), [1, 3, 112, 112]),
      });
      vectors.push(normalise(result[emb.outputNames[0]].data));
    }
  }

  const tracks = toTracks(vectors);
  store.videos[keyFor(stat)] = {
    name: path.basename(file),
    faces: vectors.length,
    tracks: tracks.map((t) => ({ v: pack(t.vec), seen: t.seen })),
    at: Date.now(),
  };
  save();
  return { faces: vectors.length, tracks: tracks.length };
}

/**
 * Works through a list in the background. Concurrency is deliberately one: the
 * app's own ffmpeg pool serves hovers and posters, and a hover that waits
 * behind a queue of frame extractions is the one thing a background job must
 * never cause.
 */
async function startJob(items, { onProgress } = {}) {
  if (job.running) return job;
  Object.assign(job, { running: true, paused: false, cancel: false, done: 0, total: items.length, errors: 0, current: '' });

  (async () => {
    try {
      await ensureSessions((msg) => { job.current = msg; });
      for (const item of items) {
        if (job.cancel) break;
        while (job.paused && !job.cancel) await new Promise((r) => setTimeout(r, 400));
        job.current = path.basename(item.file);
        try {
          await indexVideo(item.file, item.stat, item.duration || 0);
        } catch {
          job.errors += 1;
        }
        job.done += 1;
        if (onProgress) onProgress(job);
      }
    } catch (err) {
      job.current = err.message;
      job.errors += 1;
    } finally {
      job.running = false;
      job.current = '';
      clearTimeout(saveTimer);
      fsp.writeFile(storeFile, JSON.stringify(store)).catch(() => {});
    }
  })();

  return job;
}

const status = () => ({
  ...job,
  indexed: Object.keys(store.videos).length,
  available: available(),
  modelsReady: modelsReady(),
});
const pause = (on) => { job.paused = Boolean(on); return status(); };
const cancel = () => { job.cancel = true; job.paused = false; return status(); };

// ------------------------------------------------------------------- search

/**
 * Ranks every other indexed video against this one, best matching pair of
 * tracks first. Returns raw scores — the caller decides what to show, and the
 * user decides what is true.
 */
function similar(stat, { limit = 60 } = {}) {
  const self = store.videos[keyFor(stat)];
  if (!self) return null;
  const mine = self.tracks.map((t) => unpack(t.v));
  if (!mine.length) return { query: self.name, faces: self.faces, matches: [] };

  const key = keyFor(stat);
  const matches = [];
  for (const [otherKey, entry] of Object.entries(store.videos)) {
    if (otherKey === key) continue;
    let best = -1;
    for (const track of entry.tracks || []) {
      const vec = unpack(track.v);
      for (const own of mine) {
        const s = similarity(own, vec);
        if (s > best) best = s;
      }
    }
    if (best > 0) matches.push({ key: otherKey, name: entry.name, score: best, faces: entry.faces });
  }

  matches.sort((a, b) => b.score - a.score);
  return {
    query: self.name,
    faces: self.faces,
    tracks: mine.length,
    threshold: MATCH_AT,
    matches: matches.slice(0, limit),
  };
}

module.exports = {
  init, available, modelsReady, keyFor, isIndexed,
  indexVideo, startJob, status, pause, cancel, similar,
  MATCH_AT,
};
