/* The preferences pane is XUL filled in at load time from the string tables, so
   a key that exists in the markup and not in the tables shows as a blank row.
   These cover that, and the journal figures folder in particular: figures an
   institution licenses to a reader are read from the Zotero data directory and
   are never packaged with the plugin or published. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import I18N from "../content/i18n.js";

const pane = readFileSync(new URL("../content/preferences.xhtml", import.meta.url), "utf8");
const keys = attribute => [...pane.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map(match => match[1]);

test("every string the preferences pane asks for exists in both languages", () => {
	const asked = [...keys("data-i18n"), ...keys("data-i18n-value"), ...keys("data-i18n-label")];
	assert.ok(asked.length > 20, "the pane is filled in from the tables");
	const missing = [];
	for (const locale of ["en", "ko"]) {
		for (const key of asked) {
			const value = I18N.STRINGS[locale][key];
			if (typeof value !== "string" || !value.trim()) missing.push(`${locale}: ${key}`);
		}
	}
	assert.deepEqual(missing, [], "these rows would render blank");
});

test("the pane names the folder journal figures are read from, and what goes in it", () => {
	assert.match(pane, /data-i18n-value="prefJournalFolder"/, "a labelled row states the folder");
	assert.match(pane, /id="zotpop-journal-folder"[^>]*readonly="readonly"/, "the path is shown, not edited");
	assert.match(pane, /id="zotpop-journal-folder"[^>]*value="zotpop\/journals"/);
	assert.match(pane, /data-i18n="prefJournalFolderNote"/, "with one note under it");
	// No preference is bound to it: there is no such setting, and offering one
	// would imply the folder can be moved.
	const row = /<html:input id="zotpop-journal-folder"[^>]*>/.exec(pane)[0];
	assert.ok(!row.includes("preference="), "the row reports a location rather than storing one");

	for (const locale of ["en", "ko"]) {
		const note = I18N.STRINGS[locale].prefJournalFolderNote;
		assert.match(note, /jcr\.json/, `${locale} names the figures file`);
		assert.match(note, /journal-registry\.json/, `${locale} names the registry file`);
		const label = I18N.STRINGS[locale].prefJournalFolder;
		assert.match(label, locale === "en" ? /Zotero data directory/ : /Zotero 데이터 폴더/);
	}
	assert.match(I18N.STRINGS.en.prefJournalFolderNote, /never packaged with the plugin and never published/);
	assert.match(I18N.STRINGS.ko.prefJournalFolderNote, /배포본에 넣거나 공개하지 않습니다/);
});

test("nothing claims the plugin ships a Journal Impact Factor, or calls the OpenAlex figure one", () => {
	/* The figure the archive carries is a two-year mean citedness, which is not
	   a JIF: the JIF is the Clarivate figure a reader supplies themselves. */
	for (const locale of ["en", "ko"]) {
		const strings = I18N.STRINGS[locale];
		assert.ok(!/shipped with the plugin|플러그인에 내장/.test(strings.prefNoteIF),
			`${locale} no longer says the figures are packaged`);
		assert.ok(!/Impact Factor|JIF/.test(strings.prefJIF),
			`${locale} does not call the OpenAlex lookup a Journal Impact Factor`);
		assert.match(strings.prefJIF, locale === "en" ? /2-year mean citedness/ : /2년 평균 피인용도/);
		assert.match(strings.prefNoteIF, locale === "en" ? /2-year mean citedness/ : /2년 평균 피인용도/);
	}
});
