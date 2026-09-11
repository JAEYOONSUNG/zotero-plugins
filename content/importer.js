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
		}
		return map;
	}

	async function findByDOI(libraryID, doi) {
		let s = new Zotero.Search({ libraryID });
		s.addCondition("DOI", "is", doi);
		s.addCondition("deleted", "false");
		let ids = await s.search();
		return ids.length ? ids[0] : null;
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
		setIf("title", rec.title);
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
		if (rec.itemType === "preprint" && rec.arxiv) {
			setIf("repository", "arXiv");
			setIf("archiveID", "arXiv:" + rec.arxiv);
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
		if (rec.citations == null) return;
		let label = ZotPoPSources.SOURCES[rec.source]?.label || rec.source;
		let line = `Citations: ${rec.citations} (${label}, ${today()})`;
		let extra = item.getField("extra") || "";
		let lines = extra.split("\n").filter(l => !/^Citations:\s/i.test(l));
		lines.push(line);
		item.setField("extra", lines.filter(Boolean).join("\n"));
		await item.saveTx();
	}

	async function isPDFAttachment(att) {
		try {
			if (att.attachmentContentType === "application/pdf") return true;
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
		// 2) Open-access URLs: source-reported, Europe PMC, arXiv, Unpaywall
		let urls = await ZotPoPSources.pdfCandidates(rec, opts.http, { email: opts.email });
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
				log?.("PDF download failed (" + url + "): " + e.message);
				continue;
			}
			if (att && await isPDFAttachment(att)) return { ok: true, how: "oa", url };
			if (att) {
				log?.("Not a PDF, discarding: " + url);
				try { await att.eraseTx(); } catch (e) {}
			}
		}
		return { ok: false };
	}

	/**
	 * Import one record.
	 * @return {{status: 'added'|'exists'|'failed', item?: Zotero.Item, pdf?: string, error?: string}}
	 */
	async function importRecord(rec, opts) {
		let { libraryID, collections = [], attachPDF: wantPDF = true, skipDuplicates = true, citationsInExtra = true, http, email, log } = opts;
		try {
			if (!rec.doi && !rec.pmid && !rec.arxiv && http) {
				try { await ZotPoPSources.resolveDOIByTitle(rec, http, { email }); } catch (e) { log?.("DOI lookup failed: " + e.message); }
			}
			if (rec.doi) {
				let existingID = await findByDOI(libraryID, rec.doi);
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
			if (wantPDF) {
				let r = await attachPDF(item, rec, { http, email, log });
				pdf = r.ok ? "pdf:" + r.how : "no pdf";
			}
			return { status: "added", item, how, pdf };
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

	return { importRecord, getLibraryDOIMap, getTargets, getCurrentTarget, findByDOI };
})();
