# ZotPoP / Publish or Perish comparison

Generated: 2026-09-12T20:58:44.896Z

5/12 cases pass. Scholar and API coverage: not established.

Candidate overlap is bibliographic agreement with PoP, not relevance precision. Missing human judgements leave precision unavailable.

Transport 'installed-publish-or-perish' uses the installed PoP engine; its overlap measures integration fidelity and does not establish independent scraper parity.

| Case | Source | Status | PoP top recall | Full-cap recall | Candidate overlap | Precision | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scholar-thermophile | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 929 ms |
| scholar-geobacillus-title | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 638 ms |
| scholar-recombineering | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 634 ms |
| scholar-cas9-title | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 523 ms |
| openalex-thermophile | openalex | pass | 100.0% | 100.0% | 100.0% | unavailable | 2060 ms |
| openalex-geobacillus-title | openalex | pass | 100.0% | 100.0% | 100.0% | unavailable | 711 ms |
| openalex-recombineering | openalex | pass | 100.0% | 100.0% | 100.0% | unavailable | 707 ms |
| openalex-cas9-title | openalex | pass | 100.0% | 100.0% | 100.0% | unavailable | 921 ms |
| crossref-recombineering | crossref | pass | 100.0% | 100.0% | 100.0% | unavailable | 1271 ms |
| pubmed-recombineering | pubmed | fail | 0.0% | 0.0% | 0.0% | unavailable | 1299 ms |
| scholar-liu | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 643 ms |
| scholar-nar | scholar | fail | 0.0% | 0.0% | unavailable | unavailable | 434 ms |

## scholar-thermophile

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:29.993Z. Reference SHA-256: 6c468189dd71dd4bca19683a618e8f5d247e5cabb16597be48d2645fdc31682b.

Errors: HTTP 429 from scholar.google.com

## scholar-geobacillus-title

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:31.005Z. Reference SHA-256: 069346f5d7c45d06546b6319417350fec7936f74dd2a5398406c14481fd54121.

Errors: HTTP 429 from scholar.google.com

## scholar-recombineering

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:38.006Z. Reference SHA-256: bbff7db42e7f181f347a6c452f82473f95ef53e7e3dbf5defc616cfc84fcb58a.

Errors: HTTP 429 from scholar.google.com

## scholar-cas9-title

Mode: live. Transport: direct. Counts: {"referenceRaw":1,"referenceCompared":1,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, expected-target-missing, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:44.792Z. Reference SHA-256: aa7bb9de897be018f041714ed8f692a38e7e13848b41460940f535391caeb65e.

Errors: HTTP 429 from scholar.google.com

## openalex-thermophile

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":30,"candidateCompared":30}.

Outcome: All declared checks pass.

Matches: 30 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 30.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:43:55.227Z. Reference SHA-256: ccb09074d65736cc8d5a69122e3d6fb2f6fdced417a0322c8a966829376221e3.

## openalex-geobacillus-title

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":30,"candidateCompared":30}.

Outcome: All declared checks pass.

Matches: 30 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 30.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:48.621Z. Reference SHA-256: 5278b06c5164031993461c452c4aebcd2a56332a401a6ea1397f22ec72b686d6.

## openalex-recombineering

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":30,"candidateCompared":30}.

Outcome: All declared checks pass.

Matches: 30 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 30.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:43:57.449Z. Reference SHA-256: a53aaa2a8f272d3773c57ed9465fdab0b988965aad4b6bd4ad6b4e481290f19e.

## openalex-cas9-title

Mode: live. Transport: direct. Counts: {"referenceRaw":1,"referenceCompared":1,"candidateRaw":1,"candidateCompared":1}.

Outcome: All declared checks pass.

Matches: 1 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 1.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:44:01.056Z. Reference SHA-256: 730dc5b58b73af4568408afaf2e39b7c8c12e811a1cc78ce25b2da1c64e2a24c.

## crossref-recombineering

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":30,"candidateCompared":30}.

Outcome: All declared checks pass.

Matches: 30 DOI, 0 normalized exact title. Identity conflicts: 8. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 30.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:53.667Z. Reference SHA-256: 43551b7fcf0e58a758a073650f58194288c76ed4973dd4e20b3a100aea033458.

## pubmed-recombineering

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":30,"candidateCompared":30}.

Outcome: reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 30.

Reference quality: 1 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-12T20:40:57.785Z. Reference SHA-256: 74b5d6357bdecc3a996440d2278e72326ebecf7385d7c71ddcf9f490f1f0b515.

## scholar-liu

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 22 records with unverifiable fields.

Reference time: 2026-09-12T20:41:02.524Z. Reference SHA-256: 79b6fd9f4a3ce88e022b8c31f73fae1f4e3c172f72b15b9ac3591e633c35229f.

Errors: HTTP 429 from scholar.google.com

## scholar-nar

Mode: live. Transport: direct. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":0,"candidateCompared":0}.

Outcome: candidate-errors, empty-candidate, reference-recall-below-threshold.

Matches: 0 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Reference quality: 0 known field violations; 18 records with unverifiable fields.

Reference time: 2026-09-12T20:41:08.633Z. Reference SHA-256: 75aa482a6f5db147f00ef739980084b181890eb199db36c6304600cf37327a31.

Errors: HTTP 429 from scholar.google.com
