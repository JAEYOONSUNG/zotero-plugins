/* global Zotero, Services, Ci, IOUtils, PathUtils, CSS, ZotPoPI18N, ZotPoPSources, ZotPoPMetrics, ZotPoPImporter, ZotPoPPoPBridge, ZotPoPPreview, ZotPoPMarquee, ZotPoPHistory, ZotPoPAffiliations, ZotPoPJournalMarks */
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
	// Wider text columns: at the old widths a title showed eight words and an
	// author list two names, and every one of them rolled at once.
	const DEFAULT_COLS = {
		chk: 28, citations: 56, cpy: 74, rank: 60, authorString: 190, title: 320,
		year: 58, venue: 150, journalIF: 48, affiliation: 150, country: 62, tier: 56,
		doi: 150, pdf: 44, inLibrary: 44, status: 96
	};

	// 8: Year, Rank and Per year were narrower than their own digits ("20…", "Ra…").
	const COL_VERSION = 8;
	const COLUMN_KEYS = Object.keys(DEFAULT_COLS);
	// Narrower than this and a column cannot show its own content (a 4-digit year needs ~56px with its padding)
	const MIN_COL = 40;
	// An unbounded drag used to persist a column wider than the window
	const MAX_COL = 900;

	// Localised string lookup; replaced in init() once the pref is read.
	let t = ZotPoPI18N.make("en");

	// Source labels that should follow the UI language rather than the API's own name
	const SOURCE_LABEL_KEYS = { multi: "srcMulti", preprint: "srcPreprint", europepmc: "srcEuropePMC", scholar: "srcScholar" };
	const SVG_NS = "http://www.w3.org/2000/svg";
	// innerHTML is not available on createElementNS elements in Gecko, so each
	// shape is built as a node.
	function brandMark(key, size) {
		let lib = typeof ZotPoPBrandIcons !== "undefined" ? ZotPoPBrandIcons : null;
		if (!lib) return null;
		let drawn = lib.shape(lib.iconFor(key));
		if (!drawn) return null;
		let svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", drawn.viewBox);
		svg.setAttribute("width", String(size || 12));
		svg.setAttribute("height", String(size || 12));
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("focusable", "false");
		svg.setAttribute("class", "brand-mark");
		if (drawn.kind === "fill") svg.setAttribute("fill", "currentColor");
		else {
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "1.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
		}
		for (let [tag, attrs] of drawn.parts) {
			let node = document.createElementNS(SVG_NS, tag);
			for (let [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
			svg.appendChild(node);
		}
		return svg;
	}

	function sourceLabel(key) {
		if (key === "orcid") return "ORCID";
		let k = SOURCE_LABEL_KEYS[key];
		return engineValue() === "pop" ? (ZotPoPSources.POP_SOURCES?.[key]?.label || key)
			: k ? t(k) : (ZotPoPSources.SOURCES[key]?.label || key);
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
		colWidths: Object.assign({}, DEFAULT_COLS),
		colOrder: [...COLUMN_KEYS]
	};
	let marquee = null;
	let history = null;
	let searchSurface = "papers";
	const surfaceSnapshots = new Map();
	const authorSessions = { scholar: { input: "", profiles: [], profile: null, action: "profiles" }, orcid: { input: "", profiles: [], profile: null, action: "profiles" } };
	let activeAuthorProvider = "scholar";
	let authorAction = "profiles";

	// ------------------------------------------------------------ files
	// Where ZotPoP keeps what it learned: recent searches with their results, and the
	// journal and institution figures every search would otherwise ask OpenAlex for again.
	function diskIO() {
		if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined" || !Zotero.DataDirectory?.dir) return null;
		return {
			readText: path => IOUtils.readUTF8(path),
			writeText: (path, text) => IOUtils.writeUTF8(path, text),
			remove: path => IOUtils.remove(path, { ignoreAbsent: true }),
			exists: path => IOUtils.exists(path),
			makeDir: dir => IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true })
		};
	}
	function dataPath(...parts) {
		return typeof PathUtils !== "undefined" && Zotero.DataDirectory?.dir ? PathUtils.join(Zotero.DataDirectory.dir, "zotpop", ...parts) : parts.join("/");
	}
	function setupStorage() {
		let io = diskIO() || ZotPoPHistory.memoryIO();
		let size = parseInt(PREF("historySize"), 10);
		history = ZotPoPHistory.create({ io, dir: dataPath("history"), join: typeof PathUtils !== "undefined" ? PathUtils.join : undefined,
			max: size > 0 ? size : 30, maxBytes: 64 * 1024 * 1024 });
		return io;
	}
	let cacheIO = null;
	async function loadCaches() {
		if (!cacheIO || !ZotPoPSources.importCaches) return;
		try { ZotPoPSources.importCaches(JSON.parse(await cacheIO.readText(dataPath("cache.json")))); }
		catch (_) { /* first run, or a damaged file: the lookups simply happen again */ }
	}
	async function saveCaches() {
		if (!cacheIO || !ZotPoPSources.exportCaches) return;
		try { await cacheIO.writeText(dataPath("cache.json"), JSON.stringify(ZotPoPSources.exportCaches())); }
		catch (e) { log("saving lookup cache failed: " + e.message); }
	}

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
		// The host says which service failed; the path and query are for the log.
		let host = ""; try { host = new URL(url).host; } catch (ignored) { host = url.split("?")[0]; }
		let err = new Error(msg + " · " + host);
		err.url = url.split("?")[0];
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

	let statusRevert = null, lastStatus = { msg: "", cls: "" };
	// Timers by whichever global has them: the window in Zotero, none in the test sandbox.
	const later = (fn, ms) => (typeof setTimeout === "function" ? setTimeout(fn, ms) : typeof window !== "undefined" && window.setTimeout ? window.setTimeout(fn, ms) : null);
	const cancelLater = id => { if (id == null) return; if (typeof clearTimeout === "function") clearTimeout(id); else if (typeof window !== "undefined" && window.clearTimeout) window.clearTimeout(id); };
	function setStatus(msg, cls, options = {}) {
		if (statusRevert != null) { cancelLater(statusRevert); statusRevert = null; }
		$("status").textContent = msg;
		$("statusbar").classList.toggle("err", cls === "err");
		// "DOI copied." is news for a moment, not a state to read back later.
		if (options.transient) statusRevert = later(() => { statusRevert = null; setStatus(lastStatus.msg, lastStatus.cls); }, 4000);
		else lastStatus = { msg, cls };
	}
	function setProgress(value, max) {
		let p = $("progress");
		if (value == null) { p.hidden = true; return; }
		p.hidden = false;
		p.max = Math.max(1, max || 100);
		p.value = Math.min(p.max, value);
	}
	let bannerAction = null;
	function showBanner(text, action) {
		$("banner-text").textContent = text;
		// A banner can carry one verb: what to do about what it says.
		bannerAction = action && typeof action.run === "function" ? action : null;
		let btn = $("banner-action");
		if (btn) { btn.hidden = !bannerAction; btn.textContent = bannerAction ? bannerAction.label : ""; }
		$("banner").hidden = false;
	}
	/* Scholar's two walls, and the one cure for both: a window inside Zotero,
	   sharing its cookies, where the human answers the CAPTCHA or signs in.
	   When that window closes, the interrupted search runs again by itself. */
	function scholarWallBanner(error, retry) {
		let key = error.wall === "login" ? "scholarWallLogin" : "scholarWallCaptcha";
		showBanner(t(key), { label: t("scholarOpen"), run: () => {
			let plugin = typeof Zotero !== "undefined" ? Zotero.ZotPoP : null;
			let win = plugin && typeof plugin.openScholarSession === "function" ? plugin.openScholarSession(error.url) : null;
			if (!win) { Zotero.launchURL(error.url || "https://scholar.google.com"); return; }
			hideBanner();
			try { win.addEventListener("unload", () => { setTimeout(() => { if (typeof retry === "function") retry(); }, 400); }, { once: true }); } catch (e) { log("scholar session: " + e.message); }
		} });
	}
	function hideBanner() { $("banner").hidden = true; }

	function fmt(n, d = 2) {
		if (n == null || !Number.isFinite(n)) return "–";
		return Number.isInteger(n) && d === 0 ? String(n) : n.toFixed(d);
	}

	// ------------------------------------------------------------ init
	function init() {
		let locale = ZotPoPI18N.resolveLocale(PREF("language") || "auto", Zotero.locale || Services.locale?.appLocaleAsBCP47);
		t = ZotPoPI18N.make(locale);
		document.documentElement.setAttribute("lang", locale);
		ZotPoPI18N.apply(document, t);
		document.title = t("windowTitle");

		$("engine").value = PREF("searchEngine") === "pop" ? "pop" : "direct";
		let sel = $("source");
		// A saved preference always beats the shipped default, so every profile
		// that used ZotPoP before the combined search existed stayed pinned to a
		// single source -- which is exactly the "it only searches one API"
		// complaint. Move those over once, and never touch a later choice.
		if (!PREF("multiSourceMigrated")) {
			if (PREF("defaultSource") === "openalex") PREF("defaultSource", "multi");
			PREF("multiSourceMigrated", true);
		}
		// The fallback has to agree with prefs.js; hard-coding a single source
		// here quietly overrode the shipped default of "multi".
		populateSearchSources();
		populatePoPOutputSort();
		for (let id of ["engine", "source", "sort", "popOutputSort", "popCachePolicy", "target"]) enhanceSelect($(id));

		restoreQuery();
		restoreAuthorPreferences();
		searchSurface = PREF("searchSurface") === "authors" ? "authors" : "papers";
		$("opt-pdf").checked = PREF("attachPDF") !== false;
		$("opt-skip").checked = PREF("skipDuplicates") !== false;
		$("opt-extra").checked = PREF("citationsInExtra") !== false;

		restoreLayout();
		populateTargets();
		cacheIO = setupStorage();
		wireEvents();
		applySearchSurface();
		sourceHint();
		applyColumnWidths();
		setDetailVisible(!$("detail").hidden);
		setStatus(PREF("hintShown") ? t("ready") : t("welcome"));
		render();
		{ let field = $(searchSurface === "authors" ? "author-input" : "keywords"); field.focus(); if (field.value) field.select(); }
		loadCaches().finally(restoreCachedSearch);
	}

	function wireEvents() {
		$("mode-papers").addEventListener("click", () => switchSearchMode("papers"));
		$("mode-authors").addEventListener("click", () => switchSearchMode("authors"));
		$("author-form").addEventListener("submit", e => { e.preventDefault(); runAuthorAction("profiles"); });
		$("author-input").addEventListener("input", authorInputChanged);
		$("author-input-kind").addEventListener("change", authorInputChanged);
		$("author-max-results").addEventListener("change", () => { if (searchSurface === "authors") state.searchController?.abort(); saveAuthorPreferences(); });
		$("author-provider").addEventListener("change", () => switchAuthorProvider($("author-provider").value));
		$("author-name-btn").addEventListener("click", () => runAuthorAction("name-papers"));
		$("author-stop-btn").addEventListener("click", stopOperation);
		$("author-history-btn").addEventListener("click", e => { e.stopPropagation(); toggleHistoryMenu(); });
		$("query-form").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
		$("query-form").addEventListener("input", cancelCacheRestore);
		$("query-form").addEventListener("change", cancelCacheRestore);
		$("stop-btn").addEventListener("click", stopOperation);
		$("clear-btn").addEventListener("click", clearAll);
		$("history-btn").addEventListener("click", e => { e.stopPropagation(); toggleHistoryMenu(); });
		$("banner-close").addEventListener("click", hideBanner);
		$("banner-action")?.addEventListener("click", () => { if (bannerAction) bannerAction.run(); });
		// A beat after the last key, not per key: with a thousand rows every
		// keystroke rebuilt the table, and Hangul composition fires one per jamo.
		let filterTimer = null;
		$("filter").addEventListener("input", () => { syncFilterClear(); clearTimeout(filterTimer); filterTimer = setTimeout(() => { filterTimer = null; render(); }, 120); });
		$("filter").addEventListener("keydown", e => { if (e.key === "ArrowDown") { e.preventDefault(); $("table-wrap").focus(); } });
		$("filter-clear")?.addEventListener("click", () => { clearFilter(); $("filter").focus(); });
		syncFilterClear();
		$("chk-all").addEventListener("change", e => selectVisible(e.target.checked));
		$("select-all").addEventListener("click", () => selectVisible(true));
		$("select-none").addEventListener("click", () => { state.selected.clear(); render(); });
		$("select-new").addEventListener("click", () => {
			state.selected.clear();
			for (let r of state.visible) if (!r.inLibrary) state.selected.add(r.key);
			render();
		});
		$("copy-csv").addEventListener("click", copyCSV);
		$("copy-pop-json")?.addEventListener("click", () => copyText(popOriginalJSON(), t("popJSONCopied")));
		$("save-csv").addEventListener("click", saveCSV);
		$("toggle-detail").addEventListener("click", toggleDetail);
		$("toggle-metrics")?.addEventListener("click", toggleMetrics);
		// An in-page select menu closes when focus leaves it, so Tab does not leave it floating.
		if (typeof document.addEventListener === "function") document.addEventListener("focusin", e => { if (openSel && !openSel.menu?.contains?.(e.target) && e.target !== selButton(openSel.sel)) closeSelMenu(); });
		$("preview-btn").addEventListener("click", () => openPreview());
		$("import-btn").addEventListener("click", () => importRecords(state.records.filter(r => state.selected.has(r.key))));
		$("target").addEventListener("change", () => { state.doiMap.clear(); refreshLibraryFlags(); });
		$("source").addEventListener("change", sourceHint);
		$("engine").addEventListener("change", () => { cancelCacheRestore(); populateSearchSources(); sourceHint(); savePrefs(); saveQuery(); });
		$("pop-options")?.addEventListener("input", cancelCacheRestore);
		$("popOutputSort")?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });
		$("popCachePolicy")?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });
		for (let key of COMBINED_SOURCES) $("multi-source-" + key)?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });

		setupColumnOrder();
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
		document.addEventListener("click", () => { hideCtxMenu(); closeSelMenu(); closeHistoryMenu(); });
		window.addEventListener("blur", () => { closeSelMenu(); closeHistoryMenu(); });
		window.addEventListener("resize", () => { closeSelMenu(); closeHistoryMenu(); });
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

	function selButton(sel) { return sel.parentNode?.querySelector?.(".sel-btn") || null; }

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
		if (event.target?.classList?.contains("marquee-text")) return;
		// Nor may the menu's own scrolling: a library with more collections than fit
		// the list scrolls to the current one as it opens, and closing on that left
		// the "Add to" menu unable to open at all.
		if (openSel && (event.target === openSel.menu || openSel.menu?.contains?.(event.target))) return;
		if (!$("histmenu").hidden && (event.target === $("histmenu") || $("histmenu").contains?.(event.target))) return;
		closeSelMenu();
		closeHistoryMenu();
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
		PREF(engineValue() === "pop" ? "popDefaultSource" : "defaultSource", $("source").value);
		PREF("searchEngine", engineValue());
		PREF("attachPDF", $("opt-pdf").checked);
		PREF("skipDuplicates", $("opt-skip").checked);
		PREF("citationsInExtra", $("opt-extra").checked);
		let m = parseInt($("maxResults").value, 10);
		if (m > 0) PREF("maxResults", m);
	}

	function populatePoPOutputSort() {
		let select = $("popOutputSort"), labels = { rank: "popRank", author: "authors", cites: "thCites", cites_annual: "thPerYear", cites_norm: "popCitesNorm", source: "venue", title: "thTitle", year: "years" };
		select.textContent = "";
		for (let [key, label] of Object.entries(labels)) for (let direction of ["", "-"]) { let option = document.createElement("option"); option.value = direction + key; option.textContent = t(label) + (direction ? " ↓" : " ↑"); select.appendChild(option); }
		select.value = "rank";
	}

	function engineValue() { return $("engine")?.value === "pop" ? "pop" : "direct"; }
	function populateSearchSources(preferred) {
		let pop = engineValue() === "pop", select = $("source");
		let registry = pop ? ZotPoPSources.POP_SOURCES || {} : ZotPoPSources.SOURCES;
		let choice = preferred || PREF(pop ? "popDefaultSource" : "defaultSource") || (pop ? "scholar" : "multi");
		select.textContent = "";
		for (let key of Object.keys(registry)) { let option = document.createElement("option"); option.value = key; option.textContent = sourceLabel(key); select.appendChild(option); }
		select.value = Object.prototype.hasOwnProperty.call(registry, choice) ? choice : pop ? "scholar" : "multi";
		syncSel(select);
	}
	function sourceHint() {
		if (searchSurface === "authors") {
			$("combined-options").hidden = true; $("pop-options").hidden = true;
			updateAuthorHint(); return;
		}
		let key = $("source").value;
		let pop = engineValue() === "pop";
		$("authors").setAttribute("placeholder", t(pop ? "popAuthorsPh" : "authorsPh"));
		$("authors").setAttribute("title", t(pop ? "popAuthorsHelp" : "authorsHelp"));
		$("title").setAttribute("title", t(pop ? "popTitleHelp" : "titleHelp"));
		if ($("combined-options")) $("combined-options").hidden = pop || key !== "multi";
		if ($("pop-options")) $("pop-options").hidden = !pop;
		if ($("direct-sort-field")) $("direct-sort-field").hidden = pop;
		if ($("pop-sort-field")) $("pop-sort-field").hidden = !pop;
		if (pop) { showBanner(t("popModeNotice")); return; }
		if (key === "semanticscholar" && !(PREF("s2ApiKey") || "").trim()) showBanner(t("bannerS2"));
		else if (key === "openalex" && !String(PREF("openAlexApiKey") || "").trim()) showBanner(t("bannerNoKey"));
		else if (key === "scholar") showBanner(t("bannerScholar"));
		else if (key === "preprint") showBanner(t("bannerPreprint"));
		else if (key === "multi") showBanner(t("bannerMulti"));
		else hideBanner();
	}

	function currentSurfaceKey() { return searchSurface === "authors" ? "author:" + activeAuthorProvider : "papers"; }
	function saveSurfaceResults() {
		surfaceSnapshots.set(currentSurfaceKey(), { records: state.records, selected: new Set(state.selected), focusKey: state.focusKey,
			detailKey: state.detailKey, sortKey: state.sortKey, sortDir: state.sortDir, filter: $("filter").value });
	}
	function restoreSurfaceResults() {
		let saved = surfaceSnapshots.get(currentSurfaceKey());
		Object.assign(state, saved || { records: [], selected: new Set(), focusKey: null, detailKey: null, sortKey: "rank", sortDir: "asc" });
		$("filter").value = saved?.filter || "";
	}
	function applySearchSurface() {
		$("query-form").hidden = searchSurface === "authors";
		$("author-panel").hidden = searchSurface !== "authors";
		$("mode-papers").setAttribute("aria-pressed", String(searchSurface === "papers"));
		$("mode-authors").setAttribute("aria-pressed", String(searchSurface === "authors"));
		sourceHint(); renderAuthorProfiles();
	}
	async function settleActiveSearch() {
		if (state.searching) { state.searchController?.abort(); try { await state.searchDone; } catch (_) {} }
	}
	async function switchSearchMode(mode) {
		if (state.importing || !["papers", "authors"].includes(mode)) return;
		cancelCacheRestore(); while (state.searching) await settleActiveSearch();
		if (searchSurface !== mode) { saveSurfaceResults(); searchSurface = mode; restoreSurfaceResults(); }
		PREF("searchSurface", mode); applySearchSurface(); hideBanner(); setStatus(t("ready")); render();
	}
	async function switchAuthorProvider(provider) {
		if (!["scholar", "orcid"].includes(provider)) return;
		if (state.importing) { $("author-provider").value = activeAuthorProvider; return; }
		cancelCacheRestore(); while (state.searching) await settleActiveSearch();
		authorSessions[activeAuthorProvider].input = $("author-input").value;
		if (activeAuthorProvider === "scholar") authorSessions.scholar.inputKind = $("author-input-kind").value || "auto";
		if (searchSurface === "authors") saveSurfaceResults();
		activeAuthorProvider = provider; $("author-provider").value = provider;
		authorAction = authorSessions[provider].action;
		$("author-input").value = authorSessions[provider].input;
		$("author-input-kind").value = authorSessions[provider].inputKind || "auto";
		if (searchSurface === "authors") restoreSurfaceResults();
		saveAuthorPreferences(); updateAuthorHint(); renderAuthorProfiles(); hideBanner(); setStatus(t("ready")); render();
	}
	function saveAuthorPreferences() {
		authorSessions[activeAuthorProvider].input = $("author-input").value;
		if (activeAuthorProvider === "scholar") authorSessions.scholar.inputKind = $("author-input-kind").value || "auto";
		PREF("lastAuthorQuery", JSON.stringify({ provider: activeAuthorProvider, inputKind: $("author-input-kind").value || "auto", maxResults: $("author-max-results").value,
			sessions: Object.fromEntries(Object.entries(authorSessions).map(([key, value]) => [key, { input: value.input, profile: value.profile, action: value.action, inputKind: value.inputKind }])) }));
	}
	function restoreAuthorPreferences() {
		let saved = {}; try { saved = JSON.parse(PREF("lastAuthorQuery") || "{}"); } catch (_) {}
		activeAuthorProvider = saved.provider === "orcid" ? "orcid" : "scholar";
		for (let key of ["scholar", "orcid"]) {
			let session = saved.sessions?.[key];
			authorSessions[key].input = typeof session?.input === "string" ? session.input : "";
			authorSessions[key].action = ["profiles", "publications", "name-papers"].includes(session?.action) ? session.action : "profiles";
			authorSessions[key].inputKind = ["name", "profile"].includes(session?.inputKind) ? session.inputKind : "auto";
			if (session?.profile?.provider === key && typeof session.profile.id === "string") {
				authorSessions[key].profile = session.profile; authorSessions[key].profiles = [session.profile];
			}
		}
		$("author-provider").value = activeAuthorProvider;
		$("author-input-kind").value = authorSessions[activeAuthorProvider].inputKind;
		authorAction = authorSessions[activeAuthorProvider].action;
		$("author-input").value = authorSessions[activeAuthorProvider].input;
		let max = Number(saved.maxResults); $("author-max-results").value = Number.isInteger(max) && max >= 1 && max <= 2000 ? String(max) : "1000";
	}
	function updateAuthorHint() {
		let orcid = activeAuthorProvider === "orcid";
		$("author-input-label").textContent = t(orcid ? "authorOrcidInput" : "authorScholarInput");
		$("author-help").textContent = t(orcid ? "authorOrcidHelp" : "authorScholarHelp");
		$("author-name-btn").hidden = orcid;
		$("author-input-kind-field").hidden = orcid;
	}
	function authorInputChanged() {
		cancelCacheRestore();
		if (searchSurface === "authors") state.searchController?.abort();
		let session = authorSessions[activeAuthorProvider]; session.profiles = []; session.profile = null; session.action = authorAction = "profiles";
		saveAuthorPreferences(); renderAuthorProfiles();
	}
	function renderAuthorProfiles() {
		let host = $("author-profiles"), session = authorSessions[activeAuthorProvider]; host.textContent = "";
		for (let profile of session.profiles) {
			let card = document.createElement("article"); card.className = "author-profile";
			if (session.profile && profile.id === session.profile.id && profile.name === session.profile.name) card.classList.add("selected");
			let info = document.createElement("div"); info.className = "author-profile-info";
			let line = (cls, value) => { let node = document.createElement("div"); node.className = cls; node.textContent = value; info.appendChild(node); };
			line("author-profile-name", profile.name || profile.id || t("authorNameUnverified"));
			if (profile.affiliation) line("author-profile-meta", profile.affiliation);
			if (profile.id) line("author-profile-meta", profile.id);
			line("author-profile-meta", t(profile.mode === "name-search" ? "authorNameUnverified" : profile.identityConfirmed ? "authorIdentityConfirmed" : "authorIdentityPending"));
			let actions = document.createElement("div"); actions.className = "author-profile-actions";
			if (profile.id) { let load = document.createElement("button"); load.type = "button"; load.textContent = t("authorLoadWorks"); load.disabled = state.searching || state.importing;
				load.addEventListener("click", () => runAuthorAction("publications", profile)); actions.appendChild(load); }
			if (/^https:\/\//i.test(profile.url || "")) { let open = document.createElement("button"); open.type = "button"; open.textContent = t("authorOpenProfile");
				open.addEventListener("click", () => Zotero.launchURL(profile.url)); actions.appendChild(open); }
			card.appendChild(info); card.appendChild(actions); host.appendChild(card);
		}
	}
	function authorQuery(action = authorAction, profile = authorSessions[activeAuthorProvider].profile) {
		return { mode: "author", authorProvider: activeAuthorProvider, authorInput: $("author-input").value,
			authorAction: action, authorProfileId: action === "publications" ? profile?.id || "" : "",
			maxResults: $("author-max-results").value.trim() ? Number($("author-max-results").value) : 1000,
			...(activeAuthorProvider === "scholar" ? { authorInputKind: $("author-input-kind").value || "auto", popProfile: String(PREF("popDataDir") || "pop-default") } : {}) };
	}
	async function restoreAuthorHistory() {
		if (state.searching || state.importing || !history || !$("author-input").value.trim()) return;
		cancelCacheRestore(); let controller = cacheRestoreController = new AbortController();
		let query = authorQuery(), signature = JSON.stringify(query);
		let active = () => cacheRestoreController === controller && !controller.signal.aborted && !state.searching && searchSurface === "authors" && JSON.stringify(authorQuery()) === signature;
		try {
			let saved = await history.find("author:" + query.authorProvider, query), entry = saved && await history.get(saved.id);
			if (entry && active()) await showAuthorHistory(entry, active);
		} catch (error) { log("author history restore failed: " + error.message); }
		finally { if (cacheRestoreController === controller) cacheRestoreController = null; }
	}
	async function showAuthorHistory(entry, active = () => true) {
		let query = entry.query || {}, provider = query.authorProvider;
		if (!["scholar", "orcid"].includes(provider)) return false;
		await refreshLibraryFlags(); if (!active()) return false;
		if (activeAuthorProvider !== provider) { saveSurfaceResults(); activeAuthorProvider = provider; }
		$("author-provider").value = provider; $("author-input").value = query.authorInput || "";
		$("author-input-kind").value = query.authorInputKind || "auto";
		$("author-max-results").value = String(query.maxResults || 1000);
		let session = authorSessions[provider]; session.input = $("author-input").value;
		session.inputKind = query.authorInputKind || "auto";
		session.profile = query.authorProfile || entry.records?.[0]?.authorProfile || null;
		session.profiles = Array.isArray(query.authorProfiles) && query.authorProfiles.length ? query.authorProfiles : session.profile ? [session.profile] : [];
		session.action = authorAction = query.authorAction || "profiles";
		state.selected.clear(); state.focusKey = null; state.detailKey = null; $("filter").value = "";
		state.sortKey = entry.records.some(r => r.popOriginal) ? "popOrdinal" : "rank"; state.sortDir = "asc";
		displaySearchResults(entry.records); updateAuthorHint(); renderAuthorProfiles(); saveAuthorPreferences();
		setStatus(query.authorAction === "profiles" ? t("authorProfilesFound", session.profiles.length) : t("historyRestored", entry.records.length));
		showBanner(t("historyRestoredNotice", new Date(entry.savedAt).toLocaleString(t.locale || undefined), Boolean(entry.partial))
			+ (query.authorAction === "name-papers" ? " " + t("authorNameUnverified") : provider === "orcid" ? " " + t("authorOrcidHelp") : popHistoryNotice(entry)));
		return true;
	}
	async function abortableAuthorTask(task, signal) {
		let rejectAbort; const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(abortError()); signal.addEventListener("abort", rejectAbort, { once: true }); if (signal.aborted) rejectAbort(); });
		try { return await Promise.race([task, interrupted]); }
		finally { signal.removeEventListener("abort", rejectAbort); }
	}
	async function runAuthorAction(action = "profiles", profile = null) {
		if (state.importing) return;
		while (state.searching) await settleActiveSearch(); cancelCacheRestore();
		if (searchSurface !== "authors") return;
		let q = authorQuery(action, profile), input = q.authorInput;
		if (!input.trim()) { setStatus(t("authorNeedInput"), "err"); return; }
		if (!Number.isInteger(q.maxResults) || q.maxResults < 1 || q.maxResults > 2000) { setStatus(t("needCriteria"), "err"); return; }
		if (typeof ZotPoPAuthors === "undefined") { setStatus(t("authorModuleUnavailable"), "err"); return; }
		if (action === "name-papers" && (activeAuthorProvider !== "scholar" || q.authorInputKind === "profile" || ZotPoPAuthors.parseOrcid(input) || /https?:\/\//i.test(input))) { setStatus(t("authorNeedName"), "err"); return; }
		if (action === "publications" && (!profile?.id || profile.provider !== activeAuthorProvider)) return;
		authorAction = action;
		let session = authorSessions[activeAuthorProvider];
		session.action = action;
		if (action !== "publications") { session.profiles = []; session.profile = null; } else session.profile = profile;
		saveAuthorPreferences();
		state.records = []; state.selected.clear(); state.focusKey = null; state.detailKey = null; $("filter").value = "";
		state.searching = true; state.cancelled = false;
		let resolveDone; state.searchDone = new Promise(resolve => { resolveDone = resolve; });
		let controller = state.searchController = new AbortController();
		let active = () => state.searchController === controller && !controller.signal.aborted && searchSurface === "authors"
			&& activeAuthorProvider === q.authorProvider && $("author-input").value === q.authorInput;
		let received = [], profiles = [], message = t(action === "profiles" ? "authorLookup" : "authorLoading"), fallbackToName = false;
		$("author-search-btn").disabled = true; $("author-name-btn").disabled = true; $("author-stop-btn").disabled = false;
		$("search-btn").disabled = true; $("busy").hidden = action === "profiles"; $("busy-text").textContent = message;
		setStatus(message); hideBanner(); renderAuthorProfiles(); render();
		let ctx = { signal: controller.signal, isCancelled: () => controller.signal.aborted, errors: [], scholarInputKind: q.authorInputKind || "auto", DOMParser: window.DOMParser,
			popSearchSource: typeof ZotPoPPoPBridge !== "undefined" && ZotPoPPoPBridge.searchSource ? (source, query, context) => ZotPoPPoPBridge.searchSource(source, query, context) : undefined,
			onProgress: (msg, n, total) => { if (active()) { setStatus(msg); setProgress(n, total); } },
			onResults: records => { if (active()) { received = records; state.sortKey = records.some(r => r.popOriginal) ? "popOrdinal" : "rank"; state.sortDir = "asc"; displaySearchResults(records); } }, log };
		try {
			let options = { maxResults: q.maxResults, popOutputSort: "rank" };
			let task = action === "profiles" ? ZotPoPAuthors.searchProfiles(q.authorProvider, input, http, ctx)
				: action === "name-papers" ? ZotPoPAuthors.loadNamePublications(input, options, http, ctx) : ZotPoPAuthors.loadPublications(profile, options, http, ctx);
			let result = await abortableAuthorTask(task, controller.signal);
			if (!active()) throw abortError();
			if (action === "profiles") { profiles = result; session.profiles = result; setStatus(result.length ? t("authorProfilesFound", result.length) : t("authorNoProfiles")); }
			else {
				received = result; session.profile = { ...(profile || {}), ...(result.authorProfile || result.profile || profile || {}) };
				if (session.profile.provider) {
					if (action === "publications" && session.profiles.some(item => item.id === session.profile.id)) session.profiles = session.profiles.map(item => item.id === session.profile.id ? session.profile : item);
					else session.profiles = [session.profile];
				}
				state.sortKey = result.some(r => r.popOriginal) ? "popOrdinal" : "rank"; state.sortDir = "asc";
				displaySearchResults(result); await refreshLibraryFlags(); if (!active()) throw abortError();
				let partial = Boolean(result.partial || ctx.errors.length);
				setStatus(t(partial ? "incompleteResults" : "resultCount", q.authorProvider === "orcid" ? "ORCID" : "Google Scholar", result.length, false));
				showBanner(t(action === "name-papers" ? "authorNameUnverified" : q.authorProvider === "orcid" ? "authorOrcidHelp" : "popModeNotice")
					+ (result.authorProvenance?.truncated ? " " + t("authorLimited", result.length, result.authorProvenance.totalGroups) : ""));
			}
			if (ctx.errors.length) showBanner(t("partialFail", ctx.errors.join(" / ")));
			await history?.save({ source: "author:" + q.authorProvider, query: { ...q, authorProfile: session.profile, authorProfiles: session.profiles },
				records: stripDisplayFields(received), partial: Boolean(received.partial || ctx.errors.length) });
			saveAuthorPreferences();
		} catch (error) {
			if (state.searchController !== controller) return;
			if (controller.signal.aborted || error.name === "AbortError") {
				state.cancelled = true; setStatus(t("searchStopped", received.length));
				if (received.length) await history?.save({ source: "author:" + q.authorProvider, query: { ...q, authorProfile: session.profile }, records: stripDisplayFields(received), partial: true });
			}
			// A profile lookup that hit Google's login wall: the paper search by
			// name is still open, so run it rather than leave an empty table.
			else if (action === "profiles" && q.authorProvider === "scholar" && error.reason === "login" && q.authorInputKind !== "profile" && !/https?:\/\//i.test(input)) {
				fallbackToName = true; setStatus(t("searchFailed", error.message || error), "err");
			}
			else if (error.wall) { setStatus(t("searchFailed", error.message || error), "err"); scholarWallBanner(error, () => runAuthorAction(action, profile)); }
			else { setStatus(t("searchFailed", error.message || error), "err"); showBanner(t("searchFailed", error.message || error)); }
		} finally {
			if (state.searchController === controller || !state.searchController) { state.searching = false; state.searchController = null;
				$("author-search-btn").disabled = false; $("author-name-btn").disabled = false; $("author-stop-btn").disabled = true; $("search-btn").disabled = false;
				$("busy").hidden = true; setProgress(null); renderAuthorProfiles(); render(); }
			resolveDone();
		}
		if (fallbackToName) {
			await runAuthorAction("name-papers");
			if (searchSurface === "authors" && activeAuthorProvider === "scholar" && $("author-input").value === input) showBanner(t("scholarProfileLogin"));
		}
	}

	// ------------------------------------------------------------ query persistence
	const QUERY_FIELDS = ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "maxResults", "sort"];
	const POP_FIELDS = ["affiliation", "issn", "citedId", "field", "popRaw", "popOutputSort", "popCachePolicy"];
	const COMBINED_SOURCES = ["openalex", "crossref", "europepmc", "arxiv", "pubmed", "semanticscholar", "scholar"];
	const DEFAULT_COMBINED_SOURCES = COMBINED_SOURCES.slice(0, 4);
	function readCombinedSources() { return COMBINED_SOURCES.filter(key => $("multi-source-" + key)?.checked); }
	function restoreCombinedSources(values) {
		let selected = Array.isArray(values) ? values : DEFAULT_COMBINED_SOURCES;
		for (let key of COMBINED_SOURCES) if ($("multi-source-" + key)) $("multi-source-" + key).checked = selected.includes(key);
	}
	function restoreQuery() {
		let saved = {};
		try { saved = JSON.parse(PREF("lastQuery") || "{}"); } catch (e) {}
		for (let f of QUERY_FIELDS) if (saved[f] != null) $(f).value = saved[f];
		restoreCombinedSources(saved.sources);
		for (let f of POP_FIELDS) if (saved[f] != null) $(f).value = saved[f];
		if (!$("popOutputSort").value) $("popOutputSort").value = "rank";
		if (!$("popCachePolicy").value) $("popCachePolicy").value = "refresh";
		syncSel($("popCachePolicy"));
		syncSel($("popOutputSort"));
		if (!$("maxResults").value) $("maxResults").value = PREF("maxResults") || 200;
		syncSel($("sort"));
	}
	function saveQuery() {
		let o = {};
		for (let f of QUERY_FIELDS) o[f] = $(f).value;
		o.sources = readCombinedSources();
		o.engine = engineValue();
		for (let f of POP_FIELDS) o[f] = $(f).value;
		PREF("lastQuery", JSON.stringify(o));
	}

	let cacheRestoreController;
	function cancelCacheRestore() {
		cacheRestoreController?.abort();
		cacheRestoreController = null;
	}

	// The query the window opened with may already have an answer on disk. Show it,
	// say when it was captured, and leave Search to fetch a fresh one on request.
	async function restoreCachedSearch() {
		if (searchSurface === "authors") return restoreAuthorHistory();
		if (state.searching || state.importing) return;
		let query = readQuery();
		if (![query.authors, query.venue, query.title, query.keywords, ...POP_FIELDS.map(f => query[f] || "").filter((_, i) => !["popOutputSort", "popCachePolicy"].includes(POP_FIELDS[i]))].some(value => value.trim())) return;
		cancelCacheRestore();
		let controller = cacheRestoreController = new AbortController(), metadata;
		let signature = () => JSON.stringify([engineValue(), $("source").value, readQuery()]);
		let originalSignature = signature();
		let active = () => cacheRestoreController === controller && !controller.signal.aborted
			&& !state.searching && !state.importing && originalSignature === signature();
		try {
			try {
				let saved = history && await history.find($("source").value, query);
				let entry = saved && await history.get(saved.id);
				if (!active()) return;
				if (entry?.records?.length && await showHistoryEntry(entry, active)) return;
			}
			catch (e) { log("history restore failed: " + e.message); }
			if (!active() || engineValue() === "pop" || $("source").value !== "scholar" || typeof ZotPoPPoPBridge === "undefined") return;
			let noNetwork = async () => { throw new Error("Network is disabled while restoring a cached search"); };
			let ctx = {
				signal: controller.signal, isCancelled: () => controller.signal.aborted,
				popCacheOnly: true, recoveryMaxResults: query.maxResults, errors: [],
				enrichCitations: false, journalMetrics: false, institutionMetrics: false,
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
		}
		finally { if (cacheRestoreController === controller) cacheRestoreController = null; }
	}

	// ------------------------------------------------------------ recent searches
	function stripDisplayFields(records) {
		return records.map(({ rank, authorString, status, statusClass, statusTitle, inLibrary, ...rest }) => {
			if (rest.popOriginal) rest.rank = rank;
			return rest;
		});
	}

	// Every finished search is kept, so that typing it again costs nothing. A stopped
	// search is kept too, marked as incomplete, since what it did fetch was paid for.
	async function rememberSearch(sourceKey, query, records, partial) {
		if (!history || !records?.length) return;
		try { await history.save({ source: sourceKey, query, records: stripDisplayFields(records), partial }); }
		catch (e) { log("saving search history failed: " + e.message); }
	}

	async function showHistoryEntry(entry, active = () => true) {
		if (entry.query?.mode === "author") return showAuthorHistory(entry, active);
		let records = entry.records || [];
		if (!records.length) return false;
		// Saved results may predate stricter author/identity checks. Revalidate
		// their fields locally without spending requests or rewriting the snapshot.
		let originalCount = records.length;
		if (entry.query?.engine !== "pop" && ZotPoPSources.filterRecords) records = ZotPoPSources.filterRecords(records, { ...entry.query, keywords: "" });
		let removed = originalCount - records.length;
		await refreshLibraryFlags();
		if (!active()) return false;
		state.sortKey = entry.query?.engine === "pop" ? "popOrdinal" : "rank";
		state.sortDir = "asc";
		$("filter").value = "";
		displaySearchResults(records);
		let captured = new Date(entry.savedAt).toLocaleString(t.locale || undefined);
		setStatus(t("historyRestored", records.length));
		showBanner(t("historyRestoredNotice", captured, Boolean(entry.partial))
			+ (removed ? " " + t("historyRevalidated", removed) : "")
			+ (entry.query?.engine === "pop" ? popHistoryNotice(entry) : ""));
		return true;
	}

	function popHistoryNotice(entry) {
		let saved = entry.records?.[0]?.popProvenance?.profileId || entry.query?.popProfile || "pop-default";
		let current = String(PREF("popDataDir") || "pop-default");
		if (saved === current) return " " + t("popModeNotice");
		return " " + t("popProfileChanged", saved === "pop-default" ? t("popDefaultProfile") : saved,
			current === "pop-default" ? t("popDefaultProfile") : current);
	}

	// Bring a recent search back: its boxes, its source, and its results, from disk.
	async function openHistoryEntry(id) {
		if (state.searching || state.importing || !history) return;
		cancelCacheRestore();
		let entry = await history.get(id);
		if (!entry) { setStatus(t("historyMissing"), "err"); return; }
		if (state.searching || state.importing) return;
		let stillMine = () => !state.searching && !state.importing;
		let query = entry.query || {};
		if (query.mode === "author") {
			await switchSearchMode("authors");
			await showAuthorHistory(entry, stillMine); return;
		}
		if (searchSurface !== "papers") await switchSearchMode("papers");
		$("engine").value = query.engine === "pop" ? "pop" : "direct";
		populateSearchSources(entry.source);
		syncSel($("engine"));
		for (let f of POP_FIELDS) $(f).value = query[f] == null ? (f === "popOutputSort" ? "rank" : f === "popCachePolicy" ? "refresh" : "") : String(query[f]);
		syncSel($("popOutputSort"));
		for (let f of QUERY_FIELDS) $(f).value = query[f] == null ? "" : String(query[f]);
		restoreCombinedSources(query.sources);
		syncSel($("sort"));
		let source = $("source");
		if (entry.source && Array.from(source.options || []).some(o => o.value === entry.source)) {
			source.value = entry.source;
			syncSel(source);
			sourceHint();
		}
		savePrefs();
		saveQuery();
		state.selected.clear();
		state.focusKey = null;
		state.detailKey = null;
		await showHistoryEntry(entry, stillMine);
	}

	function closeHistoryMenu() {
		let menu = $("histmenu");
		if (menu.hidden) return;
		menu.hidden = true;
		menu.textContent = "";
		$("history-btn").setAttribute("aria-expanded", "false");
		$("author-history-btn").setAttribute("aria-expanded", "false");
	}

	async function toggleHistoryMenu() {
		if (!$("histmenu").hidden) { closeHistoryMenu(); return; }
		closeSelMenu();
		hideCtxMenu();
		await openHistoryMenu();
	}

	async function openHistoryMenu() {
		let menu = $("histmenu");
		menu.textContent = "";
		let entries = [];
		try { entries = history ? await history.list() : []; }
		catch (e) { log("listing history failed: " + e.message); }
		if (!entries.length) {
			let d = document.createElement("div");
			d.className = "histempty";
			d.textContent = t("historyEmpty");
			menu.appendChild(d);
		}
		for (let e of entries) {
			let d = document.createElement("div");
			d.className = "histopt";
			d.setAttribute("role", "menuitem");
			d.dataset.id = e.id;
			let label = document.createElement("span");
			label.className = "h-label";
			label.textContent = e.label || history.describe(e.query);
			let meta = document.createElement("span");
			meta.className = "h-meta";
			let when = new Date(e.savedAt).toLocaleString(t.locale || undefined);
			let provider = e.query?.mode === "author" ? (e.query.authorProvider === "orcid" ? "ORCID" : "Google Scholar") : sourceLabel(e.source);
			meta.textContent = e.kind === "profiles" ? t("authorHistoryProfiles", provider, e.count, when) : t("historyEntryMeta", provider, e.count, when, Boolean(e.partial));
			d.appendChild(label);
			d.appendChild(meta);
			d.title = label.textContent;
			d.tabIndex = 0;
			d.addEventListener("click", ev => { ev.stopPropagation(); closeHistoryMenu(); openHistoryEntry(e.id); });
			d.addEventListener("keydown", ev => {
				if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); d.click(); }
				else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); (ev.key === "ArrowDown" ? d.nextElementSibling : d.previousElementSibling)?.focus?.(); }
			});
			menu.appendChild(d);
		}
		if (entries.length) {
			menu.appendChild(document.createElement("hr"));
			let clear = document.createElement("div");
			clear.className = "histclear";
			clear.setAttribute("role", "menuitem");
			clear.textContent = t("historyClear");
			clear.addEventListener("click", async ev => {
				ev.stopPropagation();
				closeHistoryMenu();
				try { await history.clear(); setStatus(t("historyCleared")); }
				catch (e) { log("clearing history failed: " + e.message); }
			});
			menu.appendChild(clear);
		}
		menu.hidden = false;
		let btn = $(searchSurface === "authors" ? "author-history-btn" : "history-btn");
		btn.setAttribute("aria-expanded", "true");
		if (typeof btn.getBoundingClientRect !== "function") return;
		let r = btn.getBoundingClientRect();
		let below = window.innerHeight - r.bottom - 8;
		menu.style.maxHeight = Math.max(120, below) + "px";
		menu.style.top = (r.bottom + 3) + "px";
		menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - menu.offsetWidth - 6)) + "px";
	}

	// ------------------------------------------------------------ layout persistence
	function restoreLayout() {
		try { state.colOrder = normalizeColumnOrder(JSON.parse(PREF("colOrder") || "null")); }
		catch (e) { state.colOrder = [...COLUMN_KEYS]; }
		// Sizes saved on a large screen are clamped to this window, so a wide
		// sidebar or a tall detail pane cannot swallow the table on a laptop.
		let w = parseInt(PREF("metricsWidth"), 10);
		if (w >= 140) $("metrics").style.width = Math.min(w, metricsCap()) + "px";
		let h = parseInt(PREF("detailHeight"), 10);
		// A stored 0 used to come back as a dead strip with no way to grab the splitter
		if (h >= 60) $("detail").style.height = Math.min(h, detailCap()) + "px";
		if (PREF("detailHidden") === true) setDetailVisible(false);
		if (PREF("metricsHidden") === true) setMetricsVisible(false);
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
			PREF("metricsHidden", $("metrics").hidden === true);
			PREF("colWidths", JSON.stringify(state.colWidths));
			PREF("colWidthsVersion", COL_VERSION);
			PREF("winWidth", window.outerWidth);
			PREF("winHeight", window.outerHeight);
			PREF("winLeft", window.screenX);
			PREF("winTop", window.screenY);
		}
		catch (e) { log("saveLayout failed: " + e.message); }
	}

	const metricsCap = () => Math.max(140, Math.floor((window.innerWidth || 1200) * 0.3));
	const detailCap = () => Math.max(60, Math.floor((window.innerHeight || 800) * 0.5));
	function setMetricsVisible(on) {
		$("metrics").hidden = !on;
		$("vsplit").hidden = !on;
		let b = $("toggle-metrics"); if (b) b.setAttribute("aria-pressed", String(!!on));
	}
	function toggleMetrics() { setMetricsVisible($("metrics").hidden); saveLayout(); }
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
			let w = Math.max(140, Math.min(metricsCap(), el.offsetWidth + dx));
			el.style.width = w + "px";
		});
		drag($("hsplit"), "row-resize", (dx, dy) => {
			let el = $("detail");
			let h = Math.max(60, Math.min(detailCap(), el.offsetHeight - dy));
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
			// The title used to take whatever was left, which below ~1470px was
			// nothing: fifteen fixed columns ate the width and the title was a strip
			// of padding. It has a width of its own now, and a grip like the rest.
			col.style.width = (state.colWidths[k] || DEFAULT_COLS[k]) + "px";
		}
	}

	function normalizeColumnOrder(saved) {
		let ordered = ["chk"];
		for (let key of [...(Array.isArray(saved) ? saved : []), ...COLUMN_KEYS]) {
			if (typeof key === "string" && COLUMN_KEYS.includes(key) && !ordered.includes(key)) ordered.push(key);
		}
		return ordered;
	}

	function orderColumnCells(parent) {
		if (!parent) return;
		let cells = new Map([...parent.children].map(cell => [cell.dataset.k, cell]));
		for (let key of state.colOrder) if (cells.has(key)) parent.appendChild(cells.get(key));
	}

	function applyColumnOrder() {
		orderColumnCells($("results-head"));
		orderColumnCells($("cols"));
		for (let row of $("results-body").children) orderColumnCells(row);
		marquee?.refresh();
	}

	let columnDrag = null, columnDragBlocked = false, suppressColumnClickUntil = 0;
	function clearColumnDrag() {
		if (columnDrag) suppressColumnClickUntil = Date.now() + 400;
		columnDrag = null;
		columnDragBlocked = false;
		for (let th of document.querySelectorAll("#results-table th")) th.classList.remove("column-dragging", "column-drop-before", "column-drop-after");
	}

	function setupColumnOrder() {
		let headers = [...document.querySelectorAll("#results-table th")];
		for (let th of headers) {
			let key = th.dataset.sort;
			th.dataset.k = key || "chk";
			if (!key) continue;
			th.setAttribute("draggable", "true");
			th.title = [th.title, t("columnDragTip")].filter(Boolean).join("\n");
			th.addEventListener("mousedown", e => {
				columnDragBlocked = Boolean(e.target.closest?.(".rz"));
				if (!columnDrag) suppressColumnClickUntil = 0;
			}, true);
			th.addEventListener("click", e => {
				if (e.target.closest?.(".rz")) return;
				if (columnDrag || Date.now() < suppressColumnClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
				if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
				else { state.sortKey = key; state.sortDir = ["citations", "cpy", "year", "inLibrary", "pdf", "journalIF", "tier"].includes(key) ? "desc" : "asc"; }
				render();
			});
			th.addEventListener("dragstart", e => {
				if (columnDragBlocked || e.target.closest?.(".rz") || !e.dataTransfer) { e.preventDefault(); return; }
				clearColumnDrag();
				columnDrag = { key };
				th.classList.add("column-dragging");
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", key);
			});
			th.addEventListener("dragover", e => {
				if (!columnDrag) return;
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				for (let header of headers) header.classList.remove("column-drop-before", "column-drop-after");
				if (key !== columnDrag.key) {
					let rect = th.getBoundingClientRect();
					th.classList.add(e.clientX < rect.left + rect.width / 2 ? "column-drop-before" : "column-drop-after");
				}
			});
			th.addEventListener("dragleave", e => {
				if (!th.contains(e.relatedTarget)) th.classList.remove("column-drop-before", "column-drop-after");
			});
			th.addEventListener("drop", e => {
				if (!columnDrag) return;
				e.preventDefault(); e.stopPropagation();
				if (key !== columnDrag.key) {
					let rect = th.getBoundingClientRect(), order = state.colOrder.filter(id => id !== columnDrag.key);
					order.splice(order.indexOf(key) + (e.clientX < rect.left + rect.width / 2 ? 0 : 1), 0, columnDrag.key);
					if (order.join("|") !== state.colOrder.join("|")) {
						state.colOrder = normalizeColumnOrder(order);
						applyColumnOrder();
						PREF("colOrder", JSON.stringify(state.colOrder));
					}
				}
				clearColumnDrag();
			});
			th.addEventListener("dragend", clearColumnDrag);
		}
		document.addEventListener("mouseup", () => { columnDragBlocked = false; });
		document.addEventListener("keydown", e => { if (e.key === "Escape") clearColumnDrag(); });
		$("table-wrap").addEventListener("dragover", e => {
			if (!columnDrag) return;
			let wrap = $("table-wrap"), rect = wrap.getBoundingClientRect();
			if (wrap.scrollWidth <= wrap.clientWidth) return;
			let delta = e.clientX < rect.left + 36 ? -28 : e.clientX > rect.right - 36 ? 28 : 0;
			if (delta) wrap.scrollLeft = Math.max(0, Math.min(wrap.scrollWidth - wrap.clientWidth, wrap.scrollLeft + delta));
		});
		window.addEventListener("blur", clearColumnDrag);
		window.addEventListener("unload", clearColumnDrag);
		applyColumnOrder();
	}

	function setupColumnResize() {
		let ths = [...document.querySelectorAll("#results-table th")];
		for (let th of ths) {
			let rz = th.querySelector(".rz");
			if (!rz) continue;
			let key = th.dataset.sort;
			if (!key) continue;
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
	let escapeArmed = 0;
	function stopOperation() {
		state.cancelled = true;
		state.searchController?.abort();
		setStatus(t(state.importing ? "stoppingImport" : "stopping"));
	}
	// The library's own copy of a paper, brought into view in the main window.
	function showInLibrary(r) {
		try {
			let key = r.doi && ZotPoPSources.normalizeDOI ? ZotPoPSources.normalizeDOI(r.doi) : r.doi;
			let id = key && state.doiMap.get(key);
			let pane = mainWindow?.ZoteroPane;
			if (id && pane?.selectItem) { pane.selectItem(id); setStatus(t("shownInLibrary"), "", { transient: true }); }
			else setStatus(t("thLibTip"), "", { transient: true });
		}
		catch (e) { log("showInLibrary failed: " + e.message); }
	}

	function recordIdentities(record) {
		if (record.popOriginal) return ["key:" + record.key];
		let ids = ["key:" + record.key];
		let doi = ZotPoPSources.normalizeDOI(record.doi);
		if (doi) ids.push("doi:" + doi);
		if (record.pmid) ids.push("pmid:" + record.pmid);
		if (record.arxiv) ids.push("arxiv:" + String(record.arxiv).replace(/v\d+$/, ""));
		return ids;
	}

	// Results saved before the JCR table shipped, or arriving from a source that
	// never asked it, still get the Journal Impact Factor; whatever OpenAlex figure
	// remains is marked as the estimate it is.
	function settleImpactFactors(records) {
		if (typeof ZotPoPJCR === "undefined") return;
		ZotPoPJCR.apply(records.filter(r => r.journalIFSource !== ZotPoPJCR.EDITION));
		for (let r of records) if (r.journalIF != null && r.journalIFSource !== ZotPoPJCR.EDITION) r.journalIFEstimate = true;
	}

	function displaySearchResults(records) {
		settleImpactFactors(records.filter(r => !r.popOriginal && !r.authorProfile));
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
				rank: record.popOriginal ? record.rank : i + 1,
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
			sort: $("sort").value || "relevance",
			...(engineValue() === "pop" ? { engine: "pop", popProfile: String(PREF("popDataDir") || "pop-default"),
				...Object.fromEntries(POP_FIELDS.map(key => [key, $(key).value || (key === "popOutputSort" ? "rank" : key === "popCachePolicy" ? "refresh" : "")])) }
				: $("source").value === "multi" ? { sources: readCombinedSources() } : {})
		};
	}

	async function runSearch() {
		if (searchSurface === "authors") return runAuthorAction("profiles");
		if (state.importing) return;
		// A second request while one runs used to vanish, prefill included: the
		// running one is stopped and waited out, and the new one goes.
		if (state.searching) { state.searchController?.abort(); state.cancelled = true; try { await state.searchDone; } catch (e) {} }
		if (state.searching) return;
		cancelCacheRestore();
		let q = readQuery();
		if (engineValue() !== "pop" && $("source").value === "multi" && !q.sources.length) {
			setStatus(t("needSources"), "err");
			if ($("combined-options")) $("combined-options").open = true;
			return;
		}
		if (q.engine === "pop" && q.popRaw?.trim() && [q.authors, q.venue, q.title, q.keywords, q.affiliation, q.issn, q.citedId, q.field, q.yearFrom, q.yearTo].some(value => String(value ?? "").trim())) {
			setStatus(t("popRawConflict"), "err"); return;
		}
		if (![q.authors, q.venue, q.title, q.keywords, q.popRaw, q.affiliation, q.issn, q.citedId, q.field].some(x => String(x || "").trim())) {
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
		let searchDone; state.searchDone = new Promise(res => { searchDone = res; });
		let controller = new AbortController();
		state.searchController = controller;
		let active = () => state.searchController === controller && !controller.signal.aborted;
		hideBanner();
		state.records = [];
		// The API layer already applies the requested search order. Preserve its rank
		// until the user explicitly sorts a result column again.
		state.sortKey = q.engine === "pop" ? "popOrdinal" : "rank";
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
			institutionMetrics: PREF("institutionMetrics") !== false,
			DOMParser: window.DOMParser,
			popCachePolicy: q.engine === "pop" ? q.popCachePolicy : undefined,
			popSearchSource: typeof ZotPoPPoPBridge !== "undefined" && typeof ZotPoPPoPBridge.searchSource === "function" ? (source, query, context) => ZotPoPPoPBridge.searchSource(source, query, context) : undefined,
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
			let partial = Boolean(ctx.errors?.length || recs.partial || recs.popProvenance?.complete === false);
			setStatus(partial ? t("incompleteResults", label, recs.length) : t("resultCount", label, recs.length, false));
			rememberSearch(sourceKey, q, recs, partial);
			if (q.engine === "pop") showBanner(t("popModeNotice") + (recs.popProvenance?.cached ? " " + t("popCachedNotice") : ""));
			if (ctx.errors?.length) {
				// A bare "HTTP 429" from OpenAlex is its exhausted daily budget, which the user
				// can actually fix; say so instead of showing the status code alone.
				let quota = ctx.errors.some(m => /openalex/i.test(m) && /429|budget|credit/i.test(m));
				showBanner(t("partialFail", ctx.errors.join(" / ")) + (quota ? " " + t("openAlexQuota") : ""));
			}
			if (!recs.length && !partial) setStatus(t("noResults", label));
			else if (!partial && q.sort === "date" && q.venue.trim()) setStatus(t("journalFeed", q.venue.trim(), recs.length));
			else if (!partial && !PREF("hintShown")) {
				PREF("hintShown", true);
				setStatus(t("firstHint", label, recs.length));
			}
		}
		catch (e) {
			if (state.searchController !== controller) return;
			if (controller.signal.aborted || e?.name === "AbortError") {
				state.cancelled = true;
				setStatus(t("searchStopped", state.records.length));
				rememberSearch(sourceKey, q, state.records, true);
			}
			else {
				Zotero.logError(e);
				// An exhausted OpenAlex budget is the commonest failure and "HTTP 429" tells
				// the user nothing they can act on.
				let quota = e?.status === 429 && /budget|insufficient|credit/i.test(e?.body || e?.message || "");
				let text = quota ? t("openAlexQuota") : t("searchFailed", e.message || e);
				setStatus(text, "err");
				// Scholar's walls carry their own cure: a window inside Zotero and a retry.
				if (e.wall) scholarWallBanner(e, () => runSearch()); else showBanner(text);
				if (state.records.length) rememberSearch(sourceKey, q, state.records, true);
			}
		}
		finally {
			state.searching = false;
			state.searchController = null;
			searchDone?.();
			$("search-btn").disabled = false;
			$("stop-btn").disabled = true;
			$("busy").hidden = true;
			setProgress(null);
			render();
			saveCaches();
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
		for (let id of ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "filter", ...POP_FIELDS.filter(k => !["popOutputSort", "popCachePolicy"].includes(k))]) $(id).value = "";
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
		let where = affiliationOf(r);
		let hay = (r.title + " " + r.authorString + " " + r.venue + " " + (r.doi || "") + " " + (r.year || "") + " " + (r.status || "")
			+ " " + (where ? [where.first?.institution, where.corresponding?.institution, ...where.countries].filter(Boolean).join(" ") : "")).toLowerCase();
		return f.split(/\s+/).every(w => hay.includes(w));
	}

	function sortValue(r, k) {
		if (k === "rank" && r.popOriginal) return r.popRank ?? -1;
		if (k === "cpy") return ZotPoPMetrics.citesPerYear(r) ?? -1;
		if (k === "affiliation") return (affiliationOf(r)?.first?.institution || "").toLowerCase();
		if (k === "country") return (affiliationOf(r)?.countries || []).join("/");
		if (k === "tier") return affiliationOf(r)?.hIndex ?? -1;
		if (k === "inLibrary") return r.inLibrary ? 1 : 0;
		if (k === "pdf") return hasPDF(r) ? 1 : 0;
		let v = r[k];
		if (v == null) return ["citations", "year", "rank", "journalIF"].includes(k) ? -1 : "";
		return typeof v === "string" ? v.toLowerCase() : v;
	}

	function hasPDF(r) { return Boolean((r.pdfUrls || []).length || r.pdfUrl || r.pmcid || r.arxiv); }

	// ------------------------------------------------------------ journal mark
	// The publisher's lettermark in its own colour, before the journal's name: a
	// reader knows "Science is red, Cell is blue" long before reading the title.
	function journalIdentity(r) {
		if (typeof ZotPoPJournalMarks === "undefined" || !r?.venue) return null;
		let identity = ZotPoPJournalMarks.identify(r.venue, r.publisher);
		if (!identity) return null;
		let dark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
		return { identity, tone: ZotPoPJournalMarks.colours(identity, { dark }),
			// OpenAlex's ISO 4 abbreviation when the journal lookup supplied one; the
			// module's own otherwise.
			abbrev: r.journalAbbrev || identity.mark };
	}
	function journalMark(r) {
		let found = journalIdentity(r);
		if (!found) return null;
		let mark = document.createElement("span");
		mark.className = "jmark" + (found.identity.known ? " known" : "");
		mark.textContent = found.abbrev;
		// An exact brand code is worn as-is; a derived colour is a tinted chip.
		mark.style.background = found.tone.badge || found.tone.fill;
		mark.style.color = found.tone.badge ? found.tone.badgeInk : found.tone.ink;
		mark.style.boxShadow = found.tone.badge ? "none" : "inset 0 0 0 .5px " + found.tone.edge;
		mark.title = found.identity.label ? r.venue + " · " + found.identity.label : r.venue;
		return mark;
	}
	// The journal's name written in its publisher's colour, as the library list does.
	function paintVenue(cell, r) {
		let found = journalIdentity(r);
		if (!found) return;
		cell.style.color = found.tone.ink;
		cell.style.fontWeight = "600";
		cell.classList.add("venue-known");
		cell.title = [r.venue, found.abbrev !== r.venue ? found.abbrev : "", found.identity.label, r.publisher].filter(Boolean).join(" · ");
	}

	// ------------------------------------------------------------ affiliation
	function affiliationOf(r) {
		return typeof ZotPoPAffiliations !== "undefined" && r?.people ? ZotPoPAffiliations.summarise(r.people) : null;
	}
	function tierLabel(key) {
		return key ? key.toUpperCase() : "";
	}
	function personLine(role, p) {
		if (!p) return "";
		let bits = [p.name, p.institution || t("affUnknown")];
		if (p.country) bits.push(p.flag ? p.flag + " " + p.country : p.country);
		if (p.hIndex != null) bits.push(t("affHIndex", p.hIndex) + (p.tier ? " · " + tierLabel(p.tier) : ""));
		return role + ": " + bits.join(" · ");
	}
	function affiliationTip(where) {
		if (!where) return "";
		return [
			personLine(t("affFirst"), where.first),
			personLine(where.correspondingKnown ? t("affCorresponding") : t("affLast"), where.corresponding)
		].filter(Boolean).join("\n");
	}
	function tierChip(where) {
		if (!where?.tier) return null;
		let s = document.createElement("span");
		s.className = "tier tier-" + where.tier;
		s.textContent = tierLabel(where.tier);
		s.title = t("thTierTip") + (where.hIndex != null ? "\n" + t("affHIndex", where.hIndex) : "");
		return s;
	}

	// The results filter can always be let go of: Escape in the box, the × beside it.
	function syncFilterClear() { let b = $("filter-clear"); if (b) b.hidden = !$("filter").value; }
	function clearFilter() { $("filter").value = ""; state.focusKey = null; render(); syncFilterClear(); }

	function popOriginalJSON() { return JSON.stringify(state.records.filter(r => r.popOriginal).slice().sort((a, b) => a.popOrdinal - b.popOrdinal).map(r => r.popOriginal), null, 2); }

	function render() {
		if ($("copy-pop-json")) $("copy-pop-json").hidden = !state.records.length || state.records.some(r => !r.popOriginal);
		let f = $("filter").value.trim().toLowerCase();
		let list = state.records.filter(r => matchesFilter(r, f));
		let k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
		list.sort((a, b) => {
			let va = sortValue(a, k), vb = sortValue(b, k);
			if (va < vb) return -dir;
			if (va > vb) return dir;
			return a.popOriginal && b.popOriginal ? a.popOrdinal - b.popOrdinal : a.rank - b.rank;
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
		if (!marquee) marquee = ZotPoPMarquee.attach(window, $("table-wrap"), { mode: "hover" });
		else marquee.refresh();

		$("empty").hidden = list.length > 0 || !$("busy").hidden;
		$("empty").textContent = state.records.length ? t("emptyFiltered") : t(searchSurface === "authors" ? "emptyInitialAuthors" : "emptyInitial");
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

		/* Six inline tags a title may carry, drawn as what they mean. */
		let rich = (parent, text) => {
			let parts = String(text).split(/(<\/?(?:i|b|em|strong|sub|sup)>)/i), stack = [parent];
			for (let part of parts) {
				if (!part) continue;
				let m = part.match(/^<(\/?)(i|b|em|strong|sub|sup)>$/i);
				if (!m) { stack[stack.length - 1].appendChild(document.createTextNode(part)); continue; }
				let tag = m[2].toLowerCase();
				if (m[1]) { if (stack.length > 1 && String(stack[stack.length - 1].localName || stack[stack.length - 1].tagName || "").toLowerCase() === tag) stack.pop(); continue; }
				let el = document.createElement(tag); stack[stack.length - 1].appendChild(el); stack.push(el);
			}
		};
		let td = (key, cls, text, title) => {
			let c = document.createElement("td");
			c.dataset.k = key;
			if (cls) c.className = cls;
			if (text != null) c.textContent = text;
			if (title) c.title = title;
			tr.appendChild(c);
			return c;
		};

		let c0 = td("chk", "chk");
		let cb = document.createElement("input");
		cb.type = "checkbox"; cb.tabIndex = -1;
		cb.checked = state.selected.has(r.key);
		cb.addEventListener("change", () => toggleSelect(r, cb.checked));
		c0.appendChild(cb);

		td("citations", "num", r.citations == null ? "–" : String(r.citations), r.citationSource ? t("citeSource", sourceLabel(r.citationSource)) : "");
		td("cpy", "num", fmt(ZotPoPMetrics.citesPerYear(r)));
		td("rank", "num", r.popOriginal ? (r.popRank == null ? "–" : String(r.popRank)) : String(r.rank));
		td("authorString", "", r.authorString, r.authorString).dataset.marquee = "authors";

		let tt = td("title", "title", null, r.title);
		tt.dataset.marquee = "title";
		// Plain text: the title is the widest cell, and a click on "the row" used
		// to leave Zotero for the browser. Double-click, Enter or the menu do that.
		let a = document.createElement("span");
		if (r.titleMarkup) rich(a, r.titleMarkup); else a.textContent = r.title;
		if (r.url) tt.title = r.title + "\n" + t("titleOpenTip");
		tt.appendChild(a);

		td("year", "num", r.year == null ? "" : String(r.year));
		let venueCell = td("venue", "venue", r.venue, r.publisher ? r.venue + " · " + r.publisher : r.venue);
		venueCell.dataset.marquee = "venue";
		paintVenue(venueCell, r);
		td("journalIF", "num if" + (r.journalIFEstimate ? " estimate" : ""), r.journalIF == null ? "" : (r.journalIFEstimate ? "~" : "") + fmt(r.journalIF, 1),
			r.journalIF == null ? "" : r.journalIFEstimate ? t("ifTip", fmt(r.journalIF, 1), r.journalH) : t("jifTip", fmt(r.journalIF, 1), r.journalIFSource, r.journalH));
		let where = affiliationOf(r);
		td("affiliation", "aff", where?.first?.institution || "", affiliationTip(where)).dataset.marquee = "affiliation";
		td("country", "mini country", where ? where.countries.map(c => (ZotPoPAffiliations.flag(c) + " " + c).trim()).join(" ") : "", affiliationTip(where));
		let tierCell = td("tier", "mini tiercell", null, "");
		let chip = tierChip(where);
		if (chip) tierCell.appendChild(chip);
		let doiCell = td("doi", "doi", null, r.doi ? t("thDoiTip") : ""); doiCell.dataset.marquee = "doi";
		if (r.doi) { let link = document.createElement("a"); link.href = "#"; link.tabIndex = -1; link.textContent = r.doi; link.className = "doi-link";
			link.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); Zotero.launchURL("https://doi.org/" + encodeURI(r.doi)); }); doiCell.appendChild(link); }
		let pdfCell = td("pdf", "mini pdf", hasPDF(r) ? "●" : "", hasPDF(r) ? t("thPdfClickTip") : "");
		if (hasPDF(r)) { pdfCell.setAttribute("role", "button"); pdfCell.addEventListener("click", e => { e.stopPropagation(); state.focusKey = r.key; state.detailKey = r.key; paintRows(); renderDetail(); openPreview(r); }); }
		let libCell = td("inLibrary", "mini lib", r.inLibrary ? "✓" : "", r.inLibrary ? t("thLibClickTip") : "");
		if (r.inLibrary) { libCell.setAttribute("role", "button"); libCell.addEventListener("click", e => { e.stopPropagation(); showInLibrary(r); }); }
		let st = td("status", "status", r.status || "", r.statusTitle || "");
		st.dataset.marquee = "status";
		if (r.statusClass) st.classList.add(r.statusClass);
		orderColumnCells(tr);

		tr.addEventListener("click", e => {
			if (e.target.closest("input, a, [role=button]")) return;
			state.focusKey = r.key;
			state.detailKey = r.key;
			if (e.metaKey || e.ctrlKey) toggleSelect(r, !state.selected.has(r.key));
			else { paintRows(); renderDetail(); }
		});
		tr.addEventListener("dblclick", e => {
			if (e.target.closest("input, a, [role=button]")) return;
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
		let all = state.visible.length > 0 && state.visible.every(r => state.selected.has(r.key));
		let some = state.visible.some(r => state.selected.has(r.key));
		$("chk-all").checked = all;
		$("chk-all").indeterminate = some && !all;
		let fresh = state.visible.filter(r => !r.inLibrary).length;
		let newLabel = $("select-new").querySelector("span"); if (newLabel) newLabel.textContent = t("selNewCount", fresh);
		$("select-new").disabled = fresh === 0;
		$("preview-btn").disabled = !previewRecord();
		previewManager?.update(previewRecord());
	}

	function selectVisible(on) {
		for (let r of state.visible) { if (on) state.selected.add(r.key); else state.selected.delete(r.key); }
		paintRows();
	}

	function renderMetrics(list) {
		if (searchSurface === "authors" && list.length && !list.some(record => record.citations != null && Number.isFinite(Number(record.citations)))) {
			$("metrics-hint").hidden = false; $("metrics-hint").textContent = t("authorNoCitationData", list.length); $("metrics-table").hidden = true; return;
		}
		if ($("metrics-hint")) $("metrics-hint").textContent = t("metricsHint");
		let m = ZotPoPMetrics.compute(list);
		let set = (id, v) => { $(id).textContent = v; };
		let hint = $("metrics-hint"); if (hint) { hint.hidden = list.length > 0; $("metrics-table").hidden = !list.length; }
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
		// t.locale is the already-resolved language. The old fallback passed the
		// raw preference on, which would hand "auto" to the preview as if that
		// were a language; English is the safe answer when there is no locale.
		return previewManager.open(record, { Zotero, language: t.locale || "en" });
	}
	function detailRecord() { return state.records.find(r => r.key === state.detailKey) || null; }

	function renderDetail() {
		let r = detailRecord();
		$("detail-empty").hidden = Boolean(r);
		$("detail-body").hidden = !r;
		if (!r) return;
		$("d-title").textContent = "";
		if (r.titleMarkup) {
			let parts = String(r.titleMarkup).split(/(<\/?(?:i|b|em|strong|sub|sup)>)/i), stack = [$("d-title")];
			for (let part of parts) {
				if (!part) continue;
				let m = part.match(/^<(\/?)(i|b|em|strong|sub|sup)>$/i);
				if (!m) { stack[stack.length - 1].appendChild(document.createTextNode(part)); continue; }
				let tag = m[2].toLowerCase();
				if (m[1]) { if (stack.length > 1 && String(stack[stack.length - 1].localName || stack[stack.length - 1].tagName || "").toLowerCase() === tag) stack.pop(); continue; }
				let el = document.createElement(tag); stack[stack.length - 1].appendChild(el); stack.push(el);
			}
		} else $("d-title").textContent = r.title;

		let badges = $("d-badges");
		badges.textContent = "";
		let chip = (text, cls) => {
			let s = document.createElement("span");
			s.className = "badge" + (cls ? " " + cls : "");
			s.textContent = text;
			badges.appendChild(s);
			return s;
		};
		// A source badge carries its own mark. Nine academic services all
		// rendered as grey text is a list you read one word at a time; the
		// marks are what make "this came from bioRxiv" a glance.
		let sourceChip = key => {
			let s = chip(sourceLabel(key), "src");
			let mark = brandMark(key, 12);
			if (mark) s.insertBefore(mark, s.firstChild);
			return s;
		};
		let mark = journalMark(r);
		if (mark) badges.appendChild(mark);
		if (r.citations != null) chip(t("badgeCites", r.citations), "cite");
		if (r.journalIF != null) chip(t("badgeIF", (r.journalIFEstimate ? "~" : "") + fmt(r.journalIF, 1)), "if").title = r.journalIFEstimate ? t("ifTip", fmt(r.journalIF, 1), r.journalH) : t("jifTip", fmt(r.journalIF, 1), r.journalIFSource, r.journalH);
		let cpy = ZotPoPMetrics.citesPerYear(r);
		if (cpy != null) chip(t("badgePerYear", fmt(cpy)));
		for (let s of r.sources || [r.source]) sourceChip(s);
		if (r.inLibrary) chip(t("badgeInLibrary"), "lib");
		if (hasPDF(r)) chip(t("badgeHasPdf"));
		/* A preprint and the article it became are two records with two DOIs, so
		   they are not merged -- but a list that shows both and says nothing
		   looks broken. A real search returned the Research Square preprint and
		   the Biotechnology for Biofuels article one after the other, differing
		   only in the case of one letter. */
		if (r.publishedAs) {
			chip(t("badgePublishedAs", r.publishedAs.venue || r.publishedAs.year || ""), "ver")
				.title = t("publishedAsTip", r.publishedAs.doi || "");
		}
		else if (r.preprintOf) {
			chip(t("badgeHasPreprint"), "ver").title = t("preprintOfTip", r.preprintOf.doi || "");
		}

		$("d-authors").textContent = r.authorString || t("noAuthors");
		let whereBox = $("d-where");
		whereBox.textContent = "";
		let where = affiliationOf(r);
		if (where) {
			for (let [role, p] of [[t("affFirst"), where.first], [where.correspondingKnown ? t("affCorresponding") : t("affLast"), where.corresponding]]) {
				if (!p) continue;
				let line = document.createElement("div");
				line.textContent = personLine(role, { ...p, hIndex: null });
				if (p.hIndex != null) {
					let h = document.createElement("span");
					h.textContent = " · " + t("affHIndex", p.hIndex);
					line.appendChild(h);
				}
				let chip = p.tier ? tierChip({ tier: p.tier, hIndex: p.hIndex }) : null;
				if (chip) line.appendChild(chip);
				whereBox.appendChild(line);
			}
		}
		whereBox.hidden = !whereBox.firstChild;
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
		$("d-proxy").disabled = !(r.doi || r.url);
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
			let checked = r.popOriginal ? Object.assign({}, r) : r;
			let res = await ZotPoPSources.checkCitations(checked, http, { email: PREF("email") || "", s2ApiKey: PREF("s2ApiKey") || "", openAlexApiKey: PREF("openAlexApiKey") || "", log });
			let parts = [["openalex", res.openalex], ["crossref", res.crossref], ["semanticscholar", res.semanticscholar]]
				.filter(([, v]) => v != null).map(([k, v]) => sourceLabel(k) + " " + v);
			if (!parts.length) setStatus(t("citeCheckNone"), "err");
			else setStatus(t("citeCheckResult", parts.join(" · "), checked.journalIF == null ? null : fmt(checked.journalIF, 1)));
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
		add(t("ctxProxy"), () => openViaProxy(r), !(r.doi || r.url));
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
			if (!$("histmenu").hidden) { closeHistoryMenu(); return; }
			if (!$("ctxmenu").hidden) { hideCtxMenu(); return; }
			if (state.searching) { stopOperation(); return; }
			if (state.importing) {
				// One Esc, pressed to dismiss something that had already closed, used
				// to abort a batch add half-way. It takes two within a moment and a half.
				let now = Date.now();
				if (escapeArmed && now - escapeArmed < 1500) { escapeArmed = 0; stopOperation(); }
				else { escapeArmed = now; setStatus(t("escapeAgainToStop")); }
				return;
			}
			if (document.activeElement === $("filter") && $("filter").value) { clearFilter(); return; }
			if (document.activeElement === $("filter")) { $("table-wrap").focus(); return; }
			if (state.detailKey) { state.detailKey = null; paintRows(); renderDetail(); return; }
			return;
		}
		if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("filter").focus(); $("filter").select(); return; }
		if (mod && e.key === "Enter") { e.preventDefault(); runSearch(); return; }
		if (mod && e.key.toLowerCase() === "w") { window.close(); return; }
		// Keys typed into a form field belong to that field, Cmd/Ctrl+A included: hijacking
		// it made select-all in the query boxes select every result row instead.
		if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectVisible(true); return; }
		if (mod && e.key.toLowerCase() === "c") {
			// The focused row's citation, or with Shift its DOI: what a reader reaches for most.
			let r = state.visible.find(row => row.key === state.focusKey);
			if (!r) return;
			e.preventDefault();
			if (e.shiftKey) { if (r.doi) copyText(r.doi, t("copiedDoi")); }
			else copyText(citationText(r), t("copiedCite"));
			return;
		}
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
		if ((e.key === "Backspace" || e.key === "Delete") && idx >= 0) {
			e.preventDefault();
			if (mod) { state.selected.clear(); paintRows(); }
			else toggleSelect(state.visible[idx], false);
			return;
		}
		if (e.key === "Home" || e.key === "End") {
			e.preventDefault();
			let r = state.visible[e.key === "Home" ? 0 : state.visible.length - 1];
			state.focusKey = r.key; state.detailKey = r.key; paintRows(); renderDetail();
			document.querySelector(`#results-body tr[data-key="${CSS.escape(r.key)}"]`)?.scrollIntoView({ block: "nearest" });
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
		setStatus(msg || t("copied"), "", { transient: true });
	}

	function csvText() {
		let esc = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
		let lines = [t("csvHead").join(",")];
		for (let r of state.visible) {
			lines.push([
				r.citations ?? "", fmt(ZotPoPMetrics.citesPerYear(r)), r.popOriginal ? r.popRank : r.rank, r.authorString, r.title,
				r.year ?? "", r.venue, r.journalIF == null ? "" : fmt(r.journalIF, 2),
				affiliationOf(r)?.first?.institution ?? "", (affiliationOf(r)?.countries || []).join("/"), affiliationOf(r)?.hIndex ?? "",
				r.publisher, r.doi ?? "", r.url ?? "",
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

	/* A query handed over from the item list. Title first: it is the most
	   specific thing on the row. The year narrows a common title without
	   excluding a preprint from the year before. */
	function applyPrefill() {
		let pre = Zotero.ZotPoP && typeof Zotero.ZotPoP.takePrefill === "function" ? Zotero.ZotPoP.takePrefill() : null;
		if (!pre) return false;
		if (pre.title) $("title").value = String(pre.title).replace(/<[^>]*>/g, "");
		if (pre.venue) $("venue").value = String(pre.venue);
		if (pre.authors) $("authors").value = String(pre.authors);
		let year = parseInt(pre.year, 10);
		if (year) { $("yearFrom").value = String(year - 1); $("yearTo").value = String(year + 1); }
		$("keywords").value = "";
		setStatus(t("prefilledFrom"));
		(searchSurface === "authors" ? switchSearchMode("papers").then(() => runSearch()) : runSearch()).catch(e => log("prefilled search failed: " + e.message));
		return true;
	}
	window.addEventListener("load", init);
	// Registered after init, so it runs after init on the same event.
	window.addEventListener("load", applyPrefill);
	window.addEventListener("zotpop-prefill", applyPrefill);
})();
