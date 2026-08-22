'use strict';

/**
 * Matches the xChina catalogue against the videos on disk, by reference code.
 *
 * The two write the same code differently — `MD-352.mp4` on disk against
 * `MD0352` on the site — so both sides are reduced to letters + a number with
 * leading zeros dropped, plus a part suffix where there is one (`MD-0155-2` is
 * part 2 of that shoot, and the site lists those as `MDSR0013-1` / `-2`).
 *
 * Reports only. Nothing here renames or writes.
 */

const fs = require('fs');
const path = require('path');
const { catalogue } = require('./xchina-parse');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov']);
const ROOTS = (process.env.XCHINA_ROOTS || [0, 1, 2, 3, 4, 5]
  .map((n) => `C:\\Users\\User\\OneDrive\\Folder ${n}`).join(';')).split(';');

/**
 * `MD-352` and `MD0352` both key to `md|352`; `MD-0155-2` to `md|155|2`.
 * Returns null when there is no code-shaped thing in the name at all.
 */
function refKey(raw) {
  if (!raw) return null;
  const text = String(raw).trim();

  // A code in trailing parentheses is where this tool puts one, so it wins over
  // anything the title happens to contain. Without this, `My 18th birthday
  // (MCY0093)` keys as `my|18` on a second pass and can match a different
  // catalogue entry entirely — 23 files were one run away from being renamed to
  // somebody else's title.
  const parens = text.match(/\(([^()]{2,30})\)\s*$/);
  const source = parens ? parens[1] : text;

  // Letters, then digits, then an optional part number. Anything else about the
  // name is ignored, so a title wrapped around the code still matches.
  // The part separator is a hyphen or an underscore, never a space: `MD0316 4p
  // gangbang…` is MD0316 with a title that starts with a number, not part 4.
  const m = source.match(/([A-Za-z]{2,10})\s*[-_ ]?\s*(\d{2,6})(?:[-_](\d{1,2})\b)?/);
  if (!m) return parens ? refKey(text.slice(0, parens.index)) : null;
  const letters = m[1].toLowerCase();
  const number = String(Number(m[2])); // 0352 -> 352
  return m[3] ? `${letters}|${number}|${Number(m[3])}` : `${letters}|${number}`;
}

/**
 * An episode number in the filename must not contradict one in the reference.
 *
 * `TZ-070-EP1` and `TZ-070-EP3` reduce to the same key, since the letters after
 * the number are not a part suffix — so EP1 matched the EP3 entry and would have
 * taken its title, url and cast. Where the reference names no episode there is
 * nothing to contradict: the site puts the episode in the title and distinguishes
 * the files with a part suffix, which the key already carries.
 */
function episodesAgree(base, ref) {
  const mine = (base.match(/\bEP[-_ ]?(\d{1,3})\b/i) || [])[1];
  const theirs = (String(ref).match(/EP[-_ ]?(\d{1,3})/i) || [])[1];
  if (!mine || !theirs) return true;
  return Number(mine) === Number(theirs);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === '$RECYCLE.BIN') continue;
      walk(full, out);
    } else if (VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function build() {
  const entries = catalogue();
  const byKey = new Map();
  const collisions = new Map();
  for (const entry of entries) {
    const key = refKey(entry.ref);
    if (!key) continue;
    if (byKey.has(key)) {
      collisions.set(key, (collisions.get(key) || 1) + 1);
      // Prefer the record that actually names someone.
      const prior = byKey.get(key);
      if (entry.models.length > prior.models.length) byKey.set(key, entry);
      continue;
    }
    byKey.set(key, entry);
  }

  const files = ROOTS.flatMap((root) => walk(root));
  const keys = files.map((file) => refKey(path.basename(file, path.extname(file))));
  const onDisk = new Set(keys.filter(Boolean));

  const matched = [];
  const unmatched = [];
  for (const [index, file] of files.entries()) {
    const base = path.basename(file, path.extname(file));
    const key = keys[index];
    if (!key) { unmatched.push({ file, base, key }); continue; }

    const exact = byKey.get(key);
    if (exact) {
      if (episodesAgree(base, exact.ref)) matched.push({ file, base, key, entry: exact });
      else unmatched.push({ file, base, key });
      continue;
    }

    const bits = key.split('|');

    // A file with no part where the site split the shoot into parts: `MD-0155.mp4`
    // against MD0155-1 and MD0155-2. The unsuffixed file is part 1 by the usual
    // convention — but only when no other file has claimed part 1, since then
    // this one is something else and a guess would be wrong.
    if (bits.length === 2 && byKey.has(`${key}|1`) && !onDisk.has(`${key}|1`)) {
      matched.push({ file, base, key, entry: byKey.get(`${key}|1`), via: 'part 1 by convention' });
      continue;
    }

    // The mirror: a file split into parts where the site lists the shoot once.
    // The page describes all of it, so the url and the cast are right for every
    // part — the part number stays in the name rather than being thrown away.
    if (bits.length === 3) {
      const bare = byKey.get(`${bits[0]}|${bits[1]}`);
      if (bare) {
        matched.push({ file, base, key, entry: bare, part: Number(bits[2]), via: 'part of a single listing' });
        continue;
      }
    }

    unmatched.push({ file, base, key });
  }
  return { entries, byKey, collisions, files, matched, unmatched };
}

/**
 * `The bride's wedding (MD0352).mp4`, kept legal for Windows.
 *
 * `part` is the file's own part number, passed when the site lists the shoot as
 * one video and this file is a piece of it — `(MD0080-2)` rather than `(MD0080)`,
 * so the pieces keep their order and do not all want one name.
 */
function targetName(entry, ext, part = null) {
  const clean = (entry.title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')       // characters Windows will not take
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');              // a trailing dot or space is invalid
  let ref = (entry.ref || '').trim();
  if (part && !new RegExp(`[-_]${part}$`).test(ref)) ref = `${ref}-${part}`;
  const stem = clean ? `${clean} (${ref})` : ref;
  // Windows tops out at 255 for a filename; leave room for the extension.
  return stem.slice(0, 250 - ext.length).trim() + ext;
}

module.exports = { build, refKey, targetName, walk, episodesAgree };

if (require.main === module) {
  const { entries, byKey, collisions, files, matched, unmatched } = build();
  console.log(`catalogue     : ${entries.length} entries, ${byKey.size} distinct reference keys`);
  if (collisions.size) console.log(`  collisions  : ${collisions.size} keys seen more than once`);
  console.log(`on disk       : ${files.length} videos under ${ROOTS.length} roots`);
  console.log(`matched       : ${matched.length}`);
  console.log(`  with models : ${matched.filter((m) => m.entry.models.length).length}`);
  console.log(`  with title  : ${matched.filter((m) => m.entry.title).length}`);
  console.log(`unmatched     : ${unmatched.length} (${unmatched.filter((u) => !u.key).length} have no code in the name)`);

  console.log('\nwould rename, first 12:');
  for (const m of matched.slice(0, 12)) {
    const ext = path.extname(m.file);
    console.log(`  ${m.base}${ext}`);
    console.log(`    -> ${targetName(m.entry, ext, m.part)}`);
    console.log(`       models: ${m.entry.models.join(', ') || '—'}`);
    console.log(`       url   : ${m.entry.url}`);
  }

  const codedButUnmatched = unmatched.filter((u) => u.key).slice(0, 10);
  if (codedButUnmatched.length) {
    console.log('\nhas a code but no catalogue entry, first 10:');
    for (const u of codedButUnmatched) console.log(`  ${u.base}  (key ${u.key})`);
  }
}
