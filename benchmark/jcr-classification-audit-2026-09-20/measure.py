"""Read-only JCR classification audit. --capture saves local evidence; --verify remeasures it.

Product files, preferences and installed packages are never changed. Full data/code snapshots
stay in ignored build/. The checked-in JSON contains counts, hashes and small examples only.
"""
import collections
import datetime
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
SNAP = ROOT / 'build/jcr-classification-audit-20260920/snapshot'
PROFILE = Path.home() / 'Library/Application Support/Zotero/Profiles/4f0is3m0.default/extensions'
FILES = [
    'content/journal-registry.json',
    'zotero-style-custom/data/journal-registry.json',
    'zotero-style-custom/data/journal-fields.json',
    'zotero-style-custom/data/if-jcr-2025.json',
    'zotero-style-custom/scripts/build-journal-fields.py',
    'zotero-style-custom/scripts/build-journal-registry.py',
    'zotero-style-custom/src/journal-identity.js',
    'zotero-style-custom/src/journal-metrics.js',
    'zotero-style-custom/src/workbench.js',
    'zotero-style-custom/src/strings.js',
    'zotero-style-custom/manifest.json',
    'manifest.json',
]
PACKAGES = {
    'zotpop@sungjaeyoon.dev.xpi': ['content/journal-registry.json'],
    'style-custom@sungjaeyoon.dev.xpi': ['data/journal-registry.json', 'src/journal-identity.js',
        'src/journal-metrics.js', 'src/workbench.js', 'src/strings.js'],
}
CACHE = Path.home() / 'Zotero/style-custom.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(p):
    return json.loads(p.read_bytes())


def decode(row, names):
    result = []
    for triple in row.get('levels', []):
        assert isinstance(triple, list) and len(triple) == 3
        assert all(type(i) is int and 0 <= i < len(names) for i in triple)
        result.append([names[i] for i in triple])
    return result


def selected_profiles():
    # Select journal metadata only. Never persist preferences, library records or the full cache.
    entries = read_json(CACHE).get('journalMetrics', {})
    selected = [{k: row.get(k) for k in ('name', 'profileAt', 'fields', 'topics')}
                for row in entries.values() if isinstance(row, dict)
                and row.get('name') in ('Nature', 'Science', 'Nature Methods')]
    assert len(selected) == 3, 'Expected public journal metadata controls are absent'
    return selected


def capture_profiles():
    selected = selected_profiles()
    value = json.dumps(selected, ensure_ascii=False, indent=2).encode()
    (SNAP / 'cache-profiles.json').write_bytes(value)
    return {'selectedJournalProfilesSHA256': sha(value), 'selection': [r['name'] for r in selected]}


def capture():
    assert not (OUT / 'snapshot.json').exists(), 'Existing audit snapshot must not be overwritten'
    receipt = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'workspace': {}, 'installed': {}}
    for name in FILES:
        data = (ROOT / name).read_bytes()
        dest = SNAP / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        receipt['workspace'][name] = sha(data)
    for name, members in PACKAGES.items():
        data = (PROFILE / name).read_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = {'sha256': sha(data), 'version': json.loads(archive.read('manifest.json'))['version'], 'members': {}}
            for member in members:
                value = archive.read(member)
                dest = SNAP / 'installed' / name / member
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(value)
                info['members'][member] = sha(value)
            receipt['installed'][name] = info
    receipt['cacheSample'] = capture_profiles()
    (OUT / 'snapshot.json').write_text(json.dumps(receipt, indent=2) + '\n')


def measure():
    receipt = read_json(OUT / 'snapshot.json')
    assert sha((SNAP / 'cache-profiles.json').read_bytes()) == receipt['cacheSample']['selectedJournalProfilesSHA256']
    for name, digest in receipt['workspace'].items():
        assert sha((SNAP / name).read_bytes()) == digest, name
    for name, info in receipt['installed'].items():
        for member, digest in info['members'].items():
            assert sha((SNAP / 'installed' / name / member).read_bytes()) == digest
    raw = read_json(SNAP / 'zotero-style-custom/data/journal-registry.json')
    fields = read_json(SNAP / 'zotero-style-custom/data/journal-fields.json')
    jcr = read_json(SNAP / 'zotero-style-custom/data/if-jcr-2025.json')
    rows, names = raw['journals'], raw['subjects']
    decoded = [decode(row, names) for row in rows]
    assert len(rows) == raw['count']
    assert sum(bool(x) for x in decoded) == raw['withSubjects']
    # Verify all rows against the builder's rank-indexed intermediate source, not only examples.
    matches = sum(levels == [[fields['names'][v] for v in triple]
                  for triple in fields['levels'].get(str(rank), [])]
                  for rank, levels in enumerate(decoded, 1))
    assert matches == len(rows)
    # A known invalid index must fail instead of quietly becoming an unknown label.
    try:
        decode({'levels': [[0, 1, len(names)]]}, names)
    except AssertionError:
        pass
    else:
        raise AssertionError('Invalid taxonomy index passed the audit decoder')
    installed_matches = {}
    for pkg, info in receipt['installed'].items():
        for member, digest in info['members'].items():
            source = member if pkg.startswith('zotpop@') else 'zotero-style-custom/' + member
            installed_matches[pkg + ':' + member] = digest == receipt['workspace'].get(source)
    rank = json.loads(subprocess.check_output(['node', str(OUT / 'rank-probe.cjs'), str(SNAP)], text=True))
    parents = {str(i): collections.defaultdict(set) for i in (1, 2)}
    for levels in decoded:
        for triple in levels:
            for i in (1, 2):
                parents[str(i)][triple[i]].add(triple[i-1])
    return {
        'journals': len(rows), 'withLevels': sum(bool(x) for x in decoded),
        'withoutLevels': sum(not x for x in decoded),
        'coveragePercent': round(100 * sum(bool(x) for x in decoded) / len(rows), 4),
        'levelsPerJournal': dict(sorted(collections.Counter(map(len, decoded)).items())),
        'uniqueLevelCounts': {key: len({t[i] for levels in decoded for t in levels})
                              for i, key in enumerate(('domain', 'field', 'subfield'))},
        'uniqueFullTriples': len({tuple(t) for levels in decoded for t in levels}),
        'domains': sorted({t[0] for levels in decoded for t in levels}),
        'fieldNames': sorted({t[1] for levels in decoded for t in levels}),
        'multipleParentNames': {key: {name: sorted(values) for name, values in group.items() if len(values) > 1}
                               for key, group in parents.items()},
        'rowsMatchingIntermediate': matches,
        'intermediateKeys': len(fields['levels']),
        'emptyIntermediateKeys': sum(not value for value in fields['levels'].values()),
        'registryRowKeys': sorted({key for row in rows for key in row}),
        'jcrInputRowKeys': sorted({key for row in jcr for key in row}),
        'jcrInputRows': len(jcr),
        'missingExamples': [row['title'] for row, levels in zip(rows, decoded) if not levels][:12],
        'metricQuartiles': dict(collections.Counter(str(row.get('quartile')) for row in rows)),
        'twoWorkspaceRegistriesEqual': (SNAP / 'content/journal-registry.json').read_bytes() ==
                                      (SNAP / 'zotero-style-custom/data/journal-registry.json').read_bytes(),
        'installedMatchesWorkspaceSnapshot': installed_matches,
        'productionRanks': rank,
    }


if '--capture' in sys.argv:
    capture()
    (OUT / 'measurements.json').write_text(json.dumps(measure(), ensure_ascii=False, indent=2) + '\n')
elif '--verify' in sys.argv:
    measured = json.loads(json.dumps(measure()))
    assert measured == read_json(OUT / 'measurements.json'), 'Saved measurements differ from reproduced observations'
    receipt = read_json(OUT / 'snapshot.json')
    drift = [n for n, h in receipt['workspace'].items() if sha((ROOT / n).read_bytes()) != h]
    package_drift = [n for n, info in receipt['installed'].items() if sha((PROFILE / n).read_bytes()) != info['sha256']]
    cache_drift = sha(json.dumps(selected_profiles(), ensure_ascii=False, indent=2).encode()) != receipt['cacheSample']['selectedJournalProfilesSHA256']
    print(json.dumps({'journals': measured['journals'], 'withLevels': measured['withLevels'],
                      'uniqueLevelCounts': measured['uniqueLevelCounts'], 'workspaceDrift': drift,
                      'installedDrift': package_drift, 'selectedCacheDrift': cache_drift}, ensure_ascii=False))
    print('JCR_AUDIT_MEASUREMENTS_VERIFIED')
else:
    raise SystemExit('Use --capture once, then --verify; only audit output files are written')
