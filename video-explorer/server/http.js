'use strict';

/**
 * The HTTP plumbing: JSON out (gzipped when big), static files, request bodies,
 * ranged video streaming, and the gate that turns away other sites' requests.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

const { PUBLIC_DIR, SHARED_DIR, PORT } = require('./config');

// ------------------------------------------------------------------- server

/**
 * JSON out, compressed when it is big enough to be worth it.
 *
 * A listing of the library root is tens of megabytes of the same few keys over
 * and over, which is what gzip is best at: it comes down to a few megabytes.
 * Even over loopback the page has to receive and buffer every byte, and the
 * WebView does that in another process. Below 64KB the compression costs more
 * than it saves, so small answers go as they are. The work is on the thread
 * pool, so a big listing being compressed does not hold up the requests behind
 * it, and level 4 because past that the time grows much faster than the file
 * shrinks.
 *
 * Whether the page said it accepts gzip is read in the dispatcher and left on
 * `res`, so none of the hundred-odd callers has to pass the request in.
 */
const GZIP_OVER = 64 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (!res.acceptsGzip || payload.length <= GZIP_OVER) {
    headers['Content-Length'] = Buffer.byteLength(payload);
    res.writeHead(status, headers);
    res.end(payload);
    return;
  }
  zlib.gzip(payload, { level: 4 }, (err, zipped) => {
    if (res.headersSent || res.destroyed) return;
    headers.Vary = 'Accept-Encoding';
    if (err) {
      headers['Content-Length'] = Buffer.byteLength(payload);
      res.writeHead(status, headers);
      res.end(payload);
      return;
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = zipped.length;
    res.writeHead(status, headers);
    res.end(zipped);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * The web manifest is the one .json with a type of its own. Every other one --
 * the bookmark icon set, and whatever follows it -- is ordinary JSON, and
 * serving those as a manifest was only ever true of the first .json there was.
 */
function typeFor(target) {
  if (path.basename(target).toLowerCase() === 'manifest.json') {
    return 'application/manifest+json; charset=utf-8';
  }
  return MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(res, relPath, base = PUBLIC_DIR) {
  const target = path.join(base, relPath);
  // With the separator: `public2` would otherwise pass as inside `public`.
  const root = path.resolve(base);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': typeFor(target),
      'Content-Length': data.length,
      // no-store, not no-cache: a revalidating browser can still serve a stale
      // stylesheet from memory cache, which makes UI changes look like they
      // didn't apply. These files are local and tiny.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/**
 * The files the page shares with the server -- shared/facets.js -- which live
 * beside public/ rather than in it. Scripts only: nothing else is in there that
 * a page has any business fetching.
 */
function serveShared(res, route) {
  const name = route.replace(/^\/+shared\/+/, '');
  if (!/^[\w.-]+\.js$/.test(name)) return sendJson(res, 404, { error: 'Not found' });
  return serveStatic(res, name, SHARED_DIR);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        const err = new Error('Request body too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      // A body that is not JSON is the sender's mistake, and a 400 says so --
      // as a 500 it read as the server having broken, and went in the log as one.
      try { resolve(JSON.parse(raw)); } catch {
        const err = new Error('Invalid JSON body');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Range-aware streaming so the inline player can seek without downloading everything. */
async function streamVideo(req, res, file) {
  const stat = await fsp.stat(file);
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    // pipeline, not pipe: when the browser drops the request -- every seek
    // does -- the read stream is destroyed with it, and the file handle goes.
    // pipe() left it open, which kept OneDrive from freeing the file and made
    // a move or delete of the video just played fail as "in use". A read error
    // ends the response instead of landing on the uncaught-exception handler.
    pipeline(fs.createReadStream(file), res, () => {});
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start = match && match[1] ? Number(match[1]) : 0;
  let end = match && match[2] ? Number(match[2]) : stat.size - 1;
  // A suffix range, "bytes=-500": the last 500 bytes, not the first.
  if (match && !match[1] && match[2]) {
    start = Math.max(0, stat.size - Number(match[2]));
    end = stat.size - 1;
  }
  if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    return res.end();
  }
  end = Math.min(end, stat.size - 1);

  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  pipeline(fs.createReadStream(file, { start, end }), res, () => {});
}

/**
 * Whether a request comes from somewhere other than this app's own page.
 *
 * The server is on loopback, but any website open in a browser on this PC can
 * still send it a request -- a form post needs no permission -- and it can
 * move, delete and re-root files. So: the Host must be this server (a page
 * that rebinds its own domain to 127.0.0.1 fails here), and a browser request
 * must say it came from this origin. Browsers always say; the native host and
 * the command-line tools send neither header, and are let through.
 */
const OWN_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function foreignRequest(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (host && !OWN_HOSTS.has(host)) return `host ${host}`;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `${site} request`;
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.replace(/^https?:\/\//i, '').toLowerCase())) return `origin ${origin}`;
  return '';
}

module.exports = {
  sendJson, serveStatic, serveShared, readBody, streamVideo, foreignRequest,
};
