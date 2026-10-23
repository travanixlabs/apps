'use strict';

/**
 * Familiar faces: where a video stands, who it looks like, the pictures
 * behind a suggestion, and the sweep's switch.
 */

const fsp = require('fs').promises;
const path = require('path');

const faces = require('../../faces');
const { authoriseOrThrow } = require('../config');
const { isCloudOnly } = require('../files');
const { describeVideo } = require('../walk');
const { sendJson } = require('../http');

const sendPng = (res, png) => {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.length,
    'Cache-Control': 'private, max-age=86400',
  });
  return res.end(png);
};

module.exports = () => [
  // Polled by the native host's tray tooltip; the page reads /api/status.
  ['GET', '/api/faces/status', async ({ res }) => sendJson(res, 200, faces.status())],

  // Pausing is a preference, not a setting worth persisting: the sweep should
  // start again next launch, since that is what "backfill while open" means.
  ['POST', '/api/faces/enabled', async ({ res, body }) => {
    return sendJson(res, 200, faces.setEnabled((await body()).enabled !== false));
  }],

  // Where one video stands: read or not, and what came closest if nothing
  // cleared the bar. Asked when the player opens rather than carried with
  // every listing entry.
  ['GET', '/api/faces/standing', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    return sendJson(res, 200, faces.standing(await fsp.stat(target)));
  }],

  // One video's suggestions in full -- margin, runner-up, her video count --
  // which the listing leaves out (see listedSuggestion in walk.js).
  ['GET', '/api/faces/suggested', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const stat = await fsp.stat(target);
    return sendJson(res, 200, { suggested: faces.decorate(stat).suggested || [] });
  }],

  // Other videos holding the same face. Not a name -- the same face -- so
  // it answers for the uncredited majority of the library as well.
  ['GET', '/api/faces/similar', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const stat = await fsp.stat(target);
    const found = faces.similar(
      stat,
      Number(url.searchParams.get('limit') || 12),
      Number(url.searchParams.get('offset') || 0),
    );
    const videos = [];
    for (const row of found.videos) {
      // The sweep's note of where this was can be a quarter of an hour old.
      // Stat it: gone, and it is not offered; different file at that path,
      // and it is a different video wearing the name of this one.
      let at;
      try { at = await fsp.stat(row.path); } catch { faces.forgetPath(row.key); continue; }
      if (faces.keyFor(at) !== row.key) { faces.forgetPath(row.key); continue; }
      videos.push({
        ...describeVideo({
          path: row.path, size: at.size, mtimeMs: at.mtimeMs, cloudOnly: isCloudOnly(at),
        }, ''),
        // The key addresses the face crop saved when it was profiled, which
        // is the picture of last resort for a video no poster can be had for.
        key: row.key,
        score: row.score,
        band: row.band,
        person: row.person,
        mine: row.mine,
      });
    }
    return sendJson(res, 200, { ...found, videos });
  }],

  // A picture for each named performer: her video that most resembles this
  // one. What turns a row of names into a row of thumbnails.
  ['GET', '/api/faces/best', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const stat = await fsp.stat(target);
    const names = String(url.searchParams.get('models') || '')
      .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);
    const picked = faces.bestOf(stat, names);
    const out = {};
    for (const [name, row] of Object.entries(picked)) {
      // Same guard as /similar: a picture of the wrong video is worse than
      // no picture.
      let at;
      try { at = await fsp.stat(row.path); } catch { faces.forgetPath(row.key); continue; }
      if (faces.keyFor(at) !== row.key) { faces.forgetPath(row.key); continue; }
      out[name] = { ...row, name: path.basename(row.path), cloudOnly: isCloudOnly(at) };
    }
    return sendJson(res, 200, { best: out });
  }],

  // A performer's other faces, to hold the suggested one up against.
  ['GET', '/api/faces/lineup', async ({ res, url }) => {
    // With a video, hers are ranked by how like that video's face they are.
    let against = null;
    const from = url.searchParams.get('path');
    if (from) {
      const stat = await fsp.stat(authoriseOrThrow(from));
      const person = url.searchParams.get('person');
      against = { key: faces.keyFor(stat), person: person === null || person === '' ? null : Number(person) };
    }
    return sendJson(res, 200, faces.lineup(
      url.searchParams.get('model') || '',
      Number(url.searchParams.get('limit') || 8),
      against,
    ));
  }],

  // One of those, by key. Keyed rather than pathed because a lineup shows
  // other videos, which may since have been renamed or freed up -- and this
  // is our own crop, not any part of a file.
  ['GET', '/api/faces/crop', async ({ res, url }) => {
    const png = await faces.faceImageByKey(
      url.searchParams.get('key') || '',
      Number(url.searchParams.get('person') || 0),
    );
    if (!png) return sendJson(res, 404, { error: 'no face stored' });
    return sendPng(res, png);
  }],

  // The face a suggestion was made from, so a name can be checked against a
  // picture rather than taken on trust.
  ['GET', '/api/faces/face', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const stat = await fsp.stat(target);
    const png = await faces.faceImage(stat, Number(url.searchParams.get('person') || 0));
    if (!png) return sendJson(res, 404, { error: 'no face stored for this video' });
    return sendPng(res, png);
  }],
];
