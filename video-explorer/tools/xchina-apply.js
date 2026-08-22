'use strict';

/**
 * Applies the xChina catalogue to the videos on disk: renames each matched file
 * to `Title (REF).mp4`, and writes its models and source URL into the sidecar.
 *
 *   node tools/xchina-apply.js              dry run — prints, changes nothing
 *   node tools/xchina-apply.js --apply      does it, writing an undo manifest
 *   node tools/xchina-apply.js --undo FILE  puts the names back
 *
 * Three things this is careful about:
 *
 * - The app must be closed. The server holds the sidecar in memory and writes it
 *   back on its own schedule, so a tool editing the file underneath it would be
 *   overwritten the next time a rating changed.
 * - A rename is metadata, so a cloud-only placeholder stays a placeholder — this
 *   never pulls bytes down. It does queue a sync per file, which is why the
 *   count is printed before anything moves.
 * - No two files may be renamed onto one name. Several files often share a
 *   reference — the same video downloaded twice, or two episodes filed under one
 *   code — and `fs.renameSync` overwrites the destination silently on Windows.
 *   An earlier version of this tool destroyed 12 files that way. The first file
 *   to claim a name gets it; every other keeps the name it has and is reported.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const library = require('../library');
const { build, targetName } = require('./xchina-match');

const APPLY = process.argv.includes('--apply');
const UNDO_AT = process.argv.indexOf('--undo');
const UNDO_FILE = UNDO_AT >= 0 ? process.argv[UNDO_AT + 1] : null;
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

const ONEDRIVE = process.env.OneDrive || 'C:\\Users\\User\\OneDrive';
const MANIFEST_DIR = path.join(__dirname, 'manifests');

function serverIsUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 4321, path: '/api/config', timeout: 600 },
      (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function undo(file) {
  const moves = JSON.parse(fs.readFileSync(file, 'utf8')).moves || [];

  // A manifest written before the clobber guard can list one target twice. Only
  // one of those files still exists, and there is no telling which name belongs
  // to the bytes that survived, so those are left for a person to sort out.
  const seen = new Map();
  for (const move of moves) seen.set(move.to.toLowerCase(), (seen.get(move.to.toLowerCase()) || 0) + 1);

  let back = 0;
  let missing = 0;
  let ambiguous = 0;
  for (const move of moves.slice().reverse()) {
    if (seen.get(move.to.toLowerCase()) > 1) { ambiguous += 1; continue; }
    if (!fs.existsSync(move.to)) { missing += 1; continue; }
    if (fs.existsSync(move.from)) { missing += 1; continue; }
    fs.renameSync(move.to, move.from);
    back += 1;
  }
  console.log(`undo: ${back} renamed back, ${missing} skipped (already moved or missing)`);
  if (ambiguous) {
    console.log(`      ${ambiguous} left alone: several files were renamed onto one name`);
  }
}

async function main() {
  if (UNDO_FILE) return undo(UNDO_FILE);

  if (APPLY && await serverIsUp()) {
    console.error('Video Explorer is running. Close it first — it owns library.json while it is up.');
    process.exit(1);
  }

  const { matched } = build();
  const work = LIMIT ? matched.slice(0, LIMIT) : matched;

  await library.init(ONEDRIVE);

  const renames = [];
  const labels = [];
  const clashes = [];
  const claimed = new Map(); // lower-cased target -> the file that claimed it

  for (const item of work) {
    const ext = path.extname(item.file);
    const want = targetName(item.entry, ext, item.part);
    const to = path.join(path.dirname(item.file), want);
    const slot = to.toLowerCase();

    if (path.basename(item.file).toLowerCase() === want.toLowerCase()) {
      // Already named this; it owns the name, so nothing else may take it.
      claimed.set(slot, item.file);
    } else if (claimed.has(slot)) {
      clashes.push({ from: item.file, to, held: claimed.get(slot) });
    } else if (fs.existsSync(to)) {
      clashes.push({ from: item.file, to, held: to });
    } else {
      renames.push({ from: item.file, to });
      claimed.set(slot, item.file);
    }
    if (item.entry.models.length || item.entry.url) {
      labels.push({ file: item.file, to, models: item.entry.models, url: item.entry.url });
    }
  }

  console.log(`matched          : ${work.length} files`);
  console.log(`to rename        : ${renames.length}`);
  console.log(`  name clashes   : ${clashes.length} (left alone — see below)`);
  console.log(`to label         : ${labels.length}`);
  console.log(`  with models    : ${labels.filter((l) => l.models.length).length}`);
  console.log(`  with a url     : ${labels.filter((l) => l.url).length}`);

  if (clashes.length) {
    console.log('\nSharing a reference, so only the first keeps the new name:');
    for (const c of clashes.slice(0, 20)) {
      console.log(`  ${path.basename(c.from)}`);
      console.log(`    wanted ${path.basename(c.to)} — held by ${path.basename(c.held)}`);
    }
    if (clashes.length > 20) console.log(`  … and ${clashes.length - 20} more`);
  }

  if (!APPLY) {
    console.log('\nDry run. Nothing was changed. Add --apply to do it.');
    for (const r of renames.slice(0, 5)) {
      console.log(`  ${path.basename(r.from)}\n    -> ${path.basename(r.to)}`);
    }
    return;
  }

  // Labels first: the sidecar is keyed by size + modified time, and a rename
  // changes neither, so the record stays attached either way -- but doing it in
  // this order means an interrupted run leaves labels without renames rather
  // than renames the catalogue can no longer be matched to.
  let labelled = 0;
  for (const item of labels) {
    try {
      const stat = fs.statSync(item.file);
      const patch = { url: item.url };
      if (item.models.length) patch.addModels = item.models;
      library.apply(stat, path.basename(item.to), patch);
      labelled += 1;
    } catch (err) {
      console.error('label failed:', item.file, err.message);
    }
  }
  await library.flush();
  console.log(`labelled         : ${labelled}`);

  let renamed = 0;
  let refused = 0;
  const done = [];
  for (const move of renames) {
    try {
      // Checked again here, not just when the list was built: rename overwrites
      // without complaint, so the existence test has to be the last thing before
      // the move rather than something decided minutes earlier.
      if (fs.existsSync(move.to)) { refused += 1; continue; }
      fs.renameSync(move.from, move.to);
      done.push(move);
      renamed += 1;
    } catch (err) {
      console.error('rename failed:', move.from, err.message);
    }
  }
  if (refused) console.log(`refused          : ${refused} (target appeared while running)`);

  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifest = path.join(MANIFEST_DIR, `xchina-${stamp}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ moves: done }, null, 2));
  console.log(`renamed          : ${renamed}`);
  console.log(`undo manifest    : ${manifest}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
