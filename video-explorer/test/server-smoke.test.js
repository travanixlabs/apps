'use strict';

// The server, started for real on a free port and pointed entirely at a
// temporary folder: settings, labels, cache, logs, the face and fingerprint
// snapshots (which live under %LOCALAPPDATA%) and the "OneDrive" root itself.
// Nothing it reads or writes is the real library or the running app's state.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`timed out: ${route}`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('the server starts, answers, and serves from the split modules', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 've-smoke-'));
  const home = path.join(root, 'OneDrive');
  const local = path.join(root, 'LocalAppData');
  const empty = path.join(home, 'Empty folder');
  fs.mkdirSync(empty, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  const configFile = path.join(root, 'config.json');
  // A fixed home, so the account in the registry is not followed to the real
  // sync root.
  fs.writeFileSync(configFile, JSON.stringify({ homeFollowsAccount: false, homeDir: home, roots: [] }));

  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NO_OPEN: '1',
    VIDEO_EXPLORER_CONFIG: configFile,
    VIDEO_EXPLORER_LIBRARY: path.join(home, '.video-explorer', 'library.json'),
    VIDEO_EXPLORER_CACHE: path.join(home, '.video-explorer', 'cache'),
    VIDEO_EXPLORER_LOG_DIR: path.join(root, 'logs'),
    VIDEO_EXPLORER_FACE_MODELS: path.join(root, 'no-models'),
    GRAPH_TOKEN_FILE: path.join(root, 'no-token.json'),
    LOCALAPPDATA: local,
    OneDrive: home,
    OneDriveConsumer: home,
    OneDriveCommercial: home,
  };
  const child = spawn(process.execPath, [path.join(APP, 'server.js')], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));

  try {
    // Up when the port answers.
    let config = null;
    for (let i = 0; i < 100 && !config; i += 1) {
      try { config = await request(port, 'GET', '/api/config'); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.ok(config, `never answered:\n${output}`);
    assert.strictEqual(config.status, 200);
    assert.strictEqual(path.resolve(config.json.homeDir), path.resolve(home), 'home is the temp folder');
    assert.strictEqual(config.json.homeAccount.source, 'fixed');

    const status = await request(port, 'GET', '/api/status');
    assert.strictEqual(status.status, 200, status.text);
    for (const k of ['faces', 'dupes', 'framing']) assert.ok(status.json[k], `status has ${k}`);
    assert.strictEqual(typeof status.json.walkVersion, 'number');

    const page = await request(port, 'GET', '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);

    const script = await request(port, 'GET', '/filter.js');
    assert.strictEqual(script.status, 200);
    assert.match(script.headers['content-type'], /javascript/);

    const shared = await request(port, 'GET', '/shared/facets.js');
    assert.strictEqual(shared.status, 200);
    assert.match(shared.text, /FACE_FLOOR/);
    assert.strictEqual((await request(port, 'GET', '/shared/..%2Fserver.js')).status, 404);
    assert.strictEqual((await request(port, 'GET', '/shared/nothing.js')).status, 404);

    const scan = await request(port, 'GET', `/api/scan?dir=${encodeURIComponent(empty)}`);
    assert.strictEqual(scan.status, 200, scan.text);
    assert.deepStrictEqual(scan.json.files, []);
    assert.deepStrictEqual(scan.json.folders, []);
    assert.strictEqual(scan.json.totalBelow, 0);

    // Opening the folder authorised it, and the settings were written -- to
    // the temp file.
    const after = await request(port, 'GET', '/api/config');
    assert.ok(after.json.roots.some((r) => path.resolve(r).toLowerCase() === path.resolve(home).toLowerCase()
      || path.resolve(r).toLowerCase() === path.resolve(empty).toLowerCase()), JSON.stringify(after.json.roots));

    const missing = await request(port, 'GET', '/api/nothing-here');
    assert.strictEqual(missing.status, 404);

    // Another site's request is turned away.
    const foreign = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/config', headers: { Origin: 'https://example.com' } },
        (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.strictEqual(foreign, 403);

    const down = await request(port, 'POST', '/api/shutdown', {});
    assert.strictEqual(down.status, 200);
    assert.ok(fs.existsSync(configFile));
  } finally {
    child.kill();
    await exited;
    if (process.env.VE_SMOKE_VERBOSE) console.log(output);
    assert.doesNotMatch(output, /BOOT FAILED|UNCAUGHT|UNHANDLED|ERROR (GET|POST)/, output);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
