/* What the user's own library says about a search result, and the hand-offs to
   Style Custom. Pure functions over plain data (the runtime is passed in), so
   they are testable without Zotero. Style Custom is optional: every function
   answers "nothing known" when it is absent. */
var ZotPoPSignals = (() => {
	const shortWork = value => String(value == null ? "" : value).replace(/^https?:\/\/openalex\.org\//i, "").trim().toUpperCase();
	const shortAuthor = value => shortWork(value);
	const flat = value => String(value == null ? "" : value).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
	const REFERENCE_CAP = 500;
	const STATES = new Set(["done", "reading", "unread"]);

	/* The Style Custom runtime, only when it exposes what is needed. */
	function runtimeOf(Z) {
		let sc = Z && Z.StyleCustom;
		return sc && typeof sc.paperWorks === "function" && typeof sc.watchedAuthors === "function" ? sc : null;
	}

	/* Style Custom's stored works as { key, openalex, doi, checkedAt, complete, refs:Set }, one per library item it has looked up. */
	function libraryWorks(sc) {
		let out = [];
		if (!sc) return out;
		let store = {};
		try { store = sc.paperWorks() || {}; } catch (e) { return out; }
		for (let [key, work] of Object.entries(store)) {
			if (!work || work.missing) continue;
			let list = Array.isArray(work.references) ? work.references : [];
			// Style Custom keeps at most 500 references per paper: a list that long may have been cut.
			out.push({ key, openalex: shortWork(work.openalex), doi: String(work.doi || ""), checkedAt: String(work.checkedAt || ""), complete: list.length < REFERENCE_CAP, refs: new Set(list.map(shortWork).filter(Boolean)) });
		}
		return out;
	}

	/* Library items whose stored reference list holds this OpenAlex work: "my papers cite this". */
	function libraryCiting(workId, works) {
		let id = shortWork(workId);
		return id ? works.filter(w => w.refs.has(id)).map(w => w.key) : [];
	}

	/* Library items among the works this paper cites: "this cites my papers". */
	function libraryCited(referencedIds, works) {
		let refs = new Set((referencedIds || []).map(shortWork).filter(Boolean));
		return refs.size ? works.filter(w => w.openalex && refs.has(w.openalex)).map(w => w.key) : [];
	}

	/* Followed authors among a record's authors. An OpenAlex id or ORCID is exact; a bare name only
	   counts for an author the source gave no id for, because two people share a name. */
	function followedIn(record, watched) {
		let rows = Array.isArray(watched) ? watched : [];
		if (!rows.length) return [];
		let byId = new Map(rows.map(r => [shortAuthor(r.id), r])), byOrcid = new Map(rows.filter(r => r.orcid).map(r => [String(r.orcid).replace(/^https?:\/\/orcid\.org\//i, ""), r]));
		let byName = new Map(rows.map(r => [flat(r.name), r]));
		// `authors` lists the same people as `people`, without the ids: only one of them is read.
		let people = Array.isArray(record?.people) && record.people.length ? record.people : Array.isArray(record?.authors) ? record.authors : [];
		let found = new Map();
		for (let p of people) {
			let id = shortAuthor(p.openalexId), orcid = String(p.orcid || "").replace(/^https?:\/\/orcid\.org\//i, "");
			let row = (id && byId.get(id)) || (orcid && byOrcid.get(orcid)) || null;
			let name = p.name || [p.firstName, p.lastName].filter(Boolean).join(" ");
			if (!row && !id && !orcid && flat(name)) row = byName.get(flat(name)) || null;
			if (row && !found.has(shortAuthor(row.id))) found.set(shortAuthor(row.id), { id: shortAuthor(row.id), name: row.name || name });
		}
		return [...found.values()];
	}

	/* The reading state of one library item: Style Custom's "done" or "reading" (it counts reading
	   seconds, so a paper read without a tag still shows) wins; its "unread" is every item nobody
	   touched, so there the tag decides and an untagged paper shows nothing, as before. */
	function readingState(sc, item, tagState) {
		try {
			let status = sc && item && typeof sc.state === "function" ? sc.state(item)?.status : null;
			if (status === "done" || status === "reading") return status;
		} catch (e) { /* fall back to the tag */ }
		return STATES.has(tagState) ? tagState : null;
	}

	/* What watchAuthor is given: the id Style Custom wants, a name, a lab, and the works already listed so
	   the first sweep does not report them as news. Null when the id is not an OpenAlex author id. */
	function watchPayload(person, seenWorkIds) {
		let id = shortAuthor(person?.openalexId || person?.id);
		if (!/^A\d+$/.test(id)) return null;
		return { id, name: String(person.name || id), institution: String(person.institution || person.affiliation || ""),
			seen: [...new Set((seenWorkIds || []).map(shortWork).filter(w => /^W\d+$/.test(w)))] };
	}

	/* The OpenAlex ids of records (in this window's results) that the author wrote. */
	function seenWorksOf(records, authorId) {
		let id = shortAuthor(authorId), out = [];
		if (!id) return out;
		for (let r of records || []) {
			let wrote = [...(r.people || []), ...(r.authors || [])].some(p => shortAuthor(p.openalexId) === id);
			if (wrote && r.source === "openalex" && /^W\d+$/i.test(r.sourceId || "")) out.push(shortWork(r.sourceId));
		}
		return out;
	}

	return { shortWork, runtimeOf, libraryWorks, libraryCiting, libraryCited, followedIn, readingState, watchPayload, seenWorksOf };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ZotPoPSignals;
