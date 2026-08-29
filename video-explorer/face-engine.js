'use strict';

/**
 * Faces, from a video file to a comparable vector.
 *
 * Three steps, none of which knows anything about this app: sample frames with
 * ffmpeg, find and square up the faces (YuNet), turn each one into a vector
 * (ArcFace, or SFace where that is all there is). Two vectors of the same person
 * point the same way, and cosine says how nearly.
 *
 * The models are optional. If onnxruntime or the .onnx files are missing this
 * module reports itself unavailable and the app runs exactly as it did before —
 * a face index is a convenience, never a dependency.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

// The frame size YuNet was exported at. It is fixed, not a preference: feeding
// any other shape throws at session.run.
const W = 640;
const H = 640;
const CROP = 112;
const CROP_BYTES = CROP * CROP * 3;

// Proven on the hold-out set: every 10s, at most 60 frames, at most 24 faces.
// Sixty frames is the memory budget as much as the sampling rate — a raw 640x640
// frame is 1.2MB, and holding a whole film's worth killed the harvest twice.
const HARVEST = { everySeconds: 10, maxFrames: 60, maxFaces: 24 };

/** A face rather than a smear of skin: confident, big enough, and face-shaped. */
const looksLikeAFace = (f) => f.score >= 0.9 && f.w >= 48 && f.h >= 48
  && f.w / f.h > 0.6 && f.w / f.h < 1.6;

let ort = null;
let unavailable = '';
let modelDir = '';
let recogniser = null;

/**
 * The two recognisers, best first.
 *
 * Measured over 258 hold-out videos, 28 performers: ArcFace named the right one
 * outright 96.1% of the time against SFace's 89.9%, and — the reason it wins the
 * default — its wrong answers sit at 0.18 where SFace's sit at 0.49. A library
 * full of performers the index has never seen needs that gap: it is the
 * difference between staying quiet and inventing a name.
 *
 * SFace is kept as the fallback. It is a quarter of the size and three times
 * faster, and 89.9% is not a bad day.
 */
const RECOGNISERS = [
  {
    name: 'arcface',
    file: 'arcface.onnx',
    input: 'input.1',
    output: '683',
    // RGB, scaled to [-1, 1].
    fill: (input, crop, plane) => {
      for (let i = 0; i < plane; i += 1) {
        input[i] = (crop[i * 3 + 0] - 127.5) / 127.5;
        input[plane + i] = (crop[i * 3 + 1] - 127.5) / 127.5;
        input[2 * plane + i] = (crop[i * 3 + 2] - 127.5) / 127.5;
      }
    },
  },
  {
    name: 'sface',
    file: 'sface.onnx',
    input: 'data',
    output: 'fc1',
    // BGR, unnormalised.
    fill: (input, crop, plane) => {
      for (let i = 0; i < plane; i += 1) {
        input[i] = crop[i * 3 + 2];
        input[plane + i] = crop[i * 3 + 1];
        input[2 * plane + i] = crop[i * 3 + 0];
      }
    },
  },
];

/**
 * Loads onnxruntime and locates the models, once.
 *
 * Failure is a state, not an exception: `reason` is shown in the UI so a missing
 * model looks like a missing model rather than a feature that quietly does
 * nothing.
 */
function init(dir) {
  modelDir = dir;
  if (ort || unavailable) return available();
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    ort = require('onnxruntime-node');
    ort.env.logLevel = 'fatal';
  } catch {
    unavailable = 'onnxruntime-node is not installed';
    return available();
  }
  if (!fs.existsSync(path.join(modelDir, 'yunet.onnx'))) {
    unavailable = `yunet.onnx is missing from ${modelDir}`;
    return available();
  }
  recogniser = RECOGNISERS.find((r) => fs.existsSync(path.join(modelDir, r.file))) || null;
  if (!recogniser) {
    unavailable = `no recogniser in ${modelDir} `
      + `(wanted one of ${RECOGNISERS.map((r) => r.file).join(', ')})`;
  }
  return available();
}

function available() {
  return {
    ok: Boolean(ort) && !unavailable,
    reason: unavailable,
    model: recogniser ? recogniser.name : '',
  };
}

// ------------------------------------------------------------------ sessions

const sessions = new Map();
async function session(name, file) {
  if (!sessions.has(name)) {
    sessions.set(name, ort.InferenceSession.create(path.join(modelDir, file)));
  }
  return sessions.get(name);
}

/** Lets the event loop run. Inference is synchronous inside the runtime, and a
 *  video is sixty of them; without this the server stops answering mid-harvest. */
const breathe = () => new Promise((r) => setImmediate(r));

// ----------------------------------------------------------------- detection

/**
 * YuNet's raw heads, decoded.
 *
 * Three strides, each a grid of anchors carrying a class score, an objectness, a
 * box and five landmarks. The score is the geometric mean of the two, and the
 * box and points are offsets in units of the stride — hence the multiplying back.
 */
function decodeYunet(out, width, height) {
  const faces = [];
  for (const stride of [8, 16, 32]) {
    const cls = out[`cls_${stride}`].data;
    const obj = out[`obj_${stride}`].data;
    const box = out[`bbox_${stride}`].data;
    const kps = out[`kps_${stride}`].data;
    const cols = Math.floor(width / stride);
    const rows = Math.floor(height / stride);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
        if (score < 0.6) continue;
        const cx = (c + box[i * 4 + 0]) * stride;
        const cy = (r + box[i * 4 + 1]) * stride;
        const w = Math.exp(box[i * 4 + 2]) * stride;
        const h = Math.exp(box[i * 4 + 3]) * stride;
        const points = [];
        for (let k = 0; k < 5; k += 1) {
          points.push([(c + kps[i * 10 + k * 2]) * stride, (r + kps[i * 10 + k * 2 + 1]) * stride]);
        }
        faces.push({ score, x: cx - w / 2, y: cy - h / 2, w, h, points });
      }
    }
  }
  // Non-maximum suppression, so one face is not reported once per stride.
  faces.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of faces) {
    const overlaps = kept.some((k) => {
      const x1 = Math.max(f.x, k.x);
      const y1 = Math.max(f.y, k.y);
      const x2 = Math.min(f.x + f.w, k.x + k.w);
      const y2 = Math.min(f.y + f.h, k.y + k.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      return inter / (f.w * f.h + k.w * k.h - inter) > 0.3;
    });
    if (!overlaps) kept.push(f);
  }
  return kept;
}

async function detect(rgb, width, height) {
  const s = await session('yunet', 'yunet.onnx');
  // NCHW, BGR, unnormalised — what YuNet was exported expecting.
  const input = new Float32Array(3 * width * height);
  const plane = width * height;
  for (let i = 0; i < plane; i += 1) {
    input[i] = rgb[i * 3 + 2];
    input[plane + i] = rgb[i * 3 + 1];
    input[2 * plane + i] = rgb[i * 3 + 0];
  }
  const out = await s.run({ input: new ort.Tensor('float32', input, [1, 3, height, width]) });
  return decodeYunet(out, width, height);
}

// ----------------------------------------------------------------- alignment

// Where the ArcFace family expects eyes, nose and mouth corners to land in a
// 112x112 crop. Warping to this is what makes two photographs of one person
// comparable; a plain box crop leaves the pose in the embedding.
const TEMPLATE = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

/**
 * The similarity transform (scale, rotation, translation) best mapping the five
 * detected points onto the template — the Umeyama fit, which for a similarity
 * transform is a closed-form 2x2 solve over the centred point sets.
 */
function similarityTransform(points) {
  const n = points.length;
  const mean = (pts, i) => pts.reduce((s, p) => s + p[i], 0) / n;
  const sx = mean(points, 0);
  const sy = mean(points, 1);
  const dx = mean(TEMPLATE, 0);
  const dy = mean(TEMPLATE, 1);

  let a = 0;
  let b = 0;
  let varSrc = 0;
  for (let i = 0; i < n; i += 1) {
    const px = points[i][0] - sx;
    const py = points[i][1] - sy;
    const qx = TEMPLATE[i][0] - dx;
    const qy = TEMPLATE[i][1] - dy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    varSrc += px * px + py * py;
  }
  if (varSrc === 0) return null;
  const scaleCos = a / varSrc;
  const scaleSin = b / varSrc;
  // The inverse map: warping samples the source once per destination pixel.
  const det = scaleCos * scaleCos + scaleSin * scaleSin;
  if (det === 0) return null;
  const ic = scaleCos / det;
  const is = -scaleSin / det;
  return function toSource(x, y) {
    const ux = x - dx;
    const uy = y - dy;
    return [ic * ux - is * uy + sx, is * ux + ic * uy + sy];
  };
}

/** The aligned 112x112 crop, sampled bilinearly from the frame. */
function alignFace(rgb, width, height, face) {
  const toSource = similarityTransform(face.points);
  if (!toSource) return null;
  const out = Buffer.allocUnsafe(CROP_BYTES);
  for (let y = 0; y < CROP; y += 1) {
    for (let x = 0; x < CROP; x += 1) {
      const [fx, fy] = toSource(x + 0.5, y + 0.5);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c += 1) {
        const at = (px, py) => {
          const cx = Math.min(width - 1, Math.max(0, px));
          const cy = Math.min(height - 1, Math.max(0, py));
          return rgb[(cy * width + cx) * 3 + c];
        };
        const top = at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax;
        const bottom = at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax;
        out[(y * CROP + x) * 3 + c] = Math.round(top * (1 - ay) + bottom * ay);
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- embedding

/**
 * One L2-normalised embedding for an aligned crop.
 *
 * The length depends on which recogniser is installed -- 512 for ArcFace, 128
 * for SFace -- which is why the index records the model it was built with: two
 * vectors from different models are not comparable, and mixing them silently
 * would be worse than rebuilding.
 */
async function embed(crop) {
  const s = await session(recogniser.name, recogniser.file);
  const input = new Float32Array(3 * CROP * CROP);
  recogniser.fill(input, crop, CROP * CROP);
  const out = await s.run({
    [recogniser.input]: new ort.Tensor('float32', input, [1, 3, CROP, CROP]),
  });
  return normalise(Float32Array.from(out[recogniser.output].data));
}

/** Which recogniser the vectors in hand were made by. */
const modelName = () => (recogniser ? recogniser.name : '');

function normalise(v) {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i += 1) v[i] /= norm;
  return v;
}

const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
};

function meanOf(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i += 1) out[i] += v[i];
  return normalise(out);
}

// ------------------------------------------------------------------- harvest

/**
 * Every Nth second of a video, as aligned crops with their embeddings.
 *
 * One ffmpeg reading straight through at a low frame rate rather than one seek
 * per sample: seeking cost 150-450ms a frame, and this content needs a lot of
 * frames to turn up a handful of faces. Frames arrive as one continuous rawvideo
 * stream, so they are cut out of the pipe by length rather than by any process
 * boundary.
 *
 * Two faces a frame, not one. A second person in shot is the difference between
 * suggesting one name and suggesting the pair, and the clustering downstream is
 * what tells them apart.
 */
function frames(file, opts, onFrame) {
  const { everySeconds, maxFrames } = { ...HARVEST, ...opts };
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vf', `fps=1/${everySeconds},scale=${W}:${H}:force_original_aspect_ratio=decrease,`
        + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { windowsHide: true });

    const frameBytes = W * H * 3;
    const chunks = [];
    let pending = 0;
    const held = [];
    let stopped = false;
    proc.stdout.on('data', (chunk) => {
      if (stopped) return;
      chunks.push(chunk);
      pending += chunk.length;
      while (pending >= frameBytes && held.length < maxFrames) {
        // Splice exactly one frame out of the queue, so nothing is repeatedly
        // concatenated into an ever-growing buffer.
        const buf = Buffer.allocUnsafe(frameBytes);
        let filled = 0;
        while (filled < frameBytes) {
          const head = chunks[0];
          const take = Math.min(head.length, frameBytes - filled);
          head.copy(buf, filled, 0, take);
          filled += take;
          if (take === head.length) chunks.shift();
          else chunks[0] = head.subarray(take);
        }
        pending -= frameBytes;
        held.push(buf);
      }
      if (held.length >= maxFrames) {
        stopped = true;
        chunks.length = 0;
        pending = 0;
        proc.kill(); // enough sampled; stop decoding the rest of the film
      }
    });
    proc.on('error', () => resolve([]));
    proc.on('close', async () => {
      for (const frame of held) {
        if ((await onFrame(frame)) === false) break;
      }
      resolve();
    });
  });
}

/**
 * A video's faces: aligned crops, each with its embedding.
 *
 * `shouldStop` is polled between frames so a harvest can be abandoned the moment
 * the user starts using the app again, rather than after the current film.
 */
async function facesIn(file, { shouldStop = () => false, maxFaces = HARVEST.maxFaces } = {}) {
  const found = [];
  await frames(file, {}, async (frame) => {
    if (found.length >= maxFaces || shouldStop()) return false;
    let detected;
    try { detected = await detect(frame, W, H); } catch { return true; }
    const good = detected.filter(looksLikeAFace)
      .sort((a, b) => (b.w * b.h) - (a.w * a.h))
      .slice(0, 2); // the two biggest: one video, at most two people worth naming
    for (const face of good) {
      if (found.length >= maxFaces) break;
      const crop = alignFace(frame, W, H, face);
      if (!crop) continue;
      found.push({ crop, vector: await embed(crop), size: Math.round(face.w) });
    }
    await breathe();
    return true;
  });
  return found;
}

// ------------------------------------------------------------------ grouping

/**
 * The faces in one video, split by who they belong to.
 *
 * Agglomerative in the simplest form: walk the crops in order of confidence and
 * either join the group they already resemble or start a new one. Faces of one
 * person across a film sit around 0.6-0.9 apart; two different people sit near
 * 0.4, so the line goes between.
 *
 * This is what makes a second performer nameable, and it is also what keeps the
 * male co-star out of her average — he simply becomes his own group and matches
 * nothing.
 */
function groupFaces(faces, threshold = 0.55) {
  const groups = [];
  for (const face of [...faces].sort((a, b) => b.size - a.size)) {
    let best = null;
    let bestScore = threshold;
    for (const g of groups) {
      const score = cosine(face.vector, g.centre);
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best) {
      best.members.push(face);
      best.centre = meanOf(best.members.map((m) => m.vector));
    } else {
      groups.push({ members: [face], centre: face.vector });
    }
  }
  return groups
    .map((g) => ({
      vector: g.centre,
      faces: g.members.length,
      best: g.members.reduce((a, b) => (b.size > a.size ? b : a)).crop,
    }))
    .sort((a, b) => b.faces - a.faces);
}

// ----------------------------------------------------------------------- png

const crc32 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A 112x112 RGB crop as a PNG.
 *
 * Written by hand because the app has no image library and this is the whole of
 * the format that matters: a header, one deflate stream of filter-0 scanlines,
 * and an end marker. zlib is already in Node.
 */
function cropToPng(crop, size = CROP) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    crop.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  init, available, modelName, facesIn, groupFaces, embed, cosine, meanOf,
  normalise, cropToPng, CROP, CROP_BYTES, HARVEST,
};
