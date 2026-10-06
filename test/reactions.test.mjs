/* How a paper was received: Bluesky, Hacker News, Wikipedia, the notices about it and its citation trend.
   Every answer here is a real one, recorded 2026-10-06 with a plain User-Agent, no key and no e-mail
   (17 requests in all; test/fixtures/reactions):
     bridge    = 10.1038/s41586-024-07552-4 (Bridge RNAs, Nature 2024), from the user's library
     quiet     = 10.1038/nature24268 (Nature 2017), from the user's library: Bluesky found nothing for it
     retracted = 10.1016/S0140-6736(97)11096-0 (Wakefield, Lancet 1998)
   Crossref's reference lists were dropped from the fixtures; everything else is as the services sent it.
   Crossref Event Data (api.eventdata.crossref.org) no longer answers and api.crossref.org/v1/relationships is
   "Route not found", so Wikipedia's own search is the source for Wikipedia citations. */
import { test } from "node:test";
import assert from "node:assert/strict";
import Reactions from "../content/reactions.js";
import { fakeNet, BRIDGE, QUIET, RETRACTED, DAY } from "./helpers/reactions-net.mjs";

const service = (net, extra = {}) => {
	let clock = Date.parse("2026-10-06T05:00:00Z");
	const now = () => clock;
	const svc = Reactions.create({ fetch: net.fetch, now, sleep: async () => {}, ...extra });
	return { svc, advance: ms => { clock += ms; } };
};

test("the Bridge RNA paper: Bluesky posts by landing page and title, merged; the top five with handle, date, text and link", async () => {
	const net = fakeNet();
	const { svc } = service(net);
	const out = await svc.lookup({ doi: BRIDGE });
	// Six posts link the article; the title search finds five of the same six. The union is six, not eleven.
	assert.equal(out.bluesky.count, 6);
	assert.equal(out.bluesky.top.length, 5, "at most five shown");
	const first = out.bluesky.top[0];
	assert.equal(first.handle, "erictopol.bsky.social");
	assert.equal(first.date, "2024-06-26T16:26:01.821Z");
	assert.match(first.text, /^Bridge RNA: a big discovery from nature/);
	assert.equal(first.url, "https://bsky.app/profile/erictopol.bsky.social/post/3kvtpwa2axr23");
	assert.equal(first.likes, 26);
	// Ranked by engagement: a liked post before an ignored one.
	const likes = out.bluesky.top.map(p => p.likes);
	assert.deepEqual(likes, [...likes].sort((a, b) => b - a));
	assert.ok(out.bluesky.top.every(p => !/bot/i.test(p.author + " " + p.handle)), "a bot that reposts Hacker News headlines is counted, not shown");
});

test("Hacker News by landing page and by DOI: three stories with points, comments and the discussion link", async () => {
	const net = fakeNet();
	const { svc } = service(net);
	const out = await svc.lookup({ doi: BRIDGE });
	assert.equal(out.hackerNews.count, 3);
	assert.deepEqual(out.hackerNews.top.map(s => [s.points, s.comments]), [[10, 1], [3, 0], [2, 0]]);
	assert.equal(out.hackerNews.top[0].url, "https://news.ycombinator.com/item?id=40808944");
	assert.equal(out.hackerNews.top[0].date, "2024-06-27T10:08:41Z");
	const hn = net.calls.filter(c => c.url.startsWith("https://hn.algolia.com/")).map(c => new URL(c.url).searchParams.get("query"));
	assert.deepEqual(hn.sort(), [BRIDGE, "www.nature.com/articles/s41586-024-07552-4"].sort(), "asked by DOI and by the landing page");
});

test("Wikipedia articles that cite the DOI, the citation trend from OpenAlex, and no notices for a clean paper", async () => {
	const net = fakeNet();
	const { svc } = service(net);
	const out = await svc.lookup({ doi: BRIDGE });
	assert.equal(out.wikipedia.count, 2);
	assert.deepEqual(out.wikipedia.articles.map(a => a.title), ["Patrick Hsu", "Bridge RNA"]);
	assert.equal(out.wikipedia.articles[1].url, "https://en.wikipedia.org/wiki/Bridge_RNA");
	assert.deepEqual(out.citations.byYear, [{ year: 2024, n: 30 }, { year: 2025, n: 71 }, { year: 2026, n: 62 }]);
	assert.equal(out.citations.total, 163);
	assert.equal(out.citations.source, "openalex");
	// Europe PMC links the bioRxiv preprint ("Update of"): a version, not a notice about the paper.
	assert.deepEqual(out.notices.events, []);
	assert.equal(out.notices.status, "clean");
	assert.equal(out.landing, "https://www.nature.com/articles/s41586-024-07552-4", "the landing page comes from Crossref, no redirect followed");
	assert.deepEqual(out.failed, []);
	assert.equal(out.nothing, false);
});

test("the most discussed list merges Bluesky and Hacker News by engagement, five at most, each with its link", async () => {
	const { svc } = service(fakeNet());
	const out = await svc.lookup({ doi: BRIDGE });
	assert.ok(out.mostDiscussed.length <= 5 && out.mostDiscussed.length >= 3);
	assert.deepEqual(out.mostDiscussed.slice(0, 2).map(x => [x.source, x.url]), [
		["bluesky", "https://bsky.app/profile/erictopol.bsky.social/post/3kvtpwa2axr23"],
		["hackerNews", "https://news.ycombinator.com/item?id=40808944"]]);
	assert.ok(out.mostDiscussed.every(x => /^https:\/\//.test(x.url) && x.date));
});

test("requests are plain: one User-Agent, no e-mail, no mailto, no key unless one is set; the record's own trend spares OpenAlex", async () => {
	const net = fakeNet();
	const { svc } = service(net);
	await svc.lookup({ doi: BRIDGE, title: "Bridge RNAs direct programmable recombination of target and donor DNA",
		citesByYear: [{ year: 2024, n: 30 }, { year: 2025, n: 71 }], citations: 101 });
	assert.ok(net.calls.length <= 10, "one paper costs at most ten requests: " + net.calls.length);
	for (const call of net.calls) {
		assert.doesNotMatch(call.url, /mailto|@|api_key|email/i, call.url);
		assert.equal(call.headers["User-Agent"], Reactions.USER_AGENT);
		assert.doesNotMatch(JSON.stringify(call.headers), /@/);
	}
	assert.ok(!net.calls.some(c => c.url.includes("api.openalex.org")), "the yearly citations the search already holds are used");
	const keyed = fakeNet();
	await service(keyed, { openAlexKey: () => "k3y" }).svc.lookup({ doi: BRIDGE });
	assert.ok(keyed.calls.find(c => c.url.includes("api.openalex.org")).url.includes("api_key=k3y"));
	const held = fakeNet();
	await service(held, { openAlexHeld: () => true }).svc.lookup({ doi: BRIDGE });
	assert.ok(!held.calls.some(c => c.url.includes("api.openalex.org")), "a spent OpenAlex budget is not asked again");
});

test("a retracted paper: Crossref's retraction and Europe PMC's expression of concern and comments, one notice per notice", async () => {
	const { svc } = service(fakeNet());
	const out = await svc.lookup({ doi: RETRACTED });
	assert.equal(out.notices.status, "retracted");
	const kinds = out.notices.events.map(e => [e.kind, e.date]);
	assert.ok(kinds.some(([k, d]) => k === "retraction" && d === "2010-02-06"), JSON.stringify(kinds));
	assert.ok(kinds.some(([k]) => k === "expression-of-concern"), "Europe PMC's expression of concern is kept");
	// The 2010 retraction arrives from Crossref and from Europe PMC: one row, not two.
	assert.equal(out.notices.events.filter(e => e.kind === "retraction" && e.date.startsWith("2010")).length, 1);
	assert.equal(out.notices.comments, 26);
	assert.match(out.notices.commentsUrl, /^https:\/\/europepmc\.org\/article\/MED\/9500320/);
	assert.ok(out.notices.events.every(e => /^https:\/\//.test(e.url)), "each notice links out");
	assert.equal(out.nothing, false);
});

test("nothing found is said plainly, and is not the same answer as a source that did not answer", async () => {
	const { svc } = service(fakeNet());
	const quiet = await svc.lookup({ doi: QUIET });
	assert.equal(quiet.bluesky.count, 0);
	assert.equal(quiet.hackerNews.count, 0);
	assert.equal(quiet.wikipedia.count, 0);
	assert.equal(quiet.notices.status, "clean");
	assert.deepEqual(quiet.failed, []);
	assert.equal(quiet.nothing, true);

	const broken = service(fakeNet({ fail: { "api.bsky.app": 503 } })).svc;
	const out = await broken.lookup({ doi: QUIET });
	assert.deepEqual(out.failed, ["bluesky"]);
	assert.equal(out.nothing, false, "Bluesky never answered: not \"nothing found\"");
});

test("kept per DOI for seven days: a second look costs nothing, an eighth day asks again, Refresh always asks", async () => {
	const net = fakeNet();
	const { svc, advance } = service(net);
	const first = await svc.lookup({ doi: BRIDGE });
	const asked = net.calls.length;
	assert.equal(first.cached, false);
	const again = await svc.lookup({ doi: "https://doi.org/" + BRIDGE.toUpperCase() });
	assert.equal(net.calls.length, asked, "the same paper, written another way, is the same entry");
	assert.equal(again.cached, true);
	assert.equal(again.bluesky.count, 6);
	assert.equal(svc.peek(BRIDGE).bluesky.count, 6, "peek reads the kept answer and asks nothing");
	advance(6 * DAY);
	await svc.lookup({ doi: BRIDGE });
	assert.equal(net.calls.length, asked, "six days later: still kept");
	advance(2 * DAY);
	await svc.lookup({ doi: BRIDGE });
	assert.equal(net.calls.length, 2 * asked, "after seven days it is asked again");
	await svc.lookup({ doi: BRIDGE }, { force: true });
	assert.equal(net.calls.length, 3 * asked, "Refresh asks again whatever the age");
});

test("an answer with a source missing is kept a day; a refresh where everything failed keeps the older answer", async () => {
	let down = false;
	const net = fakeNet();
	const fetch = async (url, options) => down ? { status: 503, json: null } : net.fetch(url, options);
	let clock = 0;
	const svc = Reactions.create({ fetch, now: () => clock, sleep: async () => {} });
	await svc.lookup({ doi: BRIDGE });
	down = true;
	const kept = await svc.lookup({ doi: BRIDGE }, { force: true });
	assert.equal(kept.bluesky.count, 6, "the earlier answer stands");
	assert.equal(kept.stale, true);
	const partial = Reactions.create({ fetch: fakeNet({ fail: { "hn.algolia.com": 500 } }).fetch, now: () => clock, sleep: async () => {} });
	await partial.lookup({ doi: BRIDGE });
	clock += DAY + 1;
	assert.equal(partial.peek(BRIDGE).fresh, false, "a partial answer goes stale after a day");
});

test("the store round-trips through JSON and keeps only the newest entries", () => {
	const store = Reactions.createStore({ limit: 2 });
	store.set("10.1/a", { value: { doi: "10.1/a" }, at: 1, expires: 10 });
	store.set("10.1/b", { value: { doi: "10.1/b" }, at: 2, expires: 10 });
	store.set("10.1/c", { value: { doi: "10.1/c" }, at: 3, expires: 10 });
	const back = Reactions.createStore();
	back.import(JSON.parse(JSON.stringify(store.export())));
	assert.equal(back.get("10.1/a"), null);
	assert.equal(back.get("10.1/c").value.doi, "10.1/c");
	assert.equal(back.import({ version: 99 }), 0, "an unknown file is ignored");
});

test("no DOI: nothing is asked", async () => {
	const net = fakeNet();
	const out = await service(net).svc.lookup({ doi: "" });
	assert.equal(out.reason, "no-doi");
	assert.equal(net.calls.length, 0);
});

test("a short title is not searched on Bluesky: three words would bring in posts about something else", async () => {
	const net = fakeNet();
	await service(net).svc.lookup({ doi: QUIET, title: "CRISPR off-targets" });
	const queries = net.calls.filter(c => c.url.startsWith("https://api.bsky.app/")).map(c => new URL(c.url).searchParams.get("q"));
	assert.ok(queries.every(q => q === "*"), "only the address searches: " + queries.join(" | "));
});

test("the yearly citations a search already holds are OpenAlex's, shown without a total that would mix two indexes", async () => {
	const out = await service(fakeNet()).svc.lookup({ doi: BRIDGE, citesByYear: [{ year: 2025, n: 71 }, { year: 2024, n: 30 }], citations: 180 });
	assert.deepEqual(out.citations, { total: null, byYear: [{ year: 2024, n: 30 }, { year: 2025, n: 71 }], source: "openalex", held: true });
});
