import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const failures = require("../src/failures.js");

const now = new Date("2026-09-18T22:20:00Z");
const budget = Object.assign(new Error(
  "HTTP GET https://api.openalex.org/works?per_page=25&filter=author.id%3AA5024190906&sort=publication_date:desc&select=id,doi,title failed with status code 429"),
  {status: 429});

test("a spent quota says which service, how long, and that nothing was lost", () => {
  const said = failures.describe(budget, {now});
  // The panel used to print that whole URL. It named no service the reader
  // could recognise, gave them nothing to do, and made a rate limit look like
  // a broken plugin.
  assert.doesNotMatch(said, /https?:\/\//);
  assert.doesNotMatch(said, /status code/);
  assert.match(said, /OpenAlex/);
  assert.match(said, /1시간 40분/);
  assert.match(said, /저장/, "the reader needs to know the run so far was kept");
});

test("the reset time is converted into the reader's own clock", () => {
  // "UTC midnight" is arithmetic nobody should do while deciding whether to wait.
  const {hours, rest} = failures.untilReset(new Date("2026-09-18T23:30:00Z"));
  assert.equal(hours, 0);
  assert.equal(rest, 30);
  assert.match(failures.describe(budget, {now: new Date("2026-09-18T23:30:00Z")}), /30분 뒤\(/);
});

test("each failure gets the sentence that fits it", () => {
  const at = (status, url) => Object.assign(new Error("x"), {status, url});
  assert.match(failures.describe(at(403, "https://www.easyscholar.cc/open/x"), {now}), /easyScholar.*API 키/s);
  assert.match(failures.describe(at(404, "https://api.crossref.org/works/10.1/x"), {now}), /Crossref.*기록이 없습니다/s);
  assert.match(failures.describe(at(503, "https://api.openalex.org/works"), {now}), /서버에 일시적인/);
  assert.match(failures.describe(new Error("request timed out"), {now}), /응답이 너무 늦어/);
  assert.match(failures.describe(new Error("The operation was aborted"), {now}), /중지/);
});

test("a message already written for this user is left exactly as it is", () => {
  const mine = "설정에서 본인의 easyScholar API 키를 입력하세요.";
  assert.equal(failures.describe(new Error(mine), {now}), mine);
  assert.equal(failures.describe(new Error("문헌을 하나 선택하세요."), {now}), "문헌을 하나 선택하세요.");
});

test("a service nobody recognises still produces a sentence, not a URL", () => {
  const said = failures.describe(Object.assign(
    new Error("HTTP GET https://example.invalid/a/b failed with status code 418"), {status: 418}), {now});
  assert.doesNotMatch(said, /https?:\/\//);
  assert.match(said, /418/);
});

test("nothing in, nothing out", () => {
  assert.equal(failures.describe(null), "");
  assert.equal(failures.status({}), 0);
  assert.equal(failures.service(""), "");
});
