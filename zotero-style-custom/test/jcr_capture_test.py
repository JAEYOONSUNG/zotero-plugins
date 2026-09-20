"""Offline controls using small journal-cell examples from the actual capture."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('jcr_catalog_capture', ROOT / 'scripts' / 'build-jcr-catalog.py')
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


def cell(text, details=None):
    return {'text': text, 'details': details or []}


def chemical():
    # Actual page 1: collapsed rank 4/88 must not replace Chemical's 13/183.
    return {'journalName': cell('Chemical Engineering Journal'), 'issn': cell('1385-8947'), 'eissn': cell('1873-3212'),
        'category': cell('Multiple\nkeyboard_arrow_down', ['ENGINEERING, CHEMICAL', 'ENGINEERING, ENVIRONMENTAL']),
        'edition': cell('', ['SCIE', 'SCIE']), 'totalCites': cell('591,800'), 'jif2019': cell('12.5'),
        'quartile': cell('Q1', ['Q1', 'Q1']), 'jci': cell('1.59'), 'percentageOAGold': cell('9.99'),
        'jifRank': cell('4/88', ['13/183', '4/88']), 'jifPercentile': cell('96.0', ['93.2', '96.0'])}


def humanities():
    # Actual page 8: AHCI is unranked although the collapsed row displays SSCI Q1.
    return {'journalName': cell('Humanities & Social Sciences Communications'), 'issn': cell('N/A'), 'eissn': cell('2662-9992'),
        'category': cell('Multiple\nkeyboard_arrow_down', ['HUMANITIES, MULTIDISCIPLINARY', 'SOCIAL SCIENCES, INTERDISCIPLINARY']),
        'edition': cell('', ['AHCI', 'SSCI']), 'totalCites': cell('19,200'), 'jif2019': cell('4.8'),
        'quartile': cell('Q1', ['N/A', 'Q1']), 'jci': cell('3.59'), 'percentageOAGold': cell('99.89'),
        'jifRank': cell('9/275', ['N/A', '9/275']), 'jifPercentile': cell('96.9', ['N/A', '96.9'])}


def nature():
    return {'journalName': cell('Nature Communications'), 'issn': cell('N/A'), 'eissn': cell('2041-1723'),
        'category': cell('MULTIDISCIPLINARY SCIENCES'), 'edition': cell('SCIE'), 'totalCites': cell('1,166,083'),
        'jif2019': cell('18.1'), 'quartile': cell('Q1'), 'jci': cell('3.47'), 'percentageOAGold': cell('99.94'),
        'jifRank': cell('8/140'), 'jifPercentile': cell('94.6')}


def taxonomy():
    # Small independent count controls, not the full production category totals.
    entries = [('ENGINEERING, CHEMICAL', ['SCIE']), ('ENGINEERING, ENVIRONMENTAL', ['SCIE']),
               ('HUMANITIES, MULTIDISCIPLINARY', ['AHCI']), ('SOCIAL SCIENCES, INTERDISCIPLINARY', ['SSCI']),
               ('MULTIDISCIPLINARY SCIENCES', ['SCIE'])]
    return {'schemaVersion': 1, 'source': {'provider': 'Clarivate', 'product': 'JCR',
        'url': 'https://jcr.clarivate.com/jcr/browse-categories', 'capturedAt': '2026-09-20T04:52:59.928Z',
        'datasetUpdated': '2026-06-17', 'releaseYear': 2026, 'metricYear': 2025,
        'complete': {'groups': True, 'categories': True, 'journals': False}},
        'groups': [{'key': 'Captured controls', 'name': 'Captured controls', 'categoryCount': 5, 'journalCount': 3,
                    'citableItems': None, 'categoryKeys': [name for name, _ in entries]}],
        'categories': [{'key': name, 'name': name, 'groupKeys': ['Captured controls'], 'editions': editions,
                        'journalCount': 1, 'citableItems': None, 'totalCitations': None, 'medianJIF': None}
                       for name, editions in entries], 'journals': []}


def page(index, rows, total=3, size=2):
    return {'index': index, 'start': (index - 1) * size + 1, 'end': min(index * size, total), 'total': total,
            'capturedAt': f'2026-09-20T05:00:{index:02}.000Z', 'rows': rows}


class CaptureTests(unittest.TestCase):
    def test_actual_multi_category_cells_use_aligned_details_not_collapsed_best_values(self):
        categories = capture.validate_taxonomy(taxonomy())
        row = capture.normalize_journal(chemical(), categories, 2025, 'control')
        self.assertEqual([(metric['categoryKey'], metric['rank'], metric['rankTotal'], metric['percentile'])
                          for metric in row['categoryMetrics']],
                         [('ENGINEERING, CHEMICAL', 13, 183, 93.2), ('ENGINEERING, ENVIRONMENTAL', 4, 88, 96.0)])
        self.assertEqual(row['totalCitations'], 591800)
        self.assertEqual(row['jif'], 12.5)
        self.assertEqual(row['year'], 2025, 'jif2019 is a DOM key, not the captured metric year')
        self.assertEqual(row['abbreviation'], '')
        self.assertNotIn('quartile', row, 'no single category-independent quartile is invented')

    def test_unranked_context_remains_null_beside_ranked_context(self):
        row = capture.normalize_journal(humanities(), capture.validate_taxonomy(taxonomy()), 2025, 'control')
        first, second = row['categoryMetrics']
        self.assertEqual([first[key] for key in ('rank', 'rankTotal', 'quartile', 'percentile')], [None] * 4)
        self.assertEqual(first['editions'], ['AHCI'])
        self.assertEqual(first['rankDisplay'], 'N/A')
        self.assertEqual((second['rank'], second['rankTotal'], second['quartile']), (9, 275, 1))
        self.assertEqual(row['issns'], ['2662-9992'])

    def test_single_category_and_bounded_metrics_preserve_display_without_numeric_inference(self):
        raw = nature()
        raw['jif2019'] = cell('<0.1')
        raw['jci'] = cell('N/A')
        raw['percentageOAGold'] = cell('0.00')
        row = capture.normalize_journal(raw, capture.validate_taxonomy(taxonomy()), 2025, 'control')
        self.assertIsNone(row['jif'])
        self.assertEqual(row['jifDisplay'], '<0.1')
        self.assertIsNone(row['jci'])
        self.assertEqual(row['openAccessPercent'], 0)
        self.assertEqual(row['categoryMetrics'][0]['rank'], 8)
        self.assertEqual(row['categoryMetrics'][0]['rankDisplay'], '8/140')

    def test_full_capture_requires_all_intervals_unique_journals_and_every_independent_category_count(self):
        data = taxonomy()
        result = capture.build_catalog(data, [page(2, [nature()]), page(1, [chemical(), humanities()])], page_size=2)
        self.assertEqual(len(result['journals']), 3)
        self.assertTrue(result['source']['complete']['journals'])
        self.assertEqual(result['source']['journalCapture']['categoriesChecked'], 5)
        self.assertTrue(all(category['journalCoverage']['complete'] for category in result['categories']))
        self.assertEqual(result['source']['journalCapture']['metricColumn'], {'domKey': 'jif2019', 'renderedMetricYear': 2025})
        self.assertEqual(result['source']['taxonomyCapturedAt'], data['source']['capturedAt'])
        self.assertEqual(data['journals'], [], 'the baseline is not mutated')
        data['categories'][-1]['journalCount'] = 2
        for partial in (False, True):
            with self.assertRaisesRegex(ValueError, 'independent category counts'):
                capture.build_catalog(data, [page(1, [chemical(), humanities()]), page(2, [nature()])], allow_partial=partial, page_size=2)

    def test_partial_prefix_is_explicitly_incomplete_globally_and_for_each_category(self):
        pages = [page(1, [chemical(), humanities()])]
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            capture.build_catalog(taxonomy(), pages, page_size=2)
        result = capture.build_catalog(taxonomy(), pages, allow_partial=True, page_size=2)
        self.assertFalse(result['source']['complete']['journals'])
        self.assertFalse(result['source']['journalCapture']['categoryMembershipCountsVerified'])
        self.assertTrue(result['source']['journalCapture']['partial'])
        self.assertTrue(all(not category['journalCoverage']['complete'] for category in result['categories']))
        self.assertEqual(result['categories'][-1]['journalCoverage']['observed'], 0)

    def test_duplicates_gaps_total_drift_and_wrong_intervals_are_rejected_even_in_partial_mode(self):
        base = [page(1, [chemical(), humanities()]), page(2, [nature()])]
        variations = []
        bad = copy.deepcopy(base); bad[1]['index'] = 3; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['total'] = 4; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['start'] = 2; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['rows'] = []; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['rows'] = [chemical()]; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['metricYear'] = 2019; variations.append(bad)
        bad = copy.deepcopy(base); bad[1]['datasetUpdated'] = '2026-06-18'; variations.append(bad)
        bad = copy.deepcopy(base); bad[0]['index'] = True; variations.append(bad)
        variations.append([base[0], base[0]])
        for pages in variations:
            with self.assertRaises(ValueError):
                capture.build_catalog(taxonomy(), pages, allow_partial=True, page_size=2)

    def test_missing_details_cannot_be_filled_from_collapsed_summary_or_other_context(self):
        for key in ('edition', 'quartile', 'jifRank', 'jifPercentile'):
            for details in ([], ['Q1']):
                raw = chemical()
                raw[key]['details'] = details
                with self.assertRaisesRegex(ValueError, 'aligned|alignment|category detail'):
                    capture.normalize_journal(raw, capture.validate_taxonomy(taxonomy()), 2025, 'control')
        raw = chemical(); raw['category']['details'] = []
        with self.assertRaisesRegex(ValueError, 'unknown or unexpanded'):
            capture.normalize_journal(raw, capture.validate_taxonomy(taxonomy()), 2025, 'control')

    def test_same_category_context_duplicates_merge_only_when_identical(self):
        data = taxonomy()
        categories = capture.validate_taxonomy(data)
        raw = nature()
        raw['category'] = cell('Multiple', ['MULTIDISCIPLINARY SCIENCES'] * 2)
        for key in ('edition', 'quartile', 'jifRank', 'jifPercentile'):
            raw[key]['details'] = [raw[key]['text']] * 2
        row = capture.normalize_journal(raw, categories, 2025, 'control')
        self.assertEqual(len(row['categoryMetrics']), 1)
        self.assertEqual(row['categoryKeys'], ['MULTIDISCIPLINARY SCIENCES'])
        raw['jifRank']['details'][1] = '9/140'
        with self.assertRaisesRegex(ValueError, 'conflicting duplicate'):
            capture.normalize_journal(raw, categories, 2025, 'control')

    def test_comma_separated_editions_stay_inside_their_aligned_category(self):
        data = taxonomy()
        data['categories'][-1]['editions'] = ['SCIE', 'ESCI']
        raw = nature(); raw['edition'] = cell('SCIE, ESCI')
        row = capture.normalize_journal(raw, capture.validate_taxonomy(data), 2025, 'control')
        self.assertEqual(row['categoryMetrics'][0]['editions'], ['SCIE', 'ESCI'])
        raw['edition'] = cell('Both')
        with self.assertRaisesRegex(ValueError, 'summary placeholders'):
            capture.normalize_journal(raw, capture.validate_taxonomy(data), 2025, 'control')

    def test_identity_preserves_punctuation_and_issns_without_old_title_collisions(self):
        self.assertNotEqual(capture.journal_key('Journal of Computer Science and Technology', ['1000-9000']),
                            capture.journal_key('Journal of Computer Science & Technology', ['1666-6046']))
        self.assertNotEqual(capture.journal_key('A and B', ['1000-9000']), capture.journal_key('A & B', ['1000-9000']))
        self.assertEqual(capture.journal_key(' First Journal ', ['1476-4687', '0028-0836']),
                         capture.journal_key('first journal', ['0028-0836', '1476-4687']))

    def test_invalid_metric_bounds_and_unknown_category_fail_closed(self):
        changes = [('jifRank', '141/140'), ('quartile', 'Q5'), ('jifPercentile', '100.1'),
                   ('percentageOAGold', '101'), ('jif2019', '-2'), ('totalCites', '1.5'), ('issn', 'bad'),
                   ('category', 'UNKNOWN CATEGORY')]
        for key, value in changes:
            raw = nature(); raw[key] = cell(value)
            with self.assertRaises(ValueError):
                capture.normalize_journal(raw, capture.validate_taxonomy(taxonomy()), 2025, 'control')
        for value in ('9,007,199,254,740,993', '1.00000000000000001'):
            with self.assertRaises(ValueError):
                capture.numeric(value, 'count', count=True)

    def test_cli_atomic_output_and_failure_preserves_existing_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            baseline, target = path / 'taxonomy.json', path / 'result.json'
            baseline.write_text(json.dumps(taxonomy()))
            (path / 'journals-001.json').write_text(json.dumps(page(1, [chemical(), humanities()])))
            target.write_text('previous result')
            args = ['--taxonomy', str(baseline), '--capture-dir', str(path), '--out', str(target), '--page-size', '2']
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                capture.main(args)
            self.assertEqual(target.read_text(), 'previous result')
            (path / 'journals-002.json').write_text(json.dumps(page(2, [nature()])))
            with contextlib.redirect_stdout(io.StringIO()):
                capture.main(args)
            result = json.loads(target.read_text())
            self.assertTrue(result['source']['complete']['journals'])
            self.assertEqual(len(result['source']['journalCapture']['files']), 2)
            self.assertEqual(list(path.glob('*.tmp')), [])
            before = target.read_bytes()
            with self.assertRaisesRegex(ValueError, 'changed during normalization'):
                capture.atomic_json(target, {}, b'wrong baseline')
            self.assertEqual(target.read_bytes(), before)

    def test_filename_page_index_mismatch_and_incomplete_taxonomy_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'journals-001.json').write_text(json.dumps(page(2, [nature()])))
            with self.assertRaisesRegex(ValueError, 'filename'):
                capture.read_pages(directory)
        data = taxonomy(); data['source']['complete']['categories'] = False
        with self.assertRaisesRegex(ValueError, 'complete group/category coverage'):
            capture.validate_taxonomy(data)
        data = taxonomy(); data['source']['provider'] = 'OpenAlex'
        with self.assertRaisesRegex(ValueError, 'Clarivate JCR'):
            capture.validate_taxonomy(data)


if __name__ == '__main__':
    unittest.main(verbosity=2)
