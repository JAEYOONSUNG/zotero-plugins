/* Explicit typed settings shared by the runtime and the preferences pane. */
(function(root){
 'use strict';
 const schema={
  "categories": [
    {
      "id": "columns",
      "label": "열 표시",
      "description": "메인 문헌 목록의 지표·상태·별점·읽기 시간과 추가 열을 조절합니다."
    },
    {
      "id": "views",
      "label": "뷰·작업 패널",
      "description": "기능별 작업 패널과 표시 밀도·목록 크기를 조절합니다."
    },
    {
      "id": "reader",
      "label": "리더·주석",
      "description": "PDF 테마와 여백 주석의 실제 표시·필터를 조절합니다."
    },
    {
      "id": "sidebar",
      "label": "사이드바·탭",
      "description": "리더 사이드바와 세로 탭·저장 그룹을 조절합니다."
    },
    {
      "id": "tags",
      "label": "태그",
      "description": "태그 표시 방식과 제목 옆 태그를 조절합니다."
    },
    {
      "id": "collections",
      "label": "컬렉션",
      "description": "개수·즐겨찾기·정렬 기능을 선택합니다."
    },
    {
      "id": "menus",
      "label": "메뉴·디자인",
      "description": "작업 메뉴와 패널 디자인을 조절합니다."
    },
    {
      "id": "storage",
      "label": "읽기 기록",
      "description": "기록 간격·무활동 제외·상태 연동을 조절합니다. 읽기 기록은 로컬 파일에 저장합니다."
    },
    {
      "id": "metrics",
      "label": "인용 수·IF",
      "description": "실제 제공자와 조회 주기·메타데이터 저장을 설정합니다."
    },
    {
      "id": "ai",
      "label": "번역·AI",
      "description": "사용할 모델과 요청 문구를 직접 설정합니다. 요청은 사용자가 실행할 때만 전송됩니다."
    }
  ],
  "settings": [
    {
      "key": "feature.AIGenerateRemark",
      "category": "ai",
      "label": "AI 읽기 메모 제안 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 번역 · AI · 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.AIGenerateTags",
      "category": "ai",
      "label": "AI 태그 제안 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 번역 · AI · 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.IFColumn",
      "category": "columns",
      "label": "IF 열 사용",
      "type": "boolean",
      "default": true,
      "description": "IF · 공식 카탈로그·저장 데이터 범위",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.PDFStyles",
      "category": "reader",
      "label": "PDF 테마·사용자 색상·원래 모양 복원 사용",
      "type": "boolean",
      "default": true,
      "description": "읽기 진행 / PDF Style 도구 · 복원은 Custom이 추적한 원래 테마·사이드바 적용",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.ReadUnreadStatus",
      "category": "storage",
      "label": "읽음·안 읽음 제목 구분 사용",
      "type": "boolean",
      "default": true,
      "description": "스타일 편집 → 안 읽은 제목 굵게",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.Recent",
      "category": "views",
      "label": "최근 문헌 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 최근 문헌",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.addTags",
      "category": "tags",
      "label": "태그 추가·제거·경로 이름 변경·병합 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 중첩 태그 · 선택 문헌 범위에서만 변경; 상태·별점 전용 태그 경로 변경 제외",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.annotationColors",
      "category": "reader",
      "label": "주석 색상·팔레트 사용",
      "type": "boolean",
      "default": true,
      "description": "읽기 진행 / PDF Style 도구",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.annotationColumn",
      "category": "columns",
      "label": "주석 수·페이지별 색상 분포·원문 이동 사용",
      "type": "boolean",
      "default": true,
      "description": "Annotations · 색상 막대는 주석이 있는 페이지를 표시; 문서 전체 진행률로 추정하지 않음",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.annotationManager",
      "category": "views",
      "label": "주석 관리·범위 선택·색상 일괄 변경·노트 추출 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 주석 · 현재 컬렉션·하위 컬렉션·선택 문헌 범위",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.attachmentPreview",
      "category": "views",
      "label": "첨부 미리보기 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 첨부 미리보기 · Zotero 9 attachment-preview 컴포넌트",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.backlinks",
      "category": "views",
      "label": "주석별 참조 노트 수·역링크 사용",
      "type": "boolean",
      "default": true,
      "description": "PDF 주석 머리글 / 워크벤치 → 주석·역링크 · 같은 PDF의 다른 주석 및 다른 라이브러리 참조 구분",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.canvas",
      "category": "views",
      "label": "카드·보드 이름·색상·연결 편집과 삭제 복원 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 캔버스 · 문헌/메모 카드; 보드 최대100개, 카드 최대500개",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.citedCountColumn",
      "category": "columns",
      "label": "인용 수 열·자동 조회 사용",
      "type": "boolean",
      "default": true,
      "description": "Cited Count",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.collectionItemCount",
      "category": "collections",
      "label": "컬렉션 문헌 수 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 컬렉션",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.creatorColumn",
      "category": "columns",
      "label": "저자·기여자 열 사용",
      "type": "boolean",
      "default": true,
      "description": "Creators",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.darkLightButton",
      "category": "menus",
      "label": "앱 밝게·어둡게 전환 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 스타일 편집",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.dateAddedColumn",
      "category": "columns",
      "label": "추가일·수정일 열 사용",
      "type": "boolean",
      "default": true,
      "description": "Added / Modified",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.explore",
      "category": "views",
      "label": "문헌 상세·노트·주석·필터·정렬·페이지 탐색 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 보유 문헌 · 상태·별점·연도 필터 및 현재 컬렉션 범위; 화면100개씩 페이지 이동",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.favoriteCollections",
      "category": "collections",
      "label": "컬렉션 즐겨찾기 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 컬렉션",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.graphView",
      "category": "views",
      "label": "관계·태그·저자 그래프 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 관계 그래프 · 화면 최대180노드, 검색으로 범위를 좁힘",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.itemTypeFilter",
      "category": "columns",
      "label": "항목 유형 빠른 필터 사용",
      "type": "boolean",
      "default": true,
      "description": "항목 아이콘 / 작업 패널 유형 필터",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.marginAnnotation",
      "category": "reader",
      "label": "여백 주석과 위치·너비·표시 길이 설정 사용",
      "type": "boolean",
      "default": true,
      "description": "읽기 진행 / PDF Style 도구 · 왼쪽/오른쪽, 너비160–480px, 발췌100–5000자",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.menuVisibility",
      "category": "menus",
      "label": "작업 메뉴 표시·숨김 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 스타일 편집",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.noteManager",
      "category": "views",
      "label": "노트 검색·생성·편집 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 노트 · 기존 리치 노트 편집은 Zotero 네이티브 편집기로 연결",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.publicationColumn",
      "category": "columns",
      "label": "저널·발행처 열 사용",
      "type": "boolean",
      "default": true,
      "description": "Publication",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.publicationTagsColumn",
      "category": "columns",
      "label": "저널 등급 태그·조회 사용",
      "type": "boolean",
      "default": true,
      "description": "Journal Tags / 저널 지표 · 추가 등급 조회는 본인의 easyScholar 키 필요",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.ratingColumn",
      "category": "columns",
      "label": "별점 열 표시",
      "type": "boolean",
      "default": true,
      "description": "메인 문헌 목록에서 해당 열을 표시합니다.",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.readStatus",
      "category": "storage",
      "label": "읽기 시간·상태 연동 사용",
      "type": "boolean",
      "default": true,
      "description": "Status",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.readTimeColumn",
      "category": "columns",
      "label": "읽기 시간·페이지 진행 열 표시",
      "type": "boolean",
      "default": true,
      "description": "메인 문헌 목록에서 해당 열을 표시합니다.",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.relatedItems",
      "category": "views",
      "label": "선택 문헌 연결·상호 연결 해제 사용",
      "type": "boolean",
      "default": true,
      "description": "작업 패널 하단 · 같은 라이브러리 문헌; 다른 문헌의 연결 보존",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.remarkColumn",
      "category": "columns",
      "label": "읽기 메모 열 사용",
      "type": "boolean",
      "default": true,
      "description": "Remark / 상세 문헌 메모",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.renderItemAnnotations",
      "category": "views",
      "label": "문헌 상세에 주석 직접 표시 사용",
      "type": "boolean",
      "default": true,
      "description": "보유 문헌 → 자세히 / 주석 탭 · 다른 탭·문헌으로 전환 시 늦은 응답 무시",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.renderItemNotes",
      "category": "views",
      "label": "문헌 상세에 노트 직접 표시 사용",
      "type": "boolean",
      "default": true,
      "description": "보유 문헌 → 자세히 / 노트 탭 · 단일 문헌 상세에서 노트·주석 함께 표시",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.showAnnotationColorName",
      "category": "reader",
      "label": "주석 색상 이름 사용",
      "type": "boolean",
      "default": true,
      "description": "읽기 진행 → 색상 이름",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.sortCollectionItem",
      "category": "collections",
      "label": "컬렉션 이름·개수·즐겨찾기 정렬 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 컬렉션",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.statusColumn",
      "category": "columns",
      "label": "읽기 상태 열 표시",
      "type": "boolean",
      "default": true,
      "description": "메인 문헌 목록에서 해당 열을 표시합니다.",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.styleEditor",
      "category": "menus",
      "label": "패널 CSS 편집 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 스타일 편집 · 패널 범위 CSS, 외부 로딩 규칙 제외",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.tabManager",
      "category": "sidebar",
      "label": "탭 순서·다른 탭 닫기·저장 그룹 편집 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 탭 관리 · 그룹 이름·내용 갱신; 라이브러리 탭 보호",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.tags",
      "category": "tags",
      "label": "중첩 태그 탐색 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 중첩 태그",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.tagsColumn",
      "category": "tags",
      "label": "색상 태그 표시 사용",
      "type": "boolean",
      "default": true,
      "description": "Tags / 제목 태그",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.textTagsColumn",
      "category": "tags",
      "label": "텍스트 태그·태그 수 사용",
      "type": "boolean",
      "default": true,
      "description": "Tags / #Tags",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.titleColumn",
      "category": "columns",
      "label": "제목 히트맵·태그·강조 사용",
      "type": "boolean",
      "default": true,
      "description": "스타일 편집 / 문헌 제목",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.tldr",
      "category": "ai",
      "label": "초록 요약 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 번역 · AI · 사용자 설정 endpoint·모델 필요; 실제 서비스 호출은 이번 검증에서 실행하지 않음",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.toogleSidebar",
      "category": "sidebar",
      "label": "리더 사이드바 토글 사용",
      "type": "boolean",
      "default": true,
      "description": "읽기 진행 / PDF Style 도구",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.updateItemDateModified",
      "category": "storage",
      "label": "탭 활동 시 수정일 갱신 사용",
      "type": "boolean",
      "default": true,
      "description": "스타일 편집 → 수정일 갱신 · 기본 꺼짐; 사용자 선택 시 첨부·부모 날짜 갱신",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.verticalTabManager",
      "category": "sidebar",
      "label": "독립 세로 탭 목록 사용",
      "type": "boolean",
      "default": true,
      "description": "탭 관리 / PDF Style 도구",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.viewManager",
      "category": "views",
      "label": "열 배치 저장·복원·이름·내용 갱신 사용",
      "type": "boolean",
      "default": true,
      "description": "워크벤치 → 뷰 그룹 · 열 순서·너비·표시·정렬 저장",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.reader.mergeAnnotations",
      "category": "reader",
      "label": "선택 주석 병합 사용",
      "type": "boolean",
      "default": true,
      "description": "PDF 주석 우클릭·Style 메뉴 / 워크벤치 → 주석 · 동일 PDF·유형·색상인 하이라이트/밑줄, 같은 페이지 또는 인접 두 페이지; 위치·텍스트·메모·태그 보존, 나머지는 휴지통",
      "consumer": "featureEnabled"
    },
    {
      "key": "feature.reader.attachmentVersionSwitch",
      "category": "reader",
      "label": "PDF 첨부 버전 전환 사용",
      "type": "boolean",
      "default": true,
      "description": "PDF Style 메뉴 → Switch PDF version · 같은 문헌에 속한 실제 존재하는 PDF만 선택; 기존 탭 유지",
      "consumer": "featureEnabled"
    },
    {
      "key": "showZeroReadTime",
      "category": "columns",
      "label": "기록이 없어도 0초 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "titleHeatmap",
      "category": "columns",
      "label": "제목에 읽기 히트맵 표시",
      "type": "boolean",
      "default": false
    },
    {
      "key": "unreadBold",
      "category": "columns",
      "label": "안 읽은 제목 굵게",
      "type": "boolean",
      "default": false
    },
    {
      "key": "timeFormat",
      "category": "columns",
      "label": "읽기 시간 표시 형식",
      "type": "select",
      "default": "compact",
      "options": [
        {
          "value": "compact",
          "label": "1h 20m 05s"
        },
        {
          "value": "clock",
          "label": "01:20:05"
        },
        {
          "value": "seconds",
          "label": "4805초"
        }
      ]
    },
    {
      "key": "dateDisplay",
      "category": "columns",
      "label": "날짜 표시",
      "type": "select",
      "default": "absolute",
      "options": [
        {
          "value": "absolute",
          "label": "저장된 날짜"
        },
        {
          "value": "relative",
          "label": "몇 시간·며칠 전"
        }
      ]
    },
    {
      "key": "customFields",
      "category": "columns",
      "label": "추가 필드 열",
      "type": "text",
      "default": "",
      "description": "쉼표로 DOI, publisher, language 등 Zotero 필드명을 입력합니다."
    },
    {
      "key": "recordReading",
      "category": "storage",
      "label": "활성 PDF 읽기 시간 기록",
      "type": "boolean",
      "default": true
    },
    {
      "key": "autoStatus",
      "category": "storage",
      "label": "읽기 시작 시 reading 상태 자동 반영",
      "type": "boolean",
      "default": true
    },
    {
      "key": "touchDateOnRead",
      "category": "storage",
      "label": "읽는 문헌의 수정일 갱신",
      "type": "boolean",
      "default": false
    },
    {
      "key": "recordIntervalMs",
      "category": "storage",
      "label": "기록·표시 갱신 간격 (ms)",
      "type": "number",
      "default": 1000,
      "min": 250,
      "max": 5000,
      "step": 250,
      "description": "기본 1초. 비활성 창과 무활동 시간은 제외합니다."
    },
    {
      "key": "idleSeconds",
      "category": "storage",
      "label": "무활동 제외 기준 (초)",
      "type": "number",
      "default": 60,
      "min": 5,
      "max": 300,
      "step": 1
    },
    {
      "key": "workbenchDensity",
      "category": "views",
      "label": "화면 밀도",
      "type": "select",
      "default": "comfortable",
      "options": [
        {
          "value": "comfortable",
          "label": "간격 넓게"
        },
        {
          "value": "compact",
          "label": "간격 좁게"
        }
      ]
    },
    {
      "key": "explorePageSize",
      "category": "views",
      "label": "한 페이지 문헌 수",
      "type": "number",
      "default": 100,
      "min": 25,
      "max": 200,
      "step": 1
    },
    {
      "key": "matrixPageSize",
      "category": "views",
      "label": "비교표 한 페이지 문헌 수",
      "type": "number",
      "default": 50,
      "min": 10,
      "max": 100,
      "step": 1
    },
    {
      "key": "inlineEvidenceCount",
      "category": "views",
      "label": "처음 펼칠 노트·주석 수",
      "type": "number",
      "default": 5,
      "min": 1,
      "max": 20,
      "step": 1
    },
    {
      "key": "maxExcerptLength",
      "category": "views",
      "label": "본문 발췌 표시 글자 수",
      "type": "number",
      "default": 1200,
      "min": 200,
      "max": 5000,
      "step": 1
    },
    {
      "key": "graphNodeLimit",
      "category": "views",
      "label": "그래프 최대 문헌 수",
      "type": "number",
      "default": 180,
      "min": 20,
      "max": 180,
      "step": 1
    },
    {
      "key": "annotationIgnoreFigures",
      "category": "views",
      "label": "Figure·Table로 시작하는 주석 제외",
      "type": "boolean",
      "default": false
    },
    {
      "key": "annotationPreferComment",
      "category": "views",
      "label": "주석 텍스트보다 메모를 우선 표시",
      "type": "boolean",
      "default": false
    },
    {
      "key": "readerTheme",
      "category": "reader",
      "label": "PDF 테마",
      "type": "select",
      "default": "original",
      "options": [
        {
          "value": "original",
          "label": "원래 테마 유지"
        },
        {
          "value": "light",
          "label": "밝게"
        },
        {
          "value": "dark",
          "label": "어둡게"
        },
        {
          "value": "sepia",
          "label": "세피아"
        },
        {
          "value": "custom",
          "label": "사용자 색상"
        }
      ]
    },
    {
      "key": "readerCustomBackground",
      "category": "reader",
      "label": "사용자 PDF 배경",
      "type": "color",
      "default": "#ffffff"
    },
    {
      "key": "readerCustomForeground",
      "category": "reader",
      "label": "사용자 PDF 글자",
      "type": "color",
      "default": "#202d46"
    },
    {
      "key": "marginEnabled",
      "category": "reader",
      "label": "여백 주석 표시",
      "type": "boolean",
      "default": false
    },
    {
      "key": "marginSide",
      "category": "reader",
      "label": "여백 위치",
      "type": "select",
      "default": "right",
      "options": [
        {
          "value": "right",
          "label": "오른쪽"
        },
        {
          "value": "left",
          "label": "왼쪽"
        }
      ]
    },
    {
      "key": "marginWidth",
      "category": "reader",
      "label": "여백 주석 너비 (px)",
      "type": "number",
      "default": 210,
      "min": 160,
      "max": 480,
      "step": 1
    },
    {
      "key": "marginFontSize",
      "category": "reader",
      "label": "여백 주석 글자 크기",
      "type": "number",
      "default": 13,
      "min": 10,
      "max": 22,
      "step": 1
    },
    {
      "key": "marginTextLimit",
      "category": "reader",
      "label": "여백 주석 최대 글자 수",
      "type": "number",
      "default": 1500,
      "min": 100,
      "max": 5000,
      "step": 1
    },
    {
      "key": "marginShowQuote",
      "category": "reader",
      "label": "인용 텍스트 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowComment",
      "category": "reader",
      "label": "주석 메모 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowHighlight",
      "category": "reader",
      "label": "하이라이트 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowUnderline",
      "category": "reader",
      "label": "밑줄 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowNote",
      "category": "reader",
      "label": "메모 주석 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowImage",
      "category": "reader",
      "label": "이미지 주석 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowText",
      "category": "reader",
      "label": "텍스트 주석 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "marginShowInk",
      "category": "reader",
      "label": "펜 주석 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "readerSidebar",
      "category": "sidebar",
      "label": "리더 사이드바 표시",
      "type": "boolean",
      "default": true
    },
    {
      "key": "verticalTabs",
      "category": "sidebar",
      "label": "세로 탭 목록 표시",
      "type": "boolean",
      "default": false
    },
    {
      "key": "language",
      "category": "menus",
      "label": "언어 / Language",
      "help": "자동은 Zotero 자체 언어를 따릅니다. English follows Zotero's own language when set to Auto.",
      "type": "select",
      "default": "auto",
      "options": [
        {
          "value": "auto",
          "label": "자동 (Zotero 설정을 따름) / Auto"
        },
        {
          "value": "ko-KR",
          "label": "한국어"
        },
        {
          "value": "en-US",
          "label": "English"
        }
      ]
    },
    {
      "key": "tagDisplayMode",
      "category": "tags",
      "label": "태그 열 표시 대상",
      "type": "select",
      "default": "all",
      "options": [
        {
          "value": "all",
          "label": "모든 일반 태그"
        },
        {
          "value": "colored",
          "label": "색상이 지정된 태그"
        },
        {
          "value": "prefixed",
          "label": "접두사와 일치하는 태그"
        }
      ]
    },
    {
      "key": "textTagPrefix",
      "category": "tags",
      "label": "텍스트 태그 접두사",
      "type": "text",
      "default": "#"
    },
    {
      "key": "titleTags",
      "category": "tags",
      "label": "제목 옆 태그 표시",
      "type": "boolean",
      "default": false
    },
    {
      "key": "titleTagLimit",
      "category": "tags",
      "label": "제목 옆 최대 태그 수",
      "type": "number",
      "default": 3,
      "min": 1,
      "max": 10,
      "step": 1
    },
    {
      "key": "marquee",
      "category": "columns",
      "label": "긴 제목 호버 스크롤",
      "type": "boolean",
      "default": true
    },
    {
      "key": "hoverDelay",
      "category": "columns",
      "label": "스크롤 시작 대기 (ms)",
      "type": "number",
      "default": 200,
      "min": 0,
      "max": 2000,
      "step": 50
    },
    {
      "key": "scrollSpeed",
      "category": "columns",
      "label": "스크롤 속도 (px/s)",
      "type": "number",
      "default": 180,
      "min": 30,
      "max": 600,
      "step": 10
    },
    {
      "key": "quickTypeFilter",
      "category": "columns",
      "label": "항목 아이콘으로 유형 필터",
      "type": "boolean",
      "default": true
    },
    {
      "key": "accentColor",
      "category": "menus",
      "label": "강조 색상",
      "type": "color",
      "default": "#374151"
    },
    {
      "key": "panelFontSize",
      "category": "menus",
      "label": "패널 글자 크기",
      "type": "number",
      "default": 13,
      "min": 11,
      "max": 20,
      "step": 1
    },
    {
      "key": "panelCSS",
      "category": "menus",
      "label": "Custom 패널 CSS",
      "type": "textarea",
      "default": "",
      "description": "패널 범위에만 적용됩니다. 외부 파일을 불러오는 CSS는 허용하지 않습니다.",
      "rows": 5
    },
    {
      "key": "autoCitations",
      "category": "metrics",
      "label": "보이는 문헌 인용 수 자동 조회",
      "type": "boolean",
      "default": true
    },
    {
      "key": "metadataCitations",
      "category": "metrics",
      "label": "논문 추가·수정 시 인용 수 조회 후 Extra 저장",
      "type": "boolean",
      "default": true
    },
    {
      "key": "citationRefreshDays",
      "category": "metrics",
      "label": "성공한 인용 수 재조회 간격 (일)",
      "type": "number",
      "default": 7,
      "min": 1,
      "max": 90,
      "step": 1
    },
    {
      "key": "citationRetryMinutes",
      "category": "metrics",
      "label": "조회 오류 재시도 간격 (분)",
      "type": "number",
      "default": 30,
      "min": 1,
      "max": 1440,
      "step": 1
    },
    {
      "key": "citationEmail",
      "category": "metrics",
      "label": "연락 이메일 (선택)",
      "help": "계정이 아닙니다. OpenAlex와 Crossref는 요청 URL에 ?mailto=주소를 붙이면 익명 요청보다 빠른 대기열(polite pool)에 넣어 줍니다. 대신 입력한 주소가 두 서비스의 서버 기록에 매 요청마다 남습니다. 비워 두면 아무것도 보내지 않고, 조회는 그대로 동작하되 느린 쪽 대기열을 씁니다. Zotero 로그인 계정을 대신 쓰는 일은 없습니다.",
      "type": "email",
      "default": ""
    },
    {
      "key": "openalexApiKey",
      "category": "metrics",
      "label": "OpenAlex API 키 (선택)",
      "type": "password",
      "default": "",
      "secret": true
    },
    {
      "key": "usptoApiKey",
      "category": "metrics",
      "label": "USPTO Open Data Portal 키 (선택)",
      "type": "password",
      "default": "",
      "secret": true,
      "description": "관심 저자의 특허 출원·등록을 찾는 데만 씁니다. data.uspto.gov에서 MyUSPTO 계정으로 무료 발급됩니다. 키는 api.uspto.gov에만 보내며, 비워 두면 특허 확인은 건너뜁니다."
    },
    {
      "key": "journalRankKey",
      "category": "metrics",
      "label": "easyScholar API 키",
      "type": "password",
      "default": "",
      "secret": true,
      "description": "별도 저널 등급 조회용입니다. IF는 공식 카탈로그·검증된 저장값과 자동 매칭합니다."
    },
    {
      "key": "aiEndpoint",
      "category": "ai",
      "label": "Chat Completions endpoint",
      "type": "url",
      "default": ""
    },
    {
      "key": "aiModel",
      "category": "ai",
      "label": "모델 이름",
      "type": "text",
      "default": ""
    },
    {
      "key": "aiKey",
      "category": "ai",
      "label": "API 키",
      "type": "password",
      "default": "",
      "secret": true
    },
    {
      "key": "aiLanguage",
      "category": "ai",
      "label": "출력 언어",
      "type": "text",
      "default": "Korean"
    },
    {
      "key": "aiTagsPrompt",
      "category": "ai",
      "label": "태그 제안 지시문",
      "type": "textarea",
      "default": "Suggest 3 to 8 concise topical tags for this abstract. Return only a JSON array of strings."
    },
    {
      "key": "aiRemarkPrompt",
      "category": "ai",
      "label": "읽기 메모 지시문",
      "type": "textarea",
      "default": "Write a concise research reading remark. Separate findings from limitations."
    },
    {
      "key": "open-workbench",
      "category": "views",
      "label": "연구 작업 패널 열기",
      "type": "action",
      "default": null,
      "action": "workbench"
    },
    {
      "key": "show-columns",
      "category": "columns",
      "label": "기본 Custom 열 표시",
      "type": "action",
      "default": null,
      "action": "columns"
    },
    {
      "key": "update-citations",
      "category": "metrics",
      "label": "선택 문헌 인용 수 조회",
      "type": "action",
      "default": null,
      "action": "citations"
    },
    {
      "key": "stop-citations",
      "category": "metrics",
      "label": "인용 수 조회 중지",
      "type": "action",
      "default": null,
      "action": "cancelCitations"
    },
    {
      "key": "update-if",
      "category": "metrics",
      "label": "선택 저널 공식 IF 확인",
      "type": "action",
      "default": null,
      "action": "journals"
    },
    {
      "key": "ranks",
      "category": "metrics",
      "label": "선택 저널 등급 조회",
      "type": "action",
      "default": null,
      "action": "ranks"
    }
  ]
};
 function validate(key,value){const setting=schema.settings.find(row=>row.key===key);if(!setting||setting.type==='action')throw new Error('Unknown setting: '+key);
  if(setting.type==='boolean'){if(typeof value!=='boolean')throw new Error('참/거짓 값을 선택하세요.');}
  else if(setting.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||value<setting.min||value>setting.max||setting.step&&!Number.isInteger((value-setting.min)/setting.step))throw new Error(`${setting.min}–${setting.max} 범위의 값을 입력하세요.`);}
  else if(setting.type==='select'){if(!setting.options.some(option=>option.value===value))throw new Error('목록의 값을 선택하세요.');}
  else {if(typeof value!=='string'||value.length>50000)throw new Error('설정 문자열이 너무 깁니다.');if(setting.type==='color'&&!/^#[a-f0-9]{6}$/i.test(value))throw new Error('#RRGGBB 색상을 입력하세요.');}
  return value;
 }
 const api={schema,validate};root.CustomStyleSettingsSchema=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
