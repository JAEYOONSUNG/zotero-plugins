# Style Custom

A research workbench for Zotero 7, 8 and 9. It adds a panel with the things a working researcher keeps switching windows for, and a handful of columns to the item list. It is installed as its own `.xpi`, separately from ZotPoP, and the two work together where it helps.

The repository README has the illustrated tour: [../README.md](../README.md). This file is the reference for what the plugin records, where, and how it decides things.

## What it adds

**Columns in the item list.** IF (JCR 2025 impact factor), Citations, Read time, Status (unread / reading / read), Rating, Journal mark (each journal in its own colour and abbreviation), First-author institution with country, File kinds. Right-click → *Switch to custom columns* turns them on together and hides the corresponding columns of the older Ethereal Style plugin if it is installed. Double-click a column edge to fit it to its content. Long titles scroll while the pointer rests on them and return when it leaves; the system's reduced-motion setting is respected.

**The panel.** Floating or docked in a Zotero tab. Nineteen tabs in four groups:

| Group | Tabs |
|---|---|
| Explore | Library, Recent, Related papers, Authors, Collections, Journal metrics |
| Read | Reading, Notes, Annotations, Attachments, Backlinks |
| Organise | Nested tags, Citation graph, Canvas, Comparison |
| Tools | Tabs, View groups, Translation · AI, Appearance |

⌘/Ctrl K finds a tab by name. `/` or ⌘/Ctrl F focuses the search; Esc closes the finder, then the panel. The last tab, the panel's density and whether it was docked are remembered.

**The right-click menu.** Reading status and rating; search this paper in ZotPoP; related papers; follow the senior author; copy in a citation style; open the citation graph; refresh citations and journal metrics; check retractions and open access; fill the gaps from OpenAlex; look up citations for the whole library. Every entry carries a drawn sign.

**Settings.** Ten categories with search, an explanation on every item, per-category defaults, and a *Start here* block naming the keys still blank. API keys are shown masked and are not cleared by restoring a category's defaults.

## Journal metrics

Two views. **Official JCR** browses Clarivate's own hierarchy, groups → categories → journals, captured from the JCR site: 21 groups, 254 categories, 22,643 journals with their multiple memberships. Each category carries its journal count, citable items, total citations and median JIF; each journal its JIF and, for that category, the official rank, quartile and percentile. Ranges such as `<0.1` and `N/A` are kept as written. Nothing here is recomputed.

**OpenAlex subjects** filters the stored registry of 22,594 journals by domain › field › subfield, for the journals in your library or all of them, and computes a *local* rank and quartile within a subject from the stored JIFs. That is labelled as a local comparison, not a JCR rank, wherever it appears.

Figures are from the JCR 2026 release (metric year 2025); the source's own update date and the capture date are shown on the page.

## What it records, and where

- **Reading time** is recorded from the PDF reader: time after input in the active PDF, with the background and any stretch of sixty seconds without activity excluded, per attachment and per page. It lives in `style-custom.json` in the Zotero data folder, which Zotero does not sync.
- **Status and rating** are Zotero tags (`/unread`, `/reading`, `/done`, star tags, and `style-custom:rating:0` for an explicit "no rating"), so they sync as tags do. Existing tags of the same kind from Ethereal Style are recognised. Setting *unread* by hand keeps the recorded time; new reading activity makes the paper *reading* again; a done tag outranks the automatic transition.
- **Citation counts** are looked up from OpenAlex (DOIs in batches) and cross-checked with Crossref's exact DOI lookup; without a DOI, only a match on title, year and first author is accepted. A paper that is added or whose metadata changes is looked up about 1.2 seconds later, and the figure is written to the Extra field as one line, `Citations: 123 (OpenAlex, 2026-09-13)`, leaving the rest of Extra alone. Successes are not re-asked for seven days, misses for one, errors for thirty minutes. An exact 0, an unknown `—` and an in-progress `…` are distinct. This can be turned off in the settings.
- **Impact factor** comes from the shipped JCR figures matched on journal name, alias and ISSN, with the year, source and check date in the tooltip. Nothing is guessed: a preprint, book or dataset gets no journal IF, CiteScore is never shown as IF, and an unknown value is `—` with the reason, never 0.
- **Followed authors**, their seen papers, moves and patents are kept in the same data file.

Email addresses and API keys are sent only to the service they belong to, and only if you entered them.

## Self-check

When the pref `extensions.style-custom.selfCheck` is set and Zotero starts, the plugin runs its checks against the real library and writes `style-custom-selfcheck.json` next to its data file: column registration, every tab drawing, every safe button surviving a press, the panel docking into a tab, the item menu's signs and English, the translation coverage, the citation dialog, the reading history, the watchlist, and the live APIs. It opens no window. The flag clears itself.

## Background updates

`scripts/install-background.py` replaces an already-registered copy of this plugin in a Zotero profile. It waits for Zotero to exit, re-verifies the xpi's hash and the hash of the installed copy it expects to replace, backs the old one up, and swaps the file. It never starts or stops the application or opens a window, and it refuses to replace a copy of the same version or one another updater has changed. Its status file records the PID, whether it is still waiting, and the last check.

## Development

```
node --test --test-force-exit test/*.test.mjs   # the suite; workbench tests must end with bench.destroy()
python3 scripts/build.py                        # build/style-custom-<version>.xpi
python3 scripts/extract-strings.py              # Korean source strings → data/strings-ko.json
python3 scripts/build-strings.py                # + data/strings-en.json → src/strings.js
```

Korean strings in the source are the keys; every one must have an English entry, and a test fails otherwise. `manifest.json`, `package.json`, `data/features.json` and `docs/improvement-rounds.json` must carry the same version. Every improvement round is recorded in `docs/improvement-rounds.json` with the source marker and the test that cover it, and a test checks that both still exist.

Third-party notices: [LICENSES.md](LICENSES.md).
