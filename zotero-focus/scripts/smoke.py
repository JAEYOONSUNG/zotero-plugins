#!/usr/bin/env python3
"""Exercise the built XPI through a disposable native companion (stdlib only)."""
import hashlib
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get("ZOTERO_SMOKE_APP", "/Applications/Zotero.app/Contents/MacOS/zotero"))
PLUGIN_ID = "zotero-focus@sungjaeyoon.dev"


def log_summary(text):
    lines = text.splitlines()
    selected = set()
    for index, line in enumerate(lines):
        if re.search(r"zotero-focus@|zotero focus|focusplugin|focus-under-test|bootstrap|exception|error|plugin", line, re.I) and "translator" not in line.lower():
            selected.update(range(max(0, index-1), min(len(lines), index+4)))
    return "\n".join(lines[index] for index in sorted(selected))[-16000:]


class NativeBridge:
    """Request/response files consumed only by our disposable companion extension."""
    def __init__(self, directory, proc):
        self.directory = directory
        self.proc = proc
        self.counter = 0

    def execute(self, script, args=None):
        self.counter += 1
        request = {"id": self.counter, "script": script, "input": args or {}}
        request_path = self.directory / "request.json"
        staging = self.directory / "request.tmp"
        staging.write_text(json.dumps(request))
        staging.replace(request_path)
        response_path = self.directory / ("response-" + str(self.counter) + ".json")
        deadline = time.monotonic() + 65
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise ConnectionError("Owned Zotero process exited during smoke phase")
            if response_path.exists():
                result = json.loads(response_path.read_text())
                if not result.get("ok"):
                    raise RuntimeError(result.get("error", str(result)) + "\n" + result.get("stack", ""))
                return result.get("value")
            time.sleep(0.1)
        raise TimeoutError("Disposable Zotero companion did not answer smoke phase")


def companion(profile, directory):
    extensions = profile / "extensions"
    extensions.mkdir(parents=True)
    manifest = json.dumps({
        "manifest_version": 2, "name": "Disposable Focus smoke companion", "version": "1.0",
        "applications": {"zotero": {"id": "focus-smoke-companion@local.invalid",
            "update_url": "https://example.invalid/smoke-updates.json",
            "strict_min_version": "9.0", "strict_max_version": "9.*"}}
    })
    bootstrap = r"""
var running = true;
function install() {}
function uninstall() {}
function shutdown() { running = false; }
function startup() {
  // Return immediately: plugin startup must not wait for this persistent control loop.
  IOUtils.writeUTF8(BRIDGE_DIRECTORY + '/bootstrap-started.json', JSON.stringify({started:true}));
  run().catch(error => Zotero.logError(error));
}
async function run() {
  await Zotero.initializationPromise;
  const {classes: Cc, interfaces: Ci} = Components;
  const directory = BRIDGE_DIRECTORY;
  await IOUtils.writeUTF8(directory + '/ready.json', JSON.stringify({ready:true}));
  while (running) {
    const requestPath = directory + '/request.json';
    if (await IOUtils.exists(requestPath)) {
      const request = JSON.parse(await IOUtils.readUTF8(requestPath));
      await IOUtils.remove(requestPath);
      let response;
      try {
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const check = (value, message) => { if (!value) throw new Error(message); };
        const wait = ms => Zotero.Promise.delay(ms);
        const until = async (fn, message, ms = 12000) => {
          const end = Date.now() + ms;
          while (Date.now() < end) { if (await fn()) return; await wait(80); }
          throw new Error(message);
        };
        const execute = new Function('Zotero', 'Services', 'ChromeUtils', 'Cc', 'Ci',
          'AddonManager', 'check', 'wait', 'until', 'input',
          'return (async () => {' + request.script + '\n})();');
        const value = await execute(Zotero, Services, ChromeUtils, Cc, Ci,
          AddonManager, check, wait, until, request.input);
        response = {ok:true, value};
      } catch (error) { response = {ok:false, error:String(error), stack:error.stack}; }
      await IOUtils.writeUTF8(directory + '/response-' + request.id + '.json', JSON.stringify(response),
        {tmpPath: directory + '/response.tmp'});
    }
    await Zotero.Promise.delay(60);
  }
}
"""
    with zipfile.ZipFile(extensions / "focus-smoke-companion@local.invalid.xpi", "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest)
        archive.writestr("bootstrap.js", bootstrap.replace("BRIDGE_DIRECTORY", json.dumps(str(directory))))


def stop_owned(proc):
    if proc and proc.poll() is None:
        # Popen owns this precise PID. Never use process-name matching.
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def launch(temp):
    profile, data, bridge = temp / "profile", temp / "data", temp / "bridge"
    for directory in (profile, data, bridge):
        directory.mkdir()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    prefs = {
        "marionette.port": port,
        "marionette.enabled": True,
        "extensions.zotero.useDataDir": True,
        "extensions.zotero.dataDir": str(data),
        "extensions.zotero.sync.autoSync": False,
        "extensions.zotero.automaticScraperUpdates": False,
        "extensions.zotero.streaming.enabled": False,
        "extensions.zotero.httpServer.enabled": False,
        "extensions.zotero.firstRun": False,
        "extensions.zotero.reportTranslationFailure": False,
        "extensions.zoteroMacWordIntegration.skipInstallation": True,
        "extensions.zoteroOpenOfficeIntegration.skipInstallation": True,
        "extensions.autoDisableScopes": 0,
        "extensions.enabledScopes": 15,
        "extensions.startupScanScopes": 15,
        "extensions.sideloadScopes": 15,
        "extensions.logging.enabled": True,
        "extensions.update.enabled": False,
        "browser.dom.window.dump.enabled": True,
        "app.update.enabled": False,
        "app.update.auto": False,
        "toolkit.telemetry.enabled": False,
        "datareporting.healthreport.uploadEnabled": False,
        "ui.prefersReducedMotion": 0,
    }
    (profile / "user.js").write_text("\n".join(
        f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()
    ) + "\n")
    companion(profile, bridge)
    log = (temp / "process.log").open("w+")
    proc = None
    try:
        proc = subprocess.Popen([
            str(APP), "--new-instance", "--profile", str(profile), "-datadir", str(data),
            "--headless", "--marionette", "--remote-allow-system-access",
            "-ZoteroDebugText",
        ], stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("Owned Zotero exited during startup")
            if (bridge / "ready.json").exists():
                return proc, log, NativeBridge(bridge, proc), data
            time.sleep(0.15)
        raise RuntimeError("Disposable smoke companion did not start")
    except Exception as error:
        stop_owned(proc)
        log.seek(0)
        owned_log = log_summary(log.read()).replace(str(temp), "<temporary>")
        print("Owned startup log:", owned_log, flush=True)
        log.close()
        error.owned_process_stopped = bool(proc and proc.poll() is not None)
        error.owned_log = owned_log
        raise


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    xpi = ROOT / "build" / ("zotero-focus-" + manifest["version"] + ".xpi")
    assert APP.is_file(), "Installed Zotero executable not found"
    assert xpi.is_file(), "Build the XPI before running the smoke"
    with zipfile.ZipFile(xpi) as archive:
        assert json.loads(archive.read("manifest.json")) == manifest, "Built XPI manifest is stale"
    assert manifest["applications"]["zotero"].get("update_url"), "Zotero 9 requires an update_url"
    report = {"passed": False, "pluginVersion": manifest["version"],
              "checkedAt": datetime.now(timezone.utc).isoformat(),
              "xpiSha256": hashlib.sha256(xpi.read_bytes()).hexdigest(),
              "isolation": "new disposable profile, forced disposable data directory, unique Marionette port",
              "rendering": "headless native Zotero DOM behavior; not a user-profile screenshot",
              "control": "disposable companion file bridge (Marionette browser startup is incompatible with Zotero)",
              "checks": {}}
    proc = log = client = None
    try:
        with tempfile.TemporaryDirectory(prefix="zotero-focus-smoke-") as temporary:
            try:
                runtime_xpi = Path(temporary) / "focus-under-test.xpi"
                runtime_xpi.write_bytes(xpi.read_bytes())
                report["xpiSha256"] = hashlib.sha256(runtime_xpi.read_bytes()).hexdigest()
                proc, log, client, data = launch(Path(temporary))

                def phase(name, script, args=None):
                    print("Checking " + name + "…", flush=True)
                    value = client.execute(script, args)
                    report["checks"][name] = value
                    return value

                phase("isolatedStartup", """
await Zotero.initializationPromise;
check(Zotero.DataDirectory.dir === input.data, 'Data directory isolation failed');
await until(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView, 'Main item tree did not initialize');
return {version: Zotero.version, forcedDataDirectory: true, mainWindow: true};
""", {"data": str(data)})

                phase("actualXpiStartup", """
const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
file.initWithPath(input.xpi);
const addon = await AddonManager.installTemporaryAddon(file);
check(addon.id === input.id, 'Wrong addon installed');
try {
  await until(() => Zotero.ItemTreeManager.getCustomColumns().filter(c => c.pluginID === input.id).length === 3,
    'Three actual XPI columns did not register');
} catch (error) {
  throw new Error(error.message + '; addon state=' + JSON.stringify({active:addon.isActive,
    appDisabled:addon.appDisabled,userDisabled:addon.userDisabled,pendingOperations:addon.pendingOperations})
    + '; console=' + Services.console.getMessageArray().map(m => m.message)
      .filter(m => /focus|bootstrap/i.test(m)).slice(-12).join(String.fromCharCode(10)));
}
const win = Zotero.getMainWindow();
await until(() => win.document.getElementById('zotero-focus-itemmenu'), 'Actual XPI menu missing');
check(Zotero.PreferencePanes.pluginPanes.some(p => p.pluginID === input.id), 'Preference pane missing');
return {addonActive: addon.isActive, columns: 3, menu: true, preferencePane: true};
""", {"xpi": str(runtime_xpi), "id": PLUGIN_ID})

                seeded = phase("syntheticReferences", """
const first = new Zotero.Item('journalArticle');
first.setField('title', 'Synthetic hover verification: <i>Formatted title</i> ' + 'a long readable title with styled content '.repeat(14));
first.setTags([{tag: 'synthetic-existing', type: 1}, {tag: 'zotero-focus:status:future'}]);
await first.saveTx();
const second = new Zotero.Item('journalArticle');
second.setField('title', 'Synthetic second reference');
second.setTags([{tag: 'synthetic-second', type: 0}]);
await second.saveTx();
const win = Zotero.getMainWindow();
win.resizeTo(1100, 800);
await win.ZoteroPane.selectItem(first.id);
await until(() => win.document.querySelector('#zotero-items-tree .row .cell.title .cell-text'), 'Native title missing');
return {ids: [first.id, second.id], createdOnlyInDisposableLibrary: true};
""")

                phase("menuWritesAndPreservation", """
const first = await Zotero.Items.getAsync(input.ids[0]);
const win = Zotero.getMainWindow();
await win.ZoteroPane.selectItem(first.id);
const menu = win.document.getElementById('zotero-focus-itemmenu');
const body = menu.firstElementChild;
body.children[1].dispatchEvent(new win.Event('command', {bubbles: true}));
await until(() => first.getTags().some(t => t.tag === 'zotero-focus:status:reading')
  && !first.hasChanged() && !Zotero.DB.inTransaction(), 'Status menu did not persist');
const ratingMenu = body.querySelector('menu > menupopup');
ratingMenu.children[4].dispatchEvent(new win.Event('command', {bubbles: true}));
await until(() => first.getTags().some(t => t.tag === 'zotero-focus:rating:4')
  && !first.hasChanged() && !Zotero.DB.inTransaction(), 'Rating menu did not persist');
await first.reload(['primaryData','tags'], true);
const tags = first.getTags();
check(tags.some(t => t.tag === 'synthetic-existing' && t.type === 1), 'Unrelated automatic tag changed');
check(tags.some(t => t.tag === 'zotero-focus:status:future'), 'Unknown future metadata removed');
check(tags.some(t => t.tag === 'zotero-focus:status:reading'), 'Status missing after reload');
check(tags.some(t => t.tag === 'zotero-focus:rating:4'), 'Rating missing after reload');
return {status: 'reading', rating: 4, unrelatedAutomaticTagPreserved: true, futureMetadataPreserved: true};
""", seeded)

                phase("atomicRollbackAndDirtyRefusal", """
const addon = await AddonManager.getAddonByID(input.id);
const scope = new Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),
  {sandboxName:'Focus synthetic failure verification', wantXrays:false});
scope.Zotero = Zotero;
for (const file of ['model', 'runtime']) Services.scriptloader.loadSubScript(addon.getResourceURI().spec + 'src/' + file + '.js', scope);
const runtime = new scope.ZoteroFocusRuntime({Zotero, model: scope.ZoteroFocusModel, marquee: {}});
runtime.active = true;
const items = await Zotero.Items.getAsync(input.ids);
const canonical = item => JSON.stringify(item.getTags().slice().sort((a,b) => a.tag.localeCompare(b.tag)));
const before = items.map(canonical);
const saved = items[1].save;
items[1].save = async () => { throw new Error('Synthetic pre-save failure'); };
let rejected = false;
try { await runtime.edit(items, {status: 'done'}); } catch (_) { rejected = true; }
finally { items[1].save = saved; }
check(rejected, 'Injected second-item failure did not reject');
check(items.every((item,i) => canonical(item) === before[i]), 'Rollback left stale cached tags');
check(items.every(item => !item.hasChanged()), 'Rollback left pending changes');
await Promise.all(items.map(item => item.reload(['primaryData','tags'], true)));
check(items.every((item,i) => canonical(item) === before[i]), 'Rollback changed persistent tags');
items[0].setTags([...items[0].getTags(), {tag:'synthetic-unsaved'}]);
rejected = false;
try { await runtime.edit([items[0]], {rating: 2}); } catch (_) { rejected = true; }
check(rejected, 'Dirty item was not refused');
check(items[0].getTags().some(t => t.tag === 'synthetic-unsaved'), 'Dirty item pending changes were discarded');
items[0]._clearChanged('tags');
await items[0].reload(['primaryData','tags'], true);
runtime.active = false;
// This test-only sandbox is released when the owned disposable process exits.
return {secondItemFailureRejected: true, databaseRestored: true, cachedTagsRestored: true,
  pendingChangesCleared: true, preexistingDirtyItemRefused: true};
""", {**seeded, "id": PLUGIN_ID})

                phase("nativeHoverScrollAndReset", """
const win = Zotero.getMainWindow();
await win.ZoteroPane.selectItem(input.ids[0]);
await wait(250);
const texts = [...win.document.querySelectorAll('#zotero-items-tree .row .cell.title .cell-text')];
const text = texts.find(n => n.textContent.startsWith('Synthetic hover verification:'));
check(text, 'Synthetic long native title not found');
const cell = text.closest('.cell.title');
const icon = cell.querySelector('.cell-icon');
const markup = text.innerHTML;
check(text.querySelector('i'), 'Native formatted title did not contain its italic element');
const aria = text.getAttribute('aria-label');
const iconX = icon?.getBoundingClientRect().x;
check(text.scrollWidth > text.clientWidth, 'Synthetic native title is not truncated');
cell.dispatchEvent(new win.MouseEvent('mouseover', {bubbles:true}));
cell.dispatchEvent(new win.MouseEvent('mousemove', {bubbles:true}));
await wait(750);
const moved = Math.abs(text.scrollLeft);
check(moved > 10, 'Native hover did not scroll title');
check(icon?.getBoundingClientRect().x === iconX, 'Native title icon moved');
check(text.innerHTML === markup && text.getAttribute('aria-label') === aria, 'Native markup or ARIA changed');
cell.dispatchEvent(new win.MouseEvent('mouseout', {bubbles:true, relatedTarget:win.document.documentElement}));
await wait(100);
check(text.scrollLeft === 0, 'Leaving native title did not reset');
cell.dispatchEvent(new win.MouseEvent('mouseover', {bubbles:true}));
cell.dispatchEvent(new win.MouseEvent('mousemove', {bubbles:true}));
await wait(500);
win.document.getElementById('zotero-items-tree').dispatchEvent(new win.Event('scroll', {bubbles:true}));
await wait(60);
check(text.scrollLeft === 0, 'Scrolling item tree did not reset title');
return {overflowPixels: text.scrollWidth-text.clientWidth, movedPixels: moved,
  leaveReset:true, treeScrollReset:true, iconStationary:true, richMarkupPreserved:true, ariaPreserved:true};
""", seeded)

                phase("disableAndReenable", """
let addon = await AddonManager.getAddonByID(input.id);
await addon.disable();
const win = Zotero.getMainWindow();
await until(() => !win.document.getElementById('zotero-focus-itemmenu') &&
  !Zotero.ItemTreeManager.getCustomColumns().some(c => c.pluginID === input.id), 'Disable cleanup failed');
check(!Zotero.PreferencePanes.pluginPanes.some(p => p.pluginID === input.id), 'Preference pane survived disable');
const text = [...win.document.querySelectorAll('#zotero-items-tree .row .cell.title .cell-text')]
  .find(n => n.textContent.startsWith('Synthetic hover verification:'));
check(text, 'Disabled title missing');
text.closest('.cell').dispatchEvent(new win.MouseEvent('mouseover', {bubbles:true}));
text.closest('.cell').dispatchEvent(new win.MouseEvent('mousemove', {bubbles:true}));
await wait(650);
check(text.scrollLeft === 0, 'Hover listener survived disable');
await addon.enable();
await until(() => win.document.getElementById('zotero-focus-itemmenu') &&
  Zotero.ItemTreeManager.getCustomColumns().filter(c => c.pluginID === input.id).length === 3, 'Reenable failed');
check(win.document.querySelectorAll('#zotero-focus-itemmenu').length === 1, 'Duplicate menu after reenable');
check(Zotero.PreferencePanes.pluginPanes.filter(p => p.pluginID === input.id).length === 1, 'Duplicate preference pane');
check(!Services.console.getMessageArray().some(m => m.message.includes('Error running bootstrap method')
  && m.message.includes(input.id)), 'Actual Focus bootstrap lifecycle logged an error');
await wait(200);
const reenabledText = [...win.document.querySelectorAll('#zotero-items-tree .row .cell.title .cell-text')]
  .find(n => n.textContent.startsWith('Synthetic hover verification:'));
check(reenabledText, 'Reenabled title missing');
reenabledText.closest('.cell').dispatchEvent(new win.MouseEvent('mouseover', {bubbles:true}));
reenabledText.closest('.cell').dispatchEvent(new win.MouseEvent('mousemove', {bubbles:true}));
await wait(650);
check(Math.abs(reenabledText.scrollLeft) > 10, 'Hover failed after reenable');
reenabledText.closest('.cell').dispatchEvent(new win.MouseEvent('mouseout',
  {bubbles:true, relatedTarget:win.document.documentElement}));
return {columnsRemoved:true, menuRemoved:true, preferencePaneRemoved:true, hoverStopped:true,
  reenabled:true, hoverResumed:true, duplicateMenus:0, duplicatePreferencePanes:0};
""", {"id": PLUGIN_ID})
                report["passed"] = True
            finally:
                stop_owned(proc)
                if log:
                    if not report["passed"]:
                        log.seek(0)
                        report["ownedProcessLog"] = log_summary(log.read()).replace(temporary, "<temporary>")
                    log.close()
                report["ownedProcessStopped"] = bool(proc and proc.poll() is not None)
    except Exception as error:
        report["error"] = str(error)
        if hasattr(error, "owned_process_stopped"):
            report["ownedProcessStopped"] = error.owned_process_stopped
            report["ownedProcessLog"] = error.owned_log
        traceback.print_exc()
    finally:
        output = ROOT / "docs" / "smoke-result.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if not report["passed"]:
        raise SystemExit(1)
    print("Zotero smoke verification passed")


if __name__ == "__main__":
    main()
