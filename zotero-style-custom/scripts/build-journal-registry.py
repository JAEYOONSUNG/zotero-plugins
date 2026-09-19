# -*- coding: utf-8 -*-
"""One registry for everything the plugins know about a journal.

The impact factor lived in data/if-jcr-2025.json, the abbreviation in a table
inside journal-identity.js, the colour in a second table kept identical by
hand in both plugins, and the publisher nowhere. Asking "what do we know about
this journal" meant four places and two of them could drift.

This writes data/journal-registry.json: one row per JCR journal with its
title, ISSNs, JCR abbreviation, impact factor and year, quartile, and the
publisher OpenAlex reports for it. The colour is not stored here -- it is
derived at run time from the publisher (or the curated exact table), so a
change to a family's hue does not mean regenerating 22,594 rows.

  python3 scripts/build-journal-registry.py PUBLISHERS_JSON
"""
import json, re, sys

jcr = json.load(open('data/if-jcr-2025.json', encoding='utf-8'))
publishers = {}
if len(sys.argv) > 1:
    raw = json.load(open(sys.argv[1], encoding='utf-8'))
    publishers = raw.get('out', raw)

rows = []
with_publisher = 0
for r in jcr:
    issns = [i for i in (r.get('issns') or []) if i]
    pub = ''
    for issn in issns:
        hit = publishers.get(issn)
        if hit and hit.get('publisher'):
            pub = hit['publisher']; break
    if pub: with_publisher += 1
    m = re.search(r'\bQ([1-4])\b', r.get('evidence') or '')
    rows.append({
        'title': r['title'],
        'issns': issns,
        'abbreviation': (r.get('aliases') or [''])[0],
        'impactFactor': r.get('impactFactor'),
        'year': r.get('year'),
        'quartile': int(m.group(1)) if m else None,
        'publisher': pub,
    })

out = {'edition': 'JCR 2026 (JIF 2025)', 'count': len(rows), 'withPublisher': with_publisher, 'journals': rows}
json.dump(out, open('data/journal-registry.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(f'journal-registry.json: {len(rows)} journals · publisher known for {with_publisher}')
