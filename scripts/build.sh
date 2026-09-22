#!/bin/sh
# Package the plugin as build/zotpop-<version>.xpi
# Uses python's zipfile: macOS `zip` can emit archives that Firefox's zip reader
# rejects with ERROR_CORRUPT_FILE (-3).
set -e
cd "$(dirname "$0")/.."
if LC_ALL=C grep -q '[^[:print:][:space:]]' manifest.json; then
	echo "manifest.json contains non-ASCII characters; Zotero would reject the .xpi."; exit 1
fi
if ! node -p "require('./manifest.json').applications.zotero.update_url || ''" | grep -q .; then
	echo "manifest.json has no applications.zotero.update_url; Zotero would skip the .xpi silently."; exit 1
fi
# The journal registry is generated once, in Style Custom, and copied here at build
# time so both plugins colour a journal from one table rather than two that drift.
# Only the openly licensed build is copied: a registry carrying Journal Citation
# Reports figures is licensed to its reader and is read at runtime from their own
# folder in the Zotero data directory instead. Missing means an older checkout.
rm -f content/journal-registry.json
if [ -f zotero-style-custom/data/journal-registry.open.json ]; then
	cp zotero-style-custom/data/journal-registry.open.json content/journal-registry.json
fi
# The updater is written once, in Style Custom, and copied here the same way.
if [ -f zotero-style-custom/src/updater.js ]; then
	cp zotero-style-custom/src/updater.js content/updater.js
fi
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p build
OUT="build/zotpop-${VERSION}.xpi"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
roots = ["manifest.json", "bootstrap.js", "prefs.js", "src", "content"]
# Licensed journal figures are never packaged. They live in the reader's own Zotero
# data directory and are loaded from there at runtime.
skip = {".DS_Store", "jcr-2025-data.js"}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root in roots:
        if os.path.isfile(root):
            z.write(root, root)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                if name in skip:
                    continue
                full = os.path.join(dirpath, name)
                z.write(full, os.path.relpath(full, "."))
    bad = z.testzip()
    if bad:
        raise SystemExit("corrupt entry: " + bad)
PY
echo "Built $OUT"
