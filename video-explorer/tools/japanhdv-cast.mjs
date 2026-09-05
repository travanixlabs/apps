/* Fetches the Japan HDV cast, keyed by the token its own filenames carry.
 *
 *   node tools/japanhdv-cast.mjs          fetch, then write japanhdv-cast.json
 *   node tools/japanhdv-cast.mjs --check  just say how many pages there are
 *
 * The other four studios in this library could be read off their filenames.
 * This one cannot: the title runs straight into the cast with the same
 * underscore between every word, titles run one to nine words, casts nought to
 * fourteen, and 75 of the 563 titles appear exactly once so there is nothing to
 * learn the split from. Guessing was measured and it is not good enough -- it
 * reads "Anal Fuck Reiko Kobayakawa" as the title "Anal", and "Black Magic Ward"
 * as a cast.
 *
 * So the site is asked instead, and it answers structurally rather than in
 * prose. Every video card on the listing carries a thumbnail whose path is
 *
 *     content/videos/Cheating_Wife_Aihara_Miho/scene1/02.jpg
 *
 * which is the filename's own token and scene, exactly -- the file on disk is
 * japanhdv_Cheating_Wife_Aihara_Miho_scene1_hd.mp4. The join is string equality,
 * with nothing left to infer. Beside it sits an act_list naming every performer
 * in that scene, so a four-woman video needs no guessing about where one name
 * ends and the next begins.
 *
 * 51 listing pages rather than 684 model pages: fewer requests for the same
 * answer, and the cast comes per scene rather than per woman. Sequential, with a
 * pause between, because there is no hurry and it is their server.
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1));
const OUT = path.join(HERE, 'japanhdv-cast.json');
const ROOT = 'https://japanhdv.com/japan-porn/';
const PAUSE = 500;
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url, tries = 3) {
  for (let i = 1; i <= tries; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': AGENT } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === tries) throw err;
      // Backing off rather than hammering: a server that just refused is not
      // helped by being asked again immediately.
      await wait(PAUSE * 4 * i);
    }
  }
  return null;
}

const decode = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .trim();

/**
 * The cards on one listing page.
 *
 * Split on the thumbnail wrapper so each chunk holds one card and its own
 * act_list -- reading the page as a whole would pair the first token with the
 * last cast.
 */
function cards(html) {
  const out = [];
  for (const chunk of html.split('<div class="thumb"').slice(1)) {
    const at = /content\/videos\/([A-Za-z0-9_\-]+)\/scene(\d+)\//.exec(chunk);
    if (!at) continue;
    const cast = [...chunk.matchAll(/rel="tag"[^>]*>([^<]+)</g)]
      .map((m) => decode(m[1]))
      .filter(Boolean);
    out.push({
      token: at[1],
      scene: Number(at[2]),
      cast: [...new Set(cast)],
      title: decode((/<h3 class="title_desc">([^<]*)</.exec(chunk) || [])[1] || ''),
      url: (/href="(https:\/\/japanhdv\.com\/[a-z0-9-]+\/)"/.exec(chunk) || [])[1] || '',
    });
  }
  return out;
}

const first = await fetchPage(ROOT);
if (!first) throw new Error('The listing did not answer.');
const last = Math.max(...[...first.matchAll(/japan-porn\/page\/(\d+)/g)].map((m) => +m[1]), 1);
console.log(`listing pages: ${last}`);
if (process.argv.includes('--check')) process.exit(0);

const byToken = new Map();
let seen = 0;
function absorb(html) {
  for (const c of cards(html)) {
    seen += 1;
    const key = `${c.token.toLowerCase()}|${c.scene}`;
    const had = byToken.get(key);
    if (had) {
      for (const n of c.cast) if (!had.cast.includes(n)) had.cast.push(n);
    } else {
      byToken.set(key, c);
    }
  }
}

absorb(first);
console.log(`  page   1/${last}  ${byToken.size} scenes`);
for (let p = 2; p <= last; p += 1) {
  await wait(PAUSE);
  const html = await fetchPage(`${ROOT}page/${p}/`);
  if (!html) { console.log(`  page ${String(p).padStart(3)}/${last}  gone`); continue; }
  absorb(html);
  console.log(`  page ${String(p).padStart(3)}/${last}  ${byToken.size} scenes`);
}

const scenes = [...byToken.values()];
const people = new Set();
for (const s of scenes) for (const n of s.cast) people.add(n);

fs.writeFileSync(OUT, `${JSON.stringify({
  fetched: new Date().toISOString(),
  source: ROOT,
  pages: last,
  scenes,
}, null, 2)}\n`);

console.log(`\ncards read : ${seen}`);
console.log(`scenes     : ${scenes.length}`);
console.log(`performers : ${people.size}`);
console.log(`no cast    : ${scenes.filter((s) => !s.cast.length).length}`);
console.log(`written    : ${OUT}`);
