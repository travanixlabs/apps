'use strict';

/**
 * Indexes videos in a child process.
 *
 * Not for concurrency — for containment. onnxruntime is native code, and a
 * native fault takes down whatever process it is in. Running it here means the
 * worst case is a worker that dies and gets restarted, rather than the whole
 * app disappearing mid-browse, which is exactly what happened when this ran
 * in-process.
 *
 * Protocol: one JSON item per line on stdin, one JSON result per line on
 * stdout. The parent owns the store, so there is never a second writer.
 */

const readline = require('readline');
const faces = require('./faces');

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

(async () => {
  try {
    await faces.loadModels((msg) => send({ type: 'status', message: msg }));
  } catch (err) {
    send({ type: 'fatal', message: err.message });
    process.exit(1);
  }
  send({ type: 'ready' });

  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === 'stop') break;

    try {
      const result = await faces.computeTracks(item.file, item.duration || 0);
      send({ type: 'done', key: item.key, name: item.name, ...result });
    } catch (err) {
      send({ type: 'failed', key: item.key, name: item.name, message: String(err.message).slice(0, 160) });
    }
  }
  process.exit(0);
})();
