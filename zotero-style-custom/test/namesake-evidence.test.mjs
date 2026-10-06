/* Whose paper is it? Followed-author news judged only by evidence the user
   trusts: papers held in the library, papers marked 본인 논문, and the
   author's ORCID record. OpenAlex's own profile institutions are weak: a
   merged profile carries a namesake's places (Huimin Zhao's lists a Chengdu
   hospital and the Chinese Academy of Agricultural Sciences).

   The fixture is real (2026-10-06): the 55 stored news of the 17 followed
   authors that had any, OpenAlex's record of each read back by id, the
   library papers of those authors (first/last authorship from the cache plus
   the Zotero creator list; item keys and DOIs removed), and ORCID's batched
   search answer for their 17 ORCIDs. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Runtime = require("../src/runtime.js");
const discover = require("../src/discover.js");
const fx = require("./fixtures/namesake-real.json");

const clone = value => JSON.parse(JSON.stringify(value));
const libraryAll = Object.values(fx.library).flat();

function host({rows = clone(fx.rows), library = libraryAll, orcid = fx.orcidSearch, profiles = true} = {}) {
  const calls = [], orcidCalls = [];
  const h = Object.assign(Object.create(Runtime.prototype), {
    calls, orcidCalls, cache: {watchedAuthors: rows, works: {}}, discoverTools: discover, dirty: false,
    Z: {logError(error) { throw error; }, HTTP: {async request(method, url) {
      orcidCalls.push(url);
      const asked = decodeURIComponent(url).match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/g) || [];
      return {status: 200, response: {...orcid, "expanded-result": (orcid["expanded-result"] || []).filter(r => asked.includes(r["orcid-id"]))}};
    }}},
    discoverOptions: () => ({}), libraryDOIs: () => new Set(),
    async pause() {}, async flush() { this.saved = clone(this.cache.watchedAuthors); },
    libraryPapers: () => library,
    async discoverJSON(url) {
      calls.push(url);
      if (/\/authors\?/.test(url)) {
        if (!profiles) return {results: []};
        const ids = decodeURIComponent(url).match(/ids\.openalex:([A\d|]+)/)[1].split("|");
        return {results: fx.rows.filter(r => ids.includes(r.id)).map(r => ({id: "https://openalex.org/" + r.id, display_name: r.name,
          orcid: fx.orcids[r.id] ? "https://orcid.org/" + fx.orcids[r.id] : null, last_known_institutions: [], affiliations: [], topics: []}))};
      }
      const ids = decodeURIComponent(url).match(/ids\.openalex:([W\d|]+)/)[1].split("|");
      return {results: fx.openalex.filter(w => ids.includes(w.id.split("/").pop()))};
    }
  });
  return h;
}
const rowOf = (h, name) => h.cache.watchedAuthors.find(r => r.name === name);
const own = rows => rows.flatMap(r => (r.news || []).map(w => w.id));
const held = rows => rows.flatMap(r => (r.unverified || []).map(w => w.id));

test("the 55 real stored papers: namesakes held with a reason, the author's own kept, in 3 OpenAlex requests and 1 ORCID request", async () => {
  const h = host();
  const result = await h.classifyStoredNews();
  const rows = h.cache.watchedAuthors;
  const heldIDs = held(rows).sort();
  assert.deepEqual(heldIDs, ["W4413884238", "W4413890391", "W4414459658", "W4414779981", "W7213472828"],
    "four Huimin Zhao namesakes (rice, PCOS, thiazole, birch) and Stockwell's unsigned protocol");
  assert.equal(own(rows).length, 50);
  /* The Hampton University abstract carries Jennifer Doudna's id and is signed
     from Hampton, but two of its four authors -- Erin Doherty and Benjamin
     Adler -- are on Doudna papers the user holds. Two shared coauthors is the
     rule, so it is hers: a visiting student's abstract from her lab. */
  const hampton = rowOf(h, "Jennifer A. Doudna").news.find(w => w.id === "W4411257794");
  assert.equal(hampton.verified, "coauthors");
  for (const row of rows) for (const work of row.unverified || []) assert.ok(work.reason, `${work.id} says why it is held`);
  const zhao = rowOf(h, "Huimin Zhao");
  assert.equal(zhao.unverified.find(w => w.id === "W4414459658").reason, "other-place");
  assert.equal(rowOf(h, "Brent R. Stockwell").unverified[0].reason, "no-place");
  assert.equal(h.calls.length, 3, "two work read-backs (50 + 5) and one profile batch for the missing ORCIDs");
  assert.equal(h.orcidCalls.length, 1, "seventeen ORCIDs in one batched search");
  assert.match(decodeURIComponent(h.orcidCalls[0]), /expanded-search/);
  assert.equal(zhao.orcid, "0000-0002-9069-6739");
  assert.ok(zhao.orcidPlaces.some(pl => pl.name === "California Institute of Technology"));
  assert.ok(zhao.orcidCheckedAt);
  assert.deepEqual({asked: result.asked, settled: result.settled, held: result.held}, {asked: 55, settled: 50, held: 5});
  assert.equal(result.orcidRequests, 1);
});

test("a place listed only on OpenAlex's merged profile does not vouch for a paper", () => {
  const row = clone(fx.rows.find(r => r.name === "Huimin Zhao"));
  // The rice paper, re-signed from the academy the merged profile lists.
  row.news = [{id: "W4414779981", title: "Generating Broad-Spectrum Resistance to ALS-Inhibiting Herbicides in Rice", date: "2025-10-03",
    people: ["Chao Ouyang", "Xiongxia Jin", "Huimin Zhao", "Silan Chen"], places: ["Chinese Academy of Agricultural Sciences"], country: "CN", subfield: "Molecular Biology"}];
  Runtime.reclassifyNewsRow(row, null, {library: fx.library[row.id]});
  assert.deepEqual(row.news, []);
  assert.equal(row.unverified[0].reason, "profile-only");
});

test("trusted evidence: the place followed with, library papers, ORCID; the profile only as weak", () => {
  const row = {...clone(fx.rows.find(r => r.name === "Huimin Zhao")), orcidPlaces: [{name: "California Institute of Technology", ror: ""}]};
  const ev = Runtime.authorEvidence(row, {library: fx.library[row.id]});
  const trusted = ev.places.map(pl => pl.source + ":" + pl.name);
  assert.ok(trusted.includes("followed:University of Illinois Urbana-Champaign"));
  assert.ok(trusted.includes("orcid:California Institute of Technology"));
  assert.ok(ev.places.some(pl => pl.source === "library"), "a held paper's own authorship names a place");
  assert.ok(!ev.places.some(pl => /Chengdu|Agricultural/.test(pl.name)), "nothing from the merged profile is trusted");
  assert.ok(ev.weak.some(pl => /Chengdu/.test(pl.name)), "but it is kept as weak evidence");
  assert.ok(ev.coauthors.has(Runtime.personKey("Zia Fatma")), "coauthors come from the full creator list of held papers");
  assert.ok(!ev.coauthors.has(Runtime.personKey("Huimin Zhao")), "the author is not their own coauthor");
});

test("a library paper matched by name counts only when it shares a coauthor with one matched by id", () => {
  const row = {id: "A1", name: "Huimin Zhao", institution: "Somewhere"};
  const library = [
    {people: [{id: "A1", name: "Huimin Zhao", institution: "University of Illinois Urbana-Champaign"}], creators: ["Zia Fatma", "Huimin Zhao"]},
    {people: [], creators: ["Zia Fatma", "Behnam Enghiad", "Huimin Zhao"]},
    {people: [], creators: ["Hui-Min Zhao", "Wang Wei", "Li Na"]}
  ];
  const ev = Runtime.authorEvidence(row, {library});
  assert.ok(ev.coauthors.has(Runtime.personKey("Behnam Enghiad")), "the name match sharing Zia Fatma joins");
  assert.ok(!ev.coauthors.has(Runtime.personKey("Wang Wei")), "an unrelated name match does not");
});

test("own when: at a trusted place; or two shared coauthors; or same field with one shared coauthor", () => {
  const ctx = Runtime.newsContext({id: "A1", name: "Ada Lovelace", institution: "University of Zurich"}, null, {library: [
    {people: [{id: "A1", name: "Ada Lovelace", institution: "University of Zurich"}], creators: ["Ada Lovelace", "Bo Chen", "Cy Park"], subfield: "Molecular Biology"}]});
  const judge = item => Runtime.newsVerdict({id: "W", people: [], subfield: "", ...item}, ctx);
  assert.equal(judge({places: [{name: "University of Zurich", ror: ""}]}).basis, "place");
  assert.equal(judge({places: [{name: "Elsewhere", ror: ""}], people: ["Ada Lovelace", "Bo Chen", "Cy Park"]}).basis, "coauthors");
  assert.equal(judge({places: [], people: ["Bo Chen"], subfield: "Molecular Biology"}).basis, "field");
  const one = judge({places: [], people: ["Bo Chen"], subfield: "Plant Science"});
  assert.deepEqual([one.verdict, one.reason], ["unverified", "no-place"]);
  assert.equal(judge({places: [{name: "Elsewhere", ror: ""}], people: ["Bo E. Chen", "Cy Park"]}).basis, "coauthors", "a middle initial is the same coauthor");
});

test("ORCID is asked once per fifty people and kept for two months", async () => {
  const h = host();
  await h.classifyStoredNews();
  assert.equal(h.orcidCalls.length, 1);
  const zhao = rowOf(h, "Huimin Zhao");
  zhao.news.push({id: "W4415928499x", title: "x", unclassified: true});
  h.calls.length = 0;
  await h.classifyStoredNews();
  assert.equal(h.orcidCalls.length, 1, "nothing asked again within two months");
  assert.equal(h.calls.filter(u => /\/authors\?/.test(u)).length, 0, "the ORCID is remembered too");
});

test("본인 논문 teaches a trusted place: the next paper from there is the author's own", async () => {
  const h = host();
  await h.classifyStoredNews();
  const zhao = rowOf(h, "Huimin Zhao");
  await h.resolveNamesake(zhao.id, "W4414459658", true);
  assert.ok(zhao.placesConfirmed.some(pl => pl.name === "Zhejiang University"));
  zhao.news.push({id: "Wnext", title: "Next paper from the same hospital", places: ["Zhejiang University"], people: ["Someone New"], date: "2025-11-01"});
  Runtime.reclassifyNewsRow(zhao, null, {library: fx.library[zhao.id]});
  assert.equal(zhao.news.find(w => w.id === "Wnext").verified, "place");
});

test("a held paper is released when trusted evidence later covers it", () => {
  const row = {id: "A1", name: "Ada Lovelace", institution: "Somewhere", news: [],
    unverified: [{id: "W1", title: "Held", places: ["Elsewhere"], people: ["Ada Lovelace", "Bo Chen", "Cy Park"], reason: "other-place"}]};
  Runtime.reclassifyNewsRow(row, null, {release: true, library: [{people: [{id: "A1", name: "Ada Lovelace"}], creators: ["Ada Lovelace", "Bo Chen", "Cy Park"]}]});
  assert.deepEqual(row.unverified, []);
  assert.equal(row.news[0].verified, "coauthors");
});

test("the sweep asks for each work's primary topic, so the field rule has something to compare", () => {
  const url = decodeURIComponent(discover.watchedWorksURL(["A1"], {since: "2026-01-01"}));
  assert.match(url, /select=[^&]*primary_topic/);
  const [shaped] = discover.readWorks({results: [fx.openalex.find(w => w.id.endsWith("W4414459658"))]});
  assert.equal(shaped.subfieldName, "Reproductive Medicine");
  assert.equal(shaped.topic, "Ovarian function and disorders");
});
