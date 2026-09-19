# ZotPoP — Publish or Perish-style search & import for Zotero

A Zotero 7/8/9 plugin that copies the Publish or Perish workflow and puts it inside Zotero:
search a bibliographic database with author / journal / title / keyword / year filters,
see the result list with citation counts and PoP metrics (h-index, g-index, hI,norm, hI,annual, hA),
tick the papers you want, and add them to your library — metadata via Zotero's own
translators and the PDF fetched automatically.

**Interface** — glass surfaces and line icons matching Zotero's own chrome, English by default with
Korean selectable in Settings → ZotPoP, resizable columns and panes that persist, a detail pane with
the abstract and per-paper actions, a right-click menu, filtering, CSV copy/export, and keyboard
control (↑/↓ to move, Space to select, Enter to open, ⌘F to filter, ⌘A to select all, Esc to stop).
Long text that overflows a result cell rolls only while the pointer is over that cell, once out
and back. Leaving the cell restores its start. Other cells stay still, and motion respects the
system's reduced-motion setting.

**First-page preview** — select a paper and choose Preview or press P to open a separate window.
Once opened, the preview follows result selection without stealing focus. Zotero's bundled PDF
renderer draws page one from an available PDF link. The preview does not import the item or add
an attachment; unavailable or non-PDF links show an original-page fallback.

**Sorting** — relevance, citations or newest first. Put a journal in the *Publication* field and sort
by newest to browse that journal's latest papers.
Relevance preserves each database's ordering; Combined and Preprints combine the ranks from each
source, with exact title matches first. Citation counts affect ordering only when citations is selected
locally (individual databases may also use citations in their own relevance scores). A new search resets
the previous table sort and local filter. arXiv keywords support quoted phrases, parentheses, AND, OR,
and NOT/ANDNOT.

**Library proxy** — papers behind a subscription are retried through your institution's proxy after
the free routes fail, and *Open via library* opens the publisher page through it. Configure it in
Settings → ZotPoP; a Yonsei preset is built in.

## Sources

| Source | Citation counts | Notes |
|---|---|---|
| OpenAlex | yes | default, no key needed |
| Crossref | yes | `is-referenced-by-count` |
| Semantic Scholar | yes | unauthenticated access is heavily rate-limited; add an API key in Settings |
| PubMed | via OpenAlex | counts looked up by DOI after the search |
| arXiv | via OpenAlex | |
| Google Scholar | yes | uses the separately installed Publish or Perish CLI when available; experimental web retrieval otherwise |
| Europe PMC | yes | articles plus preprints |
| Preprints | yes | bioRxiv, medRxiv, Research Square (via Europe PMC) and arXiv, merged |
| Combined | yes | OpenAlex, Crossref, Europe PMC and arXiv together, merged by DOI/title |

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

Google Scholar can use the official [Publish or Perish command-line tool](https://harzing.com/resources/publish-or-perish/command-line).
Set its absolute executable path in ZotPoP settings, or put it in the user application support
directory at `ZotPoP/tools/pop8query` (`pop8query.exe` on Windows). ZotPoP keeps its PoP search
data in `ZotPoP/PoPData`, separate from the PoP application's search history. The executable is
an external dependency and is not included in the XPI. The progress message identifies this
search route. A PoP CAPTCHA or service error is shown as an error; it is not an empty result set.

Search results appear as sources finish. Stop cancels HTTP requests, retry delays and the PoP
process. Bibliographic filters check author names and journals where complete metadata are
available; missing Scholar bylines/journal snippets remain unverified. DOI lookup requires
matching title identity, including negation and scientific numbers.
Large PoP searches first display a small batch, then extend to the requested limit. If a provider
fails after returning records, ZotPoP attempts one offline recovery and can retain an exact-query
snapshot from the last 24 hours. Such results carry a visible incomplete/cached warning and are
not treated as a fresh complete search. The [unrestricted Geobacillus case](benchmark/real-query/README.md)
documents the actual CAPTCHA interruption and recovery of 210 already received records.

## Development

```
npm run install               # quit Zotero first
/Applications/Zotero.app/Contents/MacOS/zotero -purgecaches -ZoteroDebugText
npm run test:offline          # 148 deterministic tests, no network
npm test                      # adds live API tests; they skip themselves when a
                              # provider is down or its budget is spent.
                              # OPENALEX_API_KEY=... npm test runs the OpenAlex ones.
npm run test:offline           # deterministic search/interaction/benchmark regressions
```

The [PoP comparison report](benchmark/COMPARISON.md) records the scoped before/after results,
query conditions and limitations. To repeat the direct API/web comparison, run `npm run benchmark`.
For the installed PoP Google Scholar route, add `--pop-executable /absolute/path/to/pop8query`
and optionally `--pop-data-dir /absolute/path/to/isolated-data`. Reference captures must be from
the same day and have matching source/fields/years/cap/retrieval order. Stale or incomplete
references fail verification; collect new PoP references before rerunning on another day.

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
- **`applications.zotero` must keep an `update_url`.** Without it the add-on scan skips the .xpi
  silently: no registry entry, no error, the plugin is simply absent. A dead URL is fine; the
  update checker logs a harmless 404. `scripts/install.sh` refuses to build without one.
- Build the archive with `python3 -m zipfile`-style packing; macOS `zip` output has been rejected.
- After editing files under `content/`, reopening the window is not always enough — restart Zotero
  with `-purgecaches`.

Layout: `bootstrap.js` (plugin lifecycle), `src/zotpop.js` (menu, toolbar button, window, preference
pane), `content/sources.js` (API adapters and the library proxy, also runs in Node),
`content/metrics.js` (PoP metrics), `content/importer.js` (Zotero item creation + PDF),
`content/i18n.js` (English/Korean strings), `content/ui.js` + `search.xhtml` + `search.css` (the window).

Inline `<svg>` icons in `search.xhtml` must carry `xmlns="http://www.w3.org/2000/svg"`. The document is
XHTML, so an `<svg>` without it is parsed in the XHTML namespace and silently renders nothing.

## Recall: what to set up

Two settings change how much this finds, and both are worth two minutes:

- **An OpenAlex API key (free).** Without one OpenAlex allows about $0.01 of usage per day, which
  is roughly ten searches, and then refuses everything until midnight UTC. A free key at
  openalex.org raises that to $1/day, about a hundredfold. Set it in Settings → ZotPoP. Crossref,
  Europe PMC, PubMed and arXiv need no key and have no budget.
- **Google Scholar through Publish or Perish.** Scholar has the widest coverage — books, theses,
  reports, non-English work — and ZotPoP drives the official PoP query engine rather than scraping.
  It looks for `pop8query` in `~/Library/Application Support/ZotPoP/tools/`, or at the path set in
  Settings → ZotPoP.

The default source is **Combined**, which queries OpenAlex, Crossref, Europe PMC and arXiv at once
and merges them by DOI and title. Publish or Perish searches one source per query; combining is why
a single ZotPoP search keeps working when one provider is rate-limited or down.

## Known limits

- The library proxy only downloads automatically while Zotero itself holds the proxy session.
  Open **Settings → ZotPoP → Library sign-in** once; otherwise right-click a paper and choose
  *Open via library*, which opens the publisher page in your browser instead.
- Previews are never fetched through the proxy, so a paywalled paper shows as unavailable even
  when you could read it after signing in.
- The contact e-mail is sent, as the polite-pool policies ask, to OpenAlex, Crossref, PubMed and
  Unpaywall only. Nothing else leaves the machine except the article URL you ask the proxy for.
- Stop does not interrupt a PDF download that is already in flight; it takes effect between papers.

## How import works

For each selected paper: DOI / PMID / arXiv ID → Zotero translator (same as *Add Item by Identifier*).
If nothing resolves, the item is created from the search metadata. Then Zotero's *Find Full Text*
resolvers run (Unpaywall, publisher page, PMC, any custom resolvers you configured). If they fail,
ZotPoP tries open-access URLs in order: every OA location reported by the source, Europe PMC
(`europepmc.org/articles/PMCxxxx?pdf=render`, which works where PMC itself blocks downloads), arXiv,
and Unpaywall (when a contact e-mail is set). Each download is verified to be a real PDF. Citation count is written to
the *Extra* field as `Citations: N (Source, date)`. Papers already in the library (same DOI) are
flagged and, by default, only added to the target collection.
