# CR.md — contract for the SPA code-review annotation tool

## Intent

The tool supports a review loop around a single-file SPA without ever
touching the app's code or runtime:

1. **Capture** — while using the app inside the wrapper, freeze interesting
   moments (open modals, dropdown state, mid-interaction) as
   self-contained snapshots. Capture is passive: no clicks, focus changes,
   or synthetic events reach the app.
2. **Annotate** — draw shapes with notes on the frozen snapshots. Every
   annotation is authored, timestamped, and either open, resolved or
   wontfix.
3. **Persist** — annotations travel inside the app file itself, in one
   inert JSON block, so review data is versioned together with the code it
   refers to and never decoupled from it.
4. **Hand off** — export a self-contained review file a second reviewer can
   open anywhere. Reviewers add comments and flip statuses; captured
   annotations' text and colour stay final. Both sides can produce updated
   copies.

## Expected behavior

- The app file is only ever modified inside the annotation block. Splice
  and strip are byte-exact round trips; stacked or corrupted blocks are
  collapsed to one canonical block on save.
- Annotations are anchored to snapshot pixels, never to live DOM nodes —
  nothing goes stale when the app changes after the capture.
- A file handle attached via **Open app HTML…** persists per browser, so
  **Save annotations** rewrites the app file in place. Without a handle,
  Save downloads a spliced copy and says so loudly — the app file on disk
  is not touched in that mode.
- The local stash keeps unsaved work across reloads. On open, whichever is
  newer wins (stash vs file, compared by seq and content); Save and Clear
  remove the stash. Clearing never resets the id counter.
- Saving is visible: the Save button shows the pending change count, a
  spinner while writing, and the last-saved time when clean.
- Exports freeze annotation text and colour: a second reviewer changes
  status and adds comments only, and both export save actions produce
  downloadable copies with the reviewer's contributions included.

Files in this folder (the tool is fully decoupled from any app under review):

- `index.html` — the wrapper. Columns: **Captures** (left), **Review** panel
  (annotations + editor), **app/snapshot view** (right). Header: Open /
  Reload / Clear on the left; Save annotations / Export code review on the
  right.
  Open an app file, use the app inside it, press **Ctrl+Shift+F** (or the
  camera button) to capture the current state, then annotate the capture in
  the Review panel.
- `cr.js` — all logic (wrapper controller + review drawing engine). Nothing
  from the tool is ever injected into the app itself.
- `CR.md` — this contract.

The app file is **never modified except for one block** (below), added or
replaced on "Save annotations". Annotations live on **screenshots** (frozen
DOM snapshots), not on the live DOM, so transient UI can never "lose" them.

## Local stash (unsaved working set)

The wrapper continuously mirrors the working set into `localStorage`, keyed
`cr-stash:<app filename>`. On open, a stash (if present) takes precedence
over the block in the file — it is the newer unsaved work; a toast says so.
A successful **Save to file deletes the stash** (the block becomes the
record), and **Clear** wipes the working set + stash for the current file
(ids are never reused — `seq` keeps counting); Save after Clear strips the
(now empty) block into the app file.

Caveats: on `file://` all pages share ONE storage origin in Chromium, so the
per-file keying is by filename only — two apps with the same filename share
a stash. Storage quota (~5–10 MB) bounds how many captures the stash holds;
on quota failure the tool warns and the work is only in memory until saved.

**Rolling stash history:** whenever a stash write would lose captures or
annotations (deletions, Clear), the previous version is first snapshotted
to `cr-stash-hist:<app filename>` (last 5 kept, oldest dropped on quota
pressure). Recover from the wrapper console (or ask an agent):

```js
CR.listStashHistory()          // -> [{index, ts, captures, annotations}, ...]
CR.restoreStashHistory(0)      // -> swaps the working set to that entry
```

## Export code review (self-contained review file)

"Export code review" downloads `<app>-code-review.html`: a single file with
zero external dependencies (runs from `file://` by double-click) containing

- the review UI (compact engine derived from cr.js): captures list (left),
  snapshot view (center), annotations panel (right);
- every capture's frozen DOM, all annotations, and the **app file itself**
  (base64-embedded);

A second reviewer can open it, read any annotation, **add comments** and
**update annotation status** (append-only comments; the editor shows the
thread, a status dropdown and the colour palette). Two save actions:

- **Save comments** — splices the annotations shown in the
  review into the embedded app's annotation block and downloads the updated
  app file (hash recomputed). Use this to hand back your comments and status
  updates.
- **Export a copy** — re-downloads the whole review file with the
  updated annotations baked in (the reviewer's work travels with the file).

The export carries the annotation state as it was at export time; unsaved
wrapper work is included. The data block inside the export has every `<`
escaped as `\u003c` (valid JSON, parser-inert).

## Running

Published: **https://nyjc-edtech.github.io/edtech-app-review/**

Local server (works everywhere, enables `?app=`):

```
python -m http.server 8642 --directory <this repo>
# open http://localhost:8642/index.html
# dev/agent mode: ?app=<path relative to index.html>
#   index.html?app=sample-app.html   (bundled demo)
```

`?app=` paths resolve against `index.html`'s own URL (absolute and root-relative
paths keep their usual meaning), so the same form works locally and on the
GitHub Pages project site.

Also works from `file://` (double-click `index.html`, use Open/drag-drop) in
Chromium; captures re-render with the same CDN caveats as above.

**Direct saving on `file://`:** always attach the file via **Open app
HTML…** (the picker), not drag-drop — the granted file handle is persisted
in IndexedDB and re-attached on later sessions, so "Save annotations"
rewrites the app file in place for as long as the file keeps its identity
(it is re-verified by hash on every open; an externally modified file
detaches the connection and asks you to re-open). Drag-drop and `?app=`
runs have no handle: Save downloads a spliced copy instead (loud toast) —
remember to replace the app file with it, or the edits never reach disk.
Handles granted before a Chromium permission reset re-prompt on first Save.

## Annotation block (inside the app file)

```html
<script type="application/json" id="cr-annotations"><!--cr+
{ ...pretty-printed JSON... }
+cr--></script>
```

Extract (pure JSON out, no HTML parsing):

```bash
sed -n '/<!--cr+/,/+cr-->/p' <app.html> | sed '1d;$d' | jq .
# no jq? python fallback:
sed -n '/<!--cr+/,/+cr-->/p' <app.html> | sed '1d;$d' | python -c "import json,sys; print(json.dumps(json.load(sys.stdin), indent=2))"
```

Notes are guaranteed not to contain `<!--cr+` or `+cr-->` (the tool refuses
to save such a block), and captured `dom` strings have any such sequences
sanitized at capture time — so the markers are always safe slice
boundaries. The block sits immediately before `</body>`.

## Schema (v2)

```json
{
  "schema": 2,
  "tool": "spa-code-review 0.5.3",
  "seq": 7,
  "savedTs": 1769640000000,
  "app": { "sha256": "<sha256 of app file text minus the block>", "bytes": 115136 },
  "captures": [
    {
      "id": "s1",
      "ts": "2026-10-27T09:15:00.000Z",
      "label": "scoring rules modal open",
      "dom": "<html serialized DOM of the app at capture time, scripts stripped\ufe34 ...",
      "dom_sha256": "<sha256 of the dom string>",
      "viewport": { "w": 980, "h": 673 },
      "annotations": [
        {
          "id": "a1",
          "kind": "rect",              // rect | ellipse | line | arrow | text
          "x": 320, "y": 140,          // origin: top-left (rect/ellipse/text) or start point (line/arrow)
          "w": 220, "h": 64,           // rect/ellipse/text only (text: measured callout box)
          "x2": null, "y2": null,      // line/arrow only (end point)
          "color": "#dc2626",
          "note": "Timer keeps running while Rules modal is open",
          "comments": [                  // optional: further reviewers' comments
            { "author": "AL", "ts": "2026-10-28T02:10:00.000Z",
              "text": "Reproducible also with the wildcard modal." }
          ],
          "author": "js",
          "ts": "2026-10-27T09:16:03.000Z",
          "status": "open"             // open | resolved | wontfix
        }
      ]
    }
  ]
}
```

Semantics:

- **savedTs** — optional root field; epoch ms of the last "Save annotations".
  Shown on the (disabled) Save button when the working set is clean.
- **id** — `s<n>` for captures, `a<n>` for annotations, all drawn from the
  single `seq` counter. Never reuse an id: when adding entries by hand, use
  `prefix + seq` and increment `seq`.
- **capture order** — the `captures` array order is the display order in the
  wrapper's Captures sidebar; reorder by dragging there (or by editing the
  JSON array). Nothing else depends on the order.
- **annotation coordinates are pixels** of that capture's viewport
  (`viewport.w/h` = live iframe size at capture time). No DOM anchors; nothing
  can go stale.
- **dom / dom_sha256** — the app's serialized DOM (scripts stripped, state
  frozen: open modals, toggled classes) and the sha256 of that string. The
  wrapper re-renders it in a sandboxed script-free iframe; verify integrity
  with a sha256 of the extracted string. If the dom contained the literal
  sequences `</script`, `<!--cr+`, or `+cr-->`, they were sanitized with an
  inserted backslash at capture time.
- **note / comments** — `note` is the lead comment (original reviewer);
  `comments` is an optional array of further `{author, ts, text}` entries
  appended by other reviewers. Append-only by convention. To add a comment
  by hand: push to `comments` (create the array if absent) and bump nothing
  else.
- **app.sha256** — hash of the app text *excluding* the block, recorded at
  last save. On open, the wrapper recomputes and warns on mismatch ("app
  changed since last annotation save"). A mismatch after migrating the block
  to a new build is expected; captures remain valid evidence of the old build.
- **color** — any CSS hex is valid; the wrapper's picker offers a 16-color
  palette (Tailwind-600 family): `#dc2626 #ea580c #d97706 #ca8a04 #65a30d
  #16a34a #059669 #0d9488 #0891b2 #2563eb #4f46e5 #7c3aed #c026d3 #db2777
  #92400e #1e293b`. Default red `#dc2626`.
- `schema: 1` blocks (v0.1, live-DOM anchors) are not auto-migrated; the
  wrapper warns and starts empty.

## Rendering (for screenshot identification)

Every annotation renders a badge — a filled circle with its id (`a1`) — at
the shape's origin, and shapes use fixed semantics: red = open (author
color), green dashed = resolved, slate dashed = wontfix. `a3` next to a red
rectangle in a screenshot of the review tab refers to annotation `a3` in the
JSON.

## Agent workflows

- **Read**: `sed`/`jq` extraction above. Render any capture standalone (it is
  inert HTML — scripts were stripped):
  ```bash
  sed -n '/<!--cr+/,/+cr-->/p' <app.html> | sed '1d;$d' \
    | python -c "import json,sys; d=json.load(sys.stdin); [open(c['id']+'.html','w',encoding='utf-8').write(c['dom']) for c in d['captures']]"
  ```
  The captures are the *clean* app state; annotations are vector data on top.
  Want a PNG of the annotated state? Screenshot the wrapper's review tab
  (that is what the badges are for).
- **Add**: edit the JSON in the file directly (bump `seq`, add the object to
  the right capture), or drive the wrapper: `window.CR` exposes `.data`,
  `.capture()`, `Review` (`.create(kind,x,y,x2,y2)`, `.patch`, `.deleteAnnotation`).
- **Resolve after a fix**: set `"status": "resolved"` (keep the annotation —
  it is the audit trail).
- **Verify visually**: open the wrapper on the app, switch to the capture
  tab, screenshot the wrapper; badges map 1:1 to JSON ids. Or decode the
  capture PNG and view it directly.
- **Save without the file picker**: `await window.CR.debugSpliced()` returns
  the spliced app text — write it back to disk.

## Capture pipeline (what a capture faithfully contains)

The wrapper serializes the iframe's live DOM (open modals, toggled classes
frozen as-is), strips scripts, and stores the markup. The review tab
re-renders it in a **sandboxed iframe (`allow-same-origin`, no
`allow-scripts` — attribute handlers cannot run)** — native browser
rendering, so fidelity is exact and zoom is lossless (no rasterization, no
canvas). Note: a fully-opaque `sandbox=""` srcdoc empirically renders blank
in some Chromium builds when the capture references the Google Fonts
stylesheet — hence `allow-same-origin`, which keeps scripts blocked.
External stylesheets/fonts (CDN) are referenced, not embedded: captures
render best online; offline, inline styles (e.g. the Tailwind JIT sheet)
still carry the layout and icons drop to placeholders. Form state IS
captured — dropdown choices, typed text, checkbox/radio toggles are synced
into the frozen markup. Known fidelity limits: CSS `:hover`-only state
(menus kept open *only* by hover, hover highlight) is not preserved;
JS-driven state is. Inner-panel scroll
positions reset to top in the capture. Nested iframes, `<canvas>` pixels,
and `<video>` frames are not captured. Size: one capture ≈ the app's DOM size, typically
100–400 KB.

## Limitations (v0.5.3)

- Single-file SPAs only (app rendered via iframe `srcdoc`, so relative
  subresources in the app would break — CDN/absolute URLs are fine).
- No undo; delete + redraw. No multi-select.
- Captures re-render at 1× CSS pixels; the review tab scales them visually
  (fit / 1:1 buttons).
