/* Keeping an installed copy current from the GitHub feed.

   Zotero reads a plugin's update_url on its own schedule, and only when its
   global add-on updater is on. This is the plugin's own check: it reads the
   same feed, compares versions, and installs the new file through Zotero's
   add-on manager, so a copy installed once from a file keeps up with every
   later release without a second visit to GitHub. The module is pure: the
   host hands in the request, the version comparison and the installer, so
   the decisions can be tested without Zotero.

   Shared by both plugins: the source lives in Style Custom and ZotPoP's build
   copies it into content/updater.js. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PluginUpdater = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAY = 24 * 60 * 60 * 1000;

  // A version compare that needs no Services: 0.51.12 > 0.51.9, and a suffix
  // (0.52.0-beta) sorts before its release.
  function compareVersions(a, b) {
    const split = v => String(v || "").split(/[-+]/)[0].split(".").map(part => parseInt(part, 10) || 0);
    const pa = split(a), pb = split(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    const sa = /[-+]/.test(String(a || "")), sb = /[-+]/.test(String(b || ""));
    if (sa !== sb) return sa ? -1 : 1;
    return 0;
  }

  /* What the feed offers this copy: the newest entry newer than the running
     version whose minimum Zotero the running Zotero meets. */
  function pick(feed, { id, version, appVersion, compare = compareVersions }) {
    const entries = feed && feed.addons && feed.addons[id] && Array.isArray(feed.addons[id].updates)
      ? feed.addons[id].updates : null;
    if (!entries) throw new Error("the update feed has no entry for " + id);
    let best = null;
    for (const entry of entries) {
      if (!entry || typeof entry.version !== "string" || typeof entry.update_link !== "string") continue;
      if (!/^https:\/\//i.test(entry.update_link)) continue;
      if (compare(entry.version, version) <= 0) continue;
      const min = entry.applications && entry.applications.zotero && entry.applications.zotero.strict_min_version;
      if (min && appVersion && compare(appVersion, min) < 0) continue;
      if (!best || compare(entry.version, best.version) > 0) best = entry;
    }
    return best;
  }

  function create(options) {
    const {
      id, version, updateURL, appVersion,
      request, install, compare = compareVersions,
      prefs, log = () => {}, now = () => Date.now(),
      busy = () => false,
      setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout
    } = options || {};
    if (!id || !version || !updateURL || typeof request !== "function" || typeof install !== "function") {
      throw new Error("updater needs id, version, updateURL, request and install");
    }
    const get = (name, fallback) => { try { const v = prefs && prefs.get(name); return v === undefined || v === null ? fallback : v; } catch (e) { return fallback; } };
    const set = (name, value) => { try { prefs && prefs.set(name, value); } catch (e) { log("could not save " + name + ": " + (e.message || e)); } };
    const state = { running: null, timer: null, last: null };

    function enabled() { return get("autoUpdate", true) !== false; }

    async function check() {
      const url = updateURL + (updateURL.includes("?") ? "&" : "?") + "t=" + now();
      const feed = await request(url);
      const entry = pick(feed, { id, version, appVersion, compare });
      return entry ? { status: "available", entry } : { status: "current" };
    }

    /* One check, and the install when there is one. Never throws: the result
       says what happened, and the prefs remember it for the settings pane. */
    async function run({ reason = "timer", force = false } = {}) {
      if (state.running) return state.running;
      state.running = (async () => {
        let result;
        if (!force && !enabled()) result = { status: "off" };
        else {
          try {
            result = await check();
            if (result.status === "available") {
              if (!force && busy()) result = { status: "deferred", entry: result.entry };
              else {
                await install(result.entry);
                result = { status: "installed", entry: result.entry };
              }
            }
          }
          catch (error) {
            result = { status: "error", message: String(error && error.message || error) };
            log("update check failed: " + result.message);
          }
        }
        result.reason = reason;
        result.at = new Date(now()).toISOString();
        result.version = version;
        if (result.status !== "off") set("updateLastCheck", result.at);
        set("updateLastResult", JSON.stringify({
          status: result.status, at: result.at, version,
          latest: result.entry ? result.entry.version : undefined,
          message: result.message
        }));
        state.last = result;
        return result;
      })();
      try { return await state.running; }
      finally { state.running = null; }
    }

    /* Once soon after start-up, then daily while Zotero stays open. The first
       delay keeps the check off the start-up path; a check made within the
       last few hours is not repeated at every launch. */
    function start({ delayMs = 45000, intervalMs = DAY, minGapMs = 6 * 60 * 60 * 1000 } = {}) {
      stop();
      if (typeof setTimer !== "function") { log("no timer in this scope; updates are checked on request only"); return; }
      const tick = () => {
        state.timer = null;
        const lastAt = Date.parse(get("updateLastCheck", "") || "") || 0;
        const due = !lastAt || now() - lastAt >= minGapMs;
        (due ? run({ reason: "timer" }) : Promise.resolve({ status: "recent" }))
          .catch(error => log("update check failed: " + (error.message || error)))
          .finally(() => { if (state.started) state.timer = setTimer(tick, intervalMs); });
      };
      state.started = true;
      state.timer = setTimer(tick, delayMs);
    }

    function stop() {
      state.started = false;
      if (state.timer != null) { clearTimer(state.timer); state.timer = null; }
    }

    function lastResult() {
      try { const raw = get("updateLastResult", ""); return raw ? JSON.parse(raw) : null; }
      catch (e) { return null; }
    }

    return { check, run, start, stop, enabled, lastResult, state };
  }

  return { create, pick, compareVersions, DAY };
});
