# URL parameter redaction

The shared benchmark JSON files contain URL-sanitized exports. Transient publisher access parameters such as `casa_token` and `token` were removed from article, full-text and PDF URLs. DOI, title, authors, journal, year, rank, citation counts, search conditions and recorded comparison outcomes are unchanged. Parameters unrelated to access credentials remain intact.

The files ending in `.raw.json` preserve PoP's result structure but are no longer byte-identical captures where URL parameters were removed. Byte-identical originals are retained locally under the ignored `build/pop-parity/private-originals/` directory with a SHA-256 manifest; that directory must not be shared.

[privacy-manifest.json](privacy-manifest.json) records each affected shared path, the preserved original path, original and sanitized SHA-256 hashes, and counts by removed parameter name. It contains no parameter values. Existing reference hashes inside comparison reports identify the original inputs used when those reports were measured; the manifest links those inputs to the sanitized exports. Historical measurements and capture times were not rewritten.

Verify the exported artifacts and their comparison identities with:

```sh
node scripts/sanitize-benchmark-urls.mjs --check
node scripts/verify-comparison.mjs
```

The privacy check uses the locally preserved originals. The comparison check uses the shared sanitized references and does not require private originals. Removing an access parameter may make a publisher's temporary URL unusable; DOI links remain the stable bibliographic identifiers where supplied.
