'use strict';

/**
 * The request dispatcher: the static files, then the API as a table of
 * [method, path, handler] rows gathered from server/api/*.js, one file per
 * area. A handler gets { req, res, url, body } and answers through sendJson
 * (or writes the response itself); a thrown error with a statusCode is that
 * status, anything else a logged 500.
 */

const http = require('http');

const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');
const framing = require('../framing');

const { log, logFailure } = require('./util');
const { HOST, PORT, flushConfig } = require('./config');
const { flushMeta } = require('./cache');
const {
  sendJson, serveStatic, serveShared, readBody, foreignRequest,
} = require('./http');

/**
 * What the API waits on before answering: the labels, the metadata index and
 * the face engine. The port itself opens long before these are read -- the
 * window should appear at once, and a request that arrives early waits here
 * for the stores instead of being answered from half of them.
 *
 * /api/config is exempt: it needs nothing but the config already in hand, and
 * it is the first thing the page asks for.
 */
let coreReady = Promise.resolve();

// The face index is written lazily; a close would otherwise cost whatever the
// sweep managed since the last save.
async function flushAll() {
  // The sweeps first: a video being profiled while the files below are
  // written would dirty them again, and the host's wait is short.
  for (const sweep of [faces, dupes, framing]) {
    try { sweep.setEnabled(false); } catch { /* not started */ }
  }
  flushMeta();
  await Promise.all([
    flushConfig(),
    library.flush().catch((err) => log('library flush failed:', err.message)),
    faces.flush(),
  ]);
}

const routes = new Map();
for (const area of ['config', 'files', 'library', 'faces', 'sweeps', 'media']) {
  for (const [method, route, handler] of require(`./api/${area}`)(flushAll)) {
    const key = `${method} ${route}`;
    if (routes.has(key)) throw new Error(`route declared twice: ${key}`);
    routes.set(key, handler);
  }
}
const knownPaths = new Set([...routes.keys()].map((k) => k.split(' ')[1]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;
  // Read once here so sendJson can decide without being handed the request.
  res.acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

  const foreign = foreignRequest(req);
  if (foreign) {
    log(`refused ${req.method} ${route}: ${foreign}`);
    return sendJson(res, 403, { error: 'Requests from other sites are not accepted' });
  }

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && route.startsWith('/shared/')) {
      return serveShared(res, route);
    }
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(res, route.replace(/^\/+/, ''));
    }

    const handler = routes.get(`${req.method} ${route}`);
    if (!handler) {
      if (knownPaths.has(route)) {
        return sendJson(res, 405, { error: `${req.method} is not how ${route} is asked` });
      }
      return sendJson(res, 404, { error: 'Unknown endpoint: ' + route });
    }
    if (route !== '/api/config') await coreReady;
    // The body is read once, on first ask, and handed back the same way after.
    let parsed = null;
    const body = () => { parsed = parsed || readBody(req); return parsed; };
    return await handler({ req, res, url, body });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) logFailure(`ERROR ${req.method} ${route}`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
    else res.end();
  }
});

/** main() hands over the store loading here, for the API to wait on. */
function setCoreReady(loading) {
  coreReady = loading;
}

module.exports = {
  server, flushAll, setCoreReady, routes,
};
