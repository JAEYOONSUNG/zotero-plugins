/* global Zotero, Services, IOUtils, PathUtils */
"use strict";
var customStyle = null;
var readerWindowObserver = null;
function install() {}
function uninstall() {}
async function startup({ id, version, rootURI }) {
  try {
    await Zotero.initializationPromise;
    for (const name of ["settings-schema", "data", "journals", "citations", "citation-formats", "supplementary", "workspace", "assist", "library", "reader-tools", "workbench", "marquee", "reading", "runtime"]) {
      Services.scriptloader.loadSubScript(rootURI + "src/" + name + ".js", globalThis);
    }
    const path = PathUtils.join(Zotero.DataDirectory.dir, "style-custom.json");
    let legacy = {};
    try {
      const oldPath = PathUtils.join(Zotero.DataDirectory.dir, "zoterostyle.json");
      if (await IOUtils.exists(oldPath) && (await IOUtils.stat(oldPath)).size <= 50 * 1024 * 1024) legacy = JSON.parse(await IOUtils.readUTF8(oldPath));
    } catch (error) { Zotero.logError(error); }
    const catalogResponse = await Zotero.HTTP.request("GET", rootURI + "data/if-catalog.json", { responseType: "json" });
    const catalog = catalogResponse.response;
    customStyle = new globalThis.CustomStyleRuntime({ Zotero, catalog,
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
  } catch (error) {
    await shutdown();
    Zotero.logError(error);
    throw error;
  }
}
function onMainWindowLoad({ window }) { customStyle?.addWindow(window); }
function onMainWindowUnload({ window }) { customStyle?.removeWindow(window).catch(error=>Zotero.logError(error)); }
async function shutdown() {
  if (readerWindowObserver) { Services.obs.removeObserver(readerWindowObserver, "domwindowopened"); readerWindowObserver = null; }
  const runtime = customStyle;
  customStyle = null;
  if (Zotero.StyleCustom === runtime) delete Zotero.StyleCustom;
  await runtime?.stop();
}
