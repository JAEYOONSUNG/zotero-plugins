/*
 * Who published this, shown as a mark in the publisher's own colour.
 *
 * A journal's publisher is the thing a reader recognises at a glance -- Science is
 * red, Cell is blue, Nature is green -- and a column of plain journal names hides
 * it. Each publisher family gets a lettermark drawn in its own hue; a journal
 * nobody curated gets an initialism in a colour derived from its name, so the same
 * title is always the same colour.
 *
 * The families, hues and monogram rules mirror the companion Style Custom plugin's
 * journal-identity module, so a paper reads the same in the search results as it
 * does in the library. Search hits also carry the publisher's name (OpenAlex,
 * Crossref), which settles the family for titles the patterns do not know.
 * Environment-agnostic: loads in the Zotero window and in Node for tests.
 */
var ZotPoPJournalMarks = (function () {
	"use strict";

	const text = value => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
	const flat = value => text(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

	/* One entry per publisher family, in the order they are tested: a longer, more
	   specific pattern comes before the family it belongs to, or "Nature
	   Communications" would be matched by the rule for "Nature". */

	/* Every Nature sister journal wears its own cover colour, and a reader who
		 works in the field knows them: Biotechnology blue, Methods green, Chemical
		 Biology purple, Genetics amber, Medicine red. The portfolio is one family
		 but the marks are not one colour. Hues approximate the covers. */
	const NATURE_TITLES = [
		[/^nature$/, 168], [/^nature communications/, 195], [/^nature biotechnology/, 215],
		[/^nature methods/, 95], [/^nature chemical biology/, 285], [/^nature genetics/, 40],
		[/^nature cell biology/, 200], [/^nature immunology/, 350], [/^nature neuroscience/, 25],
		[/^nature medicine/, 5], [/^nature structural/, 260], [/^nature microbiology/, 140],
		[/^nature chemistry/, 320], [/^nature materials/, 30], [/^nature physics/, 230],
		[/^nature nanotechnology/, 15], [/^nature photonics/, 45], [/^nature catalysis/, 20],
		[/^nature energy/, 60], [/^nature ecology/, 120], [/^nature plants/, 110],
		[/^nature metabolism/, 300], [/^nature machine intelligence/, 250], [/^nature sustainability/, 150],
		[/^nature climate change/, 190], [/^nature human behaviour/, 340], [/^nature aging/, 275],
		[/^nature cancer/, 355], [/^nature synthesis/, 35], [/^nature food/, 80], [/^nature water/, 205],
		[/^nature cardiovascular/, 10], [/^nature mental health/, 330], [/^nature protocols/, 100],
		[/^nature reviews/, 175], [/^scientific reports/, 160], [/^npj\b/, 165], [/^communications /, 180]
	];
	function natureHue(title) {
		const key = flat(title);
		const hit = NATURE_TITLES.find(([test]) => test.test(key));
		return hit ? hit[1] : 168;
	}

	const FAMILIES = [
		{ key: "nature", label: "Nature", mark: "N", hue: 168, test: /^nature$/ },
		{ key: "nature-portfolio", label: "Nature Portfolio", hue: natureHue,
			test: /^(nature|npj|scientific reports|communications (biology|chemistry|physics|materials|earth|engineering|medicine))\b/,
			mark: title => monogram(title, "N") },
		{ key: "science", label: "Science", mark: "S", hue: 358, test: /^science$/ },
		{ key: "aaas", label: "AAAS", hue: 358, test: /^science\b(advances|immunology|robotics|signaling|translational)?/,
			mark: title => monogram(title, "S") },
		{ key: "pnas", label: "PNAS", mark: "PN", hue: 220, test: /^proceedings of the national academy|^pnas\b/ },
		{ key: "cell-press", label: "Cell Press", hue: 200,
			test: /^(cell|molecular cell|developmental cell|cancer cell|immunity|neuron|chem|joule|matter|one earth|med|current biology|structure|trends in)\b/,
			mark: title => monogram(title, "C") },
		{ key: "oxford", label: "Oxford", hue: 232,
			test: /^(nucleic acids research|bioinformatics|briefings in|nar |database|molecular biology and evolution|fems )/,
			mark: title => monogram(title, "O") },
		{ key: "asm", label: "ASM", hue: 190,
			test: /^(applied and environmental microbiology|journal of bacteriology|mbio|msystems|msphere|mmbr|microbiology and molecular biology reviews|antimicrobial agents|journal of virology|infection and immunity|journal of clinical microbiology)\b/,
			mark: title => monogram(title, "A") },
		{ key: "acs", label: "ACS", hue: 208,
			test: /^(acs |journal of the american chemical society|analytical chemistry|biochemistry$|journal of agricultural and food chemistry|environmental science and technology)/,
			mark: title => monogram(title, "ACS") },
		{ key: "rsc", label: "RSC", hue: 344,
			test: /^(chemical (science|communications|society reviews)|green chemistry|soft matter|lab on a chip|analyst$)/,
			mark: title => monogram(title, "RSC") },
		{ key: "embo", label: "EMBO", hue: 12, test: /^(the )?embo |^molecular systems biology/, mark: title => monogram(title, "EM") },
		{ key: "elife", label: "eLife", mark: "eL", hue: 24, test: /^elife/ },
		{ key: "plos", label: "PLOS", hue: 32, test: /^plos\b|^plo s\b/, mark: title => monogram(title, "PL") },
		{ key: "frontiers", label: "Frontiers", hue: 152, test: /^frontiers in\b/, mark: title => monogram(title, "F") },
		{ key: "mdpi", label: "MDPI", hue: 140,
			test: /^(ijms|international journal of molecular sciences|microorganisms|biomolecules|catalysts|polymers|molecules|foods|sensors|cells)$/,
			mark: title => monogram(title, "M") },
		{ key: "elsevier", label: "Elsevier", hue: 28,
			test: /^(metabolic engineering|journal of (molecular biology|biological chemistry|biotechnology)|bioresource technology|biotechnology advances|enzyme and microbial|process biochemistry|food chemistry|international journal of biological macromolecules|current opinion in|methods in enzymology|biochimica et biophysica)/,
			mark: title => monogram(title, "E") },
		{ key: "springer", label: "Springer", hue: 214,
			test: /^(applied microbiology and biotechnology|extremophiles|archives of microbiology|world journal of microbiology|biotechnology letters|journal of industrial microbiology|amb express|microbial cell factories|biotechnology for biofuels|bmc )/,
			mark: title => monogram(title, "Sp") },
		{ key: "wiley", label: "Wiley", hue: 246,
			test: /^(biotechnology and bioengineering|molecular microbiology|environmental microbiology|microbial biotechnology|febs |protein science|angewandte|advanced science|chembiochem)/,
			mark: title => monogram(title, "W") }
	];

	/* The publisher as the APIs name it. A title the patterns above do not know is
	   still placed when its record says "Elsevier BV" or "Springer Science and
	   Business Media LLC". Tested after the title rules, so Cell Press keeps its
	   blue even though Elsevier owns it. */
	const PUBLISHERS = [
		{ test: /nature|springer nature/, family: "nature-portfolio" },
		{ test: /american association for the advancement of science|\baaas\b/, family: "aaas" },
		{ test: /national academy of sciences/, family: "pnas" },
		{ test: /cell press/, family: "cell-press" },
		{ test: /oxford university press|\boup\b/, family: "oxford" },
		{ test: /american society for microbiology/, family: "asm" },
		{ test: /american chemical society/, family: "acs" },
		{ test: /royal society of chemistry/, family: "rsc" },
		{ test: /embo press/, family: "embo" },
		{ test: /elife sciences/, family: "elife" },
		{ test: /public library of science/, family: "plos" },
		{ test: /frontiers media/, family: "frontiers" },
		{ test: /\bmdpi\b/, family: "mdpi" },
		{ test: /elsevier/, family: "elsevier" },
		{ test: /springer|biomed central|\bbmc\b/, family: "springer" },
		{ test: /wiley/, family: "wiley" }
	];

	// An initialism from the words that carry meaning, so an unknown journal still
	// gets a mark that means something: "Journal of Molecular Biology" -> JMB.
	const SKIP = new Set(["the", "of", "and", "in", "for", "on", "a", "an", "at", "to", "de", "der"]);
	function monogram(title, fallback) {
		let words = flat(title).split(" ").filter(word => word && !SKIP.has(word));
		if (!words.length) return fallback || "?";
		if (words.length === 1) {
			// A one-word title keeps up to four letters: "Cell" is the mark, "Ce" is not.
			let one = words[0];
			return (one.length <= 4 ? one : one.slice(0, 3)).replace(/^./, c => c.toUpperCase());
		}
		let letters = words.slice(0, 3).map(word => word[0].toUpperCase()).join("");
		return letters.length >= 2 ? letters : (fallback || letters);
	}

	// A stable hue for a journal nobody curated, so the same title is always the
	// same colour and the column stays coherent instead of arbitrary.
	function derivedHue(title) {
		let value = flat(title);
		let hash = 0;
		for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
		return hash % 360;
	}

	function fromFamily(family, name) {
		return {
			family: family.key, label: family.label,
			hue: typeof family.hue === "function" ? family.hue(name) : family.hue,
			mark: typeof family.mark === "function" ? family.mark(name) : family.mark,
			known: true
		};
	}

	function identify(title, publisher) {
		let name = text(title);
		if (!name) return null;
		let key = flat(name);
		for (let family of FAMILIES) if (family.test.test(key)) return fromFamily(family, name);
		let house = flat(publisher);
		if (house) {
			let hit = PUBLISHERS.find(p => p.test.test(house));
			let family = hit && FAMILIES.find(f => f.key === hit.family);
			if (family) return fromFamily(family, name);
		}
		return { family: "other", label: "", hue: derivedHue(name), mark: monogram(name), known: false };
	}

	// The mark's ink and its fill, from one hue so every tile in the column is built
	// the same way. A curated family sits a little stronger than a derived one.
	const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
	function colours(identity, { dark = false } = {}) {
		let hue = identity?.hue ?? 0;
		let known = Boolean(identity?.known);
		return dark
			? { ink: hsl(hue, known ? 46 : 26, 72), fill: hsl(hue, known ? 34 : 18, 24), edge: hsl(hue, known ? 34 : 18, 34) }
			: { ink: hsl(hue, known ? 42 : 22, 38), fill: hsl(hue, known ? 46 : 26, 94), edge: hsl(hue, known ? 40 : 22, 86) };
	}

	return { identify, colours, monogram, derivedHue, natureHue, FAMILIES, PUBLISHERS, NATURE_TITLES };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPJournalMarks;
