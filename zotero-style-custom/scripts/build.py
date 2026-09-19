#!/usr/bin/env python3
"""Build and independently validate a deterministic Zotero XPI (stdlib only)."""
import json
import subprocess
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["manifest.json", "bootstrap.js", "prefs.js", "src/data.js", "src/reading.js", "src/marquee.js",
         "src/workspace.js", "src/assist.js", "src/library.js", "src/reader-tools.js", "src/workbench.js", "content/workbench.css", "content/citation.css", "src/runtime.js", "src/citations.js", "src/citation-formats.js", "src/supplementary.js", "src/discover.js", "src/paper-signals.js", "src/legacy-reading.js", "src/journal-metrics.js", "src/selfcheck.js", "src/failures.js", "src/brand-icons.js", "src/i18n.js", "src/strings.js", "src/author-portrait.js", "src/attachment-kinds.js", "src/item-kinds.js", "src/journal-identity.js", "src/affiliations.js", "src/paper-graph.js", "LICENSES.md", "src/journals.js", "data/if-catalog.json", "data/journal-registry.json", "data/features.json", "content/preferences.xhtml", "content/preferences.css", "src/settings-schema.js", "src/settings.js", "content/icons/style-custom.svg", "content/icons/style-custom-toolbar.svg", *[f"content/icons/style-custom-{size}.png" for size in [16,24,32,48,96,128,256]]]


def validate_manifest(manifest):
    app = manifest["applications"]["zotero"]
    assert app.get("id") == "style-custom@sungjaeyoon.dev", "Wrong plugin identity"
    assert app.get("update_url", "").startswith("https:"), "Zotero 9 requires a secure update_url"
    assert app.get("strict_max_version"), "Zotero requires strict_max_version"
    for size, name in manifest.get("icons", {}).items():
        assert size.isdigit() and name in FILES, "Invalid icon mapping"
        blob = (ROOT / name).read_bytes()
        assert blob[:8] == b"\x89PNG\r\n\x1a\n", "Icon is not PNG"
        assert int.from_bytes(blob[16:20], "big") == int(size) == int.from_bytes(blob[20:24], "big"), "Wrong icon dimensions"


def validate(path, expected):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, "Corrupt archive entry"
        assert set(archive.namelist()) == set(FILES), "Unexpected or missing runtime files"
        manifest = json.loads(archive.read("manifest.json"))
        validate_manifest(manifest)
        assert manifest == expected, "Manifest mismatch"
        assert manifest["applications"]["zotero"]["id"] == "style-custom@sungjaeyoon.dev"
        for name in FILES:
            assert archive.read(name) == (ROOT / name).read_bytes(), "Stale file: " + name


def main():
    catalogs = sorted((ROOT / "data").glob("if-*.json"))
    inputs = [p for p in catalogs if p.name != "if-catalog.json"]
    subprocess.run(["node", str(ROOT / "scripts/verify-if-catalog.mjs"), *map(str, inputs)], check=True)
    records = [row for path in inputs for row in json.loads(path.read_text())]
    (ROOT / "data/if-catalog.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    validate_manifest(manifest)
    incomplete_manifest = json.loads(json.dumps(manifest))
    del incomplete_manifest["applications"]["zotero"]["update_url"]
    try:
        validate_manifest(incomplete_manifest)
    except AssertionError:
        pass
    else:
        raise AssertionError("Manifest checker accepted a missing update URL")
    package = json.loads((ROOT / "package.json").read_text())
    assert manifest["version"] == package["version"], "Version mismatch"
    assert all((ROOT / name).is_file() for name in FILES), "Missing source file"
    # Prove the archive checker rejects a real incomplete package.
    with tempfile.TemporaryDirectory(prefix="focus-build-control-") as temp:
        broken = Path(temp) / "missing-runtime.xpi"
        with zipfile.ZipFile(broken, "w") as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
        try:
            validate(broken, manifest)
        except AssertionError:
            pass
        else:
            raise AssertionError("Archive checker accepted an incomplete package")
    output = ROOT / "build" / ("style-custom-" + manifest["version"] + ".xpi")
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, (ROOT / name).read_bytes())
    validate(output, manifest)
    print("XPI verification passed:", output)


if __name__ == "__main__":
    main()
