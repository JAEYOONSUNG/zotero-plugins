import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import J from "../content/journal-marks.js";

test("loads in Gecko without CommonJS", () => {
	const context = vm.createContext({});
	vm.runInContext(fs.readFileSync(new URL("../content/journal-marks.js", import.meta.url), "utf8"), context);
	assert.deepEqual(Object.keys(context.ZotPoPJournalMarks), Object.keys(J));
});

test("the flagships wear their own colours: Science red, Cell blue, Nature green", () => {
	assert.deepEqual([J.identify("Science").hue, J.identify("Cell").hue, J.identify("Nature").hue], [358, 200, 168]);
	assert.equal(J.identify("Science").mark, "Science");
	assert.equal(J.identify("Cell").mark, "Cell");
	assert.equal(J.identify("Nature Communications").mark, "Nat Commun");
	assert.equal(J.abbreviate("Journal of Molecular Biology"), "J Mol Biol", "word by word from the ISO 4 list");
	assert.equal(J.abbreviate("Proceedings of the National Academy of Sciences"), "PNAS");
	assert.equal(J.abbreviate("Bioinformatics"), "Bioinformatics", "a one-word title stays whole");
	assert.equal(J.identify("Nature Communications").family, "nature-portfolio");
	assert.equal(J.identify("Molecular Cell").family, "cell-press", "the family is read off the title before the publisher");
	assert.equal(J.identify("Molecular Cell", "Elsevier BV").family, "cell-press");
});

test("a publisher name settles a title the patterns do not know; nothing known still gets a stable mark", () => {
	assert.equal(J.identify("The ISME Journal", "Oxford University Press (OUP)").family, "oxford");
	assert.equal(J.identify("Biotechnology for Biofuels", "Springer Science and Business Media LLC").family, "springer");
	assert.equal(J.identify("Journal of Cleaner Production", "Elsevier BV").family, "elsevier");
	assert.equal(J.identify("Journal of Cleaner Production", "Elsevier BV").mark, "J Clean Prod");
	const other = J.identify("Some Obscure Bulletin", "Nobody Press");
	assert.equal(other.known, false);
	assert.equal(other.mark, "Some Obscure Bull", "unknown words are kept whole, never guessed");
	assert.equal(other.hue, J.identify("some obscure  bulletin").hue, "the same name is always the same colour");
	assert.equal(J.identify(""), null);
	assert.equal(J.identify("arXiv (Cornell University)").family, "other");
});

test("ink and fill come from one hue, a little stronger for a curated family, and the mirror mirrors Style Custom", () => {
	const known = J.colours(J.identify("Science"));
	const derived = J.colours(J.identify("Some Obscure Bulletin"));
	assert.match(known.ink, /^hsl\(358 42% 38%\)$/);
	assert.match(derived.fill, /^hsl\(\d+ 26% 94%\)$/);
	assert.match(J.colours(J.identify("Science"), { dark: true }).ink, /^hsl\(358 46% 72%\)$/);
	const theirs = fs.readFileSync(new URL("../zotero-style-custom/src/journal-identity.js", import.meta.url), "utf8");
	for (const family of J.FAMILIES) assert.ok(theirs.includes(`key: '${family.key}'`) && (typeof family.hue === "function" || theirs.includes(`hue: ${family.hue}`)), family.key + " must match Style Custom");
	assert.equal(J.NATURE_TITLES.length, JSON.parse(JSON.stringify(theirs.match(/NATURE_TITLES = \[([\s\S]*?)\];/)[1].match(/\[\/\^/g))).length, "the same sister journals in both plugins");
});

test("every Nature sister journal keeps its own cover colour", () => {
	const hue = title => J.identify(title).hue;
	assert.notEqual(hue("Nature Biotechnology"), hue("Nature Methods"));
	assert.equal(hue("Nature Communications"), 22, "Nature Communications is orange");
	assert.equal(hue("Nature Biotechnology"), 50, "Nature Biotechnology is yellow");
	assert.notEqual(hue("Nature Communications"), hue("Nature"));
	assert.equal(hue("Nature Chemical Biology"), 285);
	assert.equal(hue("Nature Medicine"), 5);
	assert.equal(J.identify("Nature Reviews Microbiology").hue, 175);
	assert.equal(J.identify("Nature Reviews Microbiology").mark, "Nat Rev Microbiol");
	assert.equal(J.identify("Nature Biotechnology").family, "nature-portfolio", "still one family for the label");
	assert.equal(J.identify("Nature Something New").hue, 168, "an unlisted sister falls back to the house colour");
	assert.equal(J.identify("Scientific Reports").hue, 160);
	assert.equal(new Set(J.NATURE_TITLES.map(([, h]) => h)).size, J.NATURE_TITLES.length, "no two sisters share a hue");
});
