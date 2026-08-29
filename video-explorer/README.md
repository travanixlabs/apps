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
| Cold launch | default folder | defaults — a launch carries nothing over |
| `F5` | the folder you were in | filters, search and sort back to defaults |
| `Ctrl`+`Shift`+`R` | default folder | filters, search and sort back to defaults |

A cold launch should be predictable, but `F5` is what you press when you're
already somewhere and only want the page rebuilt — losing your place there is
pure cost, while a view that has got away from you is exactly what you were
trying to clear. Cold launch and refresh are told apart by the navigation type
the browser already reports; `Ctrl`+`Shift`+`R` needs only a flag on top of
that, since the folder is the sole difference.

"View" means the listing: filters, search text, sort field and direction, and
flatten. Card size, hover engine, page size and the default folder are
preferences, and no refresh touches them.

**Folders shown there** (⚙) narrows the default folder to a named list — `Folder 0,
Folder 1, …` — and applies nowhere else. The sync root is the one place where its
own furniture sits beside the libraries: Documents, Music, an apps folder. Names
rather than paths, so the list survives the sync folder moving, and blank lists
everything. The server applies it, so the folder count describes what is on
screen rather than what was filtered out of it.

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

**A scan lists everything that is in the folder**, cloud items included — they
are 92% of the library here, and a grid that hid them would be showing a rounding
error. Their posters come from Microsoft Graph rather than the local bytes (see
below), so they look like any other tile.

Narrowing to what is downloaded — the "what can I watch offline?" view — is
**Advanced filters → Availability**, alongside every other way of narrowing the
listing. It used to be a toolbar checkbox as well, which meant two controls for
one question and, worse, two kinds of narrowing: the checkbox re-scanned and
changed what the folder appeared to contain, while the filter merely hid rows.
Now the heading count always describes the folder, and folder tiles still lead
with what's usable offline — *"12 downloaded of 47"*.

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
| ⌗ | Edit tags and models |
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

Every card carries five stars, its **model** names when it has any, and a row of
**tag** chips. Click a star to rate, click it again to clear. Click **+ tag** or
the **⌗** button in the hover toolbar to edit both fields; click a chip to filter
by it, right-click one to remove it from that video. Only tags carry an add chip
— two of them meant two buttons opening the same dialog, and a card with no
models says nothing rather than inviting you to name one. With a selection
active, the bar gains its own stars and a **Tags…** button, so a hundred videos
can be rated or labelled at once — and `0` through `5` rate the selection
straight from the keyboard, `T` opens the editor.

**One dialog, two sections** — Tags, then Models. They were separate dialogs
behind separate buttons, which made labelling a video two trips for two facts
that are almost always entered together. Both sections save in one request, so
there is no window where a card shows half the edit, and the cursor lands in
whichever section you opened. Models stay a separate field rather than a tag
naming convention: a performer's name colliding with a tag would make both
ambiguous, and they get their own colour on the card because a name is the thing
you scan for.

Each section lists its whole vocabulary as one-click chips, **alphabetically**,
each with its use count. Adding a tag is a lookup — "is `nurse` already in
here?" — and a word is found by name, not by rank; the count is still on the
chip for whatever it tells you. The advanced filter lists the same tags
most-used first, since narrowing a listing is the other question.

Both feed the filter box: `blonde outdoor` matches a video tagged with both even
when neither word appears in its filename, `#hd` restricts a term to tags, and
`@yuki` to models. The advanced filter has a Tags facet but no Models one — `@`
is how you narrow by performer. **Sort → Rating** is
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

## Familiar faces

Who is probably in this video, from the ones you have already named.

A performer you have credited in twenty videos is described by those twenty
videos. Average their faces and you have her, far more reliably than any single
frame of any one of them. That average is what an unnamed video is compared
against — and the comparison is a **ranking**, not a threshold: a name that beats
every other name by a clear margin is worth showing, and a raw similarity number
on its own is worth nothing.

**Nothing here ever writes a label.** It suggests; you decide.

### Where it shows up

- **Under the player** — a strip with the face it matched, the name, how alike
  they are, and one click to add it: `Wu Mengmeng 83% +`. At most four names,
  one per person the video's faces cluster into. When nothing clears the bar it
  says which of three situations that is — *Not read for faces yet*, *No usable
  face*, or *Nobody recognised* with the closest few shown dimmed and their
  scores, so a near miss looks like a near miss rather than an absence. The heading says what
  there is to do — *Looks like*, *All credited*, or *Also looks like · 2 not
  credited*. Shown on credited videos too: agreement is a confirmation, and
  disagreement is the most useful thing this can tell you.
- **In the label dialog** — the same chips beside the Models box. Clicking one
  types the name into the box rather than saving it, so **Add** and **Replace**
  still mean exactly what they say.
- **Advanced filters → Suggested models** — *profiled with matching model*,
  *profiled without matching model*, *not profiled*. Three states that cover the
  listing and do not overlap. The middle one is the work.
- **Grouped by performer** — each section says how many of that performer's
  videos have been read: `83 videos · 9 profiled`, turning green at the full set.
- **The toolbar pill** — `1,204 / 2,735 reading… · 31 cached`. It says what it
  is doing, because that is the question actually being asked of it: *reading…*
  with a pulsing dot while a file is open, *waiting for you to pause* with a
  slower one between files, *counting the library…*, *paused*, or *all
  profiled*. The count climbs as it goes, which is the plainest proof of life
  there is. The fraction is videos read out of videos on this machine; the
  second number is profiles kept for videos since freed up to the cloud, which
  still work but are not part of that denominator. Hover for the file being
  read, how many this session and at what rate, and the performer count. Click
  to pause, click again to resume.

### Is this her?

A name beside a 22px thumbnail asks to be taken on trust. Click the face on a
suggestion and the lineup opens: **this video's face on the left, hers from
other videos on the right**, each captioned with where it came from. Same person
or not is then a two-second judgement.

It also names the runner-up — on a close call, who else it nearly was tells you
as much as who it was — and offers *See her N videos* to go through the rest.

Faces most like the rest of her come first. A video that yielded only two or
three faces can have the male co-star as its biggest one, so his face ends up
standing for hers; those are shown last, dimmed, and the note says how many
there are. They are **not** hidden and **not** dropped from her average: they
are part of what the match was made against, and a lineup that quietly removes
its awkward evidence is not a lineup.

Dropping them was tried. Measured leave-one-out over 280 videos it moved top-1
by −0.4 points and top-3 by +0.3 — noise, in exchange for discarding 11% of the
evidence. One wrong face among a dozen right ones is simply outvoted, and the
averaging is cheaper than deciding who to believe.

### Why it asks per name, not per video

A video is not one performer. Credited to A with A, B and C recognised in it,
the fact worth surfacing is that **B and C are missing** — so "does any
suggestion match" would call that a match and hide it. A **match** therefore
means *every* face recognised is already named: nothing left to do. Everything
else read — a name it lacks, a wrong one, or nobody recognised at all — is the
same question until you look at it, so it sits in one pile.

On a correctly credited video the name already on it should be the **top**
suggestion. That is the shape of a healthy answer, which is why they are ordered
by score rather than by how much of the video each face fills.

### How the backfill runs

While the app is open, one video at a time, and only while nothing else is
happening. A request arriving abandons the current harvest mid-frame rather than
finishing it, so browsing never waits behind a profile.

**Credited videos are read first**, and round-robin across performers rather than
one performer at a time. The obvious order — unnamed videos first, since that is
where a suggestion is worth most — is exactly wrong: nothing can be suggested
until somebody has an average face, and averages come only from videos that
already carry a name. Six each across everyone is a working index; sixty of one
woman is one working performer. Twenty-five videos in, twenty-five performers are
represented. Then the unnamed videos it is all for, then deeper coverage.

A video takes three to five seconds. Two and a half thousand of them is a few
evenings of having the app open, and it survives being interrupted: the index is
the progress record, so a close resumes rather than restarts.

The sweep covers your **home folder**, plus any folder you have opened that is
not inside it — never anything above it. Opening a folder authorises reading it,
and one browse can easily leave `C:\Users\User` on that list; honouring that as
the outermost root turns a video sweep into a walk of the whole user profile,
through junctions like `AppData\Local\Application Data` that point at their own
ancestors and never terminate. Depth is capped at 12 and every resolved path is
visited once — the same guards the folder scanner uses.

### It never downloads anything

Only files already on this machine are ever profiled — the same cloud test the
rest of the app uses. And because the profile is keyed by **size + modified
time**, exactly as the ratings sidecar is, **freeing a file up to the cloud keeps
everything already known about it**. Dehydration changes neither size nor mtime,
so the vectors, the face pictures, and the suggestions all survive it — the same
way the sprite sheets and probed metadata already do.

### What it is under the hood

`ffmpeg` samples a frame every ten seconds (at most sixty), **YuNet** finds the
faces, each is warped onto the standard five-point template, and **ArcFace
w600k_r50** turns it into a 512-number vector. The faces within one video are
clustered, so a video with several people in it can suggest several names — and
the male co-star simply becomes his own cluster and matches nobody.

Three faces are taken from each frame rather than one. Measured over 61 videos
that costs nothing — 77.0% top-1 against 78.7% for one face, inside the noise of
that sample — and it is what makes a second and third performer nameable at all.
The line between one person and the next is 0.35 for ArcFace, measured across
271 videos: two crops of the same face land near 0.48 and two people near 0.10.
SFace's 0.55 was wrong here, and split more than half of all solo videos into two
of the same woman.

Measured on 258 held-out videos across 28 performers, every video taking a turn
as the unknown one:

| | top-1 | top-3 | truth | wrong |
|---|---|---|---|---|
| SFace | 89.9% | 94.2% | 0.77 | 0.49 |
| **ArcFace** | **96.1%** | **96.5%** | 0.74 | **0.18** |

Guessing at random would score 3.6% / 10.7%. Against the running library, on
whole videos re-read end to end rather than cached crops, the same measurement
comes out lower — around 77% top-1 and 85% top-3 — so treat 96% as the ceiling
and the high seventies as the floor. What keeps the gap off the screen is the
banding: a suggestion has to clear a margin as well as a score, and among those
that did, 261 of 268 already-credited videos agreed with their label.

ArcFace is the default for the last column as much as the first: its wrong answers sit at 0.18 where SFace's sit at
0.49, and a library full of performers the index has never seen needs that gap.
It is the difference between staying quiet and inventing a name.

Confidence is shown as a band, and **both** a score floor and a margin over the
runner-up have to pass:

| band | at least | and clear of the next name by |
|---|---|---|
| strong | 55% | 15 points |
| likely | 45% | 10 points |
| possible | 38% | 6 points |

Below 38%, or within 6 points of the runner-up, nothing is suggested. The two
gates are why the numbers look lower than a percentage usually implies: a wrong
name scores around 18% here and a right one around 74%, so 38% is already well
clear of the noise — while a high score with a close second is two performers
who look alike, and naming either would be a guess.

### Setup

Optional by construction. Without them the feature reports itself off in the log
and the rest of the app is untouched.

```
npm install                                  # onnxruntime-node
%LOCALAPPDATA%\video-explorer\face-models\   # yunet.onnx + arcface.onnx (or sface.onnx)
```

The models live outside the repo and outside the build on purpose: 174MB of
weights are not source, and they survive a rebuild where a bundled copy would be
re-copied every time. `VIDEO_EXPLORER_FACE_MODELS` overrides the location.

The index records which recogniser built it. Swap the model and the old vectors
are **discarded rather than mixed** — two models' vectors are not comparable, and
re-profiling is hours of background work where a silently wrong suggestion is
forever.

## Details under each preview

Filename, then duration, resolution, frame rate, file size, bitrate, and codec,
then the modified date and the subfolder it came from. Hover the folder line for
the full path.

## Toolbar

- **Flatten subfolders** — collapse everything below into one grid (junction-loop safe, 12 levels deep)
- **Filter** — matches video names, their subfolder, folder names, **tags** and **models**; space-separated terms must all match. **A search covers the whole subtree**: typing in a folder whose videos live in subfolders switches the scan to recursive and ticks **Flatten**, because filtering can only ever see what has been scanned — and a cloud library is exactly the one that sits in subfolders rather than in front of you. Clearing the search leaves the flatten on, rather than spending another scan to put you back where you could not find anything. Prefix a term with `#` or `tag:` to match tags only — `#hd` finds what you tagged, `hd` also finds what's named that way. Clicking a tag chip fills in the `#` form.
- **Sort** — an icon in the top row, left of the filter funnel: name, date modified, size, duration, rating, or folder. Picking the field you are already on reverses it, and the icon flips so the direction reads without opening the menu. **Every launch starts on rating, highest first**, with everything unrated below it in name order — a session can sort however it likes and that choice is still written down, it just does not decide what you see when you next open the app (the same treatment `recursive` gets)
- **Volume** — an icon right of the filter funnel, opening a slider: one master level every video opens at. The player's own slider writes back to it, so there is one number rather than a toolbar setting and a per-video one drifting apart. The icon carries the level — crossed out at zero, one wave up to half, two above it — and it is a preference, so a refresh does not reset it
- **Card size** — grid tile width, 200–520px (defaults to the smallest)
- **Frame dwell** — hover advance interval, 1–5s (defaults to 1s)

### Advanced filters (the funnel)

Rating, **tags**, **models**, source link and availability, counted live against the whole
listing rather than the loaded page — the match line at the top moves as you
pick, and nothing is applied until **Apply**. Both vocabularies are listed
alphabetically with their counts, as in the editor: a facet is chosen by looking
a word up.

Every rating, tag and model is a **three-state** control: click once to
**include** (green, `+`), again to **exclude** (red, `−`), a third time to clear
it. Exclusion is the half that used to be missing — "everything tagged `hd`
*except* what is also tagged `anal`" — and it needed no second column of
controls, because a value is only ever in one of the three states.

Tags and models are matched the same way but each facet on its own: two models
and one tag means "those models AND that tag", not one merged pool. The **all /
any** switch governs the included tags, while exclusions are always all-of, since
"not this" means not this either way.

Each of those two rows opens with **no tags** / **no models** — the same
three-state control, asking about absence rather than a value. Include it to see
only the unlabelled, exclude it to drop them; it is evaluated before any value is
compared, so "no tags" plus a tag selection matches nothing, which is what it
should. **Source link** and **Availability** are single choices rather than
cycles, since "has one" and "has none" already cover the listing between them.

Applying a filter below a folder whose videos live in subfolders **flattens the
listing first**, for the same reason a search does: a filter can only narrow what
has been scanned. There used to be a Folders facet doing that job as a side
effect of picking a branch; the breadcrumb is how you choose a branch, so it went
and the flatten stayed.

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
| `T` | Edit tags and models on the selection |
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
faces.js             familiar faces: the index, the sweep, the suggestions
face-engine.js       frames -> detect -> align -> embed (optional, needs onnxruntime)
mobile/              the phone app — see mobile/README.md
public/index.html    layout
public/app.js        grid, hover scrubbing, actions
public/styles.css    dark theme
config.json          created on first run: last folder, settings, recent destinations
```

Sprite sheets and probed metadata live in `%LOCALAPPDATA%\video-explorer\cache`.
The face index and the face pictures live beside them in `\faces` (about 10KB a
video), and the ONNX models in `\face-models`.

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

