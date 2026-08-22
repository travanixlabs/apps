'use strict';

/**
 * Reads the saved xChina listing pages into one table of
 * { url, ref, models, title, duration }.
 *
 * The pages are the whole source. A spreadsheet built from them by hand used to
 * fill gaps here, and dropping it is what exposed the real gap: a model is an
 * anchor on most cards and a plain div on the rest, and matching only the div
 * left 233 videos looking unnamed. The pages now yield more than the sheet did.
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

/** A cell that is a reference and nothing else. */
function codeLike(text) {
  return /^[A-Za-z0-9][A-Za-z0-9\-_. ]{1,24}$/.test(String(text).trim());
}

/**
 * The reference inside a tag cell: letters, digits, and an optional part number.
 * Returned as written, since that is what ends up in the filename.
 */
function codeIn(text) {
  const m = String(text).match(/\b([A-Za-z]{2,10}[-_ ]?\d{2,6}(?:[-_]\d{1,2})?(?:-[A-Za-z]{1,3})?)\b/);
  return m ? m[1].trim() : '';
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

    // A model is a plain div on some cards and a link to the performer's page on
    // others — the second shape is most of them, and missing it looked like 233
    // videos with no models until the spreadsheet disagreed.
    const models = [...chunk.matchAll(/<(?:div|a)[^>]*class="model-item"[^>]*>([\s\S]*?)<\/(?:div|a)>/g)]
      .map((m) => decode(m[1]))
      .filter(Boolean);

    // Inside .tags: the studio first, then a comment count, the reference, and a
    // duration. Only the reference is a bare code with no icon in it.
    const tags = (chunk.match(/<div class="tags">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
    const cells = [...tags.matchAll(/<div([^>]*)>([\s\S]*?)<\/div>/g)]
      .map((m) => ({ attrs: m[1], html: m[2], text: textOf(m[2]) }));

    const bare = cells.filter((c) => !/<i /.test(c.html) && !/class="empty"/.test(c.attrs) && c.text);
    // The first bare cell is the studio; a reference is one of the ones after it.
    // Taken whole where the cell is nothing but a code — `MTVQ1-15`, `SM-baby`,
    // `MOFY` have no shape in common beyond that — and otherwise pulled out of
    // the cell, since the studio often shares it: `亚洲热 AH003`. Demanding the
    // whole cell match was losing every reference written that way.
    const ref = bare.slice(1)
      .map((c) => (codeLike(c.text) ? c.text : codeIn(c.text)))
      .find(Boolean) || '';
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

function catalogue() {
  return [...fromPages().values()];
}

module.exports = { catalogue, fromPages, parsePage };

if (require.main === module) {
  const all = catalogue();
  console.log(`pages     : ${fs.readdirSync(HERE).filter((f) => f.endsWith('.html')).length}`);
  console.log(`entries   : ${all.length}`);
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
