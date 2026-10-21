'use strict';

/**
 * The request dispatcher: every /api route, in the order it has always been
 * matched, plus the static files. Moved here intact from server.js.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const library = require('../library');
const faces = require('../faces');
const dupes = require('../dupes');
const framing = require('../framing');
// The same file the page loads as a script. What "matches the advanced
// filter" means is one definition, not two that would have to agree.
const filter = require('../public/filter');

const { log, logFailure, exists, loadJsonSync, createLimiter, run } = require('./util');
const {
  graph, HOST, PORT, DEFAULT_CONFIG, saveConfigSoon, flushConfig, applyHomeDir,
  authoriseOrThrow, rememberRoot, state,
} = require('./config');
const { graphStreamInfo, graphStreamUrl, graphThumbnail } = require('./cloud');
const { listDrives, listDirs, isCloudOnly, statWithCloud } = require('./files');
const {
  flushMeta, adoptEmbedded, getMeta, thumbCachePath, spriteCachePath,
  writeCacheManifest, cachedMeta, ensureSprite, ensureThumb, cachedStripNames,
  clearCache,
} = require('./cache');
const {
  subfolderEntries, describeVideo, countUnderFolders, walkOf, forgetWalks,
  scanDirectory, getLastWalk, getWalkVersion,
} = require('./walk');
const { embedTags, carryOver, handleAction } = require('./fileops');
const {
  sendJson, serveStatic, serveShared, readBody, streamVideo, foreignRequest,
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
    if (route.startsWith('/api/') && route !== '/api/config') await coreReady;
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && route.startsWith('/shared/')) {
      return serveShared(res, route);
    }
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(res, route.replace(/^\/+/, ''));
    }

    // The window is closing: everything held in memory goes to disk before the
    // host ends the process, which it does without a signal.
    if (req.method === 'POST' && route === '/api/shutdown') {
      await flushAll();
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/config') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ...state.config, homeAccount: state.homeAccount });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        for (const key of Object.keys(DEFAULT_CONFIG)) {
          if (key in body) state.config[key] = body[key];
        }
        // Emptying the path means "go back to following the account", not
        // "open on nothing" — so re-resolve rather than store a blank.
        if ('homeDir' in body || 'homeFollowsAccount' in body) await applyHomeDir();
        // Tile width and frame count are both in the cache names, so a reader
        // outside this process needs to be told when they move.
        if ('tileWidth' in body || 'frames' in body) await writeCacheManifest();
        saveConfigSoon();
        return sendJson(res, 200, { ...state.config, homeAccount: state.homeAccount });
      }
    }

    // The three sweeps in one answer.
    //
    // They were polled separately every two seconds, which was ninety requests
    // a minute for a window nobody was looking at -- and each face reply walked
    // all 23,000 profiles three times to count them. One route, one walk, and
    // the page slows to a crawl of its own accord when nothing is running.
    if (req.method === 'GET' && route === '/api/status') {
      return sendJson(res, 200, {
        faces: faces.status(),
        dupes: dupes.status(),
        framing: framing.status(),
        // Whether ffmpeg could be started at launch; the page says so once.
        ffmpeg: state.ffmpeg,
        // Bumped when a folder is found to have changed underneath a listing
        // that was served from the last walk of it.
        walkVersion: getWalkVersion(),
      });
    }

    if (req.method === 'GET' && route === '/api/drives') {
      return sendJson(res, 200, { drives: await listDrives() });
    }

    if (req.method === 'GET' && route === '/api/dirs') {
      const dir = url.searchParams.get('dir') || '';
      if (!dir) return sendJson(res, 200, { dir: '', parent: null, dirs: [], drives: await listDrives() });
      const resolved = path.resolve(dir);
      const parent = path.dirname(resolved);
      return sendJson(res, 200, {
        dir: resolved,
        parent: parent === resolved ? null : parent,
        dirs: await listDirs(resolved),
        drives: await listDrives(),
      });
    }

    if (req.method === 'GET' && route === '/api/scan') {
      const dir = url.searchParams.get('dir') || state.config.lastDir;
      if (!dir) return sendJson(res, 400, { error: 'No folder specified' });
      const resolved = path.resolve(dir);
      if (!(await exists(resolved))) return sendJson(res, 404, { error: 'Folder not found: ' + resolved });
      const recursive = url.searchParams.get('recursive') === '1';
      rememberRoot(resolved);
      const started = Date.now();
      const atHome = state.config.homeDir
        && path.resolve(state.config.homeDir).toLowerCase() === resolved.toLowerCase();
      // Absent means yes: a listing tells you what is in the folder, and
      // narrowing to what is downloaded is the availability filter's job. Only
      // an explicit cloud=0 holds cloud items back.
      const includeCloud = url.searchParams.get('cloud') !== '0';
      // The walk takes the priority hold -- the sweeps pause between videos
      // rather than keeping the disk busy under it. Measured with the face
      // sweep running, an unheld scan of one library folder took 51 seconds.
      // `fresh=1` is the page saying it wants the disk read rather than what
      // was read a moment ago.
      const fresh = url.searchParams.get('fresh') === '1';
      const scanned = await scanDirectory(resolved, recursive, includeCloud, fresh);

      // The default folder is a home page rather than a directory listing: it is
      // the one place where the sync root's own furniture — Documents, Music,
      // an apps folder — sits beside the libraries. Filtered here rather than in
      // the client so the folder count describes what is on screen.
      const shown = (state.config.homeFolders || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
      if (atHome && shown.length) {
        scanned.folders = scanned.folders.filter((f) => shown.includes(f.name.toLowerCase()));
      }

      const parent = path.dirname(resolved);
      log(`scanned ${resolved} -> ${scanned.files.length} listed, ${scanned.cloudHidden} cloud hidden, `
        + `${scanned.totalBelow} below (${scanned.cloudBelow} cloud), ${scanned.folders.length} folders `
        + `in ${Date.now() - started}ms`);
      return sendJson(res, 200, {
        dir: resolved,
        parent: parent === resolved ? null : parent,
        recursive,
        includeCloud,
        ...scanned,
      });
    }

    // How many videos under each subfolder survive the advanced filter.
    //
    // Asked separately from the scan rather than folded into it, because
    // changing a filter does not rescan: the tiles are already on screen and
    // only their numbers move. Against the walk the scan kept, so this costs
    // no stats at all -- and describes the same snapshot the tiles came from.
    if (req.method === 'POST' && route === '/api/folders/counts') {
      const body = await readBody(req);
      const dir = authoriseOrThrow(String(body.dir || ''));
      const adv = filter.unpackFilter(body.filter);
      // An empty filter has nothing to say: every video matches, and the page
      // already knows each folder's total. Refused rather than answered, so a
      // bug on either side shows up as a missing count instead of a wrong one.
      if (!filter.filterActive(adv)) {
        return sendJson(res, 400, { error: 'No filter to count' });
      }
      const key = path.resolve(dir).toLowerCase();
      let videos = getLastWalk().videos;
      // The same walk the listing was drawn from, which is the honest thing to
      // count against as well as the quick one.
      if (getLastWalk().key !== key) videos = (await walkOf(dir, false)).videos;
      const subs = await subfolderEntries(dir);
      const started = Date.now();
      const counts = countUnderFolders(dir, videos, subs, adv, await cachedStripNames());
      log(`counted ${subs.length} folders under ${dir} in ${Date.now() - started}ms`);
      return sendJson(res, 200, { dir, counts });
    }

    if (req.method === 'GET' && route === '/api/sprite') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { stat, cloudOnly } = await statWithCloud(target);
      if (cloudOnly
          && url.searchParams.get('allowCloud') !== '1'
          && !(await exists(spriteCachePath(target, stat)))) {
        return sendJson(res, 409, { error: 'cloud-only', cloudOnly: true, size: stat.size });
      }
      const { file, frames } = await ensureSprite(target, stat);
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'X-Sprite-Frames': String(frames),
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(data);
    }

    // Probes only the files a page actually shows, and never a cloud file
    // unless the user explicitly asked for it.
    if (req.method === 'POST' && route === '/api/meta') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 250) : [];
      const allowCloud = body.allowCloud === true;
      const meta = {};
      await Promise.all(paths.map(async (raw) => {
        try {
          const target = authoriseOrThrow(raw);
          const { stat, cloudOnly } = await statWithCloud(target);
          // Cached metadata is free and outlives dehydration — always use it.
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
    }

    if (route === '/api/library') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          tags: library.tagCounts(),
          models: library.modelCounts(),
          studios: library.studioCounts(),
          productions: library.productionCounts(),
          favourites: library.favouriteModels(),
          favouriteTiers: library.favouriteTiers(),
          races: library.performerRaces(),
          traits: library.performerTraits(),
          stats: library.stats(),
        });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const { paths: listed, items: listedItems, ...patch } = body;
        // Either one patch for many videos (`paths` + the patch), or a patch of
        // its own for each (`items`: [{ path, ...patch }]) -- the shape a bulk
        // answer like "All profiled" takes, sent once instead of a request per
        // name.
        const items = Array.isArray(listedItems)
          ? listedItems.filter((it) => it && typeof it.path === 'string')
            .map(({ path: p, ...own }) => ({ raw: p, patch: own }))
          : (Array.isArray(listed) ? listed : []).map((raw) => ({ raw, patch }));
        const paths = items.map((it) => it.raw);
        const records = {};
        const stats = new Map();
        let namesMoved = false;
        for (const { raw, patch: own } of items) {
          try {
            const target = authoriseOrThrow(raw);
            const stat = await fsp.stat(target);
            stats.set(raw, stat);
            const before = (library.decorate(stat).models || []).join('\n');
            // Without `paths`: apply() reads the patch's keys to tell a resume
            // save from a real edit.
            records[raw] = library.apply(stat, path.basename(target), own);
            if ((records[raw].models || []).join('\n') !== before) namesMoved = true;
          } catch (err) {
            records[raw] = { error: err.message || String(err) };
          }
        }
        // Naming someone changes who the averages are built from, so the
        // suggestions are only as current as the labels behind them. Only when
        // a name actually changed: the tag dialog sends its models box with
        // every save, and each rebuild is a full re-score of the library.
        if (namesMoved) faces.rebuildSoon();
        // Turning a name down changes one video's ranking and nobody's average,
        // so it re-scores that video instead of the whole library -- and then
        // says what the ranking became. Without that the client would keep
        // drawing the suggestion it has just refused, since its copy of the
        // listing is only as current as the last reply.
        const refusing = (p) => p.notModels !== undefined || p.addNotModels !== undefined
          || p.removeNotModels !== undefined || p.settled !== undefined;
        if (items.some((it) => refusing(it.patch))) {
          for (const { raw, patch: own } of items) {
            if (!refusing(own) || (records[raw] && records[raw].error)) continue;
            try {
              const stat = stats.get(raw) || await fsp.stat(authoriseOrThrow(raw));
              faces.rescoreOne(stat);
              records[raw] = { ...records[raw], ...faces.decorate(stat) };
            } catch { /* the record answered above; a missing file is its problem */ }
          }
        }
        return sendJson(res, 200, {
          records,
          tags: library.tagCounts(),
          models: library.modelCounts(),
          studios: library.studioCounts(),
          productions: library.productionCounts(),
        });
      }
    }

    // The label vocabulary itself: rename it everywhere, take it off
    // everything, or declare one that nothing carries yet. Colours live in the
    // config and go through /api/config like every other preference.
    if (req.method === 'POST' && route === '/api/labels') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      const spare = Array.isArray(state.config.spareLabels) ? state.config.spareLabels : [];
      const without = (list, drop) => list.filter((t) => t.toLowerCase() !== drop.toLowerCase());

      if (action === 'add') {
        if (!name) return sendJson(res, 400, { error: 'A label needs a name' });
        const used = library.tagCounts().some((t) => t.tag.toLowerCase() === name.toLowerCase());
        const already = spare.some((t) => t.toLowerCase() === name.toLowerCase());
        if (!used && !already) { state.config.spareLabels = [...spare, name]; saveConfigSoon(); }
        return sendJson(res, 200, { changed: 0, config: state.config, tags: library.tagCounts() });
      }

      if (action === 'rename') {
        const to = String(body.to || '').trim().replace(/\s+/g, ' ');
        if (!name || !to) return sendJson(res, 400, { error: 'Both names are needed' });
        const { changed } = library.renameTag(name, to);
        // The colour belongs to the label, so it moves with it, and a spare
        // label is renamed in place rather than left behind as a second one.
        const colours = { ...(state.config.labelColours || {}) };
        const held = colours[name.toLowerCase()];
        delete colours[name.toLowerCase()];
        if (held) colours[to.toLowerCase()] = held;
        const nextSpare = spare.some((t) => t.toLowerCase() === name.toLowerCase())
          ? [...without(spare, name), to] : spare;
        state.config.labelColours = colours;
        state.config.spareLabels = nextSpare;
        saveConfigSoon();
        return sendJson(res, 200, { changed, config: state.config, tags: library.tagCounts() });
      }

      if (action === 'delete') {
        if (!name) return sendJson(res, 400, { error: 'Which label?' });
        const { changed } = library.removeTagEverywhere(name);
        const colours = { ...(state.config.labelColours || {}) };
        delete colours[name.toLowerCase()];
        state.config.labelColours = colours;
        state.config.spareLabels = without(spare, name);
        saveConfigSoon();
        return sendJson(res, 200, { changed, config: state.config, tags: library.tagCounts() });
      }

      return sendJson(res, 400, { error: `Unknown action "${action}"` });
    }

    // "Not a performer": a credited name that is not a person -- a word out of
    // a filename, a studio, a scene title. It comes off every video in one
    // write, takes its race and favourite mark with it, and goes on the list
    // the filename suggester reads first, so it is never offered again.
    if (req.method === 'POST' && route === '/api/models') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ');
      // A performer renamed: her credits, the videos she was turned down on,
      // race, height/bust/body and favourite tier all move to the new name,
      // and the face lineups are rebuilt under it.
      if (body.action === 'rename') {
        const to = String(body.to || '').trim().replace(/\s+/g, ' ');
        if (!name || !to) return sendJson(res, 400, { error: 'Both names are needed' });
        const credited = library.renameTag(name, to, 'models').changed;
        const refused = library.renameTag(name, to, 'notModels').changed;
        const race = library.performerRaces()[name.toLowerCase()];
        if (race && !library.performerRaces()[to.toLowerCase()]) library.setPerformerRace(to, race);
        library.setPerformerRace(name, '');
        const traits = library.performerTraits()[name.toLowerCase()];
        if (traits && !library.performerTraits()[to.toLowerCase()]) library.setPerformerTraits(to, traits);
        library.setPerformerTraits(name, { height: '', bust: '', body: [] });
        if (library.isFavouriteModel(name)) {
          const tier = library.favouriteTiers()[name.toLowerCase()];
          library.setFavouriteModel(name, false);
          if (!library.isFavouriteModel(to)) library.setFavouriteModel(to, true, tier);
        }
        faces.rebuildSoon();
        return sendJson(res, 200, {
          credited, refused,
          favourites: library.favouriteModels(), favouriteTiers: library.favouriteTiers(),
          races: library.performerRaces(), traits: library.performerTraits(),
        });
      }
      if (body.action !== 'not-a-performer') return sendJson(res, 400, { error: `Unknown action "${body.action}"` });
      if (!name) return sendJson(res, 400, { error: 'Which name?' });
      const { changed } = library.removeTagEverywhere(name, 'models');
      log(`not a performer: "${name}" taken off ${changed} video(s)`);
      // Her average face was built from those credits. Rebuilt without them,
      // she has none, and stops being suggested anywhere.
      faces.rebuildSoon();
      if (library.isFavouriteModel(name)) library.setFavouriteModel(name, false);
      const races = library.setPerformerRace(name, '');
      const traits = library.setPerformerTraits(name, { height: '', bust: '', body: [] });
      try {
        const file = path.join(state.ONEDRIVE_ROOT, '.video-explorer', 'not-model-names.json');
        const held = loadJsonSync(file, null) || { names: [] };
        if (!Array.isArray(held.names)) held.names = [];
        if (!held.names.some((n) => String(n.name || '').toLowerCase() === name.toLowerCase())) {
          held.names.push({ name, why: 'marked not a performer in the app', when: new Date().toISOString().slice(0, 10) });
          held.updated = new Date().toISOString();
          await fsp.writeFile(file, JSON.stringify(held, null, 2));
        }
      } catch (err) {
        log(`not-a-performer: could not note "${name}" for the suggester: ${err.message}`);
      }
      return sendJson(res, 200, {
        changed, races, traits, models: library.modelCounts(),
        favourites: library.favouriteModels(), favouriteTiers: library.favouriteTiers(),
      });
    }

    if (req.method === 'POST' && route === '/api/races') {
      const body = await readBody(req);
      const races = library.setPerformerRace(body.name, body.race || '');
      return sendJson(res, 200, { races });
    }

    if (req.method === 'POST' && route === '/api/favourites') {
      const body = await readBody(req);
      const favourites = library.setFavouriteModel(body.name, body.on !== false, body.tier);
      return sendJson(res, 200, { favourites, favouriteTiers: library.favouriteTiers() });
    }

    // Download or free up, the way File Explorer's "Always keep on this
    // device" and "Free up space" do it: the pinned and unpinned attributes,
    // which OneDrive acts on in its own time. Only ever on request.
    if (req.method === 'POST' && route === '/api/availability') {
      const body = await readBody(req);
      const want = body.want === 'download' ? 'download' : body.want === 'cloud' ? 'cloud' : '';
      if (!want) return sendJson(res, 400, { error: 'want must be download or cloud' });
      const flags = want === 'download' ? ['+P', '-U'] : ['-P', '+U'];
      const results = {};
      // attrib takes one path per call -- a second one is "Parameter format
      // not correct" -- so a selection of a hundred was a hundred processes in
      // series. Four at a time: each is a short process start and an
      // attribute flip, and OneDrive does the actual work later on its own.
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const attribLimit = createLimiter(4);
      await Promise.all(paths.map((raw) => attribLimit(async () => {
        try {
          const target = authoriseOrThrow(raw);
          await run('attrib', [...flags, target]);
          results[raw] = { ok: true };
        } catch (err) {
          results[raw] = { error: err.message || String(err) };
        }
      })));
      forgetWalks();
      return sendJson(res, 200, { want, results });
    }

    // Run the carry-over now rather than waiting for its timer.
    if (req.method === 'POST' && route === '/api/carry-over') {
      const body = await readBody(req).catch(() => ({}));
      return sendJson(res, 200, await carryOver({ dry: Boolean(body && body.dry) }));
    }

    if (req.method === 'POST' && route === '/api/traits') {
      const body = await readBody(req);
      const { name, ...patch } = body;
      const traits = library.setPerformerTraits(name, patch);
      return sendJson(res, 200, { traits });
    }

    if (req.method === 'POST' && route === '/api/library/embed') {
      const body = await readBody(req);
      const paths = Array.isArray(body.paths) ? body.paths : [];
      const results = [];
      for (const raw of paths) {
        try {
          const target = authoriseOrThrow(raw);
          const written = await embedTags(target);
          results.push({ path: raw, ok: true, ...written });
        } catch (err) {
          results.push({ path: raw, ok: false, error: err.message || String(err) });
        }
      }
      log(`embedded tags into ${results.filter((r) => r.ok).length} of ${paths.length} files`);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'GET' && route === '/api/graph') {
      if (!graph) return sendJson(res, 200, { available: false, signedIn: false });
      const signedIn = graph.isSignedIn();
      if (!signedIn) return sendJson(res, 200, { available: true, signedIn: false });
      try {
        const me = await graph.whoAmI();
        return sendJson(res, 200, { available: true, signedIn: true, account: me });
      } catch (err) {
        return sendJson(res, 200, { available: true, signedIn: false, error: err.message });
      }
    }

    // ------------------------------------------------------- familiar faces

    // How far the backfill has got. Polled by the UI.
    if (req.method === 'GET' && route === '/api/dupes/status') {
      return sendJson(res, 200, dupes.status());
    }

    if (req.method === 'POST' && route === '/api/dupes/enabled') {
      const body = await readBody(req);
      return sendJson(res, 200, dupes.setEnabled(body.enabled !== false));
    }

    // Match now rather than waiting for the batch to fill: useful when a sweep
    // was interrupted and its fingerprints have never been compared.
    if (req.method === 'POST' && route === '/api/dupes/match') {
      await dupes.refresh();
      return sendJson(res, 200, dupes.status());
    }

    // Every video that is one of several copies, wherever it lives. The
    // grouping asks for this so a set split across folders is still a set.
    if (req.method === 'GET' && route === '/api/dupes/files') {
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
    }

    // Not a duplicate after all. Named by any one of its members, since the
    // page is holding videos rather than the set's own identity.
    if (req.method === 'POST' && route === '/api/dupes/dismiss') {
      const body = await readBody(req);
      const raw = String(body.path || '');
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
    }

    if (req.method === 'POST' && route === '/api/dupes/restore') {
      const body = await readBody(req);
      const out = dupes.restoreDismissed(body.signature ? String(body.signature) : '');
      return sendJson(res, 200, { ...out, status: dupes.status() });
    }

    if (req.method === 'GET' && route === '/api/dupes/groups') {
      const body = await dupes.loadDigest();
      if (!body) {
        return sendJson(res, 200, {
          groups: [], confirmed: [], possible: [], fingerprinted: 0,
          note: 'nothing matched yet -- run tools/find-dupes.js',
        });
      }
      return sendJson(res, 200, body);
    }

    if (req.method === 'GET' && route === '/api/framing/status') {
      return sendJson(res, 200, framing.status());
    }

    if (req.method === 'POST' && route === '/api/framing/enabled') {
      const body = await readBody(req);
      return sendJson(res, 200, framing.setEnabled(body.enabled !== false));
    }

    if (req.method === 'GET' && route === '/api/faces/status') {
      return sendJson(res, 200, faces.status());
    }

    // Pausing is a preference, not a setting worth persisting: the sweep should
    // start again next launch, since that is what "backfill while open" means.
    if (req.method === 'POST' && route === '/api/faces/enabled') {
      const body = await readBody(req);
      return sendJson(res, 200, faces.setEnabled(body.enabled !== false));
    }

    // Where one video stands: read or not, and what came closest if nothing
    // cleared the bar. Asked when the player opens rather than carried with
    // every listing entry.
    if (req.method === 'GET' && route === '/api/faces/standing') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const stat = await fsp.stat(target);
      return sendJson(res, 200, faces.standing(stat));
    }

    // Other videos holding the same face. Not a name -- the same face -- so
    // it answers for the uncredited majority of the library as well.
    if (req.method === 'GET' && route === '/api/faces/similar') {
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
        // A different file at that path now. The video this profile describes
        // is not there, whatever is.
        if (faces.keyFor(at) !== row.key) { faces.forgetPath(row.key); continue; }
        videos.push({
          ...describeVideo({
            path: row.path,
            size: at.size,
            mtimeMs: at.mtimeMs,
            cloudOnly: isCloudOnly(at),
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
    }

    // A picture for each named performer: her video that most resembles this
    // one. What turns a row of names into a row of thumbnails.
    if (req.method === 'GET' && route === '/api/faces/best') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const stat = await fsp.stat(target);
      const names = String(url.searchParams.get('models') || '')
        .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12);
      const picked = faces.bestOf(stat, names);
      const out = {};
      for (const [name, row] of Object.entries(picked)) {
        // Same guard the row below uses: the sweep's note of where this was can
        // be a quarter of an hour old, and a picture of the wrong video is
        // worse than no picture.
        let at;
        try { at = await fsp.stat(row.path); } catch { faces.forgetPath(row.key); continue; }
        if (faces.keyFor(at) !== row.key) { faces.forgetPath(row.key); continue; }
        out[name] = {
          ...row,
          name: path.basename(row.path),
          cloudOnly: isCloudOnly(at),
        };
      }
      return sendJson(res, 200, { best: out });
    }

    // A performer's other faces, to hold the suggested one up against.
    if (req.method === 'GET' && route === '/api/faces/lineup') {
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
    }

    // One of those, by key. Keyed rather than pathed because a lineup shows
    // other videos, which may since have been renamed or freed up -- and this
    // is our own crop, not any part of a file.
    if (req.method === 'GET' && route === '/api/faces/crop') {
      const png = await faces.faceImageByKey(
        url.searchParams.get('key') || '',
        Number(url.searchParams.get('person') || 0),
      );
      if (!png) return sendJson(res, 404, { error: 'no face stored' });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(png);
    }

    // The face a suggestion was made from, so a name can be checked against a
    // picture rather than taken on trust.
    if (req.method === 'GET' && route === '/api/faces/face') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const stat = await fsp.stat(target);
      const png = await faces.faceImage(stat, Number(url.searchParams.get('person') || 0));
      if (!png) return sendJson(res, 404, { error: 'no face stored for this video' });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(png);
    }

    if (req.method === 'GET' && route === '/api/thumb') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { stat, cloudOnly } = await statWithCloud(target);
      const cachePath = thumbCachePath(target, stat);
      const allowCloud = url.searchParams.get('allowCloud') === '1';

      // Refuse to BUILD locally for a cloud file, but always SERVE one already
      // built — and before giving up, ask OneDrive for the thumbnail it already
      // has, which costs ~16KB and hydrates nothing.
      if (cloudOnly && !allowCloud && !(await exists(cachePath))) {
        const fromGraph = await graphThumbnail(target);
        if (fromGraph.buffer) {
          await fsp.mkdir(path.dirname(cachePath), { recursive: true });
          await fsp.writeFile(cachePath, fromGraph.buffer);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': fromGraph.buffer.length,
            'X-Thumb-Source': 'graph',
            'Cache-Control': 'private, max-age=86400',
          });
          return res.end(fromGraph.buffer);
        }
        // Throttled or briefly down is a "come back", not a "there is none":
        // answering 409 for it made a tile blank for the rest of the session.
        if (fromGraph.reason === 'throttled' || fromGraph.reason === 'graph-error') {
          const wait = Number(fromGraph.retryAfter) || 5;
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Retry-After': String(wait),
          });
          return res.end(JSON.stringify({
            error: 'thumbnail unavailable', ...fromGraph, retryAfter: wait,
          }));
        }
        return sendJson(res, 409, {
          error: 'cloud-only', cloudOnly: true, size: stat.size, reason: fromGraph.reason,
        });
      }

      const data = await fsp.readFile(await ensureThumb(target, stat));
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(data);
    }

    // Resolve a cloud file's streaming URL AHEAD of being asked to play it.
    // The answer is cached for 45 minutes, so this is the same lookup /api/video
    // would do -- just paid while the user is still deciding rather than while
    // they watch a black rectangle. Cheap to call and safe to call repeatedly.
    if (req.method === 'GET' && route === '/api/warm') {
      const target = authoriseOrThrow(url.searchParams.get('path') || '');
      const { stat } = await statWithCloud(target);
      if (!isCloudOnly(stat)) return sendJson(res, 200, { warmed: false, local: true });
      const began = Date.now();
      const info = await graphStreamInfo(target).catch(() => null);
      return sendJson(res, 200, { warmed: Boolean(info), ms: Date.now() - began });
    }

    if (req.method === 'GET' && route === '/api/video') {
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
    }

    if (req.method === 'POST' && route === '/api/action') {
      const body = await readBody(req);
      return sendJson(res, 200, { results: await handleAction(body) });
    }

    if (req.method === 'POST' && route === '/api/cache/clear') {
      await clearCache();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: 'Unknown endpoint: ' + route });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) logFailure(`ERROR ${req.method} ${route}`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || String(err) });
    else res.end();
  }
});

// The face index is written lazily; a close would otherwise cost whatever the
// sweep managed since the last save.
async function flushAll() {
  flushMeta();
  await Promise.all([
    flushConfig(),
    library.flush().catch((err) => log('library flush failed:', err.message)),
    faces.flush(),
  ]);
}

/** main() hands over the store loading here, for the API to wait on. */
function setCoreReady(loading) {
  coreReady = loading;
}

module.exports = {
  server, flushAll, setCoreReady,
};
