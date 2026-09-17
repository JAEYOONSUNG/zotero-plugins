import test from "node:test";
import assert from "node:assert/strict";
import legacy from "../src/legacy-reading.js";

const note = (key, page, data) =>
  `<div class="zotero-note znv1">${key}\n{"readingTime":{"page":${page},"data":${JSON.stringify(data)}}}</div>`;

test("a reading-time note yields the paper it belongs to and the time per page", () => {
  const parsed = legacy.parseNote(note("7PBEML7V", 16, {0: 870, 1: 1620, 13: 110}));
  assert.equal(parsed.key, "7PBEML7V");
  assert.equal(parsed.totalPages, 16);
  assert.deepEqual(parsed.pageTimes, {0: 870, 1: 1620, 13: 110});
  assert.equal(parsed.seconds, 2600, "the total is what the reading time column shows");
});

test("a note a person wrote is never mistaken for bookkeeping", () => {
  for (const body of [
    '<div class="zotero-note znv1"><div data-schema-version="9"><p>for transposon library</p></div></div>',
    '<div class="zotero-note znv1">Comment: 40 pages, 13 figures, 4 tables</div>',
    '<div class="zotero-note znv1"></div>',
    '<div class="zotero-note znv1"><p>ABCD1234 is the plasmid we used</p></div>'
  ]) assert.equal(legacy.parseNote(body), null, body.slice(0, 50));
  assert.equal(legacy.isBookkeeping(note("ABCD1234", 2, {0: 10})), true);
});

test("escaped HTML entities in the stored JSON are still read", () => {
  const escaped = '<div class="zotero-note znv1">K6NGGNAW\n{&quot;readingTime&quot;:{&quot;page&quot;:12,&quot;data&quot;:{&quot;0&quot;:10}}}</div>';
  assert.equal(legacy.parseNote(escaped).seconds, 10);
});

test("nonsense in the payload is dropped rather than trusted", () => {
  // Negative, non-numeric and absurd page indexes are other plugins' bugs, not data.
  const parsed = legacy.parseNote(note("ABCD1234", 5, {0: 30, "-1": 40, x: 10, 999999: 20, 2: "bad", 3: -5}));
  assert.deepEqual(parsed.pageTimes, {0: 30});
  assert.equal(parsed.seconds, 30);
  // A note whose times all total zero carries nothing worth importing.
  assert.equal(legacy.parseNote(note("ABCD1234", 5, {0: 0})), null);
  // A missing or silly page count is simply unknown, not a reason to drop the times.
  assert.equal(legacy.parseNote(note("ABCD1234", 0, {0: 30})).totalPages, null);
});

test("malformed input returns nothing instead of throwing", () => {
  for (const body of [null, undefined, "", "{", '<div>{"readingTime":</div>',
    '<div class="zotero-note znv1">NOKEYHERE{"readingTime":{"data":{}}}</div>'])
    assert.doesNotThrow(() => legacy.parseNote(body));
  assert.equal(legacy.parseNote('<div>{"readingTime":{"page":1,"data":{"0":5}}}</div>'), null,
    "without a key there is no paper to attach the time to");
});
