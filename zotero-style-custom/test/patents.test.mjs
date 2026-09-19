import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const P = require("../src/patents.js");

test("the search asks the USPTO portal for both names on the inventor, newest grant first", () => {
  const url = P.searchURL("Jennifer A. Doudna");
  assert.match(url, /^https:\/\/api\.uspto\.gov\/api\/v1\/patent\/applications\/search\?q=/);
  assert.equal(decodeURIComponent(url).includes('inventorNameText:("Doudna" AND "Jennifer")'), true);
  assert.match(decodeURIComponent(url), /sort=applicationMetaData\.grantDate desc/);
  assert.equal(P.searchURL(""), null);
  assert.deepEqual(P.headers("abc"), {"X-Api-Key": "abc", Accept: "application/json"});
  assert.deepEqual(P.splitName("Doudna"), {first: "", last: "Doudna", initial: ""});
});

test("patents are read from the portal's shape and from PatentsView's, and namesakes are told apart", () => {
  const portal = {patentFileWrapperDataBag: [{applicationNumberText: "18123456", applicationMetaData: {
    patentNumber: "11234567", inventionTitle: "RNA-guided editing", grantDate: "2026-03-10T00:00:00", filingDate: "2024-01-05",
    inventorBag: [{inventorNameText: "DOUDNA; JENNIFER A."}, {firstName: "Martin", lastName: "Jinek"}],
    applicantBag: [{applicantNameText: "The Regents of the University of California"}], applicationStatusDescriptionText: "Patented Case"}},
    {applicationNumberText: "18999999", applicationMetaData: {inventionTitle: "Pending thing", inventorBag: [{inventorNameText: "DOUDNA CATE; JAMES H."}]}}]};
  const [granted, pending] = P.readPatents(portal);
  assert.deepEqual({id: granted.id, title: granted.title, granted: granted.granted, inventors: granted.inventors, applicants: granted.applicants, link: granted.link, status: granted.status},
    {id: "US11234567", title: "RNA-guided editing", granted: "2026-03-10", inventors: ["DOUDNA; JENNIFER A.", "Martin Jinek"], applicants: ["The Regents of the University of California"],
      link: "https://patents.google.com/patent/US11234567", status: "Patented Case"});
  assert.deepEqual({id: pending.id, link: pending.link, granted: pending.granted}, {id: "APP18999999", link: "https://patentcenter.uspto.gov/applications/18999999", granted: ""});
  assert.equal(P.matchesInventor(granted, "Jennifer A. Doudna"), true);
  assert.equal(P.matchesInventor(pending, "Jennifer A. Doudna"), false, "James H. Doudna Cate is someone else");
  assert.equal(P.matchesInventor(granted, "Martin Jinek"), true);
  assert.equal(P.matchesInventor(granted, "M. Doudna"), false, "the initial has to agree");
  const legacy = P.readPatents({patents: [{patent_id: "9999999", patent_title: "Old shape", patent_date: "2020-01-01",
    inventors: [{inventor_name_first: "Jay", inventor_name_last: "Keasling"}], assignees: [{assignee_organization: "LBNL"}]}]});
  assert.deepEqual({id: legacy[0].id, inventors: legacy[0].inventors, applicants: legacy[0].applicants}, {id: "US9999999", inventors: ["Jay Keasling"], applicants: ["LBNL"]});
  assert.deepEqual(P.readPatents({message: "Unauthorized"}), []);
  assert.deepEqual(P.readPatents(null), []);
});
