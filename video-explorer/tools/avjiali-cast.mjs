/* Pulls the cast straight from avjiali.com.
 *
 * The saved listing pages carry a title, a url and a reference code, but no
 * performer -- the name is only ever in the prose of the title, where "Miss
 * Xiao Ye Ye" and "Taiwanese babe Xiao Ye Ye" and nothing at all are all
 * possible. The site keeps the real answer on the model pages: one page per
 * performer, each listing every video of hers by reference code. Eighty-one of
 * those covers the whole catalogue, against two hundred and ninety-five video
 * pages for the same information.
 *
 * Fetched one at a time with a pause between, because there is no reason to
 * hammer someone's server for a job that takes a minute either way.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.dirname(new URL(import.meta.url).pathname.slice(1));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let n = 1; n <= tries; n += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (res.ok) return await res.text();
      if (n === tries) throw new Error(`${res.status} ${url}`);
    } catch (err) {
      if (n === tries) throw err;
    }
    await sleep(1500 * n);
  }
  return '';
}

function decode(text) {
  let out = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = out
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    if (out === before) break;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Just the body: the head is a hundred kilobytes of inlined stylesheet. */
function body(html) {
  const at = html.indexOf('<div id="main">');
  return at < 0 ? html : html.slice(at);
}

/** The video cards on any listing page, model page or otherwise. */
function cards(html) {
  const out = [];
  for (const chunk of body(html).split('<div class="thumb-videos').slice(1)) {
    const url = (chunk.match(/href="(https:\/\/avjiali\.com\/[^"]+)"/) || [])[1];
    if (!url) continue;
    out.push({
      url,
      title: decode((chunk.match(/title="([^"]*)"/) || [])[1] || ''),
      ref: (chunk.match(/content\/videos\/([A-Za-z0-9\-_]+)\//) || [])[1] || '',
    });
  }
  return out;
}

const index = await get('https://avjiali.com/chinese-av-models/');
const models = new Map();
for (const m of body(index).matchAll(
  /href="(?:https:\/\/avjiali\.com)?\/model\/([^"/]+)\/"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
  const label = decode(m[2].replace(/<[^>]*>/g, ' '));
  if (label && !models.has(m[1])) models.set(m[1], label);
}
console.log(`${models.size} performers on the index`);

const performers = [];
let n = 0;
for (const [slug, label] of models) {
  n += 1;
  // "Xiao Ye Ye (小夜夜)" -- the Latin name is what the filenames and the rest
  // of the library use, so it is the tag; the Chinese name is kept alongside.
  const parts = label.match(/^(.*?)\s*[（(]([^)）]*)[)）]\s*$/);
  const name = (parts ? parts[1] : label).trim();
  const chinese = parts ? parts[2].trim() : '';

  const seen = new Map();
  for (let page = 1; page <= 20; page += 1) {
    const url = page === 1
      ? `https://avjiali.com/model/${slug}/`
      : `https://avjiali.com/model/${slug}/page/${page}/`;
    let html;
    try { html = await get(url); } catch { break; }
    const found = cards(html);
    const fresh = found.filter((c) => !seen.has(c.url));
    for (const c of found) if (!seen.has(c.url)) seen.set(c.url, c);
    // A page past the end serves the first page again, so a page that adds
    // nothing new is the end of her list.
    if (!fresh.length) break;
    await sleep(400);
  }
  performers.push({ slug, name, chinese, videos: [...seen.values()] });
  console.log(`  ${String(n).padStart(2)}/${models.size}  ${name.padEnd(22)} ${seen.size} videos`);
  await sleep(400);
}

const total = performers.reduce((s, p) => s + p.videos.length, 0);
const refs = new Set(performers.flatMap((p) => p.videos.map((v) => v.ref)));
console.log(`\n${performers.length} performers, ${total} credits, ${refs.size} distinct videos`);

fs.writeFileSync(path.join(OUT, 'avjiali-cast.json'),
  JSON.stringify({ fetched: new Date().toISOString(), performers }, null, 2));
console.log(`wrote ${path.join(OUT, 'avjiali-cast.json')}`);
