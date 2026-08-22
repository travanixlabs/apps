'use strict';

/**
 * Just enough XLSX to read a sheet: unzip with zlib, pull sharedStrings and the
 * cell grid out of the XML by hand.
 *
 * No dependency, in keeping with the rest of this app — and an .xlsx is a zip of
 * XML, both of which Node's standard library already handles.
 */

const fs = require('fs');
const zlib = require('zlib');

/** Every entry in a zip, by name, decompressed. */
function unzip(file) {
  const buf = fs.readFileSync(file);
  const out = new Map();
  const SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

  let at = 0;
  for (;;) {
    at = buf.indexOf(SIG, at);
    if (at < 0) break;
    const method = buf.readUInt16LE(at + 8);
    let compressed = buf.readUInt32LE(at + 18);
    let uncompressed = buf.readUInt32LE(at + 22);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.slice(at + 30, at + 30 + nameLen).toString('utf8');
    const dataAt = at + 30 + nameLen + extraLen;

    // Streamed writers set the sizes to zero and put them in a trailing data
    // descriptor; find the next header and work backwards instead.
    if (!compressed) {
      const next = buf.indexOf(SIG, dataAt);
      const end = next < 0 ? findCentralDirectory(buf, dataAt) : next;
      compressed = Math.max(0, end - dataAt - 16);
    }

    const raw = buf.slice(dataAt, dataAt + compressed);
    try {
      out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    } catch {
      // A stored size we guessed wrong; inflate as far as it goes.
      try {
        out.set(name, zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
      } catch { /* skip this entry */ }
    }
    at = dataAt + compressed;
    if (uncompressed === 0 && compressed === 0) at += 1; // never stall
  }
  return out;
}

function findCentralDirectory(buf, from) {
  const at = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), from);
  return at < 0 ? buf.length : at;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, or the others would double-decode
}

/** The shared string table, in index order. */
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    // A string can be split across runs; concatenate every <t> inside the item.
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    return decodeEntities(parts.join(''));
  });
}

/** Column letters to a zero-based index: A -> 0, AA -> 26. */
function columnOf(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Rows of plain strings, from the first worksheet. */
function readSheet(file) {
  const zip = unzip(file);
  const sheetName = [...zip.keys()].find((k) => /^xl\/worksheets\/sheet1\.xml$/.test(k));
  if (!sheetName) throw new Error('no worksheet in ' + file);
  const strings = sharedStrings((zip.get('xl/sharedStrings.xml') || '').toString('utf8'));
  const xml = zip.get(sheetName).toString('utf8');

  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
      const type = (attrs.match(/t="(\w+)"/) || [])[1] || 'n';
      const body = cell[2];

      let value = '';
      if (type === 's') {
        const index = Number((body.match(/<v>(\d+)<\/v>/) || [])[1]);
        value = strings[index] || '';
      } else if (type === 'inlineStr') {
        value = decodeEntities((body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      } else {
        value = decodeEntities((body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      }
      const at = ref ? columnOf(ref) : cells.length;
      cells[at] = value;
    }
    rows.push([...cells].map((c) => c === undefined ? '' : c));
  }
  return rows;
}

module.exports = { readSheet, unzip, decodeEntities };
