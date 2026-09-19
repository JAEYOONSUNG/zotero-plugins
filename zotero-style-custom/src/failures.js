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
    const local = reset.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    return {minutes, local, hours: Math.floor(minutes / 60), rest: minutes % 60};
  }

  function describe(error, {now = new Date(), context = ''} = {}) {
    if (!error) return '';
    const raw = text(error.message || error);
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
