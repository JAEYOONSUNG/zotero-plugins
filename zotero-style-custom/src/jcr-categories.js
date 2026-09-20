/* Official JCR groups, categories and observed journal memberships.
 * Names are the captured display names, not invented Clarivate identifiers.
 * Counts remain captured values; no ranks, quartiles or taxonomy are inferred.
 */
(function(root) {
  'use strict';

  function invalid(path, message) { throw new Error('Invalid JCR catalog at ' + path + ': ' + message); }
  function object(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object');
    return value;
  }
  function label(value, path) {
    if (typeof value !== 'string' || !value.trim()) invalid(path, 'expected a nonempty exact name or key');
    return value;
  }
  function copy(value, path = 'payload', seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') invalid(path, 'expected JSON data');
    if (seen.has(value)) invalid(path, 'cyclic data');
    seen.add(value);
    const result = Array.isArray(value) ? value.map((entry, index) => copy(entry, path + '[' + index + ']', seen))
      : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry, path + '.' + key, seen)]));
    seen.delete(value);
    return result;
  }
  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const entry of Object.values(value)) freeze(entry);
      Object.freeze(value);
    }
    return value;
  }
  function number(value, path, integer = false) {
    if (value == null || typeof value === 'string' && /^(?:\s*|\s*[—–-]\s*|\s*N\/?A\s*)$/i.test(value)) return null;
    let normalized = value;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) invalid(path, 'expected an exact nonnegative number or null');
      normalized = Number(text.replace(/,/g, ''));
    }
    if (typeof normalized !== 'number' || !Number.isFinite(normalized) || normalized < 0
      || integer && !Number.isSafeInteger(normalized)) invalid(path, 'expected a nonnegative ' + (integer ? 'safe integer' : 'number') + ' or null');
    return normalized;
  }
  function year(value, path) {
    const result = number(value, path, true);
    if (result !== null && (result < 1900 || result > 2100)) invalid(path, 'expected a metric or release year');
    return result;
  }
  const boundedMetric = /^[<>≤≥]\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  function metric(row, key, path) {
    const displayKey = key + 'Display', raw = row[key];
    if (row[displayKey] != null && typeof row[displayKey] !== 'string') invalid(path + '.' + displayKey, 'expected captured display text');
    if (typeof raw === 'string' && boundedMetric.test(raw.trim())) {
      if (row[displayKey] != null && row[displayKey] !== raw) invalid(path + '.' + displayKey, 'conflicting bounded metric display');
      row[displayKey] = raw;
      row[key] = null;
    } else row[key] = number(raw, path + '.' + key);
    if (typeof row[displayKey] === 'string' && boundedMetric.test(row[displayKey].trim()) && row[key] !== null) {
      invalid(path + '.' + key, 'a bounded display is not an exact numeric value');
    }
  }
  function strings(value, path) {
    if (!Array.isArray(value)) invalid(path, 'expected an array');
    const result = value.map((item, index) => label(item, path + '[' + index + ']'));
    if (new Set(result).size !== result.length) invalid(path, 'duplicate entries');
    return result;
  }
  function missingDisplay(value) { return /^(?:\s*|\s*[—–-]\s*|\s*N\/?A\s*)$/i.test(value); }
  function categoryMetric(value, path, journal, categoryIndex) {
    const row = object(value, path);
    row.categoryKey = label(row.categoryKey, path + '.categoryKey');
    if (!journal.categoryKeys.includes(row.categoryKey)) invalid(path + '.categoryKey', 'metric category does not belong to this journal');
    row.editions = strings(row.editions, path + '.editions');
    const category = categoryIndex.get(row.categoryKey);
    if (!category) invalid(path + '.categoryKey', 'unknown category');
    for (const edition of row.editions) {
      if (/^(?:Both|Multiple)$/i.test(edition) || category.editions.length && !category.editions.includes(edition)) {
        invalid(path + '.editions', 'edition is not an observed edition of this category');
      }
    }
    row.rank = number(row.rank, path + '.rank', true);
    row.rankTotal = number(row.rankTotal, path + '.rankTotal', true);
    row.quartile = number(row.quartile, path + '.quartile', true);
    row.percentile = number(row.percentile, path + '.percentile');
    if (row.rank !== null && row.rank < 1 || row.rankTotal !== null && row.rankTotal < 1
      || row.rank !== null && row.rankTotal !== null && row.rank > row.rankTotal) invalid(path + '.rank', 'rank must be positive and within its observed total');
    if (row.quartile !== null && (row.quartile < 1 || row.quartile > 4)) invalid(path + '.quartile', 'quartile must be 1 through 4 or null');
    if (row.percentile !== null && row.percentile > 100) invalid(path + '.percentile', 'percentile must be 0 through 100 or null');
    for (const key of ['rankDisplay', 'quartileDisplay', 'percentileDisplay']) {
      if (row[key] == null) { row[key] = null; continue; }
      if (typeof row[key] !== 'string') invalid(path + '.' + key, 'expected exact captured text or null');
      if (/\b(?:Both|Multiple)\b/i.test(row[key])) invalid(path + '.' + key, 'summary placeholders are not category-specific metrics');
    }
    if (row.rankDisplay !== null) {
      const display = row.rankDisplay.trim();
      if (missingDisplay(display)) {
        if (row.rank !== null || row.rankTotal !== null) invalid(path + '.rankDisplay', 'unavailable display contradicts a numeric rank');
      } else {
        const parts = display.split('/');
        if (parts.length > 2) invalid(path + '.rankDisplay', 'invalid rank display');
        const rank = number(parts[0].trim(), path + '.rankDisplay', true);
        const total = parts.length === 2 ? number(parts[1].trim(), path + '.rankDisplay', true) : null;
        if (rank === null || rank < 1 || parts.length === 2 && (total === null || total < rank)) invalid(path + '.rankDisplay', 'invalid rank bounds');
        if (row.rank !== null && rank !== row.rank || row.rankTotal !== null && total !== null && total !== row.rankTotal) invalid(path + '.rankDisplay', 'display contradicts the observed numeric rank');
      }
    }
    if (row.quartileDisplay !== null) {
      const display = row.quartileDisplay.trim();
      if (missingDisplay(display)) {
        if (row.quartile !== null) invalid(path + '.quartileDisplay', 'unavailable display contradicts a numeric quartile');
      } else {
        const match = /^Q?\s*([1-4])$/i.exec(display);
        if (!match || row.quartile !== null && Number(match[1]) !== row.quartile) invalid(path + '.quartileDisplay', 'invalid or conflicting quartile display');
      }
    }
    if (row.percentileDisplay !== null) {
      const display = row.percentileDisplay.trim();
      if (missingDisplay(display)) {
        if (row.percentile !== null) invalid(path + '.percentileDisplay', 'unavailable display contradicts a numeric percentile');
      } else {
        const percentile = number(display.replace(/%$/, '').trim(), path + '.percentileDisplay');
        if (percentile === null || percentile > 100 || row.percentile !== null && percentile !== row.percentile) invalid(path + '.percentileDisplay', 'invalid or conflicting percentile display');
      }
    }
    return row;
  }
  function sourceOf(value) {
    const source = copy(object(value, 'source'));
    if (source.provider !== 'Clarivate' || source.product !== 'JCR') invalid('source', 'requires Clarivate JCR provenance');
    let url;
    try { url = new URL(source.url); } catch (_) { invalid('source.url', 'expected an official HTTPS JCR URL'); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jcr.clarivate.com' || url.username || url.password || url.port) {
      invalid('source.url', 'expected an official HTTPS JCR URL');
    }
    if (typeof source.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(source.capturedAt)
      || !Number.isFinite(Date.parse(source.capturedAt))) invalid('source.capturedAt', 'expected a capture timestamp with timezone');
    if (source.datasetUpdated != null && (typeof source.datasetUpdated !== 'string' || !source.datasetUpdated.trim())) {
      invalid('source.datasetUpdated', 'expected the captured date text or null');
    }
    source.datasetUpdated = source.datasetUpdated ?? null;
    source.releaseYear = year(source.releaseYear, 'source.releaseYear');
    source.metricYear = year(source.metricYear, 'source.metricYear');
    object(source.complete, 'source.complete');
    for (const section of ['groups', 'categories', 'journals']) {
      if (typeof source.complete[section] !== 'boolean') invalid('source.complete.' + section, 'expected an explicit coverage boolean');
    }
    return source;
  }

  function create(payload) {
    object(payload, 'payload');
    if (payload.schemaVersion !== 1) invalid('schemaVersion', 'unsupported schema');
    const source = sourceOf(payload.source), groupIndex = new Map(), categoryIndex = new Map(), journalIndex = new Map();
    function records(section, index, normalize) {
      if (!Array.isArray(payload[section])) invalid(section, 'expected an array');
      return payload[section].map((input, position) => {
        const path = section + '[' + position + ']', row = copy(object(input, path), path);
        row.key = label(row.key, path + '.key');
        if (index.has(row.key)) invalid(path + '.key', 'duplicate key');
        normalize(row, path);
        index.set(row.key, row);
        return row;
      });
    }
    const groups = records('groups', groupIndex, (row, path) => {
      row.name = label(row.name, path + '.name');
      if (row.key !== row.name) invalid(path + '.key', 'group keys must equal the exact captured name');
      row.categoryKeys = strings(row.categoryKeys, path + '.categoryKeys');
      for (const field of ['categoryCount', 'journalCount', 'citableItems']) row[field] = number(row[field], path + '.' + field, true);
    });
    const categories = records('categories', categoryIndex, (row, path) => {
      row.name = label(row.name, path + '.name');
      if (row.key !== row.name) invalid(path + '.key', 'category keys must equal the exact captured name');
      row.groupKeys = strings(row.groupKeys, path + '.groupKeys');
      row.editions = strings(row.editions, path + '.editions');
      for (const field of ['journalCount', 'citableItems', 'totalCitations']) row[field] = number(row[field], path + '.' + field, true);
      metric(row, 'medianJIF', path);
    });
    const journals = records('journals', journalIndex, (row, path) => {
      row.title = label(row.title, path + '.title');
      if (row.abbreviation != null && typeof row.abbreviation !== 'string') invalid(path + '.abbreviation', 'expected text or null');
      row.abbreviation = row.abbreviation ?? null;
      row.issns = strings(row.issns, path + '.issns');
      for (const issn of row.issns) if (!/^\d{4}-?\d{3}[\dXx]$/.test(issn)) invalid(path + '.issns', 'invalid ISSN syntax');
      row.categoryKeys = strings(row.categoryKeys, path + '.categoryKeys');
      metric(row, 'jif', path);
      row.year = year(row.year, path + '.year');
      if (Object.hasOwn(row, 'categoryMetrics')) {
        if (!Array.isArray(row.categoryMetrics)) invalid(path + '.categoryMetrics', 'expected an array when present');
        const contexts = new Map();
        row.categoryMetrics = row.categoryMetrics.map((entry, index) => {
          const location = path + '.categoryMetrics[' + index + ']';
          const normalized = categoryMetric(entry, location, row, categoryIndex);
          const previous = contexts.get(normalized.categoryKey) || [];
          if (previous.some(other => !other.editions.length || !normalized.editions.length
            || normalized.editions.some(edition => other.editions.includes(edition)))) {
            invalid(location, 'duplicate or overlapping category/edition metric context');
          }
          previous.push(normalized); contexts.set(normalized.categoryKey, previous);
          return normalized;
        });
      }
      const hasMetrics = row.jif !== null || (row.categoryMetrics || []).some(entry => [entry.rank, entry.quartile, entry.percentile].some(value => value !== null));
      if (hasMetrics && row.year !== null && source.metricYear !== null && row.year !== source.metricYear) invalid(path + '.year', 'metric year differs from the captured JCR dataset');
    });
    const byGroup = new Map(groups.map(group => [group.key, []]));
    const byCategory = new Map(categories.map(category => [category.key, []]));
    for (const group of groups) {
      for (const key of group.categoryKeys) {
        const category = categoryIndex.get(key);
        if (!category) invalid('groups.' + group.key + '.categoryKeys', 'unknown category: ' + key);
        if (!category.groupKeys.includes(group.key)) invalid('groups.' + group.key, 'category membership is not reciprocal: ' + key);
        byGroup.get(group.key).push(category);
      }
      if (group.categoryCount !== null && (group.categoryKeys.length > group.categoryCount
        || source.complete.categories && group.categoryKeys.length !== group.categoryCount)) {
        invalid('groups.' + group.key + '.categoryCount', 'captured category coverage disagrees with the official count');
      }
    }
    for (const category of categories) {
      for (const key of category.groupKeys) {
        const group = groupIndex.get(key);
        if (!group) invalid('categories.' + category.key + '.groupKeys', 'unknown group: ' + key);
        if (!group.categoryKeys.includes(category.key)) invalid('categories.' + category.key, 'group membership is not reciprocal: ' + key);
      }
    }
    for (const journal of journals) {
      for (const key of journal.categoryKeys) {
        if (!categoryIndex.has(key)) invalid('journals.' + journal.key + '.categoryKeys', 'unknown category: ' + key);
        byCategory.get(key).push(journal);
      }
    }
    for (const category of categories) {
      const count = byCategory.get(category.key).length;
      if (category.journalCount !== null && (count > category.journalCount || source.complete.journals && count !== category.journalCount)) {
        invalid('categories.' + category.key + '.journalCount', 'captured journal coverage disagrees with the official count');
      }
    }
    // Multi-category journals cannot be counted by summing category totals.
    // Keep the official group counts untouched and check only observed excess.
    for (const group of groups) {
      const observed = new Set(byGroup.get(group.key).flatMap(category => byCategory.get(category.key))).size;
      if (group.journalCount !== null && observed > group.journalCount) invalid('groups.' + group.key + '.journalCount', 'observed journals exceed the official count');
    }
    const empty = Object.freeze([]);
    const coverage = new Map(categories.map(category => {
      const observed = byCategory.get(category.key);
      const contexts = journal => (journal.categoryMetrics || []).filter(entry => entry.categoryKey === category.key);
      const countMatches = category.journalCount !== null && observed.length === category.journalCount;
      return [category.key, Object.freeze({categoryKey: category.key, officialJournalCount: category.journalCount,
        observedJournalCount: observed.length, metricJournalCount: observed.filter(journal => contexts(journal).length).length,
        rankedJournalCount: observed.filter(journal => contexts(journal).some(entry => entry.rank !== null)).length,
        quartileJournalCount: observed.filter(journal => contexts(journal).some(entry => entry.quartile !== null)).length,
        percentileJournalCount: observed.filter(journal => contexts(journal).some(entry => entry.percentile !== null)).length,
        countMatches, membershipComplete: source.complete.journals && countMatches})];
    }));
    freeze(source); freeze(groups); freeze(categories); freeze(journals);
    for (const values of byGroup.values()) freeze(values);
    for (const values of byCategory.values()) freeze(values);
    return Object.freeze({source, groups, categories, journals,
      group: key => groupIndex.get(key) || null,
      category: key => categoryIndex.get(key) || null,
      categoriesForGroup: key => byGroup.get(key) || empty,
      journalsForCategory: key => byCategory.get(key) || empty,
      categoryCoverage: key => coverage.get(key) || null});
  }

  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleJCRCategories = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
