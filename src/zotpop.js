/* global Zotero */
"use strict";

Zotero.ZotPoP = {
	id: null,
	version: null,
	rootURI: null,
	_window: null,
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
		item.addEventListener("command", () => this.openSearchWindow(window));
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
		btn.style.setProperty("-moz-context-properties", "fill, fill-opacity");
		btn.style.fill = "currentColor";
		btn.addEventListener("command", () => this.openSearchWindow(window));
		let anchor = doc.getElementById("zotero-tb-lookup");
		if (anchor && anchor.parentElement === toolbar) anchor.after(btn);
		else toolbar.appendChild(btn);
		return "ok";
	},

	removeFromWindow(window) {
		window.document.getElementById("zotpop-menuitem")?.remove();
		window.document.getElementById("zotpop-toolbar-button")?.remove();
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
