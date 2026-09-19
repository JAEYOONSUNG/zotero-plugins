# -*- coding: utf-8 -*-
"""The subject of every journal in the registry, from OpenAlex.

The journals tab could group by subject only for the journals the library
already held and had a profile for: 206 of 22,594. Every other row showed an
empty 분야 cell and the three subject menus counted in the tens.

OpenAlex gives each source a ranked list of topics, and each topic carries its
subfield, field and domain. This sweeps the registry's ISSNs 50 at a time and
writes data/journal-fields.json: a table of names plus, per journal rank, the
distinct domain/field/subfield triples that its top topics belong to, largest
first, at most four.

  python3 scripts/build-journal-fields.py            # continue where it stopped
  python3 scripts/build-journal-fields.py --restart

The key is the user's own OpenAlex key, read from the Zotero profile; this
file is data that ships with the plugin, so the sweep runs here and not on
anybody's machine at run time.
"""
import json, os, sys, time, urllib.request, urllib.error, glob

OUT = 'data/journal-fields.json'
REGISTRY = 'data/journal-registry.json'
TOP_TOPICS = 8          # topics to read per source, ranked by works count
MAX_LEVELS = 4          # triples kept per journal

def key():
    for path in glob.glob(os.path.expanduser('~/Library/Application Support/Zotero/Profiles/*/prefs.js')):
        for line in open(path, encoding='utf-8', errors='ignore'):
            if 'openAlexApiKey' in line or 'openalexApiKey' in line:
                parts = line.split('", "')
                if len(parts) > 1: return parts[1].rstrip('");\n').rstrip('"')
    raise SystemExit('No OpenAlex key in the Zotero profile. Enter one in ZotPoP or Style Custom settings first.')

def fetch(issns, token, tries=4):
    url = ('https://api.openalex.org/sources?select=id,issn,display_name,topics&per-page=50&filter=issn:'
           + '%7C'.join(issns))
    for attempt in range(tries):
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token,
                                                       'User-Agent': 'style-custom-registry-build'})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode('utf-8')).get('results', [])
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503) and attempt < tries - 1:
                time.sleep(3 * (attempt + 1)); continue
            raise
        except Exception:
            if attempt < tries - 1: time.sleep(3 * (attempt + 1)); continue
            raise
    return []

def main():
    restart = '--restart' in sys.argv
    journals = json.load(open(REGISTRY, encoding='utf-8'))['journals']
    state = {'names': [], 'levels': {}, 'asked': 0, 'found': 0}
    if os.path.exists(OUT) and not restart:
        state = json.load(open(OUT, encoding='utf-8'))
    names = state['names']; index = {n: i for i, n in enumerate(names)}
    def id_of(name):
        if name not in index:
            index[name] = len(names); names.append(name)
        return index[name]
    done = set(state['levels'])
    todo = [(str(rank), row) for rank, row in enumerate(journals, 1)
            if str(rank) not in done and row.get('issns')]
    print(f'{len(done)} done, {len(todo)} to go')
    token = key()
    batch = []
    byIssn = {}
    def flush():
        nonlocal batch
        if not batch: return
        state['asked'] += len(batch)
        for source in fetch([b[0] for b in batch], token):
            ranks = set()
            for issn in source.get('issn') or []:
                if issn in byIssn: ranks.add(byIssn[issn])
            if not ranks: continue
            seen, order = {}, []
            for topic in (source.get('topics') or [])[:TOP_TOPICS]:
                triple = (topic.get('domain', {}).get('display_name'),
                          topic.get('field', {}).get('display_name'),
                          topic.get('subfield', {}).get('display_name'))
                if not all(triple): continue
                seen[triple] = seen.get(triple, 0) + (topic.get('count') or 0)
                if triple not in order: order.append(triple)
            order.sort(key=lambda t: -seen[t])
            packed = [[id_of(d), id_of(f), id_of(s)] for d, f, s in order[:MAX_LEVELS]]
            for rank in ranks:
                state['levels'][rank] = packed
                state['found'] += 1
        batch = []
    for rank, row in todo:
        issn = row['issns'][0]
        byIssn[issn] = rank
        batch.append((issn, rank))
        if len(batch) == 50:
            flush()
            if state['asked'] % 1000 == 0:
                json.dump(state, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
                print(f"  asked {state['asked']} · found {state['found']}", flush=True)
    flush()
    state['names'] = names
    json.dump(state, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f"asked {state['asked']} · journals with a subject {len(state['levels'])} · names {len(names)}")

def merge():
    """Write what the sweep found into the registry that ships with the plugin.

    One file and one fetch at start: the registry row carries its own subjects,
    packed as indexes into a table of names shared by all 22,594 rows."""
    fields = json.load(open(OUT, encoding='utf-8'))
    registry = json.load(open(REGISTRY, encoding='utf-8'))
    names, levels = fields['names'], fields['levels']
    used, remap = {}, []
    def keep(i):
        if i not in used:
            used[i] = len(remap); remap.append(names[i])
        return used[i]
    filled = 0
    for rank, row in enumerate(registry['journals'], 1):
        packed = levels.get(str(rank))
        row.pop('levels', None)
        if not packed: continue
        row['levels'] = [[keep(d), keep(f), keep(s)] for d, f, s in packed]
        filled += 1
    registry['subjects'] = remap
    registry['withSubjects'] = filled
    json.dump(registry, open(REGISTRY, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{filled} of {len(registry["journals"])} journals carry a subject · {len(remap)} names')

if '--merge' in sys.argv: merge()
else: main()
