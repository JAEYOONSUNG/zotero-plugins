/* global Zotero, Services, Ci, IOUtils, PathUtils, CSS, ZotPoPI18N, ZotPoPSources, ZotPoPMetrics, ZotPoPImporter */
"use strict";

(function () {
	const args = (window.arguments && window.arguments[0]) || {};
	if (typeof Zotero === "undefined" && args.Zotero) window.Zotero = args.Zotero;
	const mainWindow = args.mainWindow || null;

	const $ = id => document.getElementById(id);
	const PREF = (k, v) => v === undefined
		? Zotero.Prefs.get("extensions.zotpop." + k, true)
		: Zotero.Prefs.set("extensions.zotpop." + k, v, true);

	// Title has no fixed width: it absorbs whatever is left, so keep these lean.
	const DEFAULT_COLS = {
		chk: 28, citations: 56, cpy: 64, rank: 46, authorString: 150,
		year: 46, venue: 140, doi: 135, pdf: 46, inLibrary: 46, status: 100
	};

	const COL_VERSION = 3;

	// Localised string lookup; replaced in init() once the pref is read.
	let t = ZotPoPI18N.make("en");

	// Source labels that should follow the UI language rather than the API's own name
	const SOURCE_LABEL_KEYS = { multi: "srcMulti", preprint: "srcPreprint", europepmc: "srcEuropePMC", scholar: "srcScholar" };
	function sourceLabel(key) {
		let k = SOURCE_LABEL_KEYS[key];
		return k ? t(k) : (ZotPoPSources.SOURCES[key]?.label || key);
	}

	const state = {
		records: [],
		visible: [],
		selected: new Set(),
		focusKey: null,
		detailKey: null,
		sortKey: "citations",
		sortDir: "desc",
		searching: false,
		importing: false,
		cancelled: false,
		doiMap: new Map(),
		libraryID: null,
		colWidths: Object.assign({}, DEFAULT_COLS)
	};

	// ------------------------------------------------------------ HTTP adapter
	function httpError(e, url) {
		let status = e?.status || e?.xmlhttp?.status;
		let msg = status ? `HTTP ${status}` : (e?.message || String(e));
		let err = new Error(msg + " — " + url.split("?")[0]);
		err.status = status;
		return err;
	}
	const http = {
		async getJSON(url, headers = {}) {
			try {
				let xhr = await Zotero.HTTP.request("GET", url, {
					headers: Object.assign({ Accept: "application/json" }, headers),
					responseType: "json", timeout: 60000, errorDelayMax: 0
				});
				return xhr.response;
			}
			catch (e) { throw httpError(e, url); }
		},
		async getText(url, headers = {}) {
			try {
				let xhr = await Zotero.HTTP.request("GET", url, { headers, responseType: "text", timeout: 60000, errorDelayMax: 0 });
				return xhr.responseText;
			}
			catch (e) { throw httpError(e, url); }
		}
	};

	function log(msg) { Zotero.debug("ZotPoP: " + msg); }

	function setStatus(msg, cls) {
		$("status").textContent = msg;
		$("statusbar").classList.toggle("err", cls === "err");
	}
	function setProgress(value, max) {
		let p = $("progress");
		if (value == null) { p.hidden = true; return; }
		p.hidden = false;
		p.max = Math.max(1, max || 100);
		p.value = Math.min(p.max, value);
	}
	function showBanner(text) {
		$("banner-text").textContent = text;
		$("banner").hidden = false;
	}
	function hideBanner() { $("banner").hidden = true; }

	function fmt(n, d = 2) {
		if (n == null || !Number.isFinite(n)) return "–";
		return Number.isInteger(n) && d === 0 ? String(n) : n.toFixed(d);
	}

	// ------------------------------------------------------------ init
	function init() {
		let locale = ZotPoPI18N.resolveLocale(PREF("language") || "en", Zotero.locale || Services.locale?.appLocaleAsBCP47);
		t = ZotPoPI18N.make(locale);
		document.documentElement.setAttribute("lang", locale);
		ZotPoPI18N.apply(document, t);
		document.title = t("windowTitle");

		let sel = $("source");
		for (let key of Object.keys(ZotPoPSources.SOURCES)) {
			let o = document.createElement("option");
			o.value = key; o.textContent = sourceLabel(key);
			sel.appendChild(o);
		}
		sel.value = PREF("defaultSource") || "openalex";
		if (!sel.value) sel.value = "openalex";

		restoreQuery();
		$("opt-pdf").checked = PREF("attachPDF") !== false;
		$("opt-skip").checked = PREF("skipDuplicates") !== false;
		$("opt-extra").checked = PREF("citationsInExtra") !== false;

		restoreLayout();
		populateTargets();
		wireEvents();
		sourceHint();
		applyColumnWidths();
		setDetailVisible(!$("detail").hidden);
		setStatus(t("ready"));
		render();
		$("keywords").focus();
	}

	function wireEvents() {
		$("query-form").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
		$("stop-btn").addEventListener("click", () => { state.cancelled = true; setStatus(t("stopping")); });
		$("clear-btn").addEventListener("click", clearAll);
		$("banner-close").addEventListener("click", hideBanner);
		$("filter").addEventListener("input", () => { state.focusKey = null; render(); });
		$("chk-all").addEventListener("change", e => selectVisible(e.target.checked));
		$("select-all").addEventListener("click", () => selectVisible(true));
		$("select-none").addEventListener("click", () => { state.selected.clear(); render(); });
		$("select-new").addEventListener("click", () => {
			state.selected.clear();
			for (let r of state.visible) if (!r.inLibrary) state.selected.add(r.key);
			render();
		});
		$("copy-csv").addEventListener("click", copyCSV);
		$("save-csv").addEventListener("click", saveCSV);
		$("toggle-detail").addEventListener("click", toggleDetail);
		$("import-btn").addEventListener("click", () => importRecords(state.records.filter(r => state.selected.has(r.key))));
		$("target").addEventListener("change", () => { state.doiMap.clear(); refreshLibraryFlags(); });
		$("source").addEventListener("change", sourceHint);

		for (let th of document.querySelectorAll("#results-table th[data-sort]")) {
			th.addEventListener("click", e => {
				if (e.target.classList.contains("rz")) return;
				let k = th.dataset.sort;
				if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
				else { state.sortKey = k; state.sortDir = ["citations", "cpy", "year", "inLibrary", "pdf"].includes(k) ? "desc" : "asc"; }
				render();
			});
		}
		for (let id of ["source", "sort", "opt-pdf", "opt-skip", "opt-extra", "maxResults"]) {
			$(id).addEventListener("change", savePrefs);
		}
		// detail actions
		$("d-open").addEventListener("click", () => { let r = detailRecord(); if (r?.url) Zotero.launchURL(r.url); });
		$("d-pdf").addEventListener("click", () => { let r = detailRecord(); let u = (r?.pdfUrls || [])[0] || r?.pdfUrl; if (u) Zotero.launchURL(u); });
		$("d-proxy").addEventListener("click", () => openViaProxy(detailRecord()));
		$("d-copy-doi").addEventListener("click", () => { let r = detailRecord(); if (r?.doi) copyText(r.doi, t("copiedDoi")); });
		$("d-copy-cite").addEventListener("click", () => { let r = detailRecord(); if (r) copyText(citationText(r), t("copiedCite")); });
		$("d-add").addEventListener("click", () => { let r = detailRecord(); if (r) importRecords([r]); });

		setupSplitters();
		setupColumnResize();
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("click", () => hideCtxMenu());
		window.addEventListener("unload", saveLayout);
		window.addEventListener("resize", debounce(saveLayout, 400));
	}

	function debounce(fn, ms) {
		let t;
		return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
	}

	function savePrefs() {
		PREF("defaultSource", $("source").value);
		PREF("attachPDF", $("opt-pdf").checked);
		PREF("skipDuplicates", $("opt-skip").checked);
		PREF("citationsInExtra", $("opt-extra").checked);
		let m = parseInt($("maxResults").value, 10);
		if (m > 0) PREF("maxResults", m);
	}

	function sourceHint() {
		let key = $("source").value;
		if (key === "semanticscholar" && !(PREF("s2ApiKey") || "").trim()) showBanner(t("bannerS2"));
		else if (key === "scholar") showBanner(t("bannerScholar"));
		else if (key === "preprint") showBanner(t("bannerPreprint"));
		else if (key === "multi") showBanner(t("bannerMulti"));
		else hideBanner();
	}

	// ------------------------------------------------------------ query persistence
	const QUERY_FIELDS = ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "maxResults", "sort"];
	function restoreQuery() {
		let saved = {};
		try { saved = JSON.parse(PREF("lastQuery") || "{}"); } catch (e) {}
		for (let f of QUERY_FIELDS) if (saved[f] != null) $(f).value = saved[f];
		if (!$("maxResults").value) $("maxResults").value = PREF("maxResults") || 200;
	}
	function saveQuery() {
		let o = {};
		for (let f of QUERY_FIELDS) o[f] = $(f).value;
		PREF("lastQuery", JSON.stringify(o));
	}

	// ------------------------------------------------------------ layout persistence
	function restoreLayout() {
		let w = parseInt(PREF("metricsWidth"), 10);
		if (w >= 140 && w <= 500) $("metrics").style.width = w + "px";
		let h = parseInt(PREF("detailHeight"), 10);
		if (h >= 0 && h <= 700) $("detail").style.height = h + "px";
		if (PREF("detailHidden") === true) setDetailVisible(false);
		// COL_VERSION guards against stale widths after the defaults change
		if (PREF("colWidthsVersion") === COL_VERSION) {
			try {
				let saved = JSON.parse(PREF("colWidths") || "{}");
				for (let k of Object.keys(DEFAULT_COLS)) if (saved[k] > 20) state.colWidths[k] = saved[k];
			}
			catch (e) {}
		}
	}
	function saveLayout() {
		try {
			PREF("metricsWidth", $("metrics").offsetWidth);
			PREF("detailHeight", $("detail").offsetHeight);
			PREF("detailHidden", $("detail").hidden === true);
			PREF("colWidths", JSON.stringify(state.colWidths));
			PREF("colWidthsVersion", COL_VERSION);
			PREF("winWidth", window.outerWidth);
			PREF("winHeight", window.outerHeight);
			PREF("winLeft", window.screenX);
			PREF("winTop", window.screenY);
		}
		catch (e) { log("saveLayout failed: " + e.message); }
	}

	function setDetailVisible(on) {
		$("detail").hidden = !on;
		$("hsplit").hidden = !on;
		$("toggle-detail-label").textContent = on ? t("detailOn") : t("detailOff");
	}
	function toggleDetail() {
		setDetailVisible($("detail").hidden);
		saveLayout();
	}

	function setupSplitters() {
		drag($("vsplit"), "col-resize", (dx) => {
			let el = $("metrics");
			let w = Math.max(140, Math.min(500, el.offsetWidth + dx));
			el.style.width = w + "px";
		});
		drag($("hsplit"), "row-resize", (dx, dy) => {
			let el = $("detail");
			let h = Math.max(60, Math.min(600, el.offsetHeight - dy));
			el.style.height = h + "px";
		});
	}

	function drag(handle, cursor, onMove) {
		handle.addEventListener("mousedown", e => {
			e.preventDefault();
			handle.classList.add("dragging");
			let lastX = e.clientX, lastY = e.clientY;
			let move = ev => {
				onMove(ev.clientX - lastX, ev.clientY - lastY);
				lastX = ev.clientX; lastY = ev.clientY;
			};
			let up = () => {
				handle.classList.remove("dragging");
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", up);
				document.body.style.cursor = "";
				saveLayout();
			};
			document.body.style.cursor = cursor;
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", up);
		});
	}

	function applyColumnWidths() {
		for (let col of document.querySelectorAll("#cols col")) {
			let k = col.dataset.k;
			if (k === "title") { col.style.width = ""; continue; }
			col.style.width = (state.colWidths[k] || DEFAULT_COLS[k]) + "px";
		}
	}

	function setupColumnResize() {
		let ths = [...document.querySelectorAll("#results-table th")];
		for (let th of ths) {
			let rz = th.querySelector(".rz");
			if (!rz) continue;
			let key = th.dataset.sort;
			if (!key || key === "title") continue;
			rz.addEventListener("mousedown", e => {
				e.preventDefault();
				e.stopPropagation();
				let startX = e.clientX;
				let startW = state.colWidths[key] || DEFAULT_COLS[key];
				let move = ev => {
					state.colWidths[key] = Math.max(28, startW + (ev.clientX - startX));
					applyColumnWidths();
				};
				let up = () => {
					document.removeEventListener("mousemove", move);
					document.removeEventListener("mouseup", up);
					document.body.style.cursor = "";
					saveLayout();
				};
				document.body.style.cursor = "col-resize";
				document.addEventListener("mousemove", move);
				document.addEventListener("mouseup", up);
			});
		}
	}

	// ------------------------------------------------------------ targets
	function populateTargets() {
		let sel = $("target");
		sel.textContent = "";
		let cur = ZotPoPImporter.getCurrentTarget(mainWindow);
		for (let t of ZotPoPImporter.getTargets()) {
			let o = document.createElement("option");
			o.value = t.libraryID + ":" + (t.collectionID || "");
			o.textContent = (t.depth ? "  ".repeat(t.depth) + "↳ " : "") + t.label;
			sel.appendChild(o);
		}
		sel.value = cur.libraryID + ":" + (cur.collectionID || "");
		if (!sel.value) sel.selectedIndex = 0;
	}
	function currentTarget() {
		let [lib, col] = ($("target").value || "").split(":");
		return {
			libraryID: parseInt(lib, 10) || Zotero.Libraries.userLibraryID,
			collections: col ? [parseInt(col, 10)] : []
		};
	}

	// ------------------------------------------------------------ search
	function readQuery() {
		let num = id => { let v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : null; };
		return {
			authors: $("authors").value, venue: $("venue").value, title: $("title").value, keywords: $("keywords").value,
			yearFrom: num("yearFrom"), yearTo: num("yearTo"), maxResults: num("maxResults") || 200,
			sort: $("sort").value || "relevance"
		};
	}

	async function runSearch() {
		if (state.searching || state.importing) return;
		let q = readQuery();
		if (![q.authors, q.venue, q.title, q.keywords].some(x => x.trim())) {
			setStatus(t("needCriteria"), "err");
			$("keywords").focus();
			return;
		}
		saveQuery();
		savePrefs();
		let sourceKey = $("source").value;
		let label = sourceLabel(sourceKey);
		state.searching = true;
		state.cancelled = false;
		state.records = [];
		state.selected.clear();
		state.focusKey = null;
		state.detailKey = null;
		$("search-btn").disabled = true;
		$("stop-btn").disabled = false;
		$("busy").hidden = false;
		$("busy-text").textContent = t("searching", label);
		render();
		setStatus(t("searching", label));
		setProgress(0, q.maxResults);
		let ctx = {
			email: PREF("email") || "",
			s2ApiKey: PREF("s2ApiKey") || "",
			enrichCitations: PREF("enrichCitations") !== false,
			DOMParser: window.DOMParser,
			isCancelled: () => state.cancelled,
			onProgress: (msg, n, total) => { setStatus(msg); $("busy-text").textContent = msg; setProgress(n, total); },
			log
		};
		try {
			let recs = await ZotPoPSources.search(sourceKey, q, http, ctx);
			recs.forEach((r, i) => {
				r.rank = i + 1;
				r.authorString = r.authors.map(a => a.name).join(", ");
				r.status = "";
			});
			state.records = recs;
			await refreshLibraryFlags();
			setStatus(t("resultCount", label, recs.length, state.cancelled));
			if (ctx.errors?.length) showBanner(t("partialFail", ctx.errors.join(" / ")));
			if (!recs.length) setStatus(t("noResults", label));
			else if (q.sort === "date" && q.venue.trim()) setStatus(t("journalFeed", q.venue.trim(), recs.length));
			else if (!PREF("hintShown")) {
				PREF("hintShown", true);
				setStatus(t("firstHint", label, recs.length));
			}
		}
		catch (e) {
			Zotero.logError(e);
			setStatus(t("searchFailed", e.message || e), "err");
			showBanner(t("searchFailed", e.message || e));
		}
		finally {
			state.searching = false;
			$("search-btn").disabled = false;
			$("stop-btn").disabled = true;
			$("busy").hidden = true;
			setProgress(null);
			render();
		}
	}

	async function refreshLibraryFlags() {
		let { libraryID } = currentTarget();
		if (libraryID !== state.libraryID || !state.doiMap.size) {
			state.libraryID = libraryID;
			state.doiMap = await ZotPoPImporter.getLibraryDOIMap(libraryID);
		}
		for (let r of state.records) r.inLibrary = Boolean(r.doi && state.doiMap.has(r.doi));
		render();
	}

	function clearAll() {
		for (let id of ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "filter"]) $(id).value = "";
		state.records = [];
		state.selected.clear();
		state.focusKey = null;
		state.detailKey = null;
		saveQuery();
		hideBanner();
		setStatus(t("ready"));
		render();
	}

	// ------------------------------------------------------------ render
	function matchesFilter(r, f) {
		if (!f) return true;
		let hay = (r.title + " " + r.authorString + " " + r.venue + " " + (r.doi || "") + " " + (r.year || "")).toLowerCase();
		return f.split(/\s+/).every(w => hay.includes(w));
	}

	function sortValue(r, k) {
		if (k === "cpy") return ZotPoPMetrics.citesPerYear(r) ?? -1;
		if (k === "inLibrary") return r.inLibrary ? 1 : 0;
		if (k === "pdf") return hasPDF(r) ? 1 : 0;
		let v = r[k];
		if (v == null) return ["citations", "year", "rank"].includes(k) ? -1 : "";
		return typeof v === "string" ? v.toLowerCase() : v;
	}

	function hasPDF(r) { return Boolean((r.pdfUrls || []).length || r.pdfUrl || r.pmcid || r.arxiv); }

	function render() {
		let f = $("filter").value.trim().toLowerCase();
		let list = state.records.filter(r => matchesFilter(r, f));
		let k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
		list.sort((a, b) => {
			let va = sortValue(a, k), vb = sortValue(b, k);
			if (va < vb) return -dir;
			if (va > vb) return dir;
			return a.rank - b.rank;
		});
		state.visible = list;

		for (let th of document.querySelectorAll("#results-table th[data-sort]")) {
			th.classList.toggle("sorted-asc", th.dataset.sort === k && state.sortDir === "asc");
			th.classList.toggle("sorted-desc", th.dataset.sort === k && state.sortDir === "desc");
		}

		let tbody = $("results-body");
		let frag = document.createDocumentFragment();
		for (let r of list) {
			frag.appendChild(buildRow(r));
		}
		tbody.textContent = "";
		tbody.appendChild(frag);

		$("empty").hidden = list.length > 0 || !$("busy").hidden;
		$("empty").textContent = state.records.length ? t("emptyFiltered") : t("emptyInitial");
		updateCounts();
		renderMetrics(list);
		renderDetail();
	}

	function buildRow(r) {
		let tr = document.createElement("tr");
		tr.dataset.key = r.key;
		if (r.inLibrary) tr.classList.add("in-library");
		if (state.selected.has(r.key)) tr.classList.add("selected");
		if (state.focusKey === r.key) tr.classList.add("focused");

		let td = (cls, text, title) => {
			let c = document.createElement("td");
			if (cls) c.className = cls;
			if (text != null) c.textContent = text;
			if (title) c.title = title;
			tr.appendChild(c);
			return c;
		};

		let c0 = td("chk");
		let cb = document.createElement("input");
		cb.type = "checkbox";
		cb.checked = state.selected.has(r.key);
		cb.addEventListener("change", () => toggleSelect(r, cb.checked));
		c0.appendChild(cb);

		td("num", r.citations == null ? "–" : String(r.citations), r.citationSource ? t("citeSource", sourceLabel(r.citationSource)) : "");
		td("num", fmt(ZotPoPMetrics.citesPerYear(r)));
		td("num", String(r.rank));
		td("", r.authorString, r.authorString);

		let tt = td("title", null, r.title);
		let a = document.createElement("a");
		a.textContent = r.title;
		a.href = "#";
		a.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (r.url) Zotero.launchURL(r.url); });
		tt.appendChild(a);

		td("num", r.year == null ? "" : String(r.year));
		td("", r.venue, r.venue);
		td("", r.doi || "", r.doi || "");
		td("mini pdf", hasPDF(r) ? "●" : "", hasPDF(r) ? t("thPdfTip") : "");
		td("mini lib", r.inLibrary ? "✓" : "", r.inLibrary ? t("thLibTip") : "");
		let st = td("status", r.status || "", r.statusTitle || "");
		if (r.statusClass) st.classList.add(r.statusClass);

		tr.addEventListener("click", e => {
			if (e.target.closest("input, a")) return;
			state.focusKey = r.key;
			state.detailKey = r.key;
			if (e.metaKey || e.ctrlKey) toggleSelect(r, !state.selected.has(r.key));
			else { paintRows(); renderDetail(); }
		});
		tr.addEventListener("dblclick", e => {
			if (e.target.closest("input, a")) return;
			if (r.url) Zotero.launchURL(r.url);
		});
		tr.addEventListener("contextmenu", e => {
			e.preventDefault();
			state.focusKey = r.key;
			state.detailKey = r.key;
			paintRows();
			renderDetail();
			showCtxMenu(e.clientX, e.clientY, r);
		});
		return tr;
	}

	// Repaint row classes without rebuilding the table
	function paintRows() {
		for (let tr of document.querySelectorAll("#results-body tr")) {
			let key = tr.dataset.key;
			tr.classList.toggle("selected", state.selected.has(key));
			tr.classList.toggle("focused", state.focusKey === key);
			let cb = tr.querySelector("input[type=checkbox]");
			if (cb) cb.checked = state.selected.has(key);
		}
		updateCounts();
	}

	function toggleSelect(r, on) {
		if (on) state.selected.add(r.key); else state.selected.delete(r.key);
		paintRows();
	}

	function updateCounts() {
		let n = state.records.filter(r => state.selected.has(r.key)).length;
		$("selected-count").textContent = t("selected", n);
		$("import-btn").disabled = n === 0 || state.importing || state.searching;
		$("chk-all").checked = state.visible.length > 0 && state.visible.every(r => state.selected.has(r.key));
	}

	function selectVisible(on) {
		for (let r of state.visible) { if (on) state.selected.add(r.key); else state.selected.delete(r.key); }
		paintRows();
	}

	function renderMetrics(list) {
		let m = ZotPoPMetrics.compute(list);
		let set = (id, v) => { $(id).textContent = v; };
		set("m-years", m.minYear ? `${m.minYear}–${m.maxYear}` : "–");
		set("m-cyears", m.minYear ? String(m.citationYears) : "–");
		set("m-papers", String(m.papers));
		set("m-citations", String(m.citations));
		set("m-cpy", fmt(m.citesPerYear));
		set("m-cpp", fmt(m.citesPerPaper));
		set("m-cpa", fmt(m.citesPerAuthor));
		set("m-ppa", fmt(m.papersPerAuthor));
		set("m-app", fmt(m.authorsPerPaper));
		set("m-h", String(m.hIndex));
		set("m-g", String(m.gIndex));
		set("m-hinorm", String(m.hiNorm));
		set("m-hiannual", fmt(m.hiAnnual));
		set("m-ha", String(m.hA));
	}

	// ------------------------------------------------------------ detail pane
	function detailRecord() { return state.records.find(r => r.key === state.detailKey) || null; }

	function renderDetail() {
		let r = detailRecord();
		$("detail-empty").hidden = Boolean(r);
		$("detail-body").hidden = !r;
		if (!r) return;
		$("d-title").textContent = r.title;

		let badges = $("d-badges");
		badges.textContent = "";
		let chip = (text, cls) => {
			let s = document.createElement("span");
			s.className = "badge" + (cls ? " " + cls : "");
			s.textContent = text;
			badges.appendChild(s);
		};
		if (r.citations != null) chip(t("badgeCites", r.citations), "cite");
		let cpy = ZotPoPMetrics.citesPerYear(r);
		if (cpy != null) chip(t("badgePerYear", fmt(cpy)));
		for (let s of r.sources || [r.source]) chip(sourceLabel(s));
		if (r.inLibrary) chip(t("badgeInLibrary"), "lib");
		if (hasPDF(r)) chip(t("badgeHasPdf"));

		$("d-authors").textContent = r.authorString || t("noAuthors");
		let bits = [];
		if (r.venue) bits.push(r.venue);
		if (r.year) bits.push(String(r.year));
		if (r.volume) bits.push(`${r.volume}${r.issue ? "(" + r.issue + ")" : ""}${r.pages ? ":" + r.pages : ""}`);
		if (r.doi) bits.push("DOI " + r.doi);
		if (r.pmid) bits.push("PMID " + r.pmid);
		if (r.arxiv) bits.push("arXiv " + r.arxiv);
		$("d-meta").textContent = bits.join(" · ");
		$("d-abstract").textContent = r.abstract || t("noAbstract");

		$("d-open").disabled = !r.url;
		$("d-pdf").disabled = !((r.pdfUrls || [])[0] || r.pdfUrl);
		$("d-copy-doi").disabled = !r.doi;
		$("d-proxy").disabled = !proxyLanding(r);
		$("d-add").disabled = state.importing || state.searching;
	}

	function proxyLanding(r) {
		return r ? ZotPoPSources.proxyLandingURL(r, (PREF("proxyPrefix") || "").trim()) : null;
	}

	function openViaProxy(r) {
		let url = proxyLanding(r);
		if (!url) {
			setStatus(t("proxyNotSet"), "err");
			showBanner(t("proxyHint"));
			return;
		}
		Zotero.launchURL(url);
		setStatus(t("proxyOpened"));
	}

	function citationText(r) {
		let authors = (r.authors || []).map(a => a.name).join(", ");
		let bits = [authors, r.year ? `(${r.year})` : "", r.title, r.venue].filter(Boolean);
		let out = bits.join(". ");
		if (r.doi) out += ". https://doi.org/" + r.doi;
		return out;
	}

	// ------------------------------------------------------------ context menu
	function showCtxMenu(x, y, r) {
		let menu = $("ctxmenu");
		menu.textContent = "";
		let add = (label, fn, disabled) => {
			let d = document.createElement("div");
			d.textContent = label;
			if (disabled) d.className = "disabled";
			else d.addEventListener("click", () => { hideCtxMenu(); fn(); });
			menu.appendChild(d);
		};
		add(state.selected.has(r.key) ? t("ctxDeselect") : t("ctxSelect"), () => toggleSelect(r, !state.selected.has(r.key)));
		add(t("ctxAdd"), () => importRecords([r]), state.importing || state.searching);
		menu.appendChild(document.createElement("hr"));
		add(t("ctxOpen"), () => Zotero.launchURL(r.url), !r.url);
		add(t("ctxPdf"), () => Zotero.launchURL((r.pdfUrls || [])[0] || r.pdfUrl), !((r.pdfUrls || [])[0] || r.pdfUrl));
		add(t("ctxProxy"), () => openViaProxy(r), !proxyLanding(r));
		menu.appendChild(document.createElement("hr"));
		add(t("ctxCopyTitle"), () => copyText(r.title, t("copiedTitle")));
		add(t("ctxCopyDoi"), () => copyText(r.doi, t("copiedDoi")), !r.doi);
		add(t("ctxCopyCite"), () => copyText(citationText(r), t("copiedCite")));
		menu.hidden = false;
		let w = menu.offsetWidth, h = menu.offsetHeight;
		menu.style.left = Math.min(x, window.innerWidth - w - 6) + "px";
		menu.style.top = Math.min(y, window.innerHeight - h - 6) + "px";
	}
	function hideCtxMenu() { $("ctxmenu").hidden = true; }

	// ------------------------------------------------------------ keyboard
	function onKeyDown(e) {
		let mod = e.metaKey || e.ctrlKey;
		if (e.key === "Escape") {
			if (!$("ctxmenu").hidden) { hideCtxMenu(); return; }
			if (state.searching || state.importing) { state.cancelled = true; setStatus(t("stopping")); return; }
			return;
		}
		if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("filter").focus(); $("filter").select(); return; }
		if (mod && e.key === "Enter") { e.preventDefault(); runSearch(); return; }
		if (mod && e.key.toLowerCase() === "w") { window.close(); return; }
		if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
			if (!(mod && e.key.toLowerCase() === "a")) return;
		}
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectVisible(true); return; }
		if (!state.visible.length) return;
		let idx = state.visible.findIndex(r => r.key === state.focusKey);
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			let next = e.key === "ArrowDown"
				? Math.min(state.visible.length - 1, idx < 0 ? 0 : idx + 1)
				: Math.max(0, idx < 0 ? 0 : idx - 1);
			let r = state.visible[next];
			state.focusKey = r.key;
			state.detailKey = r.key;
			if (e.shiftKey) state.selected.add(r.key);
			paintRows();
			renderDetail();
			document.querySelector(`#results-body tr[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: "nearest" });
			return;
		}
		if (e.key === " " && idx >= 0) {
			e.preventDefault();
			let r = state.visible[idx];
			toggleSelect(r, !state.selected.has(r.key));
			return;
		}
		if (e.key === "Enter" && idx >= 0) {
			e.preventDefault();
			let r = state.visible[idx];
			if (r.url) Zotero.launchURL(r.url);
		}
	}

	// ------------------------------------------------------------ export
	function copyText(text, msg) {
		Zotero.Utilities.Internal.copyTextToClipboard(String(text || ""));
		setStatus(msg || t("copied"));
	}

	function csvText() {
		let esc = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
		let lines = [t("csvHead").join(",")];
		for (let r of state.visible) {
			lines.push([
				r.citations ?? "", fmt(ZotPoPMetrics.citesPerYear(r)), r.rank, r.authorString, r.title,
				r.year ?? "", r.venue, r.publisher, r.doi ?? "", r.url ?? "",
				(r.pdfUrls || [])[0] || r.pdfUrl || "", (r.sources || [r.source]).join("+"), r.inLibrary ? t("csvYes") : t("csvNo")
			].map(esc).join(","));
		}
		return lines.join("\n");
	}

	function copyCSV() {
		if (!state.visible.length) { setStatus(t("nothingToCopy"), "err"); return; }
		copyText(csvText(), t("copiedCsv", state.visible.length));
	}

	async function saveCSV() {
		if (!state.visible.length) { setStatus(t("nothingToSave"), "err"); return; }
		try {
			let d = new Date();
			let p2 = n => String(n).padStart(2, "0");
			let stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
			let path = PathUtils.join(desktopPath(), `zotpop-${stamp}.csv`);
			// UTF-8 BOM so Excel opens Korean text correctly
			await IOUtils.writeUTF8(path, "\uFEFF" + csvText());
			setStatus(t("csvSaved", path));
			try { Zotero.File.reveal(Zotero.File.pathToFile(path)); } catch (e) { log("reveal failed: " + e.message); }
		}
		catch (e) {
			Zotero.logError(e);
			setStatus(t("csvSaveFailed", e.message || e), "err");
		}
	}

	function desktopPath() {
		for (let key of ["Desk", "Home"]) {
			try {
				let p = Services.dirsvc.get(key, Ci.nsIFile).path;
				if (p) return key === "Desk" ? p : PathUtils.join(p, "Desktop");
			}
			catch (e) { /* try next */ }
		}
		return Zotero.DataDirectory.dir;
	}

	// ------------------------------------------------------------ import
	function setRowStatus(r, text, cls, title) {
		r.status = text;
		r.statusClass = cls;
		r.statusTitle = title || "";
		let tr = document.querySelector(`#results-body tr[data-key="${CSS.escape(r.key)}"]`);
		if (!tr) return;
		let td = tr.querySelector("td.status");
		if (td) { td.textContent = text; td.className = "status " + (cls || ""); td.title = title || ""; }
		if (r.inLibrary) {
			tr.classList.add("in-library");
			let lib = tr.querySelector("td.lib");
			if (lib) lib.textContent = "✓";
		}
	}

	async function importRecords(recs) {
		if (state.importing || state.searching || !recs.length) return;
		let { libraryID, collections } = currentTarget();
		let opts = {
			libraryID, collections,
			attachPDF: $("opt-pdf").checked,
			skipDuplicates: $("opt-skip").checked,
			citationsInExtra: $("opt-extra").checked,
			http, email: PREF("email") || "", proxyPrefix: PREF("proxyPrefix") || "", log
		};
		state.importing = true;
		state.cancelled = false;
		$("import-btn").disabled = true;
		$("search-btn").disabled = true;
		$("stop-btn").disabled = false;
		$("d-add").disabled = true;
		let added = 0, exists = 0, failed = 0, pdfs = 0, proxyLoginNeeded = false;
		setProgress(0, recs.length);
		for (let i = 0; i < recs.length; i++) {
			if (state.cancelled) break;
			let r = recs[i];
			setStatus(t("adding", i + 1, recs.length, r.title.slice(0, 70)));
			setRowStatus(r, t("statusAdding"), "");
			let res = await ZotPoPImporter.importRecord(r, opts);
			if (res.status === "added") {
				added++;
				r.inLibrary = true;
				if (r.doi) state.doiMap.set(r.doi, res.item.id);
				let gotPDF = res.pdf.startsWith("pdf");
				if (res.proxyLoginNeeded) proxyLoginNeeded = true;
				if (gotPDF) pdfs++;
				let label = res.pdf === "skipped" ? t("statusAdded")
					: res.pdf === "pdf:proxy" ? t("statusAddedProxy")
					: gotPDF ? t("statusAddedPdf") : t("statusAddedNoPdf");
				setRowStatus(r, label, "ok", res.how === "manual" ? t("tipManual") : t("tipTranslator"));
			}
			else if (res.status === "exists") {
				exists++;
				r.inLibrary = true;
				setRowStatus(r, t("statusExists"), "warn");
			}
			else {
				failed++;
				setRowStatus(r, t("statusFailed"), "err", res.error);
			}
			state.selected.delete(r.key);
			setProgress(i + 1, recs.length);
		}
		state.importing = false;
		$("search-btn").disabled = false;
		$("stop-btn").disabled = true;
		setProgress(null);
		paintRows();
		renderDetail();
		setStatus(t("importDone", added, pdfs, exists, failed, state.cancelled));
		if (failed) showBanner(t("importFailures", failed));
		else if (proxyLoginNeeded) showBanner(t("loginNeeded"));
	}

	window.addEventListener("load", init);
})();
