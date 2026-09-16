# Unrestricted Geobacillus query

The user rejected small-query overlap as sufficient evidence of search usefulness. A native query showed that comparison-only year bounds (2015–2025) and a30-record cap had been left in the window. Those controls were cleared; the user's Geobacillus keyword was preserved.

The all-years search requested1000 records. Google Scholar delivered210 and then required a CAPTCHA on page22. The original bridge reported an error and displayed zero, despite those210 successfully received papers. The official PoP CLI recovered all210 using its documented --offline mode; no CAPTCHA bypass or additional retrieval was used.

Of these210,123 are dated before2015. The restricted test setup excluded that date range. Examples include the2001 taxonomic study defining Geobacillus at rank2 and the2017 Genetic toolbox for controlled expression of functional proteins in Geobacillus spp. at rank129, beyond the earlier30-record cap.

The implementation now publishes an initial batch, reports retrieval progress, and is being extended to retain matching cached partial results with an explicit warning. Cached recovery is not fresh complete retrieval and is not counted as a parity pass. Further retrieval beyond the challenged page requires normal Google Scholar verification.

See [URL-sanitized recovered records](geobacillus-recovered-210.raw.json), [recovery metadata](recovery.json), and [URL redaction/original hashes](../PRIVACY.md). This is a concrete breadth/failure-retention case, not a universal relevance guarantee.
