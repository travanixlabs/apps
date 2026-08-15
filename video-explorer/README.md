# Video Explorer

A local file explorer for MP4 libraries with hover-scrub previews, so you never
have to open a video just to see what's in it.

## Run it

Double-click `start.cmd`, or from a terminal:

```
node server.js
```

It opens `http://127.0.0.1:4321` in your browser automatically. Set `NO_OPEN=1`
to suppress that, or `PORT=4400` to move it off the default port.

No `npm install` — the server uses only the Node standard library plus the
`ffmpeg` / `ffprobe` binaries already on your PATH.

## First use

It opens in your **default folder**, which follows the **signed-in OneDrive
account** rather than a stored path. The OneDrive client records every account
it has signed in under `HKCU\Software\Microsoft\OneDrive\Accounts`, with the
email and the folder it syncs to; the app reads that and uses the matching
folder. Move or rename the sync folder and the app follows it.

`%OneDrive%` is only the fallback, because it names whichever account was set up
first — on a machine with both a personal and a work account, that is a coin
flip. When more than one account is present the tie is broken by asking Graph
which account this app is actually signed into, so cloud thumbnails and
streaming resolve against the same drive the grid is showing.

Three ways in, differing only in where you land:

| | Folder | View |
| --- | --- | --- |
| Cold launch | default folder | left as you had it |
| `F5` | the folder you were in | filters, search and sort back to defaults |
| `Ctrl`+`Shift`+`R` | default folder | filters, search and sort back to defaults |

A cold launch should be predictable, but `F5` is what you press when you're
already somewhere and only want the page rebuilt — losing your place there is
pure cost, while a view that has got away from you is exactly what you were
trying to clear. Cold launch and refresh are told apart by the navigation type
the browser already reports; `Ctrl`+`Shift`+`R` needs only a flag on top of
that, since the folder is the sole difference.

"View" means the listing: filters, search text, sort field and direction, flatten
and the cloud toggle. Card size, hover engine, page size and the default folder
are preferences, and no refresh touches them.

Uncheck **Follow the signed-in OneDrive account** under ⚙ to pin a fixed folder
instead. Re-checking it re-resolves, and the path box goes read-only while it's
on, since the value is derived rather than chosen.

To go somewhere else for one session, paste a folder path into the bar (or use
**Browse…**) and press **Open**. Nothing is hardcoded — point it anywhere,
including a mapped drive.

## Browsing

Navigation is explorer-style: one folder level at a time. Subfolders render in
their own section **above** the videos, each showing a recursive video count and
total size, so you can see there are 5,682 videos under a folder while standing
outside it. Folder covers use the first video inside as a thumbnail. Folders
containing no videos at any depth are dimmed but still navigable.

A clickable breadcrumb runs along the top, preceded by **←** / **→** history
buttons, **🏠** for the default folder, and **↑** for the parent folder. All
three are drop targets. History behaves like a browser's:
visiting a new folder after going back discards the forward entries. Alt+← and
Alt+→ work, as do the side buttons on a mouse, and Backspace goes up a level.

**Flatten subfolders** (off by default) collapses everything beneath the current
folder into one grid. When it's off, the status bar still reports what's hidden —
*"28,392 in total below"*.

## Cloud-only files

This matters if your library lives in OneDrive with Files On-Demand. A
placeholder reports its full logical size but allocates **no blocks on disk**;
reading a single byte makes Windows download the entire file. A ~4.7 TB library
on a 930 GB drive is mostly placeholders, so anything that touches pixels has to
check first.

Detection is free: the scan already calls `stat` on every file, and
`stat.blocks === 0` identifies a placeholder exactly as reliably as the Windows
`RECALL_ON_DATA_ACCESS` attribute.

**Show Cloud Items ☁** in the toolbar is **on at every launch**, so the whole
library is listed by default — cloud files are 92% of it here, and a grid that
hid them would be showing a rounding error. Their posters come from Microsoft
Graph rather than the local bytes (see below), so they look like any other tile.

Unchecking it narrows the grid to what is downloaded — the "what can I watch
offline?" view. That's a per-session choice: it resets to on next launch rather
than quietly persisting a mostly-empty library. The hidden count is reported in
the status bar (*"47 cloud items hidden ☁"*), and folder tiles lead with what's
usable offline — *"12 downloaded of 47"*.

Hovering a cloud item does nothing — a hover must never start a 400 MB download.
The ☁ button in the hover toolbar fetches one deliberately, after a confirmation
naming the exact size. `/api/thumb`, `/api/sprite`, and `/api/meta` all refuse
cloud files unless explicitly told otherwise, so no code path can hydrate one by
accident.

Note that Windows re-dehydrates files on its own: a folder fully downloaded ten
minutes ago can be back to placeholders when Storage Sense reclaims space.

**The cache outlives dehydration.** Cache keys are path + size + mtime, and
freeing a file's bytes changes none of those — so a poster and metadata built
while a file was local stay valid forever. The cloud guard therefore blocks
*generating* pixels, never *serving* pixels already built: a cloud-only file with
a cached poster shows its thumbnail, duration, and resolution normally, at zero
bandwidth. The library becomes progressively browsable just by being used.

Hovering a cloud-only file still does nothing regardless of cache, since live
preview streams the real bytes.

## Paging and lazy metadata

Nothing is probed during a scan. An earlier build called `ffprobe` on every file
up front — for 47 cloud-backed files that took **91 seconds** and downloaded
gigabytes. The scan now only enumerates and stats, which is why it returns in
milliseconds.

The grid renders one page at a time (24 videos by default, adjustable in ⚙).
Scrolling to the bottom loads the next page automatically, and a **Load N more**
button with a count of what's left sits there too. Each page triggers exactly one
batched `/api/meta` call for the files it just rendered, so duration, resolution,
fps, bitrate, and codec fill in a moment after the tiles appear — the row reads
*"reading…"* until then. Posters load per tile on scroll; hover previews load
nothing until you actually hover.

## How previews work

Two engines, switchable in settings (⚙).

**Live video** (default) needs no pre-processing at all. Hovering a tile hands
one shared `<video>` element the real file and plays 1 second from each of 10
evenly spaced points. Only one tile is ever hovered, so a decoder pool of one is
enough — and the element is torn down on mouse-out so nothing accumulates. Mid-file
seeks resolve in 1–45ms over HTTP range requests, so previews start on the first
hover with no waiting and nothing cached.

**Cached stills** is the alternative: ffmpeg extracts 10 frames sampled at the
midpoint of 10 equal segments, letterboxes each to an identical 16:9 tile, and
stitches them into one horizontal sprite strip. Costs ~0.9s per video the first
time, then re-hovering is free and needs no decoding. Worth it for folders you
revisit constantly.

Either way each tile gets a static poster frame — a single ffmpeg seek at the 25%
mark, ~78ms — so the grid fills fast. The strip below the image marks which
segment you're on, and a badge shows `4/10 · 3:12`: segment index and its
timestamp in the source.

Posters and sprites build lazily as tiles scroll into view. **Build all previews**
warms the whole filtered set, 4 at a time.

Cache lives in `%LOCALAPPDATA%\video-explorer\cache` — deliberately outside this
folder, since the app itself sits in OneDrive and syncing thousands of
regenerable JPEGs would be wasted bandwidth. Override with the
`VIDEO_EXPLORER_CACHE` environment variable. Entries are keyed by path + size +
modified time, so an edited file regenerates and an unchanged one is never
re-encoded.

## Quick actions

Hover any tile for a toolbar in the top-right corner:

| Button | Action |
| ------ | ------ |
| ☁ | Cloud-only files only: download and build a preview |
| ⌗ | Edit tags |
| ☺ | Edit models |
| ✎ | Rename inline |
| ➜ | Move to a folder |
| 🗑 | Delete |

**Deletes go to the Windows Recycle Bin**, never a permanent unlink — a misclick
is always recoverable. Copies and moves never overwrite: a name collision
becomes `clip (2).mp4`. Move falls back to copy-then-delete across volumes.

### Drag and drop

Select any number of videos and drag them onto a **folder tile** to move them
there. Hold **Ctrl** while dropping to copy instead — the cursor shows which.
Breadcrumb crumbs and the **↑** button are drop targets too, so you can move
files up and out of the current folder, not just down into a subfolder.

Dragging a tile that isn't selected makes it the selection first, so what moves
is always exactly what's highlighted. The drag image is a single count chip
("10 videos") rather than ten thumbnails.

The current folder's own crumb is not a drop target, and the server refuses a
move whose destination is the file's existing folder — otherwise the
no-collision rule would turn a no-op drop into ten `clip (2).mp4` duplicates.

### Selecting

A **selection starts from the ring** in the tile's top-left corner, which appears
on hover and fills in once selected — there's no separate checkbox to aim at.
While a selection exists, clicking any thumbnail adds or removes it, and
shift-click extends the range; a bar under the toolbar then moves, rates, labels,
or deletes everything selected at once.

With nothing selected, **clicking a thumbnail opens the player** — the common case
gets the whole tile as its target, and the ring keeps a way to begin selecting
without playing anything. The round **▶** in the dead centre does the same. The
stream is served with HTTP range requests, so seeking doesn't download the whole
file.

### The player

It opens on the same 10-segment preview the thumbnail plays, just bigger, so a
video can be recognised before committing to watching it. Native controls stay
hidden until you press the big **▶**, which turns the preview into a real
playthrough: sound on, controls back, from the top. Nothing autoplays.

**‹ and ›** step to the previous or next video without going back to the grid,
following `state.view` — the listing as filtered and sorted, not the folder on
disk — and wrapping at both ends so neither button is ever dead. A counter in the
bottom-right corner says where you are. The bare arrow keys do the same while the
preview is showing; once playback has started they belong to the video element,
which seeks with them, so from then on stepping needs `Shift`.

The card's action bar appears in the footer, driven by one shared definition so
the two can't drift apart, with the **rating and label row** to its left — a video
can be judged while you're watching it rather than only from the grid, and an edit
in either place lands in both. The **⌗** and **☺** buttons are dropped here, since
the chips they would open a dialog for are sitting immediately to their left. One
other difference: rename prompts for a name rather than editing in place. A move
or delete closes the player instead of leaving it playing a file that no longer
exists.

## Ratings and tags

Every card carries five stars and a row of tag chips. Click a star to rate,
click it again to clear. Click **+ tag** or the **⌗** button in the hover
toolbar to edit tags; click a chip to filter by it, right-click one to remove it
from that video. With a selection active, the bar gains its own stars and a
**Tags…** button, so a hundred videos can be rated or tagged at once — and `0`
through `5` rate the selection straight from the keyboard, `T` opens the tag
editor.

Tags feed the existing filter box, so `blonde outdoor` matches a video tagged
with both even when neither word appears in its filename. **Sort → Rating** is
available too, with name as the tiebreak so the unrated bulk stays browsable.

### Where they live

Not in the video files. Writing a tag into an MP4 means rebuilding its `moov`
atom, which rewrites the whole file — 76 MB of disk for a 20-byte tag, and for a
cloud placeholder a full download followed by a full re-upload. At 92% cloud,
that is not a viable default.

So edits land in `.video-explorer\library.json` at the OneDrive sync root. That
location is deliberate: unlike the preview cache — regenerable bulk, kept out of
OneDrive on purpose — this file is a few hundred KB of irreplaceable hand-entered
judgement, and syncing it is what makes ratings appear on every device running
the app.

Records are keyed by **size + modified time**, not by path, so a rename or a move
keeps its rating and tags attached, whether done in the app or in Explorer.
Dehydration changes neither value, so a cloud file's tags survive Storage Sense
reclaiming its bytes.

### Writing them into the files

**Write into files** in the selection bar pushes ratings and tags into the videos
themselves, for players and devices that will never see this app. Tags go to the
standard `keywords` atom; the rating rides along as a freeform atom, since the
MP4 muxer drops `rating` unless `-movflags use_metadata_tags` is set.

It confirms with the real byte count first, because each file is rebuilt and
re-uploaded. Cloud-only files are refused rather than downloaded. Two details
make it cheaper than it sounds: the sidecar record follows the file to its new
size and mtime, and the cached poster and sprite are **renamed to the new key
rather than re-rendered** — verified by mtime, the same JPEG file moves across.

Reading works the other way round automatically. When a file is probed for
metadata and has no local record, any embedded tags and rating are adopted into
the sidecar. That is the return leg: tag on this machine, write into the files,
and another machine picks them up the first time it looks at them.

## Details under each preview

Filename, then duration, resolution, frame rate, file size, bitrate, and codec,
then the modified date and the subfolder it came from. Hover the folder line for
the full path.

## Toolbar

- **Flatten subfolders** — collapse everything below into one grid (junction-loop safe, 12 levels deep)
- **Filter** — matches video names, their subfolder, folder names, and **tags**; space-separated terms must all match. Prefix a term with `#` or `tag:` to match tags only — `#hd` finds what you tagged, `hd` also finds what's named that way. Clicking a tag chip fills in the `#` form.
- **Sort** — an icon in the top row, left of the filter funnel: name, date modified, size, duration, rating, or folder. Picking the field you are already on reverses it, and the icon flips so the direction reads without opening the menu. Defaults to **rating, highest first**, with everything unrated below it in name order
- **Card size** — grid tile width, 200–520px (defaults to the smallest)
- **Frame dwell** — hover advance interval, 1–5s (defaults to 1s)

### Advanced filters (the funnel)

Rating, models, tags, availability and folders, counted live against the whole
tree rather than the loaded page — the match line at the top moves as you pick,
and nothing is applied until **Apply**.

Every rating, model, tag and folder is a **three-state** control: click once to
**include** (green, `+`), again to **exclude** (red, `−`), a third time to clear
it. Exclusion is the half that used to be missing — "everything tagged `hd`
*except* what is also tagged `anal`", or a whole branch minus one corner of it —
and it needed no second column of controls, because a value is only ever in one
of the three states.

Includes and excludes are read separately: the **all / any** switch governs the
included tags, while exclusions are always all-of, since "not this" means not
this either way. Picking a folder covers everything beneath it, so excluding a
child of an included parent is how you carve out a subtree.

**An edit that breaks the filter removes the card.** Listing four stars only and
rating something 3 — from the grid or from the player — drops it from the
listing, rather than leaving it on screen contradicting the filter you are
working to. Only the edited files are re-tested, and only removal is acted on: a
full re-render would rebuild every thumbnail and lose your scroll position, and
re-sorting would make cards jump under the cursor mid-edit. If the video you are
watching is the one that goes, the player stays open and its arrows work from the
slot it vacated — forward lands on whatever slid into that slot.

## Keyboard

| Key | Action |
| --- | ------ |
| `F5` | Rebuild the page, same folder, view back to defaults |
| `Ctrl`+`Shift`+`R` | Start over: default folder, view back to defaults |
| `Alt`+`←` / `Alt`+`→` | Back / forward through visited folders |
| `←` / `→` | Previous / next video, while the player's preview is showing |
| `Shift`+`←` / `Shift`+`→` | Previous / next video once playback has started, when the bare arrows seek |
| `Backspace` | Up one folder |
| `/` | Focus the filter box |
| `Ctrl`+`A` | Select every video in the current listing |
| `0`–`5` | Rate the selection |
| `T` | Edit tags on the selection |
| `N` | Edit models on the selection |
| `Delete` | Recycle the selection |
| `M` | Move the selection to a folder |
| `Esc` | Unwind one layer: picker → player → settings → text field → selection |

Shortcuts are suppressed while a text field has focus or a dialog is open, so
typing `m` in the filter box never moves anything. The selection bar lists the
available keys so they're discoverable.

## Settings (⚙)

Default folder (whether it follows the signed-in OneDrive account, or a fixed
path), hover engine (live video vs cached stills), segments per video (2–24),
tile width
(120–640px), and an option to scrub with horizontal mouse position instead of the
timer (cached-stills mode only). Changing the engine, segment count, or tile width
rebuilds on next hover. **Clear preview cache** empties the cache directory —
everything rebuilds on demand.

## Files

```
server.js            HTTP server, ffmpeg orchestration, file operations
graph.js             Microsoft Graph: cloud thumbnails and streaming URLs
library.js           ratings and tags, keyed by size + modified time
mobile/              the phone app — see mobile/README.md
public/index.html    layout
public/app.js        grid, hover scrubbing, actions
public/styles.css    dark theme
config.json          created on first run: last folder, settings, recent destinations
```

Sprite sheets and probed metadata live in `%LOCALAPPDATA%\video-explorer\cache`.

## Notes

- Binds to `127.0.0.1` only. File reads, sprite generation, and streaming are
  restricted to folders you have explicitly opened; the folder picker can browse
  anywhere so you can choose move/copy destinations freely.
- ffmpeg runs at most `cores - 2` jobs concurrently (min 2, max 6).
- Recognises `.mp4`, `.m4v`, and `.mov`. Add extensions to `VIDEO_EXT` in
  `server.js` to widen it.
- If your videos are cloud-only OneDrive placeholders, generating a preview
  forces a full download of that file. Mark the folder **Always keep on this
  device** first if you want to avoid surprise downloads.

