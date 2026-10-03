/* Turning a transport failure into a sentence a person can act on.

   The panel used to print the exception verbatim, so a spent daily quota
   appeared as a 300-character OpenAlex URL ending in "failed with status code
   429". That tells the reader nothing they can do, buries the one useful word
   in a query string, and looks broken rather than rate-limited. Every message
   here says what happened, and what to do about it, in that order. */
(function (root) {
  'use strict';

  const text = value => String(value == null ? '' : value).trim();

  const HOSTS = [
    [/api\.openalex\.org/i, 'OpenAlex'],
    [/api\.crossref\.org/i, 'Crossref'],
    [/ebi\.ac\.uk|europepmc/i, 'Europe PMC'],
    [/eutils\.ncbi|ncbi\.nlm\.nih\.gov/i, 'PubMed'],
    [/api\.semanticscholar\.org/i, 'Semantic Scholar'],
    [/export\.arxiv\.org|arxiv\.org/i, 'arXiv'],
    [/easyscholar\.cc/i, 'easyScholar'],
    [/api\.osf\.io/i, 'OSF Preprints'],
    [/doi\.org/i, 'DOI 확인']
  ];

  function service(value) {
    const haystack = text(value);
    for (const [pattern, name] of HOSTS) if (pattern.test(haystack)) return name;
    return '';
  }

  function status(error) {
    const direct = Number(error && (error.status ?? error.xmlhttp?.status));
    if (Number.isFinite(direct) && direct > 0) return direct;
    const found = /status code (\d{3})/i.exec(text(error && error.message));
    return found ? Number(found[1]) : 0;
  }

  // Midnight UTC, said in the reader's own clock, because "UTC 자정" is a
  // conversion they should not have to do while deciding whether to wait.
  function untilReset(now = new Date()) {
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const minutes = Math.max(1, Math.round((reset - now) / 60000));
    // The reader's own clock: a Korean format shown to an English reader is one
    // more conversion, which is the thing this line exists to save them.
    const local = reset.toLocaleTimeString((root.CustomStyleI18N&&root.CustomStyleI18N.locale&&root.CustomStyleI18N.locale())||undefined, {hour: '2-digit', minute: '2-digit'});
    return {minutes, local, hours: Math.floor(minutes / 60), rest: minutes % 60};
  }

  /* The library and reader tools guard their inputs in English, for the log;
     the reader sees the same refusal as a sentence in their own language. */
  const OWN = {
    "A regular parent item is required": "논문 항목 아래에 있는 주석이어야 합니다.",
    "Annotation attachment belongs to another library": "이 주석의 PDF는 다른 라이브러리에 있습니다.",
    "Annotation attachment is unavailable in this library": "이 라이브러리에서 주석의 PDF를 찾을 수 없습니다.",
    "Annotation parent is unavailable in this library": "이 라이브러리에서 주석이 달린 논문을 찾을 수 없습니다.",
    "Annotation parent is unavailable": "주석이 달린 논문을 찾을 수 없습니다.",
    "Annotations must belong to the same PDF": "같은 PDF의 주석만 병합할 수 있습니다.",
    "Annotations must share a regular parent item": "같은 논문의 주석만 함께 노트로 만들 수 있습니다.",
    "Annotations must share the same PDF and library": "같은 PDF의 주석만 병합할 수 있습니다.",
    "Collection is unavailable": "컬렉션을 찾을 수 없습니다. 삭제되었을 수 있습니다.",
    "Collection does not belong to the chosen library": "이 컬렉션은 선택한 라이브러리에 없습니다.",
    "Enter a valid tag name": "태그 이름을 입력하세요.",
    "External annotations cannot be merged": "PDF 파일에 원래 들어 있던 주석은 병합할 수 없습니다.",
    "Item has unsaved changes; save it before editing": "이 문헌의 다른 변경 사항이 아직 저장 중입니다. 잠시 뒤 다시 시도하세요.",
    "Item is read-only": "읽기 전용 문헌이라 바꿀 수 없습니다.",
    "Item is unavailable": "문헌을 찾을 수 없습니다. 삭제되었을 수 있습니다.",
    "Library is unavailable": "라이브러리를 찾을 수 없습니다.",
    "Merge requires the same annotation color": "색이 같은 주석만 병합할 수 있습니다.",
    "Merge requires the same highlight or underline type": "같은 종류(하이라이트끼리, 밑줄끼리)만 병합할 수 있습니다.",
    "Merge supports one page or two adjacent pages": "한 쪽 또는 이어진 두 쪽의 주석만 병합할 수 있습니다.",
    "Merged annotation text is too long": "합친 글이 너무 길어 병합할 수 없습니다.",
    "Too many annotation rectangles to merge": "주석 영역이 너무 많아 병합할 수 없습니다.",
    "Unsupported annotation rectangle geometry": "이 주석의 모양은 병합할 수 없습니다.",
    "Unsupported annotation geometry": "이 주석의 모양은 병합할 수 없습니다.",
    "Invalid annotation geometry": "이 주석의 모양은 병합할 수 없습니다.",
    "No Zotero window is available": "Zotero 창이 열려 있지 않습니다.",
    "Reading status and rating tags cannot be renamed": "읽기 상태·별점 태그는 이름을 바꿀 수 없습니다.",
    "Renamed tag is too long": "새 태그 이름이 너무 깁니다.",
    "Select 2 to 50 annotations": "주석을 2개에서 50개까지 선택하세요.",
    "Select 2\u201350 distinct annotations": "주석을 2개에서 50개까지 선택하세요.",
    "Select annotations explicitly": "주석을 먼저 선택하세요.",
    "Select annotations in the same library": "같은 라이브러리의 주석만 선택하세요.",
    "Select annotations to extract": "노트로 만들 주석을 선택하세요.",
    "Select at least two annotations": "병합할 주석을 두 개 이상 선택하세요.",
    "Select at least two items": "문헌을 두 개 이상 선택하세요.",
    "Select at most 100 items to relate": "한 번에 100개까지 연결할 수 있습니다.",
    "Select at most 100 items to unlink": "한 번에 100개까지 연결을 해제할 수 있습니다.",
    "Select items explicitly": "문헌을 먼저 선택하세요.",
    "Select items in the same library": "같은 라이브러리의 문헌만 선택하세요.",
    "Select regular items in the same library": "같은 라이브러리의 논문만 선택하세요.",
    "Tag branches cannot contain empty path segments": "태그 경로에 빈 단계가 있습니다. '/' 사이에 이름을 넣으세요.",
    "Tags must be nonempty strings": "빈 태그는 추가할 수 없습니다.",
    "The active reader or selection changed": "그 사이 열린 PDF나 선택이 바뀌었습니다. 다시 선택한 뒤 실행하세요.",
    "Use a six-digit annotation color": "색은 #RRGGBB 형식으로 고르세요.",
    "A group name is required": "탭 그룹 이름을 입력하세요.",
    "A palette needs 1\u201316 colors": "팔레트에는 색이 1개에서 16개까지 필요합니다.",
    "Annotation palette not found": "주석 팔레트를 찾을 수 없습니다.",
    "At most 50 annotation palettes can be saved": "주석 팔레트는 50개까지 저장할 수 있습니다.",
    "Background and text colors must differ": "배경색과 글자색이 달라야 합니다.",
    "Text and background need a contrast of at least 4.5:1": "글자와 배경의 대비가 4.5:1 이상이어야 읽을 수 있습니다. 더 어둡거나 밝은 색을 고르세요.",
    "Choose a saved palette": "저장한 팔레트를 고르세요.",
    "Each line needs #RRGGBB and a label": "한 줄에 '#RRGGBB, 이름' 형식으로 적으세요.",
    "Margin width must be 160\u2013480, text limit 100\u20135000, and side left or right": "여백 너비는 160–480, 글자 수는 100–5000 사이여야 합니다.",
    "Only document tabs can be moved": "문서 탭만 옮길 수 있습니다.",
    "Open a library item table first": "라이브러리 목록을 먼저 여세요.",
    "Open at least one document tab to save a group": "탭 그룹을 저장하려면 PDF 탭을 하나 이상 여세요.",
    "Palette colors must be unique six-digit colors with short labels": "팔레트 색은 서로 다른 #RRGGBB 색과 짧은 이름이어야 합니다.",
    "PDF attachment is unavailable": "PDF 첨부를 찾을 수 없습니다.",
    "Select an open document reader first": "PDF를 먼저 여세요.",
    "Selected annotation belongs to another PDF": "선택한 주석이 다른 PDF의 것입니다.",
    "Tab group not found": "탭 그룹을 찾을 수 없습니다.",
    "Tab no longer exists": "그 탭은 이미 닫혔습니다.",
    "The active reader changed or closed": "그 사이 열린 PDF가 바뀌었거나 닫혔습니다.",
    "The active reader changed": "그 사이 열린 PDF가 바뀌었습니다.",
    "The library tab cannot be closed": "라이브러리 탭은 닫을 수 없습니다.",
    "The tab group window was closed": "탭 그룹이 있던 창이 닫혔습니다.",
    "This document is read-only": "읽기 전용 문서입니다.",
    "View group not found": "뷰 그룹을 찾을 수 없습니다.",
    "Choose light, dark, sepia, or a palette with six-digit background and foreground colors": "밝게·어둡게·세피아 중 하나를 고르거나 #RRGGBB 배경·글자색을 넣으세요.",
    "Choose an available PDF attached to this same paper": "같은 논문에 붙은 PDF를 고르세요."
  };

  function describe(error, {now = new Date(), context = ''} = {}) {
    if (!error) return '';
    const raw = text(error.message || error);
    if (Object.prototype.hasOwnProperty.call(OWN, raw)) return OWN[raw];
    const where = service(raw) || service(error && error.url) || service(context);
    const code = status(error);

    if (code === 429 || /insufficient budget|rate limit/i.test(raw)) {
      const {hours, rest, local} = untilReset(now);
      const left = hours ? `${hours}시간 ${rest}분` : `${rest}분`;
      return `${where || '조회처'}의 하루 사용량을 다 썼습니다. ${left} 뒤(${local})에 초기화되고, `
        + `그때 다시 실행하면 남은 것부터 이어서 채웁니다. 지금까지 받은 값은 이미 저장했습니다.`;
    }
    if (code === 401 || code === 403) {
      return `${where || '조회처'}가 요청을 거절했습니다(${code}). API 키가 필요하거나 만료됐는지 설정에서 확인하세요.`;
    }
    if (code === 404) {
      return `${where || '조회처'}에 해당 기록이 없습니다. 논문 자체의 문제가 아니라 그 서비스가 모르는 것입니다.`;
    }
    if (code >= 500) {
      return `${where || '조회처'} 서버에 일시적인 문제가 있습니다(${code}). 잠시 뒤 다시 시도하세요.`;
    }
    if (/abort/i.test(raw) && !/timeout/i.test(raw)) return '중지했습니다.';
    if (/timeout|timed out/i.test(raw)) {
      return `${where || '조회처'} 응답이 너무 늦어 중단했습니다. 네트워크를 확인하고 다시 시도하세요.`;
    }
    if (/NetworkError|offline|ENOTFOUND|dns/i.test(raw)) {
      return '네트워크에 연결할 수 없습니다.';
    }
    // A message written for this plugin's user is already the right sentence;
    // only a URL-shaped transport error needs replacing.
    if (/^https?:\/\//i.test(raw) || /^HTTP (GET|POST)/i.test(raw)) {
      return `${where || '조회'} 요청이 실패했습니다${code ? ` (${code})` : ''}.`;
    }
    return raw;
  }

  const api = {describe, service, status, untilReset};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleFailures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
