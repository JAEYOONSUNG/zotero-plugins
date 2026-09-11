/* global Zotero */
"use strict";

Zotero.ZotPoP = {
	id: null,
	version: null,
	rootURI: null,
	_window: null,
	_prefPaneID: null,

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		try {
			this._prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: id,
				src: rootURI + "content/preferences.xhtml",
				label: "ZotPoP",
				image: rootURI + "content/icon.svg"
			});
		}
		catch (e) {
			Zotero.logError(e);
		}
		Zotero.debug(`ZotPoP ${version} initialized`);
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
		item.setAttribute("label", "\uB17C\uBB38 \uAC80\uC0C9 & \uAC00\uC838\uC624\uAE30 (Publish or Perish)\u2026");
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
		btn.setAttribute("tooltiptext", "\uB17C\uBB38 \uAC80\uC0C9 & \uAC00\uC838\uC624\uAE30 (Publish or Perish)");
		btn.setAttribute("image", "chrome://zotpop/content/icon.svg");
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
		for (let win of Zotero.getMainWindows()) this.removeFromWindow(win);
		if (this._prefPaneID) {
			try { Zotero.PreferencePanes.unregister(this._prefPaneID); } catch (e) {}
		}
	}
};
