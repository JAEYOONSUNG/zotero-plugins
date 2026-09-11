/* global Zotero, Services */
"use strict";

var focusPlugin = null;
var focusScope = null;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  focusScope = { Zotero };
  for (const file of ["model", "marquee", "runtime"]) {
    Services.scriptloader.loadSubScript(rootURI + "src/" + file + ".js", focusScope);
  }
  focusPlugin = new focusScope.ZoteroFocusRuntime({
    Zotero,
    model: focusScope.ZoteroFocusModel,
    marquee: focusScope.ZoteroFocusMarquee
  });
  try {
    await focusPlugin.start({ id, version, rootURI });
    for (const window of Zotero.getMainWindows()) focusPlugin.addWindow(window);
  }
  catch (error) {
    await focusPlugin.stop();
    focusPlugin = null;
    focusScope = null;
    Zotero.logError(error);
    throw error;
  }
}

function onMainWindowLoad({ window }) { focusPlugin?.addWindow(window); }
function onMainWindowUnload({ window }) { focusPlugin?.removeWindow(window); }

async function shutdown() {
  try { await focusPlugin?.stop(); }
  finally { focusPlugin = null; focusScope = null; }
}
