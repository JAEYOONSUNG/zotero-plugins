/* global Zotero */
"use strict";

Zotero.ZotPoP = {
	_prefill: null,
	takePrefill() { let p = this._prefill; this._prefill = null; return p; },
	id: null,
	version: null,
	rootURI: null,
	_window: null,
	_tabID: null,
	_loginWindow: null,
	_prefPaneID: null,

	t(key) {
		try {
			let locale = Zotero.ZotPoPI18N.resolveLocale(
				Zotero.Prefs.get("extensions.zotpop.language", true) || "en",
				Zotero.locale
			);
			return Zotero.ZotPoPI18N.make(locale)(key);
		}
		catch (e) {
			return key;
		}
	},

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		// The journal registry shared with Style Custom: a publisher, JCR
		// abbreviation and quartile for every JCR journal, so a result whose
		// source says nothing about its publisher still gets the house colour.
		try {
			let registry = await Zotero.HTTP.request("GET", rootURI + "content/journal-registry.json", { responseType: "json" });
			if (registry && registry.response && Zotero.ZotPoPJournalMarks && Zotero.ZotPoPJournalMarks.loadRegistry) {
				Zotero.ZotPoPJournalMarks.loadRegistry(registry.response);
			}
		}
		catch (e) { Zotero.debug("ZotPoP: journal registry not loaded: " + (e && e.message)); }
		try {
			this._prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: id,
				src: rootURI + "content/preferences.xhtml",
				label: "ZotPoP",
				image: rootURI + "content/icons/zotpop-toolbar.svg"
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
		// A copy installed once from a file keeps itself current from the
		// GitHub feed named in the manifest. See content/updater.js.
		try { this.updater = await this.createUpdater(); if (this.updater) this.updater.start(); }
		catch (e) { Zotero.logError(e); }
		Zotero.debug(`ZotPoP ${version} initialized`);
	},

	async createUpdater() {
		let Updater = typeof PluginUpdater !== "undefined" ? PluginUpdater : null;
		if (!Updater || !this.id || !this.rootURI) return null;
		let manifest = await Zotero.HTTP.request("GET", this.rootURI + "manifest.json", { responseType: "json" });
		let updateURL = manifest?.response?.applications?.zotero?.update_url;
		if (!/^https:\/\//.test(String(updateURL || ""))) return null;
		return Updater.create({
			id: this.id, version: this.version, updateURL, appVersion: Zotero.version,
			request: async url => (await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 20000, errorDelayMax: 0 })).response,
			install: entry => this.installAddon(entry),
			compare: (a, b) => typeof Services !== "undefined" && Services.vc ? Services.vc.compare(a, b) : Updater.compareVersions(a, b),
			prefs: {
				get: name => Zotero.Prefs.get("extensions.zotpop." + name, true),
				set: (name, value) => Zotero.Prefs.set("extensions.zotpop." + name, value, true)
			},
			// An upgrade reloads the plugin and closes its windows: not in the
			// middle of a search or a session the user is signing in to.
			busy: () => !!(this._window && !this._window.closed) || !!this._tabID
				|| !!(this._loginWindow && !this._loginWindow.closed) || !!(this._scholarWindow && !this._scholarWindow.closed),
			log: message => Zotero.debug("ZotPoP: " + message)
		});
	},

	// Zotero's own add-on manager fetches the file, checks it against the
	// feed's hash and swaps it in; a bootstrapped plugin needs no restart.
	async installAddon(entry) {
		let { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
		let install = await AddonManager.getInstallForURL(entry.update_link, { hash: entry.update_hash, name: "ZotPoP", version: entry.version });
		await new Promise((resolve, reject) => {
			let fail = what => () => reject(new Error(what + (install.error ? " (" + install.error + ")" : "")));
			install.addListener({
				onInstallEnded: () => resolve(), onInstallFailed: fail("install failed"), onDownloadFailed: fail("download failed"),
				onInstallCancelled: fail("install cancelled"), onDownloadCancelled: fail("download cancelled")
			});
			install.install();
		});
	},

	// The preferences pane: what the last check found, and a check on demand.
	updateStatusText(result) {
		if (!result) return this.t("updateStatusNever");
		let when = result.at ? " · " + new Date(result.at).toLocaleString() : "";
		let t = this.t.bind(this);
		let text = result.status === "current" ? t("updateStatusCurrent")(result.version)
			: result.status === "installed" ? t("updateStatusInstalled")(result.latest)
			: result.status === "deferred" ? t("updateStatusDeferred")(result.latest)
			: result.status === "error" ? t("updateStatusError")(result.message || "")
			: result.status === "off" ? t("updateStatusOff")
			: t("updateStatusNever");
		return text + when;
	},

	async checkUpdatesNow(doc) {
		let label = doc.getElementById("zotpop-update-status");
		if (!this.updater) { if (label) label.value = this.t("updateStatusNoFeed"); return; }
		if (label) label.value = this.t("updateChecking");
		let result = await this.updater.run({ reason: "user", force: true });
		if (label) label.value = this.updateStatusText(result);
	},

	// Fill a preference pane: data-i18n (text), data-i18n-value / data-i18n-label (XUL attributes)
	localizePrefs(doc) {
		try {
			for (let el of doc.querySelectorAll("[data-i18n]")) el.textContent = this.t(el.getAttribute("data-i18n"));
			for (let el of doc.querySelectorAll("[data-i18n-value]")) el.setAttribute("value", this.t(el.getAttribute("data-i18n-value")));
			for (let el of doc.querySelectorAll("[data-i18n-label]")) el.setAttribute("label", this.t(el.getAttribute("data-i18n-label")));
			let status = doc.getElementById("zotpop-update-status");
			if (status) status.value = this.updateStatusText(this.updater ? this.updater.lastResult() : null);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	// Scholar inside Zotero: the page that refused, in a window that shares
	// Zotero's cookies, so a CAPTCHA answered or an account signed in there
	// counts for every request the plugin makes afterwards.
	openScholarSession(url) {
		if (this._scholarWindow && !this._scholarWindow.closed) { this._scholarWindow.focus(); return this._scholarWindow; }
		let opener = Zotero.getMainWindow();
		let target = /^https:\/\/scholar\.google\./i.test(String(url || "")) ? url : "https://scholar.google.com/";
		this._scholarWindow = opener.openDialog(
			"chrome://zotpop/content/proxylogin.xhtml",
			"zotpop-scholar-session",
			"chrome,centerscreen,resizable=yes,dialog=no,width=1000,height=780",
			{ Zotero, plugin: this, mode: "scholar", url: target }
		);
		return this._scholarWindow;
	},

	openProxyLogin() {
		if (this._loginWindow && !this._loginWindow.closed) {
			this._loginWindow.focus();
			return this._loginWindow;
		}
		let opener = Zotero.getMainWindow();
		this._loginWindow = opener.openDialog(
			"chrome://zotpop/content/proxylogin.xhtml",
			"zotpop-proxy-login",
			"chrome,centerscreen,resizable=yes,dialog=no,width=1000,height=780",
			{ Zotero, plugin: this }
		);
		return this._loginWindow;
	},

	setProxyPrefix(doc, value) {
		Zotero.Prefs.set("extensions.zotpop.proxyPrefix", value, true);
		let input = doc.getElementById("zotpop-proxy");
		if (input) {
			input.value = value;
			input.dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
		}
	},

	addToWindow(window) {
		let menu = this._addMenuItem(window);
		let toolbar = this._addToolbarButton(window);
		Zotero.debug(`ZotPoP: window UI added (menu=${menu}, toolbar=${toolbar})`);
	},

	_addMenuItem(window) {
		let doc = window.document;
		if (doc.getElementById("zotpop-menuitem")) return "already";
		let popup = doc.getElementById("menu_ToolsPopup");
		if (!popup) return "no Tools menu";
		let item = doc.createXULElement("menuitem");
		item.id = "zotpop-menuitem";
		item.setAttribute("label", this.t("menuLabel"));
		// Every other plugin's entry in this menu carries a sign; an unmarked
		// line reads as a separator between them.
		item.classList.add("menuitem-iconic");
		item.setAttribute("image", "data:image/svg+xml;utf8," + encodeURIComponent(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">'
			+ '<circle cx="7" cy="7" r="4.2"/><line x1="10.1" y1="10.1" x2="13.4" y2="13.4"/></svg>'));
		item.addEventListener("command", () => this.openSearch(window));
		popup.appendChild(item);
		return "ok";
	},

	_addToolbarButton(window) {
		let doc = window.document;
		if (doc.getElementById("zotpop-toolbar-button")) return "already";
		let toolbar = doc.getElementById("zotero-items-toolbar")
			|| doc.getElementById("zotero-tb-lookup")?.parentElement;
		if (!toolbar) return "no toolbar";
		let btn = doc.createXULElement("toolbarbutton");
		btn.id = "zotpop-toolbar-button";
		btn.className = "zotero-tb-button";
		btn.setAttribute("tooltiptext", this.t("toolbarTip"));
		btn.setAttribute("image", "chrome://zotpop/content/icons/zotpop-toolbar.svg");
		// The icon carries its own colours now, so it must not be repainted in
		// the toolbar's text colour the way a context-fill glyph is.
		btn.addEventListener("command", () => this.openSearch(window));
		/* At the right-hand end of the tools, after the note button.

		   It used to sit second, between Zotero's lookup and its attachment
		   button, which put a plugin in the middle of the program's own tools.
		   Both plugins now group at the end, in a fixed order. */
		let anchor = doc.getElementById("zotero-tb-note-add")
			|| doc.getElementById("zotero-tb-attachment-add")
			|| doc.getElementById("zotero-tb-lookup");
		if (anchor && anchor.parentElement === toolbar) anchor.after(btn);
		else toolbar.appendChild(btn);
		return "ok";
	},

	removeFromWindow(window) {
		window.document.getElementById("zotpop-menuitem")?.remove();
		window.document.getElementById("zotpop-toolbar-button")?.remove();
	},

	/* prefill: {title, authors, year, doi} from a row in the item list, so the
	   tab opens on that paper's search rather than empty. The form reads it
	   once and clears it; a second open with nothing passed is a plain open. */
	openSearch(mainWindow, prefill) {
		if (prefill && typeof prefill === "object") this._prefill = prefill;
		let win = mainWindow || Zotero.getMainWindow();
		let Tabs = win && win.Zotero_Tabs;
		// Older builds have no tab API; a window is better than nothing.
		if (!Tabs || typeof Tabs.add !== "function") return this.openSearchWindow(win);
		let doc = win.document;
		if (this._tabID && doc.getElementById(this._tabID)) {
			Tabs.select(this._tabID);
			// The tab is already open: tell it there is a new query to run.
			try {
				let browser = doc.getElementById(this._tabID)?.querySelector("browser");
				browser?.contentWindow?.dispatchEvent(new browser.contentWindow.CustomEvent("zotpop-prefill"));
			}
			catch (e) { Zotero.logError(e); }
			return this._tabID;
		}
		let added;
		try {
			added = Tabs.add({
				type: "zotpop-search",
				title: this.t("toolbarTip"),
				// The tab bar reads data.icon directly (without a data object it
				// throws before the tab is shown) and renders it as an item-type
				// icon, so the value has to be one Zotero's skin actually styles.
				// "magnifier" is not, and drew an empty slot.
				data: { icon: "journalArticle" },
				select: true,
				onClose: () => { this._tabID = null; }
			});
		}
		catch (e) {
			Zotero.logError(e);
			return this.openSearchWindow(win);
		}
		this._tabID = added.id;
		let browser = doc.createXULElement("browser");
		browser.setAttribute("type", "content");
		browser.setAttribute("flex", "1");
		browser.setAttribute("disableglobalhistory", "true");
		browser.setAttribute("src", "chrome://zotpop/content/search.xhtml");
		browser.style.width = "100%";
		browser.style.height = "100%";
		added.container.appendChild(browser);
		return this._tabID;
	},

	closeSearchTab(mainWindow) {
		let win = mainWindow || Zotero.getMainWindow();
		if (this._tabID && win && win.Zotero_Tabs) {
			try { win.Zotero_Tabs.close(this._tabID); } catch (e) { Zotero.logError(e); }
		}
		this._tabID = null;
	},

	openSearchWindow(mainWindow) {
		if (this._window && !this._window.closed) {
			this._window.focus();
			return this._window;
		}
		let opener = mainWindow || Zotero.getMainWindow();
		let features = ["chrome", "resizable=yes", "dialog=no"];
		let num = (k, min, max, fallback) => {
			let v = parseInt(Zotero.Prefs.get("extensions.zotpop." + k, true), 10);
			return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
		};
		let width = num("winWidth", 700, 6000, 1440);
		let height = num("winHeight", 500, 4000, 900);
		features.push("width=" + width, "height=" + height);
		let left = num("winLeft", -8000, 8000, null);
		let top = num("winTop", -8000, 8000, null);
		if (left !== null && top !== null) features.push("left=" + left, "top=" + top);
		else features.push("centerscreen");
		this._window = opener.openDialog(
			"chrome://zotpop/content/search.xhtml",
			"zotpop-search",
			features.join(","),
			{ Zotero, plugin: this, mainWindow: opener }
		);
		return this._window;
	},

	shutdown() {
		try { this.updater?.stop(); } catch (e) {}
		this.updater = null;
		this.closeSearchTab();
		if (this._window && !this._window.closed) this._window.close();
		this._window = null;
		if (this._loginWindow && !this._loginWindow.closed) this._loginWindow.close();
		this._loginWindow = null;
		for (let win of Zotero.getMainWindows()) this.removeFromWindow(win);
		if (this._prefPaneID) {
			try { Zotero.PreferencePanes.unregister(this._prefPaneID); } catch (e) {}
		}
	}
};
