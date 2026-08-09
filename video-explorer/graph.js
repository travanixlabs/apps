'use strict';

/**
 * Microsoft Graph access for cloud-only files.
 *
 * OneDrive generates thumbnails server-side for videos it stores. Fetching one
 * over HTTPS costs a few KB and — crucially — does NOT hydrate the placeholder,
 * so a 26,000-file cloud library becomes browsable without downloading 4.7TB.
 *
 * Uses the OAuth device-code flow: no client secret, no redirect URI, and the
 * refresh token is cached locally so sign-in happens once.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const CLIENT_ID = process.env.GRAPH_CLIENT_ID || 'ca1688c6-9077-4485-a565-d0ca35a4cb0a';
// "common" accepts both work and personal accounts — the synced OneDrive here
// is a consumer account, so a tenant-specific endpoint would not see it.
const TENANT = process.env.GRAPH_TENANT || 'common';
// Files.Read is all this needs; offline_access is what lets the token refresh
// so sign-in happens once rather than every session.
const SCOPES = 'Files.Read offline_access';

const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Tokens never go in OneDrive — that would sync a credential to the cloud.
const TOKEN_FILE = process.env.GRAPH_TOKEN_FILE
  || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'video-explorer', 'graph-token.json');

let cached = null;

function loadTokens() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    cached = null;
  }
  return cached;
}

async function saveTokens(tokens) {
  cached = tokens;
  await fsp.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fsp.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function form(params) {
  return new URLSearchParams(params).toString();
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/** Step 1: ask Microsoft for a code the user types at microsoft.com/devicelogin. */
async function requestDeviceCode() {
  const { ok, body } = await postForm(`${AUTH_BASE}/devicecode`, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  if (!ok) {
    throw new Error(`device code request failed: ${body.error} — ${body.error_description || ''}`);
  }
  return body; // { user_code, verification_uri, device_code, interval, expires_in }
}

/** Step 2: poll until the user finishes signing in. */
async function pollForToken(deviceCode, intervalSeconds, expiresInSeconds) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let wait = (intervalSeconds || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));

    const { ok, body } = await postForm(`${AUTH_BASE}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: deviceCode,
    });

    if (ok) {
      const tokens = {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: Date.now() + (body.expires_in - 60) * 1000,
      };
      await saveTokens(tokens);
      return tokens;
    }

    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { wait += 5000; continue; }
    throw new Error(`sign-in failed: ${body.error} — ${body.error_description || ''}`);
  }
  throw new Error('sign-in timed out');
}

async function refresh(tokens) {
  const { ok, body } = await postForm(`${AUTH_BASE}/token`, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: tokens.refresh_token,
    scope: SCOPES,
  });
  if (!ok) throw new Error(`token refresh failed: ${body.error_description || body.error}`);

  const next = {
    access_token: body.access_token,
    refresh_token: body.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (body.expires_in - 60) * 1000,
  };
  await saveTokens(next);
  return next;
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  tokens = await refresh(tokens);
  return tokens.access_token;
}

function isSignedIn() {
  return loadTokens() !== null;
}

async function graphGet(urlPath) {
  const token = await getAccessToken();
  if (!token) throw new Error('not signed in to Microsoft Graph');

  const res = await fetch(`${GRAPH_BASE}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Graph ${res.status}: ${text.slice(0, 200)}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
}

/** Local absolute path -> path relative to the OneDrive sync root. */
function toDriveRelative(absPath, oneDriveRoot) {
  const root = path.resolve(oneDriveRoot);
  const full = path.resolve(absPath);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  return full.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '');
}

/** Graph needs each path segment encoded, but the slashes left intact. */
function encodeDrivePath(relative) {
  return relative.split('/').map(encodeURIComponent).join('/');
}

/**
 * Thumbnail URLs Microsoft already generated for this file.
 * Returns { small, medium, large } with url/width/height, or null if none.
 */
async function getThumbnails(absPath, oneDriveRoot) {
  const relative = toDriveRelative(absPath, oneDriveRoot);
  if (!relative) throw new Error('file is outside the OneDrive root');

  const data = await graphGet(`/me/drive/root:/${encodeDrivePath(relative)}:/thumbnails`);
  const set = (data.value && data.value[0]) || null;
  return set || null;
}

/**
 * Top-level folders can be your own or shared folders mounted from another
 * account. Shared ones 404 under /me/drive/root:/path and must be addressed
 * through their remoteItem's driveId + itemId, so the mapping is resolved once
 * and reused.
 */
let rootMap = null;

async function getRootMap() {
  if (rootMap) return rootMap;
  const data = await graphGet('/me/drive/root/children?$select=name,folder,remoteItem');
  const map = new Map();
  for (const item of data.value || []) {
    if (!item.folder && !item.remoteItem) continue;
    map.set(item.name.toLowerCase(), item.remoteItem
      ? {
        shared: true,
        driveId: item.remoteItem.parentReference && item.remoteItem.parentReference.driveId,
        itemId: item.remoteItem.id,
      }
      : { shared: false });
  }
  rootMap = map;
  return map;
}

function resetRootMap() {
  rootMap = null;
}

/**
 * Graph address for a local file, handling both your own folders and shared
 * ones. `suffix` is appended to the item (e.g. "/thumbnails", "/content").
 */
async function itemPathFor(absPath, oneDriveRoot, suffix = '') {
  const relative = toDriveRelative(absPath, oneDriveRoot);
  if (!relative) return null;

  const segments = relative.split('/');
  const top = segments[0];
  const rest = segments.slice(1).join('/');

  // Path addressing closes with ":" only when a sub-resource follows
  // (":/thumbnails"). Addressing the item itself, or adding a query string,
  // must not carry that colon or Graph answers 409.
  const isSubResource = suffix.startsWith('/');

  const map = await getRootMap();
  const entry = map.get(top.toLowerCase());

  if (entry && entry.shared && entry.driveId && entry.itemId) {
    const base = `/drives/${entry.driveId}/items/${entry.itemId}`;
    if (!rest) return `${base}${suffix}`;
    const inner = `:/${encodeDrivePath(rest)}`;
    return isSubResource ? `${base}${inner}:${suffix}` : `${base}${inner}${suffix}`;
  }

  const base = `/me/drive/root:/${encodeDrivePath(relative)}`;
  return isSubResource ? `${base}:${suffix}` : `${base}${suffix}`;
}

async function thumbnailsPathFor(absPath, oneDriveRoot) {
  return itemPathFor(absPath, oneDriveRoot, '/thumbnails');
}

/**
 * A short-lived, pre-authenticated URL for the file's bytes. It supports HTTP
 * range requests, so a <video> can stream and seek straight from OneDrive
 * without the local placeholder ever being hydrated.
 *
 * These expire (roughly an hour), so callers should cache with a margin rather
 * than hold one indefinitely.
 */
async function getDownloadUrl(absPath, oneDriveRoot) {
  // No $select here: the downloadUrl is an annotation Graph returns by default
  // and rejects as a select field.
  const urlPath = await itemPathFor(absPath, oneDriveRoot);
  if (!urlPath) return null;
  const item = await graphGet(urlPath);
  return item['@microsoft.graph.downloadUrl'] || null;
}

/**
 * Downloads the largest thumbnail Microsoft holds for this file.
 * Returns a Buffer, or null when the service has no thumbnail for it.
 * Never touches the local placeholder, so nothing is hydrated.
 *
 * Uses the /content sub-resource, which redirects straight to the image. That
 * is one round trip instead of two (metadata, then the CDN URL it contains).
 */
async function fetchThumbnail(absPath, oneDriveRoot) {
  const urlPath = await thumbnailsPathFor(absPath, oneDriveRoot);
  if (!urlPath) return null;

  const token = await getAccessToken();
  if (!token) throw new Error('not signed in to Microsoft Graph');

  for (const size of ['large', 'medium', 'small']) {
    const res = await fetch(`${GRAPH_BASE}${urlPath}/0/${size}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });

    if (res.ok) return Buffer.from(await res.arrayBuffer());

    // 404 on "large" can mean this file only has smaller renditions; keep
    // trying. Any other status is a real failure worth surfacing.
    if (res.status !== 404) {
      const err = new Error(`Graph thumbnail ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
  }

  const err = new Error('no thumbnail available');
  err.statusCode = 404;
  throw err;
}

/**
 * Identifies the signed-in account via the drive itself, so no User.Read
 * permission is needed just to confirm who we are.
 */
async function whoAmI() {
  const drive = await graphGet('/me/drive');
  const owner = (drive.owner && drive.owner.user) || {};
  return {
    displayName: owner.displayName || '(unknown)',
    driveType: drive.driveType,          // 'personal' or 'business'
    quotaUsedGB: drive.quota ? Math.round(drive.quota.used / 1e9) : null,
    quotaTotalGB: drive.quota ? Math.round(drive.quota.total / 1e9) : null,
  };
}

async function driveInfo() {
  return graphGet('/me/drive');
}

module.exports = {
  CLIENT_ID,
  TENANT,
  TOKEN_FILE,
  requestDeviceCode,
  pollForToken,
  getAccessToken,
  isSignedIn,
  graphGet,
  getThumbnails,
  fetchThumbnail,
  getDownloadUrl,
  getRootMap,
  resetRootMap,
  toDriveRelative,
  whoAmI,
  driveInfo,
};
