# SPA Code Review

Review HTML5 single-page apps by capturing and annotating screenshots of
them — without ever touching the app's code or runtime.

Open an app in the wrapper, use it normally, and press **Ctrl+Shift+F** to
freeze interesting moments (open modals, dropdown state, mid-interaction) as
self-contained DOM snapshots. Draw shapes and text notes on the frozen
snapshots, discuss in per-annotation threads, and track each item as
**open / resolved / wontfix**.

## How it works

1. **Capture** — the app runs in an iframe; a capture serializes its current
   DOM (scripts stripped, form state synced in). Passive: no clicks, focus
   changes, or synthetic events reach the app.
2. **Annotate** — rectangle, ellipse, line, arrow, and text-note tools on top
   of the snapshot. Annotations are pixel coordinates on the capture, so
   nothing goes stale when the app changes afterwards.
3. **Persist** — annotations travel inside the app file itself, in one inert
   JSON block, so review data is versioned together with the code it refers
   to. The app file is never modified except for that block.
4. **Hand off** — export a self-contained review file a second reviewer can
   open anywhere (double-click, no server): they add comments and flip
   statuses, then hand back a spliced app file.

Unsaved work is kept in a local stash across reloads, with rolling history
for recovery; saving verifies the file's identity by SHA-256 before writing.

## Running

**Published:** <https://nyjc-edtech.github.io/edtech-app-review/>

- **Open an app** — click *Open app HTML…* or drag-drop an `.html` file.
  Opening via the picker attaches the file so **Save annotations** rewrites
  it in place; without a picker handle, Save downloads a spliced copy.
- **Local server** (enables `?app=`):
  `python -m http.server 8642 --directory <this repo>` then open
  `http://localhost:8642/index.html?app=sample-app.html` (path relative to
  `index.html`; `sample-app.html` is a bundled demo).
- **file://** — double-click `index.html` in Chromium. Capture and saving work;
  direct in-place saving needs the picker (see above).

Works best in Chromium browsers (uses the File System Access API for
in-place saving). Single-file SPAs only — the app is rendered via iframe
`srcdoc`, so relative subresources inside the app break; CDN/absolute URLs
are fine.

## Trust model

The app under review runs **unsandboxed and same-origin** with the wrapper —
capture needs DOM access, and the tool is designed for reviewing apps you or
your team wrote. Don't point it at third-party HTML you don't trust.
Snapshots, by contrast, are rendered in a sandboxed, script-free iframe.

## Docs

[`CR.md`](CR.md) is the full contract: annotation-block format, JSON schema,
stash/history semantics, export format, capture pipeline, fidelity limits,
and agent workflows (extract/render/edit annotations from the command line).

## License

[MIT](LICENSE)
