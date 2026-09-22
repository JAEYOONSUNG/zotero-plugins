/* Bibliographic field checks shared by search adapters. No HTTP or DOM dependencies. */
var ZotPoPQuery = (function () {
	"use strict";

	const PARTICLES = new Set(["al", "bin", "da", "de", "del", "della", "den", "der", "di", "dos", "du", "el", "ibn", "la", "le", "van", "von"]);
	const VENUE_JOINERS = new Set(["a", "an", "and", "de", "for", "in", "of", "the", "&"]);
	const VENUE_ABBREVIATIONS = {
		acad: ["academy", "academic"], am: ["american"], ann: ["annals"], appl: ["applied"],
		biochem: ["biochemistry", "biochemical"], biol: ["biology", "biological"], chem: ["chemistry", "chemical"],
		clin: ["clinical"], commun: ["communications", "communication"], comput: ["computer", "computing", "computational"],
		ecol: ["ecology", "ecological"], eng: ["engineering"], europ: ["european"], exp: ["experimental"],
		genet: ["genetics", "genetic"], immunol: ["immunology", "immunological"], int: ["international"],
		j: ["journal"], med: ["medicine", "medical"], mol: ["molecular"], nat: ["nature", "natural"],
		natl: ["national"], neurosci: ["neuroscience", "neurosciences"], phys: ["physics", "physical"],
		proc: ["proceedings"], psychol: ["psychology", "psychological"], res: ["research"], rev: ["review", "reviews"],
		sci: ["science", "sciences", "scientific"], soc: ["society"], stat: ["statistics", "statistical"],
		technol: ["technology", "technological"], trans: ["transactions"], tr: ["transactions"]
	};
	const GREEK_LETTERS = {
		"\u03b1": "alpha", "\u03b2": "beta", "\u03b3": "gamma", "\u03b4": "delta", "\u03b5": "epsilon", "\u03b6": "zeta",
		"\u03b7": "eta", "\u03b8": "theta", "\u03b9": "iota", "\u03ba": "kappa", "\u03bb": "lambda", "\u03bc": "mu",
		"\u03bd": "nu", "\u03be": "xi", "\u03bf": "omicron", "\u03c0": "pi", "\u03c1": "rho", "\u03c2": "sigma",
		"\u03c3": "sigma", "\u03c4": "tau", "\u03c5": "upsilon", "\u03c6": "phi", "\u03c7": "chi", "\u03c8": "psi", "\u03c9": "omega"
	};
	const TRANSLITERATIONS = {
		"\u00f8": "o", "\u00d8": "O", "\u0142": "l", "\u0141": "L", "\u0111": "d", "\u0110": "D",
		"\u00df": "ss", "\u00e6": "ae", "\u00c6": "Ae", "\u0153": "oe", "\u0152": "Oe"
	};
	const ENTITIES = {
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014", minus: "\u2212",
		rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", alpha: "\u03b1", beta: "\u03b2",
		gamma: "\u03b3", delta: "\u03b4", kappa: "\u03ba", micro: "\u00b5", deg: "\u00b0"
	};
	const GENERIC_TITLE = /^(?:editorial|introduction|conclusions?|discussion|summary|abstract|acknowledg(?:e)?ments?|preface|foreword|correction|erratum|retraction|commentary|book review|letter to the editor)$/;

	function clean(value) {
		let text = String(value ?? "")
			.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code) => {
				let n = /^x/i.test(code) ? parseInt(code.slice(1), 16) : parseInt(code, 10);
				return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
			})
			.replace(new RegExp("&(" + Object.keys(ENTITIES).join("|") + ");", "gi"), (_, entity) => ENTITIES[entity.toLowerCase()]);
		// Strip paired markup, not arbitrary angle brackets that may be inequalities.
		for (let i = 0; i < 8; i++) {
			let unwrapped = text.replace(/<([a-z][\w:-]*)(?:\s[^<>]*?)?>([\s\S]*?)<\/\1\s*>/gi, "$2");
			if (unwrapped === text) break;
			text = unwrapped;
		}
		return text.replace(/<br\s*\/?>/gi, " ").normalize("NFKD")
			// Fold Latin accents without erasing mathematical negation overlays or CJK marks.
			.replace(/(\p{Script=Latin})(\p{M}+)/gu, (_, letter, marks) => letter + marks.replace(/[\u0300-\u0314\u031b\u0323-\u0328\u032d-\u0331]/g, ""))
			// Greek letters are written out as often as they are typed, and journals
			// transliterate the letters no accent rule can reach (Muller, Orsted, Strasse).
			.replace(/([\u0391-\u03a9\u03b1-\u03c9])[\u0300-\u036f]*/g, (whole, letter) => {
				let name = GREEK_LETTERS[letter.toLowerCase()];
				if (!name) return whole;
				return letter === letter.toLowerCase() ? name : name[0].toUpperCase() + name.slice(1);
			})
			.replace(/[\u00f8\u00d8\u0142\u0141\u0111\u0110\u00df\u00e6\u00c6\u0153\u0152]/g, letter => TRANSLITERATIONS[letter])
			.normalize("NFC").replace(/\u00ad/g, "");
	}

	function words(value) {
		return clean(value).replace(/['’ʼ]/g, "").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
	}

	function present(value) { return String(value ?? "").trim().length > 0; }

	/** Normalize only verified author identifier syntax; a checksum is not proof of registration. */
	function parseAuthorIdentifier(value) {
		let raw = String(value ?? "").trim();
		let openalex = raw.match(/^(?:(?:https?:\/\/(?:api\.)?openalex\.org\/)?(?:authors\/)?)?(A[1-9]\d*)\/?$/i);
		if (openalex) return { type: "openalex", id: openalex[1].toUpperCase() };
		// ORCID is printed with hyphens, pasted with spaces and linked without a scheme.
		let orcid = raw.match(/^(?:(?:https?:\/\/)?orcid\.org\/|orcid:\s*)?(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{3}[\dX])\/?$/i);
		if (!orcid) return null;
		let digits = orcid[1].replace(/[\s-]/g, "").toUpperCase(), total = 0;
		// ISO 7064 MOD 11-2, as specified by ORCID's identifier structure documentation.
		for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
		let checksum = (12 - total % 11) % 11;
		if (digits[15] !== (checksum === 10 ? "X" : String(checksum))) return null;
		return { type: "orcid", id: digits.match(/.{4}/g).join("-") };
	}

	function authorIdentifierLike(value) {
		return /^(?:https?:\/\/|orcid\.org\/|(?:authors\/)?[A-Za-z]\d|orcid:|\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d)/i.test(String(value).trim());
	}

	// Names and venue names are whole atoms; title words are separate atoms.
	// Operators inside quotes remain literal. Malformed expressions fail closed.
	function expressionTokens(value, wholeAtoms, ignoreOperatorCase) {
		// Word processors and browsers hand back curly quotes; they still mean a phrase.
		let text = String(value).replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'");
		// A pasted all-caps title is text, not Boolean logic: "WHY NOT TO USE ANTIBIOTICS".
		// Only a run of four plain words reads as prose; a short or punctuated expression
		// is still an expression. Author and venue atoms keep the case "LIU DR" needs.
		if (!wholeAtoms && text === text.toUpperCase() && /\p{Lu}/u.test(text) && !/["()]/.test(text)
			&& text.split(/[\s;]+/).filter(piece => piece && !["AND", "OR", "NOT", "ANDNOT"].includes(piece)).length >= 4) {
			text = text.toLowerCase();
		}
		let pieces = text.match(/"(?:\\.|[^"\\])*"|[();]|[^\s();"]+|"[^\"]*$/g) || [];
		let tokens = [], pending = [];
		let flush = () => { if (pending.length) tokens.push({ kind: "term", value: pending.join(" ") }); pending = []; };
		for (let piece of pieces) {
			let op = ignoreOperatorCase ? piece.toUpperCase() : piece;
			if (piece === ";") op = "AND";
			if (["AND", "OR", "NOT", "ANDNOT", "(", ")"].includes(op)) {
				flush();
				if (op === "ANDNOT") tokens.push({ kind: "AND" }, { kind: "NOT" });
				else tokens.push({ kind: op });
			}
			else if (piece.startsWith('"')) {
				flush();
				if (!piece.endsWith('"') || piece.length === 1) return null;
				tokens.push({ kind: "term", value: piece.slice(1, -1).replace(/\\(["\\])/g, "$1"), phrase: true });
			}
			else if (wholeAtoms) pending.push(piece);
			else tokens.push({ kind: "term", value: piece });
		}
		flush();
		return tokens;
	}

	function parseExpression(value, wholeAtoms = false, ignoreOperatorCase = false) {
		// Bound both parser and downstream visitor recursion for pasted/generated input.
		if (String(value ?? "").length > 32768) return null;
		let tokens = expressionTokens(value, wholeAtoms, ignoreOperatorCase);
		if (!tokens?.length || tokens.length > 1024) return null;
		let index = 0, valid = true, depth = 0;
		function factor() {
			if (++depth > 128) { valid = false; index = tokens.length; depth--; return null; }
			let result = factorValue();
			depth--;
			return result;
		}
		function factorValue() {
			let token = tokens[index++];
			if (!token) { valid = false; return null; }
			if (token.kind === "NOT") return { kind: "NOT", child: factor() };
			if (token.kind === "(") {
				let result = either();
				if (tokens[index++]?.kind !== ")") valid = false;
				return result;
			}
			if (token.kind !== "term" || !present(token.value)) { valid = false; return null; }
			return token;
		}
		function both() {
			let result = factor();
			while (index < tokens.length && !["OR", ")"].includes(tokens[index].kind)) {
				if (tokens[index].kind === "AND") index++;
				result = { kind: "AND", left: result, right: factor() };
			}
			return result;
		}
		function either() {
			let result = both();
			while (tokens[index]?.kind === "OR") {
				index++;
				result = { kind: "OR", left: result, right: both() };
			}
			return result;
		}
		let result = either();
		return valid && index === tokens.length ? result : null;
	}

	function evaluate(value, match, wholeAtoms = false, ignoreOperatorCase = false) {
		if (!present(value)) return true;
		let tree = parseExpression(value, wholeAtoms, ignoreOperatorCase);
		if (!tree) return false;
		function visit(node) {
			if (node.kind === "term") {
				let result = match(node.value, node.phrase);
				return result == null ? null : Boolean(result);
			}
			if (node.kind === "NOT") {
				let result = visit(node.child);
				return result === null ? null : !result;
			}
			let left = visit(node.left);
			if ((node.kind === "AND" && left === false) || (node.kind === "OR" && left === true)) return left;
			let right = visit(node.right);
			if (node.kind === "AND") return right === false ? false : left === null || right === null ? null : true;
			return right === true ? true : left === null || right === null ? null : false;
		}
		return visit(tree) === true;
	}

	/** Compile whole author names; the caller owns field syntax and escaping. */
	function compileAuthors(query, formatAtom, { notOperator = "NOT", binaryNot = false } = {}) {
		if (typeof formatAtom !== "function") throw new TypeError("Author formatting requires a function");
		if (!["NOT", "ANDNOT"].includes(notOperator)) throw new RangeError("Author negation operator must be NOT or ANDNOT");
		if (!present(query)) return "";
		let tree = parseExpression(query, true, true);
		if (!tree) throw new SyntaxError("Invalid author expression: check names, quotes, operators and parentheses");
		function format(node) {
			if (node.kind === "term") {
				let value = formatAtom(node.value);
				if (typeof value !== "string" || !value.trim()) throw new TypeError("Formatted author names must be non-empty strings");
				node.formatted = value;
			}
			else if (node.kind === "NOT") format(node.child);
			else { format(node.left); format(node.right); }
		}
		function render(node) {
			if (node.kind === "term") return node.formatted;
			if (node.kind === "NOT") return "(NOT " + render(node.child) + ")";
			let operator = node.kind === "ANDNOT" ? notOperator : node.kind;
			return "(" + render(node.left) + " " + operator + " " + render(node.right) + ")";
		}
		if (notOperator === "NOT" && !binaryNot) { format(tree); return render(tree); }
		let nativeMemo = new Map();
		function nativeAndNot(node) {
			if (!nativeMemo.has(node)) nativeMemo.set(node, rewriteNative(node));
			return nativeMemo.get(node);
		}
		function rewriteNative(node) {
			if (node.kind === "term") return node;
			if (node.kind === "NOT") return node.child.kind === "NOT" ? nativeAndNot(node.child.child) : null;
			if (node.kind === "AND") {
				for (let [positive, negative] of [[node.left, node.right], [node.right, node.left]]) {
					if (negative.kind !== "NOT") continue;
					let left = nativeAndNot(positive), right = nativeAndNot(negative.child);
					if (left && right) return { kind: "ANDNOT", left, right };
				}
			}
			let left = nativeAndNot(node.left), right = nativeAndNot(node.right);
			return left && right ? { kind: node.kind, left, right } : null;
		}
		let native = nativeAndNot(tree);
		if (native) { format(tree); return render(native); }

		// Binary exclusion (arXiv ANDNOT or PubMed NOT) needs a positive scope.
		// Convert to bounded disjunctive clauses when necessary so nested NOTs
		// retain their meaning, including A AND (B OR NOT C). Every clause needs
		// a positive author scope; a purely negative branch needs a backend universe.
		const MAX_CLAUSES = 128;
		function clauses(node, negated = false) {
			if (node.kind === "term") return [[{ node, negated }]];
			if (node.kind === "NOT") return clauses(node.child, !negated);
			let left = clauses(node.left, negated), right = clauses(node.right, negated);
			let join = negated ? (node.kind === "AND" ? "OR" : "AND") : node.kind;
			if ((join === "OR" ? left.length + right.length : left.length * right.length) > MAX_CLAUSES) {
				throw new RangeError("Author expression is too complex for binary " + notOperator + "; simplify its grouped alternatives");
			}
			return join === "OR" ? [...left, ...right] : left.flatMap(a => right.map(b => [...a, ...b]));
		}
		let alternatives = clauses(tree);
		if (alternatives.some(clause => clause.every(term => term.negated))) {
			throw new SyntaxError("Binary " + notOperator + " requires a positive author name in every OR branch; purely negative author expressions are unsupported");
		}
		format(tree);
		let join = (values, operator) => values.length === 1 ? values[0] : "(" + values.join(" " + operator + " ") + ")";
		return join(alternatives.map(clause => {
			let positive = join(clause.filter(t => !t.negated).map(t => t.node.formatted), "AND");
			let negative = clause.filter(t => t.negated).map(t => t.node.formatted);
			return negative.length ? "(" + positive + " " + notOperator + " " + join(negative, "OR") + ")" : positive;
		}), "OR");
	}

	function nameTokens(value) { return clean(value).replace(/['’ʼ]/g, "").match(/[\p{L}\p{M}]+/gu) || []; }
	// A hyphen binds a written name together: "Newton-John" is one surname and
	// "J-Y" one pair of initials, even though each half is a word of its own.
	function compoundTokens(value) {
		return clean(value).replace(/['’ʼ]/g, "").match(/[\p{L}\p{M}]+(?:-[\p{L}\p{M}]+)*/gu) || [];
	}
	const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;
	// "Smith Jr" and "Smith III" are Smith; a generational suffix is never the surname.
	function withoutSuffixes(tokens) {
		let kept = tokens.filter(token => !NAME_SUFFIX.test(token));
		return kept.length ? kept : tokens;
	}
	function droppedSuffixes(value) {
		let tokens = String(value).split(/\s+/).filter(Boolean);
		let kept = withoutSuffixes(tokens);
		return kept.length === tokens.length ? String(value) : kept.join(" ");
	}
	function compactInitials(value) { return /^[A-Z]{2,3}$/.test(value); }
	function initialToken(value) { return value.length === 1 || compactInitials(value); }

	function nameParts(author) {
		if (author && typeof author === "object" && present(author.lastName)) {
			return { family: droppedSuffixes(author.lastName), given: String(author.firstName || "") };
		}
		let raw = typeof author === "string" ? author : author?.name || "";
		if (raw.includes(",")) {
			let [family, ...given] = raw.split(",");
			return { family: droppedSuffixes(family), given: droppedSuffixes(given.join(" ")) };
		}
		let tokens = compoundTokens(raw);
		let parts = withoutSuffixes(tokens);
		if (parts.length < 2) return { family: parts.length === tokens.length ? raw : parts.join(" "), given: "" };
		let end = parts.length;
		while (end > 0 && initialToken(parts[end - 1].replace(/-/g, ""))) end--;
		if (end > 0 && end < parts.length) return { family: parts.slice(0, end).join(" "), given: parts.slice(end).join(" ") };
		// An all-caps byline ("LIU DR") hides which token is the surname, because every
		// token reads as initials. The longest token is the name; the rest are initials.
		if (end === 0) {
			let chosen = parts.reduce((best, part, i) => part.length > parts[best].length ? i : best, 0);
			return { family: parts[chosen], given: parts.filter((_, i) => i !== chosen).join(" ") };
		}
		let start = parts.length - 1;
		while (start > 0 && PARTICLES.has(parts[start - 1].toLowerCase())) start--;
		return { family: parts.slice(start).join(" "), given: parts.slice(0, start).join(" ") };
	}

	function givenForms(value) {
		let tokens = nameTokens(value);
		let plain = tokens.map(t => t.toLowerCase());
		let expanded = tokens.flatMap(t => compactInitials(t) ? [...t.toLowerCase()] : [t.toLowerCase()]);
		return [plain, expanded].filter((form, i) => !i || form.join(" ") !== plain.join(" "));
	}

	function givenMatches(query, candidate) {
		if (!present(query)) return true;
		if (!present(candidate)) return false;
		for (let a of givenForms(query)) for (let b of givenForms(candidate)) {
			if (!a.length || !b.length) continue;
			// Korean and Chinese given names are written joined as often as apart:
			// "Jae Yoon" and "Jaeyoon", "Xiao-Ming" and "Xiaoming", are one person.
			if (a.join("") === b.join("")) return true;
			// A query may omit middle names; explicitly requested initials need evidence.
			if (a.length > b.length) continue;
			if (a.every((part, i) => part === b[i]
				|| ((part.length === 1 || b[i].length === 1) && part[0] === b[i][0]))) return true;
		}
		return false;
	}

	// Every token of a name, in the order it is written, with compact initials ("JY")
	// broken into letters so "J Y" and "JY" read the same.
	function nameSequence(value) {
		return nameTokens(value).flatMap(token => compactInitials(token) ? [...token.toLowerCase()] : [token.toLowerCase()]);
	}

	// "Sheila Ingemann" is an unfinished "Sheila Ingemann Jensen", and "Ingemann Jensen" is
	// the same person written without a first name. Neither ends in the family name the
	// surname rule wants, yet both are how people actually type a Danish or Spanish name.
	// Without a matching surname, the last requested full token must be present.
	// Otherwise "Sheila Ingemann" falsely expands "Sheila I. Stewart". Query initials
	// and earlier given-name tokens may still match initials ("S. Ingemann Jensen").
	// One token alone stays a surname.
	function partialNameMatches(query, family, given) {
		let wanted = nameSequence(query);
		if (wanted.length < 2 || wanted.every(token => token.length === 1)) return false;
		let anchor = wanted.length - 1;
		while (wanted[anchor].length === 1) anchor--;
		let full = [...nameSequence(given), ...nameSequence(family)];
		if (wanted.length > full.length) return false;
		for (let start = 0; start + wanted.length <= full.length; start++) {
			if (wanted[anchor] !== full[start + anchor]) continue;
			if (wanted.every((token, i) => token === full[start + i]
				|| ((token.length === 1 || (i < anchor && full[start + i].length === 1)) && token[0] === full[start + i][0]))) return true;
		}
		return false;
	}

	// Journals transliterate the same surname both ways: Mueller is Muller, Boehm is Bohm.
	// Only a fold that leaves a real surname behind counts, so "Bae" is not "Ba".
	function transliteratedFamily(value) {
		let folded = value.replace(/([aou])e/g, "$1");
		return folded.length >= 4 ? folded : value;
	}
	function sameFamily(typed, wanted) {
		return typed === wanted || transliteratedFamily(typed) === transliteratedFamily(wanted);
	}

	function authorMatches(query, author) {
		let { family, given } = nameParts(author);
		// CJK names are commonly written without a space between family and given name.
		if (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query) && present(family) && present(given)) {
			let joined = words(query).join("");
			if (joined === words(family + given).join("") || joined === words(given + family).join("")) return true;
		}
		let families = [words(family)];
		let withoutParticles = [...families[0]];
		while (withoutParticles.length > 1 && PARTICLES.has(withoutParticles[0])) withoutParticles.shift();
		families.push(withoutParticles);
		// A compound surname is searched by either half: "Garcia Marquez" answers to
		// "Garcia" and to "Marquez", and "Newton-John" to "Newton".
		if (withoutParticles.length > 1) families.push(...withoutParticles.filter(word => !PARTICLES.has(word)).map(word => [word]));
		let terms = withoutSuffixes(nameTokens(query));
		for (let familyWords of families) {
			let wanted = familyWords.join("");
			if (!wanted) continue;
			for (let length = 1; length <= terms.length; length++) {
				if (sameFamily(terms.slice(0, length).join("").toLowerCase(), wanted)
					&& givenMatches(terms.slice(length).join(" "), given)) return true;
				if (sameFamily(terms.slice(-length).join("").toLowerCase(), wanted)
					&& givenMatches(terms.slice(0, -length).join(" "), given)) return true;
			}
		}
		return partialNameMatches(query, family, given);
	}

	function matchesAuthor(query, authors) {
		let list = Array.isArray(authors) ? authors : present(authors) ? [authors] : [];
		return evaluate(query, term => {
			let identifier = parseAuthorIdentifier(term);
			if (identifier) {
				let field = identifier.type === "openalex" ? "openalexId" : "orcid";
				let identities = list.map(author => parseAuthorIdentifier(author?.[field]));
				if (identities.some(id => id?.type === identifier.type && id.id === identifier.id)) return true;
				// Absence cannot establish an excluded identity when the byline lacks IDs.
				return identities.length && identities.every(id => id?.type === identifier.type) ? false : null;
			}
			if (authorIdentifierLike(term) || !list.some(author => present(nameParts(author).family))) return null;
			return list.some(author => authorMatches(term, author));
		}, true, true);
	}

	// A letter/digit boundary is a word boundary in a title, so IL6 reads as IL-6.
	function titleWords(value) {
		return words(value).flatMap(word => word.match(/[\p{L}\p{M}]+|\p{N}+/gu) || []);
	}

	// Plurals and possessives are the same word: "Alzheimer" finds "Alzheimer's",
	// "genome" finds "genomes". Three letters is too short to be a stem.
	function titleStem(word) { return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word; }

	// A trailing asterisk is truncation, the way PubMed and Scopus write it.
	function titleNeedles(term) {
		let pieces = clean(term).replace(/['’ʼ]/g, "").toLowerCase().match(/[\p{L}\p{M}\p{N}]+\*?/gu) || [];
		return pieces.flatMap(piece => {
			let truncated = piece.endsWith("*");
			let parts = (truncated ? piece.slice(0, -1) : piece).match(/[\p{L}\p{M}]+|\p{N}+/gu) || [];
			return parts.map((word, i) => ({ word, stem: titleStem(word), prefix: truncated && i === parts.length - 1 }));
		});
	}

	function matchesTitle(query, title) {
		let haystack = titleWords(title), stems = haystack.map(titleStem);
		if (present(query) && !haystack.length) return false;
		let hit = (needle, i) => i < haystack.length
			&& (needle.prefix ? haystack[i].startsWith(needle.word) : stems[i] === needle.stem);
		return evaluate(query, (term, phrase) => {
			let needles = titleNeedles(term);
			if (!needles.length) return false;
			if (!phrase) return needles.every(needle => haystack.some((_, i) => hit(needle, i)));
			return haystack.some((_, start) => needles.every((needle, i) => hit(needle, start + i)));
		});
	}

	function venueNameMatches(query, name) {
		let a = words(query), b = words(name);
		if (!a.length || !b.length) return false;
		if (a.join(" ") === b.join(" ")) return true;
		a = a.filter(word => !VENUE_JOINERS.has(word));
		b = b.filter(word => !VENUE_JOINERS.has(word));
		if (!a.length || !b.length) return false;
		// A supplied acronym must actually be written as an acronym. PNAS stops short of
		// "of the United States of America", so an acronym may end the initials early.
		let acronym = clean(query).replace(/[.\s]/g, "");
		if (/^[A-Z]{2,10}$/.test(acronym) && b.length > 1) {
			let initials = b.map(w => w[0]).join(""), lower = acronym.toLowerCase();
			if (lower === initials || (lower.length >= 3 && initials.startsWith(lower))) return true;
		}
		if (a.length !== b.length) return false;
		// "Sci Rep" is Scientific Reports. One clipped word alone is not evidence
		// (Cell is not Cellular), so truncation only counts across a multi-word name.
		let truncation = (short, full) => a.length > 1 && short.length >= 3 && full.length > short.length && full.startsWith(short);
		return a.every((word, i) => word === b[i]
			|| VENUE_ABBREVIATIONS[word]?.includes(b[i]) || VENUE_ABBREVIATIONS[b[i]]?.includes(word)
			|| truncation(word, b[i]) || truncation(b[i], word));
	}

	function matchesVenue(query, record) {
		let rec = typeof record === "string" ? { venue: record } : record || {};
		let names = [rec.venue, rec.journalAbbreviation, rec.journalAbbr, ...(rec.venueAliases || [])].filter(present);
		let issns = [rec.issn, ...(rec.issns || [])].filter(present).map(v => String(v).replace(/[^\dx]/gi, "").toLowerCase());
		if (present(query) && !names.length && !issns.length) return false;
		return evaluate(query, term => {
			if (/^\d{4}-?\d{3}[\dx]$/i.test(term.trim())) return issns.includes(term.trim().replace(/-/g, "").toLowerCase());
			return names.some(name => venueNameMatches(term, name));
		}, true);
	}

	function matchesRecord(record, query = {}) {
		if (!record) return false;
		query = query || {};
		if (!matchesAuthor(query.authors, record.authors) || !matchesTitle(query.title, record.title) || !matchesVenue(query.venue, record)) return false;
		let year = Number(record.year || String(record.publicationDate || "").slice(0, 4));
		let from = Number(query.yearFrom), to = Number(query.yearTo);
		if ((present(query.yearFrom) && !Number.isInteger(from)) || (present(query.yearTo) && !Number.isInteger(to))) return false;
		if ((from || to) && (!Number.isInteger(year) || year <= 0)) return false;
		return !(from && year < from) && !(to && year > to);
	}

	function normalizedDOI(value) {
		let doi = String(value || "").trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase();
		return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : null;
	}

	function titleIdentity(value) {
		// Retain scientific superscripts/subscripts before compatibility normalization
		// flattens them into baseline digits (x², x₂ and x2 are different expressions).
		let scripted = String(value ?? "")
			.replace(/<(sup|sub)(?:\s[^<>]*?)?>([\s\S]*?)<\/\1\s*>/gi, (_, tag, text) => (tag.toLowerCase() === "sup" ? "^" : "_") + text)
			.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾]+/g, text => "^" + text.normalize("NFKD"))
			.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎]+/g, text => "_" + text.normalize("NFKD"))
			// A formula subscript on a multi-letter symbol is typed both ways: CO2 is CO₂.
			// A single letter keeps its script, where x₂ and x² are different expressions.
			.replace(/(\p{L}{2,})_(\d)/gu, "$1$2");
		return clean(scripted).toLowerCase().replace(/['’ʼ]/g, "").replace(/&/g, " and ")
			.replace(/[−–—‐‑‒]/g, "-")
			// Ordinary word hyphenation is typographic. Numeric ranges, signed values,
			// ionic charges and single-letter mathematical subtraction carry identity.
			.replace(/([\p{L}\p{M}]+)-(?=([\p{L}\p{M}]+))/gu, (_, left, right) => left + (left.length === 1 && right.length === 1 ? "-" : " "))
			.match(/[\p{L}\p{M}]+|\d+(?:[.,]\d+)*|[\p{Sm}%!/⁄^_\-]/gu)?.join(" ") || "";
	}

	function isSafeDOIMatch(record, candidate) {
		if (!record || !candidate) return false;
		let doi = normalizedDOI(candidate.doi);
		if (!doi || (present(record.doi) && normalizedDOI(record.doi) !== doi)) return false;
		for (let id of ["pmid", "pmcid", "arxiv"]) {
			let normalizeID = value => (id === "arxiv" ? String(value).replace(/v\d+$/, "") : String(value)).toLowerCase();
			if (record[id] && candidate[id] && normalizeID(record[id]) !== normalizeID(candidate[id])) return false;
		}
		let a = titleIdentity(record.title), b = titleIdentity(candidate.title);
		// Ordered, complete title identity retains negation, numbers and scientific signs.
		// A high bag-of-words similarity is not evidence for assigning a DOI.
		if (!a || a !== b) return false;
		let yearA = Number(record.year), yearB = Number(candidate.year);
		if (yearA && yearB && Math.abs(yearA - yearB) > 1) return false;
		let authorsA = (record.authors || []).filter(author => present(nameParts(author).family));
		let authorsB = (candidate.authors || []).filter(author => present(nameParts(author).family));
		let authorMatch = authorsA.some(author => {
			let { family, given } = nameParts(author);
			return authorsB.some(other => authorMatches([given, family].filter(Boolean).join(" "), other));
		});
		if (authorsA.length && authorsB.length && !authorMatch) return false;
		let generic = GENERIC_TITLE.test(a) || a.split(" ").length < 4 || a.length < 20;
		if (generic) {
			if (!authorMatch || !yearA || yearA !== yearB) return false;
			if (record.venue && candidate.venue && !matchesVenue(record.venue, candidate)) return false;
		}
		return true;
	}

	return { matchesAuthor, matchesTitle, matchesVenue, matchesRecord, isSafeDOIMatch, compileAuthors, parseExpression, titleIdentity, parseAuthorIdentifier };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPQuery;
