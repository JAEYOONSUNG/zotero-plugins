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
	// Exact codes read off the journals' own sites: Science #ca2015, Cell Press #007dbc; Nature's masthead is black.
	assert.deepEqual([J.identify("Science").hex, J.identify("Cell").hex, J.identify("Nature").hex], ["#ca2015", "#007dbc", null]);
	assert.deepEqual([J.identify("Science").hue, J.identify("Cell").hue], [4, 200]);
	assert.equal(J.identify("Nature").exact, true, "no colour is itself an exact answer");
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
	/* A publisher the sixteen-row table does not list still gets a family of its
	   own, keyed on its name, so every journal of that house shares one colour.
	   Measured on the full JCR list this took the journals left to a
	   title-derived hue from 97% to 10%. */
	const other = J.identify("Some Obscure Bulletin", "Nobody Press");
	assert.equal(other.known, true);
	assert.equal(other.viaPublisher, true);
	assert.match(other.family, /^pub:nobody-press/);
	assert.equal(other.label, "Nobody Press", "the house's own name is the label");
	assert.equal(other.mark, "Some Obscure Bull", "unknown words are kept whole, never guessed");
	assert.equal(other.hue, J.identify("Another Obscure Bulletin", "Nobody Press").hue, "one house, one colour");
	// Only a journal with no publisher at all is left to a hue from its title.
	const alone = J.identify("Some Obscure Bulletin");
	assert.equal(alone.known, false);
	assert.equal(alone.hue, J.identify("some obscure  bulletin").hue, "the same name is always the same colour");
	assert.equal(J.identify(""), null);
	assert.equal(J.identify("arXiv (Cornell University)").family, "other");
});

test("an exact code is worn as-is on the badge and pulled to a readable lightness for the name", () => {
	const nbt = J.colours(J.identify("Nature Biotechnology"));
	assert.equal(nbt.badge, "#efd600");
	assert.equal(nbt.badgeInk, "#111111", "dark lettering on a light yellow");
	// The lightness is whatever that hue needs: a yellow has to go further down
	// than a blue, so the test asks for the contrast, not for a number.
	const ratio = (h, s, l, behind) => {
		const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
		const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
		const f = v => { v += m; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
		const lum = 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		return (Math.max(lum, behind) + 0.05) / (Math.min(lum, behind) + 0.05);
	};
	const parse = ink => ink.match(/hsl\((\d+) (\d+)% (\d+)%\)/).slice(1).map(Number);
	{
		const [h, s, l] = parse(nbt.ink);
		assert.equal(h, 54, "the same hue the journal prints");
		assert.ok(ratio(h, s / 100, l / 100, 1) >= 4.5, "dark enough to read as text on white: " + nbt.ink);
	}
	{
		const [h, s, l] = parse(J.colours(J.identify("Nature Biotechnology"), { dark: true }).ink);
		assert.equal(h, 54);
		assert.ok(ratio(h, s / 100, l / 100, 0.0176) >= 4.5, "and on a dark row");
	}
	const asm = J.colours(J.identify("mBio"));
	assert.equal(asm.badgeInk, "#ffffff", "white lettering on a dark red");
	const none = J.colours(J.identify("Nature"));
	assert.equal(none.badge, undefined);
	assert.match(none.ink, /^hsl\(0 0% 12%\)$/, "a black masthead stays black");
	const derived = J.colours(J.identify("Some Obscure Bulletin"));
	assert.equal(derived.badge, undefined);
	assert.match(derived.fill, /^hsl\(\d+ 36% 93%\)$/);
	const theirs = fs.readFileSync(new URL("../zotero-style-custom/src/journal-identity.js", import.meta.url), "utf8");
	for (const family of J.FAMILIES) assert.ok(theirs.includes(`key: '${family.key}'`) && (typeof family.hue === "function" || theirs.includes(`hue: ${family.hue}`)), family.key + " must match Style Custom");
	assert.equal(J.NATURE_TITLES.length, JSON.parse(JSON.stringify(theirs.match(/NATURE_TITLES = \[([\s\S]*?)\];/)[1].match(/\[\/\^/g))).length, "the same sister journals in both plugins");
	const theirColours = JSON.parse(theirs.match(/JOURNAL_COLOURS = (\{[\s\S]*?\});/)[1].replace(/'/g, "\""));
	assert.deepEqual(theirColours, J.JOURNAL_COLOURS, "the same exact codes in both plugins");
});

test("every Nature sister journal keeps its own cover colour", () => {
	const hue = title => J.identify(title).hue;
	assert.notEqual(hue("Nature Biotechnology"), hue("Nature Methods"));
	assert.equal(J.identify("Nature Communications").hex, "#e63323", "the rule under the nature.com header");
	assert.equal(J.identify("Nature Biotechnology").hex, "#efd600", "Nature Biotechnology is yellow");
	assert.equal(J.identify("Nature Chemical Biology").hex, "#0094a4", "Nature Chemical Biology is teal");
	assert.equal(J.identify("Nature Medicine").hex, "#e40428");
	assert.equal(J.JOURNAL_HUES["molecular cell"], 200, "measured off the PDFs in the library");
	assert.equal(J.identify("Microbial Cell Factories").known, true, "a measured journal counts as known even without a family");
	assert.notEqual(J.identify("Nature Communications").hex, J.identify("Nature").hex);
	assert.equal(new Set(J.FAMILIES.map(f => f.key)).size, J.FAMILIES.length);
	assert.equal(J.identify("Nature Reviews Microbiology").hex, "#e5005b");
	assert.equal(J.identify("Nature Reviews Microbiology").mark, "Nat Rev Microbiol");
	assert.equal(J.identify("Nature Biotechnology").family, "nature-portfolio", "still one family for the label");
	assert.equal(J.identify("Nature Something New").hue, 168, "an unlisted sister falls back to the house colour");
	assert.equal(J.identify("Nature Something New").exact, false);
	assert.equal(J.identify("Scientific Reports").hue, 0);
});
