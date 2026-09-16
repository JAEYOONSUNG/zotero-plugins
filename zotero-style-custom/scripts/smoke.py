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
PLUGIN_ID = "style-custom@sungjaeyoon.dev"


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
        "applications": {"zotero": {"id": "custom-smoke-companion@local.invalid",
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
    with zipfile.ZipFile(extensions / "custom-smoke-companion@local.invalid.xpi", "w", zipfile.ZIP_DEFLATED) as archive:
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
    version = json.loads((ROOT / 'manifest.json').read_text())['version']
    xpi = ROOT / ('build/style-custom-' + version + '.xpi')
    report = {'passed':False, 'xpiSha256':hashlib.sha256(xpi.read_bytes()).hexdigest(), 'checks':{}}
    with tempfile.TemporaryDirectory(prefix='custom-style-smoke-') as temporary:
        proc = log = None
        try:
            proc, log, client, data = launch(Path(temporary))
            script = (ROOT / 'scripts/native-check.js').read_text()
            report['checks'] = client.execute(script, {'xpi':str(xpi),'id':PLUGIN_ID,'data':str(data)})
            report['passed'] = True
        except Exception as error:
            report['error'] = str(error)
            raise
        finally:
            stop_owned(proc)
            if log:
                if not report['passed']:
                    log.seek(0); print(log_summary(log.read())[-10000:])
                log.close()
            report['ownedProcessStopped'] = bool(proc and proc.poll() is not None)
            output=ROOT/'docs/smoke-result.json';output.parent.mkdir(exist_ok=True)
            output.write_text(json.dumps(report,indent=2)+'\n')
    print('Native smoke passed')

if __name__ == '__main__':
    main()
