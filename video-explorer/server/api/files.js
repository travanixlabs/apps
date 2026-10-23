'use strict';

/**
 * Folders and files: the picker's listing of folders, the scan, the filtered
 * subfolder counts, and the actions on files (move, copy, rename, delete,
 * download or free up, tags written into the file).
 */

const path = require('path');

const { log, exists, createLimiter, run } = require('../util');
const { authoriseOrThrow, rememberRoot, state } = require('../config');
const { listDrives, listDirs } = require('../files');
const { cachedStripNames } = require('../cache');
const {
  subfolderEntries, countUnderFolders, walkOf, forgetWalks, scanDirectory, getLastWalk,
} = require('../walk');
const { embedTags, handleAction } = require('../fileops');
const { sendJson } = require('../http');
// The same file the page loads as a script. What "matches the advanced
// filter" means is one definition, not two that would have to agree.
const filter = require('../../public/filter');

module.exports = () => [
  // POST, not GET: browsing to a folder makes it somewhere a move may land
  // (see authoriseDestination), and a GET that grants anything can be made
  // by an <img src> on any page.
  ['POST', '/api/dirs', async ({ res, body }) => {
    const dir = String((await body()).dir || '');
    if (!dir) return sendJson(res, 200, { dir: '', parent: null, dirs: [], drives: await listDrives() });
    const resolved = path.resolve(dir);
    const parent = path.dirname(resolved);
    // Browsed to, so it may be chosen as somewhere to move or copy to.
    state.browsed.add(resolved.toLowerCase());
    return sendJson(res, 200, {
      dir: resolved,
      parent: parent === resolved ? null : parent,
      dirs: await listDirs(resolved),
      drives: await listDrives(),
    });
  }],

  // POST for the same reason: a scan authorises reads under the folder.
  ['POST', '/api/scan', async ({ res, body }) => {
    const asked = await body();
    const dir = String(asked.dir || '') || state.config.lastDir;
    if (!dir) return sendJson(res, 400, { error: 'No folder specified' });
    const resolved = path.resolve(dir);
    if (!(await exists(resolved))) return sendJson(res, 404, { error: 'Folder not found: ' + resolved });
    const recursive = asked.recursive === true || asked.recursive === '1' || asked.recursive === 1;
    rememberRoot(resolved);
    const started = Date.now();
    const atHome = state.config.homeDir
      && path.resolve(state.config.homeDir).toLowerCase() === resolved.toLowerCase();
    // Absent means yes: a listing tells you what is in the folder, and
    // narrowing to what is downloaded is the availability filter's job. Only
    // an explicit cloud=0 holds cloud items back.
    const includeCloud = !(asked.cloud === false || asked.cloud === '0' || asked.cloud === 0);
    // The walk takes the priority hold -- the sweeps pause between videos
    // rather than keeping the disk busy under it. Measured with the face
    // sweep running, an unheld scan of one library folder took 51 seconds.
    // `fresh` is the page saying it wants the disk read rather than what was
    // read a moment ago.
    const fresh = asked.fresh === true || asked.fresh === '1' || asked.fresh === 1;
    const scanned = await scanDirectory(resolved, recursive, includeCloud, fresh);

    // The default folder is a home page rather than a directory listing: it is
    // the one place where the sync root's own furniture -- Documents, Music,
    // an apps folder -- sits beside the libraries. Filtered here rather than in
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
  }],

  // How many videos under each subfolder survive the advanced filter.
  //
  // Asked separately from the scan rather than folded into it, because
  // changing a filter does not rescan: the tiles are already on screen and
  // only their numbers move. Against the walk the scan kept, so this costs
  // no stats at all -- and describes the same snapshot the tiles came from.
  ['POST', '/api/folders/counts', async ({ res, body }) => {
    const asked = await body();
    const dir = authoriseOrThrow(String(asked.dir || ''));
    const adv = filter.unpackFilter(asked.filter);
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
  }],

  // Download or free up, the way File Explorer's "Always keep on this
  // device" and "Free up space" do it: the pinned and unpinned attributes,
  // which OneDrive acts on in its own time. Only ever on request.
  ['POST', '/api/availability', async ({ res, body }) => {
    const asked = await body();
    const want = asked.want === 'download' ? 'download' : asked.want === 'cloud' ? 'cloud' : '';
    if (!want) return sendJson(res, 400, { error: 'want must be download or cloud' });
    const flags = want === 'download' ? ['+P', '-U'] : ['-P', '+U'];
    const results = {};
    // attrib takes one path per call -- a second one is "Parameter format
    // not correct" -- so a selection of a hundred was a hundred processes in
    // series. Four at a time: each is a short process start and an
    // attribute flip, and OneDrive does the actual work later on its own.
    const paths = Array.isArray(asked.paths) ? asked.paths : [];
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
  }],

  ['POST', '/api/library/embed', async ({ res, body }) => {
    const paths = Array.isArray((await body()).paths) ? (await body()).paths : [];
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
  }],

  ['POST', '/api/action', async ({ res, body }) => sendJson(res, 200, { results: await handleAction(await body()) })],
];
