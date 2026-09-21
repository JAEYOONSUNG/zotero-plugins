import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const Updater = require("../src/updater.js");
assert.equal(globalThis.PluginUpdater, Updater, "the browser-side global both plugins read");
const here = path.dirname(fileURLToPath(import.meta.url));

const ID = "style-custom@sungjaeyoon.dev";
const feed = latest => ({ addons: { [ID]: { updates: [
  { version: "0.51.10", update_link: "https://example.org/style-custom-0.51.10.xpi", update_hash: "sha256:a", applications: { zotero: { strict_min_version: "7.0" } } },
  { version: latest, update_link: "https://example.org/style-custom-" + latest + ".xpi", update_hash: "sha256:b", applications: { zotero: { strict_min_version: "7.0" } } }
] } } });

function host({ version = "0.51.11", latest = "0.51.12", busy = false, autoUpdate } = {}) {
  const store = new Map();
  if (autoUpdate !== undefined) store.set("autoUpdate", autoUpdate);
  const calls = { requests: [], installs: [] };
  const timers = [];
  const updater = Updater.create({
    id: ID, version, appVersion: "9.0.6",
    updateURL: "https://raw.githubusercontent.com/x/y/main/updates/style-custom.json",
    request: async url => { calls.requests.push(url); return feed(latest); },
    install: async entry => { calls.installs.push(entry); },
    prefs: { get: k => store.get(k), set: (k, v) => store.set(k, v) },
    busy: () => busy,
    now: () => 1_700_000_000_000,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {}
  });
  return { updater, store, calls, timers };
}

test("versions compare numerically, and a pre-release sorts before its release", () => {
  const c = Updater.compareVersions;
  assert.equal(c("0.51.12", "0.51.9"), 1);
  assert.equal(c("0.51.9", "0.51.12"), -1);
  assert.equal(c("1.0", "1.0.0"), 0);
  assert.equal(c("0.52.0-beta", "0.52.0"), -1);
  assert.equal(c("0.38.2", "0.38.1"), 1);
});

test("the feed's newest entry newer than this copy is the one to install", () => {
  const entry = Updater.pick(feed("0.51.12"), { id: ID, version: "0.51.11", appVersion: "9.0.6" });
  assert.equal(entry.version, "0.51.12");
  assert.equal(Updater.pick(feed("0.51.12"), { id: ID, version: "0.51.12", appVersion: "9.0.6" }), null, "a current copy has nothing to do");
  assert.equal(Updater.pick(feed("0.51.12"), { id: ID, version: "0.60.0", appVersion: "9.0.6" }), null, "a newer local build is never downgraded");
});

test("an entry that needs a newer Zotero, or is not served over https, is skipped", () => {
  const f = feed("0.51.12");
  f.addons[ID].updates[1].applications.zotero.strict_min_version = "10.0";
  assert.equal(Updater.pick(f, { id: ID, version: "0.51.9", appVersion: "9.0.6" }).version, "0.51.10");
  const g = feed("0.51.12");
  g.addons[ID].updates[1].update_link = "http://example.org/plain.xpi";
  assert.equal(Updater.pick(g, { id: ID, version: "0.51.11", appVersion: "9.0.6" }), null);
  assert.throws(() => Updater.pick({ addons: {} }, { id: ID, version: "0.51.11" }), /no entry/);
});

test("a run fetches the feed with a cache-buster, installs the newer file and remembers the result", async () => {
  const { updater, store, calls } = host();
  const result = await updater.run({ reason: "user" });
  assert.equal(result.status, "installed");
  assert.equal(result.entry.version, "0.51.12");
  assert.match(calls.requests[0], /style-custom\.json\?t=\d+$/);
  assert.equal(calls.installs.length, 1);
  assert.equal(store.get("updateLastCheck"), "2023-11-14T22:13:20.000Z");
  const last = updater.lastResult();
  assert.equal(last.status, "installed");
  assert.equal(last.latest, "0.51.12");
});

test("a current copy is left alone, and the pref still records the check", async () => {
  const { updater, calls } = host({ version: "0.51.12" });
  const result = await updater.run();
  assert.equal(result.status, "current");
  assert.equal(calls.installs.length, 0);
  assert.equal(updater.lastResult().status, "current");
});

test("with the setting off nothing is fetched, but a check the user asks for still runs", async () => {
  const { updater, calls } = host({ autoUpdate: false });
  assert.equal((await updater.run()).status, "off");
  assert.equal(calls.requests.length, 0);
  assert.equal((await updater.run({ reason: "user", force: true })).status, "installed");
});

test("a plugin in the middle of work defers the install to the next timer", async () => {
  const { updater, calls } = host({ busy: true });
  const result = await updater.run();
  assert.equal(result.status, "deferred");
  assert.equal(calls.installs.length, 0);
  assert.equal((await updater.run({ force: true })).status, "installed", "a user's own request is not deferred");
});

test("a failed fetch is reported, never thrown", async () => {
  const store = new Map();
  const updater = Updater.create({
    id: ID, version: "0.51.11", updateURL: "https://example.org/feed.json",
    request: async () => { throw new Error("HTTP 404"); }, install: async () => {},
    prefs: { get: k => store.get(k), set: (k, v) => store.set(k, v) }
  });
  const result = await updater.run();
  assert.equal(result.status, "error");
  assert.match(result.message, /404/);
  assert.equal(updater.lastResult().message, "HTTP 404");
});

test("start waits, checks, then re-arms daily; a recent check is not repeated at launch", async () => {
  const { updater, store, calls, timers } = host();
  updater.start({ delayMs: 1000, intervalMs: 5000, minGapMs: 3600_000 });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  store.set("updateLastCheck", "2023-11-14T22:00:00.000Z"); // 13 minutes before "now"
  timers[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.requests.length, 0, "checked less than an hour ago");
  assert.equal(timers.length, 2, "and still re-armed");
  assert.equal(timers[1].ms, 5000);
  store.delete("updateLastCheck");
  timers[1].fn();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.requests.length, 1);
  updater.stop();
  assert.equal(updater.state.timer, null);
});

test("ZotPoP ships the same updater, copied by its build", () => {
  const twin = path.join(here, "..", "..", "content", "updater.js");
  if (!existsSync(twin)) return;
  assert.equal(readFileSync(twin, "utf8"), readFileSync(path.join(here, "..", "src", "updater.js"), "utf8"));
});
