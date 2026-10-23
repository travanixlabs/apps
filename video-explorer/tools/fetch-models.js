#!/usr/bin/env node
'use strict';

/**
 * Fetches the two face models familiar faces needs, into the folder the app
 * reads them from, and checks each against the SHA-256 the app was built
 * and calibrated with. Nothing else downloads them; a fresh machine without
 * this step reports "familiar faces: off (yunet.onnx is missing ...)".
 *
 *   node tools/fetch-models.js            into %LOCALAPPDATA%\video-explorer\face-models
 *   node tools/fetch-models.js --dir X    somewhere else (VIDEO_EXPLORER_FACE_MODELS too)
 *   node tools/fetch-models.js --check    say what is there and whether it matches; fetch nothing
 *
 *   yunet.onnx    OpenCV's YuNet face detector (2023mar), straight from the
 *                 opencv_zoo repository.
 *   arcface.onnx  InsightFace's w600k_r50 ArcFace recogniser, which ships
 *                 inside the buffalo_l model pack (a 288MB zip; the one file
 *                 is taken out of it and the rest discarded).
 *
 * No dependencies: Node's https follows the redirects, PowerShell unpacks the
 * zip. The hashes are the files this app was measured with -- a different
 * ArcFace export is not comparable, and the index records which model built
 * it, so the app would re-profile the library against a new one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const { execFileSync } = require('child_process');

const { FACE_MODEL_DIR } = require('../server/paths');

const MODELS = [
  {
    file: 'yunet.onnx',
    url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    bytes: 232589,
  },
  {
    file: 'arcface.onnx',
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    inZip: 'w600k_r50.onnx',
    sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
    bytes: 174383860,
  },
];

const argv = process.argv.slice(2);
const flag = (name) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? (argv[at + 1] || true) : null; };
const dir = (typeof flag('dir') === 'string' && flag('dir')) || FACE_MODEL_DIR;
const checkOnly = argv.includes('--check');

function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function download(url, to, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 8) { reject(new Error('too many redirects')); return; }
    https.get(url, { headers: { 'User-Agent': 'video-explorer/fetch-models' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, to, hops + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastSaid = 0;
      const out = fs.createWriteStream(to);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total && got - lastSaid > 8 * 1024 * 1024) {
          lastSaid = got;
          process.stdout.write(`\r  ${Math.round((got / total) * 100)}% of ${Math.round(total / 1048576)}MB`);
        }
      });
      res.pipe(out);
      out.on('finish', () => { if (total) process.stdout.write('\r'); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function status(model) {
  const at = path.join(dir, model.file);
  if (!fs.existsSync(at)) return { at, state: 'missing' };
  const st = fs.statSync(at);
  if (st.size !== model.bytes) return { at, state: `present but ${st.size} bytes (expected ${model.bytes})` };
  return { at, state: sha256Of(at) === model.sha256 ? 'ok' : 'present but the hash differs' };
}

async function fetchOne(model) {
  const at = path.join(dir, model.file);
  const tmp = path.join(os.tmpdir(), `ve-model-${process.pid}-${model.inZip ? 'pack.zip' : model.file}`);
  console.log(`fetching ${model.file} from ${model.url}`);
  await download(model.url, tmp);
  let source = tmp;
  if (model.inZip) {
    const unpack = `${tmp}.unpacked`;
    fs.rmSync(unpack, { recursive: true, force: true });
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${tmp.replace(/'/g, "''")}' -DestinationPath '${unpack.replace(/'/g, "''")}' -Force`],
    { stdio: 'inherit', windowsHide: true });
    source = path.join(unpack, model.inZip);
    if (!fs.existsSync(source)) throw new Error(`${model.inZip} was not in the pack`);
  }
  const hash = sha256Of(source);
  if (hash !== model.sha256) {
    throw new Error(`${model.file}: the download's SHA-256 is ${hash}, not the ${model.sha256} this app was measured with -- not installed`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(source, at);
  fs.rmSync(tmp, { force: true });
  if (model.inZip) fs.rmSync(`${tmp}.unpacked`, { recursive: true, force: true });
  console.log(`  ${model.file}: installed at ${at}`);
}

(async () => {
  console.log(`face models in ${dir}`);
  let missing = 0;
  for (const model of MODELS) {
    const s = status(model);
    console.log(`  ${model.file}: ${s.state}`);
    if (s.state !== 'ok') missing += 1;
  }
  if (checkOnly) { process.exit(missing ? 1 : 0); }
  for (const model of MODELS) {
    if (status(model).state === 'ok') continue;
    await fetchOne(model);
  }
  console.log(missing ? 'done -- restart the app to switch familiar faces on' : 'nothing to do');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
