/* global Zotero, Services, Ci, IOUtils, PathUtils, CSS, ZotPoPI18N, ZotPoPSources, ZotPoPMetrics, ZotPoPImporter, ZotPoPPoPBridge, ZotPoPPreview, ZotPoPMarquee */
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
		year: 46, venue: 140, journalIF: 48, doi: 135, pdf: 46, inLibrary: 46, status: 100
	};

	const COL_VERSION = 4;
	// Narrower than this and a column cannot show its own content (a 4-digit year needs ~40px)
	const MIN_COL = 40;
	// An unbounded drag used to persist a column wider than the window
	const MAX_COL = 900;

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
		sortKey: "rank",
		checking: false,
		sortDir: "asc",
		searching: false,
		searchController: null,
		importing: false,
		cancelled: false,
		doiMap: new Map(),
		libraryID: null,
		colWidths: Object.assign({}, DEFAULT_COLS)
	};
	let marquee = null;

	// ------------------------------------------------------------ HTTP adapter
	function abortError() {
		let err = new Error("Search cancelled");
		err.name = "AbortError";
		return err;
	}

	// Zotero embeds the requested URL in its own error text and redacts only "key=", so any
	// message reused here is scrubbed of its query string before it reaches the UI or the log.
	function scrubURLs(text) {
		return String(text || "").replace(/(https?:\/\/[^\s?]+)\?\S*/g, "$1");
	}

	function httpError(e, url) {
		if (e?.name === "AbortError") return e;
		// Reading responseText throws outright when responseType is "json", so probe the
		// parsed response first and only fall back to text behind a guard.
		let body = "";
		try {
			let raw = e?.xmlhttp?.response;
			if (typeof raw === "string") body = raw;
			else if (raw && typeof raw === "object") body = JSON.stringify(raw);
			else if (e?.xmlhttp?.responseType === "" || e?.xmlhttp?.responseType === "text") body = e.xmlhttp.responseText || "";
		}
		catch (ignored) { /* the body is a bonus; never let reading it break the error path */ }
		let status = e?.status ?? e?.xmlhttp?.status;
		// A network-level failure arrives as status 0, which is falsy: testing truthiness
		// fell through to Zotero's message, which carries the contact e-mail.
		let msg = status != null && status !== 0 ? `HTTP ${status}` : scrubURLs(e?.message || String(e));
		let err = new Error(msg + " — " + url.split("?")[0]);
		err.status = status;
		// sources.js distinguishes an exhausted OpenAlex budget from a transient 429
		err.body = String(body).slice(0, 400);
		return err;
	}
	async function requestHTTP(url, headers, responseType, signal) {
		if (signal?.aborted) throw abortError();
		let cancelRequest;
		let onAbort = () => cancelRequest?.();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let xhr = await Zotero.HTTP.request("GET", url, {
				headers, responseType, timeout: 60000, errorDelayMax: 0,
				// Zotero.HTTP supplies a callback that rejects its promise and aborts XHR.
				cancellerReceiver: cancel => {
					cancelRequest = cancel;
					if (signal?.aborted) cancel();
				}
			});
			if (signal?.aborted) throw abortError();
			return xhr;
		}
		catch (e) {
			if (signal?.aborted || (Zotero.HTTP.CancelledException && e instanceof Zotero.HTTP.CancelledException)) throw abortError();
			throw httpError(e, url);
		}
		finally { signal?.removeEventListener("abort", onAbort); }
	}
	const http = {
		async getJSON(url, headers = {}, signal) {
			let xhr = await requestHTTP(url, Object.assign({ Accept: "application/json" }, headers), "json", signal);
			// XHR yields null rather than throwing when a body is not JSON — a captive portal
			// or an API maintenance page. Name it, instead of a TypeError deep in an adapter.
			if (xhr.response === null) {
				let err = new Error(t("notJSON", url.split("?")[0]));
				err.status = xhr.status;
				throw err;
			}
			return xhr.response;
		},
		async getText(url, headers = {}, signal) {
			let xhr = await requestHTTP(url, headers, "text", signal);
			return xhr.responseText;
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
		for (let id of ["source", "sort", "target"]) enhanceSelect($(id));

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
		restoreCachedSearch();
	}

	function wireEvents() {
		$("query-form").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
		$("query-form").addEventListener("input", cancelCacheRestore);
		$("query-form").addEventListener("change", cancelCacheRestore);
		$("stop-btn").addEventListener("click", stopOperation);
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
		$("preview-btn").addEventListener("click", () => openPreview());
		$("import-btn").addEventListener("click", () => importRecords(state.records.filter(r => state.selected.has(r.key))));
		$("target").addEventListener("change", () => { state.doiMap.clear(); refreshLibraryFlags(); });
		$("source").addEventListener("change", sourceHint);

		for (let th of document.querySelectorAll("#results-table th[data-sort]")) {
			th.addEventListener("click", e => {
				if (e.target.classList.contains("rz")) return;
				let k = th.dataset.sort;
				if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
				else { state.sortKey = k; state.sortDir = ["citations", "cpy", "year", "inLibrary", "pdf", "journalIF"].includes(k) ? "desc" : "asc"; }
				render();
			});
		}
		for (let id of ["source", "sort", "opt-pdf", "opt-skip", "opt-extra", "maxResults"]) {
			$(id).addEventListener("change", savePrefs);
		}
		// detail actions
		$("d-open").addEventListener("click", () => { let r = detailRecord(); if (r?.url) Zotero.launchURL(r.url); });
		$("d-pdf").addEventListener("click", () => { let r = detailRecord(); let u = (r?.pdfUrls || [])[0] || r?.pdfUrl; if (u) Zotero.launchURL(u); });
		$("d-preview").addEventListener("click", () => openPreview(detailRecord()));
		$("d-proxy").addEventListener("click", () => openViaProxy(detailRecord()));
		$("d-copy-doi").addEventListener("click", () => { let r = detailRecord(); if (r?.doi) copyText(r.doi, t("copiedDoi")); });
		$("d-copy-cite").addEventListener("click", () => { let r = detailRecord(); if (r) copyText(citationText(r), t("copiedCite")); });
		$("d-add").addEventListener("click", () => { let r = detailRecord(); if (r) importRecords([r]); });
		$("d-check").addEventListener("click", () => checkCitations(detailRecord()));

		// Pressing in the results hands keyboard focus to the table. Done on mousedown because
		// focusing during the click handler is undone when the browser settles focus after it;
		// without this the caret stays in the last query box and arrows/Space never arrive.
		$("table-wrap").addEventListener("mousedown", e => {
			// e.target is not always an Element here (scrollbar and anonymous content have no
			// closest), so probe for the method rather than assuming it.
			if (typeof e.target?.closest === "function" && e.target.closest("input, a")) return;
			$("table-wrap").focus({ preventScroll: true });
		});

		setupSplitters();
		setupColumnResize();
		document.addEventListener("keydown", onKeyDown);
		document.addEventListener("click", () => { hideCtxMenu(); closeSelMenu(); });
		window.addEventListener("blur", closeSelMenu);
		window.addEventListener("resize", closeSelMenu);
		document.addEventListener("scroll", onDocumentScroll, true);
		window.addEventListener("unload", saveLayout);
		window.addEventListener("unload", () => state.searchController?.abort());
		window.addEventListener("unload", cancelCacheRestore);
		window.addEventListener("unload", () => previewManager?.close());
		window.addEventListener("resize", debounce(saveLayout, 400));
	}

	// ---------------------------------------------------------------- dropdowns
	// Gecko paints a native <select> popup through this window's backdrop-filter
	// layers, so the option list came out transparent and doubled over the page.
	// The <select> stays as the value model; an opaque in-page menu drives it.
	let openSel = null;

	function selButton(sel) { return sel.parentNode.querySelector(".sel-btn"); }

	function syncSel(sel) {
		let btn = selButton(sel);
		if (!btn) return;
		let o = sel.options[sel.selectedIndex];
		btn.querySelector(".sel-label").textContent = o ? o.textContent.trim() : "";
		btn.disabled = sel.disabled;
	}

	function closeSelMenu() {
		if (!openSel) return;
		let { sel, menu } = openSel;
		menu.remove();
		let btn = selButton(sel);
		btn?.setAttribute("aria-expanded", "false");
		btn?.removeAttribute("aria-activedescendant");
		openSel = null;
	}

	function onDocumentScroll(event) {
		// Reading a narrow result cell must not dismiss the open source/sort menu.
		if (!event.target?.classList?.contains("marquee-text")) closeSelMenu();
	}

	function openSelMenu(sel) {
		if (openSel && openSel.sel === sel) { closeSelMenu(); return; }
		closeSelMenu();
		if (sel.disabled || !sel.options.length) return;
		let btn = selButton(sel);
		let menu = document.createElement("div");
		menu.className = "selmenu";
		menu.setAttribute("role", "listbox");
		let items = [];
		for (let i = 0; i < sel.options.length; i++) {
			let o = sel.options[i];
			let d = document.createElement("div");
			d.className = "selopt" + (i === sel.selectedIndex ? " on" : "");
			d.setAttribute("role", "option");
			// role="option" without aria-selected is not exposed as a choice to assistive
			// technology, which left these reading as plain text.
			d.setAttribute("aria-selected", i === sel.selectedIndex ? "true" : "false");
			d.id = sel.id + "-opt-" + i;
			d.textContent = o.textContent;
			d.addEventListener("mouseenter", () => highlight(i));
			d.addEventListener("click", e => { e.stopPropagation(); pick(i); });
			menu.appendChild(d);
			items.push(d);
		}
		let cur = sel.selectedIndex < 0 ? 0 : sel.selectedIndex;
		let highlight = i => {
			cur = i;
			items.forEach((d, n) => d.classList.toggle("hot", n === i));
			items[i]?.scrollIntoView({ block: "nearest" });
			if (items[i]) btn.setAttribute("aria-activedescendant", items[i].id);
		};
		let pick = i => {
			let prev = sel.value;
			items.forEach((d, n) => d.setAttribute("aria-selected", n === i ? "true" : "false"));
			sel.selectedIndex = i;
			syncSel(sel);
			closeSelMenu();
			btn.focus();
			if (sel.value !== prev) sel.dispatchEvent(new Event("change", { bubbles: true }));
		};
		document.body.appendChild(menu);
		let r = btn.getBoundingClientRect();
		menu.style.minWidth = r.width + "px";
		let h = menu.offsetHeight;
		let below = window.innerHeight - r.bottom - 8;
		if (h > below && r.top > below) {
			menu.style.maxHeight = Math.min(h, r.top - 8) + "px";
			menu.style.top = Math.max(6, r.top - Math.min(h, r.top - 8) - 3) + "px";
		}
		else {
			menu.style.maxHeight = Math.max(120, below) + "px";
			menu.style.top = (r.bottom + 3) + "px";
		}
		menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + "px";
		btn.setAttribute("aria-expanded", "true");
		openSel = { sel, menu, items, pick, move: d => highlight(Math.max(0, Math.min(items.length - 1, cur + d))), commit: () => pick(cur) };
		highlight(cur);
	}

	function enhanceSelect(sel) {
		let wrap = document.createElement("div");
		wrap.className = "sel";
		sel.parentNode.insertBefore(wrap, sel);
		wrap.appendChild(sel);
		// The real select stays as the value model but must not be reachable by Tab: focusing
		// it invisibly and arrowing through it changed the value without updating the button.
		sel.setAttribute("tabindex", "-1");
		sel.setAttribute("aria-hidden", "true");
		sel.addEventListener("change", () => syncSel(sel));
		let btn = document.createElement("button");
		btn.type = "button";
		btn.className = "sel-btn";
		btn.setAttribute("aria-haspopup", "listbox");
		btn.setAttribute("aria-expanded", "false");
		let label = document.createElement("span");
		label.className = "sel-label";
		btn.appendChild(label);
		let caret = document.createElement("span");
		caret.className = "sel-caret";
		btn.appendChild(caret);
		wrap.appendChild(btn);
		btn.addEventListener("click", e => { e.stopPropagation(); openSelMenu(sel); });
		btn.addEventListener("keydown", e => {
			if (openSel && openSel.sel === sel) {
				if (e.key === "ArrowDown") { e.preventDefault(); openSel.move(1); }
				else if (e.key === "ArrowUp") { e.preventDefault(); openSel.move(-1); }
				else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSel.commit(); }
				else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSelMenu(); }
				return;
			}
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openSelMenu(sel); }
		});
		syncSel(sel);
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
		syncSel($("sort"));
	}
	function saveQuery() {
		let o = {};
		for (let f of QUERY_FIELDS) o[f] = $(f).value;
		PREF("lastQuery", JSON.stringify(o));
	}

	let cacheRestoreController;
	function cancelCacheRestore() {
		cacheRestoreController?.abort();
		cacheRestoreController = null;
	}

	async function restoreCachedSearch() {
		if ($("source").value !== "scholar" || typeof ZotPoPPoPBridge === "undefined" || state.searching || state.importing) return;
		let query = readQuery();
		if (![query.authors, query.venue, query.title, query.keywords].some(value => value.trim())) return;
		cancelCacheRestore();
		let controller = cacheRestoreController = new AbortController(), metadata;
		let signature = () => JSON.stringify([$("source").value, ...QUERY_FIELDS.map(key => $(key).value)]);
		let originalSignature = signature();
		let active = () => cacheRestoreController === controller && !controller.signal.aborted
			&& !state.searching && !state.importing && originalSignature === signature();
		let noNetwork = async () => { throw new Error("Network is disabled while restoring a cached search"); };
		let ctx = {
			signal: controller.signal, isCancelled: () => controller.signal.aborted,
			popCacheOnly: true, recoveryMaxResults: query.maxResults, errors: [],
			enrichCitations: false, journalMetrics: false,
			popSearch: async (q, context) => {
				let rows = await ZotPoPPoPBridge.search(q, { ...context, popCacheOnly: true });
				if (!rows?.cached || !rows?.partial) throw new Error("No cached search snapshot is available");
				metadata = { capturedAt: rows.capturedAt };
				return rows;
			}
		};
		try {
			let records = await ZotPoPSources.search("scholar", query, { getJSON: noNetwork, getText: noNetwork }, ctx);
			if (!active() || !records.length) return;
			await refreshLibraryFlags();
			if (!active()) return;
			state.sortKey = "rank";
			state.sortDir = "asc";
			displaySearchResults(records);
			let captured = new Date(metadata.capturedAt).toLocaleString(t.locale || undefined);
			setStatus(t("cacheRestored", records.length));
			showBanner(t("cacheRestoredNotice", captured));
		}
		catch (_) {
			// No recent matching snapshot is a normal startup condition. A live
			// search remains available and receives its own error reporting.
		}
		finally { if (cacheRestoreController === controller) cacheRestoreController = null; }
	}

	// ------------------------------------------------------------ layout persistence
	function restoreLayout() {
		let w = parseInt(PREF("metricsWidth"), 10);
		if (w >= 140 && w <= 500) $("metrics").style.width = w + "px";
		let h = parseInt(PREF("detailHeight"), 10);
		// A stored 0 used to come back as a dead strip with no way to grab the splitter
		if (h >= 60 && h <= 700) $("detail").style.height = h + "px";
		if (PREF("detailHidden") === true) setDetailVisible(false);
		// COL_VERSION guards against stale widths after the defaults change
		if (PREF("colWidthsVersion") === COL_VERSION) {
			try {
				let saved = JSON.parse(PREF("colWidths") || "{}");
				for (let k of Object.keys(DEFAULT_COLS)) if (saved[k] >= MIN_COL && saved[k] <= MAX_COL) state.colWidths[k] = saved[k];
			}
			catch (e) {}
		}
	}
	function saveLayout() {
		try {
			PREF("metricsWidth", $("metrics").offsetWidth);
			// offsetHeight is 0 for a hidden pane; saving that brings it back as a dead strip
			if (!$("detail").hidden) PREF("detailHeight", $("detail").offsetHeight);
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
					state.colWidths[key] = Math.min(MAX_COL, Math.max(MIN_COL, startW + (ev.clientX - startX)));
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
			// Double-clicking the grip restores the column's default width, so a column
			// dragged too narrow to read is recoverable without editing preferences.
			rz.addEventListener("dblclick", e => {
				e.preventDefault();
				e.stopPropagation();
				state.colWidths[key] = DEFAULT_COLS[key];
				applyColumnWidths();
				saveLayout();
				setStatus(t("columnReset"));
			});
			rz.setAttribute("title", t("columnResetTip"));
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
		syncSel(sel);
	}
	function currentTarget() {
		let [lib, col] = ($("target").value || "").split(":");
		return {
			libraryID: parseInt(lib, 10) || Zotero.Libraries.userLibraryID,
			collections: col ? [parseInt(col, 10)] : []
		};
	}

	// ------------------------------------------------------------ search
	function stopOperation() {
		state.cancelled = true;
		state.searchController?.abort();
		setStatus(t("stopping"));
	}

	function recordIdentities(record) {
		let ids = ["key:" + record.key];
		let doi = ZotPoPSources.normalizeDOI(record.doi);
		if (doi) ids.push("doi:" + doi);
		if (record.pmid) ids.push("pmid:" + record.pmid);
		if (record.arxiv) ids.push("arxiv:" + String(record.arxiv).replace(/v\d+$/, ""));
		return ids;
	}

	function displaySearchResults(records) {
		// A merged record may acquire a different source key. Carry row interaction
		// state through a shared identifier as well as an unchanged key.
		let previous = new Map();
		for (let r of state.records) {
			for (let id of recordIdentities(r)) {
				let flags = previous.get(id) || {};
				flags.selected ||= state.selected.has(r.key);
				flags.focused ||= state.focusKey === r.key;
				flags.detailed ||= state.detailKey === r.key;
				previous.set(id, flags);
			}
		}
		let selected = new Set(), focusKey = null, detailKey = null;
		state.records = records.map((record, i) => {
			let r = Object.assign({}, record, {
				rank: i + 1,
				authorString: (record.authors || []).map(a => a.name || [a.firstName, a.lastName].filter(Boolean).join(" ")).join(", "),
				status: "",
				inLibrary: Boolean(record.doi && state.doiMap.has(record.doi))
			});
			for (let id of recordIdentities(r)) {
				let flags = previous.get(id);
				if (flags?.selected) selected.add(r.key);
				if (flags?.focused) focusKey = r.key;
				if (flags?.detailed) detailKey = r.key;
			}
			return r;
		});
		state.selected = selected;
		state.focusKey = focusKey;
		state.detailKey = detailKey;
		// Keep received rows readable; progress continues in the status bar.
		$("busy").hidden = !state.searching || state.records.length > 0;
		render();
	}

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
		cancelCacheRestore();
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
		let controller = new AbortController();
		state.searchController = controller;
		let active = () => state.searchController === controller && !controller.signal.aborted;
		hideBanner();
		state.records = [];
		// The API layer already applies the requested search order. Preserve its rank
		// until the user explicitly sorts a result column again.
		state.sortKey = "rank";
		state.sortDir = "asc";
		$("filter").value = "";
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
			openAlexApiKey: PREF("openAlexApiKey") || "",
			enrichCitations: PREF("enrichCitations") !== false,
			journalMetrics: PREF("journalMetrics") !== false,
			DOMParser: window.DOMParser,
			popSearch: typeof ZotPoPPoPBridge !== "undefined" ? (query, context) => ZotPoPPoPBridge.search(query, context) : undefined,
			signal: controller.signal,
			isCancelled: () => controller.signal.aborted,
			onProgress: (msg, n, total) => {
				if (!active()) return;
				setStatus(msg); $("busy-text").textContent = msg; setProgress(n, total);
			},
			onResults: records => { if (active()) displaySearchResults(records); },
			log
		};
		try {
			let recs = await ZotPoPSources.search(sourceKey, q, http, ctx);
			if (!active()) throw abortError();
			displaySearchResults(recs);
			await refreshLibraryFlags();
			if (!active()) throw abortError();
			setStatus(t("resultCount", label, recs.length, false));
			if (ctx.errors?.length) {
				// A bare "HTTP 429" from OpenAlex is its exhausted daily budget, which the user
				// can actually fix; say so instead of showing the status code alone.
				let quota = ctx.errors.some(m => /openalex/i.test(m) && /429|budget|credit/i.test(m));
				showBanner(t("partialFail", ctx.errors.join(" / ")) + (quota ? " " + t("openAlexQuota") : ""));
			}
			if (!recs.length) setStatus(t("noResults", label));
			else if (q.sort === "date" && q.venue.trim()) setStatus(t("journalFeed", q.venue.trim(), recs.length));
			else if (!PREF("hintShown")) {
				PREF("hintShown", true);
				setStatus(t("firstHint", label, recs.length));
			}
		}
		catch (e) {
			if (state.searchController !== controller) return;
			if (controller.signal.aborted || e?.name === "AbortError") {
				state.cancelled = true;
				setStatus(t("searchStopped", state.records.length));
			}
			else {
				Zotero.logError(e);
				// An exhausted OpenAlex budget is the commonest failure and "HTTP 429" tells
				// the user nothing they can act on.
				let quota = e?.status === 429 && /budget|insufficient|credit/i.test(e?.body || e?.message || "");
				let text = quota ? t("openAlexQuota") : t("searchFailed", e.message || e);
				setStatus(text, "err");
				showBanner(text);
			}
		}
		finally {
			state.searching = false;
			state.searchController = null;
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
		cancelCacheRestore();
		if (state.searching) {
			state.cancelled = true;
			state.searchController?.abort();
			state.searchController = null;
			$("busy").hidden = true;
		}
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
		if (v == null) return ["citations", "year", "rank", "journalIF"].includes(k) ? -1 : "";
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
		if (!marquee) marquee = ZotPoPMarquee.attach(window, $("table-wrap"));
		else marquee.refresh();

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
		td("", r.authorString, r.authorString).dataset.marquee = "authors";

		let tt = td("title", null, r.title);
		tt.dataset.marquee = "title";
		let a = document.createElement("a");
		a.textContent = r.title;
		a.href = "#";
		a.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (r.url) Zotero.launchURL(r.url); });
		tt.appendChild(a);

		td("num", r.year == null ? "" : String(r.year));
		td("", r.venue, r.venue).dataset.marquee = "venue";
		td("num if", r.journalIF == null ? "" : fmt(r.journalIF, 1), r.journalIF == null ? "" : t("ifTip", fmt(r.journalIF, 1), r.journalH));
		td("", r.doi || "", r.doi || "").dataset.marquee = "doi";
		td("mini pdf", hasPDF(r) ? "●" : "", hasPDF(r) ? t("thPdfTip") : "");
		td("mini lib", r.inLibrary ? "✓" : "", r.inLibrary ? t("thLibTip") : "");
		let st = td("status", r.status || "", r.statusTitle || "");
		st.dataset.marquee = "status";
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
		$("preview-btn").disabled = !previewRecord();
		previewManager?.update(previewRecord());
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
	let previewManager;
	function previewRecord() {
		return state.records.find(r => r.key === state.focusKey)
			|| state.records.find(r => state.selected.has(r.key)) || detailRecord();
	}
	function openPreview(record = previewRecord()) {
		if (!record) return;
		if (!previewManager) previewManager = ZotPoPPreview.createManager(payload => window.openDialog(
			"chrome://zotpop/content/preview.xhtml", "zotpop-preview",
			"chrome,centerscreen,resizable=yes,dialog=no,width=860,height=960", payload
		));
		return previewManager.open(record, { Zotero, language: t.locale || PREF("language") || "en" });
	}
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
		if (r.journalIF != null) chip(t("badgeIF", fmt(r.journalIF, 1)), "if");
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
		$("d-preview").disabled = false;
		$("d-pdf").disabled = !((r.pdfUrls || [])[0] || r.pdfUrl);
		$("d-copy-doi").disabled = !r.doi;
		$("d-proxy").disabled = !proxyLanding(r);
		$("d-add").disabled = state.importing || state.searching;
		$("d-check").disabled = state.checking || !(r.doi || r.arxiv || r.pmid || (r.source === "openalex" && r.sourceId));
	}

	// Re-query every free source for one paper's current citation count and its journal's impact
	async function checkCitations(r) {
		if (!r || state.checking) return;
		state.checking = true;
		$("d-check").disabled = true;
		setStatus(t("citeChecking"));
		try {
			let res = await ZotPoPSources.checkCitations(r, http, { email: PREF("email") || "", s2ApiKey: PREF("s2ApiKey") || "", openAlexApiKey: PREF("openAlexApiKey") || "", log });
			let parts = [["openalex", res.openalex], ["crossref", res.crossref], ["semanticscholar", res.semanticscholar]]
				.filter(([, v]) => v != null).map(([k, v]) => sourceLabel(k) + " " + v);
			if (!parts.length) setStatus(t("citeCheckNone"), "err");
			else setStatus(t("citeCheckResult", parts.join(" · "), r.journalIF == null ? null : fmt(r.journalIF, 1)));
			render();
		}
		catch (e) {
			log("citation check failed: " + e.message);
			setStatus(t("citeCheckFailed", e.message || String(e)), "err");
		}
		finally {
			state.checking = false;
			renderDetail();
		}
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
		add(t("previewAction"), () => openPreview(r));
		add(t("ctxPdf"), () => Zotero.launchURL((r.pdfUrls || [])[0] || r.pdfUrl), !((r.pdfUrls || [])[0] || r.pdfUrl));
		add(t("ctxProxy"), () => openViaProxy(r), !proxyLanding(r));
		menu.appendChild(document.createElement("hr"));
		add(t("ctxCopyTitle"), () => copyText(r.title, t("copiedTitle")));
		add(t("ctxCopyDoi"), () => copyText(r.doi, t("copiedDoi")), !r.doi);
		add(t("ctxCopyCite"), () => copyText(citationText(r), t("copiedCite")));
		menu.appendChild(document.createElement("hr"));
		add(t("ctxCheck"), () => checkCitations(r), state.checking || !(r.doi || r.arxiv || r.pmid || (r.source === "openalex" && r.sourceId)));
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
			if (openSel) { closeSelMenu(); return; }
			if (!$("ctxmenu").hidden) { hideCtxMenu(); return; }
			if (state.searching || state.importing) { stopOperation(); return; }
			return;
		}
		if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("filter").focus(); $("filter").select(); return; }
		if (mod && e.key === "Enter") { e.preventDefault(); runSearch(); return; }
		if (mod && e.key.toLowerCase() === "w") { window.close(); return; }
		// Keys typed into a form field belong to that field, Cmd/Ctrl+A included: hijacking
		// it made select-all in the query boxes select every result row instead.
		if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectVisible(true); return; }
		if (!mod && !e.altKey && e.key.toLowerCase() === "p") { e.preventDefault(); openPreview(); return; }
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
				r.year ?? "", r.venue, r.journalIF == null ? "" : fmt(r.journalIF, 2), r.publisher, r.doi ?? "", r.url ?? "",
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
		if (td) {
			td.textContent = text; td.className = "status " + (cls || ""); td.title = title || "";
			marquee?.refreshCell(td);
		}
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
