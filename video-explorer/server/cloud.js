'use strict';

/**
 * OneDrive over Graph: the streaming URL for a cloud-only file, and the
 * thumbnail OneDrive already has for it. Both exist so a placeholder is never
 * opened -- opening one makes Windows download the whole video.
 */

const { graphLimit, waitFor, sleep } = require('./util');
const { graph, state } = require('./config');

// Files Graph has no thumbnail for, so one 404 isn't retried on every scroll.
const graphMisses = new Set();

/**
 * Streaming URLs are short-lived but a playing <video> issues many range
 * requests. Without caching, every seek would cost a Graph round trip.
 */
const streamUrlCache = new Map(); // lowercased path -> { url, duration, expiresAt }
const STREAM_URL_TTL_MS = 45 * 60 * 1000;

/**
 * The URL to stream this cloud file from, plus its duration where OneDrive
 * knows it -- one Graph call for both, cached together. Fetching the item took
 * ~2.6s on this connection, so the preview strip and playback sharing one
 * lookup matters: whichever asks first pays, the other gets it free.
 */
async function graphStreamInfo(file) {
  if (!graph || !state.ONEDRIVE_ROOT || !graph.isSignedIn()) return null;

  const key = file.toLowerCase();
  const hit = streamUrlCache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit;

  const info = await graph.getStreamInfo(file, state.ONEDRIVE_ROOT);
  if (!info || !info.url) return null;

  const entry = { ...info, expiresAt: Date.now() + STREAM_URL_TTL_MS };
  streamUrlCache.set(key, entry);
  return entry;
}

async function graphStreamUrl(file) {
  const info = await graphStreamInfo(file);
  return info ? info.url : null;
}

/**
 * A poster fetched from OneDrive rather than rendered locally. Costs ~16KB and
 * does NOT hydrate the placeholder, which is the only way to show thumbnails
 * for a cloud-only library without downloading it.
 */
async function graphThumbnail(file) {
  if (!graph || !state.ONEDRIVE_ROOT) return { reason: 'no-onedrive' };
  if (graphMisses.has(file.toLowerCase())) return { reason: 'no-thumbnail' };
  if (!graph.isSignedIn()) return { reason: 'signed-out' };

  // Throttling is not a missing thumbnail. Asking for a whole library's worth
  // at once -- which is what the grid now does -- earns a 429 with a wait on
  // it, and treating that as "this file has no picture" left tiles permanently
  // blank for files OneDrive had a picture for all along.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const buffer = await graphLimit(() => graph.fetchThumbnail(file, state.ONEDRIVE_ROOT));
      if (!buffer || buffer.length === 0) {
        graphMisses.add(file.toLowerCase());
        return { reason: 'no-thumbnail' };
      }
      return { buffer };
    } catch (err) {
      const status = Number(err.statusCode) || 0;
      if (status === 404) {
        graphMisses.add(file.toLowerCase());
        return { reason: 'no-thumbnail' };
      }
      const transient = status === 429 || status === 408 || status >= 500;
      if (!transient) return { reason: 'graph-error', status, error: err.message };
      if (attempt === 2) return { reason: 'throttled', status, retryAfter: waitFor(err) };
      await sleep(waitFor(err, attempt) * 1000);
    }
  }
  return { reason: 'throttled' };
}

module.exports = {
  graphStreamInfo, graphStreamUrl, graphThumbnail,
};
