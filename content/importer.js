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

	// Map of normalized DOI -> itemID for every non-deleted regular item in a library
	async function getLibraryDOIMap(libraryID) {
		let map = new Map();
		try {
			let sql = "SELECT I.itemID, IDV.value FROM items I "
				+ "JOIN itemData ID ON I.itemID = ID.itemID "
				+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
				+ "JOIN fields F ON ID.fieldID = F.fieldID "
				+ "WHERE F.fieldName = 'DOI' AND I.libraryID = ? "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems)";
			let rows = await Zotero.DB.queryAsync(sql, [libraryID]);
			for (let row of rows) {
				let doi = ZotPoPSources.normalizeDOI(row.value);
				if (doi) map.set(doi, row.itemID);
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
			let sql = "SELECT I.itemID FROM items I "
				+ "JOIN itemData ID ON I.itemID = ID.itemID "
				+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
				+ "JOIN fields F ON ID.fieldID = F.fieldID "
				+ "WHERE F.fieldName = 'DOI' AND I.libraryID = ? AND LOWER(IDV.value) = ? "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems) LIMIT 1";
			let rows = await Zotero.DB.queryAsync(sql, [libraryID, target]);
			return rows.length ? rows[0].itemID : null;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
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
	const flatTitle = value => String(value == null ? "" : value)
		.replace(/<[^>]*>/g, " ")
		.toLowerCase()
		.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

	async function findByTitle(libraryID, title, year) {
		let wanted = flatTitle(title);
		// A short title is not evidence: "Introduction" or "Erratum" would match
		// half a library.
		if (wanted.split(" ").filter(w => w.length > 2).length < 4) return null;
		try {
			let sql = "SELECT I.itemID, IDV.value AS title, "
				+ "(SELECT IDV2.value FROM itemData ID2 "
				+ " JOIN itemDataValues IDV2 ON ID2.valueID = IDV2.valueID "
				+ " JOIN fields F2 ON ID2.fieldID = F2.fieldID AND F2.fieldName = 'date' "
				+ " WHERE ID2.itemID = I.itemID) AS date "
				+ "FROM items I "
				+ "JOIN itemData ID ON I.itemID = ID.itemID "
				+ "JOIN itemDataValues IDV ON ID.valueID = IDV.valueID "
				+ "JOIN fields F ON ID.fieldID = F.fieldID "
				+ "WHERE F.fieldName = 'title' AND I.libraryID = ? "
				+ "AND I.itemID NOT IN (SELECT itemID FROM deletedItems) "
				+ "AND I.itemID NOT IN (SELECT itemID FROM itemAttachments) "
				+ "AND I.itemID NOT IN (SELECT itemID FROM itemNotes)";
			let rows = await Zotero.DB.queryAsync(sql, [libraryID]);
			let wantedYear = String(year || "").match(/\b(1[5-9]|20)\d{2}\b/);
			for (let row of rows) {
				if (flatTitle(row.title) !== wanted) continue;
				if (wantedYear) {
					let theirs = String(row.date || "").match(/\b(1[5-9]|20)\d{2}\b/);
					// A year on both sides that disagrees means two different
					// papers with one name, which does happen.
					if (theirs && theirs[0] !== wantedYear[0]) continue;
				}
				return row.itemID;
			}
		}
		catch (e) {
			Zotero.logError(e);
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

	async function createManually(rec, libraryID, collections) {
		let itemType = Zotero.ItemTypes.getID(rec.itemType) ? rec.itemType : "journalArticle";
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
		setIf("date", rec.year ? String(rec.year) : "");
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

	async function recordCitations(item, rec) {
		if (rec.citations == null && rec.journalIF == null) return;
		let extra = item.getField("extra") || "";
		let lines = extra.split("\n").filter(l => !/^(Citations|Journal IF)\b/i.test(l));
		if (rec.citations != null) {
			let srcKey = rec.citationSource || rec.source;
			let label = ZotPoPSources.SOURCES[srcKey]?.label || srcKey;
			lines.push(`Citations: ${rec.citations} (${label}, ${today()})`);
		}
		if (rec.journalIF != null) lines.push(`Journal IF (OpenAlex 2y): ${rec.journalIF.toFixed(2)} (${today()})`);
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
		let { libraryID, collections = [], attachPDF: wantPDF = true, skipDuplicates = true, citationsInExtra = true, http, email, proxyPrefix, log } = opts;
		try {
			if (!rec.doi && !rec.pmid && !rec.arxiv && http) {
				try { await ZotPoPSources.resolveDOIByTitle(rec, http, { email }); } catch (e) { log?.("DOI lookup failed: " + e.message); }
			}
			{
				// The DOI is the reliable answer; the title is what is left when
				// one side has no DOI to compare.
				let existingID = rec.doi ? await findByDOI(libraryID, rec.doi) : null;
				if (!existingID && skipDuplicates) existingID = await findByTitle(libraryID, rec.title, rec.year);
				if (existingID) {
					let existing = await Zotero.Items.getAsync(existingID);
					if (skipDuplicates) {
						if (collections.length) {
							let changed = false;
							for (let c of collections) {
								if (!existing.inCollection(c)) { existing.addToCollection(c); changed = true; }
							}
							if (changed) await existing.saveTx();
						}
						return { status: "exists", item: existing };
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
			if (citationsInExtra) await recordCitations(item, rec);

			let pdf = "skipped";
			let proxyLoginNeeded = false;
			if (wantPDF) {
				let r = await attachPDF(item, rec, { http, email, proxyPrefix, log });
				pdf = r.ok ? "pdf:" + r.how : "no pdf";
				if (!r.ok && r.proxyLogin) proxyLoginNeeded = true;
			}
			return { status: "added", item, how, pdf, proxyLoginNeeded };
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

	return { importRecord, getLibraryDOIMap, getTargets, getCurrentTarget, findByDOI, findByTitle, flatTitle };
})();
