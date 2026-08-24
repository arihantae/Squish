# Squish

A browser-based image compressor. Drop in JPG, PNG, or WebP images and it
shrinks them on the spot — no server, no upload, no account. Everything runs
in JavaScript in your own browser tab.

## Features

- Drag & drop or browse to upload, multiple images at once
- Live before/after size comparison for the whole batch and per image
- Quality slider (re-encodes JPEG/WebP with real lossy compression)
- Max-size resize control (downscales huge images, preserves aspect ratio)
- Drag-to-compare slider over each thumbnail
- Download images one at a time or all together as a `.zip`
- Handles the failure modes that matter: wrong file type, oversized files,
  corrupt images, and images that don't actually get smaller

## Running it locally

No build step, no dependencies to install.

1. Clone or download this folder
2. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari)

That's it. There's no server because there doesn't need to be one — see below.

## How compression works

Everything goes through the browser's built-in **Canvas API**:

1. The uploaded file is drawn onto an off-screen `<canvas>` at the target
   dimensions (original size, or scaled down if resizing is requested)
2. `canvas.toBlob(callback, mimeType, quality)` re-encodes those pixels using
   the browser's native JPEG/WebP/PNG encoder

This is genuine lossy re-encoding, not a renamed file or a fake size number —
`toBlob`'s `quality` argument controls the same kind of compression a tool
like Photoshop's "Save for Web" does, just via a browser API instead of a
desktop app.

**One real limitation, by design of the format:** PNG encoding is *always*
lossless in the Canvas spec, so the quality slider has no effect on PNGs.
The app is upfront about this in the UI rather than pretending otherwise —
resizing (which reduces pixel count, not encoding quality) is the effective
lever for shrinking a PNG.

**Never hands back something worse.** Every compression result is compared
against the original file size. If the "compressed" version would be equal
size or larger, the app keeps the original instead and says so, rather than
silently making a file bigger.

## Project structure

```
image-compressor/
├── index.html          # markup
├── style.css            # all styling (dark theme, one accent color)
├── script.js             # all app logic
├── vendor/
│   └── jszip.min.js      # ZIP generation, vendored locally (no CDN)
└── README.md
```

No framework, no bundler. `script.js` is organized into clearly labeled
sections: config, state, file handling, compression, rendering, downloads,
and the before/after compare slider.

## Design notes

- **Vanilla JS over a framework.** At this scope (one page, no routing, no
  server state) a framework adds ceremony without adding capability. Every
  line here is inspectable and explainable without knowing a framework's
  conventions.
- **One global quality/resize control, not per-image.** This is a batch
  tool — matching the mental model of "compress this whole set the same
  way" kept the UI and the state model simpler.
- **Max-size resize instead of width/height fields.** A single "longest
  side" number scales every image proportionally with no aspect-ratio-lock
  UI needed, and it works uniformly across a batch of differently-sized
  images.
- **JSZip is vendored, not loaded from a CDN.** Keeps the "nothing leaves
  your browser, works offline" story literally true, and means the demo
  never breaks because a CDN hiccupped.

## Browser support

Targets modern evergreen browsers (Chrome, Firefox, Edge, Safari — current
versions). Relies on the Canvas API, `Promise`, `URL.createObjectURL`, and
Pointer Events, all standard for several years now.
