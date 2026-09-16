/* global Zotero, Services */
"use strict";

var focusPlugin = null;
var focusScope = null;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  // Zotero already gives each plugin its own bootstrap sandbox. Load into that
  // real global: a plain object target does not become globalThis for subscript
  // exports. Zotero also owns and destroys this sandbox after shutdown.
  focusScope = globalThis;
  try {
    for (const file of ["model", "marquee", "runtime"]) {
      Services.scriptloader.loadSubScript(rootURI + "src/" + file + ".js", focusScope);
    }
    focusPlugin = new focusScope.ZoteroFocusRuntime({
      Zotero,
      model: focusScope.ZoteroFocusModel,
      marquee: focusScope.ZoteroFocusMarquee
    });
    await focusPlugin.start({ id, version, rootURI });
    for (const window of Zotero.getMainWindows()) focusPlugin.addWindow(window);
  }
  catch (error) {
    await shutdown();
    Zotero.logError(error);
    throw error;
  }
}

function onMainWindowLoad({ window }) { focusPlugin?.addWindow(window); }
function onMainWindowUnload({ window }) { focusPlugin?.removeWindow(window); }

async function shutdown() {
  try { await focusPlugin?.stop(); }
  finally {
    focusPlugin = null;
    focusScope = null;
  }
}
