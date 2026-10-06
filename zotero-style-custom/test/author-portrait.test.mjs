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

test("Wikidata is searched by ORCID and read back to a freely licensed photo and a website", () => {
  const url = portrait.wikidataSearchURL(["https://orcid.org/0000-0001-9161-999x", "0000-0002-1234-5678", "not an orcid"]);
  assert.match(decodeURIComponent(url), /haswbstatement:P496=0000-0001-9161-999X\|P496=0000-0002-1234-5678$/);
  assert.deepEqual(portrait.readWikidataSearch({query: {search: [{title: "Q42"}, {title: "Property:P1"}]}}), ["Q42"]);
  const snak = value => ({mainsnak: {datavalue: {value}}, rank: "normal"});
  const found = portrait.readWikidataEntities({entities: {
    Q1: {id: "Q1", claims: {P496: [snak("0000-0001-9161-999X")], P18: [snak("Old photo.jpg"), {...snak("Jane Roe 2024.jpg"), rank: "preferred"}], P856: [snak("https://roe-lab.example.org/")]}},
    Q2: {id: "Q2", claims: {P496: [snak("0000-0002-1234-5678")]}},
    Q3: {id: "Q3", claims: {P18: [snak("Nobody.jpg")]}}
  }});
  // The preferred image, not merely the first; nothing without an ORCID.
  assert.deepEqual(found.get("0000-0001-9161-999X"), {qid: "Q1", image: "Jane Roe 2024.jpg", site: "https://roe-lab.example.org/", scholar: ""});
  assert.deepEqual(found.get("0000-0002-1234-5678"), {qid: "Q2", image: "", site: "", scholar: ""});
  assert.equal(found.size, 2);
  assert.equal(portrait.commonsThumb("Jane Roe 2024.jpg", 160), "https://commons.wikimedia.org/wiki/Special:FilePath/Jane_Roe_2024.jpg?width=160");
  assert.equal(portrait.commonsPage("Jane Roe 2024.jpg"), "https://commons.wikimedia.org/wiki/File:Jane_Roe_2024.jpg");
});

test("an image address written with &amp; is fetched with an ampersand", () => {
  const found = portrait.choose(page(`
    <h1>Jane Q. Roe</h1>
    <img src="https://photos.example.org/view?id=7&amp;size=large" alt="Jane Q. Roe portrait" width="300" height="300">`), at, "Jane Q. Roe");
  assert.equal(found.url, "https://photos.example.org/view?id=7&size=large");
});

test("a Wikidata item with several ORCIDs answers to each of them", () => {
  const snak = value => ({mainsnak: {datavalue: {value}}, rank: "normal"});
  const found = portrait.readWikidataEntities({entities: {Q3298995: {id: "Q3298995", claims: {
    P496: [snak("0000-0001-6232-9969"), snak("0000-0002-0775-2913"), snak("0000-0003-3535-2076")],
    P18: [{...snak("George Church in 2023 06.jpg"), rank: "preferred"}]}}}});
  for (const orcid of ["0000-0001-6232-9969", "0000-0002-0775-2913", "0000-0003-3535-2076"])
    assert.equal(found.get(orcid)?.image, "George Church in 2023 06.jpg", orcid);
});

test("a Google Scholar ID from Wikidata becomes that profile's photo, and only a JPEG counts", () => {
  assert.equal(portrait.scholarID("lcNi1RUAAAAJ"), "lcNi1RUAAAAJ");
  assert.equal(portrait.scholarID("../evil?x=1"), "", "anything but a Scholar ID is dropped");
  assert.equal(portrait.scholarPhoto("lcNi1RUAAAAJ"), "https://scholar.googleusercontent.com/citations?view_op=view_photo&user=lcNi1RUAAAAJ&citpid=2");
  assert.equal(portrait.scholarIsPhoto("image/jpeg"), true);
  assert.equal(portrait.scholarIsPhoto("image/png"), false, "the grey placeholder is a PNG");
  assert.equal(portrait.scholarIsPhoto(null), false);
});

// Item 11: every followed author has a relationship graph of their own.
// Names are compared as letters only, so test names are spelled with letters, not digits.
const nm = i => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26) % 26) + String.fromCharCode(97 + Math.floor(i / 676));
const ego = (over = {}) => portrait.egoGraph({
  me: {id: "A1", name: "Jennifer A. Doudna"},
  works: [
    {id: "W1", doi: "https://doi.org/10.1/w1", title: "One", year: 2024, people: [{id: "A1", name: "Jennifer A. Doudna"}, {id: "A2", name: "Sam Sternberg"}, {id: "A3", name: "Ruth Lee"}]},
    {id: "W2", doi: "10.1/w2", title: "Two", year: 2023, people: [{id: "A1", name: "Jennifer A. Doudna"}, {id: "A2", name: "Sam Sternberg"}]},
    {id: "W9", title: "Not hers", people: [{id: "A8", name: "Someone Else"}, {id: "A2", name: "Sam Sternberg"}]}
  ],
  news: [{id: "W3", doi: "10.1/w3", title: "Three", people: ["Jennifer A. Doudna", "Ruth Lee", "Kim Park"]},
    {id: "W1b", doi: "10.1/W1", title: "One again", people: ["Jennifer A. Doudna", "Sam Sternberg"]}],
  items: [{id: "11", doi: "", authors: "Jennifer A. Doudna; Ruth Lee; Alice Kim"}, {id: "12", authors: "Other Person; Alice Kim"}],
  followed: [{id: "A3", name: "Ruth Lee"}],
  ...over
});

test("the centre is the followed author and each co-author's weight is the number of shared papers, counted once per paper", () => {
  const g = ego();
  assert.equal(g.centre.id, "A1");
  assert.equal(g.centre.name, "Jennifer A. Doudna");
  const by = Object.fromEntries(g.nodes.map(n => [n.name, n]));
  assert.equal(by["Sam Sternberg"].weight, 2, "W1 held twice (tracked work and stored news, one DOI) is one paper, plus W2");
  assert.equal(by["Ruth Lee"].weight, 3, "W1, the stored news W3 and the library item");
  assert.equal(by["Kim Park"].weight, 1);
  assert.equal(by["Alice Kim"].weight, 1);
  assert.ok(!by["Jennifer A. Doudna"] && !by["Someone Else"] && !by["Other Person"], "not the centre, and not people from papers she is not on");
  assert.deepEqual(g.nodes.map(n => n.name).slice(0, 2), ["Ruth Lee", "Sam Sternberg"], "heaviest first");
  assert.ok(g.edges.every(e => e.source === "A1" && e.weight === by[g.nodes.find(n => n.id === e.target).name].weight));
});

test("a followed co-author is marked with who they are, and every node has a readable label", () => {
  const g = ego({fullLabels: 2});
  const ruth = g.nodes.find(n => n.name === "Ruth Lee");
  assert.deepEqual(ruth.followed, {id: "A3", name: "Ruth Lee"});
  assert.equal(ruth.label, "Ruth Lee");
  const full = g.nodes.filter(n => n.label === n.name).map(n => n.name);
  assert.deepEqual(full.sort(), ["Ruth Lee", "Sam Sternberg"], "the top two by weight carry their full name");
  const rest = g.nodes.filter(n => n.label !== n.name);
  assert.ok(rest.length >= 2);
  for (const n of rest) { assert.match(n.label, /^[A-Z]{1,2}$/, "initials for the rest"); assert.ok(n.tooltip.includes(n.name), "with the name in the tooltip"); }
  for (const n of g.nodes) assert.ok(n.label && n.tooltip, "no node without a name");
  const followedLast = ego({fullLabels: 1, followed: [{id: "A9", name: "Alice Kim"}]}).nodes.find(n => n.name === "Alice Kim");
  assert.equal(followedLast.label, "Alice Kim", "a followed co-author always shows their full name");
});

test("the visible co-authors are capped by weight, with the rest counted for Show all", () => {
  const many = Array.from({length: 35}, (_, i) => ({id: "W" + (100 + i), doi: "10.9/" + i, title: "p" + i, people: [{id: "A1", name: "Jennifer A. Doudna"}, {id: "B" + i, name: "Person " + nm(i) + "x"}, ...(i < 5 ? [{id: "C", name: "Heavy Hitter"}] : [])]}));
  const g = portrait.egoGraph({me: {id: "A1", name: "Jennifer A. Doudna"}, works: many, limit: 20});
  assert.equal(g.total, 36);
  assert.equal(g.nodes.length, 20);
  assert.equal(g.hidden, 16);
  assert.equal(g.nodes[0].name, "Heavy Hitter", "the heaviest survive the cap");
  const all = portrait.egoGraph({me: {id: "A1", name: "Jennifer A. Doudna"}, works: many, limit: Infinity});
  assert.equal(all.nodes.length, 36);
  assert.equal(all.hidden, 0);
});

test("links between co-authors come from papers they share, only among the people drawn", () => {
  const g = ego();
  const link = g.links.find(l => [l.source, l.target].sort().join() === ["A2", "A3"].join());
  assert.equal(link.weight, 1, "Sam and Ruth are both on W1");
  const shown = new Set(g.nodes.map(n => n.id));
  assert.ok(g.links.every(l => shown.has(l.source) && shown.has(l.target)));
});

test("a consortium paper is not a hundred collaborations, and an author with nothing in hand has no neighbours", () => {
  const crowd = {id: "WC", doi: "10.1/c", people: [{id: "A1", name: "Jennifer A. Doudna"}, ...Array.from({length: 40}, (_, i) => ({id: "X" + i, name: "Member " + nm(i) + "z"}))]};
  assert.equal(portrait.egoGraph({me: {id: "A1", name: "Jennifer A. Doudna"}, works: [crowd]}).nodes.length, 0);
  const none = portrait.egoGraph({me: {id: "A1", name: "Jennifer A. Doudna"}});
  assert.deepEqual([none.nodes.length, none.total, none.hidden], [0, 0, 0]);
  assert.equal(none.centre.name, "Jennifer A. Doudna");
});

test("the layout puts the author in the middle and every co-author inside the frame without touching another", () => {
  const g = ego();
  const laid = portrait.egoLayout(g, {width: 760, height: 360});
  assert.equal(Math.round(laid.centre.x), 380);
  assert.equal(Math.round(laid.centre.y), 180);
  const all = [laid.centre, ...laid.nodes];
  for (const n of all) assert.ok(n.x - n.rad >= 0 && n.x + n.rad <= 760 && n.y - n.rad >= 0 && n.y + n.rad <= 360, n.name + " is inside");
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) >= all[i].rad + all[j].rad, `${all[i].name} and ${all[j].name} do not overlap`);
  const twenty = portrait.egoLayout(portrait.egoGraph({me: {id: "A1", name: "Me Self"}, works: Array.from({length: 20}, (_, i) => ({id: "W" + i, doi: "10/" + i, people: [{id: "A1", name: "Me Self"}, {id: "B" + i, name: "Co " + nm(i) + "y"}]}))}), {width: 760, height: 360});
  const nodes = [twenty.centre, ...twenty.nodes];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) >= nodes[i].rad + nodes[j].rad, "twenty around one author do not overlap");
  for (const n of twenty.nodes) assert.ok(n.rad >= 11, "big enough for two letters at 11px");
});

// Regression review A3: the id is the identity; a name only stands in for a record that has no id.
test("two co-authors of one name with different ids stay two nodes; one id under two spellings stays one", () => {
  const me = {id: "A1", name: "Jennifer Doudna"};
  const g = portrait.egoGraph({me, works: [
    {id: "W1", doi: "10.1/a", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A20", name: "John Smith"}]},
    {id: "W2", doi: "10.1/b", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A21", name: "John Smith"}]},
    {id: "W3", doi: "10.1/c", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A30", name: "Kay Lee"}]},
    {id: "W4", doi: "10.1/d", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A30", name: "Kay A Lee"}]}]});
  const smiths = g.nodes.filter(n => n.name === "John Smith");
  assert.equal(smiths.length, 2, "different ids are different people");
  assert.deepEqual(smiths.map(n => n.weight), [1, 1]);
  assert.deepEqual(smiths.map(n => n.id).sort(), ["A20", "A21"]);
  const lee = g.nodes.filter(n => /Lee/.test(n.name));
  assert.equal(lee.length, 1, "one id is one person whatever the spelling");
  assert.equal(lee[0].weight, 2);
  assert.equal(lee[0].name, "Kay A Lee", "the fuller spelling is shown");
});

test("a namesake of the centre with another id is a co-author, not the centre", () => {
  const g = portrait.egoGraph({me: {id: "A1", name: "John Smith"}, works: [
    {id: "W1", doi: "10.1/a", people: [{id: "A1", name: "John Smith"}, {id: "A9", name: "John Smith"}, {id: "A2", name: "Ann Lee"}]},
    {id: "W2", doi: "10.1/b", people: [{id: "A9", name: "John Smith"}, {id: "A3", name: "Bo Kim"}]}]});
  assert.deepEqual(g.nodes.map(n => n.id).sort(), ["A2", "A9"], "the namesake is drawn; Bo Kim's paper (without A1) is not hers");
  assert.ok(!g.nodes.some(n => n.id === "A3"));
});

test("a record without an id joins the one person of that name; with two candidates it stands alone", () => {
  const me = {id: "A1", name: "Jennifer Doudna"};
  const one = portrait.egoGraph({me, works: [{id: "W1", doi: "10.1/a", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A2", name: "Sam Sternberg"}]}],
    news: [{id: "W2", doi: "10.1/b", people: ["Jennifer Doudna", "Sam Sternberg"]}]});
  assert.equal(one.nodes.length, 1);
  assert.deepEqual([one.nodes[0].id, one.nodes[0].weight], ["A2", 2]);
  const two = portrait.egoGraph({me, works: [
    {id: "W1", doi: "10.1/a", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A20", name: "John Smith"}]},
    {id: "W2", doi: "10.1/b", people: [{id: "A1", name: "Jennifer Doudna"}, {id: "A21", name: "John Smith"}]}],
    news: [{id: "W3", doi: "10.1/c", people: ["Jennifer Doudna", "John Smith"]}]});
  assert.equal(two.nodes.filter(n => n.name === "John Smith").length, 3, "the unattributable name is its own node, not credited to either id");
  assert.equal(two.nodes.find(n => n.id === "A20").weight, 1);
});

// Regression review A8: narrow panels used to overlap (20 co-authors at 320x400 gave 8 pairs, 48 gave 62).
test("the ego layout never overlaps or leaves the frame, at 320, 480 and 760 wide with 20 and 48 co-authors, growing taller when it must", () => {
  for (const width of [320, 480, 760]) for (const count of [1, 5, 20, 48]) {
    const graph = portrait.egoGraph({me: {id: "A1", name: "Me Self"}, limit: Infinity,
      works: Array.from({length: count}, (_, i) => ({id: "W" + i, doi: "10/" + i, people: [{id: "A1", name: "Me Self"}, {id: "B" + i, name: "Co " + nm(i) + "y"}]})),
      followed: [{id: "B0", name: "Co " + nm(0) + "y"}]});
    const laid = portrait.egoLayout(graph, {width, height: 400});
    const label = `${width}x${laid.height} with ${count}`;
    assert.ok(laid.height >= 400, label + ": never shorter than asked");
    assert.equal(laid.nodes.length, count, label + ": every co-author is placed");
    const all = [laid.centre, ...laid.nodes];
    for (const n of all) assert.ok(n.x - n.rad >= -0.5 && n.x + n.rad <= width + 0.5 && n.y - n.rad >= -0.5 && n.y + n.rad <= laid.height + 0.5, `${label}: ${n.name} is inside`);
    let overlaps = 0;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y) < all[i].rad + all[j].rad) overlaps++;
    assert.equal(overlaps, 0, `${label}: ${overlaps} overlapping pairs`);
    for (const n of laid.nodes) assert.ok(n.rad >= 11, "big enough for two letters at 11px");
    assert.equal(Math.round(laid.centre.y), Math.round(laid.height / 2), label + ": the author stays in the middle");
  }
  const roomy = portrait.egoLayout(portrait.egoGraph({me: {id: "A1", name: "Me Self"}, works: [{id: "W", doi: "10/w", people: [{id: "A1", name: "Me Self"}, {id: "B", name: "Co Aay"}]}]}), {width: 760, height: 360});
  assert.equal(roomy.height, 360, "when everything fits, the asked height stands");
});

test("a merged person's second OpenAlex id is the centre, not a co-author of themselves (round 13)", () => {
  const works = [
    {id: "W1", doi: "10/1", people: [{id: "A1", name: "Pat Lee"}, {id: "B1", name: "Co One"}]},
    {id: "W2", doi: "10/2", people: [{id: "A2", name: "P. Lee"}, {id: "B2", name: "Co Two"}]}];
  const g = portrait.egoGraph({me: {id: "A1", ids: ["A1", "A2"], name: "Pat Lee"}, works});
  assert.deepEqual(g.nodes.map(n => n.id).sort(), ["B1", "B2"]);
  const circle = portrait.coauthors(works, ["A1", "A2"]);
  assert.deepEqual(circle.map(c => c.id).sort(), ["B1", "B2"]);
});

test("stored news written before co-author ids were kept is still the followed author's paper when they sign past the sixth name", () => {
  const g = portrait.egoGraph({me: {id: "A1", name: "Jennifer A. Doudna"},
    news: [{id: "W1", doi: "10.1/x", people: ["Peter H. Yoon", "Trevor Docter", "Zeyuan Zhang", "Kenneth J. Loi", "Santiago C. Lopez", "Luis E. Valentin-Alvarado"]},
      {id: "W2", doi: "10.1/y", unclassified: true, people: ["Peter H. Yoon", "Somebody Else"]}]});
  assert.deepEqual(g.nodes.map(n => n.name).sort(), ["Kenneth J. Loi", "Luis E. Valentin-Alvarado", "Peter H. Yoon", "Santiago C. Lopez", "Somebody Else", "Trevor Docter", "Zeyuan Zhang"],
    "news is stored under this author, so it is theirs, unclassified (no places stored yet) included, as the list shows it");
  assert.equal(g.nodes.find(n => n.name === "Peter H. Yoon").weight, 2);
});
