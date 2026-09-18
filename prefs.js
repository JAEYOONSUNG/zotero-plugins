// Default preferences for ZotPoP (extensions.zotpop.*)
pref("extensions.zotpop.language", "en");
pref("extensions.zotpop.email", "");
pref("extensions.zotpop.s2ApiKey", "");
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
