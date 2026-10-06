/* The reactions card in the detail pane: nothing is asked until "Reactions" is pressed; then one compact card
   with a chip per source and its count, the most discussed posts and stories, the Wikipedia articles, the
   notices and the citation trend. Every item links out and says so (data-opens="browser"); nothing found is
   said plainly and differently from a source that did not answer; the answer is kept and shown again on the
   next visit without a request. Runs the real ui.js with the recorded answers of test/fixtures/reactions. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paper, uiHarness } from "./helpers/search-ui-harness.mjs";
import { fakeNet, zoteroRequest, BRIDGE, QUIET } from "./helpers/reactions-net.mjs";

// The module keeps a polite gap between two requests to one host (200 ms): a press takes about half a second.
const settle = async ui => {
	for (let i = 0; i < 300; i++) {
		await new Promise(r => setTimeout(r, 10));
		if (!ui || !ui.reactionsBusy()) { if (i > 2) return; }
	}
};
const TITLES = { [BRIDGE]: "Bridge RNAs direct programmable recombination of target and donor DNA", [QUIET]: "Enhanced proofreading governs CRISPR\u2013Cas9 targeting accuracy" };
function setup({ doi = BRIDGE, net = fakeNet(), files = new Map(), extra = {} } = {}) {
	const launched = [];
	const ui = uiHarness({ realRows: true, request: zoteroRequest(net), historyFiles: files, launchURL: url => launched.push(url),
		search: async () => [paper("p", { doi, title: TITLES[doi] || "A paper without a DOI", source: "openalex", ...extra })] });
	return { ui, net, launched, files };
}
const all = (node, selector) => node.querySelectorAll(selector);
const button = box => all(box, "button").find(b => b.className.split(" ").includes("rx-btn"));

test("opening a paper asks nothing; the button says what it will do and that it reaches the network", async () => {
	const { ui, net } = setup();
	await ui.runSearch();
	const r = ui.state.records[0];
	ui.state.detailKey = r.key;
	ui.originalRenderDetail();
	await ui.renderReactions(r);
	await settle(ui);
	assert.equal(net.calls.length, 0, "nothing is fetched until the button is pressed");
	const box = ui.get("d-reactions");
	assert.equal(box.hidden, false);
	const b = button(box);
	assert.equal(b.textContent, "reactButton");
	assert.equal(b.getAttribute("data-opens"), "network");
	assert.equal(b.disabled, false);
});

test("pressing Reactions draws the card: source chips with counts, the most discussed list, Wikipedia, the trend; each item opens its page", async () => {
	const { ui, net, launched } = setup();
	await ui.runSearch();
	const r = ui.state.records[0];
	ui.state.detailKey = r.key;
	await ui.renderReactions(r);
	button(ui.get("d-reactions")).emit("click");
	await settle(ui);
	assert.ok(net.calls.length > 0 && net.calls.length <= 10, "one press, at most ten requests: " + net.calls.length);
	const box = ui.get("d-reactions");
	const card = box.querySelector("div.rx-card");
	assert.ok(card, "the card is drawn");
	const chips = all(card, "span.rx-chip").map(c => c.textContent);
	assert.deepEqual(chips.slice(0, 3), ["Bluesky6", "Hacker News3", "Wikipedia2"]);
	assert.ok(chips.some(c => c === "reactNoNotices"), "a clean paper says it has no notices: " + chips.join(" / "));
	const items = all(card, "button.rx-item");
	assert.ok(items.length >= 5, "most discussed and Wikipedia items: " + items.length);
	assert.ok(items.every(b => b.getAttribute("data-opens") === "browser"), "every item is marked as opening the browser");
	assert.match(all(card, "div.rx-sub")[0].textContent, /^reactMostDiscussed\|5/);
	items[0].emit("click");
	assert.deepEqual(launched, ["https://bsky.app/profile/erictopol.bsky.social/post/3kvtpwa2axr23"]);
	assert.match(items[0].textContent, /@erictopol\.bsky\.social/);
	assert.match(items[0].textContent, /Bridge RNA: a big discovery/);
	const refresh = all(card, "button").find(b => b.className.split(" ").includes("rx-refresh"));
	assert.equal(refresh.getAttribute("data-opens"), "network");
	assert.equal(all(card, "span.rx-bar").length, 3, "a bar per year of the citation trend");
	assert.equal(card.querySelector("p.rx-empty"), null);
	// Every button in the card says what pressing it does: the self-check never presses one that opens a window.
	assert.ok(all(box, "button").every(b => b.getAttribute("data-opens") || b.getAttribute("data-safe")), "data-opens on every button");
});

test("nothing found is said in one plain line; a source that did not answer is named instead", async () => {
	const quiet = setup({ doi: QUIET });
	await quiet.ui.runSearch();
	let r = quiet.ui.state.records[0];
	quiet.ui.state.detailKey = r.key;
	await quiet.ui.renderReactions(r);
	button(quiet.ui.get("d-reactions")).emit("click");
	await settle(quiet.ui);
	let card = quiet.ui.get("d-reactions").querySelector("div.rx-card");
	assert.equal(card.querySelector("p.rx-empty").textContent, "reactNothing");
	assert.equal(card.querySelector("p.rx-failed"), null);

	const down = setup({ doi: QUIET, net: fakeNet({ fail: { "api.bsky.app": 503 } }) });
	await down.ui.runSearch();
	r = down.ui.state.records[0];
	down.ui.state.detailKey = r.key;
	await down.ui.renderReactions(r);
	button(down.ui.get("d-reactions")).emit("click");
	await settle(down.ui);
	card = down.ui.get("d-reactions").querySelector("div.rx-card");
	assert.equal(card.querySelector("p.rx-empty"), null, "not \"nothing found\" when Bluesky never answered");
	assert.equal(card.querySelector("p.rx-failed").textContent, "reactFailedSources|Bluesky");
	assert.ok(all(card, "span.rx-chip").some(c => c.className.includes("failed") && c.textContent.startsWith("Bluesky")));
});

test("a paper without a DOI cannot be looked up, and says why", async () => {
	const { ui, net } = setup({ doi: null });
	await ui.runSearch();
	const r = ui.state.records[0];
	ui.state.detailKey = r.key;
	await ui.renderReactions(r);
	const b = button(ui.get("d-reactions"));
	assert.equal(b.disabled, true);
	assert.equal(b.getAttribute("data-tip"), "reactNoDoi");
	b.emit("click");
	await settle(ui);
	assert.equal(net.calls.length, 0);
});

test("the answer is kept on disk: the next window shows the card at once and asks nothing", async () => {
	const files = new Map();
	const first = setup({ files });
	await first.ui.runSearch();
	let r = first.ui.state.records[0];
	first.ui.state.detailKey = r.key;
	await first.ui.renderReactions(r);
	button(first.ui.get("d-reactions")).emit("click");
	await settle(first.ui);
	assert.ok([...files.keys()].some(k => k.endsWith("reactions.json")), "kept in reactions.json");

	const net = fakeNet();
	const second = setup({ files, net });
	await second.ui.runSearch();
	r = second.ui.state.records[0];
	second.ui.state.detailKey = r.key;
	await second.ui.renderReactions(r);
	await settle(second.ui);
	assert.ok(second.ui.get("d-reactions").querySelector("div.rx-card"), "the kept card is shown without pressing");
	assert.equal(net.calls.length, 0, "and without a request");
});
