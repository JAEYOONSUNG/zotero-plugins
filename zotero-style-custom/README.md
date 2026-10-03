# Style Custom

A research workbench for Zotero 9 (9.0–9.*; the manifest does not load it on other versions). Its companion ZotPoP runs on Zotero 7–9. It adds a panel with the things a working researcher keeps switching windows for, and a handful of columns to the item list. It is installed as its own `.xpi`, separately from ZotPoP, and the two work together where it helps.

The repository README has the illustrated tour: [../README.md](../README.md). This file is the reference for what the plugin records, where, and how it decides things.

## What it adds

**Columns in the item list.** IF (a Journal Impact Factor only for journals in your own JCR export or among the 86 publisher-page figures; otherwise blank), OA 2-yr mean citedness (OpenAlex's figure, not a JIF), Citations, Read time, Status (unread / reading / read), Rating, Journal mark (each journal in its own colour and abbreviation), First-author institution with country, File kinds. Right-click → *Style Custom → Switch to custom columns* turns them on together and hides the corresponding columns of the older Ethereal Style plugin if it is installed. Double-click a column's right edge to fit it to its content, as in a spreadsheet. The institution's tier is read off its OpenAlex h-index with fixed cut-points shared with ZotPoP: T1 at 2000 or more, T2 at 1400, T3 at 400, T4 below. Citations per year (the library overview's *연 N회 인용*) follow ZotPoP's convention: citations ÷ max(1, this year − publication year). Long titles scroll while the pointer rests on them and return when it leaves; the system's reduced-motion setting is respected.

**The panel.** Floating or docked in a Zotero tab. Nineteen tabs in four groups (names as the English interface shows them):

| Group | Tabs |
|---|---|
| Explore | Library, Recent, Related papers, Authors, Collections, Journal metrics |
| Reading | Reading progress, Notes, Annotations, Attachments, Backlinks |
| Organise | Nested tags, Citation map, Canvas, Compare |
| Tools | Tabs, View groups, Translate·AI, Style editor |

⌘/Ctrl K finds a tab by name. `/` or ⌘/Ctrl F focuses the search; Esc closes the finder, then the panel. The last tab, the panel's density and whether it was docked are remembered.

**Searching the library.** The panel's search takes plain words, `"a phrase"`, `-excluded`, field terms (`title:`, `author:`, `tag:`, `journal:`, `year:2018-2022`, `collection:`, `abstract:`, `note:`), and now `OR` (capitals; also `|`) with parentheses: `(cats OR dogs) -deep author:kim`. Lowercase `or` stays a word.

**The right-click menu.** Reading status and rating; search this paper in ZotPoP; related papers; follow the senior author; copy in a citation style; open the citation graph; refresh citations and journal metrics; check retractions and open access; fill the gaps from OpenAlex; look up citations for the whole library. Every entry carries a drawn sign.

**Settings.** Eleven categories (Columns, Views and panels, Reader and annotations, Sidebar and tabs, Tags, Collections, Menus and design, Reading record, Citations and IF, Translate·AI, Updates) with search, an explanation on every item, per-category defaults, and a *Start here* block naming the keys still blank. API keys are shown masked and are not cleared by restoring a category's defaults.

## Journal metrics

Two views. The first browses groups → categories → journals. In the build as published, which carries no Journal Citation Reports figures, this is OpenAlex's classification (26 fields, 252 subfields, 89,510 journals), each journal with OpenAlex's two-year mean citedness, labelled as an estimate and never as a JIF. The **Official JCR** view, Clarivate's own hierarchy with each category's journal count, citable items, total citations and median JIF and each journal's JIF, official rank, quartile and percentile, appears only when you put your own JCR export in `style-custom-journals/` in the Zotero data folder (ranges such as `<0.1` and `N/A` are kept as written; nothing is recomputed). The source's own update date and the capture date are shown on the page.

**OpenAlex subjects** filters the stored registry (the current open registry: 89,510 journals, from OpenAlex sources of 2026-09-22) by domain › field › subfield, for the journals in your library or all of them, and computes a *local* rank and quartile within a subject from the stored figures. That is labelled as a local comparison, not a JCR rank, wherever it appears.

**Refresh the journal impact factor** (right-click menu) only re-reads the publisher metrics pages of the 86 journals that have one; your JCR export and OpenAlex figures are not changed.

## What it records, and where

- **Reading time** is recorded from the PDF reader: time after input in the active PDF, with the background and any stretch of sixty seconds without activity excluded, per attachment and per page. It lives in `style-custom.json` in the Zotero data folder, which Zotero does not sync.
- **Status** is a Zotero tag (`/unread`, `/reading`, `/done`), so it syncs as tags do; **rating** is an Extra line, `Rating: N`, which syncs with the item and can be edited by hand (legacy rating tags, including those of Ethereal Style, are still read, and *Move rating tags into Extra* migrates them). Setting *unread* by hand keeps the recorded time; an explicit `/unread` tag beats imported reading seconds, and reading needs 30 seconds of recorded time before the paper becomes *reading*; a done tag outranks the automatic transition.
- **Citation counts** are looked up from OpenAlex (DOIs in batches) and cross-checked with Crossref's exact DOI lookup; without a DOI, only a match on title, year and first author is accepted. A paper that is added or whose metadata changes is looked up about 1.2 seconds later, and the figure is written to the Extra field as one line, `Citations: 123 (OpenAlex, 2026-09-13)`, leaving the rest of Extra alone. With an OpenAlex API key, the citations of the rows visible in the item list are also looked up automatically (a figure older than seven days is stale and asked again); without a key nothing is looked up unasked in the list, and you can use *Refresh citations for the selection* instead. Successes are not re-asked for seven days (adjustable), misses for one, errors for thirty minutes (adjustable). An exact 0, an unknown `—` and an in-progress `…` are distinct. Both automatic lookups can be turned off in the settings.
- **Impact factor** is a Journal Impact Factor only for journals found in your own JCR export (`style-custom-journals/`) or among the 86 publisher-page figures that ship, matched on journal name, alias and ISSN (ambiguous titles need an ISSN), with the year, source and check date in the tooltip. Every other journal shows no IF; OpenAlex's two-year mean citedness, which is not a JIF, is in its own column. Nothing is guessed: a preprint, book or dataset gets no journal IF, CiteScore is never shown as IF, and an unknown value is `—` with the reason, never 0.
- **Followed authors**, their seen papers, moves and patents are kept in the same data file.
- **Local only, not synced.** These live in `style-custom.json` on this computer and are not synced by Zotero or anything else: your memos on papers, the reading queue (keyed by `libraryID:itemKey`), the "seen" marks of the author inbox and 새 논문 (keyed by DOI or OpenAlex work id, shared by all libraries because the watchlist is), the canvas boards and their cards, and each tab's filters and search state. Use another computer and they are not there; keep a copy of the file if they matter. Status and rating are the exception (Zotero tags, above).

## Authors

**Following.** An author followed from a paper, a list or the authors tab is checked for new papers when you press **Check all at once** (or *Check again for new papers*) in the Authors tab, or run *Fill the gaps*; nothing is swept unasked. Papers published more than two months before the previous check are marked known rather than shown. Everything not yet marked seen stays in the inbox (up to 50 unseen per author, oldest dropped only once seen) and an unmarked paper is never filed away silently. A paper that overlaps none of the person's known affiliations, which may be a namesake's, is held under *Needs checking* (확인 필요) and is not counted as new until you confirm it. Retraction and published-version signals are re-checked after 90 days (30 for a preprint with no published version) and the check-up notice says how many are newly retracted or newly published.

**Relations and grouping.** *관계* draws who among the followed authors writes with whom, from papers already held (no request is made to draw it); picking someone narrows the inbox to them. *묶어 보기* groups the list by affiliation, tier, country or field.

**LinkedIn.** The *LinkedIn* button on an author opens, in your browser, the profile listed on their public ORCID record, or LinkedIn's people search for their name and institution. Nothing is fetched from LinkedIn; the only request is to ORCID's public API, and only when you press the button.

API keys are sent only to the service they belong to. The contact email goes to Crossref (polite pool) and OpenAlex (no speed benefit now), and only if you entered it here or in ZotPoP, whose address Style Custom uses when its own field is blank.

## Self-check

Runs only when the pref `extensions.style-custom.selfCheck` is set (the flag then clears itself): up to 47 checks, 42 by default (the demonstration-library, repair, fill and screenshot checks run only when asked for), against the real library and writes `style-custom-selfcheck.json` next to its data file: column registration, every tab drawing, every safe button surviving a press, the panel docking into a tab, the item menu's signs and English, the translation coverage, the citation dialog, the reading history, the watchlist, and the live APIs. It opens no window.

## Updates

The plugin keeps itself current: while Zotero is open it reads the release feed named in its manifest once a day and, when a newer release is listed, has Zotero's add-on manager download it, verify the hash and apply it without a restart. The **Updates** section of the preferences pane turns this off or runs a check now; the check is skipped while a self-check runs. `src/updater.js` holds the decisions and is shared with ZotPoP, whose build copies it.

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

Licence: [MIT](../LICENSE) for the code. The journal figures that ship with the plugin come from OpenAlex under CC0 1.0 and from publishers' own metrics pages; Journal Citation Reports figures are licensed to their subscriber and are not distributed, but are read from `style-custom-journals/` in the Zotero data directory when a reader puts their own export there. Third-party notices: [LICENSES.md](LICENSES.md).
