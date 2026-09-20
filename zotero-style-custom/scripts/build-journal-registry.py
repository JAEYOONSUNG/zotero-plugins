# -*- coding: utf-8 -*-
"""Build a metric registry without presenting metric provenance as taxonomy.

The legacy single quartile has no category context. OpenAlex subject captures
are merged separately by stable journal identity.
"""
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re


def build_registry(jcr, publishers=None):
    if not isinstance(jcr, list):
        raise ValueError('JCR catalog must be an array')
    publishers = publishers or {}
    if not isinstance(publishers, dict):
        raise ValueError('Publisher lookup must be an object')
    publishers = publishers.get('out', publishers)
    if not isinstance(publishers, dict):
        raise ValueError('Publisher lookup must be an object')
    rows = []
    for record in jcr:
        if not isinstance(record, dict) or not isinstance(record.get('title'), str) or not record['title'].strip():
            raise ValueError('Invalid journal metric record')
        if not isinstance(record.get('issns', []), list):
            raise ValueError('Journal ISSNs must be an array')
        issns = [value for value in record.get('issns', []) if value]
        publisher, publisher_id = '', None
        for issn in issns:
            hit = publishers.get(issn)
            if isinstance(hit, dict) and hit.get('publisher'):
                publisher, publisher_id = hit['publisher'], hit.get('sourceId', hit.get('id'))
                break
        quartile = re.search(r'\bQ([1-4])\b', record.get('evidence') or '')
        metric_year = record.get('year')
        rows.append({'title': record['title'], 'issns': copy.deepcopy(issns),
            'abbreviation': (record.get('aliases') or [''])[0], 'impactFactor': record.get('impactFactor'),
            'year': metric_year, 'quartile': int(quartile.group(1)) if quartile else None, 'publisher': publisher,
            'metricProvenance': {'provider': 'Clarivate' if record.get('authority') == 'jcr' else record.get('authority'),
                'product': 'JCR' if record.get('authority') == 'jcr' else None, 'metricYear': metric_year,
                'releaseYear': metric_year + 1 if isinstance(metric_year, int) else None,
                'sourceURL': record.get('sourceURL'), 'checkedAt': record.get('checkedAt'),
                'verification': 'legacy-catalog', 'evidence': record.get('evidence'),
                'categoryRankingsAvailable': False, 'quartileCategoryKnown': False},
            'publisherProvenance': {'provider': 'OpenAlex', 'sourceId': publisher_id} if publisher else None,
            'subjectProvenance': {'provider': None, 'scheme': None, 'capturedAt': None,
                                  'identifiersRetained': False, 'complete': False, 'status': 'not-captured'}})
    years = sorted({row['year'] for row in rows if isinstance(row['year'], int)})
    all_jcr = bool(rows) and all(row['metricProvenance']['product'] == 'JCR' for row in rows)
    edition = f'JCR {years[0] + 1} (JIF {years[0]})' if all_jcr and len(years) == 1 else 'Journal metric catalog (mixed or unknown provenance)'
    return {'edition': edition, 'count': len(rows), 'withPublisher': sum(bool(row['publisher']) for row in rows),
        'journals': rows, 'metricProvenance': {'verification': 'legacy-catalog', 'metricYears': years,
                                            'categoryRankingsAvailable': False, 'quartileCategoryKnown': False},
        'subjectProvenance': {'provider': None, 'scheme': None, 'capturedAt': None, 'complete': False, 'status': 'not-captured'}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('publishers', nargs='?')
    parser.add_argument('--catalog', default='data/if-jcr-2025.json')
    parser.add_argument('--out', default='data/journal-registry.json')
    args = parser.parse_args(argv)
    catalog_path, output_path = Path(args.catalog), Path(args.out)
    catalog_bytes = catalog_path.read_bytes()
    publisher_bytes = Path(args.publishers).read_bytes() if args.publishers else None
    before = output_path.read_bytes() if output_path.exists() else None
    result = build_registry(json.loads(catalog_bytes), json.loads(publisher_bytes) if publisher_bytes else {})
    if catalog_path.read_bytes() != catalog_bytes or args.publishers and Path(args.publishers).read_bytes() != publisher_bytes:
        raise ValueError('Metric inputs changed during build; output was not replaced')
    spec = importlib.util.spec_from_file_location('journal_fields_atomic', Path(__file__).with_name('build-journal-fields.py'))
    fields = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fields)
    fields.atomic_json(output_path, result, before)
    print(f"journal-registry.json: {len(result['journals'])} metric records; taxonomy not yet captured")


if __name__ == '__main__':
    main()
