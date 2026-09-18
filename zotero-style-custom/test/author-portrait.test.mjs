import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const portrait = require("../src/author-portrait.js");

const page = body => `<html><head><title>Jane Q. Roe — Roe Lab</title></head><body>${body}</body></html>`;
const at = "https://lab.example.edu/people/jane";

test("a page that declares its own Person.image is believed", () => {
  const found = portrait.choose(page(`
    <script type="application/ld+json">
    {"@type":"Person","name":"Jane Q. Roe","image":{"url":"/img/jane.jpg"}}
    </script>
    <img src="/img/other.jpg" alt="Jane Q. Roe" width="400" height="400">`), at, "Jane Q. Roe");
  assert.equal(found.source, "json-ld Person.image");
  assert.equal(found.url, "https://lab.example.edu/img/jane.jpg");
});

test("a logo, a banner and a favicon are never the person", () => {
  for (const markup of [
    `<img src="/logo.png" alt="Jane Q. Roe lab logo" width="400" height="400">`,
    `<img src="/hero.jpg" alt="Jane Q. Roe" width="1600" height="300">`,
    `<img src="/icon.png" alt="Jane Q. Roe" width="32" height="32">`
  ]) {
    assert.equal(portrait.choose(page(markup), at, "Jane Q. Roe"), null, markup);
  }
});

test("two equally good candidates are refused rather than guessed", () => {
  // A wrong face attributed to a person is worse than showing none, so a photo
  // that only just beats another is not an answer.
  const found = portrait.choose(page(`
    <h1>Jane Q. Roe</h1>
    <img src="/a.jpg" alt="Jane Q. Roe" width="400" height="400">
    <img src="/b.jpg" alt="Jane Q. Roe" width="400" height="400">`), at, "Jane Q. Roe");
  assert.equal(found, null);
});

test("a colleague's headshot on the same page is not taken for the author", () => {
  const found = portrait.choose(page(`
    <h1>Roe Lab</h1>
    <img src="/people/sam.jpg" alt="Sam Okafor" width="400" height="400">`), at, "Jane Q. Roe");
  assert.equal(found, null);
});

test("an image the page calls a portrait outranks a bare name match", () => {
  const found = portrait.choose(page(`
    <img src="/x.jpg" alt="Jane Q. Roe" width="400" height="400">
    <img src="/portrait/jane-roe.jpg" alt="Jane Q. Roe headshot" width="400" height="400">`), at, "Jane Q. Roe");
  assert.equal(found.url, "https://lab.example.edu/portrait/jane-roe.jpg");
});

test("the plugin can never be talked into fetching something off this machine", () => {
  for (const bad of ["http://localhost/a.jpg", "http://127.0.0.1/a.jpg", "http://192.168.1.4/a.jpg",
                     "http://10.0.0.2/a.jpg", "http://172.16.3.1/a.jpg", "file:///etc/passwd",
                     "data:image/png;base64,AAA"]) {
    assert.equal(portrait.absolute(at, bad), "", bad);
  }
  assert.equal(portrait.absolute(at, "/img/ok.jpg"), "https://lab.example.edu/img/ok.jpg");
});

test("ORCID is where a researcher's own page comes from, and only a real ORCID", () => {
  assert.equal(portrait.orcidURL("https://orcid.org/0000-0002-1825-0097"),
    "https://pub.orcid.org/v3.0/0000-0002-1825-0097/researcher-urls");
  assert.equal(portrait.orcidURL("0000-0002-1694-233X"),
    "https://pub.orcid.org/v3.0/0000-0002-1694-233X/researcher-urls");
  assert.equal(portrait.orcidURL("not an orcid"), null);
  assert.equal(portrait.orcidURL(""), null);
});

test("a lab homepage is tried before a social profile", () => {
  const urls = portrait.readResearcherURLs({"researcher-url": [
    {"url-name": "Twitter", url: {value: "https://twitter.com/jroe"}},
    {"url-name": "Lab website", url: {value: "https://lab.example.edu/"}},
    {"url-name": "Department", url: {value: "https://bio.example.edu/roe"}}
  ]});
  assert.deepEqual(urls, ["https://lab.example.edu/", "https://bio.example.edu/roe", "https://twitter.com/jroe"]);
  assert.deepEqual(portrait.readResearcherURLs(null), []);
  assert.deepEqual(portrait.readResearcherURLs({"researcher-url": [{url: {value: "javascript:alert(1)"}}]}), []);
});

test("a cached answer is reused for two months, then asked again", () => {
  const now = Date.parse("2026-09-18T00:00:00Z");
  assert.equal(portrait.stale("2026-09-01T00:00:00Z", now), false);
  assert.equal(portrait.stale("2026-06-01T00:00:00Z", now), true);
  assert.equal(portrait.stale("", now), true, "never checked is not the same as checked and empty");
});

const work = (id, people, over = {}) => ({id, title: id + " paper", year: 2025, people, ...over});
const person = (id, name, institution = "") => ({id, name, institution, position: "middle"});

test("a co-author network is the people actually on the papers, ranked by how often", () => {
  const works = [
    work("W1", [person("A1", "Jane Roe"), person("A2", "Sam Okafor", "MIT"), person("A3", "Lee Park")]),
    work("W2", [person("A1", "Jane Roe"), person("A2", "Sam Okafor")], {year: 2026}),
    work("W3", [person("A1", "Jane Roe"), person("A4", "Kim Nguyen")]),
    // A paper the author is not on contributes nothing, however tempting.
    work("W4", [person("A2", "Sam Okafor"), person("A9", "Someone Else")])
  ];
  const net = portrait.coauthors(works, "https://openalex.org/A1");
  assert.deepEqual(net.map(row => [row.name, row.papers]),
    [["Sam Okafor", 2], ["Kim Nguyen", 1], ["Lee Park", 1]]);
  assert.equal(net[0].institution, "MIT", "an institution seen on any shared paper is kept");
  assert.equal(net[0].last, 2026);
  assert.ok(net.every(row => row.id !== "A1"), "the author is not their own co-author");
});

test("an empty or unknown author gives an empty network, not a crash", () => {
  assert.deepEqual(portrait.coauthors([], "A1"), []);
  assert.deepEqual(portrait.coauthors(null, "A1"), []);
  assert.deepEqual(portrait.coauthors([work("W1", [person("A2", "Sam")])], "A1"), []);
});
