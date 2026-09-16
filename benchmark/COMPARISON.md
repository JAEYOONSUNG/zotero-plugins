# ZotPoP / Publish or Perish comparison

Comparison captured: 2026-09-12T21:11:12.689Z. PoP 8.19.5300.9483; candidate ZotPoP 0.7.0 development build.

## Result

- Matched-condition baseline: 5/12 cases passed.
- Improved implementation: 12/12 cases passed.
- Every PoP reference top-10 record (or all records for a smaller result set) was found in the corresponding ZotPoP top-30 result set.
- Google Scholar uses a separately installed official PoP CLI. These six cases establish engine integration parity, not independent web-scraper equivalence. OpenAlex, Crossref and PubMed use direct ZotPoP API adapters.
- Unknown/truncated author and journal metadata are explicitly reported as unverified. Semantic relevance precision is not measured without independently judged relevance labels.

## Conditions and measurements

Queries were chosen from the user’s research context before implementation. Source, fields, year range and cap are in [queries.json](queries.json). Reference wrappers and URL-sanitized CLI JSON exports are in [references/](references/). [URL redaction and original hashes](PRIVACY.md) document the preserved original captures and removal of transient access parameters.
PoP native source retrieval differs from its output sort: diagnostic logs confirmed OpenAlex cited-by count descending and PubMed newest first. Google Scholar and Crossref use relevance. Initial incorrectly assumed relevance conditions are retained under [capture-audit/](capture-audit/) and are excluded from the final baseline.

| Case | Source order | Baseline recall | Improved recall | Full-cap overlap | Transport |
|---|---|---:|---:|---:|---|
| scholar-thermophile | relevance | 0% | 100% | 100% | installed-publish-or-perish |
| scholar-geobacillus-title | relevance | 0% | 100% | 100% | installed-publish-or-perish |
| scholar-recombineering | relevance | 0% | 100% | 100% | installed-publish-or-perish |
| scholar-cas9-title | relevance | 0% | 100% | 100% | installed-publish-or-perish |
| openalex-thermophile | citations | 100% | 100% | 100% | direct |
| openalex-geobacillus-title | citations | 100% | 100% | 100% | direct |
| openalex-recombineering | citations | 100% | 100% | 100% | direct |
| openalex-cas9-title | citations | 100% | 100% | 100% | direct |
| crossref-recombineering | relevance | 100% | 100% | 100% | direct |
| pubmed-recombineering | date | 0% | 100% | 93% | direct |
| scholar-liu | relevance | 0% | 100% | 100% | installed-publish-or-perish |
| scholar-nar | relevance | 0% | 100% | 100% | installed-publish-or-perish |

## What changed

- Fixed page-size/offset bugs in OpenAlex and Scholar, including partial final pages.
- Added explicit author/journal field validation where complete metadata are returned; preserved unknown Scholar snippets without inventing missing fields.
- PubMed keyword queries now use PoP’s Text Word fields, avoiding unwanted automatic concept expansion.
- Preserved author Boolean grouping, and prevented DOI assignment to papers with different negation, numbers or title identity.
- Added cancellable requests/retries/processes, progressive combined results and an error when all sources fail.
- Added the optional installed PoP Google Scholar engine and explicit progress/settings disclosure.

## Evidence and limits

- [Matched baseline JSON](results/baseline-report.json)
- [Improved JSON](results/improved-report.json)
- The intermediate run in build/pop-parity/iteration-2 recorded four OpenAlex HTTP 503 failures; those were not counted as passes. The successful run followed recovery.
- Scope: 12 declared queries, four source providers, cap 30. This does not establish equivalence for every query, source, language, or future service state.
- Reference source/query provenance is verified before scoring. Empty, stale, incomplete and mismatched reference captures fail.
- Tests and real Zotero verification are recorded in .unlazy/pop-parity/GATES.md.
