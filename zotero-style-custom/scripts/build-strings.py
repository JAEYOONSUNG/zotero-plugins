# -*- coding: utf-8 -*-
"""Generate src/strings.js from the translation table."""
import json
T=json.load(open('data/strings-en.json',encoding='utf-8'))
body=json.dumps(T, ensure_ascii=False, indent=1, sort_keys=True)
out = '''/* English for the Korean strings this plugin is written in.

   The Korean text is the key: see i18n.js for why. A string that is not here
   still reads correctly in Korean, so this table can be filled in over time
   without any moment where the panel is broken.

   Generated; edit the table rather than this file by hand. */
(function (root) {
  'use strict';
  const en = %s;
  const api = {en};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CustomStyleStrings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
''' % body
open('src/strings.js','w',encoding='utf-8').write(out)
print('src/strings.js:', len(T), 'entries')
