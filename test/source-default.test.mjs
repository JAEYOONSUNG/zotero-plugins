import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../content/ui.js", import.meta.url), "utf8");
const prefs = readFileSync(new URL("../prefs.js", import.meta.url), "utf8");

test("the shipped default searches every source, not one", () => {
  const shipped = /pref\("extensions\.zotpop\.defaultSource",\s*"([^"]+)"\)/.exec(prefs);
  assert.equal(shipped[1], "multi");
});

test("the fallback in the window agrees with the shipped default", () => {
  // Hard-coding a single source here silently overrode prefs.js, so every
  // profile searched one API no matter what the plugin shipped.
  const fallbacks = [...ui.matchAll(/sel\.value\s*=\s*(?:PREF\("defaultSource"\)\s*\|\|\s*)?"([^"]+)"/g)]
    .map(match => match[1]);
  assert.ok(fallbacks.length, "the source select should have a fallback");
  for (const value of fallbacks) assert.equal(value, "multi", `fallback "${value}" contradicts prefs.js`);
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
