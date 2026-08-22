'use strict';

/**
 * Reads the saved xChina listing pages into one table of
 * { url, ref, models, title, duration }.
 *
 * The pages are the source of truth here — the spreadsheet was a partial pass
 * over the same HTML — so this parses the HTML and uses the sheet only to fill
 * gaps and to cross-check.
 *
 * Each card looks like:
 *   <div class="item video">
 *     <a href=".../video/id-XXXX.html" title="TITLE">
 *     <div class="title"><a>TITLE</a></div>
 *     <div class="model-container"><div class="model-item">NAME</div>…</div>
 *     <div class="tags"><div>Model Media</div><div><i…>3</div><div>MGL0011</div>
 *                       <div><i class="far fa-clock"></i>36:34</div></div>
 */

const fs = require('fs');
const path = require('path');
const { readSheet } = require('./xlsx');

const HERE = path.join(__dirname, '..', 'en.xchina.co');

/**
 * Entities, twice over: the saved pages carry `&amp;#39;` where the site
 * double-encoded an apostrophe, so one pass leaves `&#39;` sitting in the title.
 */
function decode(text) {
  let out = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = out
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    if (out === before) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Strips tags, for the text of one element. */
function textOf(html) {
  return decode(html.replace(/<[^>]*>/g, ' '));
}

function parsePage(html) {
  const items = [];
  // Cards are siblings, so split on the opening div rather than trying to match
  // balanced tags with a regex.
  const chunks = html.split('<div class="item video">').slice(1);

  for (const chunk of chunks) {
    const url = (chunk.match(/href="(https:\/\/en\.xchina\.co\/video\/id-[^"]+)"/) || [])[1];
    if (!url) continue;

    const title = decode((chunk.match(/title="([^"]*)"/) || [])[1] || '')
      || textOf((chunk.match(/<div class="title">([\s\S]*?)<\/div>/) || [])[1] || '');

    const models = [...chunk.matchAll(/<div class="model-item">([\s\S]*?)<\/div>/g)]
      .map((m) => decode(m[1]))
      .filter(Boolean);

    // Inside .tags: the studio first, then a comment count, the reference, and a
    // duration. Only the reference is a bare code with no icon in it.
    const tags = (chunk.match(/<div class="tags">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
    const cells = [...tags.matchAll(/<div([^>]*)>([\s\S]*?)<\/div>/g)]
      .map((m) => ({ attrs: m[1], html: m[2], text: textOf(m[2]) }));

    const bare = cells.filter((c) => !/<i /.test(c.html) && !/class="empty"/.test(c.attrs) && c.text);
    // The first bare cell is the studio name; a reference is the next one along.
    const ref = (bare.slice(1).find((c) => /^[A-Za-z0-9][A-Za-z0-9\-_. ]{1,24}$/.test(c.text)) || {}).text || '';
    const duration = (cells.find((c) => /fa-clock/.test(c.html)) || {}).text || '';

    items.push({ url, ref, models, title, duration });
  }
  return items;
}

function fromPages() {
  const files = fs.readdirSync(HERE).filter((f) => f.toLowerCase().endsWith('.html'));
  const byUrl = new Map();
  for (const file of files) {
    const html = fs.readFileSync(path.join(HERE, file), 'utf8');
    for (const item of parsePage(html)) {
      // Later pages repeat nothing, but a page saved twice would; keep the
      // richer record either way.
      const prior = byUrl.get(item.url);
      if (!prior || (item.models.length > prior.models.length) || (!prior.ref && item.ref)) {
        byUrl.set(item.url, item);
      }
    }
  }
  return byUrl;
}

function fromSheet() {
  const file = path.join(HERE, 'xChina_video_table.xlsx');
  if (!fs.existsSync(file)) return new Map();
  const rows = readSheet(file);
  const out = new Map();
  for (const row of rows.slice(1)) {
    const [url, ref, models, title] = row.map((c) => (c || '').trim());
    if (!url) continue;
    out.set(url, {
      url,
      ref,
      models: models ? models.split(/[,、]/).map((m) => m.trim()).filter(Boolean) : [],
      title,
      duration: '',
    });
  }
  return out;
}

/** Pages first, sheet filling anything the pages did not carry. */
function catalogue() {
  const pages = fromPages();
  const sheet = fromSheet();
  for (const [url, entry] of sheet) {
    const have = pages.get(url);
    if (!have) { pages.set(url, entry); continue; }
    if (!have.ref && entry.ref) have.ref = entry.ref;
    if (!have.models.length && entry.models.length) have.models = entry.models;
    if (!have.title && entry.title) have.title = entry.title;
  }
  return [...pages.values()];
}

module.exports = { catalogue, fromPages, fromSheet, parsePage };

if (require.main === module) {
  const pages = fromPages();
  const sheet = fromSheet();
  const all = catalogue();
  console.log(`pages     : ${pages.size} entries`);
  console.log(`sheet     : ${sheet.size} entries`);
  console.log(`combined  : ${all.length} entries`);
  console.log(`with ref  : ${all.filter((e) => e.ref).length}`);
  console.log(`with model: ${all.filter((e) => e.models.length).length}`);
  console.log(`with title: ${all.filter((e) => e.title).length}`);
  console.log('');
  for (const e of all.slice(0, 8)) {
    console.log(`${(e.ref || '—').padEnd(12)} ${(e.models.join(', ') || '—').padEnd(28)} ${e.title.slice(0, 46)}`);
  }
  const noRef = all.filter((e) => !e.ref).slice(0, 5);
  if (noRef.length) {
    console.log('\nno reference, e.g.:');
    for (const e of noRef) console.log('  ', e.url, '|', e.title.slice(0, 50));
  }
}
