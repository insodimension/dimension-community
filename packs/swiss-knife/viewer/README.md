# Viewer

A tabbed document viewer beside the conversation (an artifactory, doc 45): images,
PDF, HTML, Markdown, Word, PowerPoint, Excel, plain text, audio and video, rendered
without external network access in a sandboxed frame. It is one part of the Swiss Knife plugin (`../README.md`): this
folder is the deep reference. The View is `app/view` (built to `app/dist`); the MCP server is
`src/` (bundled to `app/server.mjs`). Both built files are committed.

## Tools

| Tool | Who calls it | Does |
|---|---|---|
| `view_file { path, filename?, annotate? }` | the host on a click (the plugin declares no `modelSpaces`, so no agent is offered it) | Resolves `path` through the fence and mounts the View on it. `annotate: true` picks the annotation tool up as the file opens (the drawing tool last held on a picture or a video frame, Box if none; Pick on a page, which matters for a page too large to start with it in hand) and is ignored for a kind with nothing to annotate. The tools themselves are there either way: an annotatable kind shows its bar from the pane's first frame. |
| `read_file_chunk { path, offset, length }` | the View only (`visibility: ["app"]`) | Streams a file's bytes to the View, at most 4 MiB a call. |
| `open_media { path, size, mtimeMs, token }` | the View only (`visibility: ["app"]`) | Admits a recording for HTTP range playback through a fenced loopback capability. The View generates the 192-bit token before opening, so it can cancel pending admission. |
| `close_media { token }` | the View only (`visibility: ["app"]`) | Revokes the capability, cancels pending admission and stops active streams. A token released before its open arrives is remembered and refused. Outer View teardown awaits revocation before acknowledging the host. |
| `renew_media { token }` | the View only (`visibility: ["app"]`) | The pane saying it still holds `token`; answers `{ alive }`. A lease is held on proof of life: a request for it or this call. A pane that is gone (its session switched away, its column collapsed, a reload) stops calling, so a full table can reclaim the lease after five minutes of silence. `alive: false` means the server no longer holds it and the pane opens the recording again. |
| `open_library { workspace?, query? }` | the host (the dock's Library launcher, `launch.tool` in `plugin.json`); no agent is offered it | The only library tool that carries the View (`_meta.ui.resourceUri`). Answers `structuredContent { mode: "library", workspace?, query? }` and the tab key `library` (`_meta["ai.insodimension/tab"]`), so the View pins its Library tab. |
| `library_query { q?, kinds?, tags?, workspace?, state?, starred?, shared?, sort?, cursor?, limit? }` | the View only | One keyset page: `{ items: LibraryItem[], next?, total }`. `sort` is `recent` (the default; `discarded_at` for `state: "discarded"`), `name`, `size`, `opened` or `relevance` (best match first; with no searchable text it is `recent`). `q` of three or more characters is a trigram substring match, each whitespace-separated term of three or more must match, shorter terms beside them are ignored; a `q` shorter than three is a name prefix. `tags` (at most 24) keeps the files that carry every one of them: whole-tag equality, case-insensitive for A to Z, decided in SQL by a `json_each` predicate on the row's tag list. A cursor belongs to the sort it came from and is refused for another. `limit` is 1 to 200 (default 50). |
| `library_facets { workspace?, state? }` | the View only | `{ kinds, workspaces, tags, starred, shared, discarded }` for the filter column. `tags` is `[{ tag, count }]` for the files in scope, most used first (at most 200), one entry per tag whatever its capitals. |
| `library_revision {}` | the View only | `{ revision }`: one marker, `<total_changes>:<data_version>` of the store's connection, that moves on any write to `library.db`: this process's, or another process's commit (the comment stream, a second window). The View reads it every 3 s while its document is visible and its tab is the one in front, and reloads the list in place when it moves. |
| `library_check { ids }` | the View only | Stats up to 200 files in batches of 32, marks a gone file `missing` (and a returned one `live`), refreshes size and mtime, and answers `{ items: [{ id, state, size, mtimeMs }] }`. |
| `library_update { id, title?, note?, tags?, starred?, durationMs? }` | the View only | `{ item, revision }`. `null` clears a title or note. `revision` is `{ before, after }`, the marker read either side of the write itself; every tool that records a write of the View's own (this one, `library_open`, `library_set_thumb`, `share_mark_read`) answers with one. |
| `library_stamp { path }` | the View only | A person's Add file: `{ item }`. The deny table refuses secrets; a discarded file comes back for a human add. |
| `library_discard { id, trash }` / `library_restore { id }` | the View only | `{ item, trashed, trashError?, revoked, unrevoked }`: shares revoked on their host (`unrevoked` names any the host would not revoke; they are stopped here anyway), the thumbnail deleted, and with `trash` the file sent to the OS recycle bin (never deleted outright; a failed trash is `trashError`). Restore works for 30 days. |
| `library_discard_default { id }` | the View only | `{ trash }`: the Discard dialog's box, ticked unless `git ls-files --error-unmatch` finds the file tracked. |
| `library_open { id }` | the View only | `view_file`'s answer for the indexed path (same `openViewedFile` function) with the `revision` span of recording the open. A discarded or unknown id is refused. |
| `library_thumbs {}` | the View only | `{ base }`: `<base>/<id>` serves the cached thumbnail from the loopback origin. |
| `library_set_thumb { id, data, mime }` | the View only | The View draws a poster or a PDF's first page once and saves it (at most 150 KiB; the bytes must be the image `mime` names). Answers `{ ok, revision }`, the span of the one row update after the file is written. |

The capability URL answers `GET` and `HEAD` for one lease. A `Range: bytes=` header with a single range is a 206 (a suffix range counts from the end, an end past the file is clamped); a start past the end, a zero suffix or a malformed range is a 416 with `Content-Range: bytes */size`; a unit other than bytes, a multi-range, or any `Range` on a method other than GET is ignored and the whole file answers 200. Every answer that passes the Host and Origin check carries `Access-Control-Allow-Origin: *`, so the player reads a refusal as a refusal instead of retrying a blocked fetch.

The loopback listener belongs to the MCP connection: connection shutdown, stdin EOF and startup failure close it. Removing the outer iframe does not guarantee a React unmount; the View therefore revokes its tokens, including pending admissions, in the awaited host teardown handshake.

## What `opens` declares

The plugin's `plugin.json` (one folder up) declares, beside `mcpServer`, what this viewer can open from outside
itself (`ArtifactoryDecl.opens`, doc 86 §3.2): one entry per family it really draws,
each `{ tool: "view_file", pathArg: "path", ext, mime, annotates, label }`. The engine
publishes them as the root Store fact `artifactory/opens`; a card in the thread reads it
to show an Open button and to name the handler, so nothing outside this pack hard-codes
"the viewer".

| Family | Extensions | `annotates` |
|---|---|---|
| Images | png, jpg, jpeg, gif, webp, avif, bmp, ico, svg | `marks` |
| PDF, Word, PowerPoint, Excel | pdf, docx, pptx, xlsx, xlsm | `text` |
| Markdown | md, markdown, mdx | `text` |
| Text and code | txt, log, csv, tsv, json, yaml, toml, xml, css, js, ts, py, rs, go, java, c, cpp, sh, sql and the like | `text` |
| HTML | html, htm, xhtml | `element` |
| Audio | mp3, wav, flac, ogg, oga, opus, m4a, m4b, aac, weba, mka | `timeline` |
| Video | mp4, m4v, mov, webm, ogv, mkv | `timeline` |

`annotates` is a promise the View keeps: `marks`, `text`, `element` and `timeline` are the
four models the View's annotate layer implements (`@dimension/mcp-app-kit/annotate`,
docs 85 and 88), and the host offers Annotate on a card only for a kind a declared handler
covers.
Binaries and archives are not declared: the View shows them as a file card, which is
not "opening" them. `test/manifest.test.ts` holds the declaration to the SDK validator
and to the host's own `classifyFile` / `pickHandler`.

## Opening a file

A file opens in a new tab, which is a new iframe. Nothing of it may flash: the host holds an opaque, themed surface
over the iframe from the moment the tab exists until the View's handshake completes (`ArtifactOpening` in
`@fraym/ui`, the labor-illusion steps; doc 45), and the View shows the SAME component from its very first paint
(`McpAppShell`'s fallback) until the document is ready, so the host's surface hands over to the View's without a
blank frame or a different card. The steps are bound to real stages: **Connecting** (no tool result yet), **Reading**
the file (for a document: the bytes streaming in, with the real count of bytes read and a progress line; a recording is admitted for range playback and reads nothing), **Preparing** it (the
renderer chunk, loaded while the bytes stream, and the decode). The words wait 150 ms before they appear, so a
file that opens fast shows only the ground; when the document is ready the steps are marked done and the surface
fades out over it. A View told nothing yet shows Connecting, not "Nothing open": that statement comes only after
every document was closed, or 8 s with no tool result at all. A notice about a file that is not on screen floats
over the panes instead of pushing the one the person is looking at.

## Annotating: one toolbar per kind (docs 85, 88)

The header holds the kind badge, the file name, its size and the path copy: no mode pill, no Done button. Under it
an annotatable kind shows ONE annotation toolbar (named `Annotation tools`), the same component on every kind, from
the pane's first frame until the file is known not to have opened (an error or an unavailable file leaves
nothing to mark, and no bar, list or send button under the error card). There is nothing to click before drawing.
A drawing tool or Pick wears the accent ring while it is in hand; pressing it again, or Escape, puts it down, and the
person is browsing (scrolling, zooming, pinching, playing) again: a finger has no other way off an armed overlay.

| Kind | Tools on the bar | In hand on arrival |
|---|---|---|
| Image | **Pin, Box, Circle, Arrow, Draw** (keys `1`-`5`) · **Undo, Redo, Clear** | Box, so a drag draws at once |
| Text, Markdown, PDF, Word, PowerPoint, Excel | **Comment** (`Ctrl+Alt+M`) | Comment (the one tool of a text) |
| HTML page | **Pick**, **Whole page** | Pick, unless the page is over 2 MiB (below) |
| Audio | **Moment** (`M`), **Stretch** (`I` then `O`) | nothing to arm: notes go on the waveform |
| Video | **Moment**, **Stretch** · **Pin, Box, Circle, Arrow, Draw** · **Undo, Redo, Clear** | none: pick a tool to draw |

A kind declares its annotation in one place, its entry in `app/view/annotate-modes.ts`: the mode the bar is in and,
for a kind commented on as text, the words its request to the agent uses (`Markdown document`, `PDF`, `slide` for a
PowerPoint page). The bar is never drawn by the kind. Each mode names the kit's data for the one toolbar (`markupToolGroups`,
`commentToolGroups`, the Pick and timeline groups) and the pane seats `AnnotationToolbar` with it in the
`viewer-mode-strip` slot, which sets the bar's side inset (`--dam-strip-inset`) to the header's own 12 px so the
first tool lines up with the kind badge above it. A text's one Comment tool, its shortcut and its words are the kit's
`commentToolGroups` and `COMMENT_KEY`, the same data the shared-file page (`packages/artifact-host`) draws.

What a person adds is a **note** (the list is titled Notes). There is no send button and no row under the content: the
notes stage themselves in the composer a moment after the person stops changing them, a chip there is the
confirmation, and the person presses Enter in the chat. A warning or a refusal floats over the bottom of the pane;
removing every note takes the staged request back.

## Picking on a page (doc 88)

Pick lets a person point at part of a rendered HTML page; each pick joins the next
message as the element's selector, tag, text, a few attributes, four computed styles and its
box, with the human's note. **Whole page** picks `<body>`.

The page is **never run**. The reading frame is `sandbox=""`, as always. While Pick is in
hand the View builds a second frame from the same bytes with `sandbox="allow-scripts"` only, whose
document begins with a Content-Security-Policy that admits exactly one script, the
viewer's own picker, by its SHA-256, and denies every other script, handler,
`javascript:` URL, frame, object, base, form and connection. A canary script that the policy
must refuse runs first; if it ever runs, the picker declines and the reading frame comes
back with a plain sentence. The picker reports by `postMessage`; the View checks every
message (sender, origin, a per-mount channel, a closed set of types, exact keys, bounds)
and draws the outline, label and numbered badges itself. See doc 88 section 2 for why this
is the design and why the obvious one (reading the page directly) cannot work inside the
engine's sandbox.

**Pick is in hand from the first frame the page can be read**, so there is nothing to switch on, unless the page is
larger than `PICK_FRAME_LIMIT` (2 MiB, `app/view/document-bytes.ts`; a page of exactly 2 MiB still starts with Pick in
hand). The pick frame is a second copy of the page to parse and lay out, about the cost of the reading frame again,
and the viewer opens pages up to 128 MiB, far larger than anyone points at. A larger page opens with Pick **down**: the
bar says "Large page: press Pick to choose elements" (its tooltip says why), no second copy exists, and the pick frame
is built only when the person presses Pick or the card's Annotate. Escape, or pressing Pick again, puts it down (the page
is then only read and scrolled) and the second copy goes with it; Whole page is off while Pick is down.

Known limits, stated so nobody is surprised: putting Pick down and picking it up again opens the pick frame at the
page's top (the script-free reading frame's scroll cannot be read or set; a page that opens with Pick in hand has no
swap to suffer); clicks inside a page's own `<iframe>` go to that frame and cannot be
picked; shadow-root content picks its host element; an element inside `<head>` is not
drawn and cannot be picked; a rotated element is outlined by its bounding box; a selector
that cannot be made unique is flagged with how many elements it matches.

## Recordings (doc 88)

Audio and video play in the viewer: a transport (play, the lane, the time, volume, speed),
keyboard control (Space, arrows, Home/End, `,` and `.` to step a frame). The lane under the transport is the
kit's `WaveLane` for a sound and `FilmLane` for a video (`mcp-app-kit/README.md`), and it is both the control that plays
and the place the notes sit. The annotation toolbar's **Moment** (`M`) puts a note at the playhead and **Stretch**
(`I` sets where it starts, `O` where it ends, Escape takes a half-set one back) puts one on a span; a span can also be
dragged out on the lane (Shift-drag on a waveform). A moment within a quarter second of a note that is there focuses that one instead of stacking.
Up to 24 notes. The request lists them in time order, and for video carries up to four pictures (below).

* Recordings play through HTTP byte ranges; playback does not download and base64-decode the whole
  file before opening, and has no recording-size cap. The player preloads metadata and requests
  the bytes it needs. The View's CSP allows only its server's exact loopback origin for these resources.
* The kind comes from the file's container signature (content beats a wrong name), and a
  file the viewer cannot decode says so honestly instead of showing a blank player.
* **Audio is a waveform you can comment on.** The lane draws dense rounded bars mirrored about a baseline (the played
  part in the accent colour), a click or drag seeks, and **a double-click on the wave, or the Comment button at the
  playhead, adds a note at that time with a field right there** (Enter saves, Escape cancels); Shift-drag selects a
  stretch. Notes are numbered pins on the top edge, in the order and with the numbers of the Notes list; hover or focus
  one to read it, Enter edits it. Audio has no drawing: there is no picture to draw on.
* **A waveform exists only where its cost can be bounded from the file's own bytes.** Making one decodes the whole
  recording to samples, and a container's header can lie about how long it is (a 110 KB FLAC whose header was patched
  decoded to 200 MB, a 640 KB one to 1.2 GB), and the player's `duration` is that same header's word again. So the
  decoder is handed only two kinds of file: **an uncompressed WAV** (PCM or float), judged on its own `fmt ` and `data`
  chunks checked against the bytes really there; and **a strict MP3**, whose frames are walked end to end so the length
  is counted from the bytes (an Xing header that claims ten seconds of a file holding an hour is never read). Strict
  means: the first frame is at byte 0 or exactly where a verified ID3v2 tag ends, no other container's magic
  (`OggS`, `fLaC`, `ftyp`, `RIFF`, `FORM`, EBML) is in the first 16 bytes of the audio, three frames of one stream
  follow each other and the frames run unbroken to the end (at most 16 KiB of tag after the last), the walk is
  at most 545 s, and the player's own length agrees with the count (within the larger of 1 s or 5 %). Everything else,
  Ogg, FLAC, MP4 and M4A, WebM, AIFF, raw AAC, a compressed WAV, an MP3 that is not strictly one, **gets a flat track**:
  no decode, no waveform, no cost, and no fake wave. Notes, pins and seeking work the same on it.
* **The caps.** A file over 32 MiB gets no waveform (the decode needs its own copy); samples are held at 22.05 kHz, at
  most 8 channels and 96 MiB at once, which for a stereo 44.1 kHz MP3 means about 190 s (545 s is reached only by mono
  at 24 kHz or less); after the decode the result is checked again against the same caps and against the player's
  length, and a sound that is not the one the file promised is dropped. **One decode at a time**, in a queue the whole View
  shares: a decode cannot be cancelled, so three panes opening three recordings would otherwise hold three at once. It
  starts only for the tab on screen once the file is ready and its length is known, and the work after the decode runs
  in slices of about 6 ms that give the thread back.
* **Video is a filmstrip you can draw on.** Under the picture the lane shows a time ruler and up to 48 frame
  thumbnails spaced in proportion to time (one per frame drawn 54 px tall in the video's own shape: about one per 96 px
  for widescreen, one per 30 px for a portrait recording, fewer when narrow), each shown whole, the playhead through them
  and the notes on top (a pin for a moment, a rounded square for a drawing, a bracket for a stretch); a click seeks and a drag selects a
  stretch. The thumbnails are taken lazily once the pane is ready and on screen, one after another through a silent second
  element (the player never moves), abortable, small (long edge 160 px, JPEG 0.7), each fading in as it arrives;
  a frame that cannot be taken stays a neutral placeholder and never fails the pane. They are cached per file (4 files,
  144 pictures each), so a theme change does not take them again.
* **Drawing on a frame.** The picture is an image, so the toolbar's Pin, Box, Circle, Arrow and Draw (keys `1`-`5`)
  work on it once one is picked (none starts in hand, so a click on the picture still plays and pauses it). The first
  press on the picture pauses the film, because a box on a frame that has gone is a box on the wrong picture. A drawing
  is a note on that one frame (its time is the frame's start), shows only while the playhead is on that frame, and sits
  over the picture the video actually draws (letterbox bars excluded). The Notes row reads `0:05.2 · box`; **Go to** on a drawing pauses on its frame. Escape takes back a half-set stretch first and
  then puts the tool down.
* **What a send carries for video.** Pictures are taken at send time from the silent element (long edge 768 px, JPEG
  0.82) inside the host's image caps (4 images; 2 MiB each, 4 MiB together). **Frames you drew on come first**, one
  picture per frame however many drawings are on it, with the shapes burned in and numbered by the same number the
  note has in the Notes list and the text; the slots left over go to plain moments in time order. A drawn frame with no
  room, no host image door or a frame that could not be taken goes as boxes and a time in the text, and the human is
  told.
* A recording that does not report its length is resolved with one seek; if that fails,
  marks use the time you hear and the transport says so.

## The Library view (doc 103 §4.6)

`open_library` (the dock's Library) opens a pinned **Library** tab in the View's own tab strip; an artifact opened
from it (`library_open`, dispatched exactly like a `view_file` result) becomes an ordinary document tab beside it.
The pane lives in `app/view/library/`; the grid, filter rail, item shell and thumbnail it draws are the shared
`@fraym/ui/features/media-library` module the Video space's media library uses too, and `app/view/library/` keeps only
what is about artifacts (`rail-sections.ts` builds the rail's sections from `library_facets`, `library-item.tsx` fills
the shared cell with an artifact's kind, badges and shares):

- **Filters and search.** A left rail (kinds with counts, tags, workspaces, Starred, Shared, Recently discarded) from
  `library_facets`; the search field filters as you type (80 ms debounce). Tags are a multi-select: a file must carry
  every tag picked (`filter.tags` becomes `library_query`'s `tags`), the twelve most used show first with "Show all"
  for the rest, and a picked tag stays listed and can be cleared. A tag chip on a card or row (two at most, then "+N")
  does the same as the rail entry, and never opens the file. Every list is the server's SQLite answer:
  each request carries a key, and an answer for a key that is no longer current is dropped (`query.ts`), so a slow
  older search never overwrites a newer one. Below 760 px the rail folds behind a Filters button.
- **Virtualized grid and list** (`LibraryGrid` and its math in `@fraym/ui/features/media-library`). Fixed row heights; only the rows on
  screen plus three rows of overscan are mounted, scroll work is coalesced to one animation frame, and the next
  `library_query` page (cursor paging, 200 a page) is asked for twelve rows before the loaded end. The window size is
  the same at row 30 000 of 50 000 as at row 0 (`test/library-window.test.ts`, `test/library-grid.test.ts`).
- **Thumbnails.** `<img loading=lazy>` from the `library_thumbs` origin (`<base>/<id>?v=<presentedAt>-<n>`). A video
  or a PDF (up to 48 MiB) on screen without one gets a poster drawn in the View: the video's frame at 10 % (at most
  1 s) through `open_media`, or the PDF's first page with the PDF renderer's pdf.js, encoded WebP (JPEG where WebP
  is unavailable) at most 320 px and 128 KiB, saved with `library_set_thumb`. One at a time, only for visible rows,
  cancelled when its row scrolls away (`poster-queue.ts`); a failed one is not retried this session.
- **Missing files.** The visible rows are checked with `library_check` (batches of 200, throttled to 300 ms, a row
  not again within a minute) and a gone file shows the warning mark.
- **Staying current.** The spec gives a View no server push, so `use-change-poll.ts` reads `library_revision` every 3 s
  (a read starts only when the last has settled, a hidden document or a Library tab that is not in front does not read
  and reads at once when it is shown again, with the marker it held, so a change made meanwhile is caught on that first
  read; unmount stops it). When the marker moves, the list is marked stale and `use-library-refresh.ts` re-asks for the
  pages already loaded (up to 200 rows a call, as many calls as pages, so a list scrolled to row 600 is still 600 rows)
  and swaps them in without the loading bar, and only while the tab is in front; the selection, the scroll position
  (the grid scrolls to the selected row only when the selection moves to another row, never because a refresh shifted
  its index), an open artifact page (its shares, comment and unread counts, title and star) and the filter rail's counts
  follow. A refresh waits for a page in flight and the next page waits for it; a new filter drops it (`query.ts`, the
  same key as any answer); one that fails keeps the rows on screen and is tried again on the next beat. The open
  Comments sheet refetches when the item's comment or unread count moves. The View's own writes do not reload the list:
  each answers with its `revision` span (`src/library/revision.ts`), and the poll takes the span's `after` as the marker
  it holds only when `before` is the marker it last read and no other connection committed inside the span. A comment
  ingested, or a commit from another process, before or during the write still moves the marker and still reloads.
- **Artifact page** (`library/artifact-page.tsx`). Clicking or Enter on a card opens the file on its own page, drawn by
  the same document renderer as a tab. One bar on top: back to the Library, the name (rename in place), star, and View,
  Comments (count and unread dot), Share and Details, each named by its text at every width (visually hidden below `sm`, with a tooltip). Comments, Share and Details open as sheets under the bar, never a
  side panel. Details: "File details" (type, size, the containing folder with the full path on hover and a copy
  button, workspace, who added it, "Made in" for a file an agent presented or stamped (the session's title from `ai.insodimension/session/describe`, or `…` and the id's last eight characters when no title comes back, with Copy and an Open button that asks the host for that session through `ai.insodimension/session/open`; both verbs sit under the `session:open` grant the Viewer artifactory declares and are used only when the host offers them), dates), "Description" with tags (`library_update` on blur or Enter), and Discard…
  or Restore. Share: "Who has access" (one row per live link naming who it lets in, its role, expiry and where it
  lives, with Copy link and Manage access; never the URL; a hosted link whose file changed since its version also says
  "The file changed since you shared it." and offers Update link, `share_new_version`, in the row) and Share…. Comments: every thread in place order,
  each row wearing its author's face and its number as on the file; picking one closes the sheet and opens it where it sits.
- **Shared comments on the file.** People's comments are drawn on the artifact by the annotation kit's comment layer:
  marks wearing the commenter's face (initials on a colour their name picks) on the picture or page, on the timeline lane at their time, drawings on the frame at their time and
  highlighted passages (`artifact-threads.ts` groups a link's comments by anchor into threads). Clicking a mark seeks
  there and opens its thread: author, time, body, and a reply field that posts through `share_reply` with the
  thread's anchor so the reply joins it. New ones stay highlighted while shown and are marked read
  (`share_mark_read`). The owner's own annotation for the agent works on the page as in a tab.
- **Discard** explains that the artifact leaves the library and its links stop working; "Also move the file to the
  Recycle Bin/Trash" starts at `library_discard_default`'s answer (ticked unless git tracks the file).
- **Share.** "Where the link lives" is three choices, each one card: **Dimension cloud** (default when it answers:
  an encrypted copy on Dimension's server, always on, the server's `maxDays`), **This computer** (nothing uploaded;
  its "Only while it is on" chip's tooltip says the link opens only while the computer is on and Dimension runs), and
  **Your own server** (each paired host by name; with none, one card whose "Ask an agent to set it up" sends
  `OWN_SERVER_PROMPT` to this conversation through `ui/message`, and whose field takes the pairing link the agent
  hands back). A choice that cannot take the file says why on its card (not answering, too large, turned off by an
  administrator). "Who can open it" is Anyone with the link, with Can comment or Can only view; "Only people I add"
  and the people field appear only on a server with sign-in. "Link expires" never passes `maxDays`. Nothing is made
  until Create link, which shows `share_progress` (polled every 250 ms) in the footer, then copies the link and keeps
  it on screen. An existing link opens the same dialog with the link to copy, where it lives, and access, role and
  expiry that apply at once through `share_update`; ⋯ holds Update link (`share_new_version`) and Stop sharing
  (`share_revoke`); a hosted link whose file changed since its version shows "The file changed since you shared it."
- **Keyboard.** `/` search, arrows / Home / End / PageUp / PageDown move, Enter opens, `s` stars, Delete discards,
  Escape closes an open sheet, then the artifact page; ArrowDown or Enter in the search field moves into the grid.

## Sharing (doc 103 §5)

`src/share/` is the share client. `startShareRuntime` (started with the server, closed with its connection) owns
everything that runs in the background; `registerShareTools` mounts the app-only tools the Library View calls
(`visibility: ["app"]`: no model is ever offered one, and publishing off the machine stays a human click).

| Tool | Does |
|---|---|
| `share_hosts {}` | `{hosts, p2pAllowed}`. Each host: `{id, kind: p2p\|self\|company\|dimension, name, baseUrl, status: ok\|unreachable\|unauthorized, policy?, oidc, managed}`; the status and policy are read from the host's `/.well-known/dimension-artifacts` and `GET /api/v1/ping` and cached 30 s. Never a token. |
| `share_host_add {pairing}` or `{url, token?, kind}` | Reads the discovery document, refuses a relay-only address, proves the token with `GET /api/v1/ping`, then saves the host. A pairing link is `https://<domain>/pair#t=<token>`. |
| `share_host_remove {id}` | Refused for a `managed` host. |
| `share_create {artifactId, host, audience, expiresInDays?, allowComments}` | Resolves when the link exists: `{share: ShareSummary & {link, outcome}}`. An artifact that already has a live link on the same host for the same audience gets that link back, not a second one: `outcome` is `updated` when a hosted link's file changed since its last version and was published as the next version (comments stay on the link), `unchanged` otherwise, and `created` for a new link. The link carries the key; it is returned to the View only and never logged. A concurrent `share_progress {artifactId}` answers `{phase: sealing\|uploading\|done\|failed, sent, total, error?, shareId?}` (`sent`/`total` are sealed bytes). If the call outlives the host's tool timeout the upload keeps running and the `done` progress names the `shareId` for `share_link`. |
| `share_update`, `share_new_version`, `share_revoke`, `share_link` | Change audience/expiry/comments, seal the current file as the next version (same key, new prefix), revoke, read the link again. |
| `share_comments {artifactId}`, `share_reply`, `share_mark_read` | Read (after a bounded catch-up from every live share), reply as `displayName` from `hosts.json` (else the OS user name), mark read. |

- **`<home>/artifacts/hosts.json`.** `{relay?, displayName?, policy?: {only?: [hostId], p2p?: boolean}, hosts: [{id, kind, name, baseUrl, token?, managed?}]}`,
  validated with zod and written atomically with mode `0600` on POSIX. IT writes `managed: true` hosts and a
  `policy`: with `only` set, every other host is hidden and cannot be added, `p2p` defaults to off, and a managed
  host cannot be removed from the UI. Tokens stay in this file: they are not in any tool answer, error or log.
  Plain `http` is accepted for this computer only.
- **Upload.** The file is read 1 MiB at a time on one open handle and sealed with ASP v1 as it goes (a file is never
  held in memory). A share is created, its manifest PUT, then the chunks with at most four in flight; a chunk is
  retried with jittered backoff on a network error or a 5xx/429 (five attempts), and a chunk the host already holds
  is never sent again: after a failure the same `share_create` resumes the same remote share in the same process,
  and a `409 incomplete` commit re-sends exactly the chunks the host names. The sealed manifest is kept and
  re-sent byte for byte (its nonce is fixed per version, so it is never sealed twice). A file that changes while it
  is read fails the share. The host's policy is checked first (`audienceAllowedBy`, `maxBytes`, `maxDays`, sign-in
  needs OIDC) and refused with the host's own words before anything is created.
- **From this computer.** `p2p-server.ts` answers the read half of the host API (`GET` share, manifest and chunks
  with `Range` and `HEAD`) from the original file, sealing a chunk when asked and keeping the last 16 MiB in memory.
  There is no listener: requests arrive only as frames from the relay tunnel (`tunnel.ts`, the protocol is
  `@dimension/artifact-host/tunnel-protocol`). Each request resolves the share row (so a revoke or a discard made
  by the agent's tool in another process answers 410 at once), re-runs the fence on the file and compares the real
  path with the indexed one. A version is fixed by `(size, mtime)`: when they change the share moves to the next
  version with a fresh prefix, persisted in `<home>/artifacts/p2p/<shareId>.json` with the sealed manifest, so a
  restart serves identical bytes and never seals a manifest twice under one nonce. The tunnel runs only while a
  live, unexpired P2P share exists; it re-registers as the same tunnel (`<home>/artifacts/tunnel.json`, mode `0600`)
  after a drop or a restart, announces every non-revoked share after each change, streams a response body only
  within the credit the relay grants, and treats `bad_token`/`unknown_tunnel` as the end of that tunnel: its links
  are marked revoked and the next P2P share registers a new one.
- **Comments.** One event stream per host (`POST /api/v1/events`, up to 200 shares each, at most 8 streams), with the
  tunnel's own stream for P2P shares, reconnecting with the last comment id per share (read from the library, so it
  survives a restart). Each comment is opened with the key derived from the share's content key and written with
  `library.comments.upsert`; one that does not open is skipped. An open Library sees the write on its next
  `library_revision` read (see Staying current above).

The relay's address is `DEFAULT_RELAY_URL` (`src/share/hosts.ts`) unless `hosts.json` sets `relay`. When the relay's
discovery says `mode: "host"` (Dimension's own server is both), the same address is also offered as the built-in
`cloud` host, "Dimension cloud": no token, the server's per-IP quotas. `policy.only` must list `cloud` to keep it, and
`p2p: false` turns it off with this computer. The server runs from `scripts/vps/setup-artifact-host.sh` in the root repo.

## A click-open is a host-lent, one-file grant

The fence (`src/fence.ts`) answers "which files may a model-callable tool read", and
for a model that is: the vault, `VIEWER_ROOTS`, never a secret. A human clicking Open
on a card for a file the agent made in a project folder is a different fact, and only
the host can attest to it. The pack declares `grants: ["files:read"]`, and then:

* the engine stamps `_meta["ai.insodimension/grant"] = { read: [<realpath>] }` on the
  host call that opens the file and on every later call that View instance makes
  (including `read_file_chunk` and `open_media`), and strips the key from every call it did not
  stamp, so a View or a model cannot forge one;
* the fence reads it as **exactly those files**: the requested path, resolved to its real
  path, must equal a lent real path. Never a folder and everything under it, never a
  sibling, never a parent, and only a regular file;
* the deny rules (`.env`, private keys, credential stores, the Locker, the engine's agent
  state, UNC and device paths) run first and still refuse a lent path: a click cannot
  open a secret;
* the fence does not trust the engine's stripping. Any flaw in the grant (not an
  object, `read` not a list, a non-string, relative or tricked entry, more than 8 files)
  is no grant at all, and no grant leaves the roots exactly as they were.
* every HTTP request rechecks the fence with the host-owned grant retained at admission, verifies
  the recording's size and modification time, and opens only a regular file. A changed recording must be reopened.

A server that does not declare `files:read` is never stamped, so the viewer stays
deny-by-default for everything a human did not click.

## Limits, in one place

| What | Limit | Where it is held |
|---|---|---|
| A recording the viewer plays | No file-size cap; 64 concurrent leases/admissions (a pane frees its lease when it closes and renews it every 30 s while it is open; when the table is full, a lease with no request or renewal for five minutes that is not streaming is reclaimed, and a table of 64 live recordings refuses a new one), 192 concurrent transfers (three a lease: the player, its frame-capture clone, and the tail range of a file whose index sits at its end), 64 KiB stream buffers | `media-server.ts` (`LEASE_TTL_MS`), `media-lifecycle.ts` (`RENEW_EVERY_MS`) |
| Any other document | 128 MiB (text: the first 1 MiB) | `DOCUMENT_LIMIT`, `TEXT_LIMIT` (`document-bytes.ts`) |
| An HTML page that starts with Pick in hand | 2 MiB; larger starts with Pick down | `PICK_FRAME_LIMIT` (`document-bytes.ts`) |
| A waveform | WAV or strict MP3 only; file 32 MiB, decoded 96 MiB at 22.05 kHz, 8 channels, MP3 545 s; one decode at a time; everything else a flat track; a file is read whole only when its first bytes are a WAV, an ID3 tag or an MPEG frame | `WAVEFORM_*`, `loadPeaks` (the kit: `media/waveform.ts`, `media/peaks.ts`; the pane's `media-waveform.ts` reads the tab's bytes) |
| A video filmstrip | 48 thumbnails, 160 px long edge; 4 files cached | `MAX_FILM_SLOTS`, `FilmstripCache` (the kit: `media/filmstrip.ts`) |
| Notes on one file | 24 | `MAX_MARKS`, `MAX_COMMENTS`, `MAX_ELEMENT_PICKS`, `MAX_TIMELINE_MARKS` |
| Pictures in one request | 4, 2 MiB each, 4 MiB together | the host's image caps, held by the kit |
| A share upload | 4 chunks in flight, 1 MiB each; a chunk is tried 5 times (0.4 s base, 15 s cap, jittered) | `UPLOAD_CONCURRENCY` (`upload.ts`), `DEFAULT_RETRY` (`host-api.ts`) |
| A link from this computer | 16 MiB of sealed chunks cached; 128 KiB data frames; tunnel reconnect 1 s to 60 s, jittered | `P2pServer`, `TunnelClient` |
| Comment streams | 8 streams, 200 shares each | `MAX_STREAMS`, `SHARES_PER_STREAM` (`comments.ts`) |

## Accepted risks

The fence decides from names and real paths. Two things it does not look at, both
needing a process that can already write to the disk:

* **Hard links.** A hard link to a secret is the secret's bytes under a harmless name:
  its `realpath` is the harmless name, the deny rules do not match it, and the viewer
  does not read link counts. So a hard link inside a root (or one a human clicks) opens.
  Whoever can create one (`ln`, `mklink /H`) can already read the secret, and the bytes
  go to the user's View, never to the model (`read_file_chunk` is app-only; the model
  learns the kind and size).
* **A link swapped in after the check.** `realpath` and the open are two calls. A writer in
  the same directory can swap a link in between them, and the open follows it. The open
  handle is re-checked to be a regular file (a FIFO or directory swapped in is refused);
  its identity is not pinned. This is the same power as a shell.

## Build and test

Run both from the plugin root (`marketplace/packs/swiss-knife`), not from this folder.

```sh
bun viewer/scripts/build.mjs   # viewer/app/server.mjs and viewer/app/dist (validates ../plugin.json with the SDK first)
bun test ./viewer/test/
```

`bun run build` there builds `present` too. The host runs `app/server.mjs`, not `src/`.
`test/bundle.test.ts` rebuilds the server in memory and fails when the code in the committed
file is not what `src/` builds to, so rebuild and commit `app/server.mjs` with every change
under `src/`. The build writes every dependency path in the file as
`../../../../node_modules/` (this folder's distance to the repository root), whatever install
built it, and the same test refuses any other spelling. `src/fence.ts` also holds the plugin's
one deny table: `present` imports it, so a change to it changes both tools.
