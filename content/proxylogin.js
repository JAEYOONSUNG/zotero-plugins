/* global Zotero, ZotPoPI18N */
"use strict";

(function () {
	const args = (window.arguments && window.arguments[0]) || {};
	if (typeof Zotero === "undefined" && args.Zotero) window.Zotero = args.Zotero;
	const $ = id => document.getElementById(id);
	const PREF = k => Zotero.Prefs.get("extensions.zotpop." + k, true);

	let t = ZotPoPI18N.make("en");
	let browser = null;

	function hostOf(url) {
		let m = String(url || "").match(/^https?:\/\/([^/?#]+)/i);
		return m ? m[1].replace(/:\d+$/, "").toLowerCase() : "";
	}

	// The proxy's own host, derived from the configured prefix
	function proxyBase() {
		let prefix = (PREF("proxyPrefix") || "").trim();
		let m = prefix.match(/^https?:\/\/[^/?#]+/i);
		return m ? m[0] : null;
	}

	function init() {
		let locale = ZotPoPI18N.resolveLocale(PREF("language") || "en", Zotero.locale);
		t = ZotPoPI18N.make(locale);
		document.title = t("loginTitle");
		$("pl-check").textContent = t("loginCheck");
		$("pl-close").textContent = t("loginClose");
		$("pl-intro").textContent = t("loginIntro");
		$("pl-status").textContent = "";

		let base = proxyBase();
		if (!base) {
			$("pl-status").textContent = t("proxyNotSet");
			$("pl-check").disabled = true;
			return;
		}

		// A XUL <browser> is a real content docshell, so the cookies it receives land in
		// Zotero's own jar — which is exactly what the headless PDF downloads need.
		browser = document.createXULElement("browser");
		browser.setAttribute("type", "content");
		browser.setAttribute("remote", "false");
		browser.setAttribute("disablehistory", "false");
		browser.setAttribute("flex", "1");
		browser.id = "pl-browser";
		$("pl-browser-host").appendChild(browser);
		browser.loadURI(Services.io.newURI(base), {
			triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
		});

		let showURL = () => {
			try { $("pl-url").textContent = browser.currentURI?.spec || ""; }
			catch (e) { /* not loaded yet */ }
		};
		browser.addEventListener("load", showURL, true);
		setInterval(showURL, 1000);

		$("pl-back").addEventListener("click", () => { try { browser.goBack(); } catch (e) {} });
		$("pl-reload").addEventListener("click", () => { try { browser.reload(); } catch (e) {} });
		$("pl-close").addEventListener("click", () => window.close());
		$("pl-check").addEventListener("click", checkSession);
	}

	// Ask the proxy for a known DOI and see whether it hands back the publisher or its login page
	async function checkSession() {
		let prefix = (PREF("proxyPrefix") || "").trim();
		if (!prefix) return;
		$("pl-check").disabled = true;
		$("pl-status").textContent = t("loginChecking");
		let probe = prefix.includes("%URL%")
			? prefix.replace("%URL%", encodeURIComponent("https://doi.org/10.1126/science.aaf5573"))
			: prefix + "https://doi.org/10.1126/science.aaf5573";
		try {
			let xhr = await Zotero.HTTP.request("GET", probe, { responseType: "text", timeout: 45000, errorDelayMax: 0 });
			// Judge from where the request ended up, never from the probe URL: the target DOI
			// is embedded in the request, so matching it back would always look like success.
			// A live session leaves the proxy host; a sign-in page keeps us on it.
			let landed = hostOf(xhr.responseURL || probe);
			let proxyHost = hostOf(prefix);
			let stillOnProxy = Boolean(proxyHost) && landed === proxyHost;
			let looksLikeForm = /<form[^>]*(password|login|signin|sso)/i.test(xhr.responseText || "")
				|| /type=["']password["']/i.test(xhr.responseText || "");
			let loggedOut = stillOnProxy && looksLikeForm;
			$("pl-status").textContent = loggedOut ? t("loginNotYet") : t("loginOk");
			$("pl-status").style.color = loggedOut ? "var(--warn)" : "var(--ok)";
		}
		catch (e) {
			$("pl-status").textContent = t("loginCheckFailed", e.message || String(e));
			$("pl-status").style.color = "var(--err)";
		}
		finally {
			$("pl-check").disabled = false;
		}
	}

	window.addEventListener("load", init);
})();
