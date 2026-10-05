/* Name searches past the first page: OpenAlex's 15 and ORCID's 20 people were all a name search could show.
   "Load more people" asks each service for its next page only when pressed (OpenAlex is metered), merges a
   person already shown instead of listing them twice, and enriches the new ORCID-only cards in one batch. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Authors from "../content/authors.js";
import I18N from "../content/i18n.js";
import { uiHarness } from "./helpers/search-ui-harness.mjs";

// Valid ORCID iDs (ISO 7064 11,2 check digit) from a running number.
function orcidOf(n) {
	const base = String(1000000000000000 + n).slice(1, 16);
	let total = 0;
	for (const d of base) total = (total + Number(d)) * 2;
	const r = (12 - total % 11) % 11, check = r === 10 ? "X" : String(r);
	const all = base + check;
	return all.slice(0, 4) + "-" + all.slice(4, 8) + "-" + all.slice(8, 12) + "-" + all.slice(12);
}
const oaAuthor = (n, orcid) => ({ id: "https://openalex.org/A" + n, orcid: orcid ? "https://orcid.org/" + orcid : null, display_name: "Sam Lee", display_name_alternatives: [],
	works_count: 100 - n, cited_by_count: 10, summary_stats: { h_index: 3 }, last_known_institutions: [], topics: [] });
const orcidRow = id => ({ "orcid-id": id, "given-names": "Sam", "family-names": "Lee", "credit-name": null, "institution-name": ["Somewhere"], "other-name": [] });

/* OpenAlex: 40 people A1..A40, A1..A10 carry ORCID iDs 1..10. ORCID: 45 people, iDs 1..45. */
function services() {
	const urls = [];
	const oa = Array.from({ length: 40 }, (_, i) => oaAuthor(i + 1, i < 10 ? orcidOf(i + 1) : null));
	const or = Array.from({ length: 45 }, (_, i) => orcidRow(orcidOf(i + 1)));
	const getJSON = async url => {
		urls.push(url);
		if (url.startsWith("https://api.openalex.org/authors?search=")) {
			const page = Number(url.match(/[?&]page=(\d+)/)?.[1] || 1), per = Number(url.match(/per-page=(\d+)/)[1]);
			return { meta: { count: oa.length }, results: oa.slice((page - 1) * per, page * per) };
		}
		if (url.startsWith("https://api.openalex.org/authors?filter=orcid:")) {
			const ids = decodeURIComponent(url.match(/filter=orcid:([^&]+)/)[1]).split("|");
			return { results: ids.map((id, i) => oaAuthor(500 + Number(id.replace(/\D/g, "").slice(-4)) + i, id)) };
		}
		if (url.startsWith("https://pub.orcid.org/v3.0/expanded-search/")) {
			const start = Number(url.match(/[?&]start=(\d+)/)?.[1] || 0), rows = Number(url.match(/rows=(\d+)/)[1]);
			return { "num-found": or.length, "expanded-result": or.slice(start, start + rows) };
		}
		throw new Error("unexpected " + url);
	};
	return { urls, http: { getJSON } };
}

test("the first page says where each service's next page starts and how many it holds", async () => {
	const { http, urls } = services();
	const list = await Authors.searchProfiles("combined", "Sam Lee", http, {});
	assert.deepEqual(list.paging, { openalex: { next: 2, total: 40 }, orcid: { next: 20, total: 45 } });
	assert.ok(urls.every(u => !/[?&]page=|[?&]start=/.test(u)), "the first page asks for no offset");
	assert.equal(Authors.hasMorePeople(list.paging), true);
});

test("more: one OpenAlex page, one ORCID page, one batched enrichment; nobody listed twice", async () => {
	const { http, urls } = services();
	const first = await Authors.searchProfiles("combined", "Sam Lee", http, {});
	const before = urls.length;
	const { added, paging } = await Authors.moreProfiles("combined", "Sam Lee", first, first.paging, http, {});
	const asked = urls.slice(before);
	assert.equal(asked.filter(u => /authors\?search=.*&page=2/.test(u)).length, 1);
	assert.equal(asked.filter(u => /expanded-search.*&start=20/.test(u)).length, 1);
	assert.equal(asked.filter(u => u.includes("filter=orcid:")).length, 1, "the new ORCID-only cards in one request");
	assert.equal(asked.length, 3);
	assert.equal(added.length, 15 + 20, "OpenAlex A16..A30 and ORCID iDs 21..40, none of them shown before");
	const ids = new Set([...first, ...added].map(c => c.orcid || c.openalexId));
	assert.equal(ids.size, first.length + added.length, "no person twice");
	assert.ok(added.filter(c => c.sources.includes("orcid")).every(c => c.worksCount != null), "new ORCID cards carry their figures");
	assert.deepEqual(paging, { openalex: { next: 3, total: 40 }, orcid: { next: 40, total: 45 } });
	const last = await Authors.moreProfiles("combined", "Sam Lee", [...first, ...added], paging, http, {});
	assert.equal(Authors.hasMorePeople(last.paging), false, "after the last pages there is nothing more to ask");
	const n = urls.length;
	const none = await Authors.moreProfiles("combined", "Sam Lee", [], last.paging, http, {});
	assert.equal(urls.length, n, "no request when neither service has more");
	assert.equal(none.added.length, 0);
});

test("more: an ORCID row of a person already shown merges into that card", async () => {
	const { http } = services();
	const shown = [{ provider: "combined", sources: ["openalex"], id: "A900", openalexId: "A900", orcid: orcidOf(25), name: "Sam Lee", otherNames: [], worksCount: 5 }];
	const { added } = await Authors.moreProfiles("combined", "Sam Lee", shown, { openalex: null, orcid: { next: 20, total: 45 } }, http, {});
	assert.ok(!added.some(c => c.orcid === orcidOf(25)));
	assert.deepEqual(shown[0].sources, ["openalex", "orcid"]);
});

test("more for the ORCID provider pages by start, and a failed page keeps its place", async () => {
	const { http, urls } = services();
	const first = await Authors.searchProfiles("orcid", "Sam Lee", http, {});
	assert.equal(first.length, 20);
	assert.deepEqual(first.paging, { orcid: { next: 20, total: 45 } });
	const { added, paging } = await Authors.moreProfiles("orcid", "Sam Lee", first, first.paging, http, {});
	assert.equal(added.length, 20);
	assert.ok(urls.some(u => /expanded-search.*&start=20/.test(u)));
	assert.deepEqual(paging, { orcid: { next: 40, total: 45 } });
	const broken = { getJSON: async url => { if (url.includes("expanded-search")) throw Object.assign(new Error("down"), { status: 503 }); return http.getJSON(url); } };
	const ctx = {};
	const kept = await Authors.moreProfiles("combined", "Sam Lee", first, { openalex: { next: 2, total: 40 }, orcid: { next: 20, total: 45 } }, broken, ctx);
	assert.deepEqual(kept.paging.orcid, { next: 20, total: 45 }, "pressing again retries the ORCID page");
	assert.ok(ctx.errors.some(e => /ORCID/.test(e)));
});

/* ---------------------------------------------------------------- the window */
async function window() {
	const { http, urls } = services();
	const ui = uiHarness({ prefs: { lastAuthorQuery: JSON.stringify({ provider: "combined" }) }, request: async (_m, url) => ({ response: await http.getJSON(url), status: 200 }) });
	await ui.switchSearchMode("authors"); await ui.switchAuthorProvider("combined");
	ui.get("author-input").value = "Sam Lee"; ui.authorInputChanged();
	await ui.runAuthorAction("profiles");
	return { ui, urls };
}
const nextButton = ui => ui.get("author-profiles").querySelector("button.author-next");

test("the window: a load-more button that fetches only when pressed, appends, and is marked for the self-check", async () => {
	const { ui, urls } = await window();
	const shown = ui.authorSessions.combined.profiles.length, n = urls.length;
	const btn = nextButton(ui);
	assert.ok(btn, "offered when a service has more");
	assert.equal(btn.getAttribute("data-opens"), "network");
	assert.match(btn.textContent, new RegExp("authorNextPeople\\|" + shown + "\\|OpenAlex 40 · ORCID 45"));
	ui.renderAuthorProfiles(); ui.renderAuthorProfiles();
	assert.equal(urls.length, n, "drawing the list asks nothing");
	btn.emit("click");
	for (let i = 0; i < 100 && urls.length < n + 3; i++) await new Promise(r => setTimeout(r, 2));
	await new Promise(r => setTimeout(r, 10));
	assert.equal(ui.authorSessions.combined.profiles.length, shown + 35);
	assert.match(ui.get("status").textContent, /authorNextLoaded\|35/);
	assert.ok(nextButton(ui), "still more to come");
	// the history entry carries where the next page starts, so a reopened search can go on
	const entry = await ui.history.get((await ui.history.list())[0].id);
	assert.equal(entry.query.authorPaging.openalex.next, 3);
	assert.equal(entry.query.authorProfiles.length, shown + 35);
});

test("the window: the next page asks with the name searched, not what the box says now", async () => {
	const { ui, urls } = await window();
	ui.get("author-input").value = "Someone Else";
	const n = urls.length;
	nextButton(ui).emit("click");
	for (let i = 0; i < 100 && urls.length < n + 2; i++) await new Promise(r => setTimeout(r, 2));
	assert.ok(urls.slice(n).filter(u => /search=|expanded-search/.test(u)).every(u => /Sam/.test(decodeURIComponent(u))));
});

test("the paging strings exist in English and Korean", () => {
	for (const k of ["authorNextPeople", "authorNextLoading", "authorNextTip", "authorNextLoaded"])
		for (const lang of ["en", "ko"]) assert.ok(k in I18N.STRINGS[lang], `${lang}: ${k}`);
	assert.match(I18N.STRINGS.en.authorNextLoaded(1, 16), /1 more person/);
});
