/* global Zotero, Services, Ci, IOUtils, PathUtils, CSS, ZotPoPI18N, ZotPoPSources, ZotPoPMetrics, ZotPoPImporter, ZotPoPPoPBridge, ZotPoPPreview, ZotPoPMarquee, ZotPoPHistory, ZotPoPAffiliations, ZotPoPJournalMarks, ZotPoPFilters, ZotPoPJournals, ZotPoPTip, ZotPoPCite, ZotPoPTranslate */
"use strict";

(function () {
	const args = (window.arguments && window.arguments[0]) || {};
	if (typeof Zotero === "undefined" && args.Zotero) window.Zotero = args.Zotero;
	const mainWindow = args.mainWindow || null;

	const $ = id => document.getElementById(id);
	// The hover card (content/tooltip.js) replaces the native title tooltip: data-tip, never title.
	const tip = (el, text) => { if (typeof ZotPoPTip !== "undefined") ZotPoPTip.set(el, text); else if (el) { el.removeAttribute?.("title"); if (text) el.setAttribute("data-tip", String(text)); } };
	const PREF = (k, v) => v === undefined
		? Zotero.Prefs.get("extensions.zotpop." + k, true)
		: Zotero.Prefs.set("extensions.zotpop." + k, v, true);

	// Title has no fixed width: it absorbs whatever is left, so keep these lean.
	// Wider text columns: at the old widths a title showed eight words and an
	// author list two names, and every one of them rolled at once.
	// The title comes right after the checkbox. The columns that follow it are the
	// ones a reader scans: authors, then the lab they worked in (tier chip, flag, institution).
	// Rank, country, tier and DOI (kept in the detail) and Status (only once something has
	// one) are hidden until "all".
	const COL_FLOOR = { inLibrary: 112, citations: 68 };
	const DEFAULT_COLS = {
		chk: 28, title: 200, authorString: 150, affiliation: 150, year: 58, venue: 184, citations: 68, cpy: 64, journalIF: 60, journalOA2y: 60,
		pdf: 60, inLibrary: 112, status: 128, rank: 60, country: 62, tier: 56, doi: 150
	};

	// 8: Year, Rank and Per year were narrower than their own digits ("20…", "Ra…").
	// 9: the IF column gained a leading ~ for an estimate and 48px clipped it.
	// 10: the library column carries Style Custom's reading state beside the check.
	// 11: the title moved to second place and five columns are hidden by default.
	// 12: the status column fits "Added + PDF" and the defaults still add up to the results pane at 1280px.
	// 13: the institution column joined the default set, right after the authors, and draws tier, flag and lab.
	//     Widths saved under 12 are still good (the key set only grew); the saved order is migrated in restoreLayout.
	const COL_VERSION = 13;
	const COL_VERSION_MIN_WIDTHS = 12;
	const COLUMN_KEYS = Object.keys(DEFAULT_COLS);
	// Narrower than this and a column cannot show its own content (a 4-digit year needs ~56px with its padding)
	const MIN_COL = 40;
	// An unbounded drag used to persist a column wider than the window
	const MAX_COL = 900;

	// Localised string lookup; replaced in init() once the pref is read.
	let t = ZotPoPI18N.make("en");
	let uiLocale = "en";
	// A source's raw failure ("HTTP 503 · api.openalex.org") as a sentence in the window's language: the service, what happened, what to do.
	const explain = message => typeof ZotPoPI18N.explainError === "function" ? ZotPoPI18N.explainError(String(message ?? ""), t.locale || "en") : String(message ?? "");
	const explainList = errors => [...new Set(errors.map(explain))].join(" / ");
	const progressText = message => typeof ZotPoPI18N.localizeProgress === "function" ? ZotPoPI18N.localizeProgress(String(message ?? ""), t.locale || "en") : String(message ?? "");

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
		related: { running: false, controller: null, prev: null, store: null, generation: 0, libraryID: null },
		checking: false,
		sortDir: "asc",
		searching: false,
		searched: false,
		lastPartial: false,
		searchController: null,
		importing: false,
		cancelled: false,
		doiMap: new Map(),
		libraryID: null,
		colWidths: Object.assign({}, DEFAULT_COLS),
		colOrder: [...COLUMN_KEYS],
		colsMode: "basic",
		// The muted second line under each title: first and corresponding author with their institutions.
		affLine: true,
		facet: null,
		selectedOnly: false,
		// "all" | "new" | "owned": whether the library already has the paper.
		libraryFilter: "all",
		libCounts: { all: 0, new: 0, owned: 0 },
		// The filter builder's rules ({ kind, mode, values, ... }, see content/filters.js) and its popover.
		rules: [],
		filterOpen: false,
		filterEdit: null,
		filterQ: {}
	};
	let marquee = null;
	let history = null;
	let snapshots = null; // last OpenAlex count seen per paper (content/cite.js)
	let translator = null;
	let searchSurface = "papers";
	const surfaceSnapshots = new Map();
	const AUTHOR_PROVIDERS = ["combined", "scholar", "orcid"];
	const authorSessions = Object.fromEntries(AUTHOR_PROVIDERS.map(key => [key, { input: "", profiles: [], profile: null, action: "profiles", pick: null }]));
	let activeAuthorProvider = "combined";
	const orcidIdOf = profile => profile?.provider === "orcid" ? profile.id : profile?.orcid || null;
	const authorProviderLabel = provider => provider === "orcid" ? "ORCID" : provider === "combined" ? "OpenAlex + ORCID" : "Google Scholar";
	let authorAction = "profiles";
	// What a profile card remembers while the window is open: the folded-away profiles, which summaries are open,
	// the LinkedIn address ORCID listed for a person (or false when it listed none).
	const authorView = { showAll: false, summaries: new Map(), open: new Set(), bioOpen: new Set(), linkedin: new Map(), disk: null };

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
			list: dir => IOUtils.getChildren(dir),
			makeDir: dir => IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true })
		};
	}
	function dataPath(...parts) {
		return typeof PathUtils !== "undefined" && Zotero.DataDirectory?.dir ? PathUtils.join(Zotero.DataDirectory.dir, "zotpop", ...parts) : parts.join("/");
	}
	// The Journal Impact Factor is licensed to whoever subscribes to it, so the plugin
	// ships none. A reader who holds an entitlement puts their own export here and the
	// IF column shows those figures instead of the OpenAlex estimate.
	async function loadJournalFigures() {
		try {
			let io = diskIO();
			if (!io) return;
			// The newest jcr-YYYY.json, else jcr.json; the file (or its name) says which JCR edition it is.
			let dir = dataPath("journals");
			if (!await io.exists(dir)) return;
			let name = ZotPoPJCR.pickFile(typeof io.list === "function" ? await io.list(dir) : ["jcr.json"]);
			if (!name || !await io.exists(dataPath("journals", name))) return;
			let data = JSON.parse(await io.readText(dataPath("journals", name)));
			let rows = Array.isArray(data) ? data : data?.rows;
			// A bare list's year, when the reader set one in Preferences, is in jcr.meta.json beside it (the export itself is never edited).
			let meta = null;
			try { if (ZotPoPJCR.META_FILE && await io.exists(dataPath("journals", ZotPoPJCR.META_FILE))) meta = JSON.parse(await io.readText(dataPath("journals", ZotPoPJCR.META_FILE))); }
			catch (e) { Zotero.debug("ZotPoP: " + ZotPoPJCR.META_FILE + " not read: " + (e && e.message)); }
			if (Array.isArray(rows) && rows.length) ZotPoPJCR.load(data, { fileName: name, meta });
		}
		catch (e) { Zotero.debug("ZotPoP: local journal figures not loaded: " + (e && e.message)); }
	}

	function setupStorage() {
		let io = diskIO() || ZotPoPHistory.memoryIO();
		let size = parseInt(PREF("historySize"), 10);
		history = ZotPoPHistory.create({ io, dir: dataPath("history"), join: typeof PathUtils !== "undefined" ? PathUtils.join : undefined,
			max: size > 0 ? size : 30, maxBytes: 64 * 1024 * 1024 });
		if (typeof ZotPoPCite !== "undefined") {
			snapshots = ZotPoPCite.createSnapshots({ io, path: dataPath("citations.json") });
			snapshots.load().catch(() => {});
		}
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

	/* Requests that never reached a server (status 0 or none): counted, so a search that failed for want of a
	   connection can say so instead of quoting the network layer, and can offer the run saved last time. */
	let networkFailures = 0;
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
		if (status == null || status === 0) { networkFailures++; err.offline = true; }
		// The server's own wait, so the retry waits that long instead of 1.5 s and failing as a bare 429.
		try { let after = e?.xmlhttp?.getResponseHeader?.("Retry-After"); if (after != null && after !== "") err.retryAfter = after; } catch (ignored) {}
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
				let err = new Error(t("notJSON", ZotPoPI18N.serviceOf ? ZotPoPI18N.serviceOf(url) : url.split("?")[0]));
				err.status = xhr.status;
				throw err;
			}
			return xhr.response;
		},
		async getText(url, headers = {}, signal) {
			let xhr = await requestHTTP(url, headers, "text", signal);
			return xhr.responseText;
		},
		// For a translation endpoint the reader set up: the body is the text and the language, never a key in the URL.
		async postJSON(url, headers = {}, body) {
			let xhr;
			try {
				xhr = await Zotero.HTTP.request("POST", url, { headers: Object.assign({ Accept: "application/json" }, headers), body: JSON.stringify(body), responseType: "json", timeout: 90000, errorDelayMax: 0 });
			}
			catch (e) { throw httpError(e, url); }
			if (xhr.response === null) throw new Error(t("notJSON", ZotPoPI18N.serviceOf ? ZotPoPI18N.serviceOf(url) : url.split("?")[0]));
			return xhr.response;
		}
	};

	function log(msg) { Zotero.debug("ZotPoP: " + msg); }

	let statusRevert = null, lastStatus = { msg: "", cls: "" };
	// Timers by whichever global has them: the window in Zotero, none in the test sandbox.
	const later = (fn, ms) => (typeof setTimeout === "function" ? setTimeout(fn, ms) : typeof window !== "undefined" && window.setTimeout ? window.setTimeout(fn, ms) : null);
	const cancelLater = id => { if (id == null) return; if (typeof clearTimeout === "function") clearTimeout(id); else if (typeof window !== "undefined" && window.clearTimeout) window.clearTimeout(id); };
	/* A failure is said at once to a screen reader (the alert region); the status line itself is polite.
	   The region is emptied first so the same failure twice is said twice. */
	function announce(text) {
		let box = $("sr-alert"); if (!box) return;
		box.textContent = "";
		if (text) later(() => { box.textContent = String(text); }, 30);
	}
	function setStatus(msg, cls, options = {}) {
		if (statusRevert != null) { cancelLater(statusRevert); statusRevert = null; }
		$("status").textContent = msg;
		if (cls === "err" && !options.transient) announce(msg);
		// one line in the footer; the whole text is in the hover card when it is cut
		tip($("status"), String(msg || "").length > 48 ? msg : "");
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
	function showBanner(text, action, options = {}) {
		$("banner-text").textContent = text;
		// a long hint is one clause in the banner and the rest in its hover card
		tip($("banner-text"), options.tip || "");
		// A banner that reports a failure wears the attention colour; one that offers a hint stays plain.
		$("banner").classList.toggle("warn", Boolean(options.warn));
		// The banner appears out of a hidden box, which assistive technology does not announce by itself.
		if (options.warn) announce(text);
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
		} }, { warn: true });
	}
	function hideBanner() { $("banner").hidden = true; }

	function fmt(n, d = 2) {
		if (n == null || !Number.isFinite(n)) return "–";
		return Number.isInteger(n) && d === 0 ? String(n) : n.toFixed(d);
	}

	// ------------------------------------------------------------ init
	function init() {
		loadJournalFigures();
		let locale = ZotPoPI18N.resolveLocale(PREF("language") || "en", Zotero.locale || Services.locale?.appLocaleAsBCP47);
		t = ZotPoPI18N.make(locale);
		uiLocale = locale;
		document.documentElement.setAttribute("lang", locale);
		ZotPoPI18N.apply(document, t);
		document.title = t("windowTitle");
		if (typeof ZotPoPTip !== "undefined") ZotPoPTip.attach(window, { rich: tipContent });
		if (typeof ZotPoPTranslate !== "undefined") {
			// Its own settings by short name, another plugin's by its full key.
			translator = ZotPoPTranslate.create({ zotero: Zotero, uiLocale: locale, pluginID: "zotpop@sungjaeyoon.dev", post: http.postJSON,
				pref: key => (key.startsWith("extensions.") ? Zotero.Prefs.get(key, true) : PREF(key)) });
		}

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
		for (let id of ["engine", "source", "sort", "popOutputSort", "popCachePolicy", "target", "author-provider", "author-input-kind"]) enhanceSelect($(id));

		restoreQuery();
		restoreAuthorPreferences();
		searchSurface = PREF("searchSurface") === "authors" ? "authors" : "papers";
		$("opt-pdf").checked = PREF("attachPDF") !== false;
		$("opt-fillpdf").checked = PREF("fillMissingPDF") === true;
		$("opt-skip").checked = PREF("skipDuplicates") !== false;
		$("opt-extra").checked = PREF("citationsInExtra") !== false;
		$("opt-trnote").checked = PREF("keepTranslatedAbstract") === true;
		// Kept like the other options: it was unticked again in every new window.
		$("opt-queue").checked = PREF("queueOnAdd") === true;
		tip($("opt-trnote-wrap"), t("optTrNoteTip"));
		tip($("opt-queue-wrap"), t("optQueueTip"));

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
		$("cond-toggle").addEventListener("click", () => { state.condOpen = !state.condOpen; syncQueryCollapse(); });
		// Reaching the toggle by keyboard opens the conditions, so Tab walks into the fields.
		$("cond-toggle").addEventListener("focus", () => { let keyboard = false; try { keyboard = $("cond-toggle").matches(":focus-visible"); } catch (e) {} if (keyboard && !state.condOpen) { state.condOpen = true; syncQueryCollapse(); } });
		$("author-form").addEventListener("submit", e => { e.preventDefault(); runAuthorAction("profiles"); });
		$("author-input").addEventListener("input", authorInputChanged);
		$("author-input-kind").addEventListener("change", authorInputChanged);
		$("author-max-results").addEventListener("change", () => { if (searchSurface === "authors") state.searchController?.abort(); saveAuthorPreferences(); });
		$("author-provider").addEventListener("change", () => switchAuthorProvider($("author-provider").value));
		$("author-name-btn").addEventListener("click", () => runAuthorAction("name-papers"));
		$("author-stop-btn").addEventListener("click", stopOperation);
		$("author-help-toggle")?.addEventListener("click", () => { state.authorHelpOpen = !state.authorHelpOpen; updateAuthorHint(); });
		$("author-history-btn").addEventListener("click", e => { e.stopPropagation(); toggleHistoryMenu(e.detail === 0); });
		$("author-history-btn").addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if ($("histmenu").hidden) toggleHistoryMenu(true); else historyItems()[0]?.focus?.(); } });
		wireVenueBox();
		$("query-form").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
		$("query-form").addEventListener("input", cancelCacheRestore);
		$("query-form").addEventListener("change", cancelCacheRestore);
		$("stop-btn").addEventListener("click", stopOperation);
		$("clear-btn").addEventListener("click", clearAll);
		// A press from the keyboard has no pointer (detail 0): the menu opens with the first search focused.
		$("history-btn").addEventListener("click", e => { e.stopPropagation(); toggleHistoryMenu(e.detail === 0); });
		$("history-btn").addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if ($("histmenu").hidden) toggleHistoryMenu(true); else historyItems()[0]?.focus?.(); } });
		$("histmenu").addEventListener("keydown", onHistoryMenuKey);
		// Tab past the last row (or back before the first) leaves the menu: it closes rather than float behind.
		if (typeof document.addEventListener === "function") document.addEventListener("focusin", e => {
			let menu = $("histmenu");
			if (!menu.hidden && !menu.contains?.(e.target) && e.target !== $("history-btn") && e.target !== $("author-history-btn")) closeHistoryMenu();
		});
		$("banner-close").addEventListener("click", hideBanner);
		$("banner-action")?.addEventListener("click", () => { if (bannerAction) bannerAction.run(); });
		// A beat after the last key, not per key: with a thousand rows every
		// keystroke rebuilt the table, and Hangul composition fires one per jamo.
		let filterTimer = null;
		$("filter").addEventListener("input", () => { syncFilterClear(); clearTimeout(filterTimer); filterTimer = setTimeout(() => { filterTimer = null; render(); }, 120); });
		$("filter").addEventListener("keydown", e => { if (e.key === "ArrowDown") { e.preventDefault(); $("table-wrap").focus(); } });
		$("filter-clear")?.addEventListener("click", () => { clearFilter(); $("filter").focus(); });
		$("filter-btn")?.addEventListener("click", e => { e.stopPropagation(); toggleFilterPop(); });
		$("filter-pop")?.addEventListener("keydown", onFilterPopKey);
		window.addEventListener("resize", () => { if (state.filterOpen) positionFilterPop(); });
		// A press anywhere else lets the popover go; the keyboard stays where the press put it.
		document.addEventListener("mousedown", e => {
			if (!state.filterOpen) return;
			let el = e.target;
			if (el?.closest?.("#filter-pop, #filter-btn, .fchip")) return;
			closeFilterPop(false);
		});
		syncFilterClear();
		$("chk-all").addEventListener("change", e => selectVisible(e.target.checked));
		$("facet-clear")?.addEventListener("click", () => setFacet(null));
		$("person-clear")?.addEventListener("click", () => setPick(null));
		$("selected-only")?.addEventListener("click", () => { state.selectedOnly = !state.selectedOnly; render(); });
		$("select-none").addEventListener("click", () => { state.selected.clear(); render(); });
		$("related-btn").addEventListener("click", toggleRelated);
		// Changing the library filter never touches the checks: what was chosen stays chosen.
		for (let b of document.querySelectorAll("#lib-filter button")) b.addEventListener("click", () => { state.libraryFilter = b.dataset.lib; render(); });
		let toolbarMenus = { "export-btn": () => [exportMenuItems(), t("exportMenu")], "view-btn": () => [viewMenuItems(), t("viewMenu")], "d-more": () => [moreMenuItems(detailRecord()), t("dMore")], "d-tr-lang": () => [trLangMenuItems(), t("trLang")] };
		for (let id of Object.keys(toolbarMenus)) {
			let open = focusFirst => { let [items, label] = toolbarMenus[id](); openToolbarMenu($(id), items, label, focusFirst); };
			// A click from the keyboard has no pointer (detail 0), so it also moves focus into the menu.
			$(id).addEventListener("click", e => { e.stopPropagation(); open(e.detail === 0); });
			$(id).addEventListener("keydown", e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (openTbMenu?.btn === $(id)) openTbMenu.nodes[0]?.focus(); else open(true); } });
		}
		$("tbmenu").addEventListener("keydown", onToolbarMenuKey);
		$("ctxmenu").addEventListener("keydown", onCtxMenuKey);
		$("d-tr-run")?.addEventListener("click", runTranslate);
		$("d-tr-copy")?.addEventListener("click", copyTranslation);
		$("d-tr-orig")?.addEventListener("click", () => { state.trHideOrig = state.trHideOrig !== true; let r = detailRecord(); if (r) renderTranslate(r); });
		$("d-tr-title")?.addEventListener("change", e => { PREF("translateTitle", Boolean(e.target.checked)); let r = detailRecord(); if (r) renderTranslate(r); });
		// An in-page select menu closes when focus leaves it, so Tab does not leave it floating.
		if (typeof document.addEventListener === "function") document.addEventListener("focusin", e => { if (openSel && !openSel.menu?.contains?.(e.target) && e.target !== selButton(openSel.sel)) closeSelMenu(); });
		$("preview-btn").addEventListener("click", () => togglePreview());
		$("dp-prev").addEventListener("click", () => previewViewer?.goTo(previewViewer.page - 1));
		$("dp-next").addEventListener("click", () => previewViewer?.goTo(previewViewer.page + 1));
		$("dp-close").addEventListener("click", closePreview);
		$("dp-retry").addEventListener("click", () => previewViewer?.retry());
		$("dp-original").addEventListener("click", () => { let u = state.preview.originalURL; if (u && ZotPoPPreview.safeURL(u)) Zotero.launchURL(u); });
		$("import-btn").addEventListener("click", () => importRecords(state.records.filter(r => state.selected.has(r.key))));
		$("target").addEventListener("change", () => { relatedLibraryChanged(); state.doiMap.clear(); refreshLibraryFlags(); });
		$("source").addEventListener("change", sourceHint);
		$("engine").addEventListener("change", () => { cancelCacheRestore(); populateSearchSources(); sourceHint(); savePrefs(); saveQuery(); });
		$("pop-options")?.addEventListener("input", cancelCacheRestore);
		$("popOutputSort")?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });
		$("popCachePolicy")?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });
		for (let key of COMBINED_SOURCES) $("multi-source-" + key)?.addEventListener("change", () => { cancelCacheRestore(); saveQuery(); });

		setupColumnOrder();
		for (let id of ["source", "sort", "opt-pdf", "opt-skip", "opt-extra", "opt-trnote", "opt-fillpdf", "opt-queue", "maxResults"]) {
			$(id).addEventListener("change", savePrefs);
		}
		for (let id of ["target", "opt-pdf", "opt-skip", "opt-extra", "opt-trnote", "opt-fillpdf", "opt-queue"]) $(id).addEventListener("change", () => syncImportBar());
		$("import-opts-toggle")?.addEventListener("click", () => { state.optsOpen = !state.optsOpen; syncImportBar(); });
		// detail actions
		// An owned paper's main action shows its library copy; any other adds it.
		$("d-queue").addEventListener("click", () => queueDetail());
		$("d-primary").addEventListener("click", () => { let r = detailRecord(); if (!r) return; if (r.inLibrary) showInLibrary(r); else importRecords([r]); });

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
		document.addEventListener("click", () => { hideCtxMenu(); closeSelMenu(); closeHistoryMenu(); closeToolbarMenu(); });
		window.addEventListener("blur", () => { closeSelMenu(); closeHistoryMenu(); closeToolbarMenu(); });
		window.addEventListener("resize", () => { closeSelMenu(); closeHistoryMenu(); closeToolbarMenu(); });
		document.addEventListener("scroll", onDocumentScroll, true);
		window.addEventListener("unload", saveLayout);
		window.addEventListener("unload", () => state.searchController?.abort());
		window.addEventListener("unload", cancelCacheRestore);
		window.addEventListener("unload", () => cancelRelated());
		window.addEventListener("unload", () => { try { ZotPoPImporter?.dispose?.(); } catch (e) { /* the window is closing anyway */ } });
		window.addEventListener("unload", () => { clearTimeout(previewTimer); previewViewer?.close(); });
		window.addEventListener("resize", debounce(saveLayout, 400));
		window.addEventListener("resize", debounce(fitTitleColumn, 100));
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
		btn?.removeAttribute("aria-controls");
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
		closeToolbarMenu();
	}

	function openSelMenu(sel) {
		if (openSel && openSel.sel === sel) { closeSelMenu(); return; }
		closeSelMenu();
		if (sel.disabled || !sel.options.length) return;
		let btn = selButton(sel);
		let menu = document.createElement("div");
		menu.className = "selmenu";
		menu.setAttribute("role", "listbox");
		if (sel.id) { menu.id = sel.id + "-list"; btn.setAttribute("aria-controls", menu.id); }
		let named = btn.getAttribute("aria-labelledby");
		if (named) menu.setAttribute("aria-labelledby", named.split(" ")[0]);
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
			menu.style.top = (r.bottom + 8) + "px";
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
		/* The field's own caption names the button ("Engine, Direct"), as it named the select it stands in for:
		   <label for=…> or the caption span of a wrapping <label>. */
		if (sel.id) {
			btn.id = sel.id + "-btn"; label.id = sel.id + "-value";
			let caption = null;
			try { caption = document.querySelector(`label[for="${CSS.escape(sel.id)}"]`) || sel.closest?.("label")?.querySelector?.("span"); } catch (e) { caption = null; }
			if (caption) { if (!caption.id) caption.id = sel.id + "-caption"; btn.setAttribute("aria-labelledby", caption.id + " " + label.id); }
		}
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
		PREF("fillMissingPDF", $("opt-fillpdf").checked);
		PREF("skipDuplicates", $("opt-skip").checked);
		PREF("citationsInExtra", $("opt-extra").checked);
		PREF("keepTranslatedAbstract", $("opt-trnote").checked);
		PREF("queueOnAdd", $("opt-queue").checked);
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
		tip($("authors"), t(pop ? "popAuthorsHelp" : "authorsHelp"));
		tip($("title"), t(pop ? "popTitleHelp" : "titleHelp"));
		if ($("combined-options")) $("combined-options").hidden = pop || key !== "multi";
		if ($("pop-options")) $("pop-options").hidden = !pop;
		if ($("direct-sort-field")) $("direct-sort-field").hidden = pop;
		if ($("pop-sort-field")) $("pop-sort-field").hidden = !pop;
		if (pop) { showBanner(t("popModeNoticeShort"), null, { tip: t("popModeNotice") }); return; }
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
			detailKey: state.detailKey, sortKey: state.sortKey, sortDir: state.sortDir, filter: $("filter").value, rules: state.rules });
	}
	function restoreSurfaceResults() {
		let saved = surfaceSnapshots.get(currentSurfaceKey());
		Object.assign(state, saved || { records: [], selected: new Set(), focusKey: null, detailKey: null, sortKey: "rank", sortDir: "asc" });
		resetFilters(); $("filter").value = saved?.filter || ""; state.rules = saved?.rules || [];
	}
	function applySearchSurface() {
		$("query-form").hidden = searchSurface === "authors";
		$("author-panel").hidden = searchSurface !== "authors";
		$("mode-papers").setAttribute("aria-pressed", String(searchSurface === "papers"));
		$("mode-authors").setAttribute("aria-pressed", String(searchSurface === "authors"));
		sourceHint(); renderAuthorProfiles();
	}
	// What the status line says when nothing is running: the results on screen, or "ready" for none.
	function restStatus() {
		let n = state.records.length;
		if (!n) return t("ready");
		let label = searchSurface === "authors" ? authorProviderLabel(activeAuthorProvider) : sourceLabel($("source").value);
		return t("resultCount", label, n, false, 0);
	}
	async function settleActiveSearch() {
		if (state.searching) { state.searchController?.abort(); try { await state.searchDone; } catch (_) {} }
	}
	async function switchSearchMode(mode) {
		if (state.importing || !["papers", "authors"].includes(mode)) return;
		cancelCacheRestore(); while (state.searching) await settleActiveSearch();
		if (searchSurface !== mode) { saveSurfaceResults(); searchSurface = mode; restoreSurfaceResults(); }
		PREF("searchSurface", mode); applySearchSurface(); hideBanner(); setStatus(restStatus()); render();
	}
	async function switchAuthorProvider(provider) {
		if (!AUTHOR_PROVIDERS.includes(provider)) return;
		if (state.importing) { $("author-provider").value = activeAuthorProvider; return; }
		cancelCacheRestore(); while (state.searching) await settleActiveSearch();
		authorSessions[activeAuthorProvider].input = $("author-input").value;
		if (activeAuthorProvider === "scholar") authorSessions.scholar.inputKind = $("author-input-kind").value || "auto";
		if (searchSurface === "authors") saveSurfaceResults();
		activeAuthorProvider = provider; $("author-provider").value = provider;
		authorAction = authorSessions[provider].action;
		$("author-input").value = authorSessions[provider].input;
		$("author-input-kind").value = authorSessions[provider].inputKind || "auto";
		syncSel($("author-provider")); syncSel($("author-input-kind"));
		if (searchSurface === "authors") restoreSurfaceResults();
		saveAuthorPreferences(); updateAuthorHint(); renderAuthorProfiles(); hideBanner(); setStatus(restStatus()); render();
	}
	function saveAuthorPreferences() {
		authorSessions[activeAuthorProvider].input = $("author-input").value;
		if (activeAuthorProvider === "scholar") authorSessions.scholar.inputKind = $("author-input-kind").value || "auto";
		PREF("lastAuthorQuery", JSON.stringify({ provider: activeAuthorProvider, inputKind: $("author-input-kind").value || "auto", maxResults: $("author-max-results").value,
			sessions: Object.fromEntries(Object.entries(authorSessions).map(([key, value]) => [key, { input: value.input, profile: value.profile, action: value.action, inputKind: value.inputKind, pick: value.pick }])) }));
	}
	function restoreAuthorPreferences() {
		let saved = {}; try { saved = JSON.parse(PREF("lastAuthorQuery") || "{}"); } catch (_) {}
		activeAuthorProvider = AUTHOR_PROVIDERS.includes(saved.provider) ? saved.provider : "combined";
		for (let key of AUTHOR_PROVIDERS) {
			let session = saved.sessions?.[key];
			authorSessions[key].input = typeof session?.input === "string" ? session.input : "";
			authorSessions[key].action = ["profiles", "publications", "name-papers"].includes(session?.action) ? session.action : "profiles";
			authorSessions[key].inputKind = ["name", "profile"].includes(session?.inputKind) ? session.inputKind : "auto";
			if (session?.profile?.provider === key && typeof session.profile.id === "string") {
				authorSessions[key].profile = session.profile; authorSessions[key].profiles = [session.profile];
			}
			authorSessions[key].pick = validPick(session?.pick);
		}
		$("author-provider").value = activeAuthorProvider;
		$("author-input-kind").value = authorSessions[activeAuthorProvider].inputKind;
		authorAction = authorSessions[activeAuthorProvider].action;
		$("author-input").value = authorSessions[activeAuthorProvider].input;
		syncSel($("author-provider")); syncSel($("author-input-kind"));
		let max = Number(saved.maxResults); $("author-max-results").value = Number.isInteger(max) && max >= 1 && max <= 2000 ? String(max) : "1000";
	}
	function updateAuthorHint() {
		let orcid = activeAuthorProvider === "orcid", combined = activeAuthorProvider === "combined", kind = combined ? "Combined" : orcid ? "Orcid" : "Scholar";
		$("author-input-label").textContent = t("author" + kind + "Input");
		$("author-input").placeholder = combined ? t("authorCombinedInput") : "";
		$("author-help").textContent = t("author" + kind + "Help");
		let more = $("author-help-more"), toggle = $("author-help-toggle");
		if (more && toggle) {
			more.textContent = t("author" + kind + "HelpMore");
			let open = state.authorHelpOpen === true;
			more.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
		}
		$("author-name-btn").hidden = orcid;
		$("author-input-kind-field").hidden = orcid || combined;
	}
	function authorInputChanged() {
		cancelCacheRestore();
		if (searchSurface === "authors") state.searchController?.abort();
		let session = authorSessions[activeAuthorProvider]; session.profiles = []; session.profile = null; session.pick = null; session.action = authorAction = "profiles"; authorView.showAll = false;
		saveAuthorPreferences(); renderAuthorProfiles();
	}
	// ------------------------------------------------------------ profile cards
	const SUMMARY_TTL = 30 * 24 * 3600 * 1000;
	async function summaryDisk() {
		if (authorView.disk) return authorView.disk;
		let all = {};
		if (cacheIO) { try { let saved = JSON.parse(await cacheIO.readText(dataPath("orcid-summaries.json"))); if (saved && typeof saved === "object") all = saved; } catch (_) {} }
		return authorView.disk = all;
	}
	async function loadOrcidSummary(profile) {
		let id = profile.id, entry = authorView.summaries.get(id);
		if (entry && entry.status !== "error") return;
		authorView.summaries.set(id, { status: "loading" }); renderAuthorProfiles();
		try {
			let disk = await summaryDisk(), hit = disk[id];
			let data = hit && Date.now() - hit.at < SUMMARY_TTL ? hit.data : null;
			if (!data) {
				data = await ZotPoPAuthors.orcidSummary(id, http, {});
				disk[id] = { at: Date.now(), data };
				for (let key of Object.keys(disk).sort((x, y) => disk[y].at - disk[x].at).slice(40)) delete disk[key];
				if (cacheIO && !data.partial) cacheIO.writeText(dataPath("orcid-summaries.json"), JSON.stringify(disk)).catch(e => log("saving ORCID summaries failed: " + e.message));
			}
			if (data.linkedin) authorView.linkedin.set(id, data.linkedin);
			else if (!data.partial) authorView.linkedin.set(id, false);
			authorView.summaries.set(id, { status: "ready", data });
		} catch (error) { log("ORCID summary failed: " + error.message); authorView.summaries.set(id, { status: "error" }); }
		renderAuthorProfiles();
	}
	function toggleOrcidSummary(profile) {
		if (authorView.open.has(profile.id)) authorView.open.delete(profile.id); else { authorView.open.add(profile.id); loadOrcidSummary(profile); }
		renderAuthorProfiles();
	}
	function summaryYears(row) {
		let present = t("authorSummaryPresent");
		if (row.start && row.end) return row.start === row.end ? String(row.start) : row.start + "–" + row.end;
		if (row.start) return row.start + "–" + (row.current ? present : "");
		return row.end ? String(row.end) : "";
	}
	function summaryList(title, rows, max, line) {
		if (!rows.length) return null;
		let box = document.createElement("div"); box.className = "author-sum-block";
		let h = document.createElement("div"); h.className = "author-sum-title"; h.textContent = title; box.appendChild(h);
		for (let row of rows.slice(0, max)) { let item = document.createElement("div"); item.className = "author-sum-row"; item.textContent = line(row); box.appendChild(item); }
		if (rows.length > max) { let more = document.createElement("div"); more.className = "author-sum-more"; more.textContent = t("authorSummaryMore", rows.length - max); box.appendChild(more); }
		return box;
	}
	function renderOrcidSummary(profile) {
		let panel = document.createElement("div"); panel.className = "author-summary";
		let entry = authorView.summaries.get(profile.id) || { status: "loading" };
		let note = text => { let n = document.createElement("div"); n.className = "author-sum-note"; n.textContent = text; panel.appendChild(n); };
		if (entry.status === "loading") { note(t("authorSummaryLoading")); return panel; }
		if (entry.status === "error") { note(t("authorSummaryFail")); return panel; }
		let data = entry.data;
		if (data.empty) { note(t("authorSummaryEmpty")); return panel; }
		if (data.bio) {
			let bio = document.createElement("div"); bio.className = "author-bio" + (authorView.bioOpen.has(profile.id) ? "" : " clamped"); bio.textContent = data.bio; panel.appendChild(bio);
			if (data.bio.length > 160) {
				let toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "ghost author-bio-toggle"; toggle.textContent = t(authorView.bioOpen.has(profile.id) ? "authorBioLess" : "authorBioMore");
				toggle.addEventListener("click", () => { if (authorView.bioOpen.has(profile.id)) authorView.bioOpen.delete(profile.id); else authorView.bioOpen.add(profile.id); renderAuthorProfiles(); });
				panel.appendChild(toggle);
			}
		}
		let joined = (parts) => parts.filter(Boolean).join(" · ");
		let jobs = summaryList(t("authorSummaryJobs"), data.employments, 4, row => joined([row.role, row.org, summaryYears(row)]));
		let studies = summaryList(t("authorSummaryStudies"), data.educations, 3, row => joined([row.role, row.org, row.end || row.start]));
		for (let block of [jobs, studies]) if (block) panel.appendChild(block);
		if (data.keywords.length) {
			let box = document.createElement("div"); box.className = "badges author-sum-chips";
			for (let word of data.keywords) { let chip = document.createElement("span"); chip.className = "badge"; chip.textContent = word; box.appendChild(chip); }
			panel.appendChild(box);
		}
		if (data.websites.length) {
			let box = document.createElement("div"); box.className = "author-sum-sites";
			for (let site of data.websites) {
				let open = document.createElement("button"); open.type = "button"; open.className = "ghost author-site";
				open.appendChild(iconNode(site.linkedin ? "ic-linkedin" : "ic-external"));
				let label = document.createElement("span"); label.textContent = site.linkedin ? t("authorLinkedIn") : (site.name || site.url.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, ""));
				open.appendChild(label); tip(open, site.url);
				open.addEventListener("click", () => Zotero.launchURL(site.url)); box.appendChild(open);
			}
			panel.appendChild(box);
		}
		if (data.partial) note(t("authorSummaryPartial"));
		return panel;
	}
	// LinkedIn is only ever linked to, never read. For an ORCID person the record may name a profile; asked once, when pressed.
	function linkedInState(profile) {
		let orcidId = orcidIdOf(profile), known = orcidId ? authorView.linkedin.get(orcidId) : undefined;
		let target = ZotPoPAuthors.linkedInTarget({ ...profile, linkedin: known || profile.linkedin });
		let tipKey = target?.kind === "profile" ? "authorLinkedInProfileTip" : orcidId && known === undefined ? "authorLinkedInMaybeTip" : "authorLinkedInSearchTip";
		return { target, known, tipKey };
	}
	async function openLinkedIn(profile, button) {
		let state_ = linkedInState(profile);
		let orcidId = orcidIdOf(profile);
		if (orcidId && state_.known === undefined) {
			button.disabled = true;
			try { authorView.linkedin.set(orcidId, await ZotPoPAuthors.orcidLinkedIn(orcidId, http, {}) || false); }
			catch (error) { log("ORCID researcher-urls failed: " + error.message); }
			button.disabled = false; state_ = linkedInState(profile);
		}
		if (state_.target) Zotero.launchURL(state_.target.url);
		renderAuthorProfiles();
	}
	/* The cards are drawn again on every change (a summary opened, more people, a follow): the control that
	   had the keyboard is found again by its data-fkey and keeps it, instead of focus falling to the page.
	   After "more people" the keyboard goes to the first new person (authorView.focusNext). */
	function renderAuthorProfiles() {
		let host = $("author-profiles"), session = authorSessions[activeAuthorProvider];
		let had = document.activeElement && host.contains?.(document.activeElement) ? document.activeElement.getAttribute?.("data-fkey") : null;
		host.textContent = "";
		try { drawAuthorProfiles(host, session); }
		finally {
			let want = authorView.focusNext || had;
			if (want) {
				let found = host.querySelector?.(`[data-fkey="${CSS.escape(want)}"]`);
				if (found) { found.focus?.(); if (want === authorView.focusNext) authorView.focusNext = null; }
				else if (had) host.querySelector?.('[data-fkey^="load:"]')?.focus?.();
			}
		}
	}
	function drawAuthorProfiles(host, session) {
		let isChosen = profile => Boolean(session.profile && profile.id === session.profile.id && profile.name === session.profile.name);
		// Profiles with no papers anywhere wait behind "more" while better matches exist.
		let weak = session.profiles.filter(profile => profile.weak && !isChosen(profile));
		let folded = !authorView.showAll && weak.length > 0 && weak.length < session.profiles.length;
		for (let profile of session.profiles) {
			if (folded && profile.weak && !isChosen(profile)) continue;
			let card = document.createElement("article"); card.className = "author-profile";
			// Read as the person's name, so "Load publications" inside it is heard with whose they are.
			card.setAttribute("aria-label", profile.name || profile.id || t("authorNameUnverified"));
			let chosen = isChosen(profile);
			if (chosen) card.classList.add("selected");
			let orcid = orcidIdOf(profile);
			let summaryOpen = Boolean(orcid && authorView.open.has(orcid));
			if (summaryOpen) card.classList.add("open");
			let info = document.createElement("div"); info.className = "author-profile-info";
			// The name, then what is known about who this is as a badge beside it: lime for a public registry profile, amber for "not confirmed".
			let head = document.createElement("div"); head.className = "author-profile-head";
			let name = document.createElement("span"); name.className = "author-profile-name"; name.textContent = profile.name || profile.id || t("authorNameUnverified");
			head.appendChild(name);
			let confirmed = profile.mode !== "name-search" && profile.identityConfirmed;
			if (profile.provider === "combined" && profile.sources?.length) {
				// Which services know this person: one badge each, OpenAlex and ORCID, instead of the generic "confirmed".
				for (let source of profile.sources) { let b = document.createElement("span"); b.className = "badge lib"; b.textContent = source === "orcid" ? "ORCID" : "OpenAlex"; tip(b, t(source === "orcid" ? "authorSrcOrcidTip" : "authorSrcOpenAlexTip")); head.appendChild(b); }
			} else {
				let badge = document.createElement("span");
				badge.className = "badge " + (confirmed ? "lib" : "warn");
				badge.textContent = t(profile.mode === "name-search" ? "authorNameUnverified" : profile.identityConfirmed ? "authorIdentityConfirmed" : "authorIdentityPending");
				tip(badge, t(confirmed ? "authorIdentityConfirmedTip" : "authorIdentityUnconfirmedTip"));
				head.appendChild(badge);
			}
			if (chosen) { let check = document.createElement("span"); check.className = "author-profile-check"; check.appendChild(iconNode("ic-check")); head.appendChild(check); }
			info.appendChild(head);
			// papers, citations and h-index as small badges: what OpenAlex counts under this ORCID iD
			if (profile.worksCount != null || profile.hIndex != null) {
				let stats = document.createElement("div"); stats.className = "badges author-profile-stats";
				let add = (text, hint) => { let chip = document.createElement("span"); chip.className = "badge"; chip.textContent = text; if (hint) tip(chip, hint); stats.appendChild(chip); };
				let hTip = profile.hIndexes?.length ? t("authorHProfilesTip", profile.hIndexes.map(x => x.openalexId + ": " + (x.hIndex ?? "?")).join(", ")) : "";
				if (profile.worksCount != null) add(t("authorStatWorks", Number(profile.worksCount)), hTip);
				if (profile.citations != null) add(t("authorStatCited", Number(profile.citations)));
				if (profile.hIndex != null) add(t("authorStatH", profile.hIndex));
				info.appendChild(stats);
			}
			// the affiliation, and the identifier muted behind it on the same line
			let meta = [profile.affiliation, profile.provider === "combined" ? (profile.orcid ? "ORCID " + profile.orcid : "") : profile.id].filter(Boolean);
			if (meta.length) { let node = document.createElement("div"); node.className = "author-profile-meta"; node.textContent = meta.join(" · ");
				if (profile.institutions?.length > 2) node.setAttribute("data-tip", profile.institutions.join("; "));
				info.appendChild(node); }
			// where OpenAlex last saw them (with the country flag) and what they write about most
			let last = profile.lastInstitution, shown = (profile.affiliation || "").toLowerCase();
			let where = last && !(shown && shown.includes(String(last.name).toLowerCase())) ? ((last.country ? ZotPoPAffiliations.flag(last.country) + " " : "") + last.name) : "";
			let extra = [where, profile.topic].filter(Boolean);
			// The lab's standing (T1–T4 from its OpenAlex h-index) leads the line, as in the results table.
			let chip = last?.tier ? tierChip(last) : null;
			if (chip) tip(chip, last.name + "\n" + t("thTierTip") + (last.hIndex != null ? "\n" + t("affHIndex", last.hIndex) : ""));
			if (extra.length || chip) {
				let node = document.createElement("div"); node.className = "author-profile-meta author-profile-where";
				if (chip) node.appendChild(chip);
				if (extra.length) { let span = document.createElement("span"); span.textContent = extra.join(" · "); node.appendChild(span); }
				info.appendChild(node);
			}
			if (orcid) {
				let toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "ghost author-sum-toggle"; toggle.setAttribute("aria-expanded", String(summaryOpen)); toggle.setAttribute("data-fkey", "sum:" + orcid);
				toggle.appendChild(iconNode(summaryOpen ? "ic-chevron-up" : "ic-chevron-down")); let label = document.createElement("span"); label.textContent = t(summaryOpen ? "authorSummaryHide" : "authorSummary"); toggle.appendChild(label);
				toggle.addEventListener("click", () => toggleOrcidSummary({ id: orcid })); info.appendChild(toggle);
				if (summaryOpen) info.appendChild(renderOrcidSummary({ id: orcid }));
			}
			let actions = document.createElement("div"); actions.className = "author-profile-actions";
			if (profile.id) { let load = document.createElement("button"); load.type = "button"; load.className = "author-load"; load.textContent = t("authorLoadWorks"); load.disabled = state.searching || state.importing;
				load.setAttribute("data-fkey", "load:" + profile.id);
				if (chosen) load.classList.add("primary");
				load.addEventListener("click", () => runAuthorAction("publications", profile)); actions.appendChild(load); }
			if (/^https:\/\//i.test(profile.url || "")) { let open = document.createElement("button"); open.type = "button"; open.textContent = t("authorOpenProfile"); open.setAttribute("data-fkey", "open:" + profile.id);
				open.addEventListener("click", () => Zotero.launchURL(profile.url)); actions.appendChild(open); }
			if (profile.openalexId) {
				let w = watchButton({ openalexId: profile.openalexId, alsoIds: profile.alsoIds, name: profile.name || profile.id, institution: profile.affiliation || profile.lastInstitution?.name || "" }, renderAuthorProfiles);
				if (w) { w.classList.add("author-watch"); w.setAttribute("data-fkey", "watch:" + profile.openalexId); actions.appendChild(w); }
			}
			let li = linkedInState(profile);
			if (li.target) {
				let linkedin = document.createElement("button"); linkedin.type = "button"; linkedin.className = "author-linkedin"; linkedin.setAttribute("data-fkey", "li:" + profile.id);
				linkedin.appendChild(iconNode("ic-linkedin")); let label = document.createElement("span"); label.textContent = t("authorLinkedIn"); linkedin.appendChild(label);
				tip(linkedin, t(li.tipKey)); linkedin.addEventListener("click", () => openLinkedIn(profile, linkedin)); actions.appendChild(linkedin);
			}
			// the card itself is the quickest way to the papers
			if (profile.id) { card.classList.add("pickable");
				card.addEventListener("click", event => { if (event.target.closest?.("button, a, .author-summary")) return; if (!state.searching && !state.importing) runAuthorAction("publications", profile); }); }
			card.appendChild(info); card.appendChild(actions); host.appendChild(card);
		}
		if (weak.length && (folded || authorView.showAll)) {
			let more = document.createElement("button"); more.type = "button"; more.className = "ghost author-more"; more.setAttribute("data-fkey", "more");
			more.textContent = folded ? t("authorMoreProfiles", weak.length) : t("authorFewerProfiles");
			more.addEventListener("click", () => { authorView.showAll = !authorView.showAll; renderAuthorProfiles(); }); host.appendChild(more);
		}
		/* The services hold more people under this name than the first page: the next page is fetched only when
		   this is pressed (OpenAlex is metered), and says how many each service still has. */
		if (session.profiles.length && typeof ZotPoPAuthors !== "undefined" && ZotPoPAuthors.hasMorePeople?.(session.paging)) {
			let next = document.createElement("button"); next.type = "button"; next.className = "author-more author-next";
			next.setAttribute("data-opens", "network"); next.setAttribute("data-fkey", "next");
			let loading = Boolean(authorView.moreController);
			next.textContent = loading ? t("authorNextLoading") : t("authorNextPeople", session.profiles.length, peopleTotals(session.paging));
			tip(next, t("authorNextTip"));
			// While the next page loads the button stays focusable (aria-disabled, not disabled), so the keyboard is not dropped.
			if (loading) next.setAttribute("aria-disabled", "true");
			next.disabled = !loading && (state.searching || state.importing);
			next.addEventListener("click", () => loadMoreProfiles());
			host.appendChild(next);
		}
	}
	// What each service still holds under the name: "OpenAlex 230 · ORCID 41".
	function peopleTotals(paging) {
		return [["OpenAlex", paging?.openalex], ["ORCID", paging?.orcid]].filter(([, p]) => p?.next && p.total != null)
			.map(([name, p]) => name + " " + Number(p.total).toLocaleString(t.locale || undefined)).join(" \u00b7 ");
	}
	async function loadMoreProfiles() {
		let provider = activeAuthorProvider, session = authorSessions[provider];
		if (authorView.moreController || state.searching || state.importing || !ZotPoPAuthors.hasMorePeople?.(session.paging)) return;
		// The name the first page was asked with, not whatever the box holds now.
		let input = session.paging.input || $("author-input").value, controller = authorView.moreController = new AbortController();
		let active = () => authorView.moreController === controller && !controller.signal.aborted && activeAuthorProvider === provider && authorSessions[provider] === session;
		let ctx = { signal: controller.signal, isCancelled: () => controller.signal.aborted, errors: [], email: String(PREF("email") || ""),
			openAlexApiKey: String(PREF("openAlexApiKey") || ""), openAlexSpent: openAlexHeld(), log };
		renderAuthorProfiles(); setStatus(t("authorNextLoading"));
		try {
			let out = await ZotPoPAuthors.moreProfiles(provider, input, session.profiles, session.paging, http, ctx);
			if (!active()) return;
			session.profiles = [...session.profiles, ...out.added]; session.paging = out.paging ? { ...out.paging, input } : null;
			// The keyboard that asked for more goes to the first person it brought.
			let keyboardAsked = document.activeElement?.getAttribute?.("data-fkey") === "next";
			if (keyboardAsked && out.added[0]?.id) authorView.focusNext = "load:" + out.added[0].id;
			// New cards are shown as they are: a weak one is not hidden behind "more" after the user asked for more.
			if (out.added.some(c => c.weak)) authorView.showAll = true;
			setStatus(t("authorNextLoaded", out.added.length, session.profiles.length));
			if (ctx.errors.length) showBanner(t("partialFail", explainList(ctx.errors)), null, { warn: true });
			// The saved people list grows with it, so reopening this search from history shows them all.
			if (session.action === "profiles" && $("author-input").value === input) await history?.save({ source: "author:" + provider, query: { ...authorQuery("profiles"), authorProfile: session.profile, authorProfiles: session.profiles, authorPaging: session.paging }, records: [], partial: false });
		}
		catch (error) {
			if (active() && error?.name !== "AbortError") { setStatus(t("searchFailed", explain(error.message || error)), "err"); }
		}
		finally {
			noteOpenAlexSpent(ctx); saveCaches();
			if (authorView.moreController === controller) authorView.moreController = null;
			if (activeAuthorProvider === provider) renderAuthorProfiles();
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
		if (!AUTHOR_PROVIDERS.includes(provider)) return false;
		await refreshLibraryFlags(); if (!active()) return false;
		if (activeAuthorProvider !== provider) { saveSurfaceResults(); activeAuthorProvider = provider; }
		$("author-provider").value = provider; $("author-input").value = query.authorInput || "";
		$("author-input-kind").value = query.authorInputKind || "auto";
		$("author-max-results").value = String(query.maxResults || 1000);
		let session = authorSessions[provider]; session.input = $("author-input").value;
		session.inputKind = query.authorInputKind || "auto";
		session.profile = query.authorProfile || entry.records?.[0]?.authorProfile || null;
		session.profiles = Array.isArray(query.authorProfiles) && query.authorProfiles.length ? query.authorProfiles : session.profile ? [session.profile] : [];
		session.paging = query.authorPaging || null;
		session.action = authorAction = query.authorAction || "profiles"; session.pick = validPick(query.authorPick); state.metricsBasisUser = false;
		state.selected.clear(); state.focusKey = null; state.detailKey = null; resetFilters();
		// A person's papers come back newest first, as they were shown when first loaded.
		let personWorks = query.authorAction === "publications" && provider !== "scholar";
		state.sortKey = personWorks ? "year" : entry.records.some(r => r.popOriginal) ? "popOrdinal" : "rank"; state.sortDir = personWorks ? "desc" : "asc";
		displaySearchResults(entry.records); updateAuthorHint(); renderAuthorProfiles(); saveAuthorPreferences();
		// The rows just drawn are the ones the library is asked about: title matches, reading state, collections.
		refreshLibraryFlags().catch(e => log("library flags after restore: " + e.message));
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
		if (action === "name-papers" && (!["scholar", "combined"].includes(activeAuthorProvider) || q.authorInputKind === "profile" || ZotPoPAuthors.parseOrcid(input) || /https?:\/\//i.test(input))) { setStatus(t("authorNeedName"), "err"); return; }
		if (action === "publications" && (!profile?.id || profile.provider !== activeAuthorProvider)) return;
		authorAction = action;
		let session = authorSessions[activeAuthorProvider];
		session.action = action;
		state.metricsBasisUser = false; session.pick = null;
		authorView.moreController?.abort(); authorView.moreController = null;
		if (action !== "publications") { session.profiles = []; session.profile = null; session.paging = null; authorView.showAll = false; } else { session.profile = profile; authorView.open.clear(); }
		saveAuthorPreferences();
		state.records = []; state.selected.clear(); state.focusKey = null; state.detailKey = null; resetFilters();
		state.searching = true; state.cancelled = false;
		let resolveDone; state.searchDone = new Promise(resolve => { resolveDone = resolve; });
		let controller = state.searchController = new AbortController();
		let active = () => state.searchController === controller && !controller.signal.aborted && searchSurface === "authors"
			&& activeAuthorProvider === q.authorProvider && $("author-input").value === q.authorInput;
		let autoPick = null, received = [], profiles = [], message = t(action === "profiles" ? "authorLookup" : "authorLoading"), fallbackToName = false;
		$("author-search-btn").disabled = true; $("author-name-btn").disabled = true; $("author-stop-btn").disabled = false;
		$("search-btn").disabled = true; $("busy").hidden = action === "profiles"; $("busy-text").textContent = message;
		setStatus(message); hideBanner(); renderAuthorProfiles(); render();
		let ctx = { signal: controller.signal, isCancelled: () => controller.signal.aborted, errors: [], scholarInputKind: q.authorInputKind || "auto", DOMParser: window.DOMParser,
			email: String(PREF("email") || ""), openAlexApiKey: String(PREF("openAlexApiKey") || ""), openAlexSpent: openAlexHeld(),
			popSearchSource: typeof ZotPoPPoPBridge !== "undefined" && ZotPoPPoPBridge.searchSource ? (source, query, context) => ZotPoPPoPBridge.searchSource(source, query, context) : undefined,
			onProgress: (msg, n, total) => { if (active()) { setStatus(progressText(msg)); setProgress(n, total); } },
			onResults: records => { if (active()) { received = records; defaultSort(records); displaySearchResults(records, { stream: true }); } }, log };
		/* The list's own order is set once, by the first batch (or the final list when nothing streamed):
		   a column the reader sorts by while the rest streams in stays sorted. An ORCID person's papers
		   read newest first, whichever source they came from, from the first batch on. */
		let orcidWorks = action === "publications" && q.authorProvider !== "scholar", sortSet = false;
		let defaultSort = records => {
			if (sortSet) return;
			sortSet = true;
			state.sortKey = orcidWorks ? "year" : records.some(r => r.popOriginal) ? "popOrdinal" : "rank"; state.sortDir = orcidWorks ? "desc" : "asc";
		};
		try {
			let options = { maxResults: q.maxResults, popOutputSort: "rank" };
			let task = action === "profiles" ? ZotPoPAuthors.searchProfiles(q.authorProvider, input, http, ctx)
				: action === "name-papers" ? ZotPoPAuthors.loadNamePublications(input, options, http, ctx, q.authorProvider) : ZotPoPAuthors.loadPublications(profile, options, http, ctx);
			let result = await abortableAuthorTask(task, controller.signal);
			if (!active()) throw abortError();
			if (action === "profiles") { profiles = result; session.profiles = result; session.paging = result.paging ? { ...result.paging, input } : null; setStatus(result.length ? t("authorProfilesFound", result.length) : t("authorNoProfiles")); if (q.authorProvider === "combined" && result.length === 1 && result[0].direct) autoPick = result[0]; }
			else {
				received = result; session.profile = { ...(profile || {}), ...(result.authorProfile || result.profile || profile || {}) };
				if (session.profile.provider) {
					if (action === "publications" && session.profiles.some(item => item.id === session.profile.id)) session.profiles = session.profiles.map(item => item.id === session.profile.id ? session.profile : item);
					else session.profiles = [session.profile];
				}
				defaultSort(result);
				displaySearchResults(result); await refreshLibraryFlags(); if (!active()) throw abortError();
				let partial = Boolean(result.partial || ctx.errors.length);
				if (orcidWorks) setStatus(q.authorProvider === "combined" ? t("authorCombinedWorks", session.profile.name || session.profile.id, result.length, Boolean(result.partial)) : t("authorOrcidWorks", session.profile.name || session.profile.id, session.profile.id, result.length, Boolean(result.partial)));
				else setStatus(t(partial ? "incompleteResults" : "resultCount", authorProviderLabel(q.authorProvider), result.length, false));
				let popNotice = action !== "name-papers" && q.authorProvider === "scholar";
				showBanner(t(action === "name-papers" ? "authorNameUnverified" : q.authorProvider === "combined" ? (result.authorProvenance?.via === "openalex" ? "authorCombinedViaOpenAlex" : "authorOrcidViaOrcid") : q.authorProvider === "orcid" ? (result.authorProvenance?.via === "openalex" ? "authorOrcidViaOpenAlex" : "authorOrcidViaOrcid") : "popModeNoticeShort")
					+ (result.authorProvenance?.truncated ? " " + t("authorLimited", result.length, result.authorProvenance.totalGroups) : ""), null, popNotice ? { tip: t("popModeNotice") } : {});
			}
			if (ctx.errors.length) showBanner(t("partialFail", explainList(ctx.errors)), null, { warn: true });
			await history?.save({ source: "author:" + q.authorProvider, query: { ...q, authorProfile: session.profile, authorProfiles: session.profiles, authorPaging: session.paging || null },
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
				fallbackToName = true; setStatus(t("searchFailed", explain(error.message || error)), "err");
			}
			else if (error.wall) { setStatus(t("searchFailed", explain(error.message || error)), "err"); scholarWallBanner(error, () => runAuthorAction(action, profile)); }
			else { let text = t("searchFailed", explain(error.message || error)); setStatus(text, "err"); showBanner(text, null, { warn: true }); }
		} finally {
			if (state.searchController === controller || !state.searchController) { state.searching = false; state.searchController = null;
				$("author-search-btn").disabled = false; $("author-name-btn").disabled = false; $("author-stop-btn").disabled = true; $("search-btn").disabled = false;
				$("busy").hidden = true; setProgress(null); renderAuthorProfiles(); render(); }
			// What this search paid OpenAlex for (institution tiers, journal figures) is kept for the next window, as a paper search does.
			saveCaches();
			resolveDone();
		}
		// An ORCID iD or OpenAlex id names one person: their papers load without another click.
		if (autoPick && searchSurface === "authors" && activeAuthorProvider === "combined" && $("author-input").value === input) { await runAuthorAction("publications", autoPick); return; }
		if (fallbackToName) {
			await runAuthorAction("name-papers");
			if (searchSurface === "authors" && activeAuthorProvider === "scholar" && $("author-input").value === input) showBanner(t("scholarProfileLogin"));
		}
	}

	// ------------------------------------------------------------ query persistence
	// ------------------------------------------------------------ the journal box
	/* The publication field of the form finds journals as you type: full names, the abbreviation a
	   reference list prints ("Nat Methods", "Proc Natl Acad Sci") and the letters people say ("PNAS",
	   "NAR", "JACS"), from lists on this machine, with OpenAlex's autocomplete asked only when those
	   have fewer than five answers. A journal picked becomes a chip in the field; several can be
	   picked and the search covers any of them. Typing a name and pressing Search without picking works
	   as it always did. The builder's journal rule picks from the results instead (counts), so the two
	   share the look, not the list. */
	const J = ZotPoPJournals;
	const JOURNAL_LIMIT = 8;
	let journalCatalog = null, journalCatalogLoading = null, journalLookupSeq = 0, journalLookupTimer = null, journalLookupAbort = null;
	const journalLookupCache = new Map();
	state.venueChips = [];
	state.jsug = { items: [], active: -1, open: false, pending: false, query: "" };

	async function loadJournalRegistry() {
		// The reader's own copy first (it may hold licensed figures), then the one packaged with the plugin.
		try {
			let io = diskIO();
			if (io) { let path = dataPath("journals", "journal-registry.json"); if (await io.exists(path)) return JSON.parse(await io.readText(path)).journals || []; }
		} catch (e) { log("journal registry (local) not read: " + (e && e.message)); }
		try {
			if (typeof fetch === "function") { let res = await fetch("chrome://zotpop/content/journal-registry.json"); return (await res.json()).journals || []; }
		} catch (e) { log("journal registry not read: " + (e && e.message)); }
		return [];
	}
	function ensureJournalCatalog() {
		if (journalCatalog) return Promise.resolve(journalCatalog);
		journalCatalogLoading ||= (async () => {
			let registry = typeof J.held === "function" && J.held() ? J.held() : await loadJournalRegistry();
			let jcr = typeof ZotPoPJCR !== "undefined" && typeof ZotPoPJCR.rows === "function" ? ZotPoPJCR.rows() : [];
			journalCatalog = J.build({ curated: ZotPoPJournalMarks.ABBREVIATIONS, abbreviate: ZotPoPJournalMarks.abbreviateByWords, registry, jcr });
			return journalCatalog;
		})();
		return journalCatalogLoading;
	}

	// ---- chips
	function renderVenueChips() {
		let box = $("venue-chips"); if (!box) return;
		box.textContent = "";
		state.venueChips.forEach((chip, i) => {
			let el = fel("span", "jchip");
			tip(el, [chip.name, chip.abbrev, chip.publisher].filter(Boolean).join(" · "));
			// the journal's full name in its publisher's ink, like everywhere else
			let nameEl = fel("span", "jchip-name", chip.name); paintVenue(nameEl, { venue: chip.name, journalAbbrev: chip.abbrev || undefined });
			el.appendChild(nameEl);
			el.appendChild(fbutton("filter-clear", "×", t("venueChipRemove", chip.name), () => { removeVenueChip(i); $("venue").focus(); }));
			box.appendChild(el);
		});
		$("venue-box")?.classList.toggle("has-chips", state.venueChips.length > 0);
		// one line: more chips than fit scroll sideways inside the box, to the newest
		if ($("venue-box") && state.venueChips.length) $("venue-box").scrollLeft = $("venue-box").scrollWidth || 0;
		// With journals picked the field takes more of the row, so the chips lie side by side instead of stacking.
		$("venue-box")?.parentNode?.classList?.toggle("wide", state.venueChips.length > 0);
		$("venue")?.setAttribute("placeholder", state.venueChips.length ? t("venueMorePh") : t("venuePh"));
	}
	// The same journal can arrive under two spellings (PNAS's short and official names), so a chip
	// also matches by ISSN, OpenAlex id or abbreviation, not only by its name.
	function sameJournal(a, b) {
		// One title on two journals (the Society's and Pleiades' "Microbiology"): ISSNs that share nothing are two journals.
		let ia = a.issns || [], ib = b.issns || [];
		if (ia.length && ib.length && !ia.some(i => ib.includes(i))) return Boolean(a.openalexId && a.openalexId === b.openalexId);
		if (J.flat(a.name) === J.flat(b.name)) return true;
		if ((a.issns || []).some(i => (b.issns || []).includes(i))) return true;
		if (a.openalexId && a.openalexId === b.openalexId) return true;
		return Boolean(a.abbrev && b.abbrev && J.flat(a.abbrev) === J.flat(b.abbrev));
	}
	function addVenueChip(item) {
		if (!item || !item.name) return;
		if (!state.venueChips.some(c => sameJournal(c, item))) state.venueChips.push({ name: item.name, abbrev: item.abbrev || "", issns: (item.issns || []).slice(), openalexId: item.openalexId || null, ...(item.homonym && item.publisher ? { publisher: item.publisher } : {}) });
		$("venue").value = "";
		closeVenueList();
		renderVenueChips();
		cancelCacheRestore(); saveQuery(); syncQueryCollapse();
	}
	function removeVenueChip(i) {
		state.venueChips.splice(i, 1);
		renderVenueChips();
		cancelCacheRestore(); saveQuery(); syncQueryCollapse();
	}
	function setVenueChips(list) {
		state.venueChips = (Array.isArray(list) ? list : []).filter(c => c && c.name).map(c => ({ name: String(c.name), abbrev: c.abbrev || "", issns: Array.isArray(c.issns) ? c.issns : [], openalexId: c.openalexId || null }));
		renderVenueChips();
	}

	// ---- the suggestion list
	function closeVenueList() {
		let s = state.jsug; s.open = false; s.items = []; s.active = -1; s.pending = false;
		cancelLater(journalLookupTimer); journalLookupAbort?.abort?.(); journalLookupSeq++;
		let list = $("venue-list"); if (list) { list.hidden = true; list.textContent = ""; }
		let input = $("venue"); if (input) { input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
	}
	function drawVenueList() {
		let s = state.jsug, list = $("venue-list"), input = $("venue"); if (!list || !input) return;
		list.textContent = "";
		list.hidden = !s.open;
		input.setAttribute("aria-expanded", String(s.open));
		if (!s.open) return;
		s.items.forEach((item, i) => {
			let row = fel("div", "jopt" + (i === s.active ? " hot" : "")); row.id = "venue-opt-" + i;
			row.setAttribute("role", "option"); row.setAttribute("aria-selected", String(i === s.active));
			row.appendChild(fel("span", "jopt-name", item.name));
			// Two journals of one title are told apart by their publisher.
			if (item.homonym) row.appendChild(fel("span", "jopt-abbr", item.publisher || (item.issns || [])[0] || ""));
			let mark = journalMark({ venue: item.name, journalAbbrev: item.abbrev || undefined });
			// A publisher's mark (the abbreviation in its colour) when the journal is known, the plain abbreviation otherwise.
			if (mark && item.abbrev) row.appendChild(mark); else if (item.abbrev) row.appendChild(fel("span", "jopt-abbr", item.abbrev));
			else if (mark && item.source !== "remote") row.appendChild(mark);
			row.addEventListener("mousedown", e => e.preventDefault());
			row.addEventListener("click", () => addVenueChip(item));
			row.addEventListener("mousemove", () => { if (state.jsug.active !== i) { state.jsug.active = i; syncVenueActive(); } });
			list.appendChild(row);
		});
		for (let item of s.picked || []) {
			let row = fel("div", "jopt picked"); row.setAttribute("role", "option"); row.setAttribute("aria-disabled", "true"); row.setAttribute("aria-selected", "false");
			row.appendChild(fel("span", "jopt-name", item.name));
			row.appendChild(fel("span", "jopt-abbr", t("venuePicked")));
			row.addEventListener("mousedown", e => e.preventDefault());
			list.appendChild(row);
		}
		if (!s.items.length && !(s.picked || []).length) list.appendChild(fel("div", "jopt-note", s.pending ? t("venueSearching") : t("venueNoMatch")));
		else if (s.pending) list.appendChild(fel("div", "jopt-note", t("venueSearching")));
		// The key hints only help when there is something to choose.
		if (s.items.length) list.appendChild(fel("div", "jopt-foot", t("venueKeys")));
		if (s.active >= 0) input.setAttribute("aria-activedescendant", "venue-opt-" + s.active); else input.removeAttribute("aria-activedescendant");
	}
	function syncVenueActive() {
		let list = $("venue-list"), s = state.jsug;
		[...(list?.children || [])].forEach((row, i) => { if (row.getAttribute?.("role") !== "option") return; row.classList.toggle("hot", i === s.active); row.setAttribute("aria-selected", String(i === s.active)); });
		let input = $("venue");
		if (s.active >= 0) { input.setAttribute("aria-activedescendant", "venue-opt-" + s.active); list?.children?.[s.active]?.scrollIntoView?.({ block: "nearest" }); } else input.removeAttribute("aria-activedescendant");
	}
	async function refreshVenueSuggestions() {
		let input = $("venue"), query = input.value, s = state.jsug;
		if (J.flat(query).length < 2) { closeVenueList(); return; }
		let catalog = await ensureJournalCatalog();
		if ($("venue").value !== query) return;
		s.query = query;
		let found = J.suggest(catalog, query, { limit: JOURNAL_LIMIT });
		// A journal already picked stays in the list, marked, instead of vanishing: typing "proc natl acad" after picking PNAS must not look like "no match".
		let local = found.filter(x => !state.venueChips.some(c => sameJournal(c, x)));
		s.open = true; s.items = local; s.active = -1; s.picked = state.venueChips.map(c => found.find(x => sameJournal(c, x))).filter((x, i, all) => x && all.indexOf(x) === i);
		let wantRemote = local.length < 5 && J.flat(query).length >= 3 && journalLookupAllowed();
		s.pending = wantRemote;
		drawVenueList();
		cancelLater(journalLookupTimer); journalLookupAbort?.abort?.();
		let seq = ++journalLookupSeq;
		if (!wantRemote) return;
		// One request per pause, never per key: OpenAlex is metered. A question asked before is answered from memory.
		journalLookupTimer = later(async () => {
			let key = J.flat(query), items = journalLookupCache.get(key);
			try {
				if (!items) {
					journalLookupAbort = new AbortController();
					let auth = ZotPoPSources.openAlexAuth({ openAlexApiKey: PREF("openAlexApiKey") || "", email: PREF("email") || "" });
					let data = await http.getJSON("https://api.openalex.org/autocomplete/sources?q=" + encodeURIComponent(query.trim()) + auth, {}, journalLookupAbort.signal);
					items = (data.results || []).map(J.fromAutocomplete).filter(Boolean);
					journalLookupCache.set(key, items);
				}
			}
			catch (e) {
				if (ZotPoPSources.isQuotaError?.(e)) noteOpenAlexSpent({ openAlexSpent: true });
				items = [];
			}
			if (seq !== journalLookupSeq || !s.open) return;
			s.items = J.mergeSuggestions(s.items, items.filter(x => !state.venueChips.some(c => sameJournal(c, x))), JOURNAL_LIMIT);
			s.pending = false;
			drawVenueList();
		}, 300);
	}
	function journalLookupAllowed() {
		return engineValue() !== "pop" && PREF("journalLookup") !== false && !openAlexHeld() && typeof http?.getJSON === "function";
	}
	function onVenueKey(e) {
		let s = state.jsug, input = $("venue");
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (!s.open) { if (e.key === "ArrowDown") { e.preventDefault(); refreshVenueSuggestions(); } return; }
			e.preventDefault();
			let n = s.items.length; if (!n) return;
			s.active = e.key === "ArrowDown" ? (s.active + 1) % n : s.active <= 0 ? (s.active === 0 ? -1 : n - 1) : s.active - 1;
			syncVenueActive();
		}
		else if (e.key === "Enter") {
			// Pressing Enter on a highlighted journal picks it; otherwise it searches, as it always did.
			if (s.open && s.active >= 0 && s.items[s.active]) { e.preventDefault(); e.stopPropagation(); addVenueChip(s.items[s.active]); }
			else closeVenueList();
		}
		else if (e.key === "Escape") { if (s.open) { e.preventDefault(); e.stopPropagation(); closeVenueList(); } }
		else if (e.key === "Backspace" && !input.value && state.venueChips.length) { e.preventDefault(); removeVenueChip(state.venueChips.length - 1); }
		else if (e.key === "Tab") closeVenueList();
	}
	function wireVenueBox() {
		let input = $("venue"); if (!input) return;
		input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", "venue-list"); input.setAttribute("aria-expanded", "false");
		input.setAttribute("autocomplete", "off");
		input.addEventListener("input", refreshVenueSuggestions);
		input.addEventListener("keydown", onVenueKey);
		input.addEventListener("focus", () => { ensureJournalCatalog(); });
		input.addEventListener("blur", () => closeVenueList());
		// A press on the empty part of the box (or a chip's gap) goes to the input.
		$("venue-box")?.addEventListener("mousedown", e => { if (e.target === $("venue-box") || e.target === $("venue-chips")) { e.preventDefault(); input.focus(); } });
		renderVenueChips();
	}

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
		setVenueChips(saved.venueChips);
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
		o.venueChips = state.venueChips;
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
				state.sortKey = "rank";
				state.sortDir = "asc";
				displaySearchResults(records);
				// Asked after the rows are in place: a lookup run before them flagged the previous list.
				await refreshLibraryFlags();
				if (!active()) return;
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
		// What the library said about a row is asked again on restore, never read back from the snapshot.
		return records.map(({ rank, authorString, status, statusClass, statusTitle, inLibrary, isNew, collections, libraryItemID, readState, localPDFPath, localPDFFor, related, ...rest }) => {
			if (rest.popOriginal) rest.rank = rank;
			return rest;
		});
	}

	// Every finished search is kept, so that typing it again costs nothing. A stopped
	// search is kept too, marked as incomplete, since what it did fetch was paid for.
	async function rememberSearch(sourceKey, query, records, partial) {
		if (records?.length) noteCitationSnapshots(records);
		if (!history || !records?.length) return;
		// A run stopped or failed part-way never replaces a complete saved run of the same search that holds as many or more.
		try { await history.save({ source: sourceKey, query, records: stripDisplayFields(records), partial, keepComplete: true }); }
		catch (e) { log("saving search history failed: " + e.message); }
	}

	async function showHistoryEntry(entry, active = () => true, baseline = null) {
		if (entry.query?.mode === "author") return showAuthorHistory(entry, active);
		let records = entry.records || [];
		if (!records.length) return false;
		// Saved results may predate stricter author/identity checks. Revalidate
		// their fields locally without spending requests or rewriting the snapshot.
		let originalCount = records.length;
		if (entry.query?.engine !== "pop" && ZotPoPSources.filterRecords) records = ZotPoPSources.filterRecords(records, { ...entry.query, keywords: "" });
		let removed = originalCount - records.length;
		if (!active()) return false;
		state.sortKey = entry.query?.engine === "pop" ? "popOrdinal" : "rank";
		state.sortDir = "asc";
		resetFilters();
		state.priorKeys = baseline;
		state.queryText = history?.describe(entry.query || {}) || "";
		state.lastSig = entry.id || null;
		displaySearchResults(records);
		/* The library is asked about these rows, after they are drawn. Asked before, the lookup ran over the
		   list that was on screen and the restored rows kept only their DOI matches: a held paper found by
		   its title read as new, with no reading state or collections. */
		await refreshLibraryFlags();
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
	async function openHistoryEntry(id, { pin = null, rerun = false } = {}) {
		if (state.searching || state.importing || !history) return;
		cancelCacheRestore();
		let entry = await history.get(id);
		// A pin outlives its stored result: running it again needs only the pin itself.
		if (!entry && pin && rerun) entry = { query: pin.query, source: pin.source, records: [], savedAt: pin.lastRun || pin.pinnedAt };
		if (!entry) { setStatus(t(pin ? "pinGone" : "historyMissing"), "err"); return; }
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
		// Journals that were picked come back as chips; their OR expression is not text for the box.
		if (Array.isArray(query.venues) && query.venues.length) { setVenueChips(query.venues); $("venue").value = ""; } else setVenueChips([]);
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
		if (pin && rerun) {
			// An explicit run: the rows are compared with what the pin has seen, and then count as seen.
			state.pinLook = pin.id;
			await runSearch();
			restorePinFilters(pin);
			return;
		}
		if (!pin) { await showHistoryEntry(entry, stillMine); return; }
		let tooMany = entry.records.length > history.SEEN_CAP;
		let baseline = tooMany ? null : await history.baseline(pin.id);
		if (!await showHistoryEntry(entry, stillMine, baseline)) return;
		restorePinFilters(pin);
		if (tooMany) { setStatus(t("pinTooMany")); return; }
		await history.markSeen(pin.id, entry.records);
		setStatus(t("pinShown", state.records.filter(r => r.isNew).length));
	}
	function restorePinFilters(pin) {
		let f = pin.filters;
		if (!f) return;
		try {
			if (typeof f.text === "string") $("filter").value = f.text;
			if (Array.isArray(f.rules)) state.rules = Filters.reviveRules(f.rules);
			if (f.yearRange && Number.isFinite(f.yearRange.from) && Number.isFinite(f.yearRange.to)) state.yearRange = f.yearRange;
			render();
		}
		catch (e) { log("restoring pin filters failed: " + e.message); }
	}
	function currentFilters() {
		let text = $("filter")?.value || "", rules = Array.isArray(state.rules) ? JSON.parse(JSON.stringify(state.rules)) : [];
		if (!text && !rules.length && !state.yearRange) return null;
		return { text, rules, ...(state.yearRange ? { yearRange: { from: state.yearRange.from, to: state.yearRange.to } } : {}) };
	}
	async function pinEntry(id) {
		// The filters on screen go with the pin only when the pinned search is the one on screen.
		let filters = state.lastSig === id ? currentFilters() : null;
		let pinned = await history.pin(id, { filters }).catch(e => { log("pinning failed: " + e.message); return null; });
		if (pinned) setStatus(t("pinPinned"), "", { transient: true });
	}

	// returnFocus: closed from the keyboard (Escape), so the keyboard goes back to the button that opened it.
	function closeHistoryMenu(returnFocus = false) {
		let menu = $("histmenu");
		if (menu.hidden) return;
		let inside = Boolean(document.activeElement && menu.contains?.(document.activeElement));
		menu.hidden = true;
		menu.textContent = "";
		$("history-btn").setAttribute("aria-expanded", "false");
		$("author-history-btn").setAttribute("aria-expanded", "false");
		if (returnFocus || inside) $(searchSurface === "authors" ? "author-history-btn" : "history-btn")?.focus?.();
	}

	// focusFirst: opened from the keyboard (Enter, Space or an arrow on the button), so the first saved search takes the keyboard.
	async function toggleHistoryMenu(focusFirst = false) {
		if (!$("histmenu").hidden) { closeHistoryMenu(focusFirst); return; }
		closeSelMenu();
		closeToolbarMenu();
		hideCtxMenu();
		await openHistoryMenu();
		if (focusFirst) historyItems()[0]?.focus?.();
	}
	// The rows of the history menu the arrows move between: saved and pinned searches and "forget all".
	const historyItems = () => [...($("histmenu").querySelectorAll?.('[role="menuitem"]') || [])];
	/* Up and Down move between the rows (over the headings and rules between them), Home and End go to
	   the ends, Escape closes and hands the keyboard back to the button. Tab reaches a row's own actions. */
	function onHistoryMenuKey(e) {
		let items = historyItems();
		if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeHistoryMenu(true); return; }
		if (!items.length) return;
		let row = e.target?.closest?.('[role="menuitem"]'), i = items.indexOf(row);
		let go = n => { e.preventDefault(); e.stopPropagation(); items[(n + items.length) % items.length]?.focus?.(); };
		if (e.key === "ArrowDown") go(i + 1);
		else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(items.length - 1);
	}

	// Whole calendar days between a saved time and now, so "yesterday" means the day before.
	function daysSince(iso) {
		let day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
		return Math.max(0, Math.round((day(new Date()) - day(new Date(iso))) / 86400000));
	}
	// The words of a saved search, with the sources it combined named as the window names them
	// ("OpenAlex, Crossref"), not as the ids the search was stored under ("openalex+crossref").
	function historyLabel(e) {
		let query = e.query || {}, names = Array.isArray(query.sources) ? query.sources : [];
		if (e.query?.mode === "author" || !names.length) return history.describe(query);
		let plain = key => String(sourceLabel(key) || key).replace(/\s*[(（][^)）]*[)）]\s*$/, "");
		return history.describe({ ...query, sources: null });
	}
	// the sources a saved search ran against, named plainly; the line under its query
	function historySources(e) {
		let names = Array.isArray(e.query?.sources) ? e.query.sources : [];
		if (e.query?.mode === "author" || !names.length) return "";
		return names.map(key => String(sourceLabel(key) || key).replace(/\s*[(（][^)）]*[)）]\s*$/, "")).join(", ");
	}
	// A small text action inside a menu row; it must not also open the row.
	function menuAction(text, title, run) {
		let b = document.createElement("button");
		b.type = "button"; b.className = "h-act"; b.textContent = text;
		tip(b, title);
		b.addEventListener("click", ev => { ev.stopPropagation(); run(); });
		b.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") ev.stopPropagation(); });
		return b;
	}
	// A pinned search: its words, its sources, what is new since it was last looked at, and two actions.
	function pinRow(p) {
		let d = document.createElement("div");
		d.className = "histopt pinned";
		d.setAttribute("role", "menuitem");
		d.dataset.id = p.id;
		let body = document.createElement("div"); body.className = "h-body";
		let label = document.createElement("span"); label.className = "h-label";
		label.textContent = historyLabel(p);
		let meta = document.createElement("span"); meta.className = "h-meta";
		meta.textContent = t("pinMeta", historySources(p) || sourceLabel(p.source), p.seen.length, t("historyWhen", daysSince(p.lastRun || p.pinnedAt)), Boolean(p.partial));
		let n = Number(p.newCount);
		let badge = document.createElement("span"); badge.className = "h-new" + (n > 0 ? " on" : "");
		badge.textContent = n > 0 ? t("pinNew", n) : t("pinNoNew");
		let line = document.createElement("span"); line.className = "h-line";
		line.appendChild(meta); line.appendChild(badge);
		body.appendChild(label); body.appendChild(line);
		let acts = document.createElement("span"); acts.className = "h-acts";
		acts.appendChild(menuAction(t("pinRerun"), t("pinRerunTip"), () => { closeHistoryMenu(); openHistoryEntry(p.id, { pin: p, rerun: true }); }));
		acts.appendChild(menuAction(t("unpinAction"), t("unpinAction"), async () => { await history.unpin(p.id).catch(() => {}); await openHistoryMenu(); }));
		d.appendChild(body); d.appendChild(acts);
		tip(d, label.textContent);
		d.tabIndex = 0;
		d.addEventListener("click", ev => { ev.stopPropagation(); closeHistoryMenu(); openHistoryEntry(p.id, { pin: p }); });
		d.addEventListener("keydown", ev => {
			if (ev.target === d && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); d.click(); }
		});
		return d;
	}
	async function openHistoryMenu() {
		let menu = $("histmenu");
		menu.textContent = "";
		let entries = [];
		try { entries = history ? await history.list() : []; }
		catch (e) { log("listing history failed: " + e.message); }
		let pins = [];
		try { pins = history && searchSurface !== "authors" ? await history.pins() : []; }
		catch (e) { log("listing pins failed: " + e.message); }
		let pinnedIds = new Set(pins.map(p => p.id));
		let isAuthors = searchSurface === "authors";
		if (pins.length) {
			let ph = document.createElement("div"); ph.className = "menu-head"; ph.textContent = t("pinnedSearches") + " · " + pins.length; menu.appendChild(ph);
			for (let p of pins) menu.appendChild(pinRow(p));
			entries = entries.filter(e => !pinnedIds.has(e.id));
			if (entries.length) menu.appendChild(document.createElement("hr"));
		}
		let head = document.createElement("div"); head.className = "menu-head"; head.textContent = t("history"); if (entries.length || !pins.length) menu.appendChild(head);
		if (!entries.length && !pins.length) {
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
			// The stored label is the plain description; a label someone chose stays as chosen.
			label.textContent = !e.label || e.label === history.describe(e.query) ? historyLabel(e) : e.label;
			let meta = document.createElement("span");
			meta.className = "h-meta";
			let when = t("historyWhen", daysSince(e.savedAt));
			let provider = e.query?.mode === "author" ? authorProviderLabel(e.query.authorProvider) : historySources(e) || sourceLabel(e.source);
			meta.textContent = e.kind === "profiles" ? t("authorHistoryProfiles", provider, e.count, when) : t("historyEntryMeta", provider, e.count, when, Boolean(e.partial));
			let body = document.createElement("div"); body.className = "h-body";
			body.appendChild(label);
			body.appendChild(meta);
			d.appendChild(body);
			if (e.query?.mode !== "author" && e.kind !== "profiles") {
				let acts = document.createElement("span"); acts.className = "h-acts";
				acts.appendChild(menuAction(t("pinAction"), t("pinActionTip"), async () => { await pinEntry(e.id); await openHistoryMenu(); }));
				d.appendChild(acts);
			}
			{
				// One stale or mistyped search goes on its own; "forget all" was the only way before.
				let acts = d.querySelector?.(".h-acts");
				if (!acts) { acts = document.createElement("span"); acts.className = "h-acts"; d.appendChild(acts); }
				let drop = menuAction(t("historyRemove"), t("historyRemoveTip"), async () => {
					try { await history.remove(e.id); } catch (err) { log("removing a saved search failed: " + err.message); }
					await openHistoryMenu();
				});
				drop.setAttribute("data-writes", "history");
				acts.appendChild(drop);
			}
			tip(d, label.textContent + "\n" + new Date(e.savedAt).toLocaleString(t.locale || undefined));
			d.tabIndex = 0;
			d.addEventListener("click", ev => { ev.stopPropagation(); closeHistoryMenu(); openHistoryEntry(e.id); });
			d.addEventListener("keydown", ev => {
				if (ev.target === d && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); d.click(); }
			});
			menu.appendChild(d);
		}
		if (entries.length || pins.length) {
			menu.appendChild(document.createElement("hr"));
			let clear = document.createElement("div");
			if (pins.length) tip(clear, t("historyClearKeepsPins"));
			clear.className = "histclear";
			clear.setAttribute("role", "menuitem");
			clear.setAttribute("data-writes", "history");
			clear.tabIndex = 0;
			clear.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); clear.click(); } });
			let clearLabel = document.createTextNode(t("historyClear"));
			clear.appendChild(iconNode("ic-clear")); clear.appendChild(clearLabel);
			// Every saved result goes at once and cannot come back, so the first press only asks.
			let armed = false;
			clear.addEventListener("click", async ev => {
				ev.stopPropagation();
				if (!armed) { armed = true; clearLabel.textContent = t("historyClearConfirm"); clear.classList.add("armed"); return; }
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
		let below = window.innerHeight - r.bottom - 16;
		menu.style.maxHeight = Math.max(120, below) + "px";
		menu.style.top = (r.bottom + 3) + "px";
		/* Hung from the button's right edge, so the menu opens under the control that opened it and
		   grows leftwards; it is kept inside the window on both sides. */
		let right = Math.max(6, Math.min(window.innerWidth - r.right, window.innerWidth - 6 - 200));
		menu.style.left = "auto";
		menu.style.right = right + "px";
		menu.style.maxWidth = Math.max(200, Math.min(560, window.innerWidth - right - 6)) + "px";
	}

	// ------------------------------------------------------------ toolbar menus
	// Export, View and the detail's More share one in-page menu. Arrow keys move, Enter or
	// Space runs the item, Escape (or Tab) closes it and focus goes back to its button.
	let openTbMenu = null;
	function closeToolbarMenu(returnFocus = false) {
		if (!openTbMenu) return;
		let { btn } = openTbMenu, menu = $("tbmenu");
		menu.hidden = true;
		menu.textContent = "";
		if (btn !== $("table-wrap")) btn.setAttribute("aria-expanded", "false");
		openTbMenu = null;
		if (returnFocus) btn.focus();
	}
	// items: { label, title, run, disabled, check, radio } or "-" for a rule; check makes it a checkable item.
	// anchor: where the menu hangs when that is not the button focus returns to (the sort menu from the table).
	function openToolbarMenu(btn, items, label, focusFirst = false, anchor = null) {
		if (openTbMenu?.btn === btn) { closeToolbarMenu(true); return; }
		closeToolbarMenu();
		closeSelMenu();
		closeHistoryMenu();
		hideCtxMenu();
		let menu = $("tbmenu"), nodes = [], acts = [];
		menu.textContent = "";
		menu.setAttribute("aria-label", label);
		for (let item of items) {
			if (item === "-") { menu.appendChild(document.createElement("hr")); continue; }
			// A caption over a group of items: read, not chosen.
			if (item.heading) { let h = document.createElement("div"); h.className = "selhead"; h.setAttribute("role", "presentation"); h.textContent = item.heading; menu.appendChild(h); continue; }
			let d = document.createElement("div");
			d.className = "selopt";
			d.setAttribute("role", item.check === undefined ? "menuitem" : item.radio ? "menuitemradio" : "menuitemcheckbox");
			if (item.check !== undefined) d.setAttribute("aria-checked", String(Boolean(item.check)));
			if (item.disabled) d.setAttribute("aria-disabled", "true");
			if (item.title) tip(d, item.title);
			d.tabIndex = -1;
			d.textContent = item.label;
			let act = () => { if (item.disabled) return; closeToolbarMenu(true); item.run(); };
			d.addEventListener("mouseenter", () => d.focus());
			d.addEventListener("click", e => { e.stopPropagation(); act(); });
			menu.appendChild(d);
			nodes.push(d);
			acts.push(act);
		}
		menu.hidden = false;
		let at = anchor || btn;
		if (typeof at.getBoundingClientRect === "function") {
			let r = at.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
			let below = window.innerHeight - r.bottom - 8;
			menu.style.top = (h > below && r.top > below ? Math.max(6, r.top - h - 3) : r.bottom + 3) + "px";
			menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + "px";
		}
		// The table, when the sort menu opens from it, is where focus returns, not a menu button.
		if (btn !== $("table-wrap")) btn.setAttribute("aria-expanded", "true");
		openTbMenu = { btn, nodes, acts };
		if (focusFirst) nodes[0]?.focus();
	}
	function onToolbarMenuKey(e) {
		if (!openTbMenu) return;
		let { nodes, acts } = openTbMenu, i = nodes.indexOf(document.activeElement);
		let go = n => { e.preventDefault(); e.stopPropagation(); nodes[(n + nodes.length) % nodes.length]?.focus(); };
		if (e.key === "ArrowDown") go(i + 1);
		else if (e.key === "ArrowUp") go(i < 0 ? nodes.length - 1 : i - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(nodes.length - 1);
		else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); acts[i]?.(); }
		else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeToolbarMenu(true); }
	}
	function exportMenuItems() {
		let items = [{ label: t("copyCsv"), title: t("copyCsvTip"), run: copyCSV }, { label: t("saveCsv"), title: t("saveCsvTip"), run: saveCSV }];
		// The original JSON only exists when every row came from Publish or Perish.
		if (state.records.length && state.records.every(r => r.popOriginal)) items.push({ label: t("popOriginalJSON"), run: () => copyText(popOriginalJSON(), t("popJSONCopied")) });
		return items;
	}
	function setColsMode(mode) { state.colsMode = mode; applyColumnView(); saveLayout(); }
	// The window's language: English (the default), Korean, or whatever Zotero speaks. Each is named in its
	// own language, so a reader who cannot read the current one can still find theirs.
	function languageChoice() { let value = PREF("language"); return value === "ko" || value === "auto" ? value : "en"; }
	function setLanguage(choice) {
		if (!["en", "ko", "auto"].includes(choice) || choice === languageChoice()) return;
		PREF("language", choice);
		// Everything the window says is made from the language at open, so it is opened again in the new one.
		// The last search comes back from the history. A search or an import in progress is not interrupted:
		// the choice is kept and applies the next time the window opens.
		if (state.searching || state.importing) { setStatus(t("langAppliesLater")); return; }
		try { window.location.reload(); } catch (e) { setStatus(t("langAppliesLater")); }
	}
	function viewMenuItems() {
		let language = languageChoice();
		return [
			{ label: t("colsBasic"), title: t("colsModeTip"), check: state.colsMode !== "all", radio: true, run: () => setColsMode("basic") },
			{ label: t("colsAll"), title: t("colsModeTip"), check: state.colsMode === "all", radio: true, run: () => setColsMode("all") },
			"-",
			{ label: t("affLineToggle"), title: t("affLineTip"), check: state.affLine, run: () => { state.affLine = !state.affLine; saveLayout(); render(); } },
			{ label: t("metricsToggle"), title: t("metricsTip"), check: !$("metrics").hidden, run: toggleMetrics },
			{ label: t("detailToggle"), title: t("detailTip"), check: !$("detail").hidden, run: toggleDetail },
			"-",
			{ label: t("sortMenu"), title: t("sortMenuTip"), run: () => openSortMenu(false) },
			{ label: t("keysMenu"), title: t("keysMenuTip"), run: () => openKeysHelp($("view-btn")) },
			"-",
			{ heading: "Language / 언어" },
			{ label: "English", check: language === "en", radio: true, run: () => setLanguage("en") },
			{ label: "한국어", check: language === "ko", radio: true, run: () => setLanguage("ko") },
			{ label: "Follow Zotero / Zotero 언어 따르기", check: language === "auto", radio: true, run: () => setLanguage("auto") }
		];
	}
	// What the detail's More holds: everything but the one main action.
	function moreMenuItems(r) {
		if (!r) return [];
		let pdf = (r.pdfUrls || [])[0] || r.pdfUrl;
		return [
			{ label: t("dOpen"), disabled: !r.url, run: () => Zotero.launchURL(r.url) },
			{ label: t("dPdf"), disabled: !pdf, run: () => Zotero.launchURL(pdf) },
			{ label: t("dProxy"), title: t("dProxyTip"), disabled: !(r.doi || r.url), run: () => openViaProxy(r) },
			"-",
			{ label: t("dCopyDoi"), disabled: !r.doi, run: () => copyText(r.doi, t("copiedDoi")) },
			{ label: t("dCopyCite"), run: () => copyText(citationText(r), t("copiedCite")) },
			"-",
			...(personPick() ? [{ label: inPick(personPick(), r) ? t("ctxNotPerson") : t("ctxIsPerson"), run: () => setPersonMembership(r, !inPick(personPick(), r)) }] : []),
			{ label: t("dCheck"), title: t("dCheckTip"), disabled: state.checking || !(r.doi || r.arxiv || r.pmid || (r.source === "openalex" && r.sourceId)), run: () => checkCitations(r) }
		];
	}

	// ------------------------------------------------------------ layout persistence
	function restoreLayout() {
		// An order saved before the title moved forward would put it back behind the authors.
		try {
			let orderVersion = PREF("colOrderVersion");
			state.colOrder = orderVersion === COL_VERSION ? normalizeColumnOrder(JSON.parse(PREF("colOrder") || "null"))
				: orderVersion === COL_VERSION_MIN_WIDTHS ? normalizeColumnOrder(moveAfter(JSON.parse(PREF("colOrder") || "null"), "affiliation", "authorString"))
				: [...COLUMN_KEYS];
		}
		catch (e) { state.colOrder = [...COLUMN_KEYS]; }
		state.colsMode = PREF("colsMode") === "all" ? "all" : "basic";
		state.affLine = PREF("affLine") !== false;
		// Sizes saved on a large screen are clamped to this window, so a wide
		// sidebar or a tall detail pane cannot swallow the table on a laptop.
		let w = parseInt(PREF("metricsWidth"), 10);
		if (w >= 140) $("metrics").style.width = Math.min(w, metricsCap()) + "px";
		let h = parseInt(PREF("detailHeight"), 10);
		// A stored 0 used to come back as a dead strip with no way to grab the splitter. The detail sizes to its
		// content; the saved height is only the most it may grow to.
		if (h >= 60) $("detail").style.setProperty("--detail-max", Math.min(h, detailCap()) + "px");
		if (PREF("detailHidden") === true) setDetailVisible(false);
		if (PREF("metricsHidden") === true) setMetricsVisible(false);
		// COL_VERSION guards against stale widths after the defaults change
		let widthsVersion = PREF("colWidthsVersion");
		if (widthsVersion >= COL_VERSION_MIN_WIDTHS && widthsVersion <= COL_VERSION) {
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
			// Nor the one-line hint it folds to while nothing is chosen.
			if (!$("detail").hidden && !$("detail").hasAttribute("data-empty")) { let cap = parseInt($("detail").style.getPropertyValue("--detail-max"), 10); PREF("detailHeight", cap >= 60 ? cap : $("detail").offsetHeight); }
			PREF("detailHidden", $("detail").hidden === true);
			PREF("metricsHidden", $("metrics").hidden === true);
			PREF("colWidths", JSON.stringify(state.colWidths));
			PREF("colWidthsVersion", COL_VERSION);
			PREF("colsMode", state.colsMode);
			PREF("affLine", state.affLine);
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
	}
	function toggleMetrics() { setMetricsVisible($("metrics").hidden); saveLayout(); }
	/* A hidden detail pane asks the network for nothing (a PubMed abstract, the references behind "cites n of
	   mine"): walking twenty rows with it folded away sent twenty requests nobody saw. Shown again, it draws
	   the row it holds, and asks then. */
	let detailShown = true;
	function setDetailVisible(on) {
		let was = detailShown;
		detailShown = Boolean(on);
		$("detail").hidden = !on;
		syncDetailSplitter();
		if (on && !was) renderDetail();
	}
	// The grip belongs to a pane that has a height to drag: not a hidden one, not the one-line hint.
	function syncDetailSplitter() {
		let detail = $("detail"), grip = $("hsplit");
		if (grip) grip.hidden = detail.hidden || detail.hasAttribute("data-empty");
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
			el.style.setProperty("--detail-max", h + "px");
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
			// A width saved before a column's content grew (the check plus 읽는 중 in 보유; ▲/▼ beside the
			// citations) would clip it; those columns keep at least what they now need.
			col.style.width = Math.max(state.colWidths[k] || DEFAULT_COLS[k], COL_FLOOR[k] || 0) + "px";
		}
		applyColumnView();
	}

	/* The fixed defaults add up to more than the results pane at 1280-1440px (the 보유 column was cut off
	   at the right edge), and to less on a wide screen. Unless the reader has sized the title themselves,
	   the title takes what the shown columns leave -- never below TITLE_MIN, so a narrow pane rolls sideways
	   rather than squeezing the title to a few letters. */
	const TITLE_MIN = 220, TITLE_WANT = 340;
	// Columns that give width back to the title, down to these floors, when it would otherwise be cut short.
	const SQUEEZE = { authorString: 100, affiliation: 100, venue: 110 };
	/* The title has a default width like every column, so "has the reader sized it" is whether it still
	   equals that default: it used to be always truthy, and the fit below never ran -- titles stayed at 200px
	   with the leftover space unused. Titles are what tells results apart, so they come first: the title
	   takes the leftover, and if that is less than TITLE_WANT the authors, institution and journal columns
	   (when the reader has not sized them) narrow toward their floors to make room. */
	function fitTitleColumn() {
		let wrap = document.querySelector(".table-wrap"), titleCol = document.querySelector('#cols col[data-k="title"]');
		if (!wrap || !titleCol || state.colWidths.title !== DEFAULT_COLS.title || !wrap.clientWidth) return;
		let others = 0, give = [];
		for (let th of document.querySelectorAll("#results-head > th")) {
			if (th.dataset.k === "title" || getComputedStyle(th).display === "none") continue;
			let col = document.querySelector(`#cols col[data-k="${th.dataset.k}"]`);
			let width = parseFloat(col?.style.width) || th.offsetWidth || 0;
			others += width;
			let floor = SQUEEZE[th.dataset.k];
			if (col && floor && state.colWidths[th.dataset.k] === DEFAULT_COLS[th.dataset.k] && width > floor) give.push({ col, width, floor });
		}
		let room = wrap.clientWidth - others - 2;
		if (room < TITLE_WANT) {
			let need = TITLE_WANT - room;
			for (let g of give) {
				if (need <= 0) break;
				let take = Math.min(need, g.width - g.floor);
				g.col.style.width = (g.width - take) + "px";
				need -= take; others -= take;
			}
			room = wrap.clientWidth - others - 2;
		}
		titleCol.style.width = Math.max(TITLE_MIN, Math.floor(room)) + "px";
	}

	// Which columns show is one attribute on the table; search.css hides the rest, in the
	// header, the colgroup and every row alike. Status shows once any row has one.
	function applyColumnView() {
		let table = $("results-table"); if (!table) return;
		table.setAttribute("data-cols", state.colsMode);
		if (state.records.some(r => r.status)) table.setAttribute("data-status", "1"); else table.removeAttribute("data-status");
		fitTitleColumn();
	}

	// A saved order from before the institution column moved: take it out of its old place and put it behind the authors.
	function moveAfter(order, key, anchor) {
		if (!Array.isArray(order)) return order;
		let rest = order.filter(k => k !== key), at = rest.indexOf(anchor);
		if (at < 0) return order;
		rest.splice(at + 1, 0, key);
		return rest;
	}

	function normalizeColumnOrder(saved) {
		let ordered = ["chk"];
		// The OpenAlex mean column arrived after the JIF one: in an older saved order it joins right beside it.
		if (Array.isArray(saved) && saved.includes("journalIF") && !saved.includes("journalOA2y")) {
			saved = saved.slice(); saved.splice(saved.indexOf("journalIF") + 1, 0, "journalOA2y");
		}
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

	// A column's sort: the same column again turns the order round; a new one starts from its natural end.
	function sortByColumn(key) {
		if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
		else { state.sortKey = key; state.sortDir = ["citations", "cpy", "year", "inLibrary", "pdf", "journalIF", "journalOA2y", "tier"].includes(key) ? "desc" : "asc"; }
		render();
	}
	/* The headers are pressed with the mouse; from the keyboard the same sorts are a menu (S in the list, or
	   View → Sort by), listing the columns on screen with the current one checked and its direction said. */
	function sortMenuItems() {
		let items = [];
		for (let th of document.querySelectorAll("#results-table th[data-sort]")) {
			let key = th.dataset.sort;
			// A column the view hides has no width; one the window has not laid out yet (no offsetWidth) counts as shown.
			if (typeof th.offsetWidth === "number" && th.offsetWidth === 0) continue;
			let name = String(th.querySelector?.("span")?.textContent || th.textContent || key).trim() || key;
			let on = state.sortKey === key;
			items.push({ label: on ? name + "  " + (state.sortDir === "asc" ? "\u2191" : "\u2193") : name, title: on ? t(state.sortDir === "asc" ? "sortNowAsc" : "sortNowDesc") : "", check: on, radio: true, run: () => sortByColumn(key) });
		}
		return items;
	}
	function openSortMenu(fromTable = false) {
		let items = sortMenuItems();
		if (!items.length) return;
		let sorted = document.querySelector("#results-table th.sorted-asc, #results-table th.sorted-desc");
		if (fromTable) openToolbarMenu($("table-wrap"), items, t("sortMenu"), true, sorted || $("results-head") || null);
		else openToolbarMenu($("view-btn"), items, t("sortMenu"), true);
	}

	function setupColumnOrder() {
		let headers = [...document.querySelectorAll("#results-table th")];
		for (let th of headers) {
			let key = th.dataset.sort;
			th.dataset.k = key || "chk";
			if (!key) continue;
			th.setAttribute("draggable", "true");
			tip(th, [th.getAttribute("data-tip"), t("columnDragTip")].filter(Boolean).join("\n"));
			th.addEventListener("mousedown", e => {
				columnDragBlocked = Boolean(e.target.closest?.(".rz"));
				if (!columnDrag) suppressColumnClickUntil = 0;
			}, true);
			th.addEventListener("click", e => {
				if (e.target.closest?.(".rz")) return;
				if (columnDrag || Date.now() < suppressColumnClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
				sortByColumn(key);
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
						PREF("colOrderVersion", COL_VERSION);
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
				/* From the width on screen: the window fits the title column to the room it has without
				   changing the stored width, and a 1px drag from the stored 200 turned a fitted 340 into 201. */
				let col = document.querySelector(`#cols col[data-k="${key}"]`);
				let startW = parseFloat(col?.style?.width) || state.colWidths[key] || DEFAULT_COLS[key];
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
			tip(rz, t("columnResetTip"));
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
	/* The default "read" action of a row (double-click, Enter). A paper the library already holds opens its own
	   PDF in Zotero's reader; the publisher's page stays a separate action (the menu's "Open in browser").
	   A held paper with no stored file is shown in the library and says so, rather than silently going to the web.
	   This is a user action: nothing but a click or a key in this window reaches it. */
	function heldItemID(r) {
		let key = r.doi && ZotPoPSources.normalizeDOI ? ZotPoPSources.normalizeDOI(r.doi) : r.doi;
		return r.libraryItemID || (key && state.doiMap?.get(key)) || null;
	}
	async function readHeldPDF(r) {
		try {
			let libraryID = state.libraryID ?? currentTarget().libraryID;
			let found = typeof ZotPoPImporter?.localPDF === "function" ? await ZotPoPImporter.localPDF(libraryID, r, heldItemID(r)) : null;
			if (found?.attachmentID != null && Zotero.Reader?.open) { await Zotero.Reader.open(found.attachmentID); return; }
			showInLibrary(r);
			setStatus(t("noLocalPdf"), "", { transient: true });
		}
		catch (e) { log("reading the local PDF failed: " + e.message); setStatus(t("readLocalFailed"), "err", { transient: true }); }
	}
	function readRecord(r) {
		if (!r) return;
		if (r.inLibrary) { readHeldPDF(r); return; }
		if (r.url) Zotero.launchURL(r.url);
	}
	// The library's own copy of a paper, brought into view in the main window.
	function showInLibrary(r) {
		try {
			let key = r.doi && ZotPoPSources.normalizeDOI ? ZotPoPSources.normalizeDOI(r.doi) : r.doi;
			let id = r.libraryItemID || (key && state.doiMap.get(key));
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
	// never asked it, still get the Journal Impact Factor. A figure in journalIF that
	// the JCR did not give is an older record's OpenAlex 2-year mean: it moves to its
	// own field, so the two are never read as one.
	function settleImpactFactors(records) {
		let edition = typeof ZotPoPJCR === "undefined" ? null : ZotPoPJCR.EDITION;
		for (let r of records) {
			// Only the JCR names a source for its figure; a bare journalIF is the older OpenAlex-mean-in-JIF-field shape.
			if (r.journalIF != null && !r.journalIFSource) {
				if (r.journalOA2y == null) r.journalOA2y = r.journalIF;
				r.journalIF = null;
			}
			delete r.journalIFEstimate;
		}
		if (edition) ZotPoPJCR.apply(records.filter(r => r.journalIFSource !== edition));
	}

	/* Providers report every page as it arrives. Redrawing the list for each one is wasted work
	   when pages come faster than the eye reads, so streamed updates draw at most once per
	   STREAM_FRAME (the first one at once); the final draw of a search is never deferred. */
	const STREAM_FRAME = 120;
	let streamTimer = null, lastStreamAt = 0;
	function renderStreamed() {
		if (streamTimer != null) return;
		let wait = STREAM_FRAME - (Date.now() - lastStreamAt);
		if (wait <= 0) { lastStreamAt = Date.now(); render(); }
		else streamTimer = later(() => { streamTimer = null; lastStreamAt = Date.now(); render(); }, wait);
	}
	function displaySearchResults(records, { stream = false } = {}) {
		settleImpactFactors(records.filter(r => !r.popOriginal && !r.authorProfile));
		affiliationMemo = new WeakMap();
		// A merged record may acquire a different source key. Carry row interaction
		// state through a shared identifier as well as an unchanged key.
		// A row can also leave one streamed batch and come back in a later one (a source that asks
		// one journal at a time, a re-ranked pool): its check waits for it until the search ends.
		let previous = new Map(state.searching && state.streamCarry || []);
		for (let r of state.records) {
			for (let id of recordIdentities(r)) {
				let flags = previous.get(id) || {};
				flags.selected ||= state.selected.has(r.key);
				flags.focused ||= state.focusKey === r.key;
				flags.detailed ||= state.detailKey === r.key;
				// A row's library ranking stays with it when a later batch redraws the list (load more, the next journal).
				if (r.related && !flags.related) flags.related = r.related;
				previous.set(id, flags);
			}
		}
		let selected = new Set(), focusKey = null, detailKey = null;
		state.records = records.map((record, i) => {
			let r = Object.assign({}, record, {
				rank: record.popOriginal ? record.rank : i + 1,
				authorString: (record.authors || []).map(a => a.name || [a.firstName, a.lastName].filter(Boolean).join(" ")).join(", "),
				status: "",
				inLibrary: Boolean(record.doi && state.doiMap.has(record.doi)),
				isNew: Boolean(state.priorKeys && !state.priorKeys.has(ZotPoPHistory.recordKey(record)))
			});
			for (let id of recordIdentities(r)) {
				let flags = previous.get(id);
				if (flags?.selected) selected.add(r.key);
				if (flags?.focused) focusKey = r.key;
				if (flags?.detailed) detailKey = r.key;
				if (flags?.related && !r.related) r.related = flags.related;
			}
			return r;
		});
		state.selected = selected;
		state.focusKey = focusKey;
		state.detailKey = detailKey;
		state.streamCarry = null;
		if (stream && state.searching) {
			let shown = new Set(state.records.flatMap(recordIdentities)), carry = new Map();
			for (let [id, flags] of previous) if (flags.selected && !shown.has(id)) carry.set(id, { selected: true });
			if (carry.size) state.streamCarry = carry;
		}
		// Keep received rows readable; progress continues in the status bar.
		$("busy").hidden = !state.searching || state.records.length > 0;
		if (stream) renderStreamed(); else render();
	}

	function readQuery() {
		let num = id => { let v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : null; };
		// An empty box means the default. "0" or "twenty" is a number the user meant, and
		// silently searching for 200 instead hides the mistake; the validator names it.
		let limit = () => {
			let raw = String($("maxResults").value || "").trim();
			if (!raw) return 200;
			let value = Number(raw);
			return Number.isInteger(value) ? value : raw;
		};
		// Journals picked in the box and whatever is still typed there: one journal, or an OR of several.
		let journals = engineValue() === "pop"
			? { venue: [...state.venueChips.map(c => c.name), $("venue").value.trim()].filter(Boolean).join(" OR ") }
			: J.queryFields(state.venueChips, $("venue").value);
		return {
			authors: $("authors").value, ...journals, title: $("title").value, keywords: $("keywords").value,
			yearFrom: num("yearFrom"), yearTo: num("yearTo"), maxResults: limit(),
			sort: $("sort").value || "relevance",
			...(engineValue() === "pop" ? { engine: "pop", popProfile: String(PREF("popDataDir") || "pop-default"),
				...Object.fromEntries(POP_FIELDS.map(key => [key, $(key).value || (key === "popOutputSort" ? "rank" : key === "popCachePolicy" ? "refresh" : "")])) }
				: $("source").value === "multi" ? { sources: readCombinedSources() } : {})
		};
	}

	let searchTicket = 0;
	async function runSearch() {
		if (searchSurface === "authors") return runAuthorAction("profiles");
		if (state.importing) return;
		// A second request while one runs used to vanish, prefill included: the
		// running one is stopped and waited out, and the new one goes.
		let q = readQuery();
		// A query the sources would refuse is named here, before the rows, checks and filters on screen are cleared.
		if (engineValue() !== "pop") {
			let year = v => v == null || (Number.isInteger(v) && v >= 1500 && v <= 2100);
			if (!year(q.yearFrom) || !year(q.yearTo)) { setStatus(t("badYear"), "err"); return; }
			if (q.yearFrom != null && q.yearTo != null && q.yearFrom > q.yearTo) { setStatus(t("badYearOrder", q.yearFrom, q.yearTo), "err"); return; }
			if (!Number.isInteger(q.maxResults) || q.maxResults < 1 || q.maxResults > 2000) { setStatus(t("badLimit"), "err"); return; }
		}
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
		/* Only the latest request goes: with A running, B and C pressed in turn both waited for A, then B went and
		   C was dropped, leaving C's words over B's rows. Each request takes a ticket; one overtaken while it waited
		   steps aside. */
		let ticket = ++searchTicket;
		if (state.searching) { state.searchController?.abort(); state.cancelled = true; try { await state.searchDone; } catch (e) {} }
		if (state.searching || ticket !== searchTicket) return;
		cancelCacheRestore();
		saveQuery();
		savePrefs();
		let sourceKey = $("source").value;
		let label = sourceLabel(sourceKey);
		// A pinned search is compared with what its pin has seen, however it was started; only a run
		// begun from the pin itself (look) counts as seen afterwards.
		let pinLook = state.pinLook; state.pinLook = null;
		state.lastSig = history ? history.signature(sourceKey, q) : null;
		state.queryText = history ? history.describe(q) : "";
		state.searching = true;
		state.cancelled = false;
		let searchDone; state.searchDone = new Promise(res => { searchDone = res; });
		let controller = new AbortController();
		state.searchController = controller;
		let active = () => state.searchController === controller && !controller.signal.aborted;
		let netBefore = networkFailures;
		hideBanner();
		state.records = [];
		state.condOpen = false;
		// The API layer already applies the requested search order. Preserve its rank
		// until the user explicitly sorts a result column again.
		state.sortKey = q.engine === "pop" ? "popOrdinal" : "rank";
		state.sortDir = "asc";
		resetFilters();
		state.selected.clear();
		state.streamCarry = null;
		state.focusKey = null;
		state.detailKey = null;
		$("search-btn").disabled = true;
		$("stop-btn").disabled = false;
		$("busy").hidden = false;
		$("busy-text").textContent = t("searching", label);
		render();
		setStatus(t("searching", label));
		setProgress(0, q.maxResults);
		// The last run of this same search, kept only as keys, to mark what is new this time.
		// Read while the search runs; the rows are marked when the final list is drawn.
		let prior = Promise.resolve(history?.previousKeys(sourceKey, q)).catch(() => null);
		let pinFound = Promise.resolve(history?.pinFor(sourceKey, q)).catch(() => null);
		let ctx = {
			email: PREF("email") || "",
			s2ApiKey: PREF("s2ApiKey") || "",
			ncbiApiKey: PREF("ncbiApiKey") || "",
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
				msg = progressText(msg); setStatus(msg); $("busy-text").textContent = msg; setProgress(n, total);
			},
			onResults: records => { if (active()) displaySearchResults(records, { stream: true }); },
			log,
			openAlexSpent: openAlexHeld()
		};
		try {
			let recs;
			try { recs = await ZotPoPSources.search(sourceKey, q, http, ctx); }
			finally { noteOpenAlexSpent(ctx); }
			if (!active()) throw abortError();
			// Decided before the first draw: the empty-table message depends on it.
			state.searched = true;
			state.lastPartial = Boolean(ctx.errors?.length || recs.partial || recs.popProvenance?.complete === false);
			let pin = await pinFound;
			if (!pin) pinLook = null;
			let priorKeys = pin ? (recs.length > history.SEEN_CAP ? null : await history.baseline(pin.id)) : await prior || null;
			// Cleared or overtaken while the history was read: these rows are no longer wanted.
			if (!active()) throw abortError();
			state.priorKeys = priorKeys;
			displaySearchResults(recs);
			await refreshLibraryFlags();
			if (!active()) throw abortError();
			let partial = state.lastPartial;
			/* The source had more than the result limit let through. The status
			   said "200건" and the h-index beside it covered the top 200 by
			   relevance of fifteen thousand, with nothing to say so. */
			let capped = Object.values(ctx.sourceStatus || {}).find(s => s && s.reason === "result-limit" && Number(s.total) > recs.length);
			setStatus(partial ? t("incompleteResults", label, recs.length) : t("resultCount", label, recs.length, false, capped ? Number(capped.total) : 0));
			let kept = rememberSearch(sourceKey, q, recs, partial);
				if (pin && pinLook) {
					// Looked at now. Zero results, a partial run or an oversized one never reset what was seen (markSeen only adds).
					await kept;
					await history.markSeen(pin.id, recs);
					if (recs.length > history.SEEN_CAP) setStatus(t("pinTooMany"));
				}
			if (q.engine === "pop") showBanner(t("popModeNotice") + (recs.popProvenance?.cached ? " " + t("popCachedNotice") : ""));
			if (ctx.errors?.length) {
				// A bare "HTTP 429" from OpenAlex is its exhausted daily budget, which the user
				// can actually fix; say so instead of showing the status code alone.
				let quota = ctx.errors.some(m => /openalex/i.test(m) && /429|budget|credit/i.test(m));
				let listed = explainList(ctx.errors);
				showBanner(t("partialFail", listed) + (quota && !listed.includes(t("openAlexQuota")) ? " " + t("openAlexQuota") : ""), null, { warn: true });
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
				// No source answered because there was no connection: say that, not the network layer's words.
				let offline = !quota && (e?.offline || (networkFailures > netBefore && !(Number(e?.status) > 0))
					|| (typeof navigator !== "undefined" && navigator?.onLine === false));
				let text = quota ? t("openAlexQuota") : offline ? t("searchOffline") : t("searchFailed", explain(e.message || e));
				state.lastPartial = true;
				let received = state.records.length;
				if (received) rememberSearch(sourceKey, q, state.records, true);
				let retry = { label: t("searchRetry"), run: () => { hideBanner(); runSearch(); } };
				// Scholar's walls carry their own cure: a window inside Zotero and a retry.
				if (e.wall) { setStatus(text, "err"); scholarWallBanner(e, () => runSearch()); }
				else if (offline && !received && await showSavedRun(sourceKey, q, () => state.searchController === controller)) {
					setStatus(text, "err");
					showBanner(t("offlineSaved", new Date(state.offlineSavedAt).toLocaleString(t.locale || undefined)), retry, { warn: true });
				}
				else { setStatus(text, "err"); showBanner(text, retry, { warn: true }); }
			}
		}
		finally {
			state.searching = false;
			state.searched = true;
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

	/* Offline, the last saved run of the same search is better than an empty table: shown as saved, dated. */
	async function showSavedRun(sourceKey, q, stillMine) {
		try {
			let saved = history && await history.find(sourceKey, q);
			let entry = saved && await history.get(saved.id);
			if (!entry?.records?.length || !stillMine()) return false;
			if (!await showHistoryEntry(entry, stillMine)) return false;
			state.offlineSavedAt = entry.savedAt;
			return true;
		}
		catch (e) { log("no saved run to show offline: " + e.message); return false; }
	}

	let flagsGeneration = 0;
	async function refreshLibraryFlags() {
		let { libraryID } = currentTarget();
		/* Read again at every search: a paper saved from the browser meanwhile
		   stayed unmarked while the map was kept for the window's life. And a
		   result the library holds without a DOI is found by title and year,
		   the same rule the import uses -- the row said "not here" and the
		   import then said "already there".
		   Each lookup belongs to one library and one generation. Switching the target
		   starts a newer lookup, and an older answer that arrives late is dropped whole,
		   so rows never show another library's items as held. */
		let generation = ++flagsGeneration;
		let stale = () => generation !== flagsGeneration;
		state.libraryID = libraryID;
		let doiMap = await ZotPoPImporter.getLibraryDOIMap(libraryID);
		if (stale()) return;
		state.doiMap = doiMap;
		// The title index is read again too: a DOI corrected since the last search counts.
		ZotPoPImporter.forgetTitleIndex?.();
		state.heldVersions?.clear();
		let records = state.records;
		let found = new Map();
		for (let r of records) {
			let id = r.doi ? doiMap.get(r.doi) : null;
			if (!id && typeof ZotPoPImporter.findByTitle === "function" && r.title) {
				try {
					// A copy with another DOI is another version, as the import decides.
					id = await ZotPoPImporter.findByTitle(libraryID, r.title, r.year, { doi: r.doi });
				} catch (e) { id = null; }
				if (stale()) return;
			}
			found.set(r, id || null);
		}
		for (let r of records) {
			let id = found.get(r);
			r.inLibrary = Boolean(id);
			// A row that is not held here must not keep the item id of another library.
			if (id) r.libraryItemID = id;
			else { r.libraryItemID = null; r.readState = null; r.collections = null; }
		}
		if (!await readHeldDetails(records, stale)) return;
		render();
	}
	/* Style Custom's reading state and the collections each owned paper is filed in, for the items found only:
	   one query each, no network. False when a newer lookup took over meanwhile. */
	async function readHeldDetails(records, stale = () => false) {
		let ids = () => records.filter(r => r.inLibrary && r.libraryItemID).map(r => r.libraryItemID);
		try {
			let states = typeof ZotPoPImporter.getReadingStates === "function" ? await ZotPoPImporter.getReadingStates(ids()) : new Map();
			if (stale()) return false;
			for (let r of records) r.readState = r.inLibrary && states.get(r.libraryItemID) || null;
		} catch (e) { /* only a hint */ }
		try {
			let paths = typeof ZotPoPImporter.getCollectionPaths === "function" ? await ZotPoPImporter.getCollectionPaths(ids()) : new Map();
			if (stale()) return false;
			for (let r of records) r.collections = r.inLibrary && paths.get(r.libraryItemID) || null;
		} catch (e) { /* only a hint */ }
		return true;
	}

	function clearAll() {
		cancelCacheRestore();
		if (state.searching) {
			state.cancelled = true;
			state.searchController?.abort();
			state.searchController = null;
			$("busy").hidden = true;
		}
		setVenueChips([]);
		for (let id of ["authors", "venue", "title", "keywords", "yearFrom", "yearTo", "filter", ...POP_FIELDS.filter(k => !["popOutputSort", "popCachePolicy"].includes(k))]) $(id).value = "";
		state.records = [];
		state.selected.clear();
		state.libraryFilter = "all";
		resetFilters();
		state.focusKey = null;
		state.detailKey = null;
		saveQuery();
		hideBanner();
		setStatus(t("ready"));
		render();
	}

	// ------------------------------------------------------------ render
	function libraryPass(r) { return state.libraryFilter === "all" || (state.libraryFilter === "owned") === Boolean(r.inLibrary); }
	// Selected-only is a mode of its own: it answers by selection alone, so a paper checked
	// and then filtered out still shows, and the other filters return when it is turned off.
	function matchesFilter(r, spec, ignoreYears = false, ignoreLibrary = false, skipRule = null) {
		if (state.selectedOnly) return state.selected.has(r.key);
		if (!ignoreLibrary && !libraryPass(r)) return false;
		if (state.yearRange && !ignoreYears && !(r.year >= state.yearRange.from && r.year <= state.yearRange.to)) return false;
		if (!applyLocalFacet(r) || !personPass(r)) return false;
		if (typeof spec === "string") spec = Filters.compile(spec, state.rules);
		return !spec || Filters.matches(r, spec, filterEnv, { ignoreYears, skipRule });
	}

	function sortValue(r, k) {
		if (k === "rank" && r.popOriginal) return r.popRank ?? -1;
		if (k === "cpy") return ZotPoPMetrics.citesPerYear(r) ?? -1;
		if (k === "affiliation") return affiliationSortKey(r);
		if (k === "country") return (affiliationOf(r)?.countries || []).join("/");
		if (k === "tier") return affiliationOf(r)?.hIndex ?? -1;
		if (k === "inLibrary") return r.inLibrary ? 1 : 0;
		/* "Rank by my library": strong links, then some, each by score; weak and none tie, so the search's own
		   order (rank) decides among them; then held papers, rows not yet ranked, and those that cannot be. */
		if (k === "related") { let t = ZotPoPRelated.rankOf(r.related); return (6 - t) * 1e6 + (t < 2 ? r.related.score : 0); }
		if (k === "pdf") return hasPDF(r) ? 1 : 0;
		let v = r[k];
		if (v == null) return ["citations", "year", "rank", "journalIF", "journalOA2y"].includes(k) ? -1 : "";
		return typeof v === "string" ? v.toLowerCase() : v;
	}

	// What sortValue gives for a missing value: the -1 of a figure, the empty text, the lab-less "9".
	const UNKNOWN_BELOW_ZERO = new Set(["citations", "year", "rank", "journalIF", "journalOA2y", "cpy", "tier"]);
	function sortUnknown(v, k) {
		if (v === -1) return UNKNOWN_BELOW_ZERO.has(k);
		return v === "" || (k === "affiliation" && v === "9");
	}

	function hasPDF(r) { return Boolean((r.pdfUrls || []).length || r.pdfUrl || r.pmcid || r.arxiv); }

	// ------------------------------------------------------------ journal mark
	// The publisher's lettermark in its own colour, before the journal's name: a
	// reader knows "Science is red, Cell is blue" long before reading the title.
	function journalIdentity(r) {
		if (typeof ZotPoPJournalMarks === "undefined" || !r?.venue) return null;
		let identity = journalOf(r);
		if (!identity) return null;
		/* Both themes' inks travel with the element as custom properties and search.css picks one
		   with prefers-color-scheme. Choosing by matchMedia at render time left the light ink on a
		   dark page (Genome Biology came out at 1:1) whenever the theme changed after the draw,
		   and in any static copy of the page. */
		let light = ZotPoPJournalMarks.colours(identity, { dark: false });
		let dark = ZotPoPJournalMarks.colours(identity, { dark: true });
		return { identity, tone: light, light, dark,
			// OpenAlex's ISO 4 abbreviation when the journal lookup supplied one; the
			// module's own otherwise.
			abbrev: r.journalAbbrev || identity.mark };
	}
	function setJournalTones(el, found) {
		let put = (name, value) => { if (typeof el.style.setProperty === "function") el.style.setProperty(name, value); else el.style[name] = value; };
		for (let [suffix, tone] of [["l", found.light], ["d", found.dark]]) {
			put("--j-ink-" + suffix, tone.ink);
			put("--j-fill-" + suffix, tone.fill);
			put("--j-edge-" + suffix, tone.edge);
		}
	}
	function journalMark(r) {
		let found = journalIdentity(r);
		if (!found) return null;
		let mark = document.createElement("span");
		mark.className = "jmark" + (found.identity.known ? " known" : "");
		mark.textContent = found.abbrev;
		// A tinted chip (fill and ink of one hue), never the raw brand colour: a saturated
		// block would be the loudest thing on the screen. search.css picks the theme's pair.
		setJournalTones(mark, found);
		tip(mark, found.identity.label ? r.venue + " · " + found.identity.label : r.venue);
		return mark;
	}
	// The journal's name written in its publisher's colour, as the library list does.
	function paintVenue(cell, r) {
		let found = journalIdentity(r);
		if (!found) return;
		setJournalTones(cell, found);
		cell.classList.add("venue-known");
	}

	// ------------------------------------------------------------ affiliation
	/* Summaries are kept per list of people, but enrichment fills a list in place, so a
	   kept summary outlives its data. Every display of results is a new data version:
	   the memo starts over, and nothing that sorts, draws or exports reads an old one. */
	let affiliationMemo = new WeakMap();
	function affiliationOf(r) {
		if (typeof ZotPoPAffiliations === "undefined" || !r?.people) return null;
		/* Asked on every comparison of a sort and every keystroke of the filter:
		   with two thousand rows, tens of thousands of summaries of the same
		   author lists. One per list of people, kept while the list lives. */
		if (typeof r.people !== "object") return ZotPoPAffiliations.summarise(r.people);
		let held = affiliationMemo.get(r.people);
		if (held === undefined) { held = ZotPoPAffiliations.summarise(r.people); affiliationMemo.set(r.people, held); }
		return held;
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
	/* The line under a title: who did the work and where, from data the search already holds. First and
	   corresponding author, each with an institution (and the country), or nothing at all: a source that
	   carries no affiliations gets no line and no placeholder. */
	function shortInstitution(name) {
		return String(name || "").replace(/\bUniversity\b/g, "Univ.").replace(/\bInstitute\b/g, "Inst.").replace(/\bLaboratory\b/g, "Lab.").replace(/\s+/g, " ").trim();
	}
	function affLineParts(r) {
		let where = affiliationOf(r), out = [];
		if (!where) return out;
		if (where.first?.institution) out.push({ role: "first", ...where.first });
		if (where.corresponding?.institution) out.push({ role: where.correspondingKnown ? "corr" : "last", ...where.corresponding });
		return out;
	}
	/* The institution has its own column now (tier, flag, lab of the corresponding author, else the first), so
	   the line under the title no longer repeats it: it names who did the work and who answers for it, which the
	   authors column cannot say, and adds the first author's lab only where it is a different one from the column's. */
	function affColumnRow(where) { return where ? (where.corresponding || where.first) : null; }
	function affLineNode(parts, where) {
		let line = document.createElement("div");
		line.className = "t-aff";
		let columnKey = ZotPoPFilters.flat(affColumnRow(where)?.institution);
		let put = text => line.appendChild(document.createTextNode(text));
		parts.forEach((p, i) => {
			if (i) put(" \u00b7 ");
			let role = document.createElement("span"); role.className = "aff-role";
			role.textContent = t(p.role === "first" ? "affLineFirst" : p.role === "corr" ? "affLineCorr" : "affLineLast") + " ";
			line.appendChild(role);
			put(p.name);
			if (p.role === "first" && ZotPoPFilters.flat(p.institution) !== columnKey) put(" \u00b7 " + (p.flag ? p.flag + " " : "") + shortInstitution(p.institution));
		});
		return line;
	}
	// Nothing to add to the authors column and the institution column: no second line.
	function affLineNeeded(parts, where) {
		if (!parts.length) return false;
		if (parts.some(p => p.role !== "first")) return true;
		return ZotPoPFilters.flat(parts[0].institution) !== ZotPoPFilters.flat(affColumnRow(where)?.institution);
	}
	function countryName(code) {
		try { return new Intl.DisplayNames([uiLocale], { type: "region" }).of(code) || code; } catch (e) { return code; }
	}
	/* A paper whose source normally names institutions but gave none for this author reads as "unknown", muted;
	   a source that never has them (no people at all, and not OpenAlex) stays empty. */
	function affUnknownWanted(r, where) { return where ? true : r?.source === "openalex"; }
	function affCellTip(r, where) {
		let row = affColumnRow(where);
		if (!row) return affUnknownWanted(r, where) ? t("affUnknown") : "";
		let lines = [row.institution || t("affUnknown")];
		let facts = [];
		if (row.country) facts.push((row.flag ? row.flag + " " : "") + countryName(row.country));
		if (row.hIndex != null) facts.push(t("affHIndex", row.hIndex));
		if (row.tier) facts.push(tierLabel(row.tier));
		if (facts.length) lines.push(facts.join(" · "));
		let role = where.corresponding ? (where.correspondingKnown ? t("affCorresponding") : t("affLast")) : t("affFirst");
		lines.push(role + ": " + row.name);
		if (where.corresponding && where.first) lines.push(personLine(t("affFirst"), where.first));
		let others = where.countries.filter(c => c !== row.country);
		if (others.length) lines.push(t("affIntl", others.map(c => (ZotPoPAffiliations.flag(c) + " " + countryName(c)).trim()).join(", ")));
		return lines.join("\n");
	}
	/* Mirrors Style Custom's column: the tier chip leads so chips line up at the left edge, then the flag, then the
	   lab with an ellipsis; the lab's own name rolls on hover. Tier appears once the institution's h-index is known. */
	function buildAffCell(cell, r) {
		let where = affiliationOf(r), row = affColumnRow(where);
		if (!row && !affUnknownWanted(r, where)) return;
		let box = document.createElement("div");
		box.className = "aff-cell";
		let chip = row?.tier ? tierChip({ tier: row.tier, hIndex: row.hIndex }) : null;
		if (chip) { chip.removeAttribute("data-tip"); box.appendChild(chip); }
		if (row?.flag) { let f = document.createElement("span"); f.className = "aff-flag"; f.textContent = row.flag; box.appendChild(f); }
		let name = document.createElement("span");
		name.className = "aff-name" + (row?.institution ? "" : " aff-unknown");
		// OpenAlex names carry their country ("BGI Group (China)"); the flag already says so.
		let inst = row?.institution ? row.institution.replace(/\s*\([^)]+\)\s*$/, row.flag ? "" : "$&").trim() || row.institution : "";
		name.textContent = inst ? shortInstitution(inst) : t("affUnknown");
		if (inst) name.dataset.marquee = "affiliation";
		box.appendChild(name);
		cell.appendChild(box);
	}
	function affiliationSortKey(r) {
		let row = affColumnRow(affiliationOf(r));
		if (!row) return "9";
		let rank = row.tier ? String(["t1", "t2", "t3", "t4"].indexOf(row.tier) + 1) : "5";
		return rank + (row.institution || "").toLowerCase();
	}

	/* The author line of the detail, as a paper's header writes it: each author with a small index into the
	   list of institutions right below, the first author in bold and the corresponding one starred. Up to
	   six authors show; "+N" opens the rest in place. An institution is a button that keeps only that
	   institution's papers. A paper whose source gave no institutions keeps the plain author line. */
	const AUTHORS_SHOWN = 6;
	function filterByInstitution(key, name) {
		let rule = state.rules.find(x => x.kind === "inst" && x.mode === "include");
		if (!rule) rule = Filters.newRule("inst", "include");
		if (!state.rules.includes(rule)) state.rules.push(rule);
		if (!rule.values.includes(key)) { rule.values.push(key); rule.labels[key] = name; }
		filtersChanged();
	}
	function renderAuthors(r) {
		let box = $("d-authors");
		box.textContent = "";
		let people = (Array.isArray(r.people) ? r.people : []).filter(p => p && String(p.name || "").trim());
		if (!people.some(p => p.institution)) { box.textContent = r.authorString || t("noAuthors"); return; }
		state.authorsOpen ||= new Set();
		let expanded = state.authorsOpen.has(r.key), shown = expanded ? people : people.slice(0, AUTHORS_SHOWN);
		let flagged = people.some(p => p.corresponding);
		let index = new Map(), order = [];
		let names = document.createElement("div"); names.className = "au-list";
		shown.forEach((p, i) => {
			if (i) names.appendChild(document.createTextNode(", "));
			let span = document.createElement("span");
			span.className = "au" + (p === people[0] || p.position === "first" ? " au-first" : "");
			span.appendChild(document.createTextNode(p.name));
			let key = Filters.flat(p.institution);
			if (key) {
				if (!index.has(key)) { index.set(key, order.length + 1); order.push({ key, name: p.institution, country: p.country }); }
				let sup = document.createElement("sup"); sup.textContent = String(index.get(key)); span.appendChild(sup);
			}
			if (p.corresponding) { let star = document.createElement("sup"); star.className = "au-corr"; star.textContent = "*"; tip(star, t("affCorresponding")); span.appendChild(star); }
			if (span.classList.contains("au-first")) tip(span, t("affFirst"));
			names.appendChild(span);
		});
		if (people.length > AUTHORS_SHOWN) {
			names.appendChild(document.createTextNode(" "));
			let more = document.createElement("button");
			more.type = "button"; more.className = "ghost au-more";
			more.textContent = expanded ? t("authorsFewer") : t("authorsMore", people.length - AUTHORS_SHOWN);
			more.setAttribute("aria-expanded", String(expanded));
			more.addEventListener("click", () => { if (expanded) state.authorsOpen.delete(r.key); else state.authorsOpen.add(r.key); renderAuthors(r); });
			names.appendChild(more);
		}
		box.appendChild(names);
		if (order.length) {
			let list = document.createElement("div"); list.className = "au-insts";
			for (let inst of order) {
				let item = document.createElement("span"); item.className = "au-inst";
				let num = document.createElement("span"); num.className = "au-num"; num.textContent = String(index.get(inst.key)); item.appendChild(num);
				let b = document.createElement("button"); b.type = "button"; b.className = "ghost au-inst-btn";
				b.textContent = inst.name + (inst.country ? " (" + inst.country + ")" : "");
				tip(b, t("instFilterTip", inst.name));
				b.addEventListener("click", () => filterByInstitution(inst.key, inst.name));
				item.appendChild(b);
				list.appendChild(item);
			}
			// "* corresponding" ends the same line, not a line of its own.
			if (flagged) { let legend = document.createElement("span"); legend.className = "au-legend"; legend.textContent = "* " + t("affCorrLegend"); list.appendChild(legend); }
			box.appendChild(list);
		}
		else if (flagged) { let legend = document.createElement("div"); legend.className = "au-legend"; legend.textContent = "* " + t("affCorrLegend"); box.appendChild(legend); }
	}
	function tierChip(where) {
		if (!where?.tier) return null;
		let s = document.createElement("span");
		s.className = "tier tier-" + where.tier;
		s.textContent = tierLabel(where.tier);
		tip(s, t("thTierTip") + (where.hIndex != null ? "\n" + t("affHIndex", where.hIndex) : ""));
		return s;
	}

	/* ---- hover cards: built on hover from the record, no network ---- */
	const TIP_NAMES = 6;
	function tipRecord(el) {
		let tr = el.closest ? el.closest("tr") : null, key = tr && tr.dataset.key;
		return key ? state.records.find(r => r.key === key) || null : null;
	}
	function tipTierChip(row) {
		let chip = fel("span", "tier tier-" + row.tier, tierLabel(row.tier));
		return chip;
	}
	function tipTierText(row) {
		if (row.hIndex == null || !row.tier) return "";
		let tiers = ZotPoPAffiliations.TIERS, i = tiers.findIndex(x => x.key === row.tier);
		return tiers[i].floor > 0 ? t("tipTierAbove", row.hIndex, tierLabel(row.tier), tiers[i].floor) : t("tipTierBelow", row.hIndex, tierLabel(row.tier), tiers[i - 1].floor);
	}
	function tipPlace(row) {
		// Always in one order: the tier chip, the flag, then the name.
		let line = fel("div", "tip-where");
		if (row.tier) line.appendChild(tipTierChip(row));
		if (row.flag) line.appendChild(fel("span", "tip-flag", row.flag));
		line.appendChild(fel("span", "tip-inst", row.institution || t("affUnknown")));
		return line;
	}
	function tipNames(r, limit) {
		let people = (Array.isArray(r.people) ? r.people : []).filter(p => p && String(p.name || "").trim());
		let list = people.length ? people.map((p, i) => ({ name: p.name, first: i === 0 || p.position === "first", corr: Boolean(p.corresponding) }))
			: (Array.isArray(r.authors) ? r.authors : []).map((a, i) => ({ name: a.name || [a.firstName, a.lastName].filter(Boolean).join(" "), first: i === 0, corr: false })).filter(a => a.name);
		let box = fel("div", "tip-names");
		list.slice(0, limit).forEach((p, i) => {
			if (i) box.appendChild(document.createTextNode(", "));
			box.appendChild(fel("span", p.first ? "tip-strong" : "tip-name", p.name + (p.corr ? "*" : "")));
		});
		if (list.length > limit) box.appendChild(fel("span", "tip-more", " " + t("authorsMore", list.length - limit)));
		return { box, total: list.length, corr: list.some(p => p.corr) };
	}
	function tipTitleCard(r) {
		let box = fel("div", "tip-rich");
		box.appendChild(fel("div", "tip-title", r.title));
		let cpy = ZotPoPMetrics.citesPerYear(r);
		let meta = [r.year, r.citations == null ? "" : t("tipCites", r.citations), cpy == null || !Number.isFinite(cpy) ? "" : t("tipPerYear", fmt(cpy, 1))].filter(x => x !== "" && x != null);
		if (r.venue || meta.length) {
			// the journal's full name in its own ink, the figures after it in grey
			let line = fel("div", "tip-meta");
			if (r.venue) { let name = fel("span", "tip-venue", r.venue); paintVenue(name, r); line.appendChild(name); }
			if (meta.length) line.appendChild(document.createTextNode((r.venue ? " \u00b7 " : "") + meta.join(" \u00b7 ")));
			box.appendChild(line);
		}
		let names = tipNames(r, TIP_NAMES);
		if (names.total) box.appendChild(names.box);
		let where = affiliationOf(r), rows = [];
		if (where?.first?.institution) rows.push([t("affFirst"), where.first]);
		if (where?.corresponding?.institution) rows.push([where.correspondingKnown ? t("affCorresponding") : t("affLast"), where.corresponding]);
		// The same lab for both would be said twice: one row for the two roles.
		if (rows.length === 2 && ZotPoPFilters.flat(rows[0][1].institution) === ZotPoPFilters.flat(rows[1][1].institution)) rows = [[t(where.correspondingKnown ? "affFirstCorr" : "affFirstLast"), rows[1][1]]];
		if (rows.length) {
			let sect = fel("div", "tip-sect");
			for (let [label, row] of rows) { let line = fel("div", "tip-row"); line.appendChild(fel("span", "tip-label", label)); line.appendChild(tipPlace(row)); sect.appendChild(line); }
			box.appendChild(sect);
		}
		return box;
	}
	function tipAffCard(r) {
		let where = affiliationOf(r), row = affColumnRow(where);
		if (!row) return affUnknownWanted(r, where) ? t("affUnknown") : null;
		let box = fel("div", "tip-rich");
		box.appendChild(fel("div", "tip-title", row.institution || t("affUnknown")));
		let place = fel("div", "tip-where");
		if (row.tier) place.appendChild(tipTierChip(row));
		if (row.flag) place.appendChild(fel("span", "tip-flag", row.flag));
		if (row.country) place.appendChild(fel("span", "tip-inst", countryName(row.country)));
		if (place.firstChild) box.appendChild(place);
		let tier = tipTierText(row);
		if (tier) box.appendChild(fel("div", "tip-meta", tier));
		let sect = fel("div", "tip-sect");
		let role = where.corresponding ? (where.correspondingKnown ? t("affCorresponding") : t("affLast")) : t("affFirst");
		let line = fel("div", "tip-row"); line.appendChild(fel("span", "tip-label", role)); line.appendChild(fel("span", "tip-person", row.name)); sect.appendChild(line);
		if (where.corresponding && where.first && where.first.institution && ZotPoPFilters.flat(where.first.institution) !== ZotPoPFilters.flat(row.institution)) {
			let other = fel("div", "tip-row"); other.appendChild(fel("span", "tip-label", t("affFirst"))); other.appendChild(fel("span", "tip-person", where.first.name + " \u00b7 " + (where.first.flag ? where.first.flag + " " : "") + where.first.institution)); sect.appendChild(other);
		}
		let others = where.countries.filter(c => c !== row.country);
		if (others.length) { let line = fel("div", "tip-row"); line.appendChild(fel("span", "tip-label", t("tipCountries"))); line.appendChild(fel("span", "tip-person", others.map(c => (ZotPoPAffiliations.flag(c) + " " + countryName(c)).trim()).join(", "))); sect.appendChild(line); }
		box.appendChild(sect);
		return box;
	}
	function tipJournalCard(r) {
		if (!r.venue) return null;
		let box = fel("div", "tip-rich"), found = journalIdentity(r);
		let head = fel("div", "tip-title", r.venue); paintVenue(head, r);
		box.appendChild(head);
		let facts = [];
		if (found && found.abbrev && found.abbrev !== r.venue) facts.push([t("tipAbbrev"), found.abbrev]);
		let publisher = r.publisher || found?.identity?.label;
		if (publisher) facts.push([t("tipPublisher"), publisher]);
		if (r.journalIF != null) facts.push(["IF", fmt(r.journalIF, 1)]);
		if (r.journalOA2y != null) facts.push([t("thOA"), fmt(r.journalOA2y, 1)]);
		if (facts.length) {
			let sect = fel("div", "tip-sect");
			for (let [label, value] of facts) { let line = fel("div", "tip-row"); line.appendChild(fel("span", "tip-label", label)); line.appendChild(fel("span", label === "IF" ? "tip-strong" : "tip-name", value)); sect.appendChild(line); }
			box.appendChild(sect);
		}
		if (r.journalIF != null) box.appendChild(fel("div", "tip-hint", t("jifTip", fmt(r.journalIF, 1), r.journalIFSource, r.journalH, r.journalIFAs)));
		if (r.journalOA2y != null) box.appendChild(fel("div", "tip-hint", t("oaTip", fmt(r.journalOA2y, 1), r.journalIF == null ? r.journalH : null)));
		return box;
	}
	function tipAuthorsCard(r) {
		let names = tipNames(r, 60);
		if (!names.total) return null;
		let box = fel("div", "tip-rich");
		box.appendChild(fel("div", "tip-meta tip-head", t("tipAuthorsAll", names.total)));
		box.appendChild(names.box);
		if (names.corr) box.appendChild(fel("div", "tip-hint", "* " + t("affCorresponding")));
		return box;
	}
	function tipContent(el, kind) {
		let r = tipRecord(el);
		if (!r) return null;
		if (kind === "title") return tipTitleCard(r);
		if (kind === "aff") return tipAffCard(r);
		if (kind === "journal") return tipJournalCard(r);
		if (kind === "authors") return tipAuthorsCard(r);
		if (kind === "related") return r.related && r.related.score != null ? relatedTipText(r.related) : null;
		return null;
	}

	// The results filter can always be let go of: Escape in the box, the × beside it.
	function syncFilterClear() { let b = $("filter-clear"); if (b) b.hidden = !$("filter").value; }
	function clearFilter() { $("filter").value = ""; state.facet = null; state.yearRange = null; state.priorKeys = null; state.focusKey = null; render(); syncFilterClear(); }

	// ------------------------------------------------------------ filter builder
	/* The results filter has three parts that combine with AND: the box (words, "phrases", -word,
	   field:value), the rules of the builder (a kind, include or exclude, any-of values) and the
	   toolbar's library filter. content/filters.js decides who passes; this section is the window's
	   state and drawing: a button beside the box, a popover with the rules, and a chip per active rule. */
	const Filters = ZotPoPFilters;
	const filterEnv = { where: r => affiliationOf(r), cpy: r => ZotPoPMetrics.citesPerYear(r) };
	function filterSpec() { return Filters.compile($("filter") ? $("filter").value : "", state.rules); }
	// A sprite icon (search.xhtml's <symbol>s) as a node, for buttons built in code.
	function iconNode(id) {
		if (typeof document.createElementNS !== "function") return document.createElement("span");
		let svg = document.createElementNS(SVG_NS, "svg"), use = document.createElementNS(SVG_NS, "use");
		svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("class", "ic"); svg.setAttribute("aria-hidden", "true");
		use.setAttribute("href", "#" + id); svg.appendChild(use);
		return svg;
	}
	function fel(tag, cls, text) {
		let e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}
	function fbutton(cls, text, label, onClick) {
		let b = fel("button", cls, text); b.type = "button";
		if (label) { b.setAttribute("aria-label", label); tip(b, label); }
		if (onClick) b.addEventListener("click", e => { e.stopPropagation(); onClick(e); });
		return b;
	}
	const ruleById = id => state.rules.find(r => r.id === id) || null;
	const activeRules = () => state.rules.filter(Filters.ruleActive);

	// ---- words for a rule
	function rangeText(rule) {
		// A threshold reads as typed: IF ≥ 2.25 is not shown as ≥ 2.3.
		let { min, max } = rule, f = v => Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
		let text = min != null && max != null ? (min === max ? f(min) : f(min) + "–" + f(max)) : min != null ? "≥ " + f(min) : "≤ " + f(max);
		// Papers with no value kept in: the chip says so, or the count beside it looks wrong.
		return rule.includeUnknown && rule.mode !== "exclude" && Filters.UNKNOWN_KINDS.includes(rule.kind) ? text + " " + t("filterUnknownChip") : text;
	}
	function valueLabel(rule, key) {
		if (rule.kind === "text") return key;
		if (rule.kind === "type") return t("filterType", key);
		if (rule.kind === "pdf") return t(key === "yes" ? "filterPdfYes" : "filterPdfNo");
		if (rule.kind === "source") return sourceLabel(key);
		if (rule.kind === "country") return (ZotPoPAffiliations.flag(key) + " " + key).trim();
		return rule.labels[key] || key;
	}
	function ruleSummary(rule) {
		if (Filters.RANGE_KINDS.includes(rule.kind)) return rangeText(rule);
		let labels = rule.values.map(key => valueLabel(rule, key)), shown = labels.slice(0, 2).join(", ");
		return labels.length > 2 ? shown + " +" + (labels.length - 2) : shown;
	}
	function ruleKindLabel(rule) {
		return t("filterKind", rule.kind) + (rule.kind === "text" && rule.field !== "all" ? " · " + t("filterField", rule.field) : "");
	}
	function ruleText(rule) { return ruleKindLabel(rule) + ": " + ruleSummary(rule); }

	// ---- changing rules
	function filtersChanged(light = false) {
		state.focusKey = null;
		state.popLight = light;
		try { render(); } finally { state.popLight = false; }
	}
	function addRule(kind, mode = "include") {
		let rule = Filters.newRule(kind, mode);
		state.rules.push(rule);
		state.filterEdit = rule.id;
		return rule;
	}
	function removeRule(id) {
		state.rules = state.rules.filter(r => r.id !== id);
		if (state.filterEdit === id) state.filterEdit = null;
		if (state.filterQ) delete state.filterQ[id];
		if (state.filterDraft) delete state.filterDraft[id];
		filtersChanged();
	}
	function toggleRuleValue(rule, key, label, on) {
		let has = rule.values.includes(key);
		if (on === undefined) on = !has;
		if (on && !has) { rule.values.push(key); if (label) rule.labels[key] = label; }
		else if (!on && has) rule.values = rule.values.filter(v => v !== key);
		filtersChanged();
	}
	function setRuleRange(rule, min, max) {
		let num = v => { let n = v === "" || v == null ? null : Number(v); return n != null && Number.isFinite(n) ? n : null; };
		rule.min = num(min); rule.max = num(max);
		// A reversed pair means the same range the other way round.
		if (rule.min != null && rule.max != null && rule.min > rule.max) [rule.min, rule.max] = [rule.max, rule.min];
		filtersChanged(true);
	}
	function dropEmptyRules() { state.rules = state.rules.filter(Filters.ruleActive); }
	function resetFilters() {
		let box = $("filter"); if (box) box.value = "";
		state.facet = null; state.yearRange = null; state.priorKeys = null; state.rules = []; state.filterEdit = null; state.filterQ = {}; state.filterDraft = {};
		if (state.filterOpen) closeFilterPop(false);
	}
	function clearAllFilters() {
		resetFilters();
		state.libraryFilter = "all";
		state.focusKey = null;
		syncFilterClear();
		render();
	}

	// ---- the chips under the toolbar
	function syncFilterUI() {
		let rules = activeRules(), btn = $("filter-btn");
		if (btn) {
			let count = $("filter-count");
			if (count) { count.hidden = !rules.length; count.textContent = String(rules.length); }
			btn.setAttribute("aria-expanded", String(Boolean(state.filterOpen)));
			btn.disabled = state.records.length === 0;
			btn.classList.toggle("active", rules.length > 0);
		}
		let box = $("filter-chips"); if (!box) return;
		box.textContent = "";
		box.hidden = !rules.length;
		for (let rule of rules) {
			let exclude = rule.mode === "exclude", text = ruleText(rule);
			let chip = fel("span", "fchip" + (exclude ? " excl" : "")); chip.setAttribute("role", "listitem");
			let main = fbutton("fchip-main", null, null, () => openFilterPop(rule.id, main));
			main.setAttribute("aria-label", (exclude ? t("filterExcluded") + " · " : "") + text + " — " + t("filterChipEdit"));
			tip(main, (exclude ? t("filterExcluded") + " · " : "") + rule.values.map(key => valueLabel(rule, key)).join(", ") || text);
			if (exclude) main.appendChild(fel("span", "fchip-tag", t("filterExcluded")));
			main.appendChild(fel("span", "fchip-text", text));
			chip.appendChild(main);
			chip.appendChild(fbutton("filter-clear", "×", t("filterChipRemove") + ": " + text, () => removeRule(rule.id)));
			box.appendChild(chip);
		}
		if (rules.length) box.appendChild(fbutton("ghost fchip-clear", t("filterClearAll"), null, () => clearAllFilters()));
		if (state.filterOpen && !state.popLight) renderFilterPop(); else if (state.filterOpen) renderFilterPopHead();
	}

	// ---- the popover
	function openFilterPop(ruleId, opener) {
		if (!state.records.length) return;
		closeToolbarMenu?.(); closeSelMenu?.(); closeHistoryMenu?.(); hideCtxMenu?.();
		state.filterOpen = true;
		state.filterOpener = opener || $("filter-btn");
		if (ruleId) state.filterEdit = ruleId;
		let pop = $("filter-pop"); pop.hidden = false;
		renderFilterPop();
		$("filter-btn")?.setAttribute("aria-expanded", "true");
		let target = ruleId ? pop.querySelector?.(`[data-fid="rule:${ruleId}:first"]`) : null;
		(target || pop.querySelector?.('[data-fid="close"]'))?.focus?.();
	}
	function closeFilterPop(returnFocus = true) {
		if (!state.filterOpen) return;
		state.filterOpen = false;
		let pop = $("filter-pop"); pop.hidden = true; pop.textContent = "";
		dropEmptyRules();
		state.filterEdit = null;
		let opener = state.filterOpener; state.filterOpener = null;
		$("filter-btn")?.setAttribute("aria-expanded", "false");
		syncFilterUI();
		if (returnFocus) (opener && opener.isConnected !== false ? opener : $("filter-btn"))?.focus?.();
	}
	function toggleFilterPop() { if (state.filterOpen) closeFilterPop(true); else openFilterPop(null, $("filter-btn")); }

	// The records every other rule lets through: what an option list counts, so a number is what you would get.
	function baseFor(rule) {
		let spec = filterSpec();
		return state.records.filter(r => matchesFilter(r, spec, false, false, rule ? rule.id : null));
	}

	function renderFilterPopHead() {
		let shown = $("filter-pop")?.querySelector?.(".fp-shown"); if (shown) shown.textContent = t("filterShown", state.visible.length, state.records.length);
		// what a rule says about itself changes as its values are typed
		for (let rule of state.rules) {
			let sum = $("filter-pop")?.querySelector?.(`[data-rule="${rule.id}"]`)?.querySelector?.(".fp-sum");
			if (sum) { sum.textContent = Filters.ruleActive(rule) ? ruleSummary(rule) : t("filterNothingYet"); sum.className = "fp-sum" + (Filters.ruleActive(rule) ? "" : " empty"); }
		}
	}
	function renderFilterPop() {
		let pop = $("filter-pop"); if (!pop || pop.hidden) return;
		// A redraw must not drop the keyboard: remember what had focus inside, and give it back.
		let active = document.activeElement, keep = active && pop.contains?.(active) ? active.getAttribute?.("data-fid") : null;
		let caret = keep && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
		let scroll = pop.querySelector?.(".fp-body")?.scrollTop || 0;
		// A long option list scrolled to the third value keeps its place when one is ticked or a batch arrives.
		let listScroll = new Map([...(pop.querySelectorAll?.(".fp-opts") || [])].map(list => [list.getAttribute("data-fid"), list.scrollTop || 0]));
		pop.textContent = "";
		pop.setAttribute("aria-label", t("filterPopTitle"));

		let head = fel("div", "fp-head");
		let title = fel("h3", null, t("filterPopTitle")); title.id = "filter-pop-title";
		head.appendChild(title);
		head.appendChild(fel("span", "fp-shown", t("filterShown", state.visible.length, state.records.length)));
		head.appendChild(fel("span", "spacer"));
		let any = activeRules().length || $("filter").value.trim() || state.facet || state.yearRange || state.libraryFilter !== "all";
		let clear = fbutton("ghost", t("filterClearAll"), null, () => clearAllFilters()); clear.disabled = !any; clear.setAttribute("data-fid", "clear-all");
		head.appendChild(clear);
		let close = fbutton("filter-clear", "×", t("filterClose"), () => closeFilterPop(true)); close.setAttribute("data-fid", "close");
		head.appendChild(close);
		pop.appendChild(head);

		let body = fel("div", "fp-body");
		// the quick syntax of the box
		let quick = fel("section", "fp-sec");
		quick.appendChild(fel("div", "fp-label", t("filterQuickTitle")));
		let ex = fel("div", "fp-examples");
		for (let sample of ["journal:Cell", "-author:Kim", "\"exact phrase\"", "year:2020-2024", "inst:Harvard", "country:KR"]) ex.appendChild(fel("code", null, sample));
		quick.appendChild(ex);
		quick.appendChild(fel("p", "fp-hint", t("filterQuickHint")));
		body.appendChild(quick);

		// the rules
		let rules = fel("section", "fp-sec");
		rules.appendChild(fel("div", "fp-label", t("filterRules")));
		if (!state.rules.length) rules.appendChild(fel("p", "fp-hint", t("filterRulesEmpty")));
		for (let rule of state.rules) rules.appendChild(ruleCard(rule));
		body.appendChild(rules);

		let add = fel("section", "fp-sec");
		add.appendChild(fel("div", "fp-label", t("filterAdd")));
		let kinds = fel("div", "fp-kinds");
		for (let kind of Filters.KINDS) {
			let b = fbutton("fp-chip", "+ " + t("filterKind", kind), null, () => { addRule(kind); renderFilterPop(); pop.querySelector?.(`[data-fid="rule:${state.filterEdit}:first"]`)?.focus?.(); });
			b.setAttribute("data-fid", "add:" + kind);
			kinds.appendChild(b);
		}
		add.appendChild(kinds); body.appendChild(add);
		pop.appendChild(body);
		positionFilterPop();
		body.scrollTop = scroll;
		for (let list of pop.querySelectorAll?.(".fp-opts") || []) { let top = listScroll.get(list.getAttribute("data-fid")); if (top) list.scrollTop = top; }
		if (keep) {
			let again = pop.querySelector?.(`[data-fid="${keep}"]`);
			if (again) { again.focus?.(); if (caret) try { again.setSelectionRange(caret[0], caret[1]); } catch (e) {} }
		}
	}
	function positionFilterPop() {
		let pop = $("filter-pop"), btn = $("filter-btn");
		if (!pop || typeof btn?.getBoundingClientRect !== "function") return;
		let r = btn.getBoundingClientRect(), w = Math.min(528, window.innerWidth - 16);
		// Under its own button, never past the footer: the card ends 8px above the import bar (or the window's edge).
		let floor = $("import-bar")?.getBoundingClientRect?.().top || window.innerHeight - 8;
		pop.style.width = w + "px";
		pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
		pop.style.top = (r.bottom + 8) + "px";
		pop.style.maxHeight = Math.max(240, floor - 8 - (r.bottom + 8)) + "px";
	}

	function ruleCard(rule) {
		let open = state.filterEdit === rule.id;
		let card = fel("div", "fp-rule" + (rule.mode === "exclude" ? " excl" : "")); card.setAttribute("data-rule", rule.id);
		let head = fel("div", "fp-rule-head");
		let mode = fel("div", "fp-seg fp-mode"); mode.setAttribute("role", "group"); mode.setAttribute("aria-label", t("filterMode"));
		for (let m of ["include", "exclude"]) {
			let b = fbutton("", t(m === "include" ? "filterInclude" : "filterExclude"), null, () => { rule.mode = m; filtersChanged(); });
			b.setAttribute("aria-pressed", String(rule.mode === m)); b.setAttribute("data-fid", "mode:" + rule.id + ":" + m);
			mode.appendChild(b);
		}
		head.appendChild(mode);
		let toggle = fel("button", "fp-rule-toggle"); toggle.type = "button";
		toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("data-fid", "rule:" + rule.id + ":toggle");
		if (rule.mode === "exclude") toggle.appendChild(fel("span", "fchip-tag", t("filterExcluded")));
		toggle.appendChild(fel("span", "fp-kind", ruleKindLabel(rule)));
		let sum = Filters.ruleActive(rule) ? ruleSummary(rule) : t("filterNothingYet");
		toggle.appendChild(fel("span", "fp-sum" + (Filters.ruleActive(rule) ? "" : " empty"), sum));
		toggle.appendChild(fel("span", "fp-chev"));
		toggle.addEventListener("click", e => { e.stopPropagation(); state.filterEdit = open ? null : rule.id; renderFilterPop(); });
		head.appendChild(toggle);
		head.appendChild(fbutton("filter-clear", "×", t("filterRemoveRule") + ": " + ruleKindLabel(rule), () => removeRule(rule.id)));
		card.appendChild(head);
		if (open) card.appendChild(ruleEditor(rule));
		return card;
	}

	function ruleEditor(rule) {
		let box = fel("div", "fp-edit");
		if (rule.kind === "text") return textEditor(rule, box);
		if (Filters.RANGE_KINDS.includes(rule.kind)) return rangeEditor(rule, box);
		return optionEditor(rule, box);
	}
	function textEditor(rule, box) {
		let fields = fel("div", "fp-fields"); fields.setAttribute("role", "group"); fields.setAttribute("aria-label", t("filterFieldLabel"));
		for (let field of Filters.TEXT_FIELDS) {
			let b = fbutton("fp-chip", t("filterField", field), null, () => { rule.field = field; filtersChanged(); });
			b.setAttribute("aria-pressed", String(rule.field === field)); b.setAttribute("data-fid", "field:" + rule.id + ":" + field);
			fields.appendChild(b);
		}
		box.appendChild(fields);
		let row = fel("div", "fp-addrow");
		let input = fel("input"); input.type = "text"; input.setAttribute("placeholder", t("filterWordsPh")); input.setAttribute("aria-label", t("filterWordsPh"));
		input.setAttribute("data-fid", "rule:" + rule.id + ":first");
		// Words typed but not yet added survive a redraw (a batch of results arriving redraws the popover).
		state.filterDraft ||= {};
		input.value = state.filterDraft[rule.id] || "";
		input.addEventListener("input", () => { state.filterDraft[rule.id] = input.value; });
		let commit = () => { let v = input.value.trim(); if (!v) return; if (!rule.values.includes(v)) rule.values.push(v); input.value = ""; delete state.filterDraft[rule.id]; filtersChanged(); };
		input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); } });
		row.appendChild(input);
		let add = fbutton("", t("filterAddWord"), null, commit); add.setAttribute("data-fid", "rule:" + rule.id + ":add");
		row.appendChild(add);
		box.appendChild(row);
		if (rule.values.length) {
			let vals = fel("div", "fp-vals");
			for (let v of rule.values) {
				let chip = fel("span", "fp-val"); chip.appendChild(fel("span", null, v));
				chip.appendChild(fbutton("filter-clear", "×", t("filterRemoveValue") + ": " + v, () => toggleRuleValue(rule, v, null, false)));
				vals.appendChild(chip);
			}
			box.appendChild(vals);
		}
		return box;
	}
	function rangeEditor(rule, box) {
		let row = fel("div", "fp-range");
		let make = (which, label) => {
			let wrap = fel("label", "fp-num"); wrap.appendChild(fel("span", null, label));
			let input = fel("input"); input.type = "number"; input.value = rule[which] == null ? "" : String(rule[which]);
			if (rule.kind === "year") { input.min = "1500"; input.max = "2100"; }
			else input.min = "0";
			if (rule.kind === "if" || rule.kind === "oa2y" || rule.kind === "cpy") input.step = "any";
			input.setAttribute("aria-label", t("filterKind", rule.kind) + " " + label); input.setAttribute("data-fid", "rule:" + rule.id + (which === "min" ? ":first" : ":max"));
			input.addEventListener("input", () => { cancelLater(state.rangeTimer); state.rangeTimer = later(() => { let lo = which === "min" ? input.value : (row.querySelector?.('[data-which="min"]')?.value ?? ""), hi = which === "max" ? input.value : (row.querySelector?.('[data-which="max"]')?.value ?? ""); setRuleRange(rule, lo, hi); }, 220); });
			input.setAttribute("data-which", which);
			wrap.appendChild(input);
			return wrap;
		};
		row.appendChild(make("min", t("filterMin")));
		row.appendChild(fel("span", "dash", "–"));
		row.appendChild(make("max", t("filterMax")));
		box.appendChild(row);
		// A figure a paper may not have: say how many papers that is and what happens to them, off by default.
		// With every paper carrying it (a year, nearly always) there is nothing to decide and no toggle.
		let missing = Filters.UNKNOWN_KINDS.includes(rule.kind) && rule.mode !== "exclude" ? baseFor(rule).filter(r => Filters.numberOf(rule.kind, r, filterEnv) == null).length : 0;
		if (missing || rule.includeUnknown && rule.mode !== "exclude" && Filters.UNKNOWN_KINDS.includes(rule.kind)) {
			let unk = fel("label", "fp-opt"); tip(unk, t("filterUnknownTip"));
			let cb = fel("input"); cb.type = "checkbox"; cb.checked = rule.includeUnknown === true; cb.setAttribute("data-fid", "unknown:" + rule.id);
			cb.addEventListener("change", () => { rule.includeUnknown = cb.checked; filtersChanged(); });
			unk.appendChild(cb); unk.appendChild(fel("span", "fp-opt-name", t("filterUnknownIn", missing)));
			box.appendChild(unk);
		}
		return box;
	}
	/* What a reader may type for a journal in the journal rule's search: the abbreviation a reference list
	   prints, the one the source gave, and the acronym ("PNAS", "JACS"). Read from lists already loaded. */
	let catalogByName = null, catalogByNameOf = null;
	function journalAlts(name, fromRecords) {
		let alts = [], key = Filters.flat(name);
		if (typeof ZotPoPJournalMarks !== "undefined") alts.push(ZotPoPJournalMarks.abbreviate(name), ZotPoPJournalMarks.abbreviateByWords(name));
		alts.push(J.acronymOf(name), ...(fromRecords?.get(key) || []));
		if (journalCatalog && catalogByNameOf !== journalCatalog) { catalogByNameOf = journalCatalog; catalogByName = new Map(journalCatalog.entries.map(e => [e.n, e])); }
		let entry = journalCatalog ? catalogByName.get(J.flat(name)) : null;
		if (entry) alts.push(...entry.abbrevs, ...entry.a);
		return [...new Set(alts.filter(Boolean))];
	}
	function sourceAbbreviations() {
		let map = new Map();
		for (let r of state.records) if (r.journalAbbrev && r.venue) { let k = Filters.flat(r.venue); if (!map.has(k)) map.set(k, []); map.get(k).push(r.journalAbbrev); }
		return map;
	}
	// Multi-value rules: a search box over the options, each with how many results it would leave.
	const FILTER_OPTION_LIMIT = 60;
	function optionEditor(rule, box) {
		state.filterQ ||= {};
		let fixed = rule.kind === "type" || rule.kind === "pdf" || rule.kind === "source";
		let list = fel("div", "fp-opts"); list.setAttribute("role", "group"); list.setAttribute("aria-label", t("filterKind", rule.kind)); list.setAttribute("data-fid", "opts:" + rule.id);
		let fill = () => {
			list.textContent = "";
			let tally = Filters.tally(rule.kind, baseFor(rule));
			let counts = new Map(tally.map(o => [o.key, o]));
			// What is chosen comes first (even at zero), then the rest by how many results each leaves.
			let chosen = rule.values.map(key => ({ key, n: counts.get(key)?.n || 0 }));
			let rest = tally.filter(o => !rule.values.includes(o.key));
			let named = key => valueLabel({ ...rule, labels: { ...rule.labels, [key]: counts.get(key)?.label || rule.labels[key] || key } }, key);
			let given = rule.kind === "journal" && (state.filterQ[rule.id] || "").trim() ? sourceAbbreviations() : null;
			let all = [...chosen, ...rest].map(o => ({ key: o.key, n: o.n, label: named(o.key), alts: given ? journalAlts(named(o.key), given) : undefined }));
			let found = Filters.searchOptions(all, state.filterQ[rule.id] || "");
			if (!found.length) list.appendChild(fel("p", "fp-hint", t("filterNoOptions")));
			for (let o of found.slice(0, FILTER_OPTION_LIMIT)) {
				let row = fel("label", "fp-opt");
				let cb = fel("input"); cb.type = "checkbox"; cb.checked = rule.values.includes(o.key); cb.setAttribute("data-fid", "opt:" + rule.id + ":" + o.key);
				cb.addEventListener("change", () => toggleRuleValue(rule, o.key, counts.get(o.key)?.label || o.label, cb.checked));
				row.appendChild(cb);
				row.appendChild(fel("span", "fp-opt-name", o.label));
				row.appendChild(fel("span", "fp-opt-n" + (o.n ? "" : " zero"), String(o.n)));
				list.appendChild(row);
			}
			if (found.length > FILTER_OPTION_LIMIT) list.appendChild(fel("p", "fp-hint", t("filterMore", found.length - FILTER_OPTION_LIMIT)));
		};
		if (!fixed) {
			let input = fel("input"); input.type = "search"; input.value = state.filterQ[rule.id] || "";
			input.setAttribute("placeholder", t("filterSearchPh", t("filterKind", rule.kind))); input.setAttribute("aria-label", t("filterSearchPh", t("filterKind", rule.kind)));
			input.setAttribute("data-fid", "rule:" + rule.id + ":first");
			input.addEventListener("input", () => { state.filterQ[rule.id] = input.value; fill(); });
			box.appendChild(input);
		}
		fill();
		box.appendChild(list);
		if (fixed) { let first = list.querySelector?.("input"); if (first) first.setAttribute("data-fid", "rule:" + rule.id + ":first"); }
		return box;
	}

	// Tab stays inside the popover, Escape closes it and hands the keyboard back to where it was opened.
	function onFilterPopKey(e) {
		if (!state.filterOpen) return;
		if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFilterPop(true); return; }
		if (e.key !== "Tab") return;
		let pop = $("filter-pop"), nodes = [...(pop.querySelectorAll?.("button, input, [tabindex]") || [])].filter(n => !n.disabled && n.tabIndex !== -1);
		if (!nodes.length) return;
		let first = nodes[0], last = nodes[nodes.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	// ------------------------------------------------------------ this search's authors
	// An author's key: the registry ID when the source gave one, else the name as written.
	// A name is not a person, so a name key never claims the results are one author's.
	const nameKey = name => String(name || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
	const authorKeys = r => ZotPoPFilters.authorKeys(r);
	// What the detail says about a paper from this search's own records alone: no request is made.
	function buildResultContext(r) {
		/* The count, its yearly mean and the index named beside them are the citation strip's own figures: the strip
		   shows OpenAlex's count when OpenAlex gave the yearly series, and naming the headline index here put
		   "per Semantic Scholar" beside OpenAlex's 90. */
		let fig = citeFigures(r), shown = fig.source ? fig.total : r.citations;
		let evidence = [], src = fig.source ? sourceLabel(fig.source) : r.citationSource ? sourceLabel(r.citationSource) : "";
		evidence.push(shown == null ? t("evCitesUnknown", src) : t("evCites", src, shown));
		let cpy = fig.source ? fig.perYear : ZotPoPMetrics.citesPerYear(r);
		if (cpy != null) evidence.push(t("evPerYear", fmt(cpy, 1)));
		if (r.journalIF != null) evidence.push(t("evIF", fmt(r.journalIF, 1)));
		if (r.journalOA2y != null) evidence.push(t("evOA2y", fmt(r.journalOA2y, 1)));
		if (hasPDF(r)) evidence.push(t("evPdf"));
		let counts = new Map();
		for (let other of state.records) for (let a of authorKeys(other)) {
			let c = counts.get(a.key) || { total: 0, unowned: 0 };
			c.total++; if (!other.inLibrary) c.unowned++;
			counts.set(a.key, c);
		}
		let authors = authorKeys(r).map(a => ({ ...a, ...counts.get(a.key) })).filter(a => a.total > 1);
		// What the citation strip above the evidence does not already say: where the count comes from, the journal's IF, a PDF.
		let rest = [];
		if (src && shown != null) rest.push(t("evSource", src));
		if (r.journalIF != null) rest.push(t("evIF", fmt(r.journalIF, 1)));
		if (r.journalOA2y != null) rest.push(t("evOA2y", fmt(r.journalOA2y, 1)));
		if (hasPDF(r)) rest.push(t("evPdf"));
		return { evidence, rest, authors };
	}
	// Whether a record passes the author facet; no facet passes everything.
	function applyLocalFacet(r) {
		return !state.facet || authorKeys(r).some(a => a.key === state.facet.key);
	}
	function setFacet(facet) {
		state.facet = facet || null;
		state.focusKey = null;
		render();
	}
	function syncFacetChip() {
		let chip = $("facet-chip"); if (!chip) return;
		chip.hidden = !state.facet;
		if (state.facet) $("facet-text").textContent = t(state.facet.byId ? "facetChipId" : "facetChipName", state.facet.name, state.visible.length);
	}

	function popOriginalJSON() { return JSON.stringify(state.records.filter(r => r.popOriginal).slice().sort((a, b) => a.popOrdinal - b.popOrdinal).map(r => r.popOriginal), null, 2); }

	// After a search the form folds to one line: keywords, Search and a summary of the other conditions.
	function conditionSummary() {
		let v = id => String($(id)?.value || "").trim(), parts = [];
		let source = sourceLabel($("source").value); if (source) parts.push(source);
		if (v("authors")) parts.push(t("authors") + " " + v("authors"));
		let journals = [...state.venueChips.map(c => c.abbrev || c.name), v("venue")].filter(Boolean);
		if (journals.length) parts.push(t("venue") + " " + journals.join(", "));
		if (v("title")) parts.push(t("titleWords") + " " + v("title"));
		let from = v("yearFrom"), to = v("yearTo");
		if (from || to) parts.push(from && to ? from + "–" + to : from ? from + "–" : "–" + to);
		let sorts = { citations: "sortCitations", date: "sortDate" }, sortKey = sorts[v("sort")];
		if (engineValue() !== "pop" && sortKey) parts.push(t(sortKey));
		return parts.join(" · ") || t("condNone");
	}
	function syncQueryCollapse() {
		let form = $("query-form"), field = $("cond-field");
		if (!form || !field) return;
		let has = searchSurface === "papers" && state.records.length > 0;
		field.hidden = !has;
		let folded = has && !state.condOpen;
		form.classList.toggle("collapsed", folded);
		$("cond-toggle").setAttribute("aria-expanded", String(!folded));
		$("cond-summary").textContent = folded ? conditionSummary() : "";
		// Folded, the toggle is the summary bar; open, it is a quiet "fold" at the end of the form.
		let label = form.querySelector(".cond-label"); if (label) label.textContent = t(folded ? "condLabel" : "condFold");
		// Open, the fold button belongs to the action group (at its end, in line with the others); folded, it is the bar after the keywords.
		try {
			let group = form.querySelector(".field.buttons > .row"), keywords = form.querySelector(".field.keep");
			if (group && keywords && typeof group.appendChild === "function") {
				if (folded || !has) { if (field.parentNode !== form) form.insertBefore(field, keywords.nextSibling); }
				else if (field.parentNode !== group) group.appendChild(field);
			}
		} catch (e) { log("fold button not moved: " + e.message); }
	}

	/* What one draw works out for many rows at once, kept for that draw only (nothing a row shows changes
	   inside it): each paper's citation figures and each journal's identity, asked for by the row's
	   signature, its cells, the sort and the metrics. A streamed 1,200-row search drew every row's figures
	   three times a frame. */
	let drawMemo = null;
	function journalOf(r) {
		if (!drawMemo) return ZotPoPJournalMarks.identify(r.venue, r.publisher);
		let key = r.venue + "\u0001" + (r.publisher || "");
		if (!drawMemo.journals.has(key)) drawMemo.journals.set(key, ZotPoPJournalMarks.identify(r.venue, r.publisher));
		return drawMemo.journals.get(key);
	}
	function render() {
		let outer = drawMemo == null;
		if (outer) drawMemo = { figures: new WeakMap(), journals: new Map() };
		try { drawList(); }
		finally { if (outer) drawMemo = null; }
	}
	function drawList() {
		if (streamTimer != null) { cancelLater(streamTimer); streamTimer = null; }
		syncQueryCollapse();
		if (state.selectedOnly && !state.records.some(r => state.selected.has(r.key))) state.selectedOnly = false;
		let spec = filterSpec();
		// The library counts follow every other filter, but not the library filter itself.
		let base = state.records.filter(r => matchesFilter(r, spec, false, true));
		let owned = base.filter(r => r.inLibrary).length;
		state.libCounts = { all: base.length, new: base.length - owned, owned };
		let list = state.selectedOnly ? base : base.filter(libraryPass);
		let k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
		list.sort((a, b) => {
			let va = sortValue(a, k), vb = sortValue(b, k);
			// A paper with no year, journal or figure is not the oldest or the smallest: it goes last either way.
			let ua = sortUnknown(va, k), ub = sortUnknown(vb, k);
			if (ua !== ub) return ua ? 1 : -1;
			if (va < vb) return -dir;
			if (va > vb) return dir;
			return a.popOriginal && b.popOriginal ? a.popOrdinal - b.popOrdinal : a.rank - b.rank;
		});
		state.visible = list;

		for (let th of document.querySelectorAll("#results-table th[data-sort]")) {
			let on = th.dataset.sort === k;
			th.classList.toggle("sorted-asc", on && state.sortDir === "asc");
			th.classList.toggle("sorted-desc", on && state.sortDir === "desc");
			if (on) th.setAttribute("aria-sort", state.sortDir === "asc" ? "ascending" : "descending"); else th.removeAttribute("aria-sort");
			// The arrow is a node after the header's own text, so it stays beside that text.
			let mark = th.querySelector(".sort-mark");
			if (!mark) {
				mark = document.createElement("span");
				mark.className = "sort-mark";
				mark.setAttribute("aria-hidden", "true");
				let grip = th.querySelector(".rz");
				if (grip) th.insertBefore(mark, grip); else th.appendChild(mark);
			}
			// Drawn by search.css as a small chevron from the header's own class; no glyph to mismatch the text.
				mark.textContent = "";
		}

		let tbody = $("results-body");
		ensureRowDelegation(tbody);
		syncRows(tbody, list);
		syncActiveRow();
		// Rows are two lines tall when any of them carries an affiliation line, one line otherwise,
		// so the rhythm of the list is the same from the first row to the last.
		if (list.some(r => state.affLine && affLineNeeded(affLineParts(r), affiliationOf(r)))) $("results-table").setAttribute("data-aff", ""); else $("results-table").removeAttribute("data-aff");
		applyColumnView();
		syncFacetChip(); syncPersonChip();
		syncFilterUI();
		if (!marquee) marquee = ZotPoPMarquee.attach(window, $("table-wrap"), { mode: "hover" });
		else marquee.refresh();

		$("empty").hidden = list.length > 0 || !$("busy").hidden;
		// "Enter a query above" after a search that ran and found nothing reads as though
		// nothing happened, which is exactly when a user needs to know a source failed.
		// Profiles found but no papers loaded yet: the next step is choosing one, not "found nothing".
		let profilesOnly = searchSurface === "authors" && !state.records.length && authorSessions[activeAuthorProvider].profiles.length > 0;
		if (state.records.length) { if (!list.length) paintEmptyFiltered($("empty")); else if ($("empty").firstChild) $("empty").textContent = ""; }
		else $("empty").textContent = profilesOnly ? t("emptyAuthorProfiles")
			: state.searched ? t(state.lastPartial ? "emptyAfterPartial" : "emptyAfterSearch")
			: t(searchSurface === "authors" ? "emptyInitialAuthors" : "emptyInitial");
		updateCounts();
		syncRelatedBtn();
		renderMetrics(list);
		renderDetail();
	}

	/* ---- the rows of the list
	   A row is built once per result and kept: a filter, a sort or a streaming update only reorders,
	   adds and removes rows, and a row is rebuilt only when what it shows has changed (its signature).
	   Clicks are handled once on the table body, not on every row. */
	const rowCache = new Map();
	let rowCacheScope = "", rowRecords = new Map(), delegatedBody = null;
	const rowStats = { built: 0, reused: 0 };
	const objectIds = new WeakMap();
	let objectCount = 0;
	const objectId = o => (o && typeof o === "object" ? (objectIds.get(o) || (objectIds.set(o, ++objectCount), objectCount)) : 0);
	function rowSignature(r) {
		let where = affiliationOf(r), row = affColumnRow(where), mark = citeMarkOf(r);
		let identity = typeof ZotPoPJournalMarks === "undefined" || !r.venue ? null : journalOf(r);
		// The rank is not here: it moves on every streamed page, and its one cell is rewritten in place (paintRowState).
		return JSON.stringify([r.citations, r.citationSource, r.popOriginal, r.popRank, r.authorString, r.title, r.titleMarkup,
			r.year, r.venue, r.publisher, r.journalIF, r.journalIFSource, r.journalOA2y, r.journalH, r.journalAbbrev, identity?.mark, identity?.known,
			r.doi, hasPDF(r), r.inLibrary, r.readState, r.isNew, r.retracted, r.status, r.statusClass, r.statusTitle,
			r.source, r.sources, r.pdfUrl, r.pdfUrls, r.pmcid, r.arxiv,
			// By value, never by the summary object: a new summary of unchanged data must not rebuild the row.
			where && [where.first, where.corresponding].map(p => p && [p.name, p.institution, p.country, p.hIndex, p.tier]), where?.correspondingKnown,
			row?.institution, row?.tier, row?.hIndex, row?.flag, where?.countries, affLineParts(r).map(p => [p.role, p.institution, p.country, p.hIndex]),
			mark?.text, mark?.direction, citeFindable(r), Boolean(citeTrend(r)),
			// The numbers, never the object: reading `top` would work out every row's explanation.
			r.related && [r.related.score, r.related.c1, r.related.c2, r.related.c3, r.related.c3w, r.related.held, r.related.unrankable, r.related.lowConf]]);
	}
	// The parts of a row that follow the selection, not the paper: set on every draw, reused row or not.
	/* The row's id, which the table points at as the active row (aria-activedescendant), so a screen reader
	   says the paper the arrows reached; any character a key may hold is spelled out, so two keys never share one. */
	const rowDomId = key => "row-" + String(key).replace(/[^\w-]/g, c => "_" + c.charCodeAt(0).toString(16));
	// Where the keyboard is in the list, for assistive technology: the focused row, read as the active one.
	function syncActiveRow() {
		let wrap = $("table-wrap"); if (!wrap) return;
		let on = state.focusKey != null && state.visible.some(r => r.key === state.focusKey);
		if (on) wrap.setAttribute("aria-activedescendant", rowDomId(state.focusKey)); else wrap.removeAttribute("aria-activedescendant");
	}
	const rankCells = new WeakMap();
	function paintRowState(tr, r, pick) {
		let rank = rankCells.get(tr);
		if (rank && !r.popOriginal && rank.textContent !== String(r.rank)) rank.textContent = String(r.rank);
		tr.classList.toggle("in-library", Boolean(r.inLibrary));
		tr.classList.toggle("selected", state.selected.has(r.key));
		tr.setAttribute("aria-selected", String(state.selected.has(r.key)));
		tr.classList.toggle("not-person", Boolean(pick && !inPick(pick, r)));
		tr.classList.toggle("focused", state.focusKey === r.key);
		let cb = tr.querySelector("input[type=checkbox]");
		if (cb) cb.checked = state.selected.has(r.key);
	}
	function syncRows(tbody, list) {
		// What every row depends on besides its own paper: a change drops all of them.
		let scope = [state.affLine, state.colOrder.join(","), uiLocale].join("|");
		if (scope !== rowCacheScope) { rowCache.clear(); rowCacheScope = scope; }
		let pick = personPick();
		rowRecords = new Map();
		let rows = [];
		for (let r of list) {
			rowRecords.set(r.key, r);
			let sig = rowSignature(r), held = rowCache.get(r.key), tr;
			if (held && held.sig === sig) { tr = held.tr; rowStats.reused++; paintRowState(tr, r, pick); }
			else { tr = buildRow(r); rowStats.built++; rowCache.set(r.key, { tr, sig }); }
			rows.push(tr);
		}
		// Settle the rows into place with the fewest moves: a row already in position stays.
		let cursor = tbody.firstChild;
		for (let tr of rows) {
			if (tr === cursor) cursor = cursor.nextSibling;
			else tbody.insertBefore(tr, cursor);
		}
		while (cursor) { let next = cursor.nextSibling; tbody.removeChild ? tbody.removeChild(cursor) : cursor.remove(); cursor = next; }
		// Rows of results that are no longer in the search are let go; filtered-out ones are kept. While a search
		// streams, a paper drops out of one page's top N and comes back in the next: its row waits (up to three
		// times the list) instead of being built again.
		if (rowCache.size > (state.searching ? 3 : 1) * state.records.length) {
			let live = new Set(state.records.map(r => r.key));
			for (let key of [...rowCache.keys()]) if (!live.has(key)) rowCache.delete(key);
		}
	}
	function rowRecord(el) {
		let key = el?.closest?.("tr")?.dataset?.key;
		return key ? rowRecords.get(key) || state.records.find(r => r.key === key) || null : null;
	}
	function ensureRowDelegation(tbody) {
		if (!tbody || delegatedBody === tbody) return;
		delegatedBody = tbody;
		tbody.addEventListener("change", e => {
			let r = rowRecord(e.target);
			if (r && e.target.closest?.("input")) toggleSelect(r, e.target.checked);
		});
		tbody.addEventListener("click", e => {
			let r = rowRecord(e.target); if (!r) return;
			let link = e.target.closest("a.doi-link");
			if (link) { e.preventDefault(); e.stopPropagation(); Zotero.launchURL("https://doi.org/" + encodeURI(r.doi)); return; }
			let cell = e.target.closest("td"), kind = cell?.dataset?.k;
			if (cell && cell.getAttribute("role") === "button" && !e.target.closest("input")) {
				if (kind === "pdf") { e.stopPropagation(); state.focusKey = r.key; state.detailKey = r.key; paintRows(); renderDetail(); openPreview(r); return; }
				if (kind === "inLibrary") { e.stopPropagation(); showInLibrary(r); return; }
				if (kind === "citations" && cell.dataset.cite) { e.stopPropagation(); state.focusKey = r.key; state.detailKey = r.key; paintRows(); renderDetail(); openCitePop(r, cell); return; }
			}
			if (e.target.closest("input, a, [role=button]")) return;
			state.focusKey = r.key;
			state.detailKey = r.key;
			if (e.metaKey || e.ctrlKey) toggleSelect(r, !state.selected.has(r.key));
			else { paintRows(); renderDetail(); }
		});
		tbody.addEventListener("dblclick", e => {
			let r = rowRecord(e.target); if (!r) return;
			if (e.target.closest("input, a, [role=button]")) return;
			readRecord(r);
		});
		tbody.addEventListener("contextmenu", e => {
			let r = rowRecord(e.target); if (!r) return;
			e.preventDefault();
			state.focusKey = r.key;
			state.detailKey = r.key;
			paintRows();
			renderDetail();
			showCtxMenu(e.clientX, e.clientY, r);
		});
	}

	// Every filter that is narrowing the list now, in words: what the empty list names, so the reader sees what to undo.
	function activeFilterParts() {
		let parts = [], text = String($("filter")?.value || "").trim();
		if (text) parts.push(t("emptyFilterText", text));
		if (state.facet) parts.push(t("emptyFilterAuthor", state.facet.name));
		if (state.yearRange) parts.push(t("emptyFilterYears", state.yearRange.from, state.yearRange.to));
		for (let rule of activeRules()) parts.push(ruleText(rule));
		if (state.libraryFilter !== "all") parts.push(t("emptyFilterLibrary", t(state.libraryFilter === "owned" ? "libOwned" : "libNew")));
		return parts;
	}
	// The list is empty although the search found papers: say which filters hide them and offer one way back.
	function paintEmptyFiltered(box) {
		box.textContent = "";
		let parts = activeFilterParts();
		let msg = document.createElement("div"); msg.className = "empty-msg";
		msg.textContent = t("emptyFiltered");
		box.appendChild(msg);
		if (parts.length) {
			let list = document.createElement("div"); list.className = "empty-filters";
			list.textContent = parts.join(" \u00b7 ");
			box.appendChild(list);
		}
		let reset = document.createElement("button");
		reset.type = "button"; reset.className = "empty-reset"; reset.textContent = t("emptyResetFilters");
		reset.addEventListener("click", () => clearAllFilters());
		box.appendChild(reset);
	}

	const NIL_COLUMNS = new Set(["year", "citations", "cpy", "journalIF", "journalOA2y", "venue", "authorString"]);
	function buildRow(r) {
		let tr = document.createElement("tr");
		tr.dataset.key = r.key;
		tr.id = rowDomId(r.key);
		tr.setAttribute("aria-selected", String(state.selected.has(r.key)));
		if (r.inLibrary) tr.classList.add("in-library");
		if (state.selected.has(r.key)) tr.classList.add("selected");
		{ let pick = personPick(); if (pick && !inPick(pick, r)) tr.classList.add("not-person"); }
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
			if (title) tip(c, title);
			tr.appendChild(c);
			return c;
		};

		let c0 = td("chk", "chk");
		let cb = document.createElement("input");
		cb.type = "checkbox"; cb.tabIndex = -1;
		cb.setAttribute("aria-label", t("rowTick"));
		cb.checked = state.selected.has(r.key);
		c0.appendChild(cb);

		decorateCiteCell(td("citations", "num", r.citations == null ? "–" : String(r.citations), r.citationSource ? t("citeSource", sourceLabel(r.citationSource)) : ""), r);
		td("cpy", "num", fmt(ZotPoPMetrics.citesPerYear(r), 1));
		rankCells.set(tr, td("rank", "num", r.popOriginal ? (r.popRank == null ? "–" : String(r.popRank)) : String(r.rank)));
		{ let ac = td("authorString", "", r.authorString); ac.dataset.marquee = "authors"; ac.dataset.tipKind = "authors"; }

		let tt = td("title", "title", null); tt.dataset.tipKind = "title";
		// Plain text: the title is the widest cell, and a click on "the row" used
		// to leave Zotero for the browser. Double-click, Enter or the menu do that.
		// The title and the affiliation line each roll on their own when they overflow.
		let main = document.createElement("div");
		main.className = "t-main";
		main.dataset.marquee = "title";
		let a = document.createElement("span");
		if (r.titleMarkup) rich(a, r.titleMarkup); else a.textContent = r.title;
		main.appendChild(a);
		// A small lime mark ahead of the title (so a narrow cell never clips it): this row was not in the previous run of this search.
		if (r.isNew) { let mark = document.createElement("span"); mark.className = "new-mark"; mark.textContent = t("newMark"); tip(mark, t("newMarkTip")); main.insertBefore(mark, a); }
		if (r.related) { let chip = relatedChip(r.related); if (chip) main.insertBefore(chip, a); }
		if (r.retracted) { let mark = document.createElement("span"); mark.className = "retract-mark"; mark.textContent = t("retractedChip"); tip(mark, t("retractedTip")); main.insertBefore(mark, main.firstChild); }
		tt.appendChild(main);
		paintRowDot(main, r);
		let affParts = state.affLine ? affLineParts(r) : [];
		if (affLineNeeded(affParts, affiliationOf(r))) {
			let line = affLineNode(affParts, affiliationOf(r));
			line.dataset.marquee = "aff";
			tt.appendChild(line);
		}

		td("year", "num", r.year == null ? "" : String(r.year));
		let venueCell = td("venue", "venue", r.venue); venueCell.dataset.tipKind = "journal";
		venueCell.dataset.marquee = "venue";
		paintVenue(venueCell, r);
		td("journalIF", "num if", r.journalIF == null ? "" : fmt(r.journalIF, 1),
			r.journalIF == null ? "" : t("jifTip", fmt(r.journalIF, 1), r.journalIFSource, r.journalH, r.journalIFAs));
		td("journalOA2y", "num if oa", r.journalOA2y == null ? "" : fmt(r.journalOA2y, 1),
			r.journalOA2y == null ? "" : t("oaTip", fmt(r.journalOA2y, 1), r.journalH));
		let where = affiliationOf(r);
		{ let ac = td("affiliation", "aff", null, ""); ac.dataset.tipKind = "aff"; ac.dataset.tipAlign = "start"; buildAffCell(ac, r); }
		td("country", "mini country", where ? where.countries.map(c => (ZotPoPAffiliations.flag(c) + " " + c).trim()).join(" ") : "", affiliationTip(where));
		let tierCell = td("tier", "mini tiercell", null, "");
		let chip = tierChip(where);
		if (chip) tierCell.appendChild(chip);
		let doiCell = td("doi", "doi", null, r.doi ? t("thDoiTip") : ""); doiCell.dataset.marquee = "doi";
		if (r.doi) { let link = document.createElement("a"); link.href = "#"; link.tabIndex = -1; link.textContent = r.doi; link.className = "doi-link"; doiCell.appendChild(link); }
		let pdfCell = td("pdf", "mini pdf", hasPDF(r) ? "●" : "", hasPDF(r) ? t("thPdfClickTip") : "");
		if (hasPDF(r)) pdfCell.setAttribute("role", "button");
		let readLabel = r.inLibrary && r.readState ? { done: t("readDone"), reading: t("readReading"), unread: t("readUnread") }[r.readState] : "";
		let libCell = td("inLibrary", "mini lib", "", r.inLibrary ? t("thLibClickTip") : "");
		if (r.inLibrary) { let ck = document.createElement("span"); ck.className = "pill pos"; ck.textContent = "✓"; libCell.appendChild(ck); }
		if (readLabel) { let rs = document.createElement("span"); rs.className = "read-state"; rs.textContent = readLabel; tip(rs, t("readStateTip")); libCell.appendChild(rs); }
		if (r.inLibrary) libCell.setAttribute("role", "button");
		let st = td("status", "status", r.status || "", r.statusTitle || "");
		st.dataset.marquee = "status";
		if (r.statusClass) st.classList.add(r.statusClass);
		// One muted dash for "no value" in every data column (the PDF and library columns are marks, and stay empty).
		for (let c of tr.children) if (NIL_COLUMNS.has(c.dataset.k) && (!c.textContent.trim() || c.textContent.trim() === "–")) { c.textContent = "–"; c.classList.add("nil"); }
		orderColumnCells(tr);

		return tr;
	}

	// Repaint row classes without rebuilding the table
	function paintRows() {
		for (let tr of document.querySelectorAll("#results-body tr")) {
			let key = tr.dataset.key;
			tr.classList.toggle("selected", state.selected.has(key));
			tr.setAttribute?.("aria-selected", String(state.selected.has(key)));
			tr.classList.toggle("focused", state.focusKey === key);
			let cb = tr.querySelector("input[type=checkbox]");
			if (cb) cb.checked = state.selected.has(key);
		}
		syncActiveRow();
		updateCounts();
	}

	function toggleSelect(r, on) {
		if (on) state.selected.add(r.key); else state.selected.delete(r.key);
		paintRows();
	}

	// The footer has one layout in both states: where to add, the options as one line (opened by hand
	// into a row of its own) and, at the right, the count and the add button. Choosing rows changes
	// the numbers and the button, never the shape.
	function syncImportBar() {
		let toggle = $("import-opts-toggle"), box = $("import-opts"); if (!toggle || !box) return;
		let open = Boolean(state.optsOpen);
		$("opt-queue-wrap").hidden = !queueApi();
		box.hidden = !open;
		toggle.hidden = false;
		toggle.setAttribute("aria-expanded", String(open));
		let parts = [["opt-pdf", "optPdfShort"], ["opt-skip", "optSkipShort"], ["opt-fillpdf", "optFillPdfShort"], ["opt-extra", "optExtraShort"], ["opt-trnote", "optTrNoteShort"], ["opt-queue", "optQueueShort"]].filter(([id]) => $(id).checked && (id !== "opt-queue" || queueApi())).map(([, key]) => t(key));
		toggle.textContent = open ? t("optsHide") : t("optsSummary", parts.length ? parts : [t("optsSummaryNone")]);
	}

	function updateCounts() {
		let n = state.records.filter(r => state.selected.has(r.key)).length;
		if (state.selectedOnly && n === 0) { state.selectedOnly = false; render(); return; }
		// Selection outlives the filter, so say how much of it is out of sight.
		let onScreen = state.visible.filter(r => state.selected.has(r.key)).length;
		$("selected-count").textContent = n > onScreen ? t("selectedSplit", n, onScreen, n - onScreen) : t("selected", n);
		let only = $("selected-only");
		if (only) { only.hidden = n === 0; only.textContent = t("selectedOnly"); only.setAttribute("aria-pressed", String(state.selectedOnly)); }
		let importLabel = $("import-btn").querySelector("span"); if (importLabel) importLabel.textContent = n ? t("importBtnN", n) : t("importBtn");
		$("import-btn").disabled = n === 0 || state.importing || state.searching;
		syncImportBar(n);
		let all = state.visible.length > 0 && state.visible.every(r => state.selected.has(r.key));
		let some = state.visible.some(r => state.selected.has(r.key));
		$("chk-all").checked = all;
		$("chk-all").indeterminate = some && !all;
		for (let [id, key, label] of [["lib-all", "all", "libAll"], ["lib-new", "new", "libNew"], ["lib-owned", "owned", "libOwned"]]) {
			let b = $(id);
			if (!b.querySelector(".lib-name")) {
				b.textContent = "";
				for (let cls of ["lib-name", "lib-n"]) { let span = document.createElement("span"); span.className = cls; if (cls === "lib-n") b.appendChild(document.createTextNode(" ")); b.appendChild(span); }
			}
			b.querySelector(".lib-name").textContent = t(label);
			b.querySelector(".lib-n").textContent = String(state.libCounts[key]);
			b.setAttribute("aria-pressed", String(state.libraryFilter === key));
		}
		$("preview-btn").disabled = !previewRecord();
		// Nothing to clear, filter, export or view while there are no rows: shown, but inert.
		$("select-none").disabled = n === 0;
		let noRows = state.records.length === 0;
		for (let id of ["export-btn", "view-btn", "lib-all", "lib-new", "lib-owned"]) { let b = $(id); if (b) b.disabled = noRows; }
	}

	function selectVisible(on) {
		for (let r of state.visible) { if (on) state.selected.add(r.key); else state.selected.delete(r.key); }
		paintRows();
	}

	const BASIS_ORDER = ["openalex", "crossref", "europepmc", "pubmed", "semanticscholar", "scholar", "arxiv"];
	function drawMetricsBasis(sources) {
		let table = $("metrics-table"), box = $("metrics-basis");
		if (!box && table?.parentNode) { box = document.createElement("div"); box.id = "metrics-basis"; box.className = "metrics-basis"; box.setAttribute("role", "group"); box.setAttribute("aria-label", t("metricsBasisLabel")); table.parentNode.insertBefore(box, table); }
		if (!box) return;
		box.textContent = "";
		box.hidden = sources.length < 2;
		if (box.hidden) return;
		// always in one order, whatever order the records happened to bring the sources in
		let rank = k => { let i = BASIS_ORDER.indexOf(k); return i < 0 ? BASIS_ORDER.length : i; };
		let keys = [null, ...[...sources].sort((a, b) => rank(a) - rank(b))];
		box.setAttribute("data-n", String(keys.length));
		for (let key of keys) {
			let b = document.createElement("button");
			b.type = "button";
			// An odd count lets the first choice span the tray, so no cell sits alone in a row.
			if (keys.length % 2 && key === null) b.className = "wide";
			// The chip names the index; the qualifier in parentheses is in its tooltip.
			let full = key ? (ZotPoPSources.SOURCES?.[key]?.label || key) : t("metricsBasisMax");
			// "Highest per paper" did not fit its half of the tray; the chip says "Highest", the tooltip the rest.
			b.textContent = key ? String(full).replace(/\s*[(（][^)）]*[)）]\s*$/, "") : t("metricsBasisMaxShort");
			tip(b, full);
			b.setAttribute("aria-pressed", String((state.metricsBasis || null) === key));
			b.addEventListener("click", () => {
				state.metricsBasis = key; state.metricsBasisUser = true; renderMetrics(state.visible || state.records || []);
				// The buttons are drawn again; the keyboard stays on the one just pressed.
				$("metrics-basis")?.querySelector?.('[aria-pressed="true"]')?.focus?.();
			});
			box.appendChild(b);
		}
	}
	function drawMetricsNotes(notes) {
		let box = $("metrics-notes"); if (!box) return;
		box.textContent = "";
		state.metricsNotesOpen ||= new Set();
		for (let n of notes) {
			let open = state.metricsNotesOpen.has(n.key);
			let row = document.createElement("div"); row.className = "metrics-note";
			let line = document.createElement("div"); line.className = "metrics-note-line";
			let short = document.createElement("span"); short.textContent = n.short;
			let b = document.createElement("button"); b.type = "button"; b.className = "ghost note-help"; b.appendChild(iconNode("ic-help"));
			b.setAttribute("aria-expanded", String(open)); b.setAttribute("aria-label", t("metricsMore")); tip(b, t("metricsMore"));
			let full = document.createElement("p"); full.className = "metrics-note-full"; full.textContent = n.full; full.hidden = !open;
			b.addEventListener("click", () => {
				let now = b.getAttribute("aria-expanded") !== "true";
				b.setAttribute("aria-expanded", String(now)); full.hidden = !now;
				if (now) state.metricsNotesOpen.add(n.key); else state.metricsNotesOpen.delete(n.key);
			});
			line.appendChild(short); line.appendChild(b); row.appendChild(line); row.appendChild(full); box.appendChild(row);
		}
	}
	// Results per year as small grey bars. Drawn from every result the other filters let
	// through, so choosing years does not flatten the picture; the chosen range stays dark.
	// A long span would be a row of specks, so it is grouped into 2, 5, 10, ... year bins
	// that start on round years (1970-74, 1975-79) and number at most YEAR_BARS_MAX.
	const YEAR_BARS_MAX = 24;
	function yearBins(first, last) {
		let size = [1, 2, 5, 10, 20, 50, 100].find(s => Math.floor(last / s) - Math.floor(first / s) + 1 <= YEAR_BARS_MAX) || 100;
		let bins = [];
		for (let start = Math.floor(first / size) * size; start <= last; start += size) {
			// Clamped to the years that exist, so a tip never names 2027-2029 for a paper from 2026.
			bins.push({ from: Math.max(start, first), to: Math.min(start + size - 1, last), size });
		}
		return bins;
	}
	function drawYearHistogram() {
		let box = $("metrics-years"); if (!box) return;
		box.textContent = "";
		let spec = filterSpec(), counts = new Map();
		let pick = searchSurface === "authors" ? personPick() : null;
		for (let r of state.records) if (Number.isInteger(r.year) && matchesFilter(r, spec, true) && (!pick || inPick(pick, r))) counts.set(r.year, (counts.get(r.year) || 0) + 1);
		let years = [...counts.keys()];
		box.hidden = years.length < 2 && !state.yearRange;
		if (box.hidden) return;
		let last = Math.max(...years), first = Math.min(...years);
		let bins = yearBins(first, last);
		for (let bin of bins) { bin.n = 0; for (let y = bin.from; y <= bin.to; y++) bin.n += counts.get(y) || 0; }
		let peak = Math.max(...bins.map(bin => bin.n), 1);
		box.appendChild(fel("div", "tr-title", t("yearsTitle")));
		let bars = document.createElement("div"); bars.className = "yr-bars" + (state.yearRange ? " ranged" : ""); bars.setAttribute("role", "group"); bars.setAttribute("aria-label", t("yearHistogram"));
		if (bins.length > 12) bars.setAttribute("data-dense", "");
		let covers = bin => Boolean(state.yearRange) && bin.to >= state.yearRange.from && bin.from <= state.yearRange.to;
		let choose = (a, b) => { state.yearRange = { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) }; state.focusKey = null; render(); };
		for (let bin of bins) {
			let b = document.createElement("button");
			b.type = "button"; b.className = "yr-bar" + (bin.n ? "" : " zero");
			b.classList.toggle("on", !state.yearRange || covers(bin));
			tip(b, bin.from === bin.to ? t("yearBarTip", bin.from, bin.n) : t("yearBinTip", bin.from, bin.to, bin.n));
			b.setAttribute("aria-label", b.title);
			b.setAttribute("aria-pressed", String(covers(bin)));
			let fill = document.createElement("span"); fill.style.height = (bin.n ? Math.max(6, Math.round(100 * bin.n / peak)) : 0) + "%"; b.appendChild(fill);
			// Pressing starts a range and passing over other bars with the button held extends it.
			b.addEventListener("mousedown", e => { if (e.button) return; state.yearAnchor = bin; choose(bin, bin); });
			b.addEventListener("mouseenter", e => { if (state.yearAnchor != null && e.buttons) choose(state.yearAnchor, bin); });
			b.addEventListener("click", e => { if (!e.detail) choose(bin, bin); });
			bars.appendChild(b);
		}
		if (!state.yearUpBound) { state.yearUpBound = true; document.addEventListener("mouseup", () => { state.yearAnchor = null; }); }
		box.appendChild(bars);
		let ends = document.createElement("div"); ends.className = "yr-ends";
		let lo = document.createElement("span"), hi = document.createElement("span");
		lo.textContent = String(first); hi.textContent = String(last);
		ends.appendChild(lo); ends.appendChild(hi);
		if (state.yearRange) {
			let clear = document.createElement("button"); clear.type = "button"; clear.className = "ghost yr-clear";
			let { from, to } = state.yearRange;
			clear.textContent = t("yearClear", from === to ? String(from) : from + "–" + to); tip(clear, t("yearClearTip"));
			clear.addEventListener("click", () => { state.yearRange = null; state.focusKey = null; render(); });
			ends.insertBefore(clear, hi);
		}
		box.appendChild(ends);
	}
	// ------------------------------------------------------------ whose papers these are
	/* A name search lists every paper under that name, namesakes included, so the figures beside it belong to no
	   one until a person is picked: the papers are clustered locally (ZotPoPAuthors.clusterPeople) and the reader
	   chooses the cluster, or several when one person splits. The choice is a set of record keys kept in the
	   author session and with the recent search; papers can be moved in or out by hand afterwards. */
	const recKey = r => ZotPoPHistory.recordKey(r);
	function validPick(p) {
		if (!p || typeof p !== "object" || !Array.isArray(p.keys)) return null;
		return { name: String(p.name || ""), extra: Number.isInteger(p.extra) && p.extra > 0 ? p.extra : 0, keys: [...new Set(p.keys.filter(k => typeof k === "string"))], others: p.others === true };
	}
	function unverifiedAuthorResults() {
		if (searchSurface !== "authors" || !state.records.length) return false;
		let session = authorSessions[activeAuthorProvider], profile = state.records[0]?.authorProfile || session.profile;
		// A name search is unconfirmed whatever its rows carry (streamed or stopped rows may carry nothing).
		return session.action === "name-papers" || profile?.mode === "name-search" || profile?.identityConfirmed === false;
	}
	const pickSets = new WeakMap();
	function personPick() { return unverifiedAuthorResults() ? authorSessions[activeAuthorProvider].pick || null : null; }
	function inPick(pick, r) {
		let set = pickSets.get(pick); if (!set) pickSets.set(pick, set = new Set(pick.keys));
		return set.has(recKey(r));
	}
	function personPass(r) { let pick = personPick(); return !pick || pick.others || inPick(pick, r); }
	let peopleMemo = { records: null, typed: null, result: null };
	function peopleClusters() {
		let typed = $("author-input").value;
		if (peopleMemo.records !== state.records || peopleMemo.typed !== typed) peopleMemo = { records: state.records, typed, result: typeof ZotPoPAuthors === "undefined" ? { clusters: [], rest: null } : ZotPoPAuthors.clusterPeople(state.records, typed, recKey) };
		return peopleMemo.result;
	}
	function persistPick() {
		saveAuthorPreferences();
		let session = authorSessions[activeAuthorProvider];
		if (!history || !state.records.length || state.searching) return;
		let q = authorQuery(session.action, session.profile);
		Promise.resolve(history.save({ source: "author:" + q.authorProvider, query: { ...q, authorProfile: session.profile, authorProfiles: session.profiles, authorPick: session.pick },
			records: stripDisplayFields(state.records), partial: Boolean(state.lastPartial) })).catch(e => log("saving the chosen person failed: " + e.message));
	}
	function setPick(pick) {
		authorSessions[activeAuthorProvider].pick = pick ? validPick(pick) : null;
		state.pickSel = new Set(); state.focusKey = null;
		persistPick(); render();
	}
	function setPersonMembership(r, on) {
		let pick = personPick(); if (!pick) return;
		let keys = new Set(pick.keys), key = recKey(r);
		if (on) keys.add(key); else keys.delete(key);
		setPick({ ...pick, keys: [...keys] });
	}
	function personLabel(pick) { return pick.extra ? t("personChipMore", pick.name, pick.extra) : pick.name; }
	function syncPersonChip() {
		let chip = $("person-chip"); if (!chip) return;
		let pick = personPick();
		chip.hidden = !pick;
		if (pick) { $("person-text").textContent = t("personChip", personLabel(pick), state.records.filter(r => inPick(pick, r)).length); }
	}
	// What the 인용 지표 card is the figures of.
	function metricsOwner() {
		if (searchSurface !== "authors") return null;
		let pick = personPick(); if (pick) return pick.name;
		let profile = state.records[0]?.authorProfile || authorSessions[activeAuthorProvider].profile;
		return profile?.identityConfirmed === true && profile.mode !== "name-search" && profile.name ? profile.name : null;
	}
	function drawPersonPicker(list) {
		let host = $("metrics-person"); if (!host) return;
		host.textContent = "";
		let pick = personPick(), picking = unverifiedAuthorResults() && !pick;
		host.hidden = !unverifiedAuthorResults();
		if (host.hidden) return;
		if (pick) {
			let inside = state.records.filter(r => inPick(pick, r)).length, outside = state.records.length - inside;
			host.appendChild(fel("div", "pp-note", t("personChosen", personLabel(pick), inside)));
			let row = fel("div", "pp-actions");
			let again = fel("button", "ghost", t("personChange")); again.type = "button"; again.addEventListener("click", () => setPick(null)); row.appendChild(again);
			if (outside || pick.others) {
				let others = fel("button", "ghost", pick.others ? t("personHideOthers") : t("personShowOthers", outside)); others.type = "button";
				others.setAttribute("aria-pressed", String(pick.others));
				others.addEventListener("click", () => setPick({ ...pick, others: !pick.others }));
				row.appendChild(others);
			}
			host.appendChild(row);
			return;
		}
		let { clusters, rest } = peopleClusters();
		state.pickSel ||= new Set();
		host.appendChild(fel("div", "pp-lead", t("personLead")));
		host.appendChild(fel("div", "pp-sub", t("personSub", state.records.length)));
		let all = rest ? [...clusters, rest] : clusters;
		let sel = state.pickSel;
		let confirm = fel("button", "primary pp-confirm");
		let sync = () => {
			let chosen = all.filter(c => sel.has(c.id)), n = chosen.reduce((sum, c) => sum + c.n, 0);
			confirm.disabled = !chosen.length; confirm.textContent = chosen.length ? t("personConfirm", n) : t("personConfirmNone");
			for (let b of host.querySelectorAll(".pp-card")) b.setAttribute("aria-pressed", String(sel.has(b.dataset.id)));
		};
		let cards = fel("div", "pp-cards");
		for (let c of all) {
			let b = document.createElement("button"); b.type = "button"; b.className = "pp-card"; b.dataset.id = c.id;
			b.appendChild(fel("span", "pp-name", c.rest ? t("personRest") : c.name));
			let years = c.minYear ? (c.minYear === c.maxYear ? String(c.minYear) : c.minYear + "–" + c.maxYear) : "";
			b.appendChild(fel("span", "pp-meta", [t("personPapers", c.n), years].filter(Boolean).join(" · ")));
			if (c.forms.length > (c.rest ? 0 : 1)) b.appendChild(fel("span", "pp-meta", t("personForms", c.forms.slice(0, 3).map(f => f.form).join(", "))));
			if (c.coauthors.length) b.appendChild(fel("span", "pp-meta", t("personCoauthors", c.coauthors.join(", "))));
			if (c.venue) b.appendChild(fel("span", "pp-meta", c.venue));
			b.addEventListener("click", () => { if (sel.has(c.id)) sel.delete(c.id); else sel.add(c.id); sync(); });
			cards.appendChild(b);
		}
		confirm.type = "button";
		host.appendChild(confirm);
		host.appendChild(cards);
		confirm.addEventListener("click", () => {
			let chosen = all.filter(c => sel.has(c.id)); if (!chosen.length) return;
			let named = chosen.filter(c => !c.rest);
			setPick({ name: (named[0] || chosen[0]).name || t("personRest"), extra: Math.max(0, chosen.length - 1), keys: chosen.flatMap(c => c.keys), others: false });
		});
		sync();
	}
	// The profile's own "Cited by" table, as Google Scholar prints it: all years and since a year.
	// An OpenAlex person gets the same table from OpenAlex's own author record: papers, citations, h-index.
	function drawScholarStats(stats, source = "scholar") {
		let box = $("metrics-scholar"); if (!box) return;
		box.textContent = "";
		box.hidden = !stats;
		if (!stats) return;
		box.appendChild(fel("div", "ms-title", t(source === "openalex" ? "openAlexStatsTitle" : "scholarStatsTitle")));
		let table = document.createElement("table"); table.className = "ms-table";
		let head = document.createElement("tr"); table.appendChild(head); head.appendChild(fel("th", null, ""));
		head.appendChild(fel("th", null, t("scholarStatsAll")));
		if (stats.since) head.appendChild(fel("th", null, t("scholarStatsSince", stats.sinceYear)));
		for (let [key, label] of [["works", t("mPapers")], ["citations", t("mCitations")], ["hIndex", "h-index"], ["i10", "i10-index"]]) {
			if (!Number.isFinite(stats[key])) continue;
			let tr = document.createElement("tr"); table.appendChild(tr); tr.appendChild(fel("td", null, label));
			tr.appendChild(fel("td", null, stats[key].toLocaleString(t.locale || undefined)));
			if (stats.since) tr.appendChild(fel("td", null, Number.isFinite(stats.since[key]) ? stats.since[key].toLocaleString(t.locale || undefined) : "–"));
		}
		box.appendChild(table);
	}
	// How the figures below were reached and why they may differ from the profile's own.
	function drawMetricsAccount(info) {
		let calc = $("metrics-calc"), why = $("metrics-explain");
		if (!calc || !why) return;
		calc.textContent = ""; why.textContent = "";
		calc.hidden = why.hidden = true;
		if (!info) return;
		calc.hidden = false;
		calc.textContent = t("metricsCalc", info.basisLabel, info.papers);
		let lines = [];
		if (Number.isFinite(info.total) && info.loaded < info.total) lines.push(t("metricsLoadedOf", info.total, info.loaded));
		else if (info.truncated) lines.push(t("metricsCappedOpen", info.loaded));
		for (let key of info.reasons) if (key !== "capped") lines.push(t("metricsWhy_" + key));
		if (info.matches) lines.push(t(info.source === "openalex" ? "metricsWhy_matchOpenAlex" : "metricsWhy_match"));
		if (!lines.length) return;
		why.hidden = false;
		for (let line of lines) why.appendChild(fel("p", "metrics-why", line));
		if (info.reasons.includes("capped") && info.profile && !state.searching && Number($("author-max-results").value) < 2000) {
			let more = fel("button", "ghost metrics-loadall", t("metricsLoadAll")); more.type = "button";
			more.addEventListener("click", () => { $("author-max-results").value = "2000"; runAuthorAction("publications", info.profile); });
			why.appendChild(more);
		}
	}
	function authorMetricsInfo(list, m, basis, sources) {
		let session = authorSessions[activeAuthorProvider], first = state.records[0];
		let profile = first?.authorProfile ? { ...(session.profile || {}), ...first.authorProfile } : session.profile;
		let verified = !unverifiedAuthorResults();
		let scholar = profile?.provider === "scholar" || (!profile && activeAuthorProvider === "scholar");
		// OpenAlex's own totals for the person, when the papers on screen are OpenAlex's records of them.
		let viaOpenAlex = !scholar && first?.authorProvenance?.via === "openalex" && profile?.mode !== "name-search"
			&& (Number.isFinite(profile?.citations) || Number.isFinite(profile?.hIndex));
		let source = scholar ? "scholar" : viaOpenAlex ? "openalex" : "other";
		let stats = !verified ? null : profile?.scholarStats ? profile.scholarStats
			: viaOpenAlex ? { works: Number.isFinite(profile.worksCount) ? profile.worksCount : null, citations: Number.isFinite(profile.citations) ? profile.citations : null, hIndex: Number.isFinite(profile.hIndex) ? profile.hIndex : null } : null;
		let pick = personPick();
		let pool = pick ? state.records.filter(r => inPick(pick, r)) : state.records;
		let total = verified && Number.isFinite(profile?.worksCount) ? profile.worksCount : null;
		let truncated = verified && first?.authorProvenance?.truncated === true;
		let reasons = ZotPoPAuthors.explainMetrics({ stats, computed: { citations: m.citations, hIndex: m.hIndex }, papers: m.papers, loaded: state.records.length, total, truncated,
			filtered: list.length < pool.length, unverified: !verified && !pick, basis, source });
		let same = key => !Number.isFinite(stats?.[key]) || stats[key] === m[key];
		let matches = Boolean(stats) && !reasons.length && same("citations") && same("hIndex");
		let basisLabel = basis ? (ZotPoPSources.SOURCES?.[basis]?.label || basis).replace(/\s*[(（][^)）]*[)）]\s*$/, "") : t("metricsBasisMax");
		return { basisLabel, papers: m.papers, loaded: state.records.length, total, truncated, reasons, matches, stats, source, profile: truncated || reasons.includes("capped") ? profile : null };
	}
	function renderMetrics(list) {
		// The graphs and the table describe the same papers: the picked person's, not the namesakes shown beside them.
		let pickedNow = searchSurface === "authors" ? personPick() : null;
		drawYearHistogram();
		drawMetricsTrend(pickedNow ? list.filter(r => inPick(pickedNow, r)) : list);
		let authors = searchSurface === "authors", owner = metricsOwner();
		let heading = $("metrics")?.querySelector("h3"); if (heading) heading.textContent = owner ? t("metricsOf", owner) : t("metricsTitle");
		drawPersonPicker(list); drawScholarStats(null); drawMetricsAccount(null);
		if (authors && unverifiedAuthorResults() && !personPick()) {
			$("metrics-hint").hidden = false; $("metrics-hint").textContent = t("personNeeded"); $("metrics-table").hidden = true; $("metrics-notes").textContent = ""; drawMetricsBasis([]);
			return;
		}
		if (authors && personPick()) list = list.filter(r => inPick(personPick(), r));
		if (searchSurface === "authors" && list.length && !list.some(record => record.citations != null && Number.isFinite(Number(record.citations)))) {
			$("metrics-hint").hidden = false; $("metrics-hint").textContent = t("authorNoCitationData", list.length); $("metrics-table").hidden = true; return;
		}
		if ($("metrics-hint")) $("metrics-hint").textContent = t("metricsHint");
		if ($("metrics-notes")) $("metrics-notes").textContent = "";
		let base = ZotPoPMetrics.compute(list);
		let sources = base.citationSources || [];
		/* Which index the statistics are read from: the highest per paper (a
		   reference figure across networks), or one index's own counts. Buttons,
		   not a <select>: a native popup draws broken over this glass panel. */
		if (!sources.includes(state.metricsBasis)) state.metricsBasis = null;
		// Scholar's own per-paper counts are the basis for Scholar results until the reader picks another.
		if (authors && !state.metricsBasisUser && typeof ZotPoPAuthors !== "undefined") state.metricsBasis = ZotPoPAuthors.defaultMetricsBasis(sources, { provider: state.records[0]?.authorProfile?.provider || activeAuthorProvider });
		let m = state.metricsBasis ? ZotPoPMetrics.compute(list, undefined, { provider: state.metricsBasis }) : base;
		drawMetricsBasis(sources);
		let set = (id, v) => { $(id).textContent = v; };
		let hint = $("metrics-hint"); if (hint) { hint.hidden = list.length > 0; $("metrics-table").hidden = !list.length; }
		// One line each, the full explanation behind a (?): the numbers stay at the top.
		let notes = [];
		if (list.length && m.unknownCitations) notes.push({ key: "unknown", short: t("metricsUnknownShort", m.unknownCitations, list.length), full: t("metricsUnknown", m.unknownCitations, list.length) });
		// Several indexes each counted citations; the highest was kept per paper, so the figures below mix networks.
		if (list.length && !state.metricsBasis && sources.length > 1) notes.push({ key: "mixed", short: t("metricsMixedShort"), full: t("metricsMixed", sources.map(key => ZotPoPSources.SOURCES?.[key]?.label || key).join(", ")) });
		// Per-author figures rest only on papers with a whole author list; say how many that is.
		if (list.length && m.perAuthorPapers < m.papers) {
			let note = m.perAuthorPapers ? t("metricsPerAuthorShare", m.perAuthorPapers, m.papers) : t("metricsPerAuthorNone", m.papers);
			notes.push({ key: "truncated", short: note, full: note + " " + t("metricsPerAuthorWhy", m.authorsTruncated, m.authorsUnknown) });
		}
		if (list.length) notes.push({ key: "scope", short: t("metricsScopeShort"), full: t("metricsScope") });
		drawMetricsNotes(notes);
		set("m-years", m.minYear ? `${m.minYear}–${m.maxYear}` : "–");
		set("m-cyears", m.minYear ? String(m.citationYears) : "–");
		set("m-papers", String(m.papers));
		set("m-citations", m.unknownCitations === m.papers && m.papers ? "–" : String(m.citations));
		set("m-cpy", fmt(m.citesPerYear));
		set("m-cpp", fmt(m.citesPerPaper));
		// A figure that cannot be computed is said so, never shown as 0.
		let perAuthor = v => v == null ? t("metricsNotComputable") : fmt(v);
		set("m-cpa", perAuthor(m.citesPerAuthor));
		set("m-ppa", perAuthor(m.papersPerAuthor));
		set("m-app", perAuthor(m.authorsPerPaper));
		set("m-h", m.hIndex == null ? "–" : String(m.hIndex));
		set("m-g", m.gIndex == null ? "–" : String(m.gIndex));
		set("m-hinorm", m.hiNorm == null ? t("metricsNotComputable") : String(m.hiNorm));
		set("m-hiannual", m.hiAnnual == null ? (m.hiNorm == null && m.papers ? t("metricsNotComputable") : "–") : fmt(m.hiAnnual));
		set("m-ha", m.hA == null ? "–" : String(m.hA));
		if (authors && list.length && typeof ZotPoPAuthors !== "undefined") {
			let info = authorMetricsInfo(list, m, state.metricsBasis, sources);
			drawScholarStats(info.stats, info.source); drawMetricsAccount(info);
		}
	}

	// ------------------------------------------------------------ citations over time
	// What OpenAlex counts per year, the last count seen (to say what was added since), and the card that tells it.
	const hasCite = () => typeof ZotPoPCite !== "undefined";
	// One index behind the whole card: the total, yearly mean, bars and increment are the yearly series' own (OpenAlex); other indexes are listed apart.
	const computeFigures = r => hasCite() && r ? ZotPoPCite.figures(r) : { source: r?.citationSource || null, total: r?.citations ?? null, perYear: ZotPoPMetrics.citesPerYear(r || {}), trend: null, others: [] };
	// Inside one draw a row's figures are asked for by its signature, its cells and the metrics: worked out once there.
	const citeFigures = r => {
		if (!drawMemo || !r || typeof r !== "object") return computeFigures(r);
		let held = drawMemo.figures.get(r);
		if (!held) drawMemo.figures.set(r, held = computeFigures(r));
		return held;
	};
	function citeTrend(r) { return citeFigures(r).trend; }
	// A paper can be asked about when OpenAlex can find it: by DOI, its own id or PMID.
	function citeFindable(r) {
		return Boolean(r && (r.doi || r.pmid || (r.source === "openalex" && /^W\d+$/.test(r.sourceId || ""))));
	}
	const citeShort = n => (n >= 10000 ? Math.round(n / 1000) + "k" : String(n));
	function citeDate(ms) {
		let d = new Date(ms), n = new Date();
		if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return t("citeToday");
		let two = v => String(v).padStart(2, "0");
		return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate());
	}
	const citeSnapshotKey = r => ZotPoPHistory.recordKey(r);
	// The count OpenAlex itself gave: the one a later look is comparable with.
	const openAlexCount = r => (r.citationsBy && r.citationsBy.openalex != null ? r.citationsBy.openalex : (r.citationSource === "openalex" ? r.citations : null));
	async function noteCitationSnapshots(records) {
		if (!snapshots) return;
		try {
			await snapshots.load();
			for (let r of records) { let c = openAlexCount(r), key = citeSnapshotKey(r); if (key && c != null && Number.isFinite(Number(c))) snapshots.observe(key, Number(c)); }
			snapshots.flush().catch(e => log("saving citation snapshots failed: " + e.message));
		}
		catch (e) { log("citation snapshots failed: " + e.message); }
	}
	// ▲ or ▼ and the figures behind it, for the table cell; null when there is no yearly data or no change.
	function citeMarkOf(r) {
		let tr = citeTrend(r);
		if (!tr || !tr.last || !tr.prev || (tr.direction !== "up" && tr.direction !== "down")) return null;
		let text = t(tr.direction === "up" ? "citeMarkUp" : "citeMarkDown", t("citeYearLine", tr.last.year, tr.last.n) + " / " + t("citeYearLine", tr.prev.year, tr.prev.n), tr.yoy);
		// The yearly series is OpenAlex's. Beside another index's count (Semantic Scholar's 150 next to a
		// falling OpenAlex 40 → 30) the arrow says whose years it read.
		let headline = r.citationSource || r.source;
		if (headline && headline !== "openalex") text += " · " + t("citeTrendOf", sourceLabel("openalex"));
		return { direction: tr.direction, glyph: tr.direction === "up" ? "▲" : "▼", text };
	}
	function decorateCiteCell(cell, r) {
		let mark = citeMarkOf(r), open = citeFindable(r) || Boolean(citeTrend(r));
		// Five digits fill the column: the mark is left out there and the tip says it.
		if (mark && String(r.citations).length < 5) {
			let m = document.createElement("span");
			m.className = "cite-mark " + mark.direction; m.textContent = mark.glyph; m.setAttribute("aria-hidden", "true");
			cell.appendChild(m);
		}
		if (!open) return;
		let base = r.citationSource ? t("citeSource", sourceLabel(r.citationSource)) : "";
		tip(cell, t("citeCellTip", base, mark ? mark.text : ""));
		cell.setAttribute("role", "button"); cell.setAttribute("aria-haspopup", "dialog"); cell.dataset.cite = "1";
	}

	/* Bars for a list of { year, n, partial }: the value above, the year below; compact ones (the side card)
	   carry both in a tip. The peak is the darkest, the year in progress the lightest. */
	function citeBars(years, max, compact) {
		let box = fel("div", "tr-bars" + (compact ? " compact" : ""));
		box.setAttribute("role", "img");
		// A year the series never covered (read before it began, or after it was saved) is unknown: a "?", not a zero bar.
		let line = y => y.n == null ? t("citeYearUnknown", y.year) : t("citeYearLine", y.year, y.n) + (y.short ? " (" + t("citeYearShort") + ")" : "");
		box.setAttribute("aria-label", years.map(line).join(", "));
		let top = Math.max(0, ...years.map(y => y.n || 0));
		for (let y of years) {
			let col = fel("div", "tr-col" + (y.n == null ? " unknown" : "") + (y.partial ? " partial" : "") + (top > 0 && y.n === top ? " peak" : ""));
			if (!compact) col.appendChild(fel("span", "tr-v", y.n == null ? "?" : citeShort(y.n)));
			let wrap = fel("div", "tr-wrap"), bar = fel("span", "tr-bar" + (y.n > 0 ? " on" : ""));
			bar.style.height = Math.round((y.n || 0) / Math.max(1, max) * 100) + "%";
			wrap.appendChild(bar); col.appendChild(wrap);
			if (!compact) col.appendChild(fel("span", "tr-y", String(y.year)));
			else tip(col, line(y) + (y.partial ? " (" + t("citeInProgress") + ")" : ""));
			box.appendChild(col);
		}
		return box;
	}
	function citeSpark(tr) {
		let box = fel("span", "spark");
		box.setAttribute("aria-hidden", "true");
		for (let y of tr.years) {
			let b = fel("span", "spark-b" + (y.n == null ? " unknown" : "") + (y.partial ? " partial" : "") + (y.n > 0 ? " on" : ""));
			b.style.height = Math.round((y.n || 0) / Math.max(1, tr.max) * 100) + "%";
			box.appendChild(b);
		}
		return box;
	}

	// The detail's own figure: the count large, the yearly average, the last two years' direction, ten years in miniature.
	function renderCiteStrip(r) {
		let box = $("d-cite");
		if (!box) return;
		box.textContent = "";
		let fig = citeFigures(r), tr = fig.trend, cpy = fig.perYear;
		if (fig.total == null && !tr) { box.hidden = true; return; }
		box.hidden = false;
		let btn = fel("button", "cite-strip"); btn.type = "button";
		btn.setAttribute("aria-haspopup", "dialog");
		btn.appendChild(fel("span", "cite-strip-n", fig.total == null ? "–" : String(fig.total)));
		btn.appendChild(fel("span", "cite-strip-l", t("citeLabel")));
		if (cpy != null && Number.isFinite(cpy)) btn.appendChild(fel("span", "cite-strip-avg", t("citePerYear", fmt(cpy, 1))));
		let mark = citeMarkOf(r);
		if (mark) btn.appendChild(fel("span", "cite-strip-mark " + mark.direction, mark.glyph + (tr.yoy == null ? "" : " " + Math.abs(tr.yoy) + "%")));
		// Two bars are a glitch, not a trend: the miniature waits for a third year.
		if (tr && tr.years.length > 2) btn.appendChild(citeSpark(tr));
		tip(btn, t("citeOpenTip"));
		btn.addEventListener("click", () => openCitePop(r, btn));
		box.appendChild(btn);
	}

	// ---- the popover: opens on a click, shows what is saved at once and mends itself when the fresh count arrives
	let citePop = null, citeToken = 0;
	function closeCitePop(returnFocus = false) {
		if (!citePop) return;
		let { el, opener, off } = citePop;
		citePop = null; citeToken++;
		off();
		el.remove ? el.remove() : el.parentNode?.removeChild(el);
		// The opener may have been redrawn while the card was open (a row repainted, the detail re-rendered):
		// focus goes to it only while it is still in the window, else to the results table.
		if (returnFocus) {
			if (opener?.focus && opener.tagName === "BUTTON" && opener.isConnected !== false) opener.focus();
			else $("table-wrap")?.focus?.({ preventScroll: true });
		}
	}
	function citeCardBody(r, st) {
		let fig = citeFigures(r), tr = fig.trend, box = fel("div", "cite-card");
		let top = fel("div", "cite-top");
		let big = fel("div", "cite-big");
		big.appendChild(fel("span", "cite-n", fig.total == null ? "–" : String(fig.total)));
		big.appendChild(fel("span", "cite-l", t("citeLabel")));
		top.appendChild(big);
		let close = fel("button", "ghost cite-close icon-btn small"); close.type = "button";
		close.setAttribute("aria-label", t("citeClose")); tip(close, t("citeClose"));
		close.appendChild(iconNode("ic-close"));
		close.addEventListener("click", () => closeCitePop(true));
		top.appendChild(close);
		box.appendChild(top);
		let sub = [], cpy = fig.perYear;
		if (cpy != null && Number.isFinite(cpy)) sub.push(t("citePerYear", fmt(cpy, 1)));
		// The card says whose count it is: the label follows the index that gave the numbers.
		sub.push(fig.source ? t("citeBasisOf", sourceLabel(fig.source)) : t("citeBasis"));
		box.appendChild(fel("div", "cite-sub", sub.join(" · ")));
		// Other indexes count differently; each is named with its own number, never merged into the card's.
		if (fig.others.length) box.appendChild(fel("div", "cite-foot", t("citeOthers", fig.others.map(o => sourceLabel(o.source) + " " + o.n).join(" · "))));
		if (tr) {
			let sect = fel("div", "cite-sect");
			sect.appendChild(fel("div", "cite-h", t("citeSectionYears")));
			sect.appendChild(citeBars(tr.years, tr.max, false));
			let running = tr.years.find(y => y.partial);
			if (running && !tr.seen) sect.appendChild(fel("div", "cite-foot", t("citeYearPartial", running.year)));
			// A series read in an earlier year (a saved search reopened): when, and that the years since are not counted here.
			if (tr.seen) sect.appendChild(fel("div", "cite-foot", t("citeSeriesAsOf", tr.seen.at ? citeDate(tr.seen.at) : String(tr.seen.to), tr.seen.to)));
			box.appendChild(sect);
		}
		// What the bars cannot say: the change against the year before, and what was added since the last look.
		let d = st.delta, change = fel("div", "cite-sect");
		if (tr && tr.last && tr.prev) {
			let line = fel("div", "cite-line");
			if (tr.yoy == null) line.textContent = t("citeYoyNone");
			else {
				line.appendChild(fel("span", "cite-yoy cite-strong " + (tr.yoy > 0 ? "up" : tr.yoy < 0 ? "down" : ""), (tr.yoy > 0 ? "\u25b2 " : tr.yoy < 0 ? "\u25bc " : "") + Math.abs(tr.yoy) + "%"));
				line.appendChild(document.createTextNode(" " + t("citeYoyVs", tr.last.year, tr.prev.year)));
			}
			change.appendChild(line);
		}
		if (d) change.appendChild(fel("div", "cite-delta" + (d.change > 0 ? " up" : ""), d.change === 0 ? t("citeSinceNone", citeDate(d.from), citeDate(d.to)) : t("citeSince", d.change, citeDate(d.from), citeDate(d.to))));
		else if (st.phase === "done") change.appendChild(fel("div", "cite-line", t("citeFirstLook")));
		if (change.firstChild) { change.insertBefore(fel("div", "cite-h", t("citeSectionRecent")), change.firstChild); box.appendChild(change); }
		let note = st.phase === "loading" ? t("citeLoading") : st.phase === "failed" ? t("citeFailed", st.message || "") : st.phase === "budget" ? t("citeBudget")
			: st.phase === "noid" ? t("citeNoId") : st.phase === "done" && !tr ? t("citeNoYears") : st.phase === "done" && st.at && !st.delta && citeDate(st.at) !== t("citeToday") ? t("citeAsOf", citeDate(st.at)) : "";
		if (note) box.appendChild(fel("div", "cite-foot cite-status", note));
		return box;
	}
	function placeCitePop() {
		if (!citePop) return;
		let { el } = citePop, anchor = citePop.anchor;
		// A re-drawn table or detail leaves the opener behind: the same place in the new one.
		if (anchor.isConnected === false) {
			let again = citePop.strip ? $("d-cite")?.querySelector(".cite-strip") : document.querySelector(`#results-body tr[data-key="${CSS.escape(citePop.rec.key)}"] td[data-cite]`);
			if (again) anchor = citePop.anchor = again;
			else if (citePop.rect) anchor = { getBoundingClientRect: () => citePop.rect };
		}
		if (typeof anchor.getBoundingClientRect === "function") citePop.rect = anchor.getBoundingClientRect();
		if (typeof el.getBoundingClientRect !== "function" || typeof anchor.getBoundingClientRect !== "function") return;
		el.style.maxHeight = ""; el.style.visibility = "hidden";
		let rect = anchor.getBoundingClientRect(), size = el.getBoundingClientRect();
		let put = ZotPoPTip.place({ anchor: rect, size: { w: size.width, h: size.height }, view: { w: window.innerWidth, h: window.innerHeight }, cursor: null });
		el.style.left = put.left + "px"; el.style.top = put.top + "px";
		if (put.maxHeight) el.style.maxHeight = put.maxHeight + "px";
		el.setAttribute("data-side", put.side);
		el.style.visibility = "";
	}
	function paintCitePop(r, st) {
		if (!citePop) return;
		citePop.el.textContent = "";
		citePop.el.appendChild(citeCardBody(r, st));
		placeCitePop();
	}
	async function openCitePop(r, anchor) {
		if (!r || typeof ZotPoPTip === "undefined") return;
		if (citePop && citePop.rec === r && citePop.opener === anchor) { closeCitePop(true); return; }
		closeCitePop();
		ZotPoPTip.current?.()?.hide?.();
		let el = fel("div", "tip-card cite-pop show");
		el.setAttribute("role", "dialog"); el.setAttribute("aria-label", t("citeOpen")); el.tabIndex = -1;
		(document.body || document).appendChild(el);
		let token = ++citeToken, key = citeSnapshotKey(r);
		let onKey = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCitePop(true); } };
		let onDown = e => { if (!el.contains(e.target) && !anchor.contains?.(e.target)) closeCitePop(); };
		let onAway = e => { if (!el.contains?.(e.target)) closeCitePop(); };
		let onResize = () => closeCitePop();
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("scroll", onAway, true);
		window.addEventListener("resize", onResize);
		window.addEventListener("blur", onResize);
		citePop = { el, rec: r, opener: anchor, anchor, strip: Boolean(anchor.classList?.contains("cite-strip")), off: () => {
			document.removeEventListener("keydown", onKey, true); document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("scroll", onAway, true); window.removeEventListener?.("resize", onResize); window.removeEventListener?.("blur", onResize);
		} };
		if (snapshots) await snapshots.load();
		if (citeToken !== token) return;
		let before = snapshots && key ? snapshots.delta(key) : null;
		if (!citeFindable(r)) { paintCitePop(r, { phase: "noid", delta: before }); el.focus?.(); return; }
		paintCitePop(r, { phase: "loading", delta: before });
		el.focus?.();
		let cctx = { email: PREF("email") || "", openAlexApiKey: PREF("openAlexApiKey") || "", log, openAlexSpent: openAlexHeld() };
		let res;
		try { res = await ZotPoPSources.refreshOpenAlexWork(r, http, cctx); }
		catch (e) { res = { ok: false, reason: "failed", message: e.message }; }
		noteOpenAlexSpent(cctx);
		let st;
		if (res.ok) {
			let changed = res.citations !== r.citations || (res.citesByYear && (JSON.stringify(res.citesByYear) !== JSON.stringify(r.citesByYear) || res.citesByYearSeen?.to !== r.citesByYearSeen?.to));
			if (res.citesByYear) { r.citesByYear = res.citesByYear; r.citesByYearSeen = res.citesByYearSeen || null; }
			(r.citationsBy ||= {}).openalex = res.citations;
			if (r.citationSource === "openalex" || r.citations == null || res.citations > r.citations) { r.citations = res.citations; r.citationSource = "openalex"; }
			if (snapshots && key) { snapshots.observe(key, res.citations, Number.isFinite(res.at) ? res.at : undefined); snapshots.flush().catch(e => log("saving citation snapshots failed: " + e.message)); }
			st = { phase: "done", delta: snapshots && key ? snapshots.delta(key) : null, at: res.at };
			if (changed) { render(); renderDetail(); }
		}
		else st = { phase: res.reason === "budget" ? "budget" : res.reason === "id" ? "noid" : "failed", message: scrubURLs(res.message || ""), delta: before };
		if (citeToken === token) paintCitePop(r, st);
	}

	// The side card's small chart: every result's yearly citations added up.
	function drawMetricsTrend(list) {
		let box = $("metrics-trend");
		if (!box) return;
		box.textContent = "";
		let sum = hasCite() && list.length ? ZotPoPCite.sumByYear(list) : null;
		box.hidden = !sum;
		if (!sum) return;
		box.appendChild(fel("div", "tr-title", t("metricsTrend")));
		box.appendChild(citeBars(sum.years, sum.max, true));
		if (sum.years.some(y => y.n == null || y.short)) box.appendChild(fel("div", "tr-note", t("metricsTrendGaps")));
		let ends = fel("div", "yr-ends");
		ends.appendChild(fel("span", "", String(sum.years[0].year))); ends.appendChild(fel("span", "", String(sum.years[sum.years.length - 1].year)));
		box.appendChild(ends);
		box.appendChild(fel("div", "tr-note", t("metricsTrendNote", sum.papers, sum.of)));
	}

	// ------------------------------------------------------------ PubMed abstracts
	/* PubMed's summary has no abstract. The one of a paper the reader opens, or translates, is fetched
	   then (several papers in one request when several are asked together), and never for a whole list. */
	const abstractBusy = new Set(), abstractFailed = new Set(), abstractFlights = new Map(); // abstractFlights: PMID -> the one request in the air
	async function ensureAbstracts(recs, { force = false } = {}) {
		let need = recs.filter(r => r && r.pmid && !r.abstract && !abstractBusy.has(r.key) && (force || !abstractFailed.has(r.key)));
		if (!need.length || typeof ZotPoPSources?.fetchPubMedAbstracts !== "function") return false;
		for (let r of need) { abstractBusy.add(r.key); abstractFailed.delete(r.key); }
		let flight = ZotPoPSources.fetchPubMedAbstracts(need.map(r => String(r.pmid)), http, { ncbiApiKey: PREF("ncbiApiKey") || "", log });
		let tracked = Promise.resolve(flight).then(got => { let found = false; for (let r of need) { let text = got.get(String(r.pmid)); if (text) { r.abstract = text; found = true; } } return found; })
			.catch(e => { log("PubMed abstract lookup failed: " + (e.message || e)); for (let r of need) abstractFailed.add(r.key); return false; })
			.finally(() => {
				for (let r of need) { abstractBusy.delete(r.key); if (abstractFlights.get(String(r.pmid)) === tracked) abstractFlights.delete(String(r.pmid)); }
				let open = detailRecord();
				if (open && need.includes(open)) paintAbstract(open);
			});
		for (let r of need) abstractFlights.set(String(r.pmid), tracked);
		return tracked;
	}
	// The request already in the air for this paper's PMID, if any: Translate waits on it instead of reporting "no abstract".
	const abstractInFlight = r => (r && r.pmid ? abstractFlights.get(String(r.pmid)) : null) || null;
	function paintAbstract(r) {
		$("d-abstract").textContent = r.abstract || (abstractBusy.has(r.key) ? t("abstractLoading") : abstractFailed.has(r.key) ? t("abstractLoadFailed") : t("noAbstract"));
		renderTranslate(r);
	}

	// ------------------------------------------------------------ translating the abstract
	let trNote = null; // { key, text, err }
	const trLang = () => state.trLang || (state.trLang = (translator && translator.defaultLanguage()) || "en");
	const trTitleOn = () => PREF("translateTitle") === true;
	function trSet(r, text, err) {
		trNote = text ? { key: r.key, text, err: Boolean(err) } : null;
		let note = $("d-tr-note");
		note.textContent = text || "";
		note.classList.toggle("err", Boolean(err));
	}
	function renderTranslate(r) {
		let row = $("d-tr");
		if (!row) return;
		let lang = typeof ZotPoPTranslate !== "undefined" && translator ? ZotPoPTranslate.byCode(trLang()) : null;
		if (!translator || !lang) { row.hidden = true; $("d-tr-out").hidden = true; $("d-abstract").hidden = false; $("d-abs-label").hidden = false; return; }
		row.hidden = false;
		$("d-tr-lang-label").textContent = lang.name;
		$("d-tr-title").checked = trTitleOn();
		let busy = state.trBusy === r.key + "|" + lang.code;
		$("d-tr-run").disabled = busy;
		let text = r.abstract ? translator.cached(r.key, lang.code, "abstract", r.abstract) : null;
		let title = trTitleOn() && r.title ? translator.cached(r.key, lang.code, "title", r.title) : null;
		let shown = Boolean(text || title);
		$("d-tr-run-label").textContent = busy ? t("trRunning") : t(shown ? "trRetry" : "trButton");
		$("d-tr-copy").hidden = !shown;
		$("d-tr-out").hidden = !shown;
		$("d-tr-title-out").hidden = !title; $("d-tr-title-out").textContent = title ? title.text : "";
		$("d-tr-text").hidden = !text; $("d-tr-text").textContent = text ? text.text : "";
		$("d-tr-via").textContent = shown ? t("trVia", (text || title).service, lang.name) : "";
		let orig = $("d-tr-orig"), hide = shown && state.trHideOrig === true && Boolean(r.abstract);
		orig.hidden = !shown || !r.abstract;
		$("d-tr-orig-label").textContent = hide ? t("trShowOrig") : t("trHideOrig");
		$("d-tr-orig-icon").setAttribute("href", hide ? "#ic-chevron-down" : "#ic-chevron-up");
		orig.setAttribute("aria-expanded", String(!hide));
		$("d-abstract").hidden = hide;
		$("d-abs-label").hidden = hide;
		let note = trNote && trNote.key === r.key ? trNote : null;
		$("d-tr-note").textContent = busy ? "" : note ? note.text : "";
		$("d-tr-note").classList.toggle("err", Boolean(note && note.err && !busy));
	}
	async function runTranslate() {
		let r = detailRecord();
		if (!r || !translator) return;
		let lang = trLang(), wantTitle = trTitleOn(), id = r.key + "|" + lang;
		if (state.trBusy === id) return;
		if (!r.abstract && r.pmid) {
			// An abstract still on its way is awaited, never re-requested; only a failed or absent one is asked for again.
			let flying = abstractInFlight(r);
			state.trBusy = id; renderTranslate(r);
			try { if (flying) await flying; else await ensureAbstracts([r], { force: true }); }
			finally { if (state.trBusy === id) state.trBusy = null; }
		}
		// The reader may have moved to another paper while the abstract was awaited: this one's answer stays with it.
		if (!r.abstract && !wantTitle) { if (detailRecord() === r) { trSet(r, t("trNoText"), true); renderTranslate(r); } else trNote = { key: r.key, text: t("trNoText"), err: true }; return; }
		if (detailRecord() !== r) return;
		state.trBusy = id; trNote = null;
		renderTranslate(r);
		try {
			// One after the other: the free services refuse a burst. "Translate again" (a translation already shown) asks anew.
			let again = Boolean((r.abstract && translator.cached(r.key, lang, "abstract", r.abstract)) || (wantTitle && r.title && translator.cached(r.key, lang, "title", r.title)));
			if (r.abstract) await translator.translateCached({ key: r.key, lang, field: "abstract", text: r.abstract, fresh: again });
			if (wantTitle && r.title) await translator.translateCached({ key: r.key, lang, field: "title", text: r.title, fresh: again });
			trNote = null;
		}
		catch (e) { trNote = { key: r.key, text: e.code === "none" ? t("trNone") : t("trFailed", scrubURLs(e.message || String(e))), err: true }; }
		finally {
			if (state.trBusy === id) state.trBusy = null;
			let now = detailRecord();
			if (now) renderTranslate(now);
		}
	}
	function copyTranslation() {
		let r = detailRecord();
		if (!r || !translator) return;
		let lang = trLang();
		let parts = [trTitleOn() && r.title ? translator.cached(r.key, lang, "title", r.title) : null, r.abstract ? translator.cached(r.key, lang, "abstract", r.abstract) : null].filter(Boolean).map(x => x.text);
		if (parts.length) copyText(parts.join("\n\n"), t("trCopied"));
	}
	function setTrLang(code) {
		state.trLang = code; PREF("translateLang", code);
		let r = detailRecord();
		if (r) renderTranslate(r);
	}
	function trLangMenuItems() {
		return ZotPoPTranslate.LANGUAGES.map(l => ({ label: l.name, check: l.code === trLang(), radio: true, run: () => setTrLang(l.code) }));
	}

	// ------------------------------------------------------------ detail pane
	/* The PDF preview lives inside the detail card: no window is ever opened for it. It follows the
	   open paper, a quick run over the rows waits a moment before fetching anything, and the viewer
	   drops whatever the previous row was still doing. */
	const PREVIEW_FOLLOW_DELAY = 150;
	state.preview = { on: false, key: null };
	let previewViewer = null, previewTimer = null, previewPending = null;
	function previewRecord() {
		return state.records.find(r => r.key === state.focusKey)
			|| state.records.find(r => state.selected.has(r.key)) || detailRecord();
	}
	function viewerOfPreview() {
		if (!previewViewer) previewViewer = ZotPoPPreview.createViewer({
			fetchPDF: (url, signal) => ZotPoPPreview.fetchPDF(url, signal, Zotero),
			readLocal: (path, signal) => ZotPoPPreview.readLocalPDF(path, signal),
			getLibrary: () => import("resource://zotero/reader/pdf/build/pdf.mjs"),
			createCanvas: () => document.createElement("canvas"),
			width: () => ($("dp-view").clientWidth || 640) - 32,
			pixelRatio: () => window.devicePixelRatio || 1,
			onState: paintPreview
		});
		return previewViewer;
	}
	function paintPreview(st) {
		let turning = st.status === "turning", ready = st.status === "ready";
		$("dp-page").textContent = t("previewPageOf", st.page || 1, st.pageCount || 0);
		$("dp-prev").disabled = !(ready || turning) || st.page <= 1;
		$("dp-next").disabled = !(ready || turning) || st.page >= st.pageCount;
		$("dp-original").disabled = !st.originalURL;
		state.preview.originalURL = st.originalURL || null;
		$("dp-retry").hidden = st.status !== "error";
		let host = $("dp-canvas");
		if (ready && st.canvas) {
			st.canvas.setAttribute("role", "img");
			st.canvas.setAttribute("aria-label", `${t("previewPageOf", st.page, st.pageCount)} — ${st.title}`);
			host.textContent = "";
			host.appendChild(st.canvas);
			$("dp-view").scrollTop = 0;
		}
		else if (!turning) host.textContent = "";
		$("dp-view").setAttribute("data-busy", String(st.status === "loading" || turning));
		$("dp-message").hidden = ready || turning;
		if (!ready && !turning) {
			let key = st.status === "loading" ? "previewLoading" : st.status === "unavailable" ? "previewUnavailable"
				: st.error?.name === "PreviewSizeError" ? "previewTooLarge" : "previewFailed";
			$("dp-message").textContent = t(key);
		}
	}
	// Brings the panel in line with the state: shown for the open paper, fetched once per paper.
	function syncPreview(follow = false) {
		let r = detailRecord(), on = Boolean(state.preview.on && r);
		$("d-pdfview").hidden = !on;
		if (on) $("detail").setAttribute("data-preview", ""); else $("detail").removeAttribute("data-preview");
		$("preview-btn").setAttribute("aria-pressed", String(Boolean(state.preview.on)));
		// A pending start for the same paper survives (openPreview() right after the row's own render must not
		// strand it on "loading"); a button press runs it now. Only a row change or close cancels it.
		if (on && state.preview.key === r.key) {
			if (previewPending && !follow) { let run = previewPending; clearTimeout(previewTimer); previewPending = null; run(); }
			return;
		}
		clearTimeout(previewTimer); previewPending = null;
		if (!on) { if (state.preview.key != null) previewViewer?.close(); state.preview.key = null; return; }
		previewViewer?.close();
		state.preview.key = r.key;
		paintPreview({ status: "loading", page: 1, pageCount: 0, title: r.title, originalURL: ZotPoPPreview.originalURL(r) });
		let start = () => { previewPending = null; if (state.preview.on && state.preview.key === r.key) viewerOfPreview().showRecord(r); };
		/* A held paper's own PDF is read before any remote one: its path is looked up once per library and item,
		   then the viewer starts. A path found in another library (or for another copy) is dropped, never shown,
		   and a lookup that answers after the library changed is not kept. */
		let owner = () => (state.libraryID ?? currentTarget().libraryID) + "|" + (r.inLibrary ? heldItemID(r) ?? "" : "-");
		let mine = owner();
		if (r.localPDFFor !== mine) { delete r.localPDFPath; delete r.localPDFFor; }
		if (r.inLibrary && r.localPDFPath === undefined && typeof ZotPoPImporter?.localPDF === "function") {
			let go = start;
			start = () => {
				previewPending = null;
				Promise.resolve(ZotPoPImporter.localPDF(state.libraryID ?? currentTarget().libraryID, r, heldItemID(r)))
					.then(found => found?.path || null, () => null)
					.then(path => { if (owner() !== mine) return; r.localPDFPath = path; r.localPDFFor = mine; go(); });
			};
		}
		if (follow) { previewPending = start; previewTimer = setTimeout(start, PREVIEW_FOLLOW_DELAY); } else start();
	}
	function openPreview(record = previewRecord()) {
		if (!record) return;
		state.preview.on = true;
		state.detailKey = record.key;
		syncPreview();
		paintRows(); renderDetail();
		$("detail").scrollIntoView?.({ block: "nearest" });
	}
	function closePreview() { state.preview.on = false; syncPreview(); }
	function togglePreview() { if (state.preview.on) closePreview(); else openPreview(); }
	function detailRecord() { return state.records.find(r => r.key === state.detailKey) || null; }

	function renderDetail() {
		let r = detailRecord();
		$("detail-empty").hidden = Boolean(r);
		$("detail-body").hidden = !r;
		// Nothing chosen: the pane folds to one hint row and gives the table its height back. The height
		// the user set stays on the element and returns with the next choice.
		if (r) $("detail").removeAttribute("data-empty"); else $("detail").setAttribute("data-empty", "");
		syncDetailSplitter();
		syncPreview(true);
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
		// The journal by its full name in its own ink, then the year, as one line under the title (no lettermark chip).
		let venueLine = $("d-venue");
		venueLine.textContent = "";
		if (r.venue) {
			let name = document.createElement("span"); name.className = "d-venue-name"; name.textContent = r.venue;
			paintVenue(name, r);
			venueLine.appendChild(name);
		}
		if (r.year) venueLine.appendChild(document.createTextNode((r.venue ? " \u00b7 " : "") + r.year));
		venueLine.hidden = !venueLine.firstChild;
		if (r.retracted) tip(chip(t("retractedChip"), "retracted"), t("retractedTip"));
		if (r.inLibrary) chip(t("badgeInLibrary"), "lib");
		let sources = r.sources || [r.source];
		// One source keeps its mark; several fold into one muted count whose tip names them.
		if (sources.length > 1) { let more = chip(t("badgeSources", sources.length), "src-more"); tip(more, sources.map(sourceLabel).join(" · ")); }
		else for (let s of sources) sourceChip(s);
		badges.hidden = !badges.firstChild;
		renderCiteStrip(r);
		let cite = $("d-cite");
		// The figures the table already shows, said once as one plain sentence with what each one is.
		let context = buildResultContext(r);
		let evidence = $("d-evidence");
		evidence.textContent = (cite.hidden ? context.evidence : context.rest).join(" · ");
		tip(evidence, r.journalIF != null ? t("jifTip", fmt(r.journalIF, 1), r.journalIFSource, r.journalH, r.journalIFAs) : r.journalOA2y != null ? t("oaTip", fmt(r.journalOA2y, 1), r.journalH) : "");

		renderAuthors(r);
		// Other papers of these authors in this search's results only, never the whole library.
		let facets = $("d-facets");
		facets.textContent = "";
		for (let a of context.authors.slice(0, 4)) {
			let line = document.createElement("div");
			line.className = "d-facet";
			let text = document.createElement("span");
			text.textContent = t(a.byId ? "facetLineId" : "facetLineName", a.name, a.total, a.unowned) + " ";
			tip(text, t("facetScope"));
			let btn = document.createElement("button");
			btn.type = "button"; btn.className = "ghost facet-show";
			btn.textContent = t("facetShow");
			btn.addEventListener("click", () => setFacet({ key: a.key, name: a.name, byId: a.byId }));
			line.appendChild(text); line.appendChild(btn);
			facets.appendChild(line);
		}
		facets.hidden = !facets.firstChild;
		let whereBox = $("d-where");
		whereBox.textContent = "";
		let where = affiliationOf(r);
		if (where) {
			for (let [role, p] of [[t("affFirst"), where.first], [where.correspondingKnown ? t("affCorresponding") : t("affLast"), where.corresponding]]) {
				if (!p) continue;
				// Always in the same order: who, then the tier chip, the flag, the lab, the country and the h-index.
				let line = document.createElement("div");
				line.appendChild(document.createTextNode(role + ": " + p.name + " \u00b7 "));
				let chip = p.tier ? tierChip({ tier: p.tier, hIndex: p.hIndex }) : null;
				if (chip) { line.appendChild(chip); line.appendChild(document.createTextNode(" ")); }
				line.appendChild(document.createTextNode((p.flag ? p.flag + " " : "") + (p.institution || t("affUnknown")) + (p.country ? " \u00b7 " + p.country : "") + (p.hIndex != null ? " \u00b7 " + t("affHIndex", p.hIndex) : "")));
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
		// Where the library files this paper: the last two levels of each path, the whole path in the tooltip.
		let filed = $("d-collections"), paths = r.inLibrary && r.collections || [];
		filed.textContent = paths.map(p => p.slice(-2).join(" › ")).join(" · ");
		tip(filed, paths.map(p => p.join(" › ")).join("\n"));
		filed.hidden = !paths.length;
		if (paths.length) filed.textContent = t("inCollections") + " " + filed.textContent;
		if (r.pmid && !r.abstract && detailShown) { ensureAbstracts([r]); }
		paintAbstract(r);

		// Why the row has the status it has, in words: a failure's cause was only in a tooltip.
		let statusLine = $("d-status");
		statusLine.textContent = r.status ? t("statusLine", r.status, r.statusTitle) : "";
		statusLine.className = "d-status" + (r.statusClass ? " " + r.statusClass : "");
		statusLine.hidden = !r.status;
		renderVersions(r);
		renderSignals(r);
		renderWhy(r);

		// The main action: an owned paper shows its library copy, any other is added.
		syncQueueButton(r);
		let primary = $("d-primary"), owned = Boolean(r.inLibrary);
		$("d-primary-label").textContent = t(owned ? "dShowLibrary" : "dAdd");
		$("d-primary-icon").setAttribute("href", owned ? "#ic-book" : "#ic-plus");
		primary.classList.toggle("primary", !owned);
		tip(primary, t(owned ? "dShowLibrary" : "dAdd"));
		primary.disabled = !owned && (state.importing || state.searching);
	}

	/* ---- "Rank by my library": only when the button is pressed (content/related.js has the formula) ---- */
	async function loadRelatedStore() {
		let store = ZotPoPRelated.createStore();
		try { store.import(JSON.parse(await cacheIO.readText(dataPath("related.json")))); }
		catch (_) { /* first run, or a damaged file: the lookups simply happen again */ }
		return store;
	}
	async function saveRelatedStore(store) {
		if (!cacheIO) return;
		try { await cacheIO.writeText(dataPath("related.json"), JSON.stringify(store.export())); }
		catch (e) { log("saving related-ranking cache failed: " + e.message); }
	}
	/* The papers this library holds, with what is already known about them: Style Custom's stored OpenAlex id
	   and reference list where it has one (no request), otherwise the DOI the search window already read. */
	function relatedHeld() {
		let out = [], seen = new Set(), lib = state.libraryID;
		// What identifies a held paper besides its title: the year and the first author's family name.
		let facts = id => {
			try {
				let it = Zotero.Items.get(id);
				if (!it) return { title: "" };
				let creators = typeof it.getCreators === "function" ? it.getCreators() : [];
				return { title: String(it.getField("title") || "").trim(), doi: String(it.getField("DOI") || "").trim(), year: String(it.getField("date") || "").match(/\d{4}/)?.[0] || "", family: String(creators?.[0]?.lastName || "").trim() };
			} catch (e) { return { title: "" }; }
		};
		let sc = styleCustom();
		if (sc) for (let w of ZotPoPSignals.libraryWorks(sc)) {
			if (!w.openalex) continue;
			if (lib != null && Number(String(w.key).split(":")[0]) !== Number(lib)) continue;
			let item = libraryItemOfKey(w.key);
			if (!item) continue;
			seen.add(item.id);
			let f = facts(item.id);
			// Style Custom's list is trusted only for the DOI it was fetched for, while fresh (content/related.js decides).
			out.push({ itemID: item.id, title: item.title, year: f.year, family: f.family, doi: f.doi, openalex: w.openalex, refs: [...w.refs], stored: true, scDoi: w.doi, checkedAt: w.checkedAt, complete: w.complete });
		}
		for (let [doi, id] of state.doiMap || []) { if (seen.has(id)) continue; seen.add(id); let f = facts(id); out.push({ itemID: id, title: f.title, year: f.year, family: f.family, doi }); }
		return out;
	}
	// What the tooltip shows of a held paper: title, year and the journal in full.
	function heldLine(top) {
		let year = "", venue = "";
		try { let it = Zotero.Items.get(top.itemID); year = String(it.getField("date") || "").match(/\d{4}/)?.[0] || ""; venue = String(it.getField("publicationTitle") || it.getField("journalAbbreviation") || "").trim(); } catch (e) { /* the title alone */ }
		return "\u2022 " + top.title + (year || venue ? " (" + [year, venue].filter(Boolean).join(", ") + ")" : "") + " \u2014 " + t("relTipWhy", top.why);
	}
	function relatedChip(rel) {
		let chip = document.createElement("span");
		chip.className = "rel-chip";
		if (rel.held || rel.unrankable) {
			chip.classList.add("muted");
			chip.textContent = t(rel.held ? "relHeldChip" : "relUnrankable");
			tip(chip, t(rel.held ? "relHeldTip" : "relUnrankableTip"));
			return chip;
		}
		let band = rel.band || ZotPoPRelated.bandOf(rel);
		chip.textContent = rel.score === 0 ? t("relNoLink") : band === "weak" ? t("relWeakChip", rel.c3) : t("relChip", rel.c1, rel.c2, rel.c3);
		chip.dataset.band = band;
		if (band === "none" || band === "weak") chip.classList.add("muted");
		if (band === "strong") chip.classList.add("strong");
		// The five papers behind the score are worked out when the card opens (tipContent, kind "related"), not for every row drawn.
		chip.dataset.tipKind = "related";
		chip.setAttribute("aria-label", t("relTip", rel.score, rel.c1, rel.c2, rel.c3w));
		return chip;
	}
	function relatedTipText(rel) {
		let band = rel.band || ZotPoPRelated.bandOf(rel);
		let cover = state.related.coverage, partial = cover && cover.known < cover.total ? [t("relCoverage", cover.known, cover.total)] : [];
		return [t("relBand", band), t("relTip", rel.score, rel.c1, rel.c2, rel.c3w), ...(rel.top || []).map(heldLine), ...(rel.lowConf ? [t("relLowConf", rel.lowConf)] : []), ...partial, ...(rel.score > 0 ? [t("relTipOpen")] : [])].join("\n");
	}
	// A held paper brought into view in Zotero's main window (selection only: no window opens).
	function selectHeld(itemID) {
		try {
			let pane = mainWindow?.ZoteroPane;
			if (itemID != null && pane?.selectItem) { pane.selectItem(itemID); setStatus(t("shownInLibrary"), "", { transient: true }); }
		}
		catch (e) { log("selectItem failed: " + e.message); }
	}
	/* The detail's "why this paper": every held paper the ranking linked it to, each a button that selects
	   that paper in Zotero, with what links them. A held result names the library copy instead. */
	const WHY_SHOWN = 8;
	function renderWhy(r) {
		let box = $("d-why");
		if (!box) return;
		box.textContent = "";
		let rel = r.related;
		let item = (it, why) => {
			let row = document.createElement("div"); row.className = "why-item";
			let go = document.createElement("button"); go.type = "button"; go.className = "ghost why-title";
			go.setAttribute("data-opens", "library");
			go.textContent = it.title || t("relUntitled");
			tip(go, t("relWhyOpen"));
			go.addEventListener("click", () => selectHeld(it.itemID));
			row.appendChild(go);
			if (why) { let note = document.createElement("span"); note.className = "why-note"; note.textContent = why; row.appendChild(note); }
			return row;
		};
		if (rel?.held && rel.heldItemID != null) {
			let head = document.createElement("div"); head.className = "why-head"; head.textContent = t("relWhyHeld");
			box.appendChild(head);
			box.appendChild(item({ itemID: rel.heldItemID, title: rel.heldTitle }, ""));
		}
		else if (rel && rel.score > 0) {
			let band = rel.band || ZotPoPRelated.bandOf(rel);
			let all = typeof rel.linked === "function" ? rel.linked() : rel.top || [];
			let head = document.createElement("div"); head.className = "why-head";
			head.textContent = t("relWhyHead", band, all.length);
			tip(head, t("relTip", rel.score, rel.c1, rel.c2, rel.c3w));
			box.appendChild(head);
			let list = document.createElement("div"); list.className = "why-list";
			for (let it of all.slice(0, WHY_SHOWN)) list.appendChild(item(it, t("relTipWhy", it.why)));
			box.appendChild(list);
			if (all.length > WHY_SHOWN) { let more = document.createElement("div"); more.className = "why-more"; more.textContent = t("relWhyMore", all.length - WHY_SHOWN); box.appendChild(more); }
		}
		box.hidden = !box.firstChild;
	}
	function syncRelatedBtn() {
		let btn = $("related-btn"), rel = state.related, on = state.sortKey === "related";
		btn.disabled = !rel.running && (state.searching || !state.records.length);
		btn.setAttribute("aria-pressed", String(on && !rel.running));
		// Rows that arrived after the ranking (load more, a later batch) have no score: the button offers to rank them.
		let fresh = on && !rel.running ? unrankedCount() : 0, stale = on && !rel.running && relatedStale();
		$("related-label").textContent = rel.running ? t("relCancel") : fresh ? t("relRankNew", fresh) : stale ? t("relRerank") : t(on ? "relBack" : "relButton");
	}
	const unrankedCount = () => state.records.filter(r => !r.related).length;
	// The library grew (a paper added here or elsewhere) since the ranking: the other scores may have moved.
	const relatedStale = () => Boolean(state.related.basis && state.related.basis !== relatedBasis());
	// A ranked paper just added is held now: its chip and "why" say so at once, the rest wait for a re-rank.
	function relatedNowHeld(r, itemID) {
		if (!r.related) return;
		r.related = { held: true, score: null, heldItemID: itemID ?? null, heldTitle: r.title };
	}
	/* What a finished ranking was worked out against: the library and how many of its papers were known.
	   The same list against the same library is sorted again without a second pass over 1,200 papers. */
	const relatedBasis = () => currentTarget().libraryID + "|" + (state.doiMap?.size || 0);
	/* One ranking job at a time, tied to a library and a generation. A library switch, the window closing or
	   a cancel bumps the generation; whatever an older job still delivers is dropped. */
	function cancelRelated({ clear = false } = {}) {
		let rel = state.related;
		rel.generation = (rel.generation || 0) + 1;
		rel.controller?.abort();
		rel.controller = null; rel.running = false;
		if (clear) clearRelated();
	}
	function clearRelated() {
		let rel = state.related, had = state.records.some(r => r.related);
		for (let r of state.records) r.related = null;
		if (state.sortKey === "related") { let prev = rel.prev || { key: "rank", dir: "asc" }; state.sortKey = prev.key; state.sortDir = prev.dir; }
		rel.prev = null; rel.libraryID = null; rel.basis = null;
		return had;
	}
	// A different library is a different set of held papers: nothing scored against the old one may stay.
	function relatedLibraryChanged() {
		let rel = state.related, lib = currentTarget().libraryID;
		if (rel.libraryID == null || rel.libraryID === lib) return;
		let had = clearRelated() || rel.running;
		cancelRelated();
		syncRelatedBtn();
		if (had) render();
	}
	async function toggleRelated() {
		let rel = state.related;
		if (rel.running) { rel.controller?.abort(); return; }
		if (state.sortKey === "related" && !unrankedCount() && !relatedStale()) {
			let prev = rel.prev || { key: "rank", dir: "asc" };
			state.sortKey = prev.key; state.sortDir = prev.dir; rel.prev = null;
			render();
			return;
		}
		if (state.searching || !state.records.length) return;
		if (state.sortKey !== "related" && rel.basis === relatedBasis() && !unrankedCount()) {
			rel.prev = { key: state.sortKey, dir: state.sortDir };
			state.sortKey = "related"; state.sortDir = "desc";
			syncRelatedBtn(); render();
			return;
		}
		let held = relatedHeld();
		if (!held.length) { showBanner(t(state.doiMap?.failed ? "relLibraryFailed" : "relNeedsLibrary"), null, { warn: true }); return; }
		let records = state.records.slice(), controller = new AbortController();
		let job = { generation: (rel.generation = (rel.generation || 0) + 1), libraryID: currentTarget().libraryID, controller };
		let stale = () => job.generation !== rel.generation;
		let cancelled = () => job.generation !== rel.generation || controller.signal.aborted;
		rel.running = true; rel.controller = controller; rel.libraryID = job.libraryID;
		hideBanner();
		syncRelatedBtn();
		let cctx = { openAlexApiKey: String(PREF("openAlexApiKey") || ""), log, openAlexSpent: openAlexHeld(), signal: controller.signal, isCancelled: () => job.generation !== rel.generation };
		let out = null;
		try {
			rel.store = rel.store || await loadRelatedStore();
			out = await ZotPoPRelated.rank({ held, http, ctx: cctx, store: rel.store, sources: ZotPoPSources,
				results: records.map(r => ({ key: r.key, source: r.source, sourceId: r.sourceId, doi: r.doi, title: r.title, year: r.year, family: r.authors?.[0]?.lastName || "", publishedAs: r.publishedAs, preprintOf: r.preprintOf })),
				onProgress: p => { if (!cancelled()) { setStatus(t("relProgress", p.done, p.total)); setProgress(p.done, p.total); } } });
		}
		catch (e) {
			if (e?.name === "AbortError") { if (!stale()) setStatus(t("relStopped"), "", { transient: true }); }
			else { log("ranking by library failed: " + (e?.message || e)); if (!stale()) setStatus(t("relFailed"), "err"); }
		}
		finally {
			noteOpenAlexSpent(cctx);
			if (job.generation === rel.generation) { rel.running = false; rel.controller = null; setProgress(null); }
			if (rel.store) await saveRelatedStore(rel.store);
		}
		// A newer generation (library switch, window closed) owns the state now: this job's answer is dropped whole.
		if (cancelled() || job.libraryID !== currentTarget().libraryID) { if (job.generation === rel.generation) { syncRelatedBtn(); render(); } return; }
		if (out) {
			let reason = out.reason;
			if (!out.ok) {
				if (reason === "empty-library" || reason === "no-known-held") showBanner(t(reason === "no-known-held" ? "relNoReferences" : "relNeedsLibrary"), null, { warn: true });
				else setStatus(t(reason === "budget" ? "relBudget" : "relFailed"), "err");
			}
			else {
				// By key onto the rows shown now: a batch that redrew the list while this ran still gets its scores.
				// Shared, not copied: `top` is worked out on first read.
				for (let r of records) r.related = out.scores.get(r.key) || null;
				let same = false;
				for (let r of state.records) if (out.scores.has(r.key)) { r.related = out.scores.get(r.key); same = true; }
				rel.basis = relatedBasis();
				if (same) {
					if (state.sortKey !== "related") rel.prev = { key: state.sortKey, dir: state.sortDir };
					state.sortKey = "related"; state.sortDir = "desc";
					let ranked = records.filter(r => r.related?.score != null).length;
					// How much of the library could be compared at all: a paper OpenAlex does not know links to nothing.
					let total = (out.heldKnown || 0) + (out.heldUnknown || 0);
					rel.coverage = total ? { known: out.heldKnown, total } : null;
					let cover = rel.coverage && rel.coverage.known < total ? " " + t("relCoverage", rel.coverage.known, total) : "";
					setStatus((out.partial ? t("relPartial", ranked, records.length) : out.requests ? t("relDone", ranked, records.length, out.requests) : t("relDoneCached", ranked, records.length)) + cover, out.partial && reason === "budget" ? "err" : "");
				}
			}
		}
		syncRelatedBtn();
		render();
	}

	/* ---- what the library says about the open paper, and following its authors (Style Custom, optional) ---- */
	const styleCustom = () => typeof ZotPoPSignals !== "undefined" ? ZotPoPSignals.runtimeOf(Zotero) : null;
	const canWatch = sc => Boolean(sc && typeof sc.watchAuthor === "function");
	function watchedRows(sc = styleCustom()) { try { return sc ? sc.watchedAuthors() || [] : []; } catch (e) { return []; } }
	// Followed under any of the person's records (Style Custom keeps the others as alsoIds).
	const isFollowed = (id, sc) => watchedRows(sc).some(row => [row.id, ...(Array.isArray(row.alsoIds) ? row.alsoIds : [])].some(one => ZotPoPSignals.shortWork(one) === ZotPoPSignals.shortWork(id)));
	state.sigRefs = new Map();
	state.sigOpen = null;
	function libraryItemOfKey(key) {
		try {
			let [lib, k] = String(key).split(":");
			let item = Zotero.Items.getByLibraryAndKey(Number(lib), k);
			return item && !item.deleted ? { id: item.id, title: String(item.getField("title") || "").trim() || k } : null;
		} catch (e) { return null; }
	}
	/* Follows an author in Style Custom with the works already listed marked seen, so the first sweep
	   does not report them as news. Resolves true when followed. */
	async function followAuthor(person) {
		let sc = styleCustom();
		if (!canWatch(sc)) return false;
		let ids = typeof ZotPoPSignals.authorIdsOf === "function" ? ZotPoPSignals.authorIdsOf(person) : person.openalexId || person.id;
		let payload = ZotPoPSignals.watchPayload(person, ZotPoPSignals.seenWorksOf(state.records, ids));
		if (!payload) return false;
		try { await sc.watchAuthor(payload); setStatus(t("watchAuthorDone", payload.name), "", { transient: true }); return true; }
		catch (e) { setStatus(t("watchAuthorFail", e.message || String(e)), "err"); return false; }
	}
	function watchButton(person, after) {
		let sc = styleCustom();
		if (!canWatch(sc) || !ZotPoPSignals.watchPayload(person, [])) return null;
		let on = isFollowed(person.openalexId || person.id, sc);
		let b = document.createElement("button");
		b.type = "button"; b.className = "watch-btn";
		b.textContent = t(on ? "watchAuthorOn" : "watchAuthor");
		b.setAttribute("aria-pressed", String(on));
		tip(b, t(on ? "watchAuthorOnTip" : "watchAuthorTip", person.name));
		b.addEventListener("click", async () => { if (on) return; b.disabled = true; await followAuthor(person); after(); });
		return b;
	}
	// Up to three people worth following: first author, corresponding author(s) and last author, those with an OpenAlex id.
	function principalAuthors(r) {
		let people = (Array.isArray(r.people) ? r.people : []).filter(p => p && p.openalexId);
		let picks = [people[0], ...people.filter(p => p.corresponding), people[people.length - 1]].filter(Boolean);
		return [...new Map(picks.map(p => [p.openalexId, p])).values()].slice(0, 3);
	}
	async function loadReferences(r) {
		let sc = styleCustom();
		if (!sc || state.sigRefs.has(r.key) || openAlexHeld() || !ZotPoPSignals.libraryWorks(sc).length) return;
		state.sigRefs.set(r.key, { status: "loading" });
		let cctx = { email: PREF("email") || "", openAlexApiKey: PREF("openAlexApiKey") || "", log, openAlexSpent: openAlexHeld() };
		let got = await ZotPoPSources.fetchReferencedWorks(r, http, cctx).catch(() => ({ ok: false }));
		noteOpenAlexSpent(cctx);
		state.sigRefs.set(r.key, got.ok ? { status: "done", id: got.id, ids: got.ids } : { status: "failed" });
		if (detailRecord() === r) renderSignals(r);
	}
	function renderSignals(r) {
		let box = $("d-signals");
		box.textContent = "";
		let sc = styleCustom();
		if (!sc) { box.hidden = true; return; }
		let works = ZotPoPSignals.libraryWorks(sc);
		let refs = state.sigRefs.get(r.key) || null;
		let again = () => { if (detailRecord() === r) renderSignals(r); };
		let line = () => { let l = document.createElement("div"); l.className = "sig-line"; box.appendChild(l); return l; };
		let followed = ZotPoPSignals.followedIn(r, watchedRows(sc));
		if (followed.length) {
			let chip = document.createElement("span"); chip.className = "badge lib";
			chip.textContent = t("sigFollowed", followed.map(f => f.name).join(", "));
			line().appendChild(chip);
		}
		if (works.length) {
			let own = r.source === "openalex" && /^W\d+$/i.test(r.sourceId || "") ? r.sourceId : refs?.id || null;
			let groups = [];
			let citing = own ? ZotPoPSignals.libraryCiting(own, works).filter(k => libraryItemOfKey(k)) : [];
			if (citing.length) groups.push({ id: "citedBy", keys: citing, label: t("sigCitedByMine", citing.length), tip: t("sigCitedByMineTip") });
			let cited = refs?.status === "done" ? ZotPoPSignals.libraryCited(refs.ids, works).filter(k => libraryItemOfKey(k)) : [];
			if (cited.length) groups.push({ id: "cites", keys: cited, label: t("sigCitesMine", cited.length), tip: t("sigCitesMineTip") });
			if (!refs && detailShown) loadReferences(r);
			let row = groups.length || refs?.status === "loading" ? line() : null;
			for (let g of groups) {
				let open = state.sigOpen && state.sigOpen.key === r.key && state.sigOpen.id === g.id;
				let b = document.createElement("button"); b.type = "button"; b.className = "sig-count"; b.textContent = g.label;
				b.setAttribute("aria-expanded", String(open)); tip(b, g.tip);
				b.addEventListener("click", () => { state.sigOpen = open ? null : { key: r.key, id: g.id }; again(); });
				row.appendChild(b);
			}
			if (refs?.status === "loading" && row) { let wait = document.createElement("span"); wait.textContent = t("sigChecking"); row.appendChild(wait); }
			let shown = groups.find(g => state.sigOpen && state.sigOpen.key === r.key && state.sigOpen.id === g.id);
			if (shown) {
				let list = document.createElement("div"); list.className = "sig-list";
				for (let k of shown.keys) {
					let it = libraryItemOfKey(k); if (!it) continue;
					let item = document.createElement("div"); item.className = "sig-item";
					let name = document.createElement("span"); name.className = "sig-title"; name.textContent = it.title; tip(name, it.title);
					let go = document.createElement("button"); go.type = "button"; go.className = "ghost"; go.textContent = t("sigShowInLibrary");
					go.addEventListener("click", () => { try { mainWindow?.ZoteroPane?.selectItem(it.id); } catch (e) { log("selectItem failed: " + e.message); } });
					item.appendChild(name); item.appendChild(go); list.appendChild(item);
				}
				box.appendChild(list);
			}
		}
		if (canWatch(sc)) for (let p of principalAuthors(r)) {
			let b = watchButton(p, again);
			if (!b) continue;
			let l = line(), who = document.createElement("span"); who.textContent = p.name; l.appendChild(who); l.appendChild(b);
		}
		box.hidden = !box.firstChild;
	}

	/* A preprint and the article it became are two records with two DOIs, so they are not
	   merged. The detail says so in one plain line: which version, where, whether the library
	   has it, and a jump to its row. A link found from title and first author says "estimated". */
	function renderVersions(r) {
		let box = $("d-versions");
		box.textContent = "";
		tip(box, "");
		let link = r.publishedAs ? { kind: "verPublished", tip: "publishedAsTip", to: r.publishedAs } : r.preprintOf ? { kind: "verPreprint", tip: "preprintOfTip", to: r.preprintOf } : null;
		box.hidden = !link;
		if (!link) return;
		let { to } = link, estimated = to.basis === "title";
		let target = state.records.find(o => o.key === to.key)
			|| (to.doi && state.records.find(o => o.doi && ZotPoPSources.normalizeDOI(o.doi) === ZotPoPSources.normalizeDOI(to.doi)));
		// Not among the results: the library may still hold it, by DOI at once or by title once asked.
		let held = target ? Boolean(target.inLibrary) : heldVersion(to, () => { if (detailRecord() === r) renderVersions(r); });
		let bits = [to.venue, to.year, target ? t(target.inLibrary ? "verOwned" : "verNotOwned") : t(held ? "verOwned" : "verGone")].filter(Boolean);
		tip(box, t(link.tip, to.doi || "") + "\n" + t(estimated ? "verEstimateTip" : "verExplicitTip"));
		box.appendChild(document.createTextNode(t(link.kind, estimated) + ": " + bits.join(" · ")));
		let action = (label, run, mark) => {
			box.appendChild(document.createTextNode(" · "));
			let go = document.createElement("button");
			go.type = "button"; go.className = "ghost";
			go.textContent = label;
			for (let [k, v] of Object.entries(mark || {})) go.setAttribute(k, v);
			go.addEventListener("click", run);
			box.appendChild(go);
		};
		if (target) { action(t("verShow"), () => revealRecord(target.key), { "data-safe": "view" }); return; }
		// Not among these results: the library's copy is selected in Zotero, and the version itself is a DOI away.
		let itemID = held ? heldVersionItem(to) : null;
		if (itemID != null) action(t("verShowLibrary"), () => selectHeld(itemID), { "data-opens": "library" });
		let doi = to.doi ? ZotPoPSources.normalizeDOI(to.doi) : null;
		if (doi) action(t("verOpenDoi"), () => Zotero.launchURL("https://doi.org/" + doi), { "data-opens": "browser" });
	}
	// The Zotero item that holds the other version, when it is known: by DOI at once, by title once asked.
	function heldVersionItem(to) {
		let doi = to.doi ? ZotPoPSources.normalizeDOI(to.doi) : null;
		if (doi && state.doiMap.has(doi)) return state.doiMap.get(doi);
		let found = state.heldVersions.get(doi || ("t:" + to.title + "|" + to.year));
		return typeof found === "number" ? found : null;
	}
	/* Whether the user's library holds the other version of a paper: true by DOI map at once; by title and
	   year (the import's own rule) asked once and remembered, calling again() when the answer arrives. */
	state.heldVersions = new Map();
	function heldVersion(to, again) {
		let doi = to.doi ? ZotPoPSources.normalizeDOI(to.doi) : null;
		if (doi && state.doiMap.has(doi)) return true;
		let id = doi || ("t:" + to.title + "|" + to.year);
		if (state.heldVersions.has(id)) { let v = state.heldVersions.get(id); return v === true || typeof v === "number"; }
		if (!to.title || typeof ZotPoPImporter.findByTitle !== "function") return false;
		state.heldVersions.set(id, null);
		// An answer about the library this lookup started in: one that arrives after the target changed is dropped.
		let generation = flagsGeneration, held = state.heldVersions;
		let current = () => generation === flagsGeneration && held === state.heldVersions;
		Promise.resolve(ZotPoPImporter.findByTitle(state.libraryID ?? currentTarget().libraryID, to.title, to.year, { doi: to.doi }))
			.then(found => { if (!current()) return; held.set(id, typeof found === "number" ? found : Boolean(found)); if (found) again(); })
			.catch(() => { if (current()) held.set(id, false); });
		return false;
	}
	// Opens another row and its detail in this window; a filter that hides it is let go first.
	function revealRecord(key) {
		if (!state.records.some(r => r.key === key)) return;
		if (!state.visible.some(r => r.key === key)) {
			resetFilters();
			state.libraryFilter = "all"; state.selectedOnly = false;
			syncFilterClear();
		}
		state.focusKey = state.detailKey = key;
		render();
		document.querySelector(`#results-body tr[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
		$("table-wrap").focus({ preventScroll: true });
	}

	// Re-query every free source for one paper's current citation count and its journal's impact
	/* A spent OpenAlex budget is remembered by the window until it resets
	   (midnight UTC), so the next search or check does not ask it again. */
	let openAlexSpentUntil = 0;
	const openAlexHeld = () => Date.now() < openAlexSpentUntil;
	function noteOpenAlexSpent(ctx) {
		if (!ctx?.openAlexSpent || openAlexHeld()) return;
		let d = new Date();
		openAlexSpentUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
	}

	async function checkCitations(r) {
		if (!r || state.checking) return;
		state.checking = true;
		setStatus(t("citeChecking"));
		try {
			let checked = r.popOriginal ? Object.assign({}, r) : r;
			let cctx = { email: PREF("email") || "", s2ApiKey: PREF("s2ApiKey") || "", openAlexApiKey: PREF("openAlexApiKey") || "", log, openAlexSpent: openAlexHeld() };
			let res = await ZotPoPSources.checkCitations(checked, http, cctx);
			noteOpenAlexSpent(cctx);
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
	/* A row's menu: the right button, or from the keyboard the context-menu key or Shift+F10 on the focused
	   row. It is a menu to assistive technology, its items are reached with the arrows and run with Enter or
	   Space, and Escape or Tab closes it and gives the keyboard back to the results. */
	function showCtxMenu(x, y, r) {
		let menu = $("ctxmenu");
		menu.textContent = "";
		menu.setAttribute("role", "menu");
		menu.setAttribute("aria-label", t("ctxMenuLabel", r.title || ""));
		let add = (label, fn, disabled) => {
			let d = document.createElement("div");
			d.textContent = label;
			d.setAttribute("role", "menuitem");
			d.tabIndex = -1;
			if (disabled) { d.className = "disabled"; d.setAttribute("aria-disabled", "true"); }
			else d.addEventListener("click", () => { hideCtxMenu(true); fn(); });
			menu.appendChild(d);
		};
		add(state.selected.has(r.key) ? t("ctxDeselect") : t("ctxSelect"), () => toggleSelect(r, !state.selected.has(r.key)));
		add(t("ctxAdd"), () => importRecords([r]), state.importing || state.searching);
		menu.appendChild(document.createElement("hr"));
		if (r.inLibrary) add(t("ctxRead"), () => readHeldPDF(r));
		add(t("ctxOpen"), () => Zotero.launchURL(r.url), !r.url);
		add(t("previewAction"), () => openPreview(r));
		add(t("ctxPdf"), () => Zotero.launchURL((r.pdfUrls || [])[0] || r.pdfUrl), !((r.pdfUrls || [])[0] || r.pdfUrl));
		add(t("ctxProxy"), () => openViaProxy(r), !(r.doi || r.url));
		menu.appendChild(document.createElement("hr"));
		add(t("ctxCopyTitle"), () => copyText(r.title, t("copiedTitle")));
		add(t("ctxCopyDoi"), () => copyText(r.doi, t("copiedDoi")), !r.doi);
		add(t("ctxCopyCite"), () => copyText(citationText(r), t("copiedCite")));
		menu.appendChild(document.createElement("hr"));
		if (personPick()) { let pick = personPick(), inside = inPick(pick, r); add(inside ? t("ctxNotPerson") : t("ctxIsPerson"), () => setPersonMembership(r, !inside)); }
		add(t("ctxCheck"), () => checkCitations(r), state.checking || !(r.doi || r.arxiv || r.pmid || (r.source === "openalex" && r.sourceId)));
		menu.hidden = false;
		let w = menu.offsetWidth, h = menu.offsetHeight;
		menu.style.left = Math.min(x, window.innerWidth - w - 6) + "px";
		menu.style.top = Math.min(y, window.innerHeight - h - 6) + "px";
		// The first item takes focus either way, so the arrows work after a right-click too.
		ctxItems()[0]?.focus?.();
	}
	const ctxItems = () => [...($("ctxmenu").querySelectorAll?.('[role="menuitem"]') || [])].filter(d => d.getAttribute("aria-disabled") !== "true");
	function onCtxMenuKey(e) {
		let items = ctxItems(), i = items.indexOf(document.activeElement);
		let go = n => { e.preventDefault(); e.stopPropagation(); items[(n + items.length) % items.length]?.focus?.(); };
		if (e.key === "ArrowDown") go(i + 1);
		else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(items.length - 1);
		else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); items[i]?.click?.(); }
		else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); hideCtxMenu(true); }
	}
	// returnFocus: the keyboard goes back to the results table, where the row is still the focused one.
	function hideCtxMenu(returnFocus = false) {
		let menu = $("ctxmenu");
		if (menu.hidden) return;
		let inside = Boolean(document.activeElement && menu.contains?.(document.activeElement));
		menu.hidden = true;
		if (returnFocus || inside) $("table-wrap")?.focus?.({ preventScroll: true });
	}
	// The context-menu key or Shift+F10 on the focused row opens its menu beside the row.
	function openRowMenuFromKeyboard() {
		let r = state.visible.find(row => row.key === state.focusKey);
		if (!r) return false;
		let tr = document.querySelector(`#results-body tr[data-key="${CSS.escape(r.key)}"]`);
		let box = tr?.getBoundingClientRect?.() || { left: 40, bottom: 120 };
		showCtxMenu(Math.round(box.left + 24), Math.round(box.bottom), r);
		return true;
	}

	// ------------------------------------------------------------ keyboard
	/* Every shortcut of the window, in one list: the overlay (? or View → Keyboard shortcuts) is drawn from it,
	   so a key added to onKeyDown is listed by adding it here. Mod is ⌘ on a Mac, Ctrl elsewhere. */
	const SHORTCUTS = [
		["Mod+Enter", "keyRunSearch"], ["Mod+F", "keyFilter"], ["\u2193", "keyFilterToList"],
		["\u2191 \u2193  PgUp PgDn  Home End", "keyMove"], ["Shift+\u2191 \u2193", "keyExtend"], ["Space", "keyTick"],
		["Mod+A", "keySelectAll"], ["Delete", "keyUntick"], ["Mod+Delete", "keyUntickAll"],
		["Enter", "keyOpen"], ["P", "keyPreview"], ["S", "keySort"], ["Shift+F10", "keyRowMenu"],
		["Mod+C", "keyCopyCite"], ["Shift+Mod+C", "keyCopyDoi"], ["Esc", "keyEscape"], ["Mod+W", "keyClose"], ["?", "keyHelp"]
	];
	const isMacKeys = () => { try { return Boolean(Zotero.isMac); } catch (e) { return false; } };
	const keyLabel = keys => keys.replace(/Mod\+/g, isMacKeys() ? "\u2318" : "Ctrl+").replace(/Shift\+/g, isMacKeys() ? "\u21e7" : "Shift+");
	let keysHelp = null; // { el, opener }
	function closeKeysHelp(returnFocus = true) {
		if (!keysHelp) return;
		let { el, opener } = keysHelp;
		keysHelp = null;
		el.remove ? el.remove() : el.parentNode?.removeChild(el);
		if (returnFocus) { if (opener?.focus && opener.isConnected !== false) opener.focus(); else $("table-wrap")?.focus?.(); }
	}
	function openKeysHelp(opener = document.activeElement) {
		if (keysHelp) { closeKeysHelp(true); return; }
		closeToolbarMenu(); closeSelMenu(); closeHistoryMenu(); hideCtxMenu();
		let el = fel("div", "keys-help");
		el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "keys-help-title");
		let card = fel("div", "keys-card");
		let head = fel("div", "keys-head");
		let title = fel("h2", "keys-title", t("keysTitle")); title.id = "keys-help-title";
		let close = fel("button", "ghost icon-btn small keys-close"); close.type = "button";
		close.setAttribute("aria-label", t("keysClose")); close.setAttribute("data-safe", "view"); tip(close, t("keysClose"));
		close.appendChild(iconNode("ic-close"));
		close.addEventListener("click", () => closeKeysHelp(true));
		head.appendChild(title); head.appendChild(close); card.appendChild(head);
		let list = fel("dl", "keys-list");
		for (let [keys, what] of SHORTCUTS) {
			let dt = fel("dt", ""), dd = fel("dd", "", t(what));
			for (let part of keyLabel(keys).split(/(\s{2,})/)) { if (/^\s+$/.test(part)) dt.appendChild(document.createTextNode(" ")); else if (part) dt.appendChild(fel("kbd", "", part)); }
			list.appendChild(dt); list.appendChild(dd);
		}
		card.appendChild(list);
		card.appendChild(fel("p", "keys-foot", t("keysFoot")));
		el.appendChild(card);
		// A press on the dimmed backdrop closes it; Tab stays on the one button inside.
		el.addEventListener("mousedown", e => { if (e.target === el) closeKeysHelp(true); });
		el.addEventListener("keydown", e => {
			if (e.key === "Escape" || e.key === "?") { e.preventDefault(); e.stopPropagation(); closeKeysHelp(true); }
			else if (e.key === "Tab") { e.preventDefault(); close.focus(); }
		});
		(document.body || document).appendChild(el);
		keysHelp = { el, opener };
		close.focus();
	}
	function onKeyDown(e) {
		// A key a menu, a list or a card has already handled is theirs: it does not also move the result rows.
		if (e.defaultPrevented) return;
		let mod = e.metaKey || e.ctrlKey;
		if (e.key === "Escape") {
			if (keysHelp) { closeKeysHelp(true); return; }
			if (state.filterOpen) { closeFilterPop(true); return; }
			if (openTbMenu) { closeToolbarMenu(true); return; }
			if (openSel) { closeSelMenu(); return; }
			if (!$("histmenu").hidden) { closeHistoryMenu(true); return; }
			if (!$("ctxmenu").hidden) { hideCtxMenu(true); return; }
			if (state.searching) { stopOperation(); return; }
			if (state.importing) {
				// One Esc, pressed to dismiss something that had already closed, used
				// to abort a batch add half-way. It takes two within a moment and a half.
				let now = Date.now();
				if (escapeArmed && now - escapeArmed < 1500) { escapeArmed = 0; stopOperation(); }
				else { escapeArmed = now; setStatus(t("escapeAgainToStop")); }
				return;
			}
			if (document.activeElement === $("filter") && ($("filter").value || state.facet || state.yearRange)) { clearFilter(); return; }
			if (document.activeElement === $("filter")) { $("table-wrap").focus(); return; }
			if (state.preview.on) { closePreview(); return; }
			if (state.detailKey) { state.detailKey = null; paintRows(); renderDetail(); return; }
			return;
		}
		if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("filter").focus(); $("filter").select(); return; }
		if (mod && e.key === "Enter") { e.preventDefault(); runSearch(); return; }
		if (mod && e.key.toLowerCase() === "w") { window.close(); return; }
		// Keys typed into a form field belong to that field, Cmd/Ctrl+A included: hijacking
		// it made select-all in the query boxes select every result row instead.
		if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
		if (e.key === "?" && !mod && !e.altKey) { e.preventDefault(); openKeysHelp(document.activeElement); return; }
		// Enter and Space on a focused button press that button (the statistics basis, say), not the focused result row.
		if (/^button$/i.test(document.activeElement?.tagName || "") && (e.key === "Enter" || e.key === " ")) return;
		/* Row keys belong to the table. Focus in the paper's detail (its buttons, the folded metadata) or on a
		   link or disclosure: Space, arrows, Page keys, Home/End, Enter and Delete do what they do there, they
		   do not pick, switch or untick result rows. */
		let active = document.activeElement, detail = $("detail");
		if (!mod && active && active !== detail && (detail?.contains?.(active) || /^(summary|a)$/i.test(active.tagName || ""))) return;
		// Nor inside a popup or on a control that opens one: there the arrows walk its own items.
		if (!mod && active && active !== $("table-wrap") && active.closest?.('[role="menu"], [role="listbox"], [role="dialog"], [aria-haspopup]')) return;
		if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && state.focusKey != null) { if (openRowMenuFromKeyboard()) e.preventDefault(); return; }
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); selectVisible(true); return; }
		if (mod && e.key.toLowerCase() === "c") {
			// Text the reader selected (a sentence of the abstract) is copied as text, by the platform.
			try { let picked = window.getSelection?.(); if (picked && !picked.isCollapsed && String(picked).trim()) return; } catch (err) { /* no selection API */ }
			// The focused row's citation, or with Shift its DOI: what a reader reaches for most.
			let r = state.visible.find(row => row.key === state.focusKey);
			if (!r) return;
			e.preventDefault();
			if (e.shiftKey) { if (r.doi) copyText(r.doi, t("copiedDoi")); }
			else copyText(citationText(r), t("copiedCite"));
			return;
		}
		if (!mod && !e.altKey && e.key.toLowerCase() === "p") { e.preventDefault(); togglePreview(); return; }
		if (!mod && !e.altKey && e.key.toLowerCase() === "s" && state.visible.length) { e.preventDefault(); openSortMenu(true); return; }
		if (!state.visible.length) return;
		let idx = state.visible.findIndex(r => r.key === state.focusKey);
		if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "PageDown" || e.key === "PageUp") {
			e.preventDefault();
			let step = e.key === "PageDown" ? 10 : e.key === "PageUp" ? -10 : e.key === "ArrowDown" ? 1 : -1;
			let next = Math.max(0, Math.min(state.visible.length - 1, idx < 0 ? 0 : idx + step));
			let r = state.visible[next];
			/* Shift extends a range from where it began, as in every list: the
			   starting row is in it, and going back shrinks it. It used to add
			   only the row arrived at, and never took one away. */
			if (e.shiftKey) {
				if (state.anchorKey == null || !state.visible.some(v => v.key === state.anchorKey)) state.anchorKey = idx >= 0 ? state.visible[idx].key : r.key;
				let from = state.visible.findIndex(v => v.key === state.anchorKey);
				if (state.rangeKeys) for (let key of state.rangeKeys) state.selected.delete(key);
				let lo = Math.min(from, next), hi = Math.max(from, next);
				state.rangeKeys = state.visible.slice(lo, hi + 1).map(v => v.key);
				for (let key of state.rangeKeys) state.selected.add(key);
			}
			else { state.anchorKey = null; state.rangeKeys = null; }
			state.focusKey = r.key;
			state.detailKey = r.key;
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
			readRecord(state.visible[idx]);
		}
	}

	// ------------------------------------------------------------ export
	function copyText(text, msg) {
		Zotero.Utilities.Internal.copyTextToClipboard(String(text || ""));
		setStatus(msg || t("copied"), "", { transient: true });
	}

	// One person's institution, country and h-index, from the same record: values of two labs are never mixed.
	const personCells = p => [p?.institution ?? "", p?.country ?? "", p?.hIndex ?? ""];
	/* The corresponding author's columns, and on what basis: flagged by the source, or the last author
	   assumed because nobody was flagged. A first author flagged corresponding is the corresponding author
	   too, though the row shows them once. */
	function correspondingCells(aff) {
		if (!aff) return [...personCells(null), ""];
		let who = aff.corresponding || (aff.correspondingKnown ? aff.first : null);
		if (!who) return [...personCells(null), ""];
		return [...personCells(who), t(aff.correspondingKnown ? "csvCorrFlagged" : "csvCorrLastAuthor")];
	}
	function csvText() {
		// A cell that starts with = + - or @ is a formula to Excel and LibreOffice ("=HYPERLINK(...)" in a
		// scraped title runs on open); a leading apostrophe keeps it text. Numbers are left as numbers.
		let esc = v => {
			let s = String(v == null ? "" : v);
			if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
			return '"' + s.replace(/"/g, '""') + '"';
		};
		let lines = [t("csvHead").join(",")];
		for (let r of state.visible) {
			let cpy = ZotPoPMetrics.citesPerYear(r);
			lines.push([
				r.citations ?? "", cpy == null || !Number.isFinite(cpy) ? "" : fmt(cpy), r.popOriginal ? r.popRank : r.rank, r.authorString, r.title,
				r.year ?? "", r.venue, r.journalIF == null ? "" : fmt(r.journalIF, 2), r.journalIF == null ? "" : (r.journalIFSource || "JCR"), r.journalOA2y == null ? "" : fmt(r.journalOA2y, 2),
				...personCells(affiliationOf(r)?.first), ...correspondingCells(affiliationOf(r)),
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
			// UTF-8 BOM so Excel opens Korean text correctly
			let path = await writeUniqueFile(desktopPath(), `zotpop-${stamp}`, ".csv", "\uFEFF" + csvText());
			setStatus(t("csvSaved", path));
			try { Zotero.File.reveal(Zotero.File.pathToFile(path)); } catch (e) { log("reveal failed: " + e.message); }
		}
		catch (e) {
			Zotero.logError(e);
			setStatus(t("csvSaveFailed", e.message || e), "err");
		}
	}

	/* An export never replaces an earlier one: the name gets -2, -3 ... on collision. The existence check
	   is only a first guess, so the write itself refuses to overwrite and a collision found there
	   (another export, another program) moves on to the next name. */
	async function writeUniqueFile(dir, base, ext, text) {
		for (let n = 1; n <= 500; n++) {
			let path = PathUtils.join(dir, n === 1 ? base + ext : `${base}-${n}${ext}`);
			if (await IOUtils.exists(path)) continue;
			try {
				await IOUtils.writeUTF8(path, text, { noOverwrite: true });
				return path;
			}
			catch (e) {
				if (!/NoModificationAllowed|exists/i.test(`${e?.name} ${e?.message}`)) throw e;
			}
		}
		throw new Error("no free file name for " + base + ext);
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
	// A failed or half-done row carries a dot ahead of its title, so it shows even where the Status column is scrolled out of view.
	function paintRowDot(main, r) {
		if (!main) return;
		for (let old of [...(main.querySelectorAll?.(".row-dot") || [])]) old.remove?.();
		if (!r.status || (r.statusClass !== "err" && r.statusClass !== "warn")) return;
		let dot = document.createElement("span"); dot.className = "row-dot " + r.statusClass; dot.setAttribute("role", "img");
		dot.setAttribute("aria-label", r.status); tip(dot, r.status + (r.statusTitle ? " \u00b7 " + r.statusTitle : ""));
		main.insertBefore(dot, main.firstChild);
	}
	function setRowStatus(r, text, cls, title) {
		r.status = text;
		r.statusClass = cls;
		r.statusTitle = title || "";
		if (text) applyColumnView();
		let tr = document.querySelector(`#results-body tr[data-key="${CSS.escape(r.key)}"]`);
		if (!tr) return;
		paintRowDot(tr.querySelector(".t-main"), r);
		let td = tr.querySelector("td.status");
		if (td) {
			td.textContent = text; td.className = "status " + (cls || ""); tip(td, title || "");
			marquee?.refreshCell(td);
		}
		if (r.inLibrary) {
			tr.classList.add("in-library");
			let lib = tr.querySelector("td.lib");
			if (lib) { let rs = lib.querySelector(".read-state"); lib.textContent = ""; let ck = document.createElement("span"); ck.className = "pill pos"; ck.textContent = "✓"; lib.appendChild(ck); if (rs) lib.appendChild(rs); }
		}
	}

	/* Style Custom's reading queue, when that plugin offers it; every control for it stays hidden otherwise. */
	const queueApi = () => { let sc = Zotero.StyleCustom; return sc && typeof sc.queueForReading === "function" ? sc : null; };
	function isQueuedItem(item) {
		try { let sc = Zotero.StyleCustom; return Boolean(item && typeof sc?.isQueued === "function" && sc.isQueued(item)); }
		catch (e) { return false; }
	}
	function libraryItemOf(r) {
		try { return r?.libraryItemID ? Zotero.Items.get(r.libraryItemID) || null : null; } catch (e) { return null; }
	}
	function queueQueryText() {
		try { return state.queryText || history?.describe(readQuery()) || ""; } catch (e) { return state.queryText || ""; }
	}
	async function queueItems(items) {
		let sc = queueApi();
		if (!sc || !items.length) return 0;
		try {
			await sc.queueForReading(items, { reason: t("queueReason", queueQueryText()), source: "zotpop" });
			return items.length;
		}
		catch (e) { log("queueForReading failed: " + (e.message || e)); return -1; }
	}
	function syncQueueButton(r) {
		let btn = $("d-queue"), api = queueApi();
		btn.hidden = !api;
		if (!api) return;
		let item = r.inLibrary ? libraryItemOf(r) : null, queued = Boolean(item && isQueuedItem(item));
		$("d-queue-label").textContent = t(queued ? "dQueued" : r.inLibrary ? "dQueue" : "dAddQueue");
		btn.setAttribute("aria-pressed", String(queued));
		btn.disabled = queued || (!r.inLibrary && (state.importing || state.searching)) || (r.inLibrary && !item);
	}
	async function queueDetail() {
		let r = detailRecord();
		if (!r || !queueApi()) return;
		if (!r.inLibrary) { await importRecords([r], { queue: true }); return; }
		let item = libraryItemOf(r);
		if (!item || isQueuedItem(item)) return;
		let n = await queueItems([item]);
		setStatus(n > 0 ? t("queuedN", n) : t("queueFailed"), n > 0 ? "" : "err", { transient: n > 0 });
		if (detailRecord() === r) syncQueueButton(r);
	}

	async function importRecords(recs, { queue } = {}) {
		if (state.importing || state.searching || !recs.length) return;
		let { libraryID, collections } = currentTarget();
		let opts = {
			libraryID, collections,
			attachPDF: $("opt-pdf").checked,
			fillMissingPDF: $("opt-fillpdf").checked,
			skipDuplicates: $("opt-skip").checked,
			citationsInExtra: $("opt-extra").checked,
			http, email: PREF("email") || "", proxyPrefix: PREF("proxyPrefix") || "", log
		};
		let wantQueue = Boolean(queueApi() && (queue === undefined ? $("opt-queue").checked : queue)), toQueue = [];
		state.importing = true;
		state.cancelled = false;
		// The destination is fixed for the run: switched half-way, A's papers were marked as held in B.
		$("target").disabled = true; syncSel($("target"));
		$("import-btn").disabled = true;
		$("search-btn").disabled = true;
		$("stop-btn").disabled = false;
		$("d-primary").disabled = true;
		let added = 0, exists = 0, failed = 0, pdfs = 0, pdfMissedCount = 0, proxyLoginNeeded = false;
		let failedRecs = [];
		setProgress(0, recs.length);
		for (let i = 0; i < recs.length; i++) {
			if (state.cancelled) break;
			let r = recs[i];
			setStatus(t("adding", i + 1, recs.length, r.title.slice(0, 70)));
			setRowStatus(r, t("statusAdding"), "");
			// The abstract the user translated here, kept as a child note when asked.
			let translatedNote = null;
			if ($("opt-trnote").checked && translator && r.abstract) {
				let lang = ZotPoPTranslate.byCode(trLang()), done = lang && translator.cached(r.key, lang.code, "abstract", r.abstract);
				if (done) translatedNote = { heading: t("noteTranslatedTitle", lang.name), text: done.text, service: done.service };
			}
			let res = await ZotPoPImporter.importRecord(r, translatedNote ? Object.assign({}, opts, { translatedNote }) : opts);
			if (res.status === "added") {
				added++;
				if (res.item) toQueue.push(res.item);
				r.inLibrary = true;
				r.libraryItemID = res.item?.id;
				if (r.doi) state.doiMap.set(r.doi, res.item.id);
				relatedNowHeld(r, res.item?.id);
				let gotPDF = res.pdf.startsWith("pdf");
				if (res.proxyLoginNeeded) proxyLoginNeeded = true;
				if (gotPDF) pdfs++;
				// Saved, only its PDF missing: not the same as a paper that failed.
				let pdfMissed = res.pdf === "no pdf";
				if (pdfMissed) pdfMissedCount++;
				let label = res.pdf === "skipped" ? t("statusAdded")
					: res.pdf === "pdf:proxy" ? t("statusAddedProxy")
					: gotPDF ? t("statusAddedPdf") : t("statusAddedNoPdf");
				if (res.warnings?.length) setRowStatus(r, label + " · " + t("statusPartSaved"), "warn", t("tipPartSaved"));
				else if (pdfMissed) setRowStatus(r, label, "warn", t("tipPdfMissed"));
				else setRowStatus(r, label, "ok", res.how === "manual" ? t("tipManual") : t("tipTranslator"));
			}
			else if (res.status === "exists") {
				exists++;
				if (res.item) toQueue.push(res.item);
				r.inLibrary = true;
				// The tick then leads to the copy found, whether or not it has a DOI.
				r.libraryItemID = res.item?.id;
				let filled = String(res.pdf || "").startsWith("pdf");
				if (filled) pdfs++;
				if (r.doi && res.item?.id != null) state.doiMap.set(r.doi, res.item.id);
				relatedNowHeld(r, res.item?.id);
				// Held already: filed where asked (or its PDF filled) is what the add was for; nothing to warn about either way.
				setRowStatus(r, (res.addedToCollection ? t("statusExistsFiled") : t("statusExists")) + (filled ? " · " + t("statusPdfFilled") : ""), filled || res.addedToCollection ? "ok" : "");
			}
			else {
				failed++;
				failedRecs.push(r);
				setRowStatus(r, t("statusFailed"), "err", res.error);
				// A failure is selected even if it was added from the detail alone, so it is there to retry.
				state.selected.add(r.key);
			}
			// What got in is let go.
			if (res.status === "added" || res.status === "exists") state.selected.delete(r.key);
			setProgress(i + 1, recs.length);
		}
		state.importing = false;
		$("target").disabled = false; syncSel($("target"));
		$("search-btn").disabled = false;
		$("stop-btn").disabled = true;
		setProgress(null);
		// Redrawn, not just repainted: an added paper leaves "not owned", and the counts say so.
		render();
		let queued = wantQueue ? await queueItems(toQueue.filter(item => !isQueuedItem(item))) : 0;
		/* Where the papers are filed now and their reading state, for the detail: read again, not guessed. Only the rows
		   just added or filed are asked; their held mark is the import's own answer. After the queue, so its state is the new one. */
		let touched = recs.filter(r => r.inLibrary && r.libraryItemID);
		if (touched.length && await readHeldDetails(touched).catch(() => false)) render();
		setStatus(t("importDone", added, pdfs, exists, failed, state.cancelled) + (queued > 0 ? " · " + t("queuedN", queued) : ""));
		if (queued < 0) showBanner(t("queueFailed"), null, { warn: true });
		if (failed) showBanner(pdfMissedCount ? t("importFailuresPdf", failed, pdfMissedCount) : t("importFailures", failed), { label: t("importRetry", failed), run: () => { hideBanner(); importRecords(failedRecs, { queue: wantQueue }); } }, { warn: true });
		else if (pdfMissedCount) showBanner(t("importPdfMissed", pdfMissedCount), null, { warn: true });
		else if (proxyLoginNeeded) showBanner(t("loginNeeded"), null, { warn: true });
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
