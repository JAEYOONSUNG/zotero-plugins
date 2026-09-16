# Gates: ZotPoP search quality

## Continuation: duplicate identity integrity (2026-09-13)

Scope: Preserve conflicting paper identities, include PMC identity, and require journal corroboration for generic-title merging. Preserve existing worktree changes.

- [x] Q1: Regression cases preserve conflicting identities and merge verified copies, including repeated and reordered inputs.
  CHECK: node --test test/search-quality.test.mjs
  EXPECT: /# fail 0/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=2e8271aeaa1b/52 entries; output=# todo 0 | # duration_ms 132.647542

- [x] Q2: All deterministic search, recovery, preview and interaction regressions pass.
  CHECK: npm run test:offline
  EXPECT: /# fail 0/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=2e8271aeaa1b/52 entries; output=# todo 0 | # duration_ms 4403.203958

- [x] Q3: Source JavaScript parses and the installable archive builds.
  CHECK: node --check content/sources.js && npm run build
  EXPECT: Built build/zotpop-
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=2e8271aeaa1b/52 entries; output=> sh scripts/build.sh | Built build/zotpop-0.8.1.xpi

## Previous verification (historical, not revalidated by this continuation)

Scope: Preserve requested search ordering, combine source relevance before truncation, and prevent incorrect duplicate removal while preserving the existing worktree changes. Read-only independent audit; implementation stays with the root agent.

- [x] G1: Deterministic regressions verify source query ordering, combined ranking, duplicate identity, and the actual UI search-to-render path.
  CHECK: node --test test/search-quality.test.mjs test/search-ui.test.mjs
  EXPECT: /# fail 0/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=41f9b060e9a6/52 entries; output=# todo 0 | # duration_ms 685.702125

- [x] G2: Existing source and metadata regression tests pass against the live APIs, with service rate-limit skips explicitly reported.
  CHECK: npm test
  EXPECT: /# fail 0/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=41f9b060e9a6/52 entries; output=# todo 0 | # duration_ms 87615.1635

- [x] G3: The changed JavaScript parses and the installable plugin archive builds successfully.
  CHECK: node --check content/sources.js && node --check content/ui.js && npm run build
  EXPECT: Built build/zotpop-
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/JaeYoon/orca/workspaces/Zotero_plugin/guppy; path=41f9b060e9a6/52 entries; output=> sh scripts/build.sh | Built build/zotpop-0.6.3.xpi
