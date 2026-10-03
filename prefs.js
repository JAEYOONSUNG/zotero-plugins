// Default preferences for ZotPoP (extensions.zotpop.*)
// English is the default. "ko" is Korean and "auto" follows Zotero's own
// language; anyone who chose either keeps it. The choice is in the search
// window's View menu and in the preferences pane.
pref("extensions.zotpop.language", "en");
pref("extensions.zotpop.email", "");
pref("extensions.zotpop.s2ApiKey", "");
pref("extensions.zotpop.ncbiApiKey", "");
pref("extensions.zotpop.openAlexApiKey", "");
pref("extensions.zotpop.popExecutable", "");
pref("extensions.zotpop.popDataDir", "");
pref("extensions.zotpop.proxyPrefix", "");
// Combined by default: one metered or rate-limited provider can no longer empty a search.
pref("extensions.zotpop.defaultSource", "multi");
// Set once, when a profile that predates the combined search is moved onto it.
pref("extensions.zotpop.multiSourceMigrated", false);
pref("extensions.zotpop.sort", "relevance");
// Publish or Perish fetches up to 1000 per query; a low cap reads as "it found nothing".
pref("extensions.zotpop.maxResults", 1000);
pref("extensions.zotpop.attachPDF", true);
pref("extensions.zotpop.skipDuplicates", true);
pref("extensions.zotpop.citationsInExtra", true);
pref("extensions.zotpop.enrichCitations", true);
pref("extensions.zotpop.journalMetrics", true);
// First and corresponding author labs, their country and standing, from OpenAlex.
pref("extensions.zotpop.institutionMetrics", true);
// Finished searches kept on disk with their results, so a repeat costs no API budget.
pref("extensions.zotpop.historySize", 30);

// Native PoP output is an explicit mode; ordinary direct/combined searches remain available.
pref("extensions.zotpop.searchEngine", "direct");
pref("extensions.zotpop.popDefaultSource", "scholar");
// New releases on GitHub are installed by the plugin itself, once a day while Zotero is open.
pref("extensions.zotpop.autoUpdate", true);

// Abstract translation. The Translate for Zotero plugin is used when installed (its service and key);
// otherwise an OpenAI-compatible chat endpoint can be entered here (https, or this computer). All optional.
pref("extensions.zotpop.translateLang", "");
pref("extensions.zotpop.translateTitle", false);
pref("extensions.zotpop.aiEndpoint", "");
pref("extensions.zotpop.aiModel", "");
pref("extensions.zotpop.aiKey", "");
