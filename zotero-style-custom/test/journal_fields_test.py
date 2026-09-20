"""Offline regression tests for future subject captures and metric provenance."""
import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


fields = module('journal_fields', 'build-journal-fields.py')
builder = module('journal_registry', 'build-journal-registry.py')
NOW = '2026-09-20T12:34:56Z'
FIRST = {'title': 'First Journal', 'issns': ['0028-0836', '1476-4687'], 'impactFactor': 5.0}
SECOND = {'title': 'Second Journal', 'issns': ['0036-8075'], 'impactFactor': 4.0}


def topic(index, path=None):
    path = index % 5 if path is None else path
    return {'id': f'https://openalex.org/T{index}', 'display_name': f'Topic {index}', 'count': index + 1,
            'domain': {'id': 'https://openalex.org/domains/1', 'display_name': 'Domain'},
            'field': {'id': 'https://openalex.org/fields/10', 'display_name': 'Field'},
            'subfield': {'id': f'https://openalex.org/subfields/{path}', 'display_name': f'Subfield {path}'}}


def source(row=FIRST, source_id='S1', topics=None):
    return {'id': 'https://openalex.org/' + source_id, 'issn': row['issns'], 'display_name': row['title'],
            'topics': [topic(i) for i in range(9)] if topics is None else topics}


def capture(registry, sources):
    return fields.capture_registry(registry, lambda _: sources, captured_at=NOW)


class JournalFieldsTests(unittest.TestCase):
    def test_imports_have_no_network_or_main_side_effects(self):
        with patch.object(fields.urllib.request, 'urlopen', side_effect=AssertionError('No network on import')):
            fresh = module('journal_fields_import_check', 'build-journal-fields.py')
            metrics = module('journal_registry_import_check', 'build-journal-registry.py')
        self.assertTrue(callable(fresh.main))
        self.assertTrue(callable(metrics.build_registry))

    def test_identity_and_fingerprint_ignore_order_and_unrelated_metadata(self):
        original = {'journals': [FIRST, SECOND]}
        reordered = copy.deepcopy({'journals': [SECOND, FIRST], 'subjectProvenance': {'complete': False}})
        reordered['journals'][1]['issns'] = ['14764687', '0028 0836', '0028-0836']
        reordered['journals'][1]['impactFactor'] = 6.2
        self.assertEqual(fields.registry_fingerprint(original), fields.registry_fingerprint(reordered))
        self.assertEqual(fields.journal_identity(FIRST), fields.journal_identity(reordered['journals'][1]))
        state = capture(original, [source(), source(SECOND, 'S2')])
        merged = fields.merge_state(reordered, state)
        self.assertEqual([row['subjectProvenance']['sourceId'] for row in merged['journals']],
                         ['https://openalex.org/S2', 'https://openalex.org/S1'])
        changed = {'journals': [FIRST]}
        with self.assertRaisesRegex(ValueError, '--restart'):
            fields.validate_state(state, changed)

    def test_all_nine_topics_five_paths_identifiers_and_weights_are_retained(self):
        registry = {'journals': [FIRST]}
        raw = source()
        state = capture(registry, [raw])
        entry = state['records'][fields.journal_identity(FIRST)]
        self.assertEqual(entry['topics'], raw['topics'])
        self.assertEqual(len(entry['paths']), 5)
        self.assertEqual(sum(path['weight'] for path in entry['paths']), 45)
        self.assertEqual(entry['paths'][0]['subfield']['id'], 'https://openalex.org/subfields/3')
        self.assertEqual(entry['paths'][0]['weight'], 13)
        self.assertEqual(entry['capturedAt'], NOW)
        merged = fields.merge_state(registry, state)
        row = merged['journals'][0]
        self.assertEqual(len(row['levels']), 5)
        self.assertEqual(len(row['subjectTopics']), 9)
        self.assertEqual(len(merged['subjectTaxonomy']['topics']), 9)
        self.assertEqual({descriptor['id'] for descriptor in merged['subjectTaxonomy']['topics']},
                         {value['id'] for value in raw['topics']})
        self.assertTrue(row['subjectProvenance']['identifiersRetained'])
        self.assertEqual(row['subjectProvenance']['taxonomy'], 'openalex-topics')
        self.assertIsNone(row['subjectProvenance']['topicLimit'])
        self.assertIsNone(row['subjectProvenance']['pathLimit'])
        self.assertNotIn('subjects', registry, 'merge must not mutate its input')

    def test_all_issns_are_queried_and_electronic_only_match_is_accepted(self):
        calls = []
        electronic = source()
        electronic['issn'] = ['1476-4687']
        state = fields.capture_registry({'journals': [FIRST]}, lambda codes: calls.append(codes) or [electronic], captured_at=NOW)
        self.assertEqual(calls, [['0028-0836', '1476-4687']])
        self.assertEqual(state['records'][fields.journal_identity(FIRST)]['status'], 'matched')

    def test_empty_missing_ambiguous_and_no_issn_are_explicit_and_retryable(self):
        journal = {'title': 'No identifiers', 'issns': []}
        for responses, expected in [([], 'missing'), ([source(topics=[])], 'empty'),
                                    ([source(), source(source_id='S2')], 'ambiguous')]:
            registry = {'journals': [FIRST]}
            state = capture(registry, responses)
            record = state['records'][fields.journal_identity(FIRST)]
            self.assertEqual(record['status'], expected)
            calls = []
            retried = fields.capture_registry(registry, lambda codes: calls.append(codes) or [source()], state, NOW)
            self.assertEqual(len(calls), 1)
            self.assertEqual(retried['records'][record['journalId']]['attempts'], 2)
            self.assertEqual(retried['records'][record['journalId']]['status'], 'matched')
        state = fields.capture_registry({'journals': [journal]}, lambda _: self.fail('No ISSN must not issue a query'), captured_at=NOW)
        self.assertEqual(next(iter(state['records'].values()))['status'], 'no-issn')

    def test_distinct_or_conflicting_sources_never_overwrite_arbitrarily(self):
        original = source()
        repeated = fields.capture_record(FIRST, [original, copy.deepcopy(original)], NOW)
        self.assertEqual(repeated['status'], 'matched')
        conflict = copy.deepcopy(original)
        conflict['topics'][0]['count'] = 999
        result = fields.capture_record(FIRST, [original, conflict], NOW)
        self.assertEqual(result['status'], 'ambiguous')
        self.assertEqual(len(result['sourceCandidates']), 2)

    def test_successful_records_resume_without_requests(self):
        registry = {'journals': [FIRST]}
        state = capture(registry, [source()])
        result = fields.capture_registry(registry, lambda _: self.fail('Matched row should resume'), state, NOW)
        self.assertEqual(result['records'], state['records'])

    def test_missing_capture_preserves_legacy_paths_and_never_claims_whole_merge_complete(self):
        registry = {'subjects': ['Old Domain', 'Old Field', 'Old Subfield'], 'journals': [copy.deepcopy(FIRST), copy.deepcopy(SECOND)]}
        registry['journals'][1].update({'levels': [[0, 1, 2]], 'subjectProvenance': {'capturedAt': None, 'complete': False, 'legacyTopicLimit': 8}})
        state = capture(registry, [source()])
        merged = fields.merge_state(registry, state)
        old = merged['journals'][1]
        self.assertEqual(old['levels'], [[0, 1, 2]])
        self.assertIsNone(old['subjectProvenance']['capturedAt'])
        self.assertEqual(old['subjectCaptureAttempt']['status'], 'missing')
        self.assertFalse(merged['subjectProvenance']['complete'])
        self.assertEqual(merged['subjectProvenance']['legacyOrUnresolvedJournals'], 1)

    def test_shared_descriptors_keep_registry_compact_without_losing_topic_ids(self):
        registry = {'journals': [FIRST, SECOND]}
        shared = [topic(i) for i in range(9)]
        merged = fields.merge_state(registry, capture(registry, [source(topics=shared), source(SECOND, 'S2', shared)]))
        self.assertEqual(len(merged['subjectTaxonomy']['topics']), 9, 'do not duplicate descriptors for every journal')
        self.assertEqual(len(merged['subjectTaxonomy']['domains']), 1)
        self.assertEqual(len(merged['subjectTaxonomy']['subfields']), 5)
        self.assertEqual(merged['journals'][0]['subjectTopics'], merged['journals'][1]['subjectTopics'])
        self.assertTrue(all(isinstance(row, list) and len(row) == 2 for row in merged['journals'][0]['subjectTopics']))

    def test_unresolved_rows_inherit_existing_legacy_provenance_not_fresh_capture_claims(self):
        legacy = {'provider': 'OpenAlex', 'scheme': 'topics', 'capturedAt': None,
                  'legacyTopicLimit': 8, 'legacyPathLimit': 4, 'identifiersRetained': False, 'complete': False}
        registry = {'journals': [{**FIRST, 'levels': [[0, 1, 2]]}], 'subjects': ['Domain', 'Field', 'Old subject'], 'subjectProvenance': legacy}
        result = fields.merge_state(registry, capture(registry, []))
        self.assertEqual(result['journals'][0]['subjectProvenance'], legacy)
        self.assertFalse(result['subjectProvenance']['complete'])
        malformed = copy.deepcopy(registry)
        malformed['journals'][0]['levels'][0][2] = 99
        with self.assertRaisesRegex(ValueError, 'invalid packed'):
            fields.merge_state(malformed, capture(malformed, []))
        for boolean in (True, False):
            malformed['journals'][0]['levels'][0][2] = boolean
            with self.assertRaisesRegex(ValueError, 'invalid packed'):
                fields.merge_state(malformed, capture(malformed, []))

    def test_incomplete_topic_identity_or_hierarchy_is_not_complete_classification(self):
        incomplete_topics = []
        missing_id = topic(1)
        missing_id.pop('id')
        incomplete_topics.append(missing_id)
        missing_field_id = topic(2)
        missing_field_id['field'].pop('id')
        incomplete_topics.append(missing_field_id)
        missing_hierarchy = topic(3)
        missing_hierarchy.pop('subfield')
        incomplete_topics.append(missing_hierarchy)
        for incomplete in incomplete_topics:
            registry = {'journals': [FIRST]}
            topics = [topic(0), incomplete]
            state = capture(registry, [source(topics=topics)])
            record = next(iter(state['records'].values()))
            self.assertEqual(record['topics'], topics)
            self.assertTrue(record['captureComplete'])
            self.assertFalse(record['classificationComplete'])
            result = fields.merge_state(registry, state)
            provenance = result['journals'][0]['subjectProvenance']
            self.assertTrue(provenance['captureComplete'])
            self.assertFalse(provenance['classificationComplete'])
            self.assertFalse(provenance['complete'])
            self.assertFalse(provenance['identifiersRetained'])
            self.assertEqual(provenance['unclassifiedTopicCount'], 1)
            self.assertEqual(len(result['journals'][0]['subjectTopics']), 2)
            self.assertTrue(result['subjectProvenance']['captureComplete'])
            self.assertFalse(result['subjectProvenance']['complete'])
            self.assertFalse(result['subjectProvenance']['classificationComplete'])
            self.assertEqual(result['subjectProvenance']['legacyOrUnresolvedJournals'], 1)
            calls = []
            retried = fields.capture_registry(registry, lambda codes: calls.append(codes) or [source()], state, NOW)
            self.assertEqual(len(calls), 1, 'partial classifications must remain retryable')
            self.assertTrue(next(iter(retried['records'].values()))['classificationComplete'])

    def test_checkpoint_snapshots_do_not_mutate_as_later_batches_complete(self):
        rows = [{'title': f'Journal {index}', 'issns': [f'1000-{index:04d}']} for index in range(52)]
        registry = {'journals': rows}
        snapshots = []
        by_issn = {row['issns'][0]: row for row in rows}
        def fetcher(codes):
            return [source(by_issn[code], 'S' + code.replace('-', ''), [topic(0)]) for code in codes]
        result = fields.capture_registry(registry, fetcher, captured_at=NOW, checkpoint=snapshots.append)
        self.assertEqual([len(state['records']) for state in snapshots], [50, 52])
        for state in snapshots:
            fields.validate_state(state, registry)
        snapshots[0]['records'].clear()
        self.assertEqual(len(result['records']), 52)
        self.assertEqual(len(snapshots[1]['records']), 52)

    def test_checkpoint_policy_bounds_full_snapshots_and_failed_batches_never_leak(self):
        rows = [{'title': f'Journal {index}', 'issns': [f'1000-{index:04d}']} for index in range(104)]
        registry = {'journals': rows}
        by_issn = {row['issns'][0]: row for row in rows}
        def fetcher(codes):
            return [source(by_issn[code], 'S' + code.replace('-', ''), [topic(0)]) for code in codes]
        snapshots = []
        fields.capture_registry(registry, fetcher, captured_at=NOW, checkpoint=snapshots.append,
                                checkpoint_policy=lambda count: count % 100 == 0)
        self.assertEqual([len(state['records']) for state in snapshots], [100, 104], 'bounded checkpoint plus final')
        calls, snapshots = [], []
        def broken(codes):
            calls.append(codes)
            sources = fetcher(codes)
            if len(calls) == 2:
                sources[-1]['topics'] = 'invalid'
            return sources
        with self.assertRaisesRegex(ValueError, 'topics array'):
            fields.capture_registry(registry, broken, captured_at=NOW, checkpoint=snapshots.append,
                                    checkpoint_policy=lambda count: False)
        self.assertEqual([len(state['records']) for state in snapshots], [50], 'late error flushes only completed first batch')

    def test_late_cli_failure_preserves_successful_batch_and_resume_skips_it(self):
        rows = [{'title': f'Journal {index}', 'issns': [f'1000-{index:04d}']} for index in range(52)]
        registry = {'journals': rows}
        by_issn = {row['issns'][0]: row for row in rows}
        with tempfile.TemporaryDirectory() as directory:
            registry_path, state_path = Path(directory) / 'registry.json', Path(directory) / 'state.json'
            registry_path.write_text(json.dumps(registry))
            calls = []
            def failing(codes, token):
                calls.append(list(codes))
                if len(calls) == 2:
                    raise OSError('late quota failure')
                return [source(by_issn[code], 'S' + code.replace('-', ''), [topic(0)]) for code in codes]
            args = ['--registry', str(registry_path), '--out', str(state_path)]
            with patch.object(fields, 'fetch', side_effect=failing):
                with self.assertRaisesRegex(OSError, 'late quota failure'):
                    fields.main(args)
            checkpoint = json.loads(state_path.read_text())
            self.assertEqual(len(checkpoint['records']), 50)
            fields.validate_state(checkpoint, registry)
            resumed_calls = []
            def success(codes, token):
                resumed_calls.append(list(codes))
                return [source(by_issn[code], 'S' + code.replace('-', ''), [topic(0)]) for code in codes]
            with patch.object(fields, 'fetch', side_effect=success), contextlib.redirect_stdout(io.StringIO()):
                fields.main(args)
            self.assertEqual(resumed_calls, [calls[1]])
            final = json.loads(state_path.read_text())
            self.assertEqual(len(final['records']), 52)
            self.assertEqual([final['records'][key] for key in checkpoint['records']], list(checkpoint['records'].values()))

    def test_same_names_with_different_taxonomy_ids_remain_distinct(self):
        topics = [topic(1, 1), topic(2, 2)]
        topics[1]['subfield']['display_name'] = topics[0]['subfield']['display_name']
        registry = {'journals': [FIRST]}
        merged = fields.merge_state(registry, capture(registry, [source(topics=topics)]))
        self.assertEqual(len(merged['journals'][0]['subjectPaths']), 2)
        self.assertEqual(len(merged['subjectTaxonomy']['subfields']), 2)
        self.assertNotEqual(*[row[2] for row in merged['journals'][0]['subjectPaths']])

    def test_legacy_state_refusal_never_changes_files_or_fetches(self):
        with tempfile.TemporaryDirectory() as directory:
            registry_path, state_path = Path(directory) / 'registry.json', Path(directory) / 'fields.json'
            registry_path.write_text(json.dumps({'journals': [FIRST]}))
            state_path.write_text(json.dumps({'names': ['Legacy'], 'levels': {'1': [[0, 0, 0]]}}))
            before = (registry_path.read_bytes(), state_path.read_bytes())
            with patch.object(fields, 'fetch', side_effect=AssertionError('Legacy refusal must precede network')):
                with self.assertRaisesRegex(ValueError, '--restart'):
                    fields.main(['--registry', str(registry_path), '--out', str(state_path)])
                with self.assertRaisesRegex(ValueError, '--restart'):
                    fields.merge_files(registry_path, state_path)
            self.assertEqual(before, (registry_path.read_bytes(), state_path.read_bytes()))

    def test_failed_restart_and_invalid_merge_leave_previous_output_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            registry_path, state_path = Path(directory) / 'registry.json', Path(directory) / 'fields.json'
            registry = {'journals': [FIRST]}
            registry_path.write_text(json.dumps(registry))
            state_path.write_text('legacy bytes retained')
            with patch.object(fields, 'fetch', side_effect=OSError('network failed')):
                with self.assertRaisesRegex(OSError, 'network failed'):
                    fields.main(['--restart', '--registry', str(registry_path), '--out', str(state_path)])
            self.assertEqual(state_path.read_text(), 'legacy bytes retained')
            invalid = capture(registry, [source()])
            invalid['records'][fields.journal_identity(FIRST)]['paths'][0]['weight'] = -100
            state_path.write_text(json.dumps(invalid))
            before = registry_path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'differ from captured'):
                fields.merge_files(registry_path, state_path)
            self.assertEqual(registry_path.read_bytes(), before)

    def test_atomic_writer_refuses_concurrent_changes_and_non_json_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'output.json'
            path.write_text('newer external bytes')
            with self.assertRaisesRegex(ValueError, 'changed during build'):
                fields.atomic_json(path, {'new': 'value'}, b'previous bytes')
            with self.assertRaises(ValueError):
                fields.atomic_json(path, {'bad': float('nan')}, path.read_bytes())
            self.assertEqual(path.read_text(), 'newer external bytes')
            fields.atomic_json(path, {'valid': True}, path.read_bytes())
            self.assertEqual(json.loads(path.read_text()), {'valid': True})
            self.assertEqual(list(Path(directory).glob('*.tmp')), [])

    def test_fetch_reads_all_pages_without_suppressing_extra_source_matches(self):
        pages = [{'meta': {'count': 201}, 'results': [{'id': str(i)} for i in range(200)]},
                 {'meta': {'count': 201}, 'results': [{'id': 'extra'}]}]
        calls = []
        def open_page(request, timeout):
            calls.append(request)
            return io.BytesIO(json.dumps(pages.pop(0)).encode())
        with patch.object(fields.urllib.request, 'urlopen', side_effect=open_page):
            result = fields.fetch(['0028-0836', '1476-4687'], token='test-token')
        self.assertEqual(len(result), 201)
        self.assertEqual([urllib.parse.parse_qs(urllib.parse.urlsplit(call.full_url).query)['page'][0] for call in calls], ['1', '2'])
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0].full_url).query)['filter'], ['issn:0028-0836|1476-4687'])
        with patch.object(fields.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"results":[]}')):
            with self.assertRaisesRegex(ValueError, 'pagination metadata'):
                fields.fetch(['0028-0836'])

    def test_metric_catalog_provenance_never_implies_official_classification(self):
        record = {**FIRST, 'aliases': ['FIRST J'], 'year': 2025, 'authority': 'jcr',
                  'sourceURL': 'https://jcr.clarivate.com/jcr/home', 'checkedAt': '2026-06-18', 'evidence': 'JIF 5.0 Q1'}
        result = builder.build_registry([record], {'1476-4687': {'publisher': 'Publisher', 'id': 'S1'}})
        row = result['journals'][0]
        self.assertEqual(row['quartile'], 1)
        self.assertEqual(row['metricProvenance']['provider'], 'Clarivate')
        self.assertEqual(row['metricProvenance']['releaseYear'], 2026)
        self.assertFalse(row['metricProvenance']['quartileCategoryKnown'])
        self.assertFalse(row['metricProvenance']['categoryRankingsAvailable'])
        self.assertEqual(row['publisherProvenance']['provider'], 'OpenAlex')
        self.assertIsNone(row['subjectProvenance']['provider'])
        self.assertIsNone(row['subjectProvenance']['capturedAt'])
        self.assertFalse(row['subjectProvenance']['complete'])
        self.assertNotIn('levels', row)
        self.assertEqual(result['edition'], 'JCR 2026 (JIF 2025)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
