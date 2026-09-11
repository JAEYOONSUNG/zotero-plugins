# ZotPoP — Publish or Perish-style search & import for Zotero

A Zotero 7/8/9 plugin that copies the Publish or Perish workflow and puts it inside Zotero:
search a bibliographic database with author / journal / title / keyword / year filters,
see the result list with citation counts and PoP metrics (h-index, g-index, hI,norm, hI,annual, hA),
tick the papers you want, and add them to your library — metadata via Zotero's own
translators and the PDF fetched automatically. The window is in Korean.

Interface: resizable columns and panes (remembered between sessions), a detail pane with the abstract
and per-paper actions, a right-click menu, filtering, CSV copy/export, and keyboard control
(↑/↓ to move, Space to select, Enter to open, ⌘F to filter, ⌘A to select all, Esc to stop).

## Sources

| Source | Citation counts | Notes |
|---|---|---|
| OpenAlex | yes | default, no key needed |
| Crossref | yes | `is-referenced-by-count` |
| Semantic Scholar | yes | unauthenticated access is heavily rate-limited; add an API key in Settings |
| PubMed | via OpenAlex | counts looked up by DOI after the search |
| arXiv | via OpenAlex | |
| Google Scholar | yes | experimental, scraped; expect CAPTCHAs after a few queries |
| 통합 검색 | yes | runs OpenAlex, Crossref, PubMed and arXiv together and merges them by DOI/title |

## Install

Quit Zotero, then:

```
npm run install     # builds the .xpi and registers it in your Zotero profile
```

Or install `build/zotpop-<version>.xpi` by hand through Zotero → Tools → Plugins → gear → *Install Plugin From File…*

Open the window either way:

- the magnifier button in the items toolbar, right of *Add Item by Identifier* (it lives on a library tab, so it is hidden while a PDF reader tab is in front)
- Tools → *논문 검색 & 가져오기 (Publish or Perish)…*

Settings (contact e-mail for polite API pools, Semantic Scholar key, defaults) live in
Zotero Settings → ZotPoP.

## Development

```
npm run install               # quit Zotero first
/Applications/Zotero.app/Contents/MacOS/zotero -purgecaches -ZoteroDebugText
npm test                      # live API smoke tests (Node 18+)
```

### Packaging constraints on Zotero 9 (Firefox 140 base)

These cost a lot of debugging time, so they are worth knowing:

- **`manifest.json` must be pure ASCII.** A single non-ASCII byte (a Korean description, say) makes
  the add-on manager reject the archive with `ERROR_CORRUPT_FILE` (-3) and silently delete the .xpi
  from the profile. `scripts/install.sh` refuses to install if it finds one.
- **Pointer/proxy files are no longer scanned.** The classic development trick of putting a text file
  named after the plugin ID in `<profile>/extensions/` containing a path does nothing here. Only
  `.xpi` files are picked up.
- **A brand-new .xpi is only detected when the add-on registry is rebuilt.** The first install removes
  `extensions.json` (backed up alongside it first); later version bumps only need an add-on scan,
  which the script triggers by clearing `extensions.lastAppVersion`.
- Sideloaded plugins are auto-disabled unless `extensions.autoDisableScopes` is `0`.
- Build the archive with `python3 -m zipfile`-style packing; macOS `zip` output has been rejected.
- After editing files under `content/`, reopening the window is not always enough — restart Zotero
  with `-purgecaches`.

Layout: `bootstrap.js` (plugin lifecycle), `src/zotpop.js` (menu + window), `content/sources.js`
(API adapters, also runs in Node), `content/metrics.js` (PoP metrics), `content/importer.js`
(Zotero item creation + PDF), `content/ui.js` + `search.xhtml` (the window).

## How import works

For each selected paper: DOI / PMID / arXiv ID → Zotero translator (same as *Add Item by Identifier*).
If nothing resolves, the item is created from the search metadata. Then Zotero's *Find Full Text*
resolvers run (Unpaywall, publisher page, PMC, any custom resolvers you configured). If they fail,
ZotPoP tries open-access URLs in order: every OA location reported by the source, Europe PMC
(`europepmc.org/articles/PMCxxxx?pdf=render`, which works where PMC itself blocks downloads), arXiv,
and Unpaywall (when a contact e-mail is set). Each download is verified to be a real PDF. Citation count is written to
the *Extra* field as `Citations: N (Source, date)`. Papers already in the library (same DOI) are
flagged and, by default, only added to the target collection.
