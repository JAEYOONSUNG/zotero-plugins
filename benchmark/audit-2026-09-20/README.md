# ZotPoP 검색 품질 감사 — 2026-09-20

**판정: 현재 ZotPoP 전체 검색을 Publish or Perish와 동급이라고 보기는 어렵다.** 기존 비교는 좁은 조건에서의 문헌 일치율을 입증했지만, 이번 점검에서는 실제 저장 결과의 저자 오탐, 실제 PubMed 제목 검색 누락, 통합 검색의 수집 상한, 검색식 변환 및 중복 제거 오류가 확인됐다.

대상: 시작 시 설치본 0.33.0, 작업 소스 0.36.5. 이번 0.36.6 변경은 롤링 수정이며 검색 엔진은 변경하지 않았다. [검사한 소스 해시](source-revision.json)를 남겼다. 검색 문제는 아래와 같이 발견·재현한 상태이며, 이번 작업에서 모두 수정했다고 주장하지 않는다.

## 먼저 고쳐야 하는 검색 문제

| 우선순위 | 문제와 관찰 | 사용자에게 미치는 영향 | 코드 근거 |
|---|---|---|---|
| P1 | `Sheila Ingemann`이 `Sheila I. Stewart`와 일치한다. 화면에 복원된 69건 중 1947년 논문 `Statutes, Orders, and Official Statements Relating to Canadian War-Time Economic Controls`의 저자로 기록된 이름은 Sheila I. Stewart다. 저장 결과 검사와 현재 matcher 재현 모두 확인. | 다른 사람의 논문이 검색에 포함되고, 출판 연도 범위·연간 인용·hI,annual 등의 계산을 오염시킨다. | `content/query.js:242`, `:252`, `:284` |
| P1 | 실제 PubMed 검색에 `CRISPR Cas9 assisted recombineering in Lactobacillus reuteri`를 입력하면 0건. `in[ti]`만 제거한 대조 요청은 PMID **25074379** 1건. API는 `phrasesnotfound: ["in"]`를 반환한다. | 존재하는 논문도 제목을 그대로 붙여 넣으면 놓칠 수 있다. | `content/sources.js:1004`, `:1038` |
| P1 | 통합 검색과 Preprints의 각 검색원 수집량이 최대 200건이다. 통합 검색에 1,000건을 요청하는 mock에서 네 검색원 모두 200건을 받아 총 800건만 반환했다. | 충분한 검색 결과가 있어도 요청한 1,000건에 도달할 수 없다. 중복 제거 후에는 더 적다. `maxResults`가 전체 문헌 수를 보장한다는 뜻은 아니지만 이 내부 상한은 별도 문제다. | `content/sources.js:1766`, `:1772` |
| P1 | Europe PMC는 `cancer OR genome` 제목을 `TITLE:"cancer OR genome"`라는 통문장으로 전달한다. PubMed는 제목 `NOT cancer`를 `cancer[ti]`로 바꾼다. | 같은 입력의 의미가 검색원마다 바뀐다. 누락·오탐을 만들며 통합 검색에도 영향을 준다. | `content/sources.js:1181`, `:1018`, `:1022` |
| P1 | 식별자 충돌이 없는 두 논문 `Bacterial growth at +10 C`와 `Bacterial growth at -10 C`가 저자·연도가 같으면 한 건으로 합쳐진다. | 과학적 의미가 다른 논문이 중복으로 제거된다. | `content/sources.js:160`, `:1685`, `:1689` |
| P2 | 2024년 Alice Smith의 프리프린트 `Introduction`이 1947년 Bob Brown의 Nature 논문 `Introduction`과 정식 출판본 관계로 연결된다. | 제목만 같은 무관한 논문을 같은 연구의 다른 버전으로 표시한다. | `content/sources.js:1723`, `:1733`, `:1746` |
| P2 | PubMed 레코드에 OpenAlex 인용 42회를 보완하면 `citationSource`는 null이다. 합친 결과의 인용 수는 검색원 중 최댓값을 쓰는 정책이다. | 인용 수 출처가 빠지거나 여러 데이터베이스의 수치가 섞여, 단일 검색원 기준의 PoP 지표와 직접 비교할 수 없다. | `content/sources.js:429`, `:1661`, `content/ui.js:1247` |

[오탐이 포함된 저장 검색의 최소 발췌](saved-author-false-positive.json), [PubMed 실제 대조 응답](pubmed-stopword-control.json), [결정론적 재현 결과](reproductions.json).

실제 저장 결과에서 확인한 1947년 기록은 명확한 이름 불일치다. 다른 오래된 논문 전부가 오탐이라고 판정하지는 않았다. `S. Ingemann Hansen` 같은 이름·이니셜의 모호성은 저자 프로필, ORCID, 소속 및 연도 확인이 더 필요하다.

## 추가로 발견한 인증 전달 오류

`checkCitations()`는 `openAlexAuth(ctx)`가 만든 문자열을 `mailto` 변수에 담은 뒤 Crossref 요청에도 붙인다(`content/sources.js:671`, `:681`). 설정에 OpenAlex 키가 있으면 해당 키가 Crossref URL에도 포함된다. **가짜 키와 mock HTTP만 사용해 재현했으며 실제 키를 읽거나 외부로 보내지 않았다.** API 키를 서비스별로 분리하는 수정은 검색 기능 개선보다 먼저 처리할 항목이다.

## 실제 API 점검

2026-09-20 KST, API 키 없이 현재 검색 어댑터를 실행했다. 인용·저널·기관 보완 호출은 껐다. 각 검색의 전체 제한은 90초, 개별 요청 제한은 20초였다. 아래 결과는 동작 점검이며 같은 날 PoP와 맞춰 재수집한 동등성 비교가 아니다.

| 입력 | 결과 | 해석 |
|---|---|---|
| 통합 / 저자 `Sheila Ingemann` / 1,000건 | 90초 제한으로 취소. 도중 36건 전달. OpenAlex HTTP 429. | 완전한 검색 결과를 확보하지 못했다. 반환 0건을 논문 없음으로 해석하면 안 된다. |
| 통합 / 키워드 `geobacillus` / 1,000건 | 약 9.6초, 최종 397건. Crossref 200건 + Europe PMC 200건에서 중복 제거. OpenAlex HTTP 429. | 일부 검색원이 실패한 결과. 충분한 후속 결과를 받을 수 있는지와 무관하게 각 소스의 200건 상한에 도달했다. |
| PubMed / 위 논문 전체 제목 / 10건 | 약 0.5초, 0건. `in[ti]`를 제거한 직접 대조는 1건. | 검색식 변환에 따른 실제 누락을 확인했다. |

HTTP 429는 이번 비인증 실행 환경의 제약이다. 유효한 키를 설정한 사용자의 실행도 항상 실패한다고 일반화하지 않는다. [요청 URL·상태·시간을 포함한 요약](live-summary.json), [재실행 스크립트](live-probe.mjs). HTTP 요청에는 키를 사용하지 않았다.

## 기존 “12/12 통과”의 의미와 한계

기존 [비교 보고서](../COMPARISON.md)는 2026-09-12의 ZotPoP 0.7.0 개발 빌드 기록이다. Google Scholar 6개, OpenAlex 4개, Crossref 1개, PubMed 1개 검색을 각각 최대 30건으로 비교해 PoP 기준 상위 문헌 **102/102건**을 후보 상위 30건 안에서 찾았다. 이는 유효한 과거의 제한적 성과다.

그러나 현재 전체 검색 품질을 입증하기에는 다음이 부족하다.

- Google Scholar 6개 사례는 설치된 **PoP 엔진 자체를 호출**했다. 독자적인 Scholar 수집 능력의 검증이 아니다.
- 현재 통합 검색, Europe PMC, arXiv, Semantic Scholar, OSF, Preprints가 비교에서 빠져 있다. 직접 API의 저자 검색 및 1,000건 대량 검색도 입증하지 않았다.
- 총 302개 후보 중 사람이 관련성을 판정한 기록이 0개다. 주제 관련성 precision은 측정되지 않았다.
- 판정기는 PoP 상위 10건 중 90%를 후보 상위 30건에서 찾으면 통과할 수 있다. 같은 30건의 순서를 뒤집어도, 상위 9건만 돌려줘도, DOI만 유지하고 제목·저자·저널·인용 수를 잘못 바꿔도 재현에서 통과했다. 이는 **판정기의 허점**이며 기존 실제 검색 결과가 그렇게 잘못됐다는 뜻은 아니다.
- Scholar 저자 사례는 30건 중 22건의 저자 필드를, 저널 사례는 30건 중 18건의 필드를 완전히 검증하지 못했다.
- 비교용 제목 정규화는 `Effects of x < y > z`와 `Effects of x z`도 같다고 처리한다. 부등식이 HTML처럼 삭제된다.
- `scripts/verify-comparison.mjs`는 현재 날짜로 과거 결과를 평가해 `stale-reference`로 실패한다. 과거 기록의 재검증과 오늘의 새 비교를 분리해야 한다.

판정 코드: `scripts/benchmark-search.mjs:102–127`, `scripts/lib/pop-reference.mjs:25–26`, `:177–182`; 재검증 코드 `scripts/verify-comparison.mjs:34–36`. [재현 스크립트](reproduce.mjs)는 검증 목적으로 과거 capture 시각을 명시하며, 오늘의 동등성 통과로 바꿔 보고하지 않는다.

## PoP와의 기능 범위 차이

PoP도 자체 문헌 데이터베이스가 아닌 외부 검색원의 인터페이스다. 따라서 검색 능력을 비교하려면 검색원·필드·정렬·날짜·상한을 맞춰야 한다. PoP 공식 목록에는 Scholar Profile, Lens, Scopus, Web of Science가 있으며 현재 ZotPoP registry에는 이 어댑터들이 없다. 반대로 ZotPoP에는 통합 검색과 전용 프리프린트 검색이 있다. [PoP 공식 검색원 문서](https://harzing.com/resources/publish-or-perish/manual/using/data-sources).

ZotPoP의 통합 검색은 OpenAlex + Crossref + Europe PMC + arXiv이며 Google Scholar를 포함하지 않는다. 따라서 “PoP의 Google Scholar 검색과 같은 범위”로 이해하면 안 된다. 저자 이름 검색도 모든 서비스에서 완전한 인물 식별은 아니며, PoP는 일부 검색원에서 저자 ID/ORCID 및 프로필 검색을 제공한다. [PoP 공식 저자 검색 문서](https://harzing.com/resources/publish-or-perish/manual/using/use-cases/author-search).

## 수정 및 재평가 순서

1. 서비스별 API 키 전달 경계를 수정한다.
2. 스크린샷에서 확인한 저자 오탐과 PubMed 불용어 누락을 먼저 막는다.
3. 통합 검색의 200건 상한을 요청량에 맞춘 페이지 수집으로 교체하고 중복 제거 후 추가 수집을 검증한다.
4. 각 검색원에서 지원하는 Boolean 문법을 공통 의미에 맞춰 변환하고, 지원하지 않는 입력은 명시한다.
5. 부호·부등식·유전자명 등 과학적 제목 구별을 보존하고 프리프린트 연결에 저자·연도·명시적 관계 근거를 추가한다.
6. 동일 날짜·동일 조건의 PoP 비교를 다시 수집한다. 저자·정확한 제목·Boolean·1,000건 사례를 포함하고 관련성, 누락, 잘못 합친 중복, 인용 출처, 완결성, 검색 시간을 각각 평가한다.

## 함께 처리한 롤링 문제

설치된 0.33.0은 자동 롤링 구현이었다. 최신 소스의 hover 동작을 반영한 **0.36.6을 실제 Zotero에 설치**했다. 기본값도 hover로 바꿔 옵션 누락 시 자동 롤링이 재발하지 않게 했고, 프레임이 지연돼도 한 번 왕복한 뒤 멈추도록 보완했다. 마우스를 올린 셀만 이동하고 벗어나면 처음으로 돌아오는 회귀 테스트 및 기존 `npm run test:offline`, XPI 빌드를 통과했다.

실제 설치본의 Gecko 화면에서도 414개 셀의 기본 이동 0건, hover 이벤트 후 해당 셀만 45px 이동, 이탈 후 이동 0건을 확인했다. 입력은 제어된 synthetic mouse 이벤트를 사용했다. [런타임 검증](runtime-hover.json).

검색 감사 재현: `node benchmark/audit-2026-09-20/reproduce.mjs`. 이는 현재 결함이 재현되는지 검사하는 감사 도구로, 결함 수정 후에는 해당 관찰값과 보고서를 갱신해야 한다.
