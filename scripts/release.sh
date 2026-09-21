#!/bin/sh
# Publish a release of one or both plugins so installed copies update themselves:
# build the xpi, write its hash into the update feed, commit, tag, push, and
# create the GitHub release with the xpi as its asset.
#
#   sh scripts/release.sh [zotpop|style-custom|both] [-m "release notes"]
#
# The version comes from each manifest. A plugin whose version is already
# released is skipped, so bump the manifest (and package.json) first. Both
# feeds live under updates/ on main; the installed plugins read them there.
set -e
cd "$(dirname "$0")/.."
REPO=JAEYOONSUNG/zotero-plugins
WHICH=${1:-both}; [ "$WHICH" != "-m" ] || { WHICH=both; set -- both "$@"; }
NOTES=""; [ "$2" = "-m" ] && NOTES="$3"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Commit the working tree first; the release commit carries only the feeds."; exit 1; }
command -v gh >/dev/null || { echo "gh is needed"; exit 1; }

release_one() { # name manifest-dir xpi-prefix tag-prefix feed
	NAME=$1; DIR=$2; PREFIX=$3; TAG_PREFIX=$4; FEED=$5
	VERSION=$(node -p "require('./$DIR/manifest.json').version")
	ID=$(node -p "require('./$DIR/manifest.json').applications.zotero.id")
	MIN=$(node -p "require('./$DIR/manifest.json').applications.zotero.strict_min_version || '7.0'")
	TAG="$TAG_PREFIX-v$VERSION"
	if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then echo "$NAME $VERSION is already released ($TAG); skipping."; return 0; fi
	if [ "$DIR" = "." ]; then sh scripts/build.sh >/dev/null; else (cd "$DIR" && python3 scripts/build.py >/dev/null); fi
	XPI="$DIR/build/$PREFIX-$VERSION.xpi"; [ -f "$XPI" ] || { echo "build did not produce $XPI"; exit 1; }
	HASH=$(shasum -a 256 "$XPI" | cut -d' ' -f1)
	LINK="https://github.com/$REPO/releases/download/$TAG/$PREFIX-$VERSION.xpi"
	node -e '
		const [feed, id, version, link, hash, min] = process.argv.slice(1);
		const fs = require("fs");
		const data = { addons: { [id]: { updates: [ { version, update_link: link, update_hash: "sha256:" + hash, applications: { zotero: { strict_min_version: min } } } ] } } };
		fs.writeFileSync(feed, JSON.stringify(data, null, 2) + "\n");
	' "$FEED" "$ID" "$VERSION" "$LINK" "$HASH" "$MIN"
	# The README's "Latest" column points at the new file.
	sed -i '' -E "s#$PREFIX-[0-9.]+\.xpi\]\([^)]*\)#$PREFIX-$VERSION.xpi]($LINK)#" README.md
	RELEASED="$RELEASED $NAME $VERSION"; TAGS="$TAGS $TAG"
	printf '%s\t%s\t%s %s\n' "$TAG" "$XPI" "$NAME" "$VERSION" >> "$PLAN"
}

PLAN=$(mktemp); trap 'rm -f "$PLAN"' EXIT
RELEASED=""; TAGS=""
[ "$WHICH" = "style-custom" ] || release_one ZotPoP . zotpop zotpop updates/zotpop.json
[ "$WHICH" = "zotpop" ] || release_one "Style Custom" zotero-style-custom style-custom style-custom updates/style-custom.json
[ -n "$RELEASED" ] || { echo "Nothing to release."; exit 0; }

git add updates/ README.md
git commit -q -m "Release:$RELEASED" -m "${NOTES:-The update feeds name the new files and their hashes.}"
for TAG in $TAGS; do git tag -f "$TAG"; done
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push -q origin "$BRANCH" "HEAD:main" $TAGS
while IFS="$(printf '\t')" read -r TAG XPI TITLE; do
	gh release create "$TAG" "$XPI" -R "$REPO" --title "$TITLE" --notes "${NOTES:-See the commit history for what changed.}" --target main >/dev/null
	echo "Released $TITLE: $XPI"
done < "$PLAN"
echo "Installed copies pick these up on their next daily check, or from the Updates section of their preferences."
