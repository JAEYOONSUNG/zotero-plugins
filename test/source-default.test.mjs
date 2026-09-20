import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uiHarness } from "./helpers/search-ui-harness.mjs";

const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
const prefs = readFileSync(new URL("../prefs.js", import.meta.url), "utf8");

test("the shipped default searches every source, not one", () => {
  const shipped = /pref\("extensions\.zotpop\.defaultSource",\s*"([^"]+)"\)/.exec(prefs);
  assert.equal(shipped[1], "multi");
});

test("the source fallback follows the selected engine and shipped default", () => {
  const direct = uiHarness({ prefs: { defaultSource: "", popDefaultSource: "" } });
  direct.get("engine").value = "direct";
  direct.populateSearchSources();
  assert.equal(direct.get("source").value, "multi");
  direct.get("engine").value = "pop";
  direct.populateSearchSources();
  assert.equal(direct.get("source").value, "scholar");
  const saved = uiHarness({ prefs: { defaultSource: "openalex", popDefaultSource: "pubmed" } });
  saved.get("engine").value = "direct"; saved.populateSearchSources();
  assert.equal(saved.get("source").value, "openalex");
  saved.get("engine").value = "pop"; saved.populateSearchSources();
  assert.equal(saved.get("source").value, "pubmed");
});

test("a profile pinned to the old single-source default is moved across exactly once", () => {
  const block = /if \(!PREF\("multiSourceMigrated"\)\) \{([\s\S]*?)\}/.exec(ui);
  assert.ok(block, "there should be a one-time migration");
  // Only the value that used to be the default is moved; a later, deliberate
  // choice of a single source must survive.
  assert.match(block[1], /PREF\("defaultSource"\) === "openalex"/);
  assert.match(block[1], /PREF\("defaultSource", "multi"\)/);
  assert.match(block[1], /PREF\("multiSourceMigrated", true\)/);
  assert.match(prefs, /multiSourceMigrated/, "the flag needs a shipped default");
});

test("the combined search really does span several sources", async () => {
  const sources = await import("../content/sources.js").catch(() => null);
  const text = readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
  const multi = /const MULTI_SOURCES = \[([^\]]+)\]/.exec(text);
  assert.ok(multi, "MULTI_SOURCES should exist");
  const names = multi[1].split(",").map(s => s.trim().replace(/"/g, ""));
  assert.ok(names.length >= 3, `"multi" should query several sources, got ${names.join(", ")}`);
  assert.ok(names.includes("openalex") && names.includes("crossref"));
});

test("the search tab asks for an icon Zotero can actually draw", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/zotpop.js", import.meta.url), "utf8");
  const icon = /data:\s*\{\s*icon:\s*"([^"]+)"/.exec(source);
  assert.ok(icon, "Zotero_Tabs.add throws without a data object");
  // The tab bar renders this as data-item-type, so it must be an item type the
  // skin styles; "magnifier" is not one and left an empty icon slot.
  assert.ok(/^[a-z][A-Za-z]+$/.test(icon[1]));
  assert.notEqual(icon[1], "magnifier");
});

test("no dead pattern pretends to filter preprints", async () => {
  const { readFileSync } = await import("node:fs");
  const sources = readFileSync(new URL("../content/sources.js", import.meta.url), "utf8");
  // SRC:PPR is what restricts the source; a declared-but-unused publisher
  // pattern read like a second, active filter.
  const declared = [...sources.matchAll(/const (PREPRINT_[A-Z_]+)\s*=/g)].map(m => m[1]);
  for (const name of declared) {
    const uses = (sources.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
    assert.ok(uses > 1, `${name} is declared but never used`);
  }
  assert.match(sources, /SRC:PPR/, "the preprint source is still restricted");
});
