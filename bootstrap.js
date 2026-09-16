/* global Zotero, Services, Components */
"use strict";

var chromeHandle = null;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
	// Register chrome://zotpop/content/ so the search window opens with chrome privileges
	var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	var manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zotpop", rootURI + "content/"]
	]);

	Services.scriptloader.loadSubScript(rootURI + "content/i18n.js", Zotero);
	Services.scriptloader.loadSubScript(rootURI + "src/zotpop.js");
	await Zotero.ZotPoP.init({ id, version, rootURI });

	for (let win of Zotero.getMainWindows()) {
		Zotero.ZotPoP.addToWindow(win);
	}
}

function onMainWindowLoad({ window }) {
	Zotero.ZotPoP?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Zotero.ZotPoP?.removeFromWindow(window);
}

function shutdown() {
	if (Zotero.ZotPoP) {
		Zotero.ZotPoP.shutdown();
		delete Zotero.ZotPoP;
	}
	// i18n.js is loaded with Zotero as its global, so its export outlives the plugin object
	delete Zotero.ZotPoPI18N;
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}
