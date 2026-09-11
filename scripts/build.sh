#!/bin/sh
# Package the plugin as build/zotpop-<version>.xpi
# Uses python's zipfile: macOS `zip` can emit archives that Firefox's zip reader
# rejects with ERROR_CORRUPT_FILE (-3).
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p build
OUT="build/zotpop-${VERSION}.xpi"
rm -f "$OUT"
python3 - "$OUT" <<'PY'
import os, sys, zipfile
out = sys.argv[1]
roots = ["manifest.json", "bootstrap.js", "prefs.js", "src", "content"]
skip = {".DS_Store"}
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
