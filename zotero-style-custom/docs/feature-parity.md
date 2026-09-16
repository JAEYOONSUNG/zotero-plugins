# 기능 대조표 — Style Custom 0.8.0

설치된 Ethereal Style 6.0.76의 모든 기능 스위치 **50개**와 추가 워크플로 7개를 대조했습니다. 기존 48개 목록은 점이 들어간 `reader.mergeAnnotations`, `reader.attachmentVersionSwitch`를 놓쳤습니다. 이번에는 두 항목과 실제 세부 조작을 함께 보완했습니다.

0.6.0에서 추가하고 현재 버전에서 회귀 검증하는 [18회 개선 기록](improvement-rounds.json)은 각 기능의 진입점·구현·회귀 테스트와 별도 검토 기록을 연결합니다. 이 표는 기능별 대응표입니다. 과거 답변에서 이를 세부 환경설정까지 완성한 것처럼 설명한 것은 부정확했습니다. 0.8.0은 실제로 연결된 설정을 별도 [설정 대조표](settings-coverage.json)로 관리합니다. 원본 화면과 모든 옵션이 같다는 뜻이 아니며, 사용자 UI나 별도 Zotero 인스턴스를 실행하지 않았습니다. 검증 범위는 Node/DOM·로컬 Zotero API 소스·임시 프로필 설치기입니다.

| 원본 기능 | 대응 기능 | 진입점 | 조건/차이 |
|---|---|---|---|
| AIGenerateRemark | AI 읽기 메모 제안 | 워크벤치 → 번역 · AI | 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음 |
| AIGenerateTags | AI 태그 제안 | 워크벤치 → 번역 · AI | 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음 |
| IFColumn | IF 열 | IF · Custom | 공식 카탈로그·저장 데이터 범위 |
| PDFStyles | PDF 테마·사용자 색상·원래 모양 복원 | 읽기 진행 / PDF Style 도구 | 복원은 Custom이 추적한 원래 테마·사이드바 적용 |
| ReadUnreadStatus | 읽음·안 읽음 제목 구분 | 스타일 편집 → 안 읽은 제목 굵게 | — |
| Recent | 최근 문헌 | 워크벤치 → 최근 문헌 | — |
| addTags | 태그 추가·제거·경로 이름 변경·병합 | 워크벤치 → 중첩 태그 | 선택 문헌 범위에서만 변경; 상태·별점 전용 태그 경로 변경 제외 |
| annotationColors | 주석 색상·팔레트 | 읽기 진행 / PDF Style 도구 | — |
| annotationColumn | 주석 수·페이지별 색상 분포·원문 이동 | Annotations · Custom | 색상 막대는 주석이 있는 페이지를 표시; 문서 전체 진행률로 추정하지 않음 |
| annotationManager | 주석 관리·범위 선택·색상 일괄 변경·노트 추출 | 워크벤치 → 주석 | 현재 컬렉션·하위 컬렉션·선택 문헌 범위 |
| attachmentPreview | 첨부 미리보기 | 워크벤치 → 첨부 미리보기 | Zotero 9 attachment-preview 컴포넌트 |
| backlinks | 주석별 참조 노트 수·역링크 | PDF 주석 머리글 / 워크벤치 → 주석·역링크 | 같은 PDF의 다른 주석 및 다른 라이브러리 참조 구분 |
| canvas | 카드·보드 이름·색상·연결 편집과 삭제 복원 | 워크벤치 → 캔버스 | 문헌/메모 카드; 보드 최대100개, 카드 최대500개 |
| citedCountColumn | 인용 수 열·자동 조회 | Cited Count · Custom | — |
| collectionItemCount | 컬렉션 문헌 수 | 워크벤치 → 컬렉션 | — |
| creatorColumn | 저자·기여자 열 | Creators · Custom | — |
| darkLightButton | 앱 밝게·어둡게 전환 | 워크벤치 → 스타일 편집 | — |
| dateAddedColumn | 추가일·수정일 열 | Added / Modified · Custom | — |
| explore | 문헌 상세·노트·주석·필터·정렬·페이지 탐색 | 워크벤치 → 문헌 탐색 | 상태·별점·연도 필터 및 현재 컬렉션 범위; 화면100개씩 페이지 이동 |
| favoriteCollections | 컬렉션 즐겨찾기 | 워크벤치 → 컬렉션 | — |
| graphView | 관계·태그·저자 그래프 | 워크벤치 → 관계 그래프 | 화면 최대180노드, 검색으로 범위를 좁힘 |
| itemTypeFilter | 항목 유형 빠른 필터 | 항목 아이콘 / 작업 패널 유형 필터 | — |
| marginAnnotation | 여백 주석과 위치·너비·표시 길이 설정 | 읽기 진행 / PDF Style 도구 | 왼쪽/오른쪽, 너비160–480px, 발췌100–5000자 |
| menuVisibility | 작업 메뉴 표시·숨김 | 워크벤치 → 스타일 편집 | — |
| noteManager | 노트 검색·생성·편집 | 워크벤치 → 노트 | 기존 리치 노트 편집은 Zotero 네이티브 편집기로 연결 |
| publicationColumn | 저널·발행처 열 | Publication · Custom | — |
| publicationTagsColumn | 저널 등급 태그·조회 | Journal Tags · Custom / 저널 지표 | 추가 등급 조회는 본인의 easyScholar 키 필요 |
| ratingColumn | 별점 표시·편집 | Rating · Custom | — |
| readStatus | 읽기 시간·상태 연동 | Status · Custom | — |
| readTimeColumn | 활성 읽기 시간 | Read Time · Custom | — |
| relatedItems | 선택 문헌 연결·상호 연결 해제 | 작업 패널 하단 | 같은 라이브러리 문헌; 다른 문헌의 연결 보존 |
| remarkColumn | 읽기 메모 열 | Remark · Custom / 상세 문헌 메모 | — |
| renderItemAnnotations | 문헌 상세에 주석 직접 표시 | 문헌 탐색 → 자세히 / 주석 탭 | 다른 탭·문헌으로 전환 시 늦은 응답 무시 |
| renderItemNotes | 문헌 상세에 노트 직접 표시 | 문헌 탐색 → 자세히 / 노트 탭 | 단일 문헌 상세에서 노트·주석 함께 표시 |
| showAnnotationColorName | 주석 색상 이름 | 읽기 진행 → 색상 이름 | — |
| sortCollectionItem | 컬렉션 이름·개수·즐겨찾기 정렬 | 워크벤치 → 컬렉션 | — |
| statusColumn | 상태 열·수동 지정 | Status · Custom / 문헌 우클릭 | — |
| styleEditor | 패널 CSS 편집 | 워크벤치 → 스타일 편집 | 패널 범위 CSS, 외부 로딩 규칙 제외 |
| tabManager | 탭 순서·다른 탭 닫기·저장 그룹 편집 | 워크벤치 → 탭 관리 | 그룹 이름·내용 갱신; 라이브러리 탭 보호 |
| tags | 중첩 태그 탐색 | 워크벤치 → 중첩 태그 | — |
| tagsColumn | 색상 태그 표시 | Tags · Custom / 제목 태그 | — |
| textTagsColumn | 텍스트 태그·태그 수 | Tags / #Tags · Custom | — |
| titleColumn | 제목 히트맵·태그·강조 | 스타일 편집 / 문헌 제목 | — |
| tldr | 초록 요약 | 워크벤치 → 번역 · AI | 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음 |
| toogleSidebar | 리더 사이드바 토글 | 읽기 진행 / PDF Style 도구 | — |
| updateItemDateModified | 탭 활동 시 수정일 갱신 | 스타일 편집 → 수정일 갱신 | 기본 꺼짐; 사용자 선택 시 첨부·부모 날짜 갱신 |
| verticalTabManager | 독립 세로 탭 목록 | 탭 관리 / PDF Style 도구 | — |
| viewManager | 열 배치 저장·복원·이름·내용 갱신 | 워크벤치 → 뷰 그룹 | 열 순서·너비·표시·정렬 저장 |
| titleMarquee | 제목 호버 롤링 | 문헌 제목 호버 | — |
| titleTranslate | 제목 번역 | 워크벤치 → 번역 · AI | 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음 |
| paperMatrix | 항목 선택·페이지 탐색·전체 CSV 비교표 | 워크벤치 → 논문 비교 | 화면50개씩, CSV는 전체 선택/필터 결과 |
| customColumn | 사용자 추가 필드 열 | 스타일 편집 → 추가 문헌 열 | — |
| perPageReading | 첨부별 페이지 읽기 기록 | 읽기 진행 / Pages · Custom | — |
| metadataCitations | 메타데이터 인용 수 자동 저장 | 논문 추가·메타데이터 변경 | — |
| durableDrafts | 초안 저장·복원 | 작성 중 노트·메모·AI 결과 | — |
| reader.mergeAnnotations | 선택 주석 병합 | PDF 주석 우클릭·Style 메뉴 / 워크벤치 → 주석 | 동일 PDF·유형·색상인 하이라이트/밑줄, 같은 페이지 또는 인접 두 페이지; 위치·텍스트·메모·태그 보존, 나머지는 휴지통 |
| reader.attachmentVersionSwitch | PDF 첨부 버전 전환 | PDF Style 메뉴 → Switch PDF version | 같은 문헌에 속한 실제 존재하는 PDF만 선택; 기존 탭 유지 |

## 구현 범위와 차이

- 읽기 기록은 기본적으로 `style-custom.json`에 저장합니다. 원본의 숨겨진 Addon Item 노트 저장 방식이나 기기 간 자동 병합을 복제하지 않았습니다.
- IF·저널 등급·인용 수는 확인 가능한 기존 데이터와 설정된 제공자 범위를 따릅니다. 원본의 Google Scholar/CNKI 및 세부 인용 분류 수치를 같은 값으로 간주하지 않습니다. AI와 별도 저널 등급 API에는 사용자 설정이 필요합니다.
- 주석 병합은 같은 PDF·유형·색상의 하이라이트 또는 밑줄 2–50개를 처리합니다. 같은 페이지 또는 인접 두 페이지의 위치를 보존합니다. 합쳐진 나머지 항목은 휴지통으로 보내며, 기존 노트의 개별 주석 링크는 자동으로 다시 쓰지 않습니다.
- PDF 버전을 바꿀 때 기존 탭을 유지합니다. 세로 탭은 별도 패널로 제공하며 Zotero의 탭 영역을 교체하지 않습니다.
- CSS 편집은 Custom 패널 범위입니다. 그래프는 화면당 최대180노드, 캔버스는 보드100개/카드500개입니다. 앱 전체 CSS 주입이나 원본과 동일한 그래프 엔진·장식 옵션은 제공하지 않습니다.
