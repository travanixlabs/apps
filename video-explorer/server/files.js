'use strict';

/**
 * The filesystem as the server sees it: drives, folders, whether a file is a
 * cloud placeholder, the walk that finds every video under a folder, and the
 * Recycle Bin. No knowledge of labels, previews or listings.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { exists, run } = require('./util');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);

// -------------------------------------------------------------- filesystem

async function listDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = String.fromCharCode(code) + ':\\';
    if (await exists(root)) drives.push(root);
  }
  return drives;
}

async function listDirs(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
    dirs.push({ name: entry.name, path: path.join(dir, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return dirs;
}

const SKIP_DIRS = new Set(['.cache', 'node_modules', 'system volume information', '$recycle.bin']);

/**
 * OneDrive "Files On-Demand" placeholders report their full logical size but
 * allocate no blocks on disk. Reading one byte makes Windows download the whole
 * file, so anything that touches pixels must check this first — a 28k-file
 * library is ~4.7TB and would never fit locally.
 */
// One definition, in walk-rules.js, so the shared tree walk agrees with the
// listing about what a placeholder is.
const { isCloudOnly } = require('../walk-rules');

async function statWithCloud(file) {
  const stat = await fsp.stat(file);
  return { stat, cloudOnly: isCloudOnly(stat) };
}

function shouldSkipDir(name) {
  // Dot-folders are metadata by convention, and one of them is ours: the
  // ratings file lives in .video-explorer at the sync root.
  return name.startsWith('$') || name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Sixty-four stats at once, not one. A stat is a round trip into the
 * filesystem, and a scan of the library root makes twenty-seven thousand of
 * them: one at a time that wait dominates the scan, and it dominates it worst
 * exactly when a sweep has the disk busy. Measured on this machine's sweeps,
 * the same batching made an identical walk 2.9x faster.
 */
const SCAN_STAT_BATCH = 64;

async function statAll(files) {
  const out = new Map();
  for (let i = 0; i < files.length; i += SCAN_STAT_BATCH) {
    const batch = files.slice(i, i + SCAN_STAT_BATCH);
    const got = await Promise.all(batch.map((f) => fsp.stat(f).catch(() => null)));
    got.forEach((stat, j) => { if (stat) out.set(batch[j], stat); });
  }
  return out;
}

/**
 * Walks everything under `dir` collecting video paths + cheap stats. No
 * ffprobe here — probing is the expensive step and only the files we
 * actually display get probed.
 */
async function collectVideos(dir) {
  const videos = [];
  const seen = new Set();

  const isVideo = (entry) => entry.isFile()
    && VIDEO_EXT.has(path.extname(entry.name).toLowerCase());

  async function walk(current, depth) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable folder — skip rather than abort the whole scan
    }
    const stats = await statAll(entries.filter(isVideo)
      .map((entry) => path.join(current, entry.name)));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 12 || shouldSkipDir(entry.name)) continue;
        const real = path.resolve(full).toLowerCase();
        if (seen.has(real)) continue; // guard against junction loops
        seen.add(real);
        await walk(full, depth + 1);
      } else if (isVideo(entry)) {
        const stat = stats.get(full); // vanished between readdir and stat — ignore
        if (!stat) continue;
        videos.push({
          path: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          cloudOnly: isCloudOnly(stat),
        });
      }
    }
  }

  await walk(dir, 0);
  return videos;
}

/** Windows Recycle Bin, so a misclick is always recoverable. */
/**
 * To the Recycle Bin, via the one Windows API that puts things there.
 *
 * The path travels in the environment rather than inside the command, because
 * a filename is data and a command is code and the two must not be mixed. This
 * was learnt from "Clean Yuan\u2019s high-end scrotum care (MPG0144).mp4",
 * which could not be deleted at all: PowerShell treats the typographic
 * apostrophe U+2019 as a string delimiter exactly as it treats the plain one,
 * so the path ended early and the remainder was parsed as code.
 *
 * Doubling quotes would not have been enough -- U+2018, U+2019, U+201C and
 * U+201D all close a string, and a library of scraped filenames contains all of
 * them. Reading $env: parses nothing, so there is nothing left to get wrong.
 */
/**
 * Any number of targets through ONE shell, not one shell each.
 *
 * Spawning PowerShell costs a third of a second before it deletes anything, so
 * a twenty-file selection was twenty of those in a row. The paths travel in a
 * temp FILE rather than the environment -- five thousand of them (the legacy
 * cache cleanup's worth) would blow the environment block -- written with a
 * BOM so the scraped-filename Unicode reads back exactly. Results come back by
 * LINE NUMBER, not by name: the console codepage mangles those same filenames
 * on the way out, and an index cannot be mangled.
 *
 * Returns path -> { ok, message }. A missing entry means the shell itself
 * failed, which the caller reports per file.
 */
async function recycle(targets) {
  const list = Array.isArray(targets) ? targets : [targets];
  const results = new Map();
  if (!list.length) return results;

  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic;',
    '$lines = [System.IO.File]::ReadAllLines($env:VIDEO_EXPLORER_DELETE_LIST);',
    'for ($i = 0; $i -lt $lines.Length; $i++) {',
    "  $p = $lines[$i]; if ($p -eq '') { continue }",
    '  try {',
    '    if (Test-Path -LiteralPath $p -PathType Container) {',
    "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '    } else {',
    "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    '    }',
    "    [Console]::Out.WriteLine('OK ' + $i)",
    '  } catch {',
    "    [Console]::Out.WriteLine('ERR ' + $i + ' ' + $_.Exception.Message.Replace([char]10, ' ').Replace([char]13, ' '))",
    '  }',
    '}',
  ].join(' ');

  // Bounded batches: one shell per thousand keeps any single run answerable,
  // and the cleanup sweep can log progress between them.
  const SHELL_BATCH = 1000;
  for (let start = 0; start < list.length; start += SHELL_BATCH) {
    const batch = list.slice(start, start + SHELL_BATCH);
    const listFile = path.join(os.tmpdir(),
      `ve-recycle-${crypto.randomBytes(6).toString('hex')}.txt`);
    try {
      await fsp.writeFile(listFile, '﻿' + batch.join('\n'), 'utf8');
      const { stdout } = await run('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, VIDEO_EXPLORER_DELETE_LIST: listFile } });
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^(OK|ERR) (\d+)(?: (.*))?$/.exec(line.trim());
        if (!m) continue;
        const target = batch[Number(m[2])];
        if (target === undefined) continue;
        results.set(target, { ok: m[1] === 'OK', message: m[3] || '' });
      }
    } finally {
      await fsp.unlink(listFile).catch(() => {});
    }
  }
  return results;
}

module.exports = {
  listDrives, listDirs, isCloudOnly, statWithCloud, shouldSkipDir,
  collectVideos, recycle,
};
