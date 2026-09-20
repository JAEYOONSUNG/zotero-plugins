# -*- coding: utf-8 -*-
"""Capture all returned OpenAlex topics with stable journal identity.

Old positional state requires --restart. Capture/merge writes are atomic and
only occur after successful validation. OPENALEX_API_KEY optionally supplies
the intended service key; importing this module never reads settings or files.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

OUT = 'data/journal-fields.json'
REGISTRY = 'data/journal-registry.json'
SCHEMA_VERSION = 2
TAXONOMY = 'openalex-topics'


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def normalized_issns(row):
    values = row.get('issns') or []
    if not isinstance(values, list):
        raise ValueError('Journal ISSNs must be an array')
    codes = set()
    for value in values:
        code = re.sub(r'[-\s]', '', str(value)).upper()
        if re.fullmatch(r'\d{7}[\dX]', code):
            codes.add(code[:4] + '-' + code[4:])
    return sorted(codes)


def journal_identity(row):
    codes = normalized_issns(row)
    if codes:
        return 'issn:' + '|'.join(codes)
    title = ' '.join(unicodedata.normalize('NFKC', str(row.get('title') or '')).casefold().split())
    if not title:
        raise ValueError('Journal needs a title or normalized ISSN identity')
    return 'title:' + hashlib.sha256(title.encode('utf-8')).hexdigest()


def registry_rows(registry):
    rows = registry.get('journals') if isinstance(registry, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('Invalid journal registry')
    ids = [journal_identity(row) for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError('Ambiguous duplicate journal identities in registry')
    return rows


def registry_fingerprint(registry):
    ids = sorted(journal_identity(row) for row in registry_rows(registry))
    return hashlib.sha256(json.dumps(ids, separators=(',', ':')).encode()).hexdigest()


def new_state(registry):
    return {'schemaVersion': SCHEMA_VERSION, 'taxonomy': TAXONOMY,
            'registryFingerprint': registry_fingerprint(registry), 'records': {}}


def validate_state(state, registry):
    if not isinstance(state, dict) or state.get('schemaVersion') != SCHEMA_VERSION:
        raise ValueError('Legacy positional subject state cannot be resumed or merged; capture with --restart')
    if state.get('taxonomy') != TAXONOMY or not isinstance(state.get('records'), dict):
        raise ValueError('Invalid subject state; capture again with --restart')
    if state.get('registryFingerprint') != registry_fingerprint(registry):
        raise ValueError('Registry identities changed; capture again with --restart')
    valid = {journal_identity(row) for row in registry_rows(registry)}
    for key, record in state['records'].items():
        if key not in valid or not isinstance(record, dict) or record.get('journalId') != key:
            raise ValueError('Invalid subject record identity; use --restart')
        if record.get('status') not in {'matched', 'empty', 'missing', 'ambiguous', 'no-issn'}:
            raise ValueError('Invalid subject capture status; use --restart')
        if not isinstance(record.get('capturedAt'), str) or not record['capturedAt'] or not isinstance(record.get('attempts'), int) or record['attempts'] < 1:
            raise ValueError('Subject capture lacks timestamp or attempt provenance; use --restart')
        try:
            captured = datetime.datetime.fromisoformat(record['capturedAt'].replace('Z', '+00:00'))
            if captured.utcoffset() is None:
                raise ValueError('Timestamp needs a timezone')
        except ValueError as error:
            raise ValueError('Invalid capture timestamp; use --restart') from error
        if record['status'] == 'matched':
            if not isinstance(record.get('sourceId'), str) or not record['sourceId'] or not isinstance(record.get('paths'), list) or not record['paths'] or not isinstance(record.get('topics'), list):
                raise ValueError('Incomplete matched source capture; use --restart')
            if record['paths'] != source_paths(record['topics']):
                raise ValueError('Stored paths differ from captured topics; use --restart')
    return state


def fetch(issns, token=None, tries=4):
    """Read all source matches, including ambiguous matches and later pages."""
    result, page = [], 1
    while True:
        params = {'select': 'id,issn,display_name,topics', 'per-page': 200, 'page': page,
                  'filter': 'issn:' + '|'.join(issns)}
        url = 'https://api.openalex.org/sources?' + urllib.parse.urlencode(params)
        headers = {'User-Agent': 'style-custom-registry-build'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        for attempt in range(tries):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
                    data = json.loads(response.read().decode('utf-8'))
                break
            except urllib.error.HTTPError as error:
                if error.code not in (429, 500, 502, 503) or attempt + 1 == tries:
                    raise
                time.sleep(3 * (attempt + 1))
        items, total = data.get('results'), data.get('meta', {}).get('count')
        if not isinstance(items, list) or not isinstance(total, int) or total < 0:
            raise ValueError('OpenAlex returned incomplete pagination metadata')
        result.extend(items)
        if len(result) >= total:
            return result
        if not items:
            raise ValueError('OpenAlex pagination ended before its reported total')
        page += 1


def topic_node(topic, kind):
    raw = topic.get(kind) or {}
    if not isinstance(raw, dict):
        return {'id': None, 'name': ''}
    return {'id': raw.get('id'), 'name': str(raw.get('display_name') or '').strip()}


def source_paths(topics):
    paths = {}
    for topic in topics:
        if not isinstance(topic, dict):
            raise ValueError('OpenAlex topic must be an object')
        nodes = {kind: topic_node(topic, kind) for kind in ('domain', 'field', 'subfield')}
        if not all(node['name'] for node in nodes.values()):
            continue
        key = json.dumps(nodes, sort_keys=True, ensure_ascii=False)
        path = paths.setdefault(key, {**nodes, 'weight': 0, 'weightComplete': True, 'topicIds': []})
        count = topic.get('count')
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            path['weight'] += count
        else:
            path['weightComplete'] = False
        if topic.get('id') is not None:
            path['topicIds'].append(topic['id'])
    return sorted(paths.values(), key=lambda path: -path['weight'])


def complete_topic(topic):
    def known_id(value):
        return isinstance(value, str) and bool(value.strip()) or isinstance(value, int) and not isinstance(value, bool) and value >= 0
    return isinstance(topic, dict) and known_id(topic.get('id')) and bool(str(topic.get('display_name') or '').strip()) and all(
        node['name'] and known_id(node['id']) for node in (topic_node(topic, kind) for kind in ('domain', 'field', 'subfield')))


def classification_complete(topics):
    return isinstance(topics, list) and bool(topics) and all(complete_topic(topic) for topic in topics)


def capture_record(row, sources, captured_at, attempts=1):
    codes = set(normalized_issns(row))
    base = {'journalId': journal_identity(row), 'title': row.get('title', ''), 'issns': sorted(codes),
            'taxonomy': TAXONOMY, 'capturedAt': captured_at, 'attempts': attempts,
            'captureComplete': False, 'classificationComplete': False}
    if not codes:
        return {**base, 'status': 'no-issn', 'paths': [], 'topics': []}
    # Never choose arbitrarily between distinct sources or conflicting snapshots.
    candidates = {}
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError('OpenAlex source must be an object')
        if codes.intersection(normalized_issns({'issns': source.get('issn') or []})):
            candidates[json.dumps(source, sort_keys=True, ensure_ascii=False)] = source
    if not candidates:
        return {**base, 'status': 'missing', 'paths': [], 'topics': []}
    if len(candidates) != 1:
        return {**base, 'status': 'ambiguous', 'captureComplete': True,
                'sourceCandidates': copy.deepcopy(list(candidates.values())), 'paths': [], 'topics': []}
    source = next(iter(candidates.values()))
    if not isinstance(source.get('id'), str) or not source['id'] or not isinstance(source.get('topics'), list):
        raise ValueError('OpenAlex source lacks an ID or complete topics array')
    topics = copy.deepcopy(source['topics'])
    paths = source_paths(topics)
    return {**base, 'status': 'matched' if paths else 'empty', 'sourceId': source['id'],
            'sourceName': source.get('display_name', ''), 'sourceIssns': normalized_issns({'issns': source.get('issn') or []}),
            'topics': topics, 'paths': paths, 'captureComplete': True,
            'classificationComplete': classification_complete(topics)}


def capture_registry(registry, fetcher, state=None, captured_at=None, checkpoint=None, checkpoint_policy=None):
    output = copy.deepcopy(validate_state(state, registry)) if state is not None else new_state(registry)
    def completed(row):
        record = output['records'].get(journal_identity(row), {})
        return record.get('status') == 'matched' and classification_complete(record.get('topics'))
    pending = [row for row in registry_rows(registry) if not completed(row)]
    completed_count, checkpoint_count = 0, 0

    def capture_batch(batch):
        nonlocal completed_count
        codes = sorted({code for row in batch for code in normalized_issns(row)})
        sources = []
        for start in range(0, len(codes), 50):
            response = fetcher(codes[start:start + 50])
            if not isinstance(response, list):
                raise ValueError('Source fetch must return a complete list')
            sources.extend(response)
        now = captured_at or utc_now()
        updates = {}
        for row in batch:
            key = journal_identity(row)
            attempts = output['records'].get(key, {}).get('attempts', 0) + 1
            updates[key] = capture_record(row, sources, now, attempts)
        # Commit the batch only after every row validates. A failed later row
        # must not leak earlier rows from that failed batch into a checkpoint.
        output['records'].update(updates)
        completed_count += len(batch)
        output['updatedAt'] = now

    def emit_checkpoint():
        nonlocal checkpoint_count
        checkpoint(copy.deepcopy(validate_state(output, registry)))
        checkpoint_count = completed_count

    def run_batch(batch):
        try:
            capture_batch(batch)
        except Exception:
            if checkpoint and completed_count > checkpoint_count:
                emit_checkpoint()  # Flush only previously completed batches.
            raise
        if checkpoint and (checkpoint_policy is None or checkpoint_policy(completed_count)):
            emit_checkpoint()

    batch, codes = [], set()
    for row in pending:
        incoming = set(normalized_issns(row))
        if batch and len(codes | incoming) > 50:
            run_batch(batch)
            batch, codes = [], set()
        batch.append(row)
        codes.update(incoming)
    if batch:
        run_batch(batch)
    if checkpoint and completed_count > checkpoint_count:
        emit_checkpoint()
    output.setdefault('updatedAt', captured_at or utc_now())
    return output


def merge_state(registry, state):
    validate_state(state, registry)
    result = copy.deepcopy(registry)
    names = result.setdefault('subjects', [])
    if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
        raise ValueError('Registry subject names must be an array of strings')
    for row in result['journals']:
        for path in row.get('levels') or []:
            if not isinstance(path, list) or len(path) != 3 or any(not isinstance(index, int) or isinstance(index, bool) or index < 0 or index >= len(names) for index in path):
                raise ValueError('Existing registry has invalid packed subject references')
    name_index = {name: index for index, name in enumerate(names)}
    taxonomy = result.setdefault('subjectTaxonomy', {'domains': [], 'fields': [], 'subfields': [], 'topics': []})
    tables = {}
    for kind in ('domains', 'fields', 'subfields', 'topics'):
        if not isinstance(taxonomy.get(kind), list):
            raise ValueError('Invalid shared taxonomy descriptor table')
        tables[kind] = {json.dumps(value, sort_keys=True, ensure_ascii=False): index for index, value in enumerate(taxonomy[kind])}

    def descriptor(kind, value):
        key = json.dumps(value, sort_keys=True, ensure_ascii=False)
        if key not in tables[kind]:
            tables[kind][key] = len(taxonomy[kind])
            taxonomy[kind].append(value)
        return tables[kind][key]

    def indexes(nodes):
        domain = descriptor('domains', nodes['domain'])
        field = descriptor('fields', {**nodes['field'], 'domain': domain})
        subfield = descriptor('subfields', {**nodes['subfield'], 'domain': domain, 'field': field})
        return domain, field, subfield

    def name_id(value):
        if value not in name_index:
            name_index[value] = len(names)
            names.append(value)
        return name_index[value]

    updated, complete_classifications, complete_captures = 0, 0, 0
    for row in result['journals']:
        capture = state['records'].get(journal_identity(row))
        if row.get('levels') and not row.get('subjectProvenance'):
            row['subjectProvenance'] = copy.deepcopy(registry.get('subjectProvenance') or {
                'provider': 'OpenAlex', 'scheme': 'topics', 'capturedAt': None,
                'identifiersRetained': False, 'complete': False, 'status': 'legacy-unverified'})
        if not capture:
            continue
        row['subjectCaptureAttempt'] = {key: copy.deepcopy(capture[key]) for key in ('status', 'capturedAt', 'attempts')}
        row['subjectCaptureAttempt'].update({'captureComplete': capture.get('captureComplete') is True,
            'classificationComplete': classification_complete(capture.get('topics')),
            'canonicalData': 'updated' if capture['status'] == 'matched' else 'retained'})
        complete_captures += capture.get('captureComplete') is True
        if capture['status'] != 'matched':
            continue  # Prior paths and their provenance survive failed/empty lookup.
        paths = capture['paths']
        packed, compact_paths, compact_topics = [], [], []
        for path in paths:
            if not all(isinstance(path.get(kind), dict) and isinstance(path[kind].get('name'), str) and path[kind]['name']
                       for kind in ('domain', 'field', 'subfield')):
                raise ValueError('Matched capture has an invalid subject path')
            packed.append([name_id(path[kind]['name']) for kind in ('domain', 'field', 'subfield')])
            compact_paths.append([*indexes(path), path['weight'], path['weightComplete']])
        for topic in capture['topics']:
            nodes = {kind: topic_node(topic, kind) for kind in ('domain', 'field', 'subfield')}
            domain, field, subfield = indexes(nodes)
            topic_index = descriptor('topics', {'id': topic.get('id'), 'name': topic.get('display_name', ''),
                                               'domain': domain, 'field': field, 'subfield': subfield})
            compact_topics.append([topic_index, topic.get('count')])
        row['levels'], row['subjectPaths'], row['subjectTopics'] = packed, compact_paths, compact_topics
        complete = classification_complete(capture['topics'])
        complete_classifications += complete
        row['subjectProvenance'] = {'provider': 'OpenAlex', 'scheme': 'topics', 'taxonomy': TAXONOMY,
            'sourceId': capture['sourceId'], 'capturedAt': capture['capturedAt'], 'complete': complete,
            'captureComplete': True, 'classificationComplete': complete,
            'coverage': 'all-topics-returned-by-source', 'sourceTopicCount': len(capture['topics']),
            'unclassifiedTopicCount': sum(not complete_topic(topic) for topic in capture['topics']),
            'identifiersRetained': complete,
            'topicLimit': None, 'pathLimit': None}
        updated += 1
    result['withSubjects'] = sum(bool(row.get('levels')) for row in result['journals'])
    result['subjectProvenance'] = {'provider': 'OpenAlex', 'scheme': 'topics', 'taxonomy': TAXONOMY,
        'stateSchemaVersion': SCHEMA_VERSION, 'registryFingerprint': state['registryFingerprint'],
        'updatedJournals': updated, 'totalJournals': len(result['journals']),
        'complete': complete_classifications == len(result['journals']),
        'classificationComplete': complete_classifications == len(result['journals']),
        'captureComplete': complete_captures == len(result['journals']),
        'legacyOrUnresolvedJournals': len(result['journals']) - complete_classifications,
        'descriptorLayout': {'subjectPaths': ['domainIndex', 'fieldIndex', 'subfieldIndex', 'weight', 'weightComplete'],
                             'subjectTopics': ['topicIndex', 'count']}}
    return result


def atomic_json(path, value, expected):
    path = Path(path)
    encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    current = path.read_bytes() if path.exists() else None
    if current != expected:
        raise ValueError('Output changed during build; refusing to overwrite it')
    if encoded == current:
        return encoded
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, path.stat().st_mode & 0o777 if path.exists() else 0o644)
        current = path.read_bytes() if path.exists() else None
        if current != expected:
            raise ValueError('Output changed during build; refusing to overwrite it')
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            os.unlink(temporary)
    return encoded


def merge_files(registry_path=REGISTRY, state_path=OUT):
    target, capture_path = Path(registry_path), Path(state_path)
    before, source = target.read_bytes(), capture_path.read_bytes()
    result = merge_state(json.loads(before), json.loads(source))
    if capture_path.read_bytes() != source:
        raise ValueError('Capture state changed during merge; retry')
    atomic_json(target, result, before)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restart', action='store_true')
    parser.add_argument('--merge', action='store_true')
    parser.add_argument('--registry', default=REGISTRY)
    parser.add_argument('--out', default=OUT)
    args = parser.parse_args(argv)
    if args.merge:
        result = merge_files(args.registry, args.out)
        print(f"Merged {result['subjectProvenance']['updatedJournals']} captured journals; unresolved entries retain prior provenance")
        return
    registry_path, output_path = Path(args.registry), Path(args.out)
    registry_bytes = registry_path.read_bytes()
    registry = json.loads(registry_bytes)
    old_bytes = output_path.read_bytes() if output_path.exists() else None
    state = json.loads(old_bytes) if old_bytes is not None and not args.restart else None
    if state is not None:
        validate_state(state, registry)
    token = os.environ.get('OPENALEX_API_KEY')
    expected = old_bytes
    saved_count, saved_time = 0, time.monotonic()
    def checkpoint_policy(completed):
        nonlocal saved_count, saved_time
        now = time.monotonic()
        if completed - saved_count >= 1000 or now - saved_time >= 30:
            saved_count, saved_time = completed, now
            return True
        return False
    def checkpoint(snapshot):
        nonlocal expected
        if registry_path.read_bytes() != registry_bytes:
            raise ValueError('Registry changed during capture; checkpoint was not replaced')
        expected = atomic_json(output_path, snapshot, expected)
    captured = capture_registry(registry, lambda codes: fetch(codes, token), state,
                                checkpoint=checkpoint, checkpoint_policy=checkpoint_policy)
    checkpoint(captured)
    print(f"Captured {len(captured['records'])} journal identities; taxonomy {TAXONOMY}")


if __name__ == '__main__':
    main()
