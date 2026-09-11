#!/usr/bin/env python3
"""Build and independently validate a deterministic Zotero XPI (stdlib only)."""
import json
from pathlib import Path
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["manifest.json", "bootstrap.js", "prefs.js", "src/model.js", "src/marquee.js",
         "src/runtime.js", "content/preferences.xhtml"]


def validate_manifest(manifest):
    app = manifest["applications"]["zotero"]
    assert app.get("id") == "zotero-focus@sungjaeyoon.dev", "Wrong plugin identity"
    assert app.get("update_url", "").startswith("https:"), "Zotero 9 requires a secure update_url"
    assert app.get("strict_max_version"), "Zotero requires strict_max_version"


def validate(path, expected):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, "Corrupt archive entry"
        assert set(archive.namelist()) == set(FILES), "Unexpected or missing runtime files"
        manifest = json.loads(archive.read("manifest.json"))
        validate_manifest(manifest)
        assert manifest == expected, "Manifest mismatch"
        assert manifest["applications"]["zotero"]["id"] == "zotero-focus@sungjaeyoon.dev"
        for name in FILES:
            assert archive.read(name) == (ROOT / name).read_bytes(), "Stale file: " + name


def main():
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
    output = ROOT / "build" / ("zotero-focus-" + manifest["version"] + ".xpi")
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
