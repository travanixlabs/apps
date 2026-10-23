'use strict';

/**
 * The pictures and the bytes: preview strips, posters, probed metadata, the
 * video stream itself, and the cache behind them.
 */

const fsp = require('fs').promises;
const path = require('path');

const library = require('../../library');
const dupes = require('../../dupes');
const { exists } = require('../util');
const { authoriseOrThrow } = require('../config');
const { graphStreamInfo, graphStreamUrl, graphThumbnail } = require('../cloud');
const { isCloudOnly, statWithCloud } = require('../files');
const {
  adoptEmbedded, getMeta, thumbCachePath, spriteCachePath, cachedMeta, ensureSprite,
  ensureThumb, clearCache,
} = require('../cache');
const { sendJson, streamVideo } = require('../http');

const sendJpeg = (res, data, extra = {}) => {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': data.length,
    'Cache-Control': 'private, max-age=86400',
    ...extra,
  });
  return res.end(data);
};

module.exports = () => [
  ['GET', '/api/sprite', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const { stat, cloudOnly } = await statWithCloud(target);
    if (cloudOnly
        && url.searchParams.get('allowCloud') !== '1'
        && !(await exists(spriteCachePath(target, stat)))) {
      return sendJson(res, 409, { error: 'cloud-only', cloudOnly: true, size: stat.size });
    }
    // background: the page building strips ahead of time for tiles that
    // scrolled past. Nobody is waiting on those, so they must not take the
    // priority hold -- which parked all three sweeps for every cloud tile
    // on the way down the page. A hover or the player asks without it.
    const background = url.searchParams.get('background') === '1';
    const { file, frames } = await ensureSprite(target, stat, { background });
    return sendJpeg(res, await fsp.readFile(file), { 'X-Sprite-Frames': String(frames) });
  }],

  // Probes only the files a page actually shows, and never a cloud file
  // unless the user explicitly asked for it.
  ['POST', '/api/meta', async ({ res, body }) => {
    const asked = await body();
    const paths = Array.isArray(asked.paths) ? asked.paths.slice(0, 250) : [];
    const allowCloud = asked.allowCloud === true;
    const meta = {};
    await Promise.all(paths.map(async (raw) => {
      try {
        const target = authoriseOrThrow(raw);
        const { stat, cloudOnly } = await statWithCloud(target);
        // Cached metadata is free and outlives dehydration -- always use it.
        const known = cachedMeta(target, stat);
        if (known) {
          meta[raw] = { ...known, cloudOnly };
          return;
        }
        if (cloudOnly && !allowCloud) {
          // Refused the probe, but the fingerprint may still say how long it
          // runs -- which is the whole answer for a library kept in the cloud.
          const secs = dupes.secsFor(stat);
          meta[raw] = { cloudOnly: true, skipped: true, ...(secs ? { duration: secs } : {}) };
          return;
        }
        const probed = await getMeta(target, stat);
        adoptEmbedded(target, stat, probed);
        meta[raw] = { ...probed, cloudOnly, ...library.decorate(stat) };
      } catch (err) {
        meta[raw] = { error: err.message || String(err) };
      }
    }));
    return sendJson(res, 200, { meta });
  }],

  ['GET', '/api/thumb', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const { stat, cloudOnly } = await statWithCloud(target);
    const cachePath = thumbCachePath(target, stat);
    const allowCloud = url.searchParams.get('allowCloud') === '1';

    // Refuse to BUILD locally for a cloud file, but always SERVE one already
    // built -- and before giving up, ask OneDrive for the thumbnail it already
    // has, which costs ~16KB and hydrates nothing.
    if (cloudOnly && !allowCloud && !(await exists(cachePath))) {
      const fromGraph = await graphThumbnail(target);
      if (fromGraph.buffer) {
        await fsp.mkdir(path.dirname(cachePath), { recursive: true });
        await fsp.writeFile(cachePath, fromGraph.buffer);
        return sendJpeg(res, fromGraph.buffer, { 'X-Thumb-Source': 'graph' });
      }
      // Throttled or briefly down is a "come back", not a "there is none":
      // answering 409 for it made a tile blank for the rest of the session.
      if (fromGraph.reason === 'throttled' || fromGraph.reason === 'graph-error') {
        const wait = Number(fromGraph.retryAfter) || 5;
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(wait) });
        return res.end(JSON.stringify({ error: 'thumbnail unavailable', ...fromGraph, retryAfter: wait }));
      }
      return sendJson(res, 409, {
        error: 'cloud-only', cloudOnly: true, size: stat.size, reason: fromGraph.reason,
      });
    }
    return sendJpeg(res, await fsp.readFile(await ensureThumb(target, stat)));
  }],

  // Resolve a cloud file's streaming URL AHEAD of being asked to play it.
  // The answer is cached for 45 minutes, so this is the same lookup /api/video
  // would do -- just paid while the user is still deciding rather than while
  // they watch a black rectangle. Cheap to call and safe to call repeatedly.
  ['GET', '/api/warm', async ({ res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const { stat } = await statWithCloud(target);
    if (!isCloudOnly(stat)) return sendJson(res, 200, { warmed: false, local: true });
    const began = Date.now();
    const info = await graphStreamInfo(target).catch(() => null);
    return sendJson(res, 200, { warmed: Boolean(info), ms: Date.now() - began });
  }],

  ['GET', '/api/video', async ({ req, res, url }) => {
    const target = authoriseOrThrow(url.searchParams.get('path') || '');
    const { cloudOnly } = await statWithCloud(target);
    // Reading a cloud placeholder locally would make Windows download the
    // whole file. Redirect to OneDrive's own range-capable URL instead: the
    // browser streams from the cloud and the placeholder stays empty.
    if (cloudOnly) {
      const streamUrl = await graphStreamUrl(target).catch(() => null);
      if (streamUrl) {
        res.writeHead(302, { Location: streamUrl, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendJson(res, 409, {
        error: 'This file is cloud-only and OneDrive streaming is unavailable. '
          + 'Sign in with: node graph-login.js',
        cloudOnly: true,
      });
    }
    return streamVideo(req, res, target);
  }],

  ['POST', '/api/cache/clear', async ({ res }) => {
    await clearCache();
    return sendJson(res, 200, { ok: true });
  }],
];
