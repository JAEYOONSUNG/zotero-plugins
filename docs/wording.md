# ZotPoP wording

One word per concept, in each language. `test/wording.test.mjs` scans both tables in
`content/i18n.js` (function source and output) for the forbidden variants below, so a
new string that drifts fails the suite.

## Glossary

| Concept | English | Korean | Not |
|---|---|---|---|
| A paper the user already has | in library / not in library | 보유 / 미보유, 라이브러리에 있음 | owned, held, you hold · 소장 |
| One result row | paper (result, when it may not be a paper) | 논문 (결과) | publication, work, work group · 문헌, 실적 (참고문헌 is fine) |
| Where results come from | source | 검색원 | 검색 소스, 소스, 출처 (출처 stays for provenance, e.g. "JIF 출처") |
| How often a paper is cited | citations (Citations/year, Citations/paper; the narrow table column is headed "Cited") | 인용, 인용 수 | Cites as a noun, "3 cites" |
| Journal Impact Factor | JIF | JIF | IF |
| OpenAlex's 2-year mean | OA 2y, OpenAlex 2-year mean (never called a JIF) | OA 2년, OpenAlex 2년 평균 | |
| Adding a paper to Zotero | add | 추가 | import · 가져오기, 가져옴 |
| Following an author | follow, followed author | 관심 저자 | watch · 팔로우 |
| The pane under the table | detail pane | 상세 패널 | detail card, the paper's detail · 상세 창, 상세 카드 |
| The venue field and column | Journal | 저널 | Publication (as a label) · 학술지 |
| Zotero's settings | Settings → ZotPoP | 설정 → ZotPoP | Preferences · 환경설정 |
| The result count field | Max results (its own label) | 최대 결과 수 | result limit · 결과 상한 |
| Show more | — | 더 보기 | 더보기 |
| Show/hide toggles | show or hide | 보이기·숨기기 | 켜기/끄기, 표시·숨기기 for panes |

Kept as they are in both languages: JIF, JCR, h-index, g-index, DOI, ORCID, ORCID iD,
OpenAlex, PubMed, Crossref, Europe PMC, arXiv, Semantic Scholar, Google Scholar,
Publish or Perish (PoP), CSV, PDF, API key, Bluesky, Hacker News, Wikipedia (위키백과 in Korean prose).

## Rules

- **No title case.** English labels are in sentence case ("Find papers and add them to your
  library", not "Search & Import Papers"). Proper names keep their capitals.
- **No jargon** (no API names in prose): say "request", not "API", and "API key" only where the
  user types one. No HTTP status codes in a sentence, no "endpoint" (AI server address,
  AI 서버 주소), no "UTC 자정" (say 한국 시간 오전 9시).
- **Errors say what happened and what to do.** Every Korean error ends in what to do (-세요,
  never -십시오); every English one has a clause after the cause ("Try again in a minute",
  "Check … in Settings → ZotPoP"). A bare "failed: <detail>" is not enough.
- **Source errors are explained.** The sources throw English for the log
  ("HTTP 503 · api.openalex.org"); the window shows `ZotPoPI18N.explainError`'s sentence, which
  names the service and the next step in the window's language. Unknown text passes through.
- **Counts.** English counts go through `plural()` ("1 paper", "1,200 papers"); Korean counts go
  through `groupDigits()` too ("1,200편"). Years are not counts.
- **CSV headers** name what the column holds: the institution's h-index is
  `FirstAuthorInstitutionHIndex` / `1저자 기관 h-index`, not an author's h-index.
- **Length.** Toolbar buttons and chips must fit at the default 1440 px window in both
  languages; when a label cannot, the chip carries a short form and the tooltip the full one
  (`metricsBasisMaxShort`).
