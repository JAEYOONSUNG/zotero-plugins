# vendor

pdf.js, as shipped by Mozilla, kept here so the app has no build step and the PDF opens with no
signal once the viewer has been used once.

- `pdf.min.js`, `pdf.worker.min.js` — `pdfjs-dist@4.10.38`, the **legacy** build (the one Mozilla
  targets at Safari), taken from `cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/` and named
  `.js` rather than `.mjs`, because that is the extension a static host is sure to serve as
  JavaScript. They are still modules, and pdf.js starts its worker as one either way.
- `standard_fonts/`, `cmaps/` — the same release's font and character-map data, so a PDF that
  does not embed its fonts, or that is typeset in Korean or Japanese, still renders.
- `LICENSE-pdfjs` — Apache 2.0, Mozilla Foundation.

Nothing here is edited. To move to another release, fetch the same four paths from that version.
