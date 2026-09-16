#!/bin/sh
# Build ZotPoP and install it into Zotero as a packed .xpi.
# Zotero must be closed. Usage: sh scripts/install.sh [profile-dir]
#
# Notes learned the hard way on Zotero 9 (Firefox 140 base):
#  - Pointer/proxy files in <profile>/extensions are NOT scanned any more; only .xpi files are.
#  - A *new* .xpi is only picked up when the add-on registry is rebuilt, so the first install
#    removes extensions.json (backed up first). Later updates just need a version scan.
#  - manifest.json must be pure ASCII. Non-ASCII there makes Zotero reject the archive
#    with ERROR_CORRUPT_FILE (-3) and silently delete it.
set -e
cd "$(dirname "$0")/.."
ID=$(node -p "require('./manifest.json').applications.zotero.id")
VERSION=$(node -p "require('./manifest.json').version")
SUPPORT="$HOME/Library/Application Support/Zotero"
PROFILE="${1:-$(ls -d "$SUPPORT/Profiles/"*.default 2>/dev/null | head -1)}"

[ -n "$PROFILE" ] || { echo "Zotero profile not found"; exit 1; }
if pgrep -q -f "Zotero.app/Contents/MacOS/zotero"; then
	echo "Quit Zotero first, then rerun."; exit 1
fi
if LC_ALL=C grep -q '[^[:print:][:space:]]' manifest.json; then
	echo "manifest.json contains non-ASCII characters; Zotero will reject the .xpi."; exit 1
fi
if ! node -p "require('./manifest.json').applications.zotero.update_url || ''" | grep -q .; then
	echo "manifest.json has no applications.zotero.update_url; Zotero would skip the .xpi silently."; exit 1
fi

sh scripts/build.sh
mkdir -p "$PROFILE/extensions"
rm -f "$PROFILE/extensions/$ID"          # stale pointer file from older installs
cp "build/zotpop-$VERSION.xpi" "$PROFILE/extensions/$ID.xpi"

# Keep sideloaded plugins enabled and force an add-on scan on next launch
sed -i '' -e '/extensions.lastAppBuildId/d' -e '/extensions.lastAppVersion/d' \
	-e '/extensions.autoDisableScopes/d' "$PROFILE/prefs.js"
echo 'user_pref("extensions.autoDisableScopes", 0);' >> "$PROFILE/prefs.js"
rm -f "$PROFILE/addonStartup.json.lz4"

if node -e "
const fs=require('fs');
const p='$PROFILE/extensions.json';
const d=JSON.parse(fs.readFileSync(p,'utf8'));
process.exit(d.addons.some(a=>a.id==='$ID') ? 0 : 1);
" 2>/dev/null; then
	echo "Updating existing registration"
else
	echo "First install: rebuilding the add-on registry (other plugins are re-detected)"
	# A second run before Zotero relaunches finds no registry; do not abort, and never
	# overwrite the original backup with an already-rebuilt one.
	if [ -f "$PROFILE/extensions.json" ]; then
		[ -f "$PROFILE/extensions.json.zotpop-backup" ] \
			|| cp "$PROFILE/extensions.json" "$PROFILE/extensions.json.zotpop-backup"
		rm -f "$PROFILE/extensions.json"
	fi
fi

echo "Installed ZotPoP $VERSION -> $PROFILE/extensions/$ID.xpi"
echo "Start Zotero; open it from the toolbar magnifier or Tools menu."
