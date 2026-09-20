"""Normalize previously captured, rendered JCR journal tables. No network access.

The page's legacy DOM column key ``jif2019`` labels the JIF for the explicitly
captured source.metricYear (2025 in the supplied capture), not the year 2019.
Expandable category detail arrays are authoritative for category metrics;
collapsed Multiple/Both summaries are never broadcast across categories.
"""
import argparse
import copy
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import unicodedata
import urllib.parse

MISSING = {'', '-', '—', '–', 'N/A', 'NA'}
SAFE_INTEGER = 9007199254740991


def fail(location, message):
    raise ValueError(f'{location}: {message}')


def timestamp(value, location):
    if not isinstance(value, str):
        fail(location, 'capture timestamp must be text')
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.utcoffset() is None:
            raise ValueError('missing timezone')
        return parsed
    except ValueError as error:
        fail(location, 'invalid capture timestamp with timezone')


def integer(value, location, minimum=0):
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= SAFE_INTEGER:
        fail(location, f'expected an integer from {minimum} through {SAFE_INTEGER}')
    return value


def text(value, location):
    if not isinstance(value, str):
        fail(location, 'expected rendered text')
    return value.strip()


def missing(value):
    return value.strip().upper() in MISSING


def numeric(value, location, count=False, bounded=False, percentage=False):
    value = text(value, location)
    if missing(value):
        return None
    if bounded and re.fullmatch(r'[<>≤≥]\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?', value):
        bound = float(re.sub(r'^[<>≤≥]\s*', '', value).replace(',', ''))
        if not math.isfinite(bound) or percentage and bound > 100:
            fail(location, 'invalid bounded percentage or metric')
        return None
    if percentage:
        value = value.removesuffix('%').strip()
    if not re.fullmatch(r'(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?', value):
        fail(location, 'not an exact nonnegative numeric display')
    if count:
        digits = value.replace(',', '')
        if not digits.isdigit() or int(digits) > SAFE_INTEGER:
            fail(location, 'count must be an exact safe integer')
        return int(digits)
    number = float(value.replace(',', ''))
    if not math.isfinite(number) or percentage and number > 100:
        fail(location, 'metric is outside its valid range')
    return number


def cell(row, key, location):
    value = row.get(key)
    if not isinstance(value, dict) or not isinstance(value.get('details'), list):
        fail(f'{location}.{key}', 'missing rendered cell or detail array')
    rendered = text(value.get('text'), f'{location}.{key}.text')
    details = [text(item, f'{location}.{key}.details[{index}]') for index, item in enumerate(value['details'])]
    return rendered, details


def single(row, key, location):
    rendered, details = cell(row, key, location)
    if details:
        if len(details) != 1 or rendered and details[0] != rendered:
            fail(f'{location}.{key}', 'ambiguous scalar cell details')
        return details[0]
    return rendered


def context_values(row, key, count, location):
    rendered, details = cell(row, key, location)
    if details:
        if len(details) != count:
            fail(f'{location}.{key}', 'category detail arrays are not aligned')
        values = details
    elif count == 1:
        values = [rendered]
    else:
        fail(f'{location}.{key}', 'multi-category metrics require aligned details, never collapsed summaries')
    if any(re.search(r'\b(?:Multiple|Both)\b', value, re.I) for value in values):
        fail(f'{location}.{key}', 'summary placeholders are not category-specific data')
    return values


def issn(value, location):
    if missing(value):
        return None
    bare = re.sub(r'[-\s]', '', value).upper()
    if not re.fullmatch(r'\d{7}[\dX]', bare):
        fail(location, 'invalid observed ISSN')
    return bare[:4] + '-' + bare[4:]


def rank(value, location):
    if missing(value):
        return None, None
    parts = value.split('/')
    if len(parts) != 2:
        fail(location, 'expected the observed rank/total display')
    place = numeric(parts[0], location, count=True)
    total = numeric(parts[1], location, count=True)
    if place is None or total is None or place < 1 or total < place:
        fail(location, 'rank must be positive and within its observed total')
    return place, total


def quartile(value, location):
    if missing(value):
        return None
    match = re.fullmatch(r'Q([1-4])', value, re.I)
    if not match:
        fail(location, 'expected an observed Q1–Q4 or unavailable display')
    return int(match.group(1))


def journal_key(title, issns):
    # Retain punctuation: "and" and "&" are not interchangeable identities.
    normalized_title = ' '.join(unicodedata.normalize('NFKC', title).casefold().split())
    identity = json.dumps([sorted(issns), normalized_title], ensure_ascii=False, separators=(',', ':'))
    return 'journal:' + hashlib.sha256(identity.encode('utf-8')).hexdigest()


def normalize_journal(row, categories, metric_year, location):
    if not isinstance(row, dict):
        fail(location, 'journal row must be an object')
    title = single(row, 'journalName', location)
    if missing(title):
        fail(location, 'journal title is unavailable')
    codes = list(dict.fromkeys(code for key in ('issn', 'eissn')
                              if (code := issn(single(row, key, location), f'{location}.{key}'))))
    category_text, details = cell(row, 'category', location)
    names = details or [category_text]
    if any(name not in categories for name in names):
        fail(location, 'unknown or unexpanded category name: ' + repr(names))
    values = {key: context_values(row, key, len(names), location)
              for key in ('edition', 'quartile', 'jifRank', 'jifPercentile')}
    metrics, by_context = [], {}
    for index, name in enumerate(names):
        edition_text = values['edition'][index]
        editions = [] if missing(edition_text) else list(dict.fromkeys(part.strip() for part in edition_text.split(',')))
        if any(not edition or edition not in categories[name]['editions'] for edition in editions):
            fail(location, 'unknown category edition context')
        rank_display, q_display, percentile_display = (values[key][index] for key in ('jifRank', 'quartile', 'jifPercentile'))
        place, total = rank(rank_display, location + '.jifRank')
        metric = {'categoryKey': name, 'editions': editions, 'rank': place, 'rankTotal': total,
                  'quartile': quartile(q_display, location + '.quartile'),
                  'percentile': numeric(percentile_display, location + '.jifPercentile', percentage=True),
                  'rankDisplay': rank_display, 'quartileDisplay': q_display, 'percentileDisplay': percentile_display}
        key = (name, tuple(sorted(editions)))
        if key in by_context:
            if {**by_context[key], 'editions': sorted(by_context[key]['editions'])} != {**metric, 'editions': sorted(editions)}:
                fail(location, 'conflicting duplicate category metric context')
            continue
        for previous in metrics:
            if previous['categoryKey'] == name and (not previous['editions'] or not editions or set(previous['editions']) & set(editions)):
                fail(location, 'ambiguous overlapping category edition contexts')
        by_context[key] = metric
        metrics.append(metric)
    jif_display = single(row, 'jif2019', location)
    jci_display = single(row, 'jci', location)
    oa_display = single(row, 'percentageOAGold', location)
    return {'key': journal_key(title, codes), 'title': title, 'abbreviation': '', 'issns': codes,
            'keyKind': 'local-issn-and-exact-title', 'categoryKeys': list(dict.fromkeys(names)),
            'editions': list(dict.fromkeys(edition for metric in metrics for edition in metric['editions'])),
            'jif': numeric(jif_display, location + '.jif2019', bounded=True), 'jifDisplay': jif_display, 'year': metric_year,
            'totalCitations': numeric(single(row, 'totalCites', location), location + '.totalCites', count=True),
            'jci': numeric(jci_display, location + '.jci', bounded=True), 'jciDisplay': jci_display,
            'openAccessPercent': numeric(oa_display, location + '.percentageOAGold', bounded=True, percentage=True),
            'openAccessPercentDisplay': oa_display, 'categoryMetrics': metrics}


def validate_taxonomy(payload):
    if not isinstance(payload, dict) or payload.get('schemaVersion') != 1:
        fail('taxonomy', 'unsupported schema')
    source = payload.get('source', {})
    if source.get('provider') != 'Clarivate' or source.get('product') != 'JCR':
        fail('taxonomy.source', 'expected independently captured Clarivate JCR provenance')
    parsed = urllib.parse.urlsplit(source.get('url', ''))
    if parsed.scheme != 'https' or parsed.hostname != 'jcr.clarivate.com' or parsed.username or parsed.password or parsed.port:
        fail('taxonomy.source.url', 'expected an official JCR URL')
    timestamp(source.get('capturedAt'), 'taxonomy.source.capturedAt')
    year = integer(source.get('metricYear'), 'taxonomy.source.metricYear', 1900)
    if year > 2100 or source.get('complete', {}).get('groups') is not True or source.get('complete', {}).get('categories') is not True:
        fail('taxonomy.source', 'complete group/category coverage and an explicit metric year are required')
    indexes = {}
    for section in ('groups', 'categories'):
        rows = payload.get(section)
        if not isinstance(rows, list):
            fail('taxonomy.' + section, 'expected an array')
        index = {}
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('key'), str) or not row['key'] or row.get('name') != row['key'] or row['key'] in index:
                fail('taxonomy.' + section, 'invalid or duplicate exact name key')
            refs = row.get('categoryKeys' if section == 'groups' else 'groupKeys')
            if not isinstance(refs, list) or any(not isinstance(value, str) for value in refs) or len(refs) != len(set(refs)):
                fail('taxonomy.' + section, 'invalid membership references')
            if section == 'categories':
                integer(row.get('journalCount'), 'taxonomy.category.journalCount')
                if not isinstance(row.get('editions'), list) or any(not isinstance(value, str) or not value for value in row['editions']):
                    fail('taxonomy.category.editions', 'invalid editions')
            elif integer(row.get('categoryCount'), 'taxonomy.group.categoryCount') != len(refs):
                fail('taxonomy.group.categoryCount', 'category count disagrees with captured memberships')
            index[row['key']] = row
        indexes[section] = index
    for key, group in indexes['groups'].items():
        for category_key in group['categoryKeys']:
            category = indexes['categories'].get(category_key)
            if not category or key not in category['groupKeys']:
                fail('taxonomy', 'nonreciprocal group/category membership')
    for key, category in indexes['categories'].items():
        for group_key in category['groupKeys']:
            group = indexes['groups'].get(group_key)
            if not group or key not in group['categoryKeys']:
                fail('taxonomy', 'nonreciprocal category/group membership')
    return indexes['categories']


def build_catalog(taxonomy, pages, allow_partial=False, page_size=200, manifest=None):
    categories = validate_taxonomy(taxonomy)
    integer(page_size, 'page_size', 1)
    if not isinstance(pages, list) or not pages:
        fail('capture', 'no completed journal pages')
    if any(not isinstance(page, dict) for page in pages):
        fail('capture', 'page must be an object')
    for page in pages:
        integer(page.get('index'), 'page.index', 1)
    ordered = sorted(pages, key=lambda page: page['index'])
    total = integer(ordered[0].get('total'), 'page.total', 1)
    expected_pages = (total + page_size - 1) // page_size
    journals, identities, times = [], set(), []
    for index, page in enumerate(ordered, 1):
        location = f'page {index}'
        if page['index'] != index or index > expected_pages:
            fail(location, 'page indices must be a unique contiguous prefix beginning at one')
        if integer(page.get('total'), location + '.total', 1) != total:
            fail(location, 'journal total drifted during capture')
        start, end = (index - 1) * page_size + 1, min(index * page_size, total)
        if integer(page.get('start'), location + '.start', 1) != start or integer(page.get('end'), location + '.end', 1) != end:
            fail(location, 'captured page interval does not match its index')
        rows = page.get('rows')
        if not isinstance(rows, list) or len(rows) != end - start + 1:
            fail(location, 'row count differs from the captured interval')
        times.append((timestamp(page.get('capturedAt'), location + '.capturedAt'), page['capturedAt']))
        for key in ('datasetUpdated', 'metricYear', 'releaseYear'):
            if key in page and page[key] != taxonomy['source'].get(key):
                fail(location, f'{key} drifted from the independent taxonomy capture')
        for offset, raw in enumerate(rows):
            journal = normalize_journal(raw, categories, taxonomy['source']['metricYear'], f'{location}, row {offset + 1}')
            if journal['key'] in identities:
                fail(location, 'duplicate journal identity across captured rows')
            identities.add(journal['key'])
            journal['capture'] = {'page': index, 'row': offset + 1, 'ordinal': start + offset, 'capturedAt': page['capturedAt']}
            journals.append(journal)
    complete_pages = len(ordered) == expected_pages and len(journals) == total
    if not complete_pages and not allow_partial:
        fail('capture', f'incomplete: expected {expected_pages} pages and {total} journals; got {len(ordered)} pages and {len(journals)} journals')
    counts = dict.fromkeys(categories, 0)
    for journal in journals:
        for key in journal['categoryKeys']:
            counts[key] += 1
    mismatches = []
    for key, category in categories.items():
        expected = category['journalCount']
        if counts[key] > expected:
            fail('capture', f'category membership exceeds official count: {key} ({counts[key]} > {expected})')
        if counts[key] != expected:
            mismatches.append({'categoryKey': key, 'expected': expected, 'observed': counts[key]})
    if complete_pages and mismatches:
        fail('capture', 'full journal capture disagrees with independent category counts: ' + json.dumps(mismatches[:5]))
    complete = complete_pages and not mismatches
    result = copy.deepcopy(taxonomy)
    result['journals'] = journals
    source = result['source']
    source.setdefault('taxonomyCapturedAt', source['capturedAt'])
    source['capturedAt'] = max(times)[1]
    source['complete']['journals'] = complete
    source['journalCapture'] = {'url': 'https://jcr.clarivate.com/jcr/browse-journals',
        'captureMethod': 'rendered-table-cells-and-category-details', 'totalReported': total,
        'capturedJournals': len(journals), 'capturedPages': len(ordered), 'expectedPages': expected_pages,
        'pageSize': page_size, 'firstCapturedAt': min(times)[1], 'lastCapturedAt': max(times)[1],
        'complete': complete, 'partial': not complete, 'categoryMembershipCountsVerified': complete,
        'categoriesChecked': len(categories), 'categoryMetricsAligned': True,
        'metricColumn': {'domKey': 'jif2019', 'renderedMetricYear': source['metricYear']},
        'files': copy.deepcopy(manifest or [])}
    for category in result['categories']:
        category['journalCoverage'] = {'observed': counts[category['key']], 'expected': category['journalCount'],
            'countMatches': counts[category['key']] == category['journalCount'], 'complete': complete}
    return result


def read_pages(directory):
    pages, manifest = [], []
    for path in sorted(Path(directory).glob('journals-*.json')):
        match = re.fullmatch(r'journals-(\d+)\.json', path.name)
        if not match:
            continue
        raw = path.read_bytes()
        page = json.loads(raw)
        if page.get('index') != int(match.group(1)):
            fail(str(path), 'filename and captured page index disagree')
        pages.append(page)
        manifest.append({'file': path.name, 'sha256': hashlib.sha256(raw).hexdigest()})
    return pages, manifest


def atomic_json(path, value, expected):
    path = Path(path)
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if (path.read_bytes() if path.exists() else None) != expected:
        fail(str(path), 'output changed during normalization; refusing overwrite')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o644)
        if (path.read_bytes() if path.exists() else None) != expected:
            fail(str(path), 'output changed during normalization; refusing overwrite')
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            os.unlink(temporary)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--taxonomy', required=True)
    parser.add_argument('--capture-dir', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--allow-partial', action='store_true')
    parser.add_argument('--page-size', type=int, default=200)
    args = parser.parse_args(argv)
    taxonomy_path, target = Path(args.taxonomy), Path(args.out)
    taxonomy_bytes = taxonomy_path.read_bytes()
    expected = target.read_bytes() if target.exists() else None
    pages, manifest = read_pages(args.capture_dir)
    result = build_catalog(json.loads(taxonomy_bytes), pages, args.allow_partial, args.page_size, manifest)
    if taxonomy_path.read_bytes() != taxonomy_bytes:
        fail('taxonomy', 'baseline changed during normalization')
    for entry in manifest:
        if hashlib.sha256((Path(args.capture_dir) / entry['file']).read_bytes()).hexdigest() != entry['sha256']:
            fail(entry['file'], 'captured page changed during normalization')
    atomic_json(target, result, expected)
    print(f"JCR catalog: {len(result['journals'])} journals, {len(result['categories'])} categories; complete={result['source']['complete']['journals']}")


if __name__ == '__main__':
    main()
