import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const model = require("../src/model.js");
const { STATUS_PREFIX: S, RATING_PREFIX: R, readState, updateTags, visibleTags, formatRating } = model;
const tag = (name, type = 0) => ({ tag: name, type });

test("loads as both a CommonJS module and a Zotero global without Node APIs", () => {
  assert.equal(globalThis.ZoteroFocusModel, model);
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../src/model.js", import.meta.url), "utf8"), context);
  assert.equal(context.ZoteroFocusModel.STATUS_PREFIX, S);
  assert.equal(context.ZoteroFocusModel.RATING_PREFIX, R);
  assert.equal(context.ZoteroFocusModel.readState([]).status, "unread");
  assert.equal(context.ZoteroFocusModel.formatRating(3), "★★★");
  const crossRealmTags = context.ZoteroFocusModel.updateTags([], { status: "reading", rating: 2 });
  assert.deepEqual(readState(crossRealmTags), { status: "reading", rating: 2 });
  assert.ok(Object.isFrozen(model));
});

test("transitions between all statuses and ratings and represents defaults as absence", () => {
  assert.deepEqual(readState([]), { status: "unread", rating: 0 });
  for (const from of ["unread", "reading", "done"]) {
    for (const to of ["unread", "reading", "done"]) {
      const next = updateTags([tag(S + from), tag(R + "4")], { status: to });
      assert.deepEqual(readState(next), { status: to, rating: 4 });
      assert.equal(next.some(entry => entry.tag === S + "unread"), false);
    }
  }
  for (let from = 0; from <= 5; from++) {
    for (let to = 0; to <= 5; to++) {
      const next = updateTags([tag(S + "reading"), tag(R + from)], { rating: to });
      assert.deepEqual(readState(next), { status: "reading", rating: to });
      assert.equal(next.some(entry => entry.tag === R + "0"), false);
    }
  }
  assert.deepEqual(updateTags([tag(S + "done"), tag(R + "5")], { status: "unread", rating: 0 }), []);
});

test("preserves unrelated tags, unknown future metadata, tag type, duplicates and extra data", () => {
  const preserved = [
    tag("Methods", 1),
    tag("Methods", 0),
    tag(S + "paused", 1),
    tag(S + "Done", 1),
    tag(R + "6", 1),
    tag(R + "03", 1),
    tag(R + "3.0", 1),
    tag(R + "-1", 1),
    { tag: "한국어 📖", type: 1, color: "red" },
    { tag: "type omitted" },
    tag(""),
  ];
  const original = [...preserved, tag(S + "done", 1), tag(R + "5", 1)];
  const snapshot = structuredClone(original);
  original.forEach(Object.freeze);
  Object.freeze(original);
  const updated = updateTags(original, Object.freeze({ status: "reading", rating: 2 }));
  assert.deepEqual(updated, [...preserved, tag(S + "reading"), tag(R + "2")]);
  assert.deepEqual(original, snapshot);
  assert.notEqual(updated[0], original[0]);
  assert.deepEqual(updateTags(updated, { status: "reading", rating: 2 }), updated);
  updated[0].tag = "changed copy";
  assert.equal(original[0].tag, "Methods");
});

test("resolves conflicts independently of order and normalizes only the patched field", () => {
  const conflicts = [
    tag(S + "unread"), tag(S + "done", 1), tag(S + "reading"), tag(S + "done"),
    tag(R + "2"), tag(R + "5", 1), tag(R + "0"), tag(R + "5"),
  ];
  assert.deepEqual(readState(conflicts), { status: "done", rating: 5 });
  assert.deepEqual(readState([...conflicts].reverse()), { status: "done", rating: 5 });
  assert.deepEqual(updateTags(conflicts, { status: "reading" }), [
    tag(R + "2"), tag(R + "5", 1), tag(R + "0"), tag(R + "5"), tag(S + "reading"),
  ]);
  assert.deepEqual(updateTags(conflicts, { rating: 1 }), [
    tag(S + "unread"), tag(S + "done", 1), tag(S + "reading"), tag(S + "done"), tag(R + "1"),
  ]);
  assert.deepEqual(updateTags(conflicts, {}), conflicts);
});

test("ignores malformed reserved values when reading without deleting them", () => {
  const tags = [
    tag(S + "constructor"), tag(S + "toString"), tag(S + "__proto__"),
    tag(S + "done "), tag(S + "READING"), tag(R + "01"), tag(R + "5\n"),
    tag(R + "5 "), tag(R + "NaN"), tag(R + "Infinity"), tag(R + ""),
  ];
  assert.deepEqual(readState(tags), { status: "unread", rating: 0 });
  assert.deepEqual(updateTags(tags, { status: "unread", rating: 0 }), tags);
});

test("rejects malformed tag collections instead of silently losing library data", () => {
  for (const tags of [undefined, null, "topic", {}, ["topic"], [null], [1], [{}], [{ tag: 4 }], [[]], new Array(1)]) {
    assert.throws(() => readState(tags), TypeError);
    assert.throws(() => updateTags(tags, { rating: 1 }), TypeError);
    assert.throws(() => visibleTags(tags), TypeError);
  }
});

test("rejects invalid patches atomically, including unknown keys and accessor fields", () => {
  const original = [tag("Keep", 1), tag(S + "done"), tag(R + "5")];
  const snapshot = structuredClone(original);
  const invalid = [
    null, undefined, [], 1, "done", new Date(),
    { status: "finished" }, { status: "constructor" }, { status: undefined },
    { status: null }, { status: 1 }, { rating: -1 }, { rating: 6 },
    { rating: 1.5 }, { rating: "3" }, { rating: NaN }, { rating: Infinity },
    { rating: undefined }, { rating: null }, { rating: true },
    { ratings: 2 }, { status: "reading", rating: 9 },
    { status: "done", typo: true }, { [Symbol("status")]: "done" },
    { get status() { throw new Error("must not execute accessor"); } },
  ];
  for (const patch of invalid) {
    assert.throws(() => updateTags(original, patch), error => error instanceof TypeError || error instanceof RangeError);
    assert.deepEqual(original, snapshot);
  }
  const nullPrototype = Object.assign(Object.create(null), { status: "reading", rating: 2 });
  assert.deepEqual(readState(updateTags(original, nullPrototype)), { status: "reading", rating: 2 });
});

test("tag display hides the complete reserved namespace and supports literal prefix filtering", () => {
  const tags = [
    tag("topic:AI"), tag("topic:한국어"), tag("Other"), tag("Topic:Case"),
    tag(S + "done"), tag(S + "future"), tag(R + "3"), tag(R + "future"),
    tag("<script>alert('text only')</script>"), tag("topic:"),
  ];
  assert.deepEqual(visibleTags(tags), [
    "topic:AI", "topic:한국어", "Other", "Topic:Case", "<script>alert('text only')</script>", "topic:",
  ]);
  assert.deepEqual(visibleTags(tags, "topic:"), ["AI", "한국어", ""]);
  assert.deepEqual(visibleTags(tags, S), []);
  assert.deepEqual(visibleTags(tags, "missing:"), []);
  for (const prefix of [null, 1, {}, []]) assert.throws(() => visibleTags(tags, prefix), TypeError);
});

test("formats unrated as blank and one through five as filled stars", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(formatRating), ["", "★", "★★", "★★★", "★★★★", "★★★★★"]);
  for (const value of [-1, 6, 1.2, "3", undefined, null, NaN, Infinity, true]) {
    assert.throws(() => formatRating(value), RangeError);
  }
});
