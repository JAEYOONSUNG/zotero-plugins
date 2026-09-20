# 저널 대분류·분야·세부 분야의 JCR 일치성 감사

**판정: JCR과 완전히 일치하지 않는다. 현재 세 단계는 OpenAlex 주제 계층이며, 분야별 순위·Q 계산과 필터에도 별도 문제가 있다.** 단순 번역이나 화면 명칭 차이가 아니다.

2026-09-20에 작업 폴더와 설치된 **Style Custom 0.50.2 / ZotPoP 0.38.0**을 읽기 전용으로 점검했다. 저널 탐색 화면은 Style Custom의 `workbench.js`에 있고, 저널 레지스트리는 두 플러그인이 공유한다. 설치본의 관련 코드와 두 레지스트리는 조사 시점 작업 소스와 같았다. 다른 업데이트를 방해하지 않도록 제품 코드·설정·설치본을 수정하지 않았고, 앱 창을 열거나 조작하지 않았다.

## 1. 분류 출처와 구조가 JCR과 다르다 — 높음

`build-journal-fields.py`는 OpenAlex `/sources`에서 `topics`를 받아, 각 주제의 `domain / field / subfield` 이름을 저장한다. JCR 카테고리는 입력으로 사용하지 않는다. 이 결과가 `journal-fields.json → journal-registry.json → registryLevels → workbench`로 전달되어 **대분류 / 분야 / 세부 분야**가 된다.

관련 코드: [수집과 상한](../../zotero-style-custom/scripts/build-journal-fields.py#L23), [OpenAlex 호출](../../zotero-style-custom/scripts/build-journal-fields.py#L36), [분류 추출](../../zotero-style-custom/scripts/build-journal-fields.py#L83), [레지스트리 병합](../../zotero-style-custom/scripts/build-journal-fields.py#L123), [화면 명칭](../../zotero-style-custom/src/workbench.js#L1999).

| 항목 | 현재 제품에서 확인한 내용 | 공식 분류와의 관계 |
| --- | --- | --- |
| 대분류 | OpenAlex domain 4개 | JCR 탐색용 Groups와 같은 체계가 아님 |
| 분야 | OpenAlex field 26개 | JCR Subject Category를 불러온 것이 아님 |
| 세부 분야 | OpenAlex subfield 이름 245개, 상위 경로를 포함하면 251개 조합 | 이름만 저장하므로 공식 식별자 기준 목록도 아님 |
| JCR의 카테고리 | 원본 카테고리 ID·할당·연도별 순위 데이터 없음 | 2026 JCR 공식 안내는 254개 연구 카테고리 |

OpenAlex 공식 계층은 **4 domains → 26 fields → 252 subfields → 4,516 topics**이며, 논문에 부여한 주제가 상위 분야로 연결된다. 따라서 로컬의 245개 이름을 공식 subfield ID 245개로 해석하거나, 단순히 7개 분야가 누락됐다고 계산하면 안 된다. [OpenAlex Fields](https://help.openalex.org/data/fields/).

JCR는 저널에 하나 이상의 Subject Category를 부여하고 카테고리별 순위를 제공한다. JCR의 Groups는 카테고리 탐색용 묶음이다. Clarivate가 작성한 2022 사용자 안내에서는 카테고리가 여러 그룹에 속할 수 있다고 설명한다. 이를 OpenAlex의 고정된 세 단계와 일대일 대응시킬 수 없다. 현재 전체 그룹 목록은 확보하지 않았으므로 과거 안내의 그룹 수를 2026 확정값으로 사용하지 않았다. [JCR Glossary](https://journalcitationreports.zendesk.com/hc/en-gb/articles/28351666061457-Glossary), [Clarivate 사용자 안내 51쪽](https://library.iliauni.edu.ge/wp-content/uploads/2024/06/Journal-Citation-Reports_User-guide-.pdf#page=51).

Clarivate의 문헌 단위 Citation Topics와 ESI 분류 역시 별도 체계다. 현재 코드는 이들 체계도 사용하지 않는다. 세 단계로 보인다는 이유만으로 JCR 또는 Citation Topics라고 볼 수 없다.

## 2. 분야 순위·Q는 자체 계산이며 동점 처리도 JCR과 다르다 — 높음

`journal-identity.js`는 OpenAlex 분야에 속한 로컬 저널들을 JIF 내림차순, 동점은 저널 이름순으로 정렬한다. 그 후 `index + 1`을 순위로 부여하고 `ceil(rank / count × 4)`로 Q를 만든다. 이 값이 저널 표의 **분야 순위**, 툴팁의 Q, 상세 화면에 표시된다. JCR에서 받은 카테고리 순위가 아니다. [계산 코드](../../zotero-style-custom/src/journal-identity.js#L531), [표 표시](../../zotero-style-custom/src/workbench.js#L2131).

캡처한 실제 제품 모듈과 전체 레지스트리를 실행한 대표 결과:

| 저널 | 자체 계산의 첫 번째 세부 분야 | 표시용 분야 순위 |
| --- | --- | ---: |
| Nature | Astronomy and Astrophysics | 2 / 270 |
| Science | Economics and Econometrics | 7 / 2,903 |
| Lancet | Economics and Econometrics | 2 / 2,903 |
| Chemical Reviews | Physical and Theoretical Chemistry | 1 / 91 |

이 표는 제품의 실제 출력이며, 각 저널의 공식 JCR 카테고리·순위 표가 아니다. 이름이 익숙하거나 주제상 관련이 있어도 JCR 지정 분류라는 근거가 되지 않는다.

동점 문제는 분류 차이와 별개로 재현된다. 현재 자체 `Oncology` 그룹에서:

- **Medical Oncology:** JIF 4.7, 178 / 713, **Q1**
- **Oncologist:** JIF 4.7, 179 / 713, **Q2**

Clarivate는 같은 카테고리에서 JIF가 같은 저널에 **같은 순위와 같은 Q**를 부여하며, 다음 순위를 건너뛰는 방식으로 설명한다. 제품은 이름순으로 순위를 갈라서 Q 경계를 나눈다. 전체 자체 그룹에서 이와 같은 **동일 JIF 인접 행의 Q 경계 분리 569건**을 관찰했다. 이는 그룹별 인접 쌍의 합계이며, 고유 저널 수나 공식 JCR과 불일치하는 저널 수가 아니다. [Clarivate 동점 규칙](https://clarivate.com/academia-government/blog/a-primer-on-ties-in-the-jcr/).

공식 JIF 순위가 없는 카테고리도 구분해야 한다. Clarivate의 2024 정책은 과학·사회과학 229개 카테고리의 순위를 통합하고, 예술·인문학 전용 25개 카테고리에는 JIF 순위를 제공하지 않는다고 설명한다. 모든 분야에 임의의 JIF Q를 만들면 이 차이도 사라진다. 이 수치는 해당 정책 발표 기준이며, 연도별 원본에서 적용 여부를 확인해야 한다. [Clarivate 순위 정책](https://clarivate.com/academia-government/blog/2024-journal-citation-reports-changes-in-journal-impact-factor-category-rankings-to-enhance-transparency-and-inclusivity/).

표의 별도 **JCR 사분위** 열은 다른 경로다. 이것은 로컬 JCR 입력의 설명 문자열에서 처음 나타나는 `Q1`~`Q4` 하나를 추출한 값이다. 어떤 카테고리의 Q인지 저장하지 않으므로 카테고리별 다중 Q를 보존할 수 없다. 따라서 별도 Q 열과 분야 순위 툴팁의 Q는 출처부터 다르다. [단일 Q 추출](../../zotero-style-custom/scripts/build-journal-registry.py#L35).

또한 **JCR 순위**라는 이름으로 노출하는 전체 순위는 로컬 전체 목록을 정렬한 순번이다. 공식 카테고리별 순위와 구별해야 한다. [전체 순번 생성](../../zotero-style-custom/src/journal-identity.js#L519), [상세 표시](../../zotero-style-custom/src/workbench.js#L2186).

## 3. 같은 이름의 서로 다른 분야를 합치고, 잘못된 경로도 검색된다 — 높음

저장된 세부 분야 이름 중 `Genetics`, `Neurology`, `Pharmacology`, `Physiology`, `Biochemistry`, `Archeology`는 각각 다른 상위 분야에 존재한다. 하지만 공식 ID를 버리고 이름으로 묶으며, 분야 순위도 `subfield + 이름`으로 그룹화한다. 예를 들어 Medicine 아래 Genetics와 Biochemistry, Genetics and Molecular Biology 아래 Genetics가 하나의 순위 모집단에 섞인다.

필터는 선택한 세 값이 **같은 경로에 있는지** 확인하지 않고, 각 값이 저널의 어느 경로에든 존재하면 통과시킨다. 캡처된 실제 `matches` 함수를 추출하여 전체 레지스트리에 실행했다. [필터 코드](../../zotero-style-custom/src/workbench.js#L1971).

| 선택한 경로 | 현재 필터 결과 | 같은 세 단계 경로를 실제 가진 저널 | 다른 경로를 섞어 통과한 수 |
| --- | ---: | ---: | ---: |
| Life Sciences → Biochemistry, Genetics and Molecular Biology → Genetics | 952 | 907 | **45** |
| Health Sciences → Biochemistry, Genetics and Molecular Biology → Genetics | 531 | 0 | **531** |

두 번째 경로는 레지스트리에 존재하지 않는데도 결과가 나온다. 세부 분야 선택 시 상위 값을 채우는 코드도 기존 대분류를 존중하지 않고 전체 이름을 탐색하므로 이런 조합을 만들 수 있다. [상위 분야 자동 선택](../../zotero-style-custom/src/workbench.js#L2044). 필요한 검사는 저널의 한 경로가 선택 조건을 모두 충족하는지 여부다.

위 수치는 번들 전체 목록을 실제 필터 함수에 넣은 결과다. 실제 화면은 서재에 있는 저널에 캐시 분류를 대입하므로 현재 화면의 건수와 같다고 주장하지 않는다.

## 4. 캐시 유무에 따라 분류가 바뀌고 순위와 어긋난다 — 높음

번들 생성은 **상위 8개 주제 → 합산한 분류 경로 최대 4개**다. 반면 실시간 프로필은 상위 6개 주제를 보관하고, 저널 화면에서는 그중 **첫 2개 주제만** 사용해 번들 분류를 대체한다. 이때 같은 분류를 중복 제거하지도 않는다. [프로필 제한](../../zotero-style-custom/src/journal-metrics.js#L89), [화면의 대체 조건](../../zotero-style-custom/src/workbench.js#L1919).

현재 저장된 공개 저널 메타데이터 캐시와 캡처한 `journalFacts`를 실행한 결과, **Nature Methods**는:

- 번들: Molecular Biology / Biophysics / Spectroscopy / Structural Biology
- 캐시가 있는 화면용 분류: **Biophysics / Biophysics**
- 분야 순위: 여전히 번들에서 계산한 **Molecular Biology 27 / 1,813**

즉 표시·필터 기준과 순위 기준이 서로 다르다. Nature와 Science에서도 뒤쪽 분류가 사라진다. 검증한 캐시의 `profileAt`은 `2026-09-19T03:43:08.375Z`다. 이는 실제 저장 자료와 설치본과 동일한 코드로 재구성한 결과이며, 사용자의 열린 화면을 직접 조작한 검증은 아니다.

프로필 상세의 `fields`와 필터용 `levels`도 다른 배열을 사용한다. 번들에만 분류가 있는 저널은 표에는 분야가 있지만 상세 프로필은 빈 배열을 받는 경로가 있다.

## 5. 완전한 목록·연도별 원본이라는 근거도 부족하다 — 중간

전체 파일을 디코딩하고 중간 생성 자료와 **22,594행 전부** 대조했다. 병합 결과는 일치하므로 단순 복사·압축 손상 때문은 아니다. 잘못된 출처와 변환이 일관되게 반영된 상태다.

- 로컬 저널 **22,594종** 중 분류 있음 **22,181종(98.1721%)**, 없음 **413종**.
- 19,778종은 경로가 정확히 4개다. 코드의 4개 상한은 확인했지만 원래 전체 주제를 보관하지 않아 각 저널에서 추가로 생략된 경로 수는 확정할 수 없다.
- 레지스트리는 JCR 카테고리 ID, OpenAlex 분야 ID, 카테고리별 순위·Q·모집단·분류 판본을 보존하지 않는다.
- 2026 JCR 공식 발표는 **22,643종 / 254개 카테고리**다. 로컬의 ‘전체 JCR 22,594종’과 49종 차이가 있으므로 전체 동일 목록이라는 주장은 검증되지 않는다. 공식 전체 식별자 목록을 확보하지 않았으므로 이를 곧바로 ‘특정 49종 누락’으로 단정하지 않는다. [2026 JCR 공식 발표](https://clarivate.com/ko/news/clarivate-releases-2026-journal-citation-reports/).

이번 감사는 분류와 관련 순위의 일치성을 판정했다. 모든 JIF 수치의 진위나 특정 저널의 최신 공식 카테고리를 전수 확인한 것은 아니다. 현재 자료만으로 전수 일치율을 만들어낼 수 없다.

## JCR과 일치시키려면 필요한 변경

1. JCR의 연도별 **저널 ID/ISSN → 공식 카테고리 ID·명칭 → 카테고리별 rank·모집단·quartile·percentile** 원본을 확보하고 보존해야 한다. Groups는 공식 다중 소속 관계를 별도로 다뤄야 한다.
2. OpenAlex 주제 탐색을 유지한다면 출처를 명시하고 JCR 분류·순위와 별도의 선택 모드로 제공해야 한다. 이름만 바꾸는 것으로 동등성이 생기지 않는다.
3. 단일 Q 추출과 자체 전체 ‘JCR 순위’를 공식 지표와 구분하고, 자체 순위를 유지할 경우 동점 처리와 모집단을 명시해야 한다.
4. 표시·필터·순위가 동일한 식별자와 분류 경로를 사용하도록 통일해야 한다. 다른 경로 간 조건 혼합, 이름 충돌, 캐시의 상위 2개 덮어쓰기를 해결해야 한다.
5. 공식 전체 목록을 기준으로 누락·추가·다중 카테고리·동점·연도 변화까지 비교해야 완전 일치를 판정할 수 있다.

## 재현 자료

- [전체 측정값과 실제 모듈 실행 결과](measurements.json)
- [설치본·작업 소스 스냅샷 해시](snapshot.json)
- [측정 스크립트](measure.py), [실제 순위·필터·화면 데이터 함수 검증](rank-probe.cjs)

`python3 benchmark/jcr-classification-audit-2026-09-20/measure.py --verify`로 로컬 보존 스냅샷의 측정값을 재계산하고 현재 파일·설치본 변경 여부를 확인할 수 있다. 전체 원본 데이터와 선택한 공개 저널 프로필 스냅샷은 로컬 `build/jcr-classification-audit-20260920/`에 보관했다.

독립 검토와 최종 재측정을 마쳤다. Unlazy 감사 기준은 **충족 6개 / 미충족 0개 / 포기 0개**다. 이는 감사 완료를 뜻하며, 제품의 JCR 일치 판정은 **실패**다. 최종 확인에서 조사 대상 작업 파일·설치본·선택한 캐시 프로필의 변경은 없었다.
