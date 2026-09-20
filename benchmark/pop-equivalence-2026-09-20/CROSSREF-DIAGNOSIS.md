# Crossref mismatch diagnosis

Read-only inspection and exact provider-page replay performed on 2026-09-20. No provider requests, credentials or private preferences were needed. Inputs: `build/search-expansion-20260920/comparison-report.json`, `references/crossref-geobacillus-1000.raw.json` and `pop-data/cache/crossref/*.dat` beneath the same build directory. Source SHA-256 during replay matched the original report: `9f2b05218b11ea5d914351f5a693dcf0e227417821c9c78455868b64f7cb5a39`.

## Missing records

The ten `.dat` files contain full HTTP 200 responses. Split each file at CRLF CRLF, parse the JSON body and sort by `message.query['start-index']`. Offsets are 0 through 900, with 100 rows each. Concatenated DOI order exactly equals all 1,000 raw PoP rows. HTTP dates span 2026-09-19 21:45:57–21:46:41 UTC and identify the API pool as `polite-array`.

Replaying those same provider pages through the unchanged production `S.search('crossref', originalQuery, mockHTTP, {journalMetrics:false,institutionMetrics:false})` produces all **986 unique DOIs**, including all 15 absent from the historical candidate capture. Prefix output counts are 100,199,296,393,491,590,690,789,888,986. An explicit empty offset-1000 response bounded this replay; it is a fixture boundary, not independent live provider evidence. No unique-DOI filter or dedupe loss was reproduced. Candidate HTTP response bodies were not retained, so the exact historical cause of each candidate miss cannot be established solely from this replay.

| Absent unique DOI | PoP ranks |
| --- | --- |
| 10.3389/fmicb.2023.1178748 | 201 |
| 10.1101/2021.04.07.438430 | 292 |
| 10.2210/pdb9zi3/pdb | 296, 302 |
| 10.1016/j.pep.2005.03.011 | 401 |
| 10.1601/ex.18149 | 495, 501 |
| 10.2210/pdb9own/pdb | 601 |
| 10.2210/pdb3hht/pdb | 711 |
| 10.3390/ijms20030780 | 797, 801 |
| 10.2210/pdb9owp/pdb | 899, 901 |
| 10.1007/s00792-004-0395-2 | 900, 920 |
| 10.15174/au.2024.4153 | 980 |
| 10.2210/pdb2iex/pdb | 981 |
| 10.3390/ijms20235869 | 982 |
| 10.24002/biota.v14i3.2580 | 984 |
| 10.22146/ijbiotech.65822 | 985 |

The 29 unmatched raw rows comprise 20 rows belonging to these 15 absent identities and nine duplicate occurrences of matched identities. Equivalently, the gap is 15 unique missing identities plus 14 duplicate rows. Every duplicate already occurs in the retained provider HTTP responses:

```text
10.1021/acs.iecr.1c03070.s001          98,101
10.2210/pdb4c1p/pdb                   198,202
10.1601/ex.23948                     199,208
10.2210/pdb5j78/pdb                   200,209
10.1016/j.plasmid.2013.10.002         295,301
10.2210/pdb9zi3/pdb                   296,302
10.1016/j.gene.2005.08.017            300,305
10.11606/t.18.2017.tde-12042017-105059 395,407
10.2210/pdb5hon/pdb                   396,408
10.1601/ex.18149                     495,501
10.21203/rs.3.rs-3420371/v1           700,701
10.3390/ijms20030780                 797,801
10.2210/pdb9owp/pdb                   899,901
10.1007/s00792-004-0395-2             900,920
```

Eleven of those fourteen repeated identities have different relevance scores across the pages. Examples: pdb9zi3 is 12.72614 then 12.728113; ex.18149 is 11.97932 then 11.9406; ijms20030780 is 11.177725 then 11.15654. Thus an explanation limited to identical-score ties is insufficient. The captured offset pages demonstrably do not form a single consistent ranking snapshot.

## Thirty metadata conflicts

All 26 author conflicts are omissions by PoP of provider `author` entries with `name` instead of `family`, mostly corporate contributors. Taking only family/given contributors produces exact PoP author-list equality in all 26 cases; no fuzzy matching is required. Reference ranks: 77,79,86,215,277,375,398,535,588,619,627,650,668,670,692,698,712,734,735,754,766,775,883,893,928,971. The standard engine should retain available corporate contributor data.

All four title conflicts are an evaluator formatting omission: stripping only `<scp>` yields exact equality. DOIs/ranks:

- 10.1002/1873-3468.70123/v2/review1: 825
- 10.1002/1873-3468.70123/v1/review2: 881
- 10.1128/jb.00222-11: 891
- 10.1002/1873-3468.70123/v1/review1: 976

## Fifty-one metadata unknowns

All 47 missing candidate years correspond to provider `issued.date-parts=[[null]]`. Every PoP year equals the provider's `created` year. Several dissertations carry an earlier `approved` year, so DOI registration time must not silently become publication time in standard search. The 47 reference ranks are 1,2,3,6,8,11,13,19,23,25,28,34,39,40,46,47,55,56,62,67,74,75,78,98,103,107,108,112,124,125,126,127,129,137,138,161,185,207,241,273,316,369,370,395,451,524,708.

Two missing bylines are ranks 287 and 315, DOIs 10.1002/1873-3468.14834/v1/decision1 and /v2/decision1. Provider records have no author but have editor Peter Brzezinski. PoP puts that editor in its byline; the standard engine's select projection excludes editor.

Two missing titles are ranks 43 and 171, DOIs 10.46936/10.25585/60000464 and 10.3030/704724. Both are grants with no top-level title in either provider or PoP, but full provider records contain titles at `project[].project-title[].title`. Standard projection excludes project; grant-specific enrichment is possible, whereas exact PoP fidelity retains its blank title.

## Decision supported by this evidence

Use an explicit PoP native mode to preserve raw records, duplicates, original ranks and source-specific metadata choices. Keep output fidelity distinct from independent bibliographic correctness. Fix the `<scp>` evaluator normalization defect without relaxing substantive metadata checks. Do not alter standard search to drop corporate contributors or mislabel registration dates as publication dates merely to imitate PoP output.
