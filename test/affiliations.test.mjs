import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import A from "../content/affiliations.js";

const person = (name, extra = {}) => ({ name, position: "middle", corresponding: false, institution: "", institutionId: null, country: null, institutionH: null, ...extra });

test("loads in Gecko without CommonJS", () => {
	const context = vm.createContext({});
	vm.runInContext(fs.readFileSync(new URL("../content/affiliations.js", import.meta.url), "utf8"), context);
	assert.deepEqual(Object.keys(context.ZotPoPAffiliations), Object.keys(A));
});

test("tiers are cut points on the institution h-index, and a flag is two code points", () => {
	assert.equal(A.tierOf(2000).key, "t1");
	assert.equal(A.tierOf(1999).key, "t2");
	assert.equal(A.tierOf(1400).key, "t2");
	assert.equal(A.tierOf(1399).key, "t3");
	assert.equal(A.tierOf(400).key, "t3");
	assert.equal(A.tierOf(399).key, "t4");
	assert.equal(A.tierOf(null), null);
	assert.equal(A.flag("kr"), "🇰🇷");
	assert.equal(A.flag("Korea"), "");
});

test("the first author and the flagged corresponding author are picked out of a long list", () => {
	const people = [person("A First", { position: "first", institution: "KAIST", institutionId: "I1", country: "KR", institutionH: 1500 }),
		person("B Middle"), person("C Corresponding", { corresponding: true, institution: "MIT", country: "US", institutionH: 2100 }),
		person("D Last", { position: "last", institution: "Elsewhere", country: "DE" })];
	const where = A.summarise(people);
	assert.equal(where.first.institution, "KAIST");
	assert.equal(where.first.flag, "🇰🇷");
	assert.equal(where.first.tier, "t2");
	assert.equal(where.corresponding.name, "C Corresponding");
	assert.equal(where.correspondingKnown, true);
	assert.deepEqual(where.countries, ["KR", "US"]);
	assert.equal(where.international, true);
	assert.equal(where.tier, "t1", "the better of the two labs sets the row's tier");
	assert.equal(where.hIndex, 2100);
});

test("without a flag the last author stands in, and a single author is not their own correspondent", () => {
	const where = A.summarise([person("A", { position: "first", country: "KR" }), person("B"), person("Z", { position: "last", institution: "Lab Z", country: "kr" })]);
	assert.equal(where.corresponding.name, "Z");
	assert.equal(where.correspondingKnown, false);
	assert.deepEqual(where.countries, ["KR"]);
	assert.equal(where.international, false);
	assert.equal(where.tier, null);
	const solo = A.summarise([person("Only", { institution: "Lab" })]);
	assert.equal(solo.corresponding, null);
	assert.equal(solo.first.institution, "Lab");
	assert.equal(A.summarise([]), null);
	assert.equal(A.summarise(null), null);
	assert.equal(A.summarise([{ name: "  " }]), null, "nameless entries do not count");
});

test("tier table is identical to Style Custom's", () => {
	const src = fs.readFileSync(new URL("../zotero-style-custom/src/affiliations.js", import.meta.url), "utf8");
	const floors = [...src.matchAll(/key: '(t\d)', floor: (\d+)/g)].map(m => [m[1], Number(m[2])]);
	assert.equal(floors.length, 4);
	assert.deepEqual(A.TIERS.map(t => [t.key, t.floor]), floors);
});

test("a byline whose positions are known but holds no last author (cut at 100) names no last author's lab (round 6, Astra 6)", () => {
	const people = Array.from({ length: 100 }, (_, i) => ({ name: "Author " + (i + 1), position: i === 0 ? "first" : "middle", institution: "Lab " + (i + 1), country: i ? "US" : "DK" }));
	const picked = A.principals(people);
	assert.equal(picked.first.name, "Author 1");
	assert.equal(picked.corresponding, null, "Author 100 is a middle author of a cut list, not the last one");
	const s = A.summarise(people);
	assert.deepEqual(s.countries, ["DK"]);
	// a list without positions (other sources) keeps the last-author convention
	assert.equal(A.principals([{ name: "X" }, { name: "Y" }]).corresponding.name, "Y");
	// and an explicit last author is still used
	assert.equal(A.principals([...people.slice(0, 99), { name: "Z", position: "last" }]).corresponding.name, "Z");
});
