/*
 * ZotPoP importer: turns search records into Zotero items (with PDFs).
 * Requires the Zotero global (chrome window).
 */
/* global Zotero, IOUtils, ZotPoPSources */
var ZotPoPImporter = (function () {
	"use strict";

	function today() {
		return new Date().toISOString().slice(0, 10);
	}

	// The DOI a field holds: the DOI field in any written form, or a "DOI:" line in Extra.
	function doiOf(fieldName, value) {
		let text = String(value || "");
		if (fieldName === "extra") return ZotPoPSources.normalizeDOI(/^\s*doi:\s*(\S+)/im.exec(text)?.[1]);
		return ZotPoPSources.normalizeDOI(text);
	}

	// Map of normalized DOI -> itemID for every non-deleted regular item in a library
	async function getLibraryDOIMap(libraryID) {
		let map = new Map();
		try {
			let sql = "SELECT I.itemID, IDV.value FROM items I "
				+ "JOIN itemData ID ON I.itemID = ID.itemID "
				+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
				+ "JOIN fields F ON ID.fieldID = F.fieldID "
				+ "WHERE F.fieldName IN ('DOI', 'extra') AND I.libraryID = ? "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems)";
			let rows = await Zotero.DB.queryAsync(sql.replace("SELECT I.itemID, IDV.value", "SELECT I.itemID, F.fieldName, IDV.value"), [libraryID]);
			// The same rule the import uses: the DOI field in any form, or a "DOI:" line in Extra.
			for (let row of rows) {
				let doi = doiOf(row.fieldName || "DOI", row.value) || (row.fieldName ? null : doiOf("extra", row.value));
				if (doi && !map.has(doi)) map.set(doi, row.itemID);
			}
		}
		catch (e) {
			Zotero.logError(e);
			// An empty map is indistinguishable from "library has no DOIs", which would make
			// every result look new. Mark it so the caller can say the status is unknown.
			map.failed = true;
		}
		return map;
	}

	// Zotero's "is" search condition compares DOI bytes and itemDataValues.value has no
	// NOCASE collation, while every search record is lowercased by normalizeDOI. Compare
	// case-insensitively in SQL so a publisher DOI stored with uppercase still matches.
	async function findByDOI(libraryID, doi) {
		let target = ZotPoPSources.normalizeDOI(doi);
		if (!target) return null;
		try {
			/* Candidates first, then an exact check with the one parser both the
			   in-library mark and the import use. The LIKE is only a net: its
			   _ and % are escaped (DOIs contain both), and "abc" inside "abcdef"
			   is thrown out by the exact check, not taken as a match. */
			let like = "%" + target.replace(/[\\%_]/g, ch => "\\" + ch) + "%";
			let sql = "SELECT I.itemID, F.fieldName, IDV.value FROM items I "
				+ "JOIN itemData ID ON I.itemID = ID.itemID "
				+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
				+ "JOIN fields F ON ID.fieldID = F.fieldID "
				+ "WHERE I.libraryID = ? AND F.fieldName IN ('DOI', 'extra') AND LOWER(IDV.value) LIKE ? ESCAPE '\\' "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems)";
			let rows = await Zotero.DB.queryAsync(sql, [libraryID, like]);
			let hit = rows.find(row => doiOf(row.fieldName, row.value) === target);
			return hit ? hit.itemID : null;
		}
		catch (e) {
			// Answering "no" here imports a second copy of a paper already on the
			// shelf. The caller has to hear that the question could not be asked.
			Zotero.logError(e);
			throw new Error("Could not check the library for duplicates: " + (e.message || e));
		}
	}

	/* The same paper, when neither copy has a DOI to match on.

	   Duplicate detection was DOI-only. In a library like this one that leaves
	   sixty-eight items unmatchable: a search result whose DOI was resolved
	   still finds nothing, because the copy already on the shelf has no DOI
	   field at all, and a second copy is imported.

	   A wrong match here is worse than a missed one -- it silently withholds a
	   paper somebody asked for -- so this is deliberately strict: the titles
	   have to be identical once punctuation and case are stripped, and the
	   years have to agree. Two papers that pass both tests and are not the same
	   paper are rare enough to accept. */
	/* Letters of every script are kept: flattened to a-z, "α-synuclein" and
	   "β-synuclein" became one title, and a Korean title became nothing.
	   Accents still come off (NFKD, marks dropped); Hangul is put back (NFC). */
	const flatTitle = value => String(value == null ? "" : value)
		.replace(/<[^>]*>/g, " ")
		.toLowerCase()
		.normalize("NFKD").replace(/\p{M}+/gu, "").normalize("NFC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

	/* The scan below reads every title in the library. Importing eighty papers
	   ran it eighty times; it is read once and kept for the run. */
	const titleRuns = new Map();
	function forgetTitleIndex(libraryID) { if (libraryID == null) titleRuns.clear(); else titleRuns.delete(libraryID); }
	async function titleIndex(libraryID) {
		let held = titleRuns.get(libraryID);
		if (held && Date.now() - held.at < 120000) return held.rows;
		let sql = "SELECT I.itemID, IDV.value AS title, "
			+ "(SELECT IDV2.value FROM itemData ID2 "
			+ " JOIN itemDataValues IDV2 ON ID2.valueID = IDV2.valueID "
			+ " JOIN fields F2 ON ID2.fieldID = F2.fieldID AND F2.fieldName = 'date' "
			+ " WHERE ID2.itemID = I.itemID) AS date, "
			// The DOI comes with the title, so a candidate can be judged without loading the item.
			+ "(SELECT IDV3.value FROM itemData ID3 "
			+ " JOIN itemDataValues IDV3 ON ID3.valueID = IDV3.valueID "
			+ " JOIN fields F3 ON ID3.fieldID = F3.fieldID AND F3.fieldName = 'DOI' "
			+ " WHERE ID3.itemID = I.itemID) AS doi, "
			+ "(SELECT IDV4.value FROM itemData ID4 "
			+ " JOIN itemDataValues IDV4 ON ID4.valueID = IDV4.valueID "
			+ " JOIN fields F4 ON ID4.fieldID = F4.fieldID AND F4.fieldName = 'extra' "
			+ " WHERE ID4.itemID = I.itemID) AS extra "
			+ "FROM items I "
			+ "JOIN itemData ID ON I.itemID = ID.itemID "
			+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
			+ "JOIN fields F ON ID.fieldID = F.fieldID "
			+ "WHERE F.fieldName = 'title' AND I.libraryID = ? "
			+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems) "
			+ "AND I.itemID NOT IN (SELECT itemID FROM itemAttachments) "
			+ "AND I.itemID NOT IN (SELECT itemID FROM itemNotes)";
		let rows = await Zotero.DB.queryAsync(sql, [libraryID]);
		let byTitle = new Map();
		for (let row of rows) {
			let key = flatTitle(row.title);
			if (!key) continue;
			let list = byTitle.get(key); if (!list) byTitle.set(key, list = []);
			list.push(row);
		}
		titleRuns.set(libraryID, {at: Date.now(), rows: byTitle});
		return byTitle;
	}
	/* Every candidate with this title and year is looked at, not the first:
	   with a preprint (another DOI) and the published copy (no DOI) on the
	   shelf, refusing the preprint must still find the copy. A candidate whose
	   DOI disagrees with the one asked about is a different version. */
	async function findByTitle(libraryID, title, year, { doi } = {}) {
		let wanted = flatTitle(title);
		// A short title is not evidence: "Introduction" or "Erratum" would match
		// half a library.
		// A Latin word counts from three letters, a word in another script from two.
		if (wanted.split(" ").filter(w => /[^a-z0-9]/.test(w) ? w.length >= 2 : w.length > 2).length < 4) return null;
		try {
			let rows = (await titleIndex(libraryID)).get(wanted) || [];
			let wantedYear = String(year || "").match(/\b(1[5-9]|20)\d{2}\b/);
			for (let row of rows) {
				if (wantedYear) {
					let theirs = String(row.date || "").match(/\b(1[5-9]|20)\d{2}\b/);
					// A year on both sides that disagrees means two different
					// papers with one name, which does happen.
					if (theirs && theirs[0] !== wantedYear[0]) continue;
				}
				// Types without a DOI field keep it in Extra as "DOI: …".
				let theirs = row.doi || (String(row.extra || "").match(/^\s*DOI:\s*(\S+)/im) || [])[1];
				if (doi && theirs && normDOI(theirs) !== normDOI(doi)) continue;
				return row.itemID;
			}
		}
		catch (e) {
			Zotero.logError(e);
			throw new Error("Could not check the library for duplicates: " + (e.message || e));
		}
		return null;
	}

	function identifierFor(rec) {
		if (rec.doi) return { DOI: rec.doi };
		if (rec.pmid) return { PMID: String(rec.pmid) };
		if (rec.arxiv) return { arXiv: rec.arxiv };
		return null;
	}

	async function importViaTranslator(rec, libraryID, collections) {
		let identifier = identifierFor(rec);
		if (!identifier) return null;
		let translate = new Zotero.Translate.Search();
		translate.setIdentifier(identifier);
		let translators = await translate.getTranslators();
		if (!translators.length) return null;
		translate.setTranslator(translators);
		let items = await translate.translate({
			libraryID,
			collections: collections && collections.length ? collections : false,
			saveAttachments: false
		});
		return items && items.length ? items[0] : null;
	}

	function manualItemType(rec) {
		if (Zotero.ItemTypes.getID(rec.itemType)) return rec.itemType;
		return rec.engine === "pop" || rec.popOriginal ? "document" : "journalArticle";
	}

	/* The day when the source gave one: a preprint saved as "2026" sorted
	   among a year of papers, though the result said which week it appeared.
	   A malformed or impossible date falls back to the year. */
	function publicationDate(rec) {
		let raw = String(rec.publicationDate || "").trim();
		let m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(raw);
		if (m) {
			let [, y, mo, d] = m, month = Number(mo || 1), day = Number(d || 1);
			let valid = month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
			if (valid && (!rec.year || Number(y) === Number(rec.year))) return [y, mo, d].filter(Boolean).join("-");
		}
		return rec.year ? String(rec.year) : "";
	}

	async function createManually(rec, libraryID, collections) {
		let itemType = manualItemType(rec);
		let item = new Zotero.Item(itemType);
		item.libraryID = libraryID;
		let setIf = (field, value) => {
			if (value == null || value === "") return;
			try {
				if (Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), item.itemTypeID)) {
					item.setField(field, value);
				}
			}
			catch (e) { /* ignore invalid field */ }
		};
		// Zotero keeps inline markup in the title field; an italic organism
		// name imported as plain text would be lost for good.
		setIf("title", rec.titleMarkup || rec.title);
		setIf("date", publicationDate(rec));
		setIf("publicationTitle", rec.venue);
		setIf("proceedingsTitle", rec.itemType === "conferencePaper" ? rec.venue : "");
		setIf("publisher", rec.publisher);
		setIf("DOI", rec.doi);
		setIf("volume", rec.volume);
		setIf("issue", rec.issue);
		setIf("pages", rec.pages);
		setIf("url", rec.url);
		setIf("abstractNote", rec.abstract);
		if (rec.itemType === "preprint") {
			// Zotero's preprint type has a repository field and nothing else names the server,
			// so without this a bioRxiv posting saved as an untitled preprint with a blank
			// repository is indistinguishable from a journal article in the item pane.
			setIf("repository", rec.preprintServer || (rec.arxiv ? "arXiv" : ""));
			if (rec.arxiv) setIf("archiveID", "arXiv:" + rec.arxiv);
		}
		item.setCreators((rec.authors || []).filter(a => a.lastName || a.firstName).map(a => ({
			firstName: a.firstName || "",
			lastName: a.lastName || a.name || "",
			creatorType: "author"
		})));
		if (collections && collections.length) item.setCollections(collections);
		await item.saveTx();
		return item;
	}

	/* A DOI translator builds the item from Crossref, which often has no
	   abstract and never has the PubMed IDs the search result carried. What
	   the result knew and the item lacks is filled in; nothing is overwritten. */
	async function backfill(item, rec) {
		let changed = false;
		try {
			if (rec.abstract && !String(item.getField("abstractNote") || "").trim()
				&& Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID("abstractNote"), item.itemTypeID)) {
				item.setField("abstractNote", rec.abstract); changed = true;
			}
		}
		catch (e) { /* a type without an abstract field */ }
		let extra = String(item.getField("extra") || "");
		let add = [];
		if (rec.pmid && !/^\s*PMID:/im.test(extra)) add.push("PMID: " + rec.pmid);
		if (rec.pmcid && !/^\s*PMCID:/im.test(extra)) add.push("PMCID: " + rec.pmcid);
		if (add.length) { item.setField("extra", [extra, ...add].filter(Boolean).join("\n")); changed = true; }
		if (changed) await item.saveTx();
		return changed;
	}

	const normDOI = value => String(value || "").trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");

	function sameWorkIdentifiers(rec, item) {
		let field = key => { try { return String(item?.getField?.(key) || ""); } catch (e) { return ""; } };
		let norm = value => String(value || "").trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
		let theirs = norm(field("DOI") || (field("extra").match(/^\s*DOI:\s*(\S+)/im) || [])[1]);
		return !rec.doi || !theirs || norm(rec.doi) === theirs;
	}

	function journalFigureLabel(rec) {
		return rec.journalIFEstimate === false && rec.journalIFSource ? String(rec.journalIFSource) : "OpenAlex 2y";
	}

	async function recordCitations(item, rec) {
		if (rec.citations == null && rec.journalIF == null) return;
		let extra = item.getField("extra") || "";
		let lines = extra.split("\n").filter(l => !/^(Citations|Journal IF)\b/i.test(l));
		if (rec.citations != null) {
			let srcKey = rec.citationSource || rec.source;
			let label = ZotPoPSources.SOURCES[srcKey]?.label || srcKey;
			lines.push(`Citations: ${rec.citations} (${label}, ${today()})`);
		}
		// Which figure it is travels with it: a JCR impact factor was written down as "OpenAlex 2y".
		if (rec.journalIF != null) lines.push(`Journal IF (${journalFigureLabel(rec)}): ${rec.journalIF.toFixed(2)} (${today()})`);
		item.setField("extra", lines.filter(Boolean).join("\n"));
		await item.saveTx();
	}

	async function isPDFAttachment(att) {
		try {
			// Do not trust attachmentContentType: importFromURL writes back whatever we asked
			// for, so checking it here would approve an HTML login page. Read the magic bytes.
			let path = await att.getFilePathAsync();
			if (!path) return false;
			let bytes = await IOUtils.read(path, { maxBytes: 5 });
			return String.fromCharCode(...bytes).startsWith("%PDF");
		}
		catch (e) {
			return false;
		}
	}

	/* A paper already on the shelf without a PDF gets one, when asked. Any PDF
	   attachment counts as having one -- including one whose file has not
	   synced down yet, which is Zotero's to fetch, not a gap to fill twice.
	   The same paper is never filled by two imports at once. */
	const filling = new Set();
	async function fillPDF(item, rec, opts) {
		if (!item || filling.has(item.id)) return "skipped";
		filling.add(item.id);
		try {
			// A library not opened yet has its children unloaded: they are loaded, not read as "no attachments".
			try { await item.loadDataType?.("childItems"); } catch (e) { return "skipped"; }
			let ids = item.getAttachments?.() || [];
			let atts = ids.length && Zotero.Items.getAsync ? await Zotero.Items.getAsync(ids) : ids.map(id => Zotero.Items.get(id));
			for (let att of atts || []) {
				if (att && !att.deleted && att.attachmentContentType === "application/pdf") return "has pdf";
			}
			if (!Zotero.Libraries.get?.(item.libraryID)?.filesEditable && Zotero.Libraries.get?.(item.libraryID)) return "no permission";
			let r = await attachPDF(item, rec, opts);
			return r.ok ? "pdf:" + r.how : "no pdf";
		}
		finally { filling.delete(item.id); }
	}

	async function attachPDF(item, rec, opts) {
		let log = opts.log;
		// 1) Zotero's own resolvers (Unpaywall, DOI page, PMC, custom resolvers)
		try {
			let fn = Zotero.Attachments.addAvailableFile || Zotero.Attachments.addAvailablePDF;
			let att = await fn.call(Zotero.Attachments, item);
			if (att) return { ok: true, how: "zotero" };
		}
		catch (e) {
			log?.("Zotero PDF lookup failed: " + e.message);
		}
		// 2) Open-access URLs first, then the library proxy for anything paywalled
		let urls = await ZotPoPSources.pdfCandidates(rec, opts.http, { email: opts.email, proxyPrefix: opts.proxyPrefix });
		let prefix = (opts.proxyPrefix || "").trim();
		let proxyLogin = false;
		for (let url of urls) {
			let att = null;
			try {
				att = await Zotero.Attachments.importFromURL({
					libraryID: item.libraryID,
					url,
					parentItemID: item.id,
					contentType: "application/pdf",
					title: "Full Text PDF"
				});
			}
			catch (e) {
				// Zotero enforces the requested type and throws for anything that is not a
				// PDF, so this is where a proxy handing back its sign-in page lands.
				log?.("PDF download failed (" + url + "): " + e.message);
				if (ZotPoPSources.viaProxy(url, prefix)) proxyLogin = true;
				continue;
			}
			if (att && await isPDFAttachment(att)) {
				return { ok: true, how: ZotPoPSources.viaProxy(url, prefix) ? "proxy" : "oa", url };
			}
			if (att) {
				log?.("Not a PDF, discarding: " + url);
				if (ZotPoPSources.viaProxy(url, prefix)) proxyLogin = true;
				try { await att.eraseTx(); }
				catch (e) { log?.("Could not discard the non-PDF attachment: " + e.message); }
			}
			else if (ZotPoPSources.viaProxy(url, prefix)) {
				proxyLogin = true;
			}
		}
		return { ok: false, proxyLogin };
	}

	/**
	 * Import one record.
	 * @return {{status: 'added'|'exists'|'failed', item?: Zotero.Item, pdf?: string, error?: string}}
	 */
	async function importRecord(rec, opts) {
		let { libraryID, collections = [], attachPDF: wantPDF = true, skipDuplicates = true, citationsInExtra = true, fillMissingPDF = false, http, email, proxyPrefix, log } = opts;
		try {
			if (!rec.doi && !rec.pmid && !rec.arxiv && http) {
				try { await ZotPoPSources.resolveDOIByTitle(rec, http, { email }); } catch (e) { log?.("DOI lookup failed: " + e.message); }
			}
			{
				// The DOI is the reliable answer; the title is what is left when
				// one side has no DOI to compare.
				let existingID = rec.doi ? await findByDOI(libraryID, rec.doi) : null;
				/* Same title and year, different DOIs: a preprint and the paper it
				   became, or two versions -- two records, not one. The title is the
				   fallback for when one side has no DOI, never an override of two
				   DOIs that disagree. */
				if (!existingID && skipDuplicates) existingID = await findByTitle(libraryID, rec.title, rec.year, { doi: rec.doi });
				if (existingID) {
					let existing = await Zotero.Items.getAsync(existingID);
					if (skipDuplicates) {
						let addedToCollection = false;
						// A library not opened yet has an item's collections unloaded; they are loaded before being asked about.
						if (collections.length) { try { await existing.loadDataType?.("collections"); } catch (e) { log?.("Collections not loaded: " + e.message); } }
						if (collections.length) {
							for (let c of collections) {
								if (!existing.inCollection(c)) { existing.addToCollection(c); addedToCollection = true; }
							}
							if (addedToCollection) await existing.saveTx();
						}
						// Said, so the row can read "이미 있음 · 컬렉션에 추가" rather than a bare "already there".
						let pdf = "skipped";
						if (wantPDF && fillMissingPDF) pdf = await fillPDF(existing, rec, { http, email, proxyPrefix, log });
						return { status: "exists", item: existing, addedToCollection, pdf };
					}
				}
			}

			let item = null;
			try {
				item = await importViaTranslator(rec, libraryID, collections);
			}
			catch (e) {
				log?.("Translator lookup failed for " + (rec.doi || rec.pmid || rec.arxiv) + ": " + e.message);
			}
			let how = "translator";
			if (!item) {
				item = await createManually(rec, libraryID, collections);
				how = "manual";
			}
			/* The item exists from here on. A later step that fails -- the abstract,
			   the Extra lines -- is reported as that step, not as a failed import:
			   "실패" for a paper already in the library led to importing it again. */
			let warnings = [];
			try { await backfill(item, rec); } catch (e) { log?.("Backfill failed: " + e.message); warnings.push("metadata"); }
			if (citationsInExtra) { try { await recordCitations(item, rec); } catch (e) { log?.("Extra failed: " + e.message); warnings.push("extra"); } }

			let pdf = "skipped";
			let proxyLoginNeeded = false;
			if (wantPDF) {
				let r = await attachPDF(item, rec, { http, email, proxyPrefix, log });
				pdf = r.ok ? "pdf:" + r.how : "no pdf";
				if (!r.ok && r.proxyLogin) proxyLoginNeeded = true;
			}
			return { status: "added", item, how, pdf, proxyLoginNeeded, warnings };
		}
		catch (e) {
			Zotero.logError(e);
			return { status: "failed", error: e.message || String(e) };
		}
	}

	// Editable libraries with their collections, flattened for a <select>
	function getTargets() {
		let out = [];
		for (let lib of Zotero.Libraries.getAll()) {
			if (!lib.editable) continue;
			out.push({ libraryID: lib.libraryID, collectionID: null, label: lib.name, depth: 0 });
			let cols = Zotero.Collections.getByLibrary(lib.libraryID, true);
			let byParent = new Map();
			for (let c of cols) {
				let k = c.parentID || 0;
				if (!byParent.has(k)) byParent.set(k, []);
				byParent.get(k).push(c);
			}
			let walk = (parentID, depth) => {
				let kids = (byParent.get(parentID) || []).sort((a, b) => a.name.localeCompare(b.name));
				for (let c of kids) {
					out.push({ libraryID: lib.libraryID, collectionID: c.id, label: c.name, depth });
					walk(c.id, depth + 1);
				}
			};
			walk(0, 1);
		}
		return out;
	}

	function getCurrentTarget(mainWindow) {
		try {
			let pane = mainWindow?.ZoteroPane || Zotero.getActiveZoteroPane();
			let libraryID = pane.getSelectedLibraryID();
			let col = pane.getSelectedCollection();
			return { libraryID, collectionID: col ? col.id : null };
		}
		catch (e) {
			return { libraryID: Zotero.Libraries.userLibraryID, collectionID: null };
		}
	}

	return { manualItemType, importRecord, fillPDF, backfill, publicationDate, journalFigureLabel, sameWorkIdentifiers, getLibraryDOIMap, getTargets, getCurrentTarget, findByDOI, findByTitle, flatTitle, forgetTitleIndex };
})();
