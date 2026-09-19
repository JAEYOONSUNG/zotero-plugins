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
		Zotero.debug(`ZotPoP ${version} initialized`);
	},

	// Fill a preference pane: data-i18n (text), data-i18n-value / data-i18n-label (XUL attributes)
	localizePrefs(doc) {
		try {
			for (let el of doc.querySelectorAll("[data-i18n]")) el.textContent = this.t(el.getAttribute("data-i18n"));
			for (let el of doc.querySelectorAll("[data-i18n-value]")) el.setAttribute("value", this.t(el.getAttribute("data-i18n-value")));
			for (let el of doc.querySelectorAll("[data-i18n-label]")) el.setAttribute("label", this.t(el.getAttribute("data-i18n-label")));
		}
		catch (e) {
			Zotero.logError(e);
		}
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
