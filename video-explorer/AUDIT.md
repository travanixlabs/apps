# Video Explorer — full audit

Date: 2026-10-21 · Tree: `35156f8` · Desktop app, native host (`%LOCALAPPDATA%\video-explorer-native`, readable) and phone PWA (`mobile/`) all in scope.
Read-only: nothing was changed, built or run except `npm test` (53/53, ~4 s).

## How to read this

- Six reviews ran in parallel (code quality, performance, reliability + tests, architecture, developer experience, UX/a11y), each reading the code end to end. Findings were then deduplicated across reviews and re-ranked on **one scale**:
  - **Critical** — data loss, silent corruption of the stores, or the sweeps stalling.
  - **High** — wrong or lost behaviour a user will hit, or a cost that grows with the library.
  - **Medium** — real, bounded, fixable in an afternoon.
  - **Nice-to-have** — hygiene.
- **Effort** S (< ½ day) / M (1–2 days) / L (a week). **Impact** Low / Med / High.
- Line numbers are from the tree above. Items marked **[verified]** were re-checked by hand against the code or the live stores after the review reported them; the rest were verified by the reviewer against the code with line references.
- Measured today: `library.json` 5.69 MB / 22.7k records; `faces/v/` 28,490 entries; `faces/suggestions.json` 12.8 MB; `cache/` 77,246 files; `%LOCALAPPDATA%` `faces-snapshot.bin` 74 MB, `faces-scores.json` 28 MB.

## Headline

The core design is sound and most of the hard parts are done well: temp+rename writes with a three-way merge on the library, a serialised write chain, snapshot-on-big-drop, daily backups, bounded ffmpeg concurrency with timeouts, a priority hold so sweeps step aside for a person, a paged grid that handles 27k videos, an `unref`'d scorer worker with a timeout and fallback, `authoriseOrThrow` on every path route, and a same-origin gate. The phone's ETag/412/merge/retry path is correct. All seven desktop modals have proper dialog roles, focus moves in and back, and every text colour on the desktop passes AA.

What matters most, in order:

1. **The one guard that protects `library.json` from "OneDrive restored an old version" cannot fire** — `adoptDisk` resets the counter the guard reads. (Reliability 1)
2. **If ffmpeg goes missing, all three sweeps write empty results into the synced stores and mark 28k videos done forever.** (Reliability 2)
3. **Scrolling past cloud-only tiles pauses all three sweeps** — the page's background strip builds take the "somebody is waiting" hold. (Performance 1)
4. **OneDrive conflict copies of the library are never read.** One exists today (9,168 records, 11 Sep); it holds nothing newer, so nothing was lost this time, but the next one could. (Architecture 1)
5. **The sweeps and the label store log only to the console, which the packaged app discards.** The subsystems most likely to fail silently are the ones not in the log. (Code quality 1)
6. **`mergeLibraries` exists twice, byte-identical, with a test on one copy; `mobile/shared/facets.js` is synced and drift-tested but nothing on the phone loads it.** The sync machinery guards a dead file. (Architecture 2–3)

---

## 1. Code quality

### 1.1 Sweeps and the label store bypass the file log — **High · S · High** [verified]
- **Where:** `server/util.js:19-77` is the only writer of `%LOCALAPPDATA%\video-explorer\logs\server-*.log`. `faces.js:40`, `dupes.js:42`, `framing.js:35` each define `const log = (msg) => console.log(...)`; `library.js:202, 223, 386` call `console.log` directly. None requires `./server/util`.
- **What:** "LABELS READ-ONLY", "merged changes written by another device", "store: N from the snapshot", "could not credit …", "scoring thread stopped", face-index migration failures — none reach disk. The native host starts node with `CreateNoWindow = true` and no stdout redirect (`Program.cs:121-128`), so in the installed app they are discarded. Checked against the real log: only the five wrapper lines from `server.js:168-195, 223` appear.
- **Why:** these are the subsystems that fail silently for hours.
- **Fix:** have the four modules `require('./server/util').log` (keep their prefix), or move `log/logFailure` to a root `log.js` and have `server/util.js` re-export it.

### 1.2 The face sweep swallows `profile()` errors and the worker's error text — **High · S · High**
- **Where:** `faces.js:2321-2327` counts a failed profile in `state.failures` without logging the message; `faces.js:1033` `if (msg.type === 'failed') { waiting.resolve(null); return; }` discards the `error` string `faces-scorer.js:405-408` sends.
- **Why:** a systematically failing ffmpeg or model shows only as a rising failure count.
- **Fix:** `log(\`profile failed ${file}: ${err.message}\`)` (rate-limited) and `log(\`scorer failed run ${run}: ${error}\`)`.

### 1.3 The page has no global error sink — **Medium · S · Med**
- **Where:** no `window.onerror` / `unhandledrejection` anywhere in `public/js`; zero `console.*` calls; 25 `catch (err)` sites toast `err.message`, everything else vanishes inside WebView2.
- **Fix:** in `core.js`, `window.addEventListener('error' | 'unhandledrejection', …)` → `toast(..., 'err')`, optionally POST to a tiny `/api/log` so it lands in the daily file.

### 1.4 Oversized functions — **Medium · M/L · Med**
- `public/js/main.js:5-616` `wireEvents` **612 lines**, 104 `addEventListener`s; `main.js:648-859` `onKeyDown` 212.
- `server/routes.js:53-852` the `createServer` callback is one **800-line** closure with 41 `route ===` branches (see Architecture 4.6).
- `mobile/app.js:4067-4273` `boot` 207; `:3101-3228` `attachScrub` 128; `:2221-2324` `renderAdv` 104.
- `public/js/grid.js:298-472` `buildGroupHead` 175; `:725-882` `buildCard` 158.
- `server.js:131-270` `loadCore` 140; `server/cache.js:378-498` `ensureSprite` 121; `library.js:569-686` `apply` 118; `view.js:1004-1112` `renderAdvanced` 109.
- **Fix:** split `wireEvents` by region (`wireToolbar`, `wirePlayer`, `wireDialogs`…) — zero behaviour change; the rest as time allows.

### 1.5 The page re-declares constants `shared/facets.js` already injects — **Medium · S · Med**
- **Where:** `public/js/core.js:191` `const RATING_MAX = 10`; `view.js:48-52` `const TRAITS`; `view.js:343` `const STAR_POINTS` — lexical `const`s shadowing the globals `facets.js:21-22` set. `public/filter.js:48, 171, 186-192` keeps fallback copies of `FACE_FLOOR`/`RACES`/`PERSON_FACETS` "while the page catches up", and `test/filter.test.js:123-133` tests a page without facets — a page that cannot exist (`index.html:842-843` always loads facets first).
- **Fix:** delete the three page constants; make `filter.js` throw if `shared` is missing; drop the fallback and its test.

### 1.6 Top-level `let`s assigned from a different file than the one declaring them — **Medium · S · Med**
- `advDraft` (declared `view.js:967`) assigned in `core.js:319` and `main.js:1088`; `heldGroups` (`view.js:583`) in `core.js:512`; `dupeStatus` (`faces.js:1669`) in `grid.js:263, 275`; `elsewhere` (`view.js:478`) in `player.js:113`.
- **Why:** invisible couplings; a rename breaks with a runtime ReferenceError only on that path.
- **Fix:** a setter beside each (`resetAdvDraft()`, `forgetGroupOrder()`, `setDupeStatus()`, `noteOtherCopies()`), or move them onto `state`.

### 1.7 Helpers living in the wrong file; the entry script is a dependency of earlier scripts — **Medium · S · Med**
- `main.js` defines `modalOpen` (used `previews.js:502, 599`), `cardMetaText`/`syncCardDetails` (`grid.js:714, 870, 129`), `FACET_NAMES`/`facetValueText` (`view.js:1152, 1276`); `nav.js:51, 61, 72` reads `baseName`/`samePath` from `player.js`. Works only because every call is after load; the comment at `index.html:845-847` ("each may only use what the ones before it define") is false for runtime use.
- **Fix:** move those helpers to `core.js`; reword the comment to "at load time".

### 1.8 Dead code — **Medium · S · Low**
- Functions referenced only at their declaration (repo-wide incl. tests/tools/html): `core.js:366` `fmtDate`; `view.js:1208` `chipToggle`; `labels.js:288` `parseTags`; `labels.js:450` `embedSelection`; `player.js:948` `nextUp`; `mobile/app.js:2776` `parseList`; `mobile/graph.js:234` `listChildren`, `:445` `itemById`, `:900` `findVideos`; root `graph.js` exports `getThumbnails`, `getDownloadUrl`, `resetRootMap`.
- Markup/CSS: `index.html:51` `#sortDirBtn`, `:81` `#volCone`, `:83` `#volWave1`; `styles.css` selectors `.cloud-tag .meta-line .folder-line .folder-where .when-labelled .source-link .label-note .folder-jump .adv-row .adv-mode-fixed`.
- Routes with no caller: see Architecture 4.9.
- **Fix:** delete.

### 1.9 mobile/app.js duplicates desktop page code beyond the vocabularies — **Medium · L · Med**
- 37 top-level functions share a name with `public/js/*` (`fmtBytes`, `starsNode`, `buildModelGroups`, `toast`…); `fmtBytes` differs by one character; `mobile/app.js:1456` re-implements `filter.js` `pendingSuggestions`. 4,338 lines / 163 functions in one module.
- **Fix:** after Architecture 4.2 gives the phone an import path, move DOM-free pieces (`fmtBytes`, `fmtDuration`, `pendingSuggestions`/`suggestedNames`, star maths) into `shared/`; split app.js by concern as the desktop is.

### 1.10 Over-exported internals — **Nice-to-have · S · Low**
- `dupe-engine.js` (`MAX_SHIFT_SEC, bits32, gapsOf, alignSound, popcount`…), `face-engine.js` (`meanOf, CROP, HARVEST`), `strips.js` (`frameCount, spritePath, adopt`), `priority.js` `MAX_HOLD_MS`, `walk-rules.js` `NEVER_WALK, STAT_BATCH`, `faces.js` `rankFor, MIN_VIDEOS`, `filter.js` `rangeMatch, choiceMatch, readValue`, `mobile/graph.js` `graphFetch, kvDel` — exported, used nowhere else, not by tests. Trim or add "exported for tests".

### Checked and found fine
Script load order (`index.html:842-855`): no eager cross-file reference to a later script; no duplicate top-level names between page scripts. Require graph is one-directional (root modules never require `server/`), no cycles. Every empty `catch {}` carries a comment. `toast()` keeps errors sticky with a dismiss button; `api()` normalises server errors. Worker protocol handlers clear `scorerWaiting` on every path. 200 HTML ids in `index.html`, all but 3 referenced; all 97 in `mobile/index.html` referenced.

---

## 2. Performance

### 2.1 Cloud strip prebuilds take the priority hold and pause all three sweeps — **Critical · S · High** [verified]
- **Where:** `public/js/previews.js:80-95` (`spriteObserver` queues a prebuild for every cloud tile within 400 px), `:379-411` (serial queue → `GET /api/sprite?…&allowCloud=1`); `server/routes.js:210-227` calls `ensureSprite(target, stat)` with no `background` flag; `server/cache.js:401` takes `priority.hold()` whenever `background` is false; `faces.js:2275`, `dupes.js:908`, `framing.js:223` park at `priority.settled()`.
- **What:** each cloud strip is ~12 s (10 range requests, 4 at a time); each takes the hold meant for "a person watching a spinner". The queue is never cleared on navigation (`grid.js:97-138` clears only `posters.queue`). In a 92 %-cloud library, a minute of scrolling the root pauses the sweeps for N × 12 s.
- **Fix:** add `background=1` to the sprite route and pass `{ background: true }` through (framing already uses that path, `server.js:204`); send it from `runPrebuild`; clear `prebuild.queue` (keep `seen`) in `renderListing`.

### 2.2 Five independent full walks of the 27k-file tree every 10–15 min — **High · M · High**
- **Where:** `framing.js:37,132-181` (10 min), `faces.js:2194,2071-2134` (15 min), `dupes.js:814,384-419` (15 min), carry-over `server/fileops.js:139-152` per root (`server.js:227-229`, every 10 min), plus `server/walk.js:334-335,400-406` re-walking a folder's subtree in the background whenever its cached walk is > 60 s old.
- **What:** ≥ 4.5 full walks per 15 min ≈ 120k+ `fs.stat` with nobody using the app; each 1.5 s idle / up to 18 s under sweep load (`walk.js:320-322`). Two `statAll`s (`files.js:73-83` vs `walk-rules.js:252-263`) and two skip lists (`files.js:42,60-64` vs `walk-rules.js:234-241`).
- **Fix:** one walk index (path → {size, mtimeMs, cloudOnly}) owned by `walk.js`, refreshed by one periodic walk (ideally `fs.watch(root, {recursive:true})` invalidation — ReadDirectoryChangesW fires on OneDrive hydrate/dehydrate), consumed by faces/dupes/framing/carryOver/listing.

### 2.3 Root listing ≈ 30–35 MB of JSON, stringified on the main thread — **High · S/M · High**
- **Where:** `server/walk.js:243-253` `listedSuggestion` ships `name, score, band, margin, runnerUp, videos, person` for every name ≥ 20 % on every video; `server/http.js:34-60` `JSON.stringify` on the event loop; page `core.js:440-465` `hydrate` × 27k.
- **What:** ~1 KB/video of suggestions (same data as the 28 MB `faces-scores.json`) → hundreds of ms of stringify during which saves and `/api/status` block, ~0.5 s gzip, then a 35 MB parse in the WebView. `margin`, `runnerUp`, `videos` are read only in hover/lineup panels (`public/js/faces.js:81-83,197-206,755-763,1313-1316`).
- **Fix:** send `{name, score, band, person}` only; fetch the rest on hover (`/api/faces/standing`); round `score` to 2 dp. See Architecture 4.12(a) for taking `suggested` out of the listing entirely.

### 2.4 `faces-scores.json` (28 MB) rewritten on every rescore and every refusal click — **High · S · High**
- **Where:** `faces.js:1262-1289` `writeScoresSoon` (5 s) → `JSON.stringify` of all `state.suggestions`; triggered by `rescore` (`:1217`, every 5 min during a sweep) and `rescoreOne` (`:999`, every `POST /api/library` with `notModels`, `routes.js:316-327`).
- **What:** 150–300 ms stall + 28 MB write per "not her" click; 28 MB parse at every launch.
- **Fix:** debounce 60 s; skip the write after `rescoreOne`; persist compactly (name index + flat arrays, drop `rank`/`runnerUp`).

### 2.5 Face harvest decodes every frame of the first 10 min and buffers 147 MB before inference starts — **High · S/M · High**
- **Where:** `face-engine.js:389-448` `frames`: `fps=1/5` after a full decode; all 120 frames (1.2 MB each) held in `held[]` until `close`, then detect/embed. `faces.js:2199-2201` already says "the ceiling is ffmpeg decoding".
- **Fix (a, S):** `-skip_frame nokey` before `-i` (5–20× less decode for typical GOPs) and `-threads 2` so the decoder stops fighting ORT's 4 threads. **(b, M):** process frames as they arrive with stdout back-pressure; peak memory 147 MB → ~3 MB. Nothing downstream depends on exact sample timing (unlike the fingerprint grid, `dupe-engine.js:66-68`).

### 2.6 `library.json` rewritten 400 ms after every sweep auto-credit — **High · S · Med-High**
- **Where:** `faces.js:708-732` `autoCredit` → `library.apply` → `library.js:506-513` `save` (400 ms) → `writeNow` (adoptDisk stat/re-read/merge, 5.7 MB stringify, rename → OneDrive upload).
- **What:** a night of 3,000 profiles with a third auto-credited ≈ 1,000 rewrites ≈ 5.7 GB uploaded.
- **Fix:** `save({ lazy: true })` with a 30–60 s debounce for sweep-originated edits; user edits keep 400 ms; the shutdown flush covers the tail.

### 2.7 The scorer's incremental path is dead during a sweep — **High · M · Med**
- **Where:** `faces.js:1124-1139` posts the whole matrix and forces `cast.cast = false` whenever `scorerMatrix !== matrixBuild`; `matrixBuild` increments in `publishVectors` (`:1455`) on every `appendVectors` — i.e. always, mid-sweep. `postMessage` structured-clones the entire backing buffer (~76 MB), not the viewed rows; the worker then runs `fullPass` (`faces-scorer.js:167-220`, ~20 s) instead of `updateColumns` for the one or two centroids that moved.
- **Fix:** an `append` message carrying only new rows (transferable); worker extends `V`/`topIdx`/`topScore`, scores only the new rows, then `updateColumns(changed)`. Or back `store` with a `SharedArrayBuffer` (Architecture 4.8).

### 2.8 Local strip build spawns 12 processes per video, serially — **Medium · M · Med**
- **Where:** `server/cache.js:437` (ffprobe), `:446-466` (10 sequential `ffmpeg` seeks, each re-opening the file), `:480-488` (tile pass over 10 JPEGs); same in `strips.js:142-169`.
- **What:** ~0.6–1.2 s of process start-up per strip × 77k strips.
- **Fix:** one ffmpeg with ten `-ss T -i file` inputs and `hstack=inputs=10` → `-frames:v 1 out.jpg`; keep the per-frame path as fallback.

### 2.9 `suggestions.json` (12.8 MB) uploaded to OneDrive every 5 min during a sweep, changed or not — **Medium · S · Med**
- **Where:** `faces.js:494,593-662` `digestSoon` → `writeDigestNow` → `writeWhole` into the sync root, then `writeLineups` (1.75 MB). ≈ 150 MB/h of upload.
- **Fix:** hash the body (or a dirty flag) and skip identical writes; `[name, score, band, person]` tuples (≈ 40 % smaller).

### 2.10 Directory walk is serial across folders — **Medium · S · Med**
- **Where:** `server/files.js:97-127` `await walk(full, depth+1)` inside the entry loop; same shape in `faces.js:2080-2119`, `dupes.js:393-415`, `framing.js:143-170`. The 64-way `statAll` only fills in folders with ≥ 64 videos.
- **Fix:** bounded concurrency across child directories (≈ 8 in flight), concatenating in directory order so queue order is unchanged.

### 2.11 Listing hot path repeats per-video work ×27k — **Medium · S · Med**
- **Where:** `server/walk.js:37-47` `sweepState` calls `faces.decorate` + `cacheName` per video; `filterView` (`:151-172`) and `countUnderFolders` (`:302`) again; `path.resolve(v.path).toLowerCase()` in three places (`:86, :446, :294`); the subfolder tally (`:89-131`) is O(folders × videos) `startsWith`. `faces.decorate` → `creditScores` (`faces.js:1727-1747`) allocates a 512-float centroid per credited name, and the cache is invalidated wholesale every rebuild (`centroidsBuilt++`, `:799`).
- **Fix:** compute decorate/cacheName/lowercased path once per video; bucket videos by first path segment for the folder tally.

### 2.12 ONNX inference shares the 4-thread libuv pool with all file I/O — **Medium · S · Med (measure)**
- **Where:** `face-engine.js:145-152,234-251,340-352` `session.run` occupies a libuv thread; `statAll`, `readdir` of 77k entries, gzip of 35 MB and every `readFile` queue on the same four. No `UV_THREADPOOL_SIZE` set anywhere.
- **Fix:** `process.env.UV_THREADPOOL_SIZE = '8'` as the first line of `server.js`; verify with the walk timing under a running sweep (the 2 s → 18 s gap is the symptom).

### 2.13 `/api/status` polled every 2 s; `dupes.status()` rebuilds its counts each time — **Medium · S · Low**
- **Where:** `public/js/faces.js:1488-1528`; `dupes.js:1066-1113` reduces 28k keys and recomputes group signatures per poll. `faces.status()` caches (`faces.js:2383-2408`); dupes does not.
- **Fix:** cache the tally keyed on `(light.size, pathByKey.size, groups.length, dismissed.size)`.

### 2.14 Nice-to-have
- `face-engine.js:304-328` `alignFace` creates a closure per output pixel (37,632 per crop, up to 48 crops/video) — hoist `at`. S · Low.
- `public/js/grid.js:1447-1455` `syncSelectionUI` walks every rendered card per click — touch affected paths via `cardsFor()`. S · Low.
- `server/cache.js:555-563` `cachedStripNames` re-reads the 77k-entry dir every 30 s (~10 MB Set) — TTL 5 min is safe (`noteStrip` adds what this process writes). S · Low.
- Launch parses ~50 MB of JSON serially before "core ready" (`library.js:155-205`, `faces.js:294-328,389-425,1297-1314`, `dupes.js:250-258`, `cache.js:745-750`) — mostly 2.4.
- `faces.js:1540-1614,1627-1673` `similar`/`bestOf` run 36k × 512 dot products on the main thread per player open (10–30 ms each) — fine today; move into the worker if the index doubles.

### Checked and found fine
`write-whole.js` temp+rename; `library.js` serialised writes; `createLimiter`/`ffLimit` (2–6)/`graphLimit` 6/`cloudSeekLimit` 4; `run()` 10-min timeout on every child; `frames()` 15-min and `collect()` 10-min watchdogs; `priority.hold` 3-min lease — no zombie path. Worker unref'd with 120 s timeout. `dupes.js` incremental matching and bounded print cache. Page: `CHUNK=240` paging with `IntersectionObserver`, delegated handlers, `cardIndex`/`byPath`, cached collators, `compileAdvanced` once per pass, `SPRITE_CAP` 400 / `THUMB_CAP` 1500 with revocation, one `<video>` reused, `scrub.shots` bounded, status poll backs off when idle/hidden. No `fs.*Sync` on the request path except a per-strip sidecar read and the log append.

---

## 3. Reliability & correctness

### 3.1 The record-collapse guard is blinded by `adoptDisk` — **Critical · S · High** [verified]
- **Where:** `library.js:364-388` `adoptDisk` — after merging, line 385 sets `lastWritten = Object.keys(data.records).length`; `library.js:451-467` `writeNow` runs `adoptDisk()` first (line 455) and only then compares the count against `lastWritten` (lines 462-467).
- **What:** the BIG_DROP guard only fires when *this process's* count collapsed since the last write. If the file on disk is an older version (OneDrive "Restore previous version", a sync-conflict resolution putting the cloud copy back, a second PC that was offline for a week writing its stale copy), the three-way merge treats every record present in base+ours but absent in theirs as "deleted by them" (`pick`: `tc && !oc → t`, `t === undefined`) and removes it — one-sided changes never consult `updated` — then overwrites `lastWritten` before the guard looks. The comment at `library.js:109-110` names exactly this writer as the case being protected against.
- **Scenario:** 6,000 records; OneDrive restores last week's 5,400. Within 30 s `refreshFromDisk` → `adoptDisk` → 600 records gone from memory, `lastWritten = 5400`; next save writes 5,400 with no snapshot.
- **Fix:** in `adoptDisk`, take `before = count(data.records)`; if the merged count drops by ≥ `BIG_DROP_RECORDS` or ≥ `BIG_DROP`, `await snapshot(JSON.stringify(data))` (ours, pre-merge) and log loudly before adopting; never lower `lastWritten` silently. Add the test in 3.21(1).

### 3.2 Sweeps permanently poison their stores when ffmpeg is absent or fails to spawn — **Critical · M · High** [verified]
- **Where:** `dupe-engine.js:113` `proc.on('error', () => resolve({ out: empty, err: 'ffmpeg not runnable', code: -1 }))` → `soundOf` null, `pictureOf` empty (`:128-139, 212-217`); `dupes.js:428-461` `profile` writes the row unconditionally (`writePrint`, `state.light.set`). `face-engine.js:435` `proc.on('error', () => resolve([]))`; `faces.js:1983-2010` writes `{faces: 0, people: []}`; `faces.js:2311-2318` counts it as "genuinely faceless" (2 strikes then skipped). `server.js:69-80` `checkFfmpeg` only logs; `:235` result discarded.
- **What:** an ENOENT spawn is indistinguishable from "no audio / no faces". Each sweep writes an empty print/profile **into the OneDrive sync root** and marks the key done, so the video is never looked at again on any machine.
- **Scenario:** ffmpeg dropped from PATH (winget upgrade, host launching node with a different environment, fresh PC). All three pills say "sweeping"; within hours 28k bogus entries exist and sync everywhere.
- **Fix:** gate `setEnabled(true)` for all three sweeps on `checkFfmpeg()` and show the reason in `/api/status`; in `collect()`/`frames()` propagate spawn `error` (reject or sentinel); in `dupes.profile`/`faces.profile` treat the sentinel as a failure (count it, write nothing). One-off repair: re-queue entries with `hashes.length === 0 && secs === 0` / `faces: 0` written while ffmpeg was missing.

### 3.3 Cloud-only placeholders can still be hydrated through `/api/thumb` and `/api/sprite` when Graph is unavailable — **High · S · High**
- **Where:** `server/routes.js:751-797` `/api/thumb` with `allowCloud=1` falls through to `ensureThumb` (`server/cache.js:504-535`), which runs `ffmpeg -i <local path>` with **no cloud branch**. `ensureSprite` (`cache.js:378-498`) line 420: `cloud = isCloudOnly(stat) ? await graphStreamInfo(file).catch(() => null) : null` — signed out / Graph down → `cloud` null → lines 437-466 run `getMeta` + `ffmpeg` on the placeholder; same in `getMeta` (`:133-140`).
- **Scenario:** token expired; user opens a cloud-only 4 GB file in the player (the player sends `allowCloud=1`) → full download; OneDrive marks it "always keep".
- **Fix:** `ensureThumb` gets the same cloud branch as `ensureSprite`; in `ensureSprite`/`getMeta`, when `isCloudOnly(stat)` and `cloud` is null, throw 409 `cloud-only; sign in` rather than falling back to the local path. Only `/api/availability` (`attrib +P`) may hydrate.

### 3.4 Non-atomic writers in the sync root; five atomic-write implementations — **High · S · Med**
- **Where:** `server/cache.js:42-50` `saveMetaSoon` → plain `fsp.writeFile(META_FILE)`, `:52-58` `flushMeta` → `writeFileSync`, called from both `server.js:302` (`exit`) and `routes.js:857` (`flushAll`) — two writers that can interleave; loader `:745-750` reads any parse failure as `{}`. `server/routes.js:439` `not-model-names.json` plain `writeFile`. Separate temp+rename copies in `write-whole.js:33-48`, `server/config.js:161-178`, `library.js:470-499`, and `faces.js:371-374, 1281-1284` (bare `.tmp` with a **fixed** name — `writeScores` is called from both the 5 s timer and `flush()`, so two overlapping calls share one temp).
- **Why:** a kill mid-write (Program.cs `Kill(entireProcessTree)` after the 5 s budget, `build.ps1` `Stop-Process -Force`, power loss) leaves a torn `meta.json` that OneDrive uploads and every machine loads as empty → every cloud-only video re-probed over Graph. `library.CORRUPT-2026-09-06T09-45.json` in the sync root is exactly 2,097,152 bytes — the shape of a truncated write.
- **Fix:** route all through `writeWhole`/`writeWholeSync` (two-line change in `cache.js:48,57` and `routes.js:439`); pid+seq temp names in `faces.js`; serialise `meta.json` via a `writing` promise.

### 3.5 Face snapshot pair can be left mismatched → silently wrong vectors — **High · S · Med**
- **Where:** `faces.js:330-381` `writeSnapshot` renames `.bin` (376-377) **then** `.json` (378-379); `readSnapshot` (`:294-328`) validates only `at < rows`; `loadEntries` (`:389-434`) rewrites the snapshot only if `fresh.length || !snap`.
- **What:** a kill between the two renames gives new `.bin` + old `.json`; old `at` indices address rows of the new matrix; after any earlier deletion/rekey every subsequent vector is shifted by one. Nothing detects it; "more of her" and suggestions run on shifted vectors until the next profile is added.
- **Fix:** write `rows`, `dim` and a cheap digest (byte length + FNV over first/last row) into the `.json`; on read, require `byteLength === rows*dim*4` and the digest, else discard and read the entry files.

### 3.6 `/api/action` move/copy writes anywhere; copying a cloud placeholder hydrates it — **High · S · Med**
- **Where:** `server/fileops.js:284-299` `destDir = path.resolve(body.dest)` is **not** passed through `authoriseOrThrow`; `moveFile` (`:201-212`) `mkdir(destDir, {recursive:true})`, EXDEV fallback `copyFile` (`:208`); `copyFileTo` (`:214-219`). No `isCloudOnly` check (contrast `embedTags` `:39-44`).
- **Scenario:** multi-select 40 cloud-only videos → "Copy to D:\" → 160 GB download.
- **Fix:** authorise `dest` (under a root, under `homeDir`, or an explicit allow step); for copy / cross-volume move on `cloudOnly` files return 409 unless `allowCloud`.

### 3.7 `/api/video` read-stream errors unhandled; aborted range requests leak file handles — **High · S · Med**
- **Where:** `server/http.js:451-483` `streamVideo`: `createReadStream(...).pipe(res)` with no `'error'` listener and no `res.on('close', () => stream.destroy())`.
- **What:** a read error (file freed to the cloud mid-play, EBUSY) emits on an un-listened stream → `uncaughtException` handler, response never ended, player hangs. Every seek aborts a range request; `pipe()` unpipes but does not destroy the source; the fd stays open — open handles block OneDrive dehydration and make move/rename/delete of the file just played fail with EBUSY.
- **Fix:** `stream.pipeline(readStream, res, cb)`; re-check `isCloudOnly` right before opening.

### 3.8 Record-level merge loses concurrent edits on the same video; resume-only saves distort it — **Medium · M · Med**
- **Where:** `library.js:314-356` (`newer` picks a whole record), `:569-582` (`apply`: `onlyResume` keeps `updated`), `mobile/app.js:450`, `mobile/graph.js:559-601`.
- **What:** desktop adds a tag at T1, phone sets a rating at T2 → the tag is lost (phone's record has no tag). Phone watches a video (resume changes, `updated` unchanged), desktop rates it → each side's tie-break goes to `ours`, so the file flips with whoever writes last. `updated` is wall-clock; a PC with a slow clock loses every conflict.
- **Fix:** per-field merge when both changed: list fields (`tags`, `models`, `notModels`, `marks`) as set-union-minus-base-deletions; scalars by `updated`; `resume` by the larger value independent of `updated`. Do 4.3 first so both copies change together.

### 3.9 `rekey` strands a phone edit on the old key — **Medium · M · Low**
- **Where:** `library.js:711-724` (`rekey` stamps `updated: Date.now()`, deletes the old key); merge rule "edit beats deletion" (`:322-323`). `embedTags` (`fileops.js:73-75`) and `carryOver` (`:169`) rekey.
- **What:** a phone edit on the old key resurrects it as an orphan record; the new key never receives the edit; `aliases` are recorded but never consulted during merge. `rekey` also overwrites an existing `data.records[to]` silently (`:721`).
- **Fix:** before merging, fold `theirs.records[alias]` into the record listing it in `aliases` (newer wins), drop the alias key; merge rather than overwrite on `rekey` collision.

### 3.10 `config.json` parse failure silently resets every setting, then overwrites the file — **Medium · S · Med**
- **Where:** `server/util.js:250-256` `loadJsonSync` returns the fallback on any error; `server.js:89` `{...DEFAULT_CONFIG, ...loadJsonSync(CONFIG_FILE, {})}`; `pruneRoots` → `saveConfigSoon()` (`config.js:436`) writes it back within seconds.
- **What:** loses `roots`, `labelColours`, `spareLabels`, `homeFolders`, `recentDests`, and `cacheNamesV2/cacheTidyV3` (re-triggering the migrations and the orphan recycle); the bad file is replaced. `colours.json` in OneDrive is written (`config.js:199-211`) but never read back.
- **Fix:** copy a failed file to `config.json.broken-<stamp>`, log loudly, don't write back until a setting actually changes; read `labelColours`/`spareLabels` from `colours.json` as fallback.

### 3.11 `POST /api/config` accepts any JSON type for any key, including server-owned `roots` — **Medium · S · Med**
- **Where:** `server/routes.js:88-91` copies every key in `DEFAULT_CONFIG` (`config.js:76-118`) into `state.config` unchecked, then saves. `roots`, `rootsSeen`, `cacheNamesV2`, `cacheTidyV3`, `lastDir` are server bookkeeping in the same whitelist; `isAuthorised` (`config.js:311-317`) does `roots.some(...)`.
- **What:** `{"roots":"x"}` makes every path route 500 and is persisted. The page posts whole objects (`main.js:1051`), so it can happen by accident.
- **Fix:** split `USER_SETTINGS` from `SERVER_STATE`; accept only the former; reject when `typeof body[k] !== typeof DEFAULT_CONFIG[k]`.

### 3.12 `renameFile` does not guard reserved device names or trailing dots — **Medium · S · Low**
- **Where:** `server/fileops.js:221-231` strips `<>:"/\|?*` and trims; `CON.mp4`, `NUL`, `COM1`, `name..mp4`, `"name. "` pass; Windows strips trailing dots/spaces silently so `exists(dest)` (`:226`) tests the wrong name. > 260-char paths will fail in ffmpeg and the recycle script.
- **Fix:** reject `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i` on the stem, strip trailing `[. ]+`, cap at 255; refuse > 260 with a clear message.

### 3.13 Orphaned `tmp_<key>` folders in the synced cache after a kill — **Medium · S · Low**
- **Where:** `server/cache.js:408` (`tmpDir` under `CACHE_DIR`, inside OneDrive), cleaned only in `finally` (`:495`); `strips.js:133/514`. `tidyCache` (`:635-703`) handles only 40-hex orphans.
- **Fix:** at launch, remove `tmp_*` dirs older than a few minutes; or build in `%LOCALAPPDATA%` and move only the finished strip across.

### 3.14 `process.on('exit')` calls an async flush that cannot run; shutdown budget is tight — **Medium · M · Med**
- **Where:** `server.js:302` `process.on('exit', () => { flushMeta(); faces.flush(); })` — `faces.flush()` (`faces.js:462-469`) is async, so it is dead code there. The real path is `/api/shutdown` → `flushAll` (`routes.js:856-863`), which `Program.cs:169-194` waits **5 s** on before `Kill`. The flush writes a 15 MB digest, lineups, a 74 MB `.bin`, a 4.7 MB `.json` and the 28 MB scores file.
- **Fix:** write the snapshot on a timer when `snapshotDirty` (not only at flush) so the shutdown flush is small; raise the host timeout to ~15 s; have `/api/shutdown` stop the sweeps first; remove the dead `faces.flush()` from `'exit'`.

### 3.15 `.writing`/`.tmp` temp files live in the sync root and are not fsync'd — **Medium · S · Low**
- **Where:** `library.js:471`, `write-whole.js:30`, `faces.js:376/378`; none call `fh.sync()` before `rename`. `noteStaleTemps` (`library.js:216-226`) only logs.
- **Fix:** open → write → `fh.sync()` → close → rename; name temps `~$…` or put them in a `.tmp/` subfolder.

### 3.16 `GET /api/scan` mutates authorisation; static prefix check lacks a separator — **Medium · S · Low**
- **Where:** `server/routes.js:138-144` `rememberRoot(resolved)` on a GET (reachable by `<img src="http://127.0.0.1:4321/api/scan?dir=C:\">` from an engine that omits `Sec-Fetch-Site` — defence-in-depth only; all current browsers send it). `server/http.js:386-389` `serveStatic` uses `startsWith(path.resolve(base))` without `+ path.sep`.
- **Fix:** require a custom header (`X-Video-Explorer: 1`) on every `/api/*`; make `rememberRoot` a POST; add `path.sep` to the prefix check.

### 3.17 Read-only labels never recover without a restart — **Medium · S · Low**
- **Where:** `library.js:155-205` (`readOnly` set at init only); `:520` `refreshFromDisk` returns early if `readOnly`.
- **Fix:** in `refreshFromDisk`, if `readOnly`, retry the read; clear `readOnly` on success.

### 3.18 Worker vs in-process ranking: two implementations, no equivalence test, silent fallback — **Medium · M · Med**
- **Where:** in-process `faces.js:918-982` `scoreVideo` + `:895-902`; worker `faces-scorer.js:111-120, 253-256, 264-341`. Selection `faces.js:1184-1231`; fallback on any failure (`ensureScorer` `:1037-1063`, `scorerSays` `:1028-1035`, 120 s timeout `:1156-1158`). They agree today except the worker keeps `TOP_K = 8` names per face (`faces-scorer.js:34`), so a video's 9th name ≥ `FACE_FLOOR` is listed via the fallback but not the thread. `/api/status` does not say which path ran.
- **Fix:** a test that scores a 6-video fixture through both and `deepStrictEqual`s; expose `scorer: 'thread'|'process'` in `status()` (`faces.js:2410`); long-term delete the in-process path.

### 3.19 Nice-to-have
- `keyFor` = `size:mtime` collisions: an in-app copy shares its record (intended) but deleting *either* copy runs `dupes.forget(key)`/`faces.forgetPath(key)` (`fileops.js:268-275`) for the survivor too. Only `forgetPath` if the stored path equals the deleted one; consider `utimes(dest, now)` in `copyFileTo`. S · Low.
- `server/http.js:467-474` suffix byte ranges mis-parsed (`bytes=-500` → `start=0,end=500`). Harmless for `<video>`. S · Low.
- `library.js:172` `init` accepts `records` of any truthy type; `adoptDisk` (`:375`) checks `typeof === 'object'` — do the same (plus `!Array.isArray`). S · Low.

### 3.20 Checked and found fine
`writeSerial`/`writing` chain serial on both branches; `refreshFromDisk` skipped while a save is pending — no adopt/write overlap. Refused-rename retry (tested). `adoptDisk` on a half-synced/locked/unparseable file returns false and keeps the stamp. BIG_DROP arithmetic and backup pruning (tested). Phone: `If-Match` + 412 → re-download + merge + retry ×4 (`graph.js:695-737`); refuses to save an empty library over a loaded one; `saveAndAdopt` re-merges what landed during the upload. `uncaughtException`/`unhandledRejection` logged with stacks; every `.then(` chain has a catch. `foreignRequest` Host/Sec-Fetch-Site/Origin gate; `Origin: null` refused; smoke-tested. `authoriseOrThrow` requires `root + path.sep` — no `C:\videos2` bypass — and is applied to every file-reading route. `serveShared` whitelist blocks traversal. `recycle()` is unicode-safe (BOM'd list file, `-LiteralPath`, results by index; curly quotes verified by hand on a temp file). `stillLocal` is called immediately before every sweep read (`faces.js:1987`, `dupes.js:430`, `framing.js:190`); all three walks skip placeholders; `embedTags` refuses cloud-only; `/api/video` redirects cloud-only to Graph; `/api/meta` refuses unless `allowCloud`. ffmpeg lifecycle: 10-min `run()` timeout, 10/15-min watchdogs, `Kill(entireProcessTree)` in the host. Priority hold 3-min lease. Walk epoch guard. Case-insensitivity consistent across library/routes/walk/phone. BOM-stripping loaders; per-entry loaders swallow one bad file. Empty library and missing models both start cleanly (smoke test runs with no models).

### 3.21 Test coverage gaps
Existing (53): `library.test.js` (normaliseTags, apply, rekey+aliases, BIG_DROP ×2, backup pruning, stale temps, settled), `library-merge.test.js` (4 pure cases + one disk-level merge/refresh/serial-save), `library-crash.test.js` (refused rename), `filter.test.js` (pack/unpack, fallbacks, % ranges), `carry-over.test.js` (pure), `server-smoke.test.js` (boot, `/api/config`, `/api/status`, static + shared, `/api/scan` on an empty folder, `/api/library` both shapes, 404, foreign Origin, `/api/shutdown`), `shared-drift.test.js`.

Untested or weak — minimal `node:test` sketches:
1. **adoptDisk drop guard (3.1)** — init 300 records; write a 50-record file to disk with a newer mtime; `await refreshFromDisk()`; assert `backups/library-*.json` with 300 records exists. *Currently fails.*
2. **Merge edge cases** — both delete; `updated` absent on one side; identical edit both sides; records differing only in `resume`; `marks`; `ratingScale` precedence; favourites differing only in case; a record whose `aliases` includes a key theirs edited (3.9). Run the same fixtures through the mobile copy (4.3).
3. **fileops** — `renameFile` (extension kept, collision rejected, case-only rename allowed, `CON`/trailing dot rejected once fixed); `uniqueDestination` suffixing; same-volume move; "Already in that folder"; unauthorised source → error entry; unknown op → 400; `recycle` on a temp file.
4. **authorisation** — `isAuthorised`/`clampRoot`/`collapseRoots`/`pruneRoots`: `C:\v` vs `C:\v2`, ancestor-of-home clamped, stale root expiry, home never dropped.
5. **http** — `foreignRequest` table; `streamVideo` ranges via the smoke server with a real file (`bytes=0-9` → 206, `bytes=999999-` → 416, suffix); static `..%2F` on `/`.
6. **cache** — `migrateCache` rekeys; `cachedMeta` legacy adoption; `tidyCache` recycles 40-hex orphans only (inject a fake `recycle`); `loadMetaIndex` with BOM/garbage; `ensureSprite` on cloud-only with Graph null must throw 409 (3.3).
7. **walk** — held walk under `WALK_KEEP_MS`, refresh after `WALK_FRESH_MS`, `forgetWalks()` during a walk prevents landing (stub `collectVideos`); `countUnderFolders` prefix (`C:\a\b` vs `C:\a\bc`); `slim()`.
8. **routes** — `/api/labels` rename/delete moves colours and spares; `/api/models rename` moves race/traits/tier; `/api/config POST` ignores unknown keys and wrong types (3.11); `/api/action rename` round trip; `/api/library` with an unauthorised path → error entry, not 500; `/api/scan` shape (4.5).
9. **faces store (no engine)** — `rescoreOne` on a settled/refused video; `rekey` moves entry + thumbs; `readSnapshot`/`writeSnapshot` round-trip and mismatched-`.bin` rejection (3.5); `adoptScores` rejects a different `sig`; worker ⇄ in-process equivalence (3.18).
10. **dupes** — `loadDigest` drops singletons and sets `needsMatch`; `dismissGroup`/`restoreDismissed` signature stability; `rekey` + `forget`; `walkForWork` skips placeholders.
11. **carry-over integration** — a file re-appearing with a new mtime moves the record (aliases), faces entry, print, and appends to `carried-over.jsonl`; `dry: true` changes nothing.
12. **config** — `writeConfig` serial, no `.tmp` left under rapid calls; corrupt `config.json` (3.10).
13. **write-whole** — refused rename retried, temp removed, overlapping writes use distinct temps.
14. **library misc** — `renameTag`/`removeTagEverywhere` (case-insensitive, merge on collision, `updated` bumped); `setPerformerTraits` validation; `favouriteTiers` default; `init` on invalid JSON → `readOnly` and `apply` throws 503; `ratingScale` migration doubles once and snapshots first; `rekey` onto an existing key.
15. **sweeps with ffmpeg missing (3.2)** — with PATH emptied, `dupes.profile`/`faces.profile` must write nothing; `/api/status` reports the reason.

---

## 4. Architecture

### 4.1 OneDrive conflict forks of the library are never read — **High · S · High** [verified]
- **Where:** `library.js:134-137` `resolveFile` opens only `library.json`; `adoptDisk` (`:364-388`) merges only in-place changes. On disk today: `library-DESKTOP-Q5R7O53.json` (2.6 MB, 9,168 records, 11 Sep) plus matching `faces/suggestions-…`, `faces/lineups-…`, `dupes/duplicates-…` forks, and `library.BROKEN-…` (0 bytes) / `library.CORRUPT-…` (2 MiB).
- **What:** when two PCs rewrite `library.json` whole within one sync window, OneDrive forks the loser; nothing reads it. **Checked:** the fork holds 0 records missing from `library.json` and 0 with a newer `updated`, so nothing was lost *this* time — but the next fork is unguarded, and this is the one failure mode the merge does not cover.
- **Fix:** in `library.init`, glob `library-*.json` beside `FILE`, `mergeLibraries(base, data, fork)` each, then move it to `backups/`; delete forks of the derived files (rebuilt from `faces/v/`, `dupes/v/`); sweep `BROKEN`/`CORRUPT` into `backups/`.

### 4.2 `mobile/shared/facets.js` is synced and drift-tested but never loaded — **High · S · Med**
- **Where:** `mobile/index.html:238` loads only `./app.js` (ESM); `app.js` imports only `auth.js`/`graph.js`. Hand copies: `RATING_MAX` `app.js:502`, `FACE_FLOOR` `:1434`, `STAR_POINTS` `:1832`, `TIERS` `:1872` (default tier hard-coded `:1877`), `RACES` `:2038`, `PERSON_FACETS`/traits `:2049-2055`, `keyFor` as `recordKey` `mobile/graph.js:944-946`. `shared/facets.js:19-23` is UMD with no ESM export.
- **What:** `tools/sync-shared.js` + `test/shared-drift.test.js` guarantee the copy file matches, but the phone does not use it; adding a race or tier on the desktop still silently misses the phone — the exact thing `shared/facets.js:13-17` says the file exists to prevent.
- **Fix:** `<script src="./shared/facets.js"></script>` before the module script in `mobile/index.html` (assigns onto `globalThis`); in `app.js`, `const { RACES, TRAITS, TIERS, PERSON_FACETS, RATING_MAX, FACE_FLOOR, STAR_POINTS, keyFor } = globalThis;` and delete the copies; assert `typeof FACE_FLOOR === 'number'` at boot.

### 4.3 `mergeLibraries` exists twice, byte-identical, tested once — **High · S/M · High**
- **Where:** `library.js:314-356` and `mobile/graph.js:559-600` (diffed: identical). `test/library-merge.test.js` requires only `../library.js`.
- **Why:** the one function whose copies *must* agree, or the phone and PC resolve the same conflict differently and ping-pong edits through OneDrive. A fix on one side (3.8) has no path to the other.
- **Fix:** move to `shared/merge.js` (UMD like facets); generalise `tools/sync-shared.js:21-22` from one pair to a list; loop it in `shared-drift.test.js`; `library.js` requires it, `mobile/graph.js` reads it from `globalThis` as in 4.2. Until then, make `library-merge.test.js` `import()` the mobile copy and run the same fixtures through both.

### 4.4 Non-atomic writers / five atomic-write copies — see **3.4**.

### 4.5 Listing shape is two hand-written lists (`slim()` vs `hydrate()`) — **Medium · S · Med**
- **Where:** `server/walk.js:182-186` `LISTING_DEFAULTS` (20 keys); `public/js/core.js:440-464` `hydrate` restores 15. Missing on the page: `studio`, `production`, `settled` (works only because readers test truthiness); `framed`/`printed` in neither, read as `=== true` in `filter.js:63-64`; `listedSuggestion` (`walk.js:243-253`) is a third hand-list.
- **Why:** the next default that is non-falsy (`dupeKinds: null` already needed its own branch at `slim():195`) arrives `undefined` and nothing says so; no test calls `/api/scan` with a labelled file.
- **Fix:** move `LISTING_DEFAULTS` to `shared/` (already served at `/shared/`) and have `hydrate` fill from it; a smoke test that scans a temp folder with one tagged file and asserts the keys.

### 4.6 `routes.js` carries domain rules that exist nowhere else — **Medium · M · Med**
- **Where:** `server/routes.js` 872 lines, 41 routes in one `if` chain. Inline: performer rename `392-421` (ten `library.*` calls + `faces.rebuildSoon()` ordered by hand), not-a-performer `422-447` (own file write), label add/rename/delete `341-389` (mutates `state.config` directly), the "which patch keys mean a refusal → rescoreOne" rule `303-320`, `homeFolders` filtering `164-168`, payload-shape normalisation `272-278`.
- **Why:** none is callable without HTTP, so the smoke test covers 5 routes and `tools/*.js` re-implement (e.g. `tools/xchina-relabel.js`).
- **Fix:** `library.renamePerformer(from, to)`, `library.markNotPerformer(name)`, a small `server/labels.js` for vocabulary ops; split `routes.js` by prefix into `server/api/{library,faces,dupes,media}.js` with a `[method, path, handler]` table. No framework.

### 4.7 `faces.js` (2,502 lines) is seven modules sharing one private `state`; three sweeps re-implement the same loop — **Medium · L · Med**
- **Where:** `faces.js:99-143` state bag; (a) store + snapshot `145-470`; (b) digest/lineups `470-664`; (c) centroids + scoring + worker bridge + scores cache `664-1316`; (d) similarity matrix `1317-1675`; (e) listing decoration `1675-1951`; (f) profile one video `1952-2026`; (g) sweep loop/queue/status `2027-2502`. `dupes.js` and `framing.js` each re-implement (g) under the same names (`sweepRoots`/`walkForWork`/`prioritise`/`worker`/`status`/`setEnabled`/`rootsChanged`; `server.js:159-223` wires them identically).
- **Fix:** `faces-store.js`, `faces-rank.js` (owns the worker), `faces-similar.js`, and a generic `sweep.js` (`{ roots, home, has(key), build(file, stat), name }`) used by all three. Keep the `faces.*` facade.

### 4.8 Worker message protocol is untyped, unversioned, untested; the matrix is copied, not shared — **Medium · S/M · Med**
- **Where:** sender `faces.js:1124-1133` (`vectors`), `:1142-1154` (`score`); receiver `faces-scorer.js:345-410`. `postMessage` of `v.mat` is a copy (74 MB today) every time `matrixBuild` moves (2.7).
- **Fix:** a `faces-protocol.js` with message builders required by both sides; a test that spawns the worker on a 3-row fixture; back `store` (`faces.js:1401-1430`) with a `SharedArrayBuffer`.

### 4.9 Eight API routes have no caller — **Medium · S · Low**
- `server/routes.js:121` `/api/drives`, `:490` `/api/carry-over`, `:519` `/api/graph`, `:534` `/api/dupes/status`, `:545` `/api/dupes/match`, `:598` `/api/dupes/groups`, `:609` `/api/framing/status`, `:618` `/api/faces/status` — none referenced in `public/`, `mobile/`, `tools/`, `test/`, `Program.cs` (the three `*/status` were superseded by `/api/status`; `/api/dirs` already returns drives).
- **Fix:** delete, or move tool-facing ones behind `tools/` scripts calling the modules directly.

### 4.10 Config/paths: three per-user locations, one documented wrongly — **Medium · S · Low**
- Packaged `config.json` → `%APPDATA%\Video Explorer\config.json` (**Roaming**; `Program.cs:116-117,130`, seeded from the legacy OneDrive copy `:154-158`); dev copy `server/config.js:43`; `%LOCALAPPDATA%\video-explorer\` holds snapshots, scores, `face-models/`, `logs/`, `graph-token.json`. `config.js:193-194` and `build.ps1:36-40` name the wrong folder.
- **Why:** a Roaming config with absolute `roots`/`lastDir` follows the user to a machine where they don't exist; `pruneRoots` then forgets them (`config.js:417`).
- **Fix:** one `server/paths.js` exporting `{ CONFIG_FILE, LOCAL_DIR, SYNC_DIR }` with a comment per file; move config to `%LOCALAPPDATA%` (one line in Program.cs) or state Roaming is deliberate.

### 4.11 `server/config.js` requires the three sweep modules just to broadcast root changes — **Medium · S · Low**
- **Where:** `server/config.js:19-21` requires `faces`, `dupes`, `framing`, used only in `rememberRoot` (`:450-452`); `:26-30` optionally requires `../graph` and re-exports it (consumed by `cloud.js:10`, `routes.js:23`). Config cannot be loaded or tested without the face engine; inverted layering.
- **Fix:** `config.onRootsChanged(fn)` registered from `server.js`; export `graph` from `cloud.js`.

### 4.12 Scalability of JSON-only storage — where it bites, and the cheapest next steps — **Medium now / High at 2–3× · S→M each · High**
Cost drivers (verified in code): (1) `library.json` rewrite per edit burst — linear, ≈ 250 B/record; at **~60k records (~15 MB)** a burst is ~0.5–1 s CPU + a 15 MB upload, and the phone downloads it whole on every open (`mobile/graph.js:635`) and PUTs it whole on every star press (`:705-711`). (2) Listing payload — at **~60–80k videos** the root is ~30–40 MB raw and 1–2 s of page-side parse+hydrate per navigation. (3) Face matrix — rows × 512 × 4 B (74 MB) posted as a copy; at **~100k faces** 200 MB + 200 MB transient. (4) Flat dirs — `cache/` 77k, `faces/v/` 28k; NTFS fine to ~300k, OneDrive's sync client and `readdir` on placeholders are the slow part. (5) Derived whole-file rewrites in the sync root every 5 min.

Next steps, in order, no database:
- **(a)** Take `suggested` out of the listing: serve it once per session from the digest the phone already uses, cached on the page in a `Map`; `describeVideo` keeps `people/profiled`. Halves the root listing. **S.**
- **(b)** Append-only `library.jsonl` deltas (`{key, patch, updated}`) per edit, compacted into `library.json` every N minutes / on close. Same format, same merge; per-edit cost is one line; the phone keeps reading `library.json`. **M.**
- **(c)** `SharedArrayBuffer` for the matrix (4.8); `faces-scores.json` as `Map<key, Uint16 name-index>`. **S/M.**
- **(d)** Bucket `cache/` and `faces/v/` by the first two hex chars — only past ~150k files. **M.**
- A database is justified only when the phone needs partial reads (the ~25–30 MB whole-file download on mobile data is the real ceiling); even then SQLite-over-OneDrive is worse than whole-file rename — the answer is a per-folder shard, not a DB.

### 4.13 Possible 1 ms key mismatch between phone and desktop — **Medium · S · High if true** — *unverified; needs a live check*
- Desktop `shared/facets.js:80` `Math.round(stat.mtimeMs)` (NTFS 100 ns precision); phone `mobile/graph.js:145,944` `Math.round(Date.parse(lastModifiedDateTime))` (Graph ISO string, ms precision, possibly truncated by the service). If Graph truncates sub-ms, ~half of all videos with a fractional ms ≥ .5 key one higher on the PC → the phone shows no labels and writes a second record.
- **Check:** list one folder via Graph and via `fs.stat`, compare keys. **If different:** `Math.floor` on both sides + a one-off `library.rekey` pass.

### 4.14 Nice-to-have
- `public/js/*` names don't match ownership: `faces.js` owns the status poll, `relistQuietly`, the framing/dupes pills and the labels-vocabulary call; `view.js` owns favourites/races/traits/sorting/grouping/volume; `core.js` owns `/api/availability`. Suggest `status.js` and `people.js`. M · Low.
- Three unrelated things are called `state` (`server/config.js:125`, `faces.js:99`, `public/js/core.js:30`). S · Low.
- `/api/status` is blind to which scorer path ran, `matrixBuild`, last rescore duration (`faces.js:2410-2456`). S · Low.

### Checked and found fine
Config write queue + temp/rename; root authorisation chain with 60-day expiry; `public/filter.js` is genuinely the one matcher for page and server; `shared/facets.js` used by server and page; walk cache with epoch guard and `walkVersion` via `/api/status`; boot order (port before stores, `coreReady` gate with `/api/config` exempt); worker lifecycle; three sweeps share `priority.js`; `slim()`/`hydrate()` round-trip correct for the 15 shared fields; mobile never calls `/api/*` (Graph-only), so the HTTP contract has one consumer plus `Program.cs` and the smoke test.

#### /api route inventory (`server/routes.js`) → callers
| Route | Line | Callers |
|---|---|---|
| POST /api/shutdown | 79 | `Program.cs:178`, smoke test |
| GET/POST /api/config | 84 | `core.js:497` / `main.js:1051` |
| GET /api/status | 110 | `public/js/faces.js:1503` |
| GET /api/drives | 121 | — dead |
| GET /api/dirs | 125 | `main.js:199`, `player.js:179` |
| GET /api/scan | 138 | `core.js:522`, `faces.js:1553` |
| POST /api/folders/counts | 188 | `nav.js:159` |
| GET /api/sprite | 210 | `previews.js:175` |
| POST /api/meta | 231 | `grid.js:665, 1120` |
| GET/POST /api/library | 263 | `main.js:1144` / `view.js:1310` |
| POST /api/labels | 341 | `faces.js:608` |
| POST /api/models | 392 | `grid.js:567` |
| POST /api/races · /api/favourites · /api/traits | 449 · 455 · 495 | `view.js:98, 122, 64` |
| POST /api/availability | 464 | `core.js:129` |
| POST /api/carry-over | 490 | — dead |
| POST /api/library/embed | 502 | `labels.js:470` |
| GET /api/graph | 519 | — dead |
| GET /api/dupes/status · POST match · GET groups | 534 · 545 · 598 | — dead |
| POST /api/dupes/enabled · GET files · POST dismiss · POST restore | 538 · 552 · 577 · 592 | `faces.js:1770`, `player.js:89`/`view.js:482`, `grid.js:256, 270` |
| GET /api/framing/status · /api/faces/status | 609 · 618 | — dead |
| POST /api/framing/enabled · /api/faces/enabled | 613 · 624 | `faces.js:1657, 1878` |
| GET /api/faces/standing · similar · best · lineup · crop · face | 632 · 640 · 679 · 703 · 722 · 738 | `faces.js` (various) |
| GET /api/thumb · /api/warm · /api/video | 751 · 803 · 812 | `previews.js`, `player.js` |
| POST /api/action | 835 | `player.js:7` |
| POST /api/cache/clear | 840 | `main.js:384` |

---

## 5. Developer experience

### 5.1 `package-lock.json` is git-ignored → no reproducible install — **High · S · Med** [verified]
- **Where:** `.gitignore:14-15`; `package.json:15` pins only `^1.29.0`. A fresh clone resolves `onnxruntime-node` and its 16 transitive deps to whatever is current; a runtime bump could change face vectors silently (`faces.js:196` discards the store only when `meta.model` changes).
- **Fix:** un-ignore and commit the lock (8 KB); add `"engines": {"node": ">=20"}` and `.nvmrc` `24` (5.4).

### 5.2 README contradicts the dependency and the keyboard section — **High · S · Med**
- `README.md:17-18` "No `npm install` — the server uses only the Node standard library" vs `package.json:14-16` and `README.md:645`; `server.js:5` still says "Zero npm dependencies".
- `README.md:39, 718` say plain `F5` resets the view; code `main.js:696-703` only acts on `Ctrl+F5`; the in-app sheet (`index.html:787`) agrees with the code.
- `README.md:232-234, 721-722` say arrows seek once playing and stepping needs Shift; code `main.js:713-723` steps on bare arrows, `↑/↓` seek; no Shift branch exists.
- `README.md:671` "dwell defaults to 1s" vs `config.js:90` `dwellMs: 2000`.
- `README.md:770-772` lists `public/app.js`, which no longer exists; omits `dupes.js`, `dupe-engine.js`, `framing.js`, `strips.js`, `priority.js`, `walk-rules.js`, `faces-scorer.js`, `tools/`. The keyboard table (`:714-734`) omits the whole player set (`Space/K, J, ,/., </>, L, [/], M, F, ↑/↓`), `Tab/Enter/Space`, `Ctrl+wheel`, `Shift+digit`, and the `?` sheet. There is **no section on the duplicates or framing sweeps** at all.
- **Fix:** rewrite "Run it"; regenerate Keyboard and Files from `index.html:775-820` and the tree; add a "Three sweeps" section.

### 5.3 On a machine with no OneDrive the app silently creates `~\OneDrive\.video-explorer` — **High · S · Med**
- **Where:** `server/config.js:71-74` `ENV_HOME` falls back to `path.join(os.homedir(), 'OneDrive')` whether or not it exists; `resolveHomeDir` (`:273`) returns it when the registry has no accounts; `server.js:105-108` `mkdir -p`s the cache under it; the `LOCALAPPDATA` fallbacks at `config.js:63` / `library.js:137` are unreachable.
- **Fix:** use the `~/OneDrive` guess only if it exists; otherwise fall through to `%LOCALAPPDATA%` and log it.

### 5.4 No Node version pinned — **Medium · S · Med**
- No `engines`, no `.nvmrc`; the bundled `node.exe` is whatever is on PATH at build time (`build.ps1:87-89`) — a different machine ships a different Node silently.
- **Fix:** `engines` + `.nvmrc`; `build.ps1` prints the version it bundled.

### 5.5 `build.ps1` kills the running app, never relaunches it, and can leave no build at all — **Medium · S · Med**
- **Where:** `build.ps1:29-33` stops `VideoExplorer` and its node child (no `/api/shutdown`, so no flush — contrast `Program.cs:177-179`); `:81` deletes `dist\`; `:82-83` publishes; no `Start-Process`. `$ErrorActionPreference='Stop'` (`:9`) means a publish failure aborts after `dist` is gone.
- **Fix:** POST `/api/shutdown` before stopping; publish to `dist.new`, swap on success; `Start-Process dist\VideoExplorer.exe` at the end (opt-out flag).

### 5.6 `build.ps1` copies by an explicit list; a new top-level folder is silently dropped — **Medium · S · Med**
- **Where:** `build.ps1:61-64` (root `*.js`, `public\`, `server\`, `shared\`); anything else → `MODULE_NOT_FOUND` at launch and "The local server did not start" (`Program.cs:60`).
- **Fix:** invert to `Copy-Item $source\* -Exclude mobile,tools,test,tags,.git,node_modules`; add a post-copy `node -e "require('./server.js')"` smoke with `NO_OPEN=1 PORT=0`.

### 5.7 Face models are a manual step nothing documents end-to-end — **Medium · M · Med**
- **Where:** `faces.js:176-177` expects `%LOCALAPPDATA%\video-explorer\face-models\{yunet.onnx, arcface.onnx}`; `README.md:644-651` names the folder but gives **no download source, URL or checksum**; no script fetches them. A fresh machine gets `familiar faces: off (yunet.onnx is missing …)` (`face-engine.js:104-111`).
- **Fix:** `tools/fetch-models.js` (or URLs + SHA-256 in the README); `build.ps1` warns if the folder is absent.

### 5.8 `npm install` on a clean clone pulls ~220 MB of other-platform ONNX binaries and may download CUDA packages — **Medium · M · Med**
- **Where:** `node_modules/onnxruntime-node/bin/napi-v6/` currently holds only `win32/x64` (64 MB) because it was pruned by hand (`build.ps1:69-70` comment); the lock lists `hasInstallScript: true` — `script/install.js:10-46` downloads CUDA EP binaries unless `ONNXRUNTIME_NODE_INSTALL=skip`. The whole `node_modules` is copied into the package (`build.ps1:71-76`).
- **Fix:** an `.npmrc` with the skip flag; `build.ps1` copies only `onnxruntime-node/{package.json,dist,lib,bin/napi-v6/win32/x64}` + `onnxruntime-common` + runtime deps.

### 5.9 Native host targets .NET 6 (out of support); `WindowsBase` conflict warning — **Medium · S · Low-Med**
- `VideoExplorer.csproj:6` `net6.0-windows`; `build.out` shows `NETSDK1138` and `MSB3277` on every build; the unused `Microsoft.Web.WebView2.Wpf.dll` is published. SDK 8.0.423 is installed.
- **Fix:** `net8.0-windows`.

### 5.10 Native host never notices the node child dying mid-session — **Medium · S · Med**
- `Program.cs:134` starts it; `HasExited` is checked only at shutdown (`:175, :188`). A node crash leaves a dead WebView with no message; the boot-failure dialog (`:59-61`) doesn't mention the log folder.
- **Fix:** subscribe to `Exited`; show a dialog naming `%LOCALAPPDATA%\video-explorer\logs`.

### 5.11 `Video Explorer.vbs` launches node with no clean-shutdown path — **Medium · S · Med**
- `Video Explorer.vbs:28` runs `cmd /c node server.js` hidden; stopping it is Task Manager/`taskkill`, which delivers no signal (`server.js:296-301`) and skips `'exit'` (`:302`), so `flushAll()` never runs. README documents only `start.cmd`.
- **Fix:** drop the VBS or pair it with a stop script that POSTs `/api/shutdown`.

### 5.12 `tags/` (511 PNG, 9.3 MB) and `public/icons/positions/` (519 PNG, 4.6 MB) both tracked — **Medium · S · Low**
- `tools/make-icons.js:1-26, 32` reads `tags\` and writes `public/icons/positions/`; input and output are both committed; nothing else references `tags/`.
- **Fix:** keep the generated set; move `tags/` out (or LFS) and document it.

### 5.13 `sweep*.log` files in the native folder are hand-made and stale — **Medium · S · Low**
- Nothing writes or rotates `sweep.log`, `.log.1..9`, `.log.err` (grep: zero hits; no scheduled task). They are `tools/sweep.js` stdout redirected by hand, Sep 13–19.
- **Fix:** give `sweep.js` a `--log` option writing to `%LOCALAPPDATA%\video-explorer\logs\sweep-YYYY-MM-DD.log` via `server/util.js`; delete the leftovers.

### 5.14 Graph sign-in is undocumented in the desktop README — **Medium · S · Med**
- `graph-login.js:3-4` is the only instruction; `README.md:28-32, 98-101` rely on Graph but never say how to sign in, that the token lives at `%LOCALAPPDATA%\video-explorer\graph-token.json` (`graph.js:31-32`), or that `GRAPH_CLIENT_ID`/`GRAPH_TENANT`/`GRAPH_TOKEN_FILE` exist.
- **Fix:** a "Cloud sign-in (optional)" subsection.

### 5.15 `package.json "main": "graph-login.js"` — **Medium · S · Low** — should be `server.js`.

### 5.16 Nice-to-have
- Undocumented env vars (`VIDEO_EXPLORER_LIBRARY`, `VIDEO_EXPLORER_FACE_MODELS`, `APP_WINDOW`, `VIDEO_EXPLORER_PORT` in `tools/sweep.js:43` vs `PORT` in the server, `GRAPH_*`) and tools (`sweep.js`, `find-dupes.js`, `make-icons.js`, `xchina-*`, `avjiali-*.mjs`, `japanhdv-cast.mjs`, `studio-credit.mjs`); no npm scripts for `sync-shared`, `make-icons`, `sweep`, or the native build. S · Low.
- README numeric/path inconsistencies: `:649` "174MB" vs `:805` "200MB"; `:14` "opens in your browser" (it opens an `--app` window first, `server.js:45-67`). S · Low.
- `mobile/README.md:221, 236-247` Files list stale (missing `shared/facets.js`, `make-icons.js`, icons); the `sw.js` `VERSION` bump convention (`mobile/sw.js:12`) is undocumented. S · Low.
- Dev mode in a normal browser works (`server/http.js:193-201` allows `127.0.0.1:4321`/`localhost:4321`); DevTools are enabled in the packaged app (`Program.cs:325`); neither is written down. Differences: fullscreen stays in the tab; `/api/shutdown` is never called, so `Ctrl+C` in `start.cmd` is the flush path. S · Low.
- File log rotates by day (7 files) but has no size cap; every refused foreign request is a line (`routes.js:59-63`). Observed 7–37 KB/day. S · Low.
- `build.ps1:45-58` carries the previous build's `app-src\config.json` forward (never the repo's), so a stale dev config persists; `Program.cs:157-161` seeds from `%OneDrive%` while `build.ps1:17` prefers `%OneDriveConsumer%`. S · Low.

### Checked and found fine
`npm test` 53/53 in ~4 s, fully sandboxed via env vars; drift test skips cleanly without `mobile/`. Single dependency, clean tree; the ONNX binary is located by `dist/binding.js:11` and is present in both `node_modules` and the package (win32/x64 only); NAPI v6 is compatible with Node 24. Crash handling: `uncaughtException`/`unhandledRejection` with stacks; `EADDRINUSE` gives an actionable message; 5xx route errors logged with stack; `run()` attaches `stderr` to its error; ffmpeg absence prints the winget command. Boot timing marks and `pruneRoots` audit lines give a readable launch trace. README claims verified correct: log location/retention, ffmpeg concurrency, `VIDEO_EXT` in three files, 14 backups, settings ranges, `VIDEO_EXPLORER_CACHE`/`CONFIG`, `NO_OPEN`, `PORT`, the `.video-explorer\` layout, `Ctrl+Shift+R`, and the non-player shortcuts. `.gitignore` correctly excludes `config.json`, `mobile/`, scraped HTML, `tools/manifests/`.

---

## 6. UX / accessibility

Contrast ratios were computed (WCAG relative luminance) from the tokens in `public/styles.css:2-14` and `mobile/styles.css:1-16`; alpha backgrounds composited over a mid-grey thumbnail.

### 6.1 Modals declare `aria-modal="true"` but nothing traps focus or inerts the page — **High · S · High**
- **Where:** `public/js/main.js:871-902` `watchModalFocus` moves focus in on open and back on close; no Tab wrap, no `inert`, no `aria-hidden` on `#scrollArea`/`header` (grep `inert` across `public/` and `mobile/`: none).
- **What:** with 27k focusable cards (`grid.js:730` `tabIndex = 0`) behind every dialog, Tabbing past the last control in `#tagModal`/`#advModal`/`#settingsModal` lands in the grid under the scrim; Enter plays a card while the dialog is open. Screen readers trusting `aria-modal` hide that content, so sighted-keyboard and SR users see different worlds.
- **Fix:** on open, set `inert` on `header.topbar`, `#breadcrumb`, `#foldersSection`, `#scrollArea` (and other open modals); remove on close. Or native `<dialog>.showModal()`.

### 6.2 The player's `<video>` has no `error` handler: a missing or undecodable file is a silent black stage — **High · S · High**
- **Where:** listeners on `#player` are only `play`, `pause`, `ended` (`main.js:418-422`), `durationchange`, `loadedmetadata` (`main.js:526-527`, `player.js:794`); no `error`/`stalled`/`abort` anywhere. Live previews fail silently too (`previews.js:493` `stopLive()`).
- **What:** a file deleted outside the app, or an unsupported codec, opens the modal titled "Playing" with a black stage at 0:00 and nothing else.
- **Fix:** `player.addEventListener('error', …)` → sticky toast with `player.error?.message || 'file missing or unsupported'` + a placard in the stage; on 404 from `/api/video` offer "Rescan folder".

### 6.3 Star ratings are unusable from the keyboard and unnamed to screen readers — **High · M · High**
- **Where:** `public/js/core.js:271-300` `buildStarRow`: each star is a text-less `<button>` with no `aria-label` (`title` set only in `pointermove`, `:285`); the value is `ev.clientX - box.left < box.width/2` (`:275`), so keyboard Enter/Space (`clientX = 0`) always rates a **half** star. No `role="radiogroup"`. Bites in `#batchStars` (`index.html:141`) and `#tagRating` (`:639`), which have no shortcut fallback (the player has 0–5 keys).
- **Fix:** `aria-label="Rate N"` per star, `ev.detail === 0` → whole star, Left/Right on the row stepping 0–10, `role="radiogroup" aria-label="Rating: 3.5 of 5"`.

### 6.4 In the player, label removal is mouse-only: the chip's ✕ is a `<span>` — **High · S · Med**
- **Where:** `public/js/labels.js:144-161` `span.chip-x` with a click listener; otherwise only `contextmenu` (`:158`). The fix pattern exists already: `labels.js:365-370` (`#tagModal`) and `main.js:997-1003` (active-filter strip) use `<button class="chip-x" aria-label>`.
- **Fix:** make the chip a `<span>` holding two sibling buttons (name, ✕), or add Delete/Backspace on a focused chip.

### 6.5 Sort menu is not a menu: no role, no focus on open, no arrow keys, no `aria-expanded` — **High · M · Med**
- **Where:** `index.html:30` `#sortBtn` has only `title` (compare `#groupBtn` `:66-67` with `aria-haspopup`/`aria-expanded`); `:37` `#sortMenu` has no `role="menu"` (`#groupMenu` `:75` does); `view.js:860-866` `toggleSortMenu` never focuses the menu; rows (`:811-848`) are plain buttons, the current sort conveyed only by `↓`/`↑` (`:829`). Group menu (`grid.js:1350-1391`) and the "…" menu (`:479-556`) focus the first row and handle Escape but have no Up/Down/Home/End; Tabbing out of "…" does not close it (`favPop.away` is `mousedown`-only, `:551`).
- **Fix:** mirror the group-button attributes; `role="menu"`/`menuitemradio` + `aria-checked`; focus the current row on open; arrow-key roving; close on `focusout`.

### 6.6 Desktop "Repeat" and PWA "Repeat" mean different things under the same name and icon — **High · S · Med**
- Desktop `index.html:358-359` `#playerRepeat`: repeat the *list* (per-video loop is "Loop (L)", `:291`). PWA `mobile/index.html:215` + `mobile/app.js:3784`: repeat the *video*; no listing-repeat exists.
- **Fix:** rename the PWA control "Loop this video" (matching desktop Loop), or implement listing-repeat there.

### 6.7 A filter that matches nothing leaves a blank grid with no inline message — **High · S · Med**
- **Where:** `grid.js:718-723` `renderEmptyState` checks only `state.files.length || state.folders.length`, never `state.view`; `view.js:1172-1180` says "No matches in this folder…" only as a toast that fades (`core.js:415`), leaving "Videos 0" and an empty `#grid`.
- **Fix:** when `state.files.length && !state.view.length`, render an inline "Nothing matches these filters — [Clear filters]" block.

### 6.8 Advanced-filter tri-state chips don't expose their state — **Medium · S · Med**
- **Where:** `view.js:1221-1238` `chipCycle`: state is a `+`/`−` glyph and a mouse-worded `title`; no `aria-pressed`, no announcement on cycle; `.chip.tri.out` relies on line-through + red (`styles.css:1496-1502`).
- **Fix:** `aria-label` = `"${label}: included|excluded|off"` on each cycle; announce via `#advMatch` (`index.html:453`, already live text).

### 6.9 No `prefers-reduced-motion` support — **Medium · S · Med**
- **Where:** 0 hits in both stylesheets. Infinite animations `.faces-pill.working .faces-dot` (`styles.css:2322-2323`, `faces-pulse 1.8s infinite`) and `.faces-pill.waiting` (`:2327-2328`) run in the top bar for hours; toast `rise` (`:2291`); hover previews auto-scrub 10 segments per tile pass.
- **Fix:** `@media (prefers-reduced-motion: reduce) { … animation: none; transition-duration: .01ms }` and gate `startLive()` behind the same query (or a setting).

### 6.10 Status text and PWA toasts have no live region — **Medium · S · Med**
- **Where:** desktop `#status` (`index.html:130`, set by `setStatus`, `core.js:418`) carries "Scanning…", "Moving N to…", "Writing tags…" with no `aria-live`; only `#toasts` (`:837`) is live. PWA `mobile/index.html:237-238` `#status` and `#toasts` have no `role`/`aria-live` (`mobile/app.js:148-161`); PWA error toasts are not sticky/dismissable (`:161`).
- **Fix:** `aria-live="polite"` on both status elements; `role="status" aria-live="polite"` on mobile `#toasts`; `role="alert"` + Dismiss for `kind==='err'` on mobile.

### 6.11 Performer group headings are not headings; the outline stops at h2 — **Medium · S · Med**
- **Where:** `grid.js:299-301` builds `div.group-head > div.group-line > span.group-name`. Outline: `h1.brand` → `h2 Folders/Videos` → nothing.
- **Fix:** `<h3 class="group-name">` (keep the CSS); `<section aria-labelledby>`; the fold button already has `aria-expanded` (`grid.js:315`).

### 6.12 Every card is in the Tab order with no roving index or arrow navigation — **Medium · M · Med**
- **Where:** `grid.js:730` `tabIndex = 0` on every card plus a select-mark and up to ~8 quick-bar buttons each (`grid.js:1065-1092`) → ~10 tab stops per tile, thousands per page; no arrows in `onGridKey` (`grid.js:953-968`); the sheet (`index.html:780`) advertises Tab.
- **Fix:** roving tabindex (one card at 0), arrow keys by row/column (column count from `gridTemplateColumns`), quick bar reachable as one stop inside the focused card.

### 6.13 PWA `--text-faint` fails AA on every surface — **Medium · S · Med**
- `mobile/styles.css:9` `#6e7d8c`: **4.48:1** on `--bg`, **4.10** on `--bg-elev`, **3.75** on `--bg-elev-2`; used at 11–12.5 px (`.fine :85`, `.folder-count :156`, `.adv-how :506`, `.dim :61`, `.chip-add`, unlit `.star`, `.face-no`). Desktop's `#8391a0` passes (5.87/5.37/4.92).
- **Fix:** adopt the desktop value.

### 6.14 Several non-text/UI contrasts under 3:1 — **Medium · S · Med**
- `styles.css:2330` `.faces-pill.paused { color: var(--text-faint); opacity: .6 }` → **2.67:1** at 11 px (text; needs 4.5). `styles.css:1314-1327` `.chip-x { opacity: .5 }` → ✕ **2.67:1** (icon; needs 3). Mobile `.chip-x { opacity: .6 }` (`mobile/styles.css:676`) ≈ 2.4. Control boundaries: desktop `--border-strong #4a5666` vs `--bg` **2.53**, vs `--bg-elev` **2.32**; mobile `#3a4553` vs `--bg` **1.94** — inputs (`styles.css:109-115`) and `.btn` (`:152-158`) have only this border as their boundary (fill vs page ≈ 1.2:1), so 1.4.11 fails.
- **Fix:** paused pill at opacity 1 with the word "paused"; `.chip-x` opacity ≥ .75; `--border-strong` ≥ `#5e6c7d` (≈ 3.1:1).

### 6.15 Hit targets below 24×24 — **Medium · S · Med**
- `.star` 15 px, `.stars.compact` 13.5 px (`styles.css:1253-1263`) → ~17×15 in `#batchStars`; `.face-refused button` (`:2428-2436`) ~17 px tall, the `▸ not · N` toggle likewise; `.faces-pill` (`:2300-2314`) ~22 px; mobile `.mode` buttons (`mobile/styles.css:649-657`) ~19 px. `.group-more` 28×24, `.group-fav` 26×26, `.select-mark` 24, `.chip-x` 24 pass by the minimum.
- **Fix:** `min-height: 24px` on `.face-refused button`, `.faces-pill`, `.mode`; 24 px stars in the selection bar.

### 6.16 Missing ffmpeg is only logged; the UI never says why previews are blank — **Medium · S · Med** (pairs with 3.2)
- `server.js:68-78` logs the winget line and returns false; nothing consumes it (`:235` `.catch(() => {})`). Preview failures go to `state.failed`/`stopLive()` silently. A fresh install shows black tiles and a `#status` that never explains.
- **Fix:** expose `ffmpeg: boolean` in `/api/config` or the status poll; sticky toast with the winget line + a Settings banner.

### 6.17 After a failed scan the empty block can show the wrong copy — **Medium · S · Low**
- `core.js:514-515` hides `#empty`; on error (`:552-554`) unhides it unchanged; a previous render may have written "Nothing here…" (`grid.js:722`), which then shows under a "Folder not found" toast instead of the onboarding copy (`index.html:171-172`).
- **Fix:** `renderEmptyState(mode)` with `'onboarding' | 'empty' | 'error'`.

### 6.18 Refusing a face suggestion on desktop depends on a hover card with a blur-timer race — **Medium · S · Med**
- `faces.js:163-183` `attachFaceHover`: the only "Not {name}" button (`#faceHoverNo`, `index.html:413`) lives in `#faceHover`, which opens on chip `focus` but closes `HOVER_OUT_MS` after `blur` (`:182`); Tabbing from the chip toward the card's buttons (at the end of the DOM, `index.html:398-416`) blurs first, so reaching the button is a race. The PWA renders a persistent ✕ `button.face-no` with `aria-label="Not {name}"` and an Undo toast (`mobile/app.js:2960-2985`).
- **Fix:** a persistent ✕ beside each desktop chip, as the PWA does, or cancel the close timer while focus is within `#faceHover`.

### 6.19 PWA dialogs and cards lack dialog/focus semantics — **Medium · S · Low-Med**
- `mobile/index.html:96, 148, 161, 193, 208`: `#adv`, `#lineup`, `#labels`, `#picker`, `#player` are plain `div.picker` with no `role="dialog"`/`aria-modal`/`aria-labelledby`; cards (`mobile/app.js:2567-2575`) have no `tabindex`; body is pinned (`mobile/styles.css:50-56`) but not inerted; `#flatBtn`, `#advBtn` (`mobile/index.html:49-50`) and `#playerAuto/#playerSound/#playerClose` (`:216-218`) rely on `title` or have no name.
- **Fix:** the desktop attribute set on each `.picker-card`; `aria-label` on icon buttons; `tabindex=0` + Enter on cards.

### 6.20 Three names for the same sweep across desktop and PWA — **Medium · S · Med**
- Pills "framing / duplicates / faces" (`index.html:121-129`); filter rows "Framing / Fingerprints / Profiling / Models suggested" (`:570-581`); headings "N profiled / All profiled" (`grid.js:385-392, 494`); PWA "Faces — from the desktop's face recognition" (`mobile/index.html:131`). So faces = Profiling = profiled = face recognition; duplicates = Fingerprints.
- **Fix:** one noun per sweep (Framing / Duplicates / Faces) everywhere.

### 6.21 Nice-to-have
- Sort vocabularies differ (desktop `index.html:41-49` vs PWA `mobile/index.html:38-47`: "Length" for Duration, plural Models/Tags, different order, no Match %). S · Low.
- Dark theme only (`styles.css:18` `color-scheme: dark`; no `prefers-color-scheme`); every size in px (~45 occurrences ≤ 12 px; mobile has 10.5 px and 10 px), so a browser minimum-font preference has no effect. M · Low.
- PWA offline states use the error style and vanish (`mobile/app.js:853, 865, 663` `kind='err'`, 3.2 s); only "· saved copy, offline" in the heading persists (`:1692`). A `warn`/`info` kind + a persistent offline strip. S · Low.

### Checked and found fine
All seven desktop modals carry `role="dialog" aria-modal="true" aria-labelledby` with a visible `<h2>` and an `aria-label="Close"` ✕; focus goes in on open and back on close; Escape unwinds one layer at a time in a sensible order (`main.js:650-669`). One global `:focus-visible` ring plus inset variants. The hover quick bar IS keyboard-reachable (`.card:focus-within .quickbar`, `styles.css:820`) with labelled `<button>`/`<a>`s; the select ring is a real button with `aria-pressed`. Player: every control has `aria-label` + `title`, Play/Pause flips, `#pbSeek` is `role="slider"` with `aria-value*` and Left/Right/Home/End; Random/Repeat/Expand/PiP carry `aria-pressed`. Group headings: fold `aria-expanded`, heart/more labelled with `aria-haspopup`, trait pills `aria-pressed`, menu rows `role="menuitem"`, refused-names toggle `aria-expanded`. Desktop toasts `role="status" aria-live="polite"`, errors `role="alert"`, sticky with a labelled ×, capped at 3. %-range inputs labelled with sane min/max/step; every SVG `aria-hidden`; tri chips add a `+`/`−` glyph so include/exclude is not colour-only. Desktop text contrast passes everywhere computed (`--text` 16.0, `--text-dim` 7.71, `--text-faint` 5.87/5.37/4.92, model chips 9.36, accent 6.64, danger 6.30, ok 9.81, `.match-mark` 13.0, `.badge-dupe` 4.93). Handled states: truly empty folder, cloud-only tiles and player, scan errors as sticky toasts, PWA sign-in expiry (401 → refresh → gate), 412 merge-and-retry with feedback, Graph 429/503 honouring `Retry-After`, read-only IndexedDB fallback that says so, "A new version is ready — Reload", PWA "Loading… / No videos here". Responsive: top-bar rows wrap, grid `auto-fill minmax(var(--card-width))` with the slider clamped 200–520, modals `min(…, 100%)` with `max-height: 92vh` and internal scroll, PWA safe-area padding and a landscape rule. Consistent across devices: tri-state chip legend, the 0–10 half-star scale (PWA doubles legacy 0–5), read-only stars on cards, tiers 1–5, `notModels` written identically.

---

## Top 10 quick wins (high impact, small effort)

| # | Item | Ref | Effort | Impact |
|---|---|---|---|---|
| 1 | Sprite route takes `background=1`; prebuild sends it and clears its queue on navigation — the sweeps stop pausing while you scroll | 2.1 | S | High |
| 2 | `adoptDisk` snapshots before adopting a merge that drops ≥ 200 records / 10 % and never lowers `lastWritten` silently | 3.1 | S | High |
| 3 | `faces.js`, `dupes.js`, `framing.js`, `library.js` log through `server/util.js` so their lines reach the daily file; log `profile()` and scorer failure text | 1.1, 1.2 | S | High |
| 4 | `ensureThumb`/`ensureSprite`/`getMeta` refuse (409) a cloud-only file when Graph can't answer instead of hydrating it; authorise `/api/action` `dest` and refuse copy/EXDEV-move of placeholders | 3.3, 3.6 | S | High |
| 5 | `meta.json` and `not-model-names.json` through `writeWhole`; pid+seq temp names for the faces snapshot/scores; serialise `meta.json` | 3.4 | S | Med |
| 6 | `streamVideo` via `stream.pipeline` so aborted seeks release the file handle and read errors end the response | 3.7 | S | Med |
| 7 | `faces-scores.json`: 60 s debounce, no write after `rescoreOne`; `library.save({ lazy })` with 30–60 s for sweep auto-credits | 2.4, 2.6 | S | High |
| 8 | Read `library-*.json` conflict forks at init, merge, move to `backups/`; delete forks of derived files | 4.1 | S | High |
| 9 | `inert` on the page behind an open modal; `<video>` `error` handler with a sticky toast and stage placard | 6.1, 6.2 | S | High |
| 10 | Commit `package-lock.json`; add `engines` + `.nvmrc`; `"main": "server.js"` | 5.1, 5.4, 5.15 | S | Med |

Next five if there is appetite: `-skip_frame nokey -threads 2` in the face harvest (2.5a); gate the sweeps on `checkFfmpeg()` and report it in `/api/status` + UI (3.2, 6.16 — M); wire `mobile/shared/facets.js` into the phone (4.2); inline "nothing matches" state + `aria-live` on `#status` (6.7, 6.10); `UV_THREADPOOL_SIZE=8` with a before/after walk timing (2.12).

Not quick, but Critical: **3.2** (ffmpeg-missing poisons the stores) is the one Critical item that is M effort; it should follow the quick wins immediately.

---

## Resolution (2026-10-23)

Every Critical, High, Medium and Nice-to-have item above was taken up after the audit, in 22 commits between `4dc78b6` and the tree this note is in. The suite went from 53 to 118 tests. Where an item was done differently from the fix the audit proposed, or scaled down, it is said here; everything not listed was done as written.

**Done differently or in part**

- **1.4 Oversized functions** — `wireEvents` split by region; `routes.js` split into `server/api/*.js` (4.6). `boot`, `attachScrub`, `renderAdv` on the phone, `buildGroupHead`, `buildCard`, `loadCore`, `ensureSprite`, `apply`, `renderAdvanced` were left whole: each is long because it does one long thing, and splitting them would have been a rename with no behaviour to test.
- **1.9 mobile/app.js** — the DOM-free pieces moved to `shared/format.js` (bytes, durations, star numbers, the suggested-names rule) and the phone loads it; the 4,300-line module was **not** split into ES modules. The split is a week of exports and imports between files with no behaviour change to hold it to.
- **2.9 suggestions.json** — unchanged digests are no longer rewritten (hash), which removes the five-minute re-uploads during a sweep. The `[name, score, band, person]` tuple format was not adopted: it would change the file the phone reads for a 40% saving on a file that is now written only when it changes.
- **3.16 GET mutates authorisation** — `/api/scan` and `/api/dirs` became POSTs and the static prefix check gained its separator. The custom `X-Video-Explorer` header on every `/api/*` was not added: the native host and the command-line tools send none, and the foreign-request gate already refuses every browser-made cross-site request.
- **4.9 Routes with no caller** — five deleted (`/api/drives`, `/api/carry-over`, `/api/graph`, `/api/dupes/match`, `/api/dupes/groups`). The three `*/status` routes the audit listed are **used**: the native host's tray tooltip polls them (`Program.cs SweepLine`). Kept.
- **4.12 (a)** — done: the listing carries no suggestions; the page holds the whole set by key from `/api/faces/suggestions` and refetches when `/api/status` reports the stamp moved. (b)–(d) are deliberately not started: the measured ceilings are not near.
- **4.13 1 ms key mismatch** — checked live over 208 files in two real folders: Graph and `fs.stat` agree on every key, and no synced file carried a fractional millisecond at all (OneDrive sets whole-millisecond times). No change needed.
- **6.9 Reduced motion** — animations and transitions off; hover previews still play on hover (that is a request) but stop cycling through the ten segments on their own.
- **6.12 Roving tabindex** — arrows, Home and End move between cards, one card is the Tab stop, the focused card's quick bar is reachable by Tab. Column count is read from the grid's computed `grid-template-columns`.
- **6.20 Sweep names** — the filter rows say Framing / Duplicates / Faces like the pills and the phone says "face sweep"; "N profiled" on a heading and "All profiled" were kept, as the word in use for the faces sweep's state.
- **6.21** — the sort vocabularies now match; the phone has an offline strip and warnings; a light theme and rem-based type were not done (a design job, not a fix).
- **5.5 / 5.6 / 5.9 / 5.10** — in the native host folder, which is not in this repository: `build.ps1` and `Program.cs` carry the changes; `VideoExplorer.csproj` targets net8.0.

**Found while writing the tests**

- A root that is a drive root (`C:\`) covered nothing under it: the prefix check appended a second separator. Fixed in `config.js`, `fileops.js` and `tree.js`.
- A group of one in the duplicates digest was dropped from the groups but still entered the light index as a fingerprinted video.
- Taking a label off every video (`removeTagEverywhere`) left empty records behind in the synced file; an edit's empty record is dropped, so now this one is too.
