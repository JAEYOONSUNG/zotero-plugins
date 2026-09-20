# ZotPoP / Publish or Perish comparison

Generated: 2026-09-19T22:03:13.171Z

2/4 cases pass. Scholar and API coverage: present.

Evaluation: fresh. Profile: strict. Results apply only to these cases, source transports, retrieval orders, caps and capture times; no universal Publish or Perish parity is established.

Declared coverage: {"sources":["crossref","pubmed","scholar"],"cases":"One 1000-result Crossref topic query, two known-paper lookups, one Scholar author query. No universal parity or semantic precision claim."}. Observed sources: crossref, pubmed, scholar. Observed caps: 1000, 10, 30.

Evaluator revision: 3df94842b00d63be86cca1f0cd3a64157fa22959. Dirty working tree: true. Config SHA-256: 046d0bb029fb6adf2d01b46ba7e23ad86dc5cfecf47eabedd2e84b139912d24d.

Candidate overlap is bibliographic agreement with PoP, not relevance precision. Missing human judgements leave precision unavailable.

Transport 'installed-publish-or-perish' uses the installed PoP engine; its overlap measures integration fidelity and does not establish independent scraper parity.

| Case | Source | Status | PoP top recall | Full-cap recall | Same top-k recall | Rank agreement | Metadata conflicts | Precision | Latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| crossref-geobacillus-1000 | crossref | fail | 100.0% | 97.1% | 100.0% | 100.0% | 30 | unavailable | 17416 ms |
| pubmed-known-paper | pubmed | pass | 100.0% | 100.0% | 100.0% | 100.0% | 0 | unavailable | 982 ms |
| scholar-known-paper | scholar | pass | 100.0% | 100.0% | 100.0% | 100.0% | 0 | unavailable | 1240 ms |
| scholar-sheila | scholar | fail | 100.0% | 96.7% | 100.0% | 100.0% | 0 | unavailable | 6758 ms |

## crossref-geobacillus-1000

Mode: live. Transport: direct. Counts: {"referenceRaw":1000,"referenceCompared":1000,"candidateRaw":1000,"candidateCompared":1000}.

Outcome: full-recall-below-threshold, metadata-conflicts, metadata-unverifiable.

Criteria: {"profile":"strict","minFullRecall":1,"minSameTopKRecall":1,"minRankAgreement":1,"requireMetadataConsistency":true,"requireVerifiedFields":true}. Ranking applicable: true; NDCG: 100.0%.

Matches: 971 DOI, 0 normalized exact title. Identity conflicts: 269. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 0.

Unique DOI diagnostic: 98.5% recall; reference duplicates: 14. Raw full-cap recall remains the strict criterion.

Matched-record metadata: 30 conflicts; 51 unverifiable records. Candidate capture: 2026-09-19T22:02:46.682Z. Candidate SHA-256: live. Candidate source revision: 3df94842b00d63be86cca1f0cd3a64157fa22959.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-19T21:45:55.100Z. Reference SHA-256: bfe6581b2dd6e1a2b9a3e1b52c148cc6c4df6b607aa01f335b914d9101792b54.

## pubmed-known-paper

Mode: live. Transport: direct. Counts: {"referenceRaw":1,"referenceCompared":1,"candidateRaw":1,"candidateCompared":1}.

Outcome: All declared checks pass.

Criteria: {"profile":"strict","minFullRecall":1,"minSameTopKRecall":1,"minRankAgreement":1,"requireMetadataConsistency":true,"requireVerifiedFields":true}. Ranking applicable: true; NDCG: 100.0%.

Matches: 1 DOI, 0 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 1.

Unique DOI diagnostic: 100.0% recall; reference duplicates: 0. Raw full-cap recall remains the strict criterion.

Matched-record metadata: 0 conflicts; 0 unverifiable records. Candidate capture: 2026-09-19T22:03:04.180Z. Candidate SHA-256: live. Candidate source revision: 3df94842b00d63be86cca1f0cd3a64157fa22959.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-19T21:46:43.331Z. Reference SHA-256: c022f351ad6f71b72f15aa40de38ed79bba1e342ee450eb7b1ecb16a671f3ebb.

## scholar-known-paper

Mode: live. Transport: installed-publish-or-perish. Counts: {"referenceRaw":1,"referenceCompared":1,"candidateRaw":1,"candidateCompared":1}.

Outcome: All declared checks pass.

Criteria: {"profile":"strict","minFullRecall":1,"minSameTopKRecall":1,"minRankAgreement":1,"requireMetadataConsistency":true,"requireVerifiedFields":true}. Ranking applicable: true; NDCG: 100.0%.

Matches: 0 DOI, 1 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 0. Fully verified field records: 1.

Unique DOI diagnostic: unavailable recall; reference duplicates: 0. Raw full-cap recall remains the strict criterion.

Matched-record metadata: 0 conflicts; 0 unverifiable records. Candidate capture: 2026-09-19T22:03:05.164Z. Candidate SHA-256: live. Candidate source revision: 3df94842b00d63be86cca1f0cd3a64157fa22959.

Reference quality: 0 known field violations; 0 records with unverifiable fields.

Reference time: 2026-09-19T21:46:45.538Z. Reference SHA-256: 83054687d840b6b1f5108b8069beec42f1a5c5a7dfa2d7e9ed5d774521f52aa5.

## scholar-sheila

Mode: live. Transport: installed-publish-or-perish. Counts: {"referenceRaw":30,"referenceCompared":30,"candidateRaw":29,"candidateCompared":29}.

Outcome: full-recall-below-threshold, metadata-unverifiable, unverifiable-fields, unverified-reference-fields.

Criteria: {"profile":"strict","minFullRecall":1,"minSameTopKRecall":1,"minRankAgreement":1,"requireMetadataConsistency":true,"requireVerifiedFields":true}. Ranking applicable: true; NDCG: 100.0%.

Matches: 7 DOI, 22 normalized exact title. Identity conflicts: 0. Known field violations: 0. Records with unverifiable fields: 13. Fully verified field records: 16.

Unique DOI diagnostic: 100.0% recall; reference duplicates: 0. Raw full-cap recall remains the strict criterion.

Matched-record metadata: 0 conflicts; 22 unverifiable records. Candidate capture: 2026-09-19T22:03:06.406Z. Candidate SHA-256: live. Candidate source revision: 3df94842b00d63be86cca1f0cd3a64157fa22959.

Reference quality: 0 known field violations; 13 records with unverifiable fields.

Reference time: 2026-09-19T21:46:47.056Z. Reference SHA-256: c6ab645d0d1d1ecd3d6082b26f18f01d64bfa7b45157e7fb61e9079e8d6efe5c.
