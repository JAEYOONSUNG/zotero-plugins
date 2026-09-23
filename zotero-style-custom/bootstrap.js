/* global Zotero, Services, IOUtils, PathUtils */
"use strict";
var customStyle = null;
// Where a reader puts journal figures their institution licenses to them. Nothing in
// this folder is ever packaged into the archive or published.
const JOURNAL_OVERLAY_DIR = "style-custom-journals";
var readerWindowObserver = null;
function install() {}
function uninstall() {}
async function startup({ id, version, rootURI }) {
  try {
    await Zotero.initializationPromise;
    for (const name of ["settings-schema", "data", "journals", "citations", "citation-formats", "supplementary", "discover", "paper-signals", "legacy-reading", "journal-metrics", "i18n", "strings", "author-portrait", "attachment-kinds", "item-kinds", "patents", "journal-identity", "jcr-categories", "jcr-browser", "affiliations", "paper-graph", "reading-path", "failures", "brand-icons", "selfcheck", "workspace", "assist", "library", "reader-tools", "workbench", "marquee", "reading", "updater", "runtime"]) {
      Services.scriptloader.loadSubScript(rootURI + "src/" + name + ".js", globalThis);
    }
    const path = PathUtils.join(Zotero.DataDirectory.dir, "style-custom.json");
    let legacy = {};
    try {
      const oldPath = PathUtils.join(Zotero.DataDirectory.dir, "zoterostyle.json");
      if (await IOUtils.exists(oldPath) && (await IOUtils.stat(oldPath)).size <= 50 * 1024 * 1024) legacy = JSON.parse(await IOUtils.readUTF8(oldPath));
    } catch (error) { Zotero.logError(error); }
    // Journal figures arrive in two layers. The plugin ships only what it may pass on:
    // OpenAlex, which is CC0. Licensed figures -- a Journal Citation Reports export the
    // reader's institution entitles them to -- are never packaged and never published;
    // they are read from this folder in the Zotero data directory, and where one exists
    // it wins, so a subscriber keeps seeing their own numbers.
    const journalDir = PathUtils.join(Zotero.DataDirectory.dir, JOURNAL_OVERLAY_DIR);
    const journalLayers = {};
    const localJournalData = async name => {
      try {
        const file = PathUtils.join(journalDir, name);
        if (!await IOUtils.exists(file)) return null;
        if ((await IOUtils.stat(file)).size > 200 * 1024 * 1024) throw new Error(name + " is too large to read");
        return JSON.parse(await IOUtils.readUTF8(file));
      } catch (error) { Zotero.logError(error); return null; }
    };
    const journalData = async (localName, shippedName = localName) => {
      const local = await localJournalData(localName);
      if (local) { journalLayers[localName] = "local"; return local; }
      const response = await Zotero.HTTP.request("GET", rootURI + "data/" + shippedName, { responseType: "json" });
      journalLayers[localName] = "shipped";
      return response.response;
    };
    const catalog = await journalData("if-catalog.json");
    // The registry combines the metric with OpenAlex subject paths. Optional for older
    // builds; missing records stay unknown rather than guessed at.
    try {
      const registry = await journalData("journal-registry.json");
      if (registry && globalThis.CustomStyleJournalIdentity) {
        globalThis.CustomStyleJournalIdentity.loadRegistry(registry);
      }
    } catch (error) { Zotero.debug("Style Custom: journal registry not loaded: " + (error && error.message)); }
    let jcrCatalog = null, jcrCatalogError = null;
    try {
      jcrCatalog = globalThis.CustomStyleJCRCategories.create(await journalData("jcr-categories.json", "journal-catalog.json"));
    } catch (error) {
      jcrCatalogError = String(error && error.message || error);
      Zotero.debug("Style Custom: journal category catalog not loaded: " + jcrCatalogError);
    }
    customStyle = new globalThis.CustomStyleRuntime({ Zotero, catalog, io: IOUtils, paths: PathUtils,
      model: globalThis.CustomStyleData, marquee: globalThis.CustomStyleMarquee,
      reading: globalThis.CustomStyleReading, legacy,
      storage: {
        async read() {
          if (!await IOUtils.exists(path)) return { schema: 1, items: {} };
          if ((await IOUtils.stat(path)).size > 50 * 1024 * 1024) throw new Error("Style Custom cache is too large");
          return JSON.parse(await IOUtils.readUTF8(path));
        },
        async write(value) {
          const encoded=JSON.stringify(value);
          if(encoded.length>16*1024*1024)throw new Error('Style Custom 저장 공간이 큽니다. 사용하지 않는 보드와 초안을 정리하세요.');
          await IOUtils.writeUTF8(path, encoded, { tmpPath: path + ".tmp" });
        }
      }
    });
    customStyle.jcrCatalog = jcrCatalog;
    customStyle.jcrCatalogError = jcrCatalogError;
    customStyle.journalLayers = journalLayers;
    customStyle.journalDir = journalDir;
    customStyle.jcrBrowser = globalThis.CustomStyleJCRBrowser;
    await customStyle.start({ id, version, rootURI });
    Zotero.StyleCustom = customStyle;
    for (const window of Zotero.getMainWindows()) customStyle.addWindow(window);
    for (const reader of Zotero.Reader._readers || []) {
      if (reader._window?.location?.href === "chrome://zotero/content/reader.xhtml") customStyle.addWindow(reader._window);
    }
    readerWindowObserver = { observe(subject) {
      const win = subject;
      win.addEventListener("load", () => {
        if (win.location?.href === "chrome://zotero/content/reader.xhtml") customStyle?.addWindow(win);
      }, { once: true });
    } };
    Services.obs.addObserver(readerWindowObserver, "domwindowopened");
    // One-time migration of already verified counts: no code window or repeat
    // network sweep is needed to add source/date metadata to existing papers.
    const runtime=customStyle;
    if(runtime.pref("metadataCitations",true) && !runtime.cache.citationMetadataMigrated
        && Object.values(runtime.cache.items).some(entry=>entry.citationLookup?.status==="ok")) {
      runtime.syncLibraryCitations(Zotero.Libraries.userLibraryID,{lookup:false}).then(async report=>{
        if(!report.cancelled && !report.errors) {runtime.cache.citationMetadataMigrated=true;runtime.dirty=true;await runtime.flush();}
      }).catch(error=>Zotero.logError(error));
    }
    // A self-check the developer can ask for from outside: set the pref while
    // Zotero is closed, start it, and read the report out of the data folder.
    // The failures worth catching -- SVG innerHTML, a dialog whose rows overlap,
    // a column that throws while painting -- only exist in the real runtime.
    if (Zotero.Prefs.get("extensions.style-custom.selfCheck", true)) {
      // Read the flags before clearing them: clearing first and reading inside
      // the timer meant repair and fill were always false by the time they were
      // asked for, and the run silently did nothing but the read-only checks.
      const options = {
        network: Zotero.Prefs.get("extensions.style-custom.selfCheckNetwork", true) !== false,
        repair: Zotero.Prefs.get("extensions.style-custom.selfCheckRepair", true) === true,
        fill: Zotero.Prefs.get("extensions.style-custom.selfCheckFill", true) === true,
        shots: Zotero.Prefs.get("extensions.style-custom.selfCheckShots", true) === true,
        seed: String(Zotero.Prefs.get("extensions.style-custom.selfCheckDemoSeed", true) || "")
      };
      for (const flag of ["selfCheck", "selfCheckRepair", "selfCheckFill", "selfCheckShots"]) Zotero.Prefs.set("extensions.style-custom." + flag, false, true);
      Zotero.Prefs.set("extensions.style-custom.selfCheckDemoSeed", "", true);
      const reportPath = PathUtils.join(Zotero.DataDirectory.dir, "style-custom-selfcheck.json");
      setTimeout(() => {
        globalThis.CustomStyleSelfCheck
          .run(Zotero, customStyle, options)
          .then(report => IOUtils.writeUTF8(reportPath, JSON.stringify(report, null, 1)))
          .catch(error => IOUtils.writeUTF8(reportPath,
            JSON.stringify({fatal: String(error && error.stack || error)}, null, 1)));
      }, 6000);
    }
  } catch (error) {
    await shutdown();
    Zotero.logError(error);
    throw error;
  }
}
function onMainWindowLoad({ window }) { customStyle?.addWindow(window); }
function onMainWindowUnload({ window }) { customStyle?.removeWindow(window).catch(error=>Zotero.logError(error)); }
// Zotero calls this with the reason. On APP_SHUTDOWN the item tree is about to
// write its column layout to disk, and a column unregistered here is dropped
// from that file -- which is how every width and order the user set was lost at
// each quit. The columns are left registered on quit; Zotero removes a plugin's
// columns itself on disable and uninstall.
async function shutdown(data, reason) {
  if (readerWindowObserver) { Services.obs.removeObserver(readerWindowObserver, "domwindowopened"); readerWindowObserver = null; }
  const runtime = customStyle;
  customStyle = null;
  if (Zotero.StyleCustom === runtime) delete Zotero.StyleCustom;
  await runtime?.stop({ keepColumns: reason === 'APP_SHUTDOWN' || reason === 2 });
}
