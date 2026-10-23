'use strict';

/**
 * The duplicates and framing sweeps: their switches, and the sets of copies.
 * (The face sweep's routes are in api/faces.js with the rest of the faces.)
 */

const dupes = require('../../dupes');
const framing = require('../../framing');
const { authoriseOrThrow } = require('../config');
const { statWithCloud } = require('../files');
const { describeVideo } = require('../walk');
const { sendJson } = require('../http');

module.exports = () => [
  // Polled by the native host's tray tooltip; the page reads /api/status.
  ['GET', '/api/dupes/status', async ({ res }) => sendJson(res, 200, dupes.status())],
  ['GET', '/api/framing/status', async ({ res }) => sendJson(res, 200, framing.status())],

  ['POST', '/api/dupes/enabled', async ({ res, body }) => {
    return sendJson(res, 200, dupes.setEnabled((await body()).enabled !== false));
  }],
  ['POST', '/api/framing/enabled', async ({ res, body }) => {
    return sendJson(res, 200, framing.setEnabled((await body()).enabled !== false));
  }],

  // Every video that is one of several copies, wherever it lives. The
  // grouping asks for this so a set split across folders is still a set.
  ['GET', '/api/dupes/files', async ({ res }) => {
    // Sets heal before they are handed over, not after the listing has drawn
    // half of one.
    await dupes.prune();
    const seen = new Set();
    const files = [];
    for (const member of dupes.members()) {
      if (seen.has(member.path)) continue;
      seen.add(member.path);
      try {
        const full = authoriseOrThrow(member.path);
        const { stat, cloudOnly } = await statWithCloud(full);
        // The key is size and modified time, so a file edited since it was
        // read is a different video now and does not belong to this set.
        if (dupes.keyFor(stat) !== member.key) continue;
        files.push(describeVideo({
          path: full, size: stat.size, mtimeMs: stat.mtimeMs, cloudOnly,
        }, null));
      } catch { /* moved, deleted, or outside the opened roots */ }
    }
    return sendJson(res, 200, { files });
  }],

  // Not a duplicate after all. Named by any one of its members, since the
  // page is holding videos rather than the set's own identity.
  ['POST', '/api/dupes/dismiss', async ({ res, body }) => {
    const raw = String((await body()).path || '');
    if (!raw) return sendJson(res, 400, { error: 'Which video?' });
    try {
      const target = authoriseOrThrow(raw);
      const { stat } = await statWithCloud(target);
      const out = dupes.dismissGroup(dupes.keyFor(stat));
      if (!out.copies) return sendJson(res, 404, { error: 'That video is not in a set of copies' });
      return sendJson(res, 200, { ...out, status: dupes.status() });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }],

  ['POST', '/api/dupes/restore', async ({ res, body }) => {
    const asked = await body();
    const out = dupes.restoreDismissed(asked.signature ? String(asked.signature) : '');
    return sendJson(res, 200, { ...out, status: dupes.status() });
  }],
];
