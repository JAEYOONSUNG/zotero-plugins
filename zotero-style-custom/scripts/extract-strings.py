# -*- coding: utf-8 -*-
"""Pull the Korean string literals out of the source, accurately.

The first attempt matched quotes with a regex over the whole file, which walked
straight through comments and template-literal boundaries and produced fragments
of code as if they were strings. This walks the text character by character and
knows what it is inside of."""
import re, json, glob, collections

def literals(text):
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '/' and i + 1 < n and text[i+1] == '/':
            j = text.find('\n', i)
            i = n if j < 0 else j + 1
            continue
        if c == '/' and i + 1 < n and text[i+1] == '*':
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in '\'"`':
            quote, j, buf, parts = c, i + 1, [], 0
            while j < n:
                d = text[j]
                if d == '\\':
                    buf.append(text[j:j+2]); j += 2; continue
                if quote == '`' and d == '$' and j + 1 < n and text[j+1] == '{':
                    depth, k = 1, j + 2
                    while k < n and depth:
                        if text[k] == '{': depth += 1
                        elif text[k] == '}': depth -= 1
                        k += 1
                    # A literal inside the placeholder -- `${t('그룹 보기')} · ${n}` -- is
                    # a key of its own; the placeholder used to swallow it unseen.
                    out.extend(literals(text[j+2:k-1]))
                    buf.append('{%d}' % parts); parts += 1; j = k; continue
                if d == quote:
                    break
                if d == '\n' and quote != '`':
                    buf = None; break
                buf.append(d); j += 1
            if buf is not None and j < n:
                out.append(''.join(buf))
            i = j + 1
            continue
        i += 1
    return out

def collect(files):
    found, where = collections.Counter(), collections.defaultdict(set)
    for f in files:
        if f.endswith('i18n.js') or f.endswith('strings.js'): continue
        for s in literals(open(f, encoding='utf-8').read()):
            if not re.search(r'[가-힣]', s): continue
            s = s.replace('\\n', '\n').replace("\\'", "'").replace('\\"', '"').replace('\\`', '`')
            if len(s) > 400: continue
            found[s] += 1
            where[s].add(f)
    return found, where

if __name__ == '__main__':
    files = sorted(glob.glob('src/*.js')) + sorted(glob.glob('content/*.xhtml'))
    found, where = collect(files)
    bad = [s for s in found if '\n' in s and len(s.split('\n')) > 4]
    print('distinct:', len(found), '· occurrences:', sum(found.values()), '· suspicious multiline:', len(bad))
    rows = [{'ko': k, 'n': v, 'files': sorted(where[k])} for k, v in found.most_common()]
    json.dump({'strings': rows}, open('data/strings-ko.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
