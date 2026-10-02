import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreview, checkPreview, FAKE } from "../scripts/search-preview.mjs";

test("search preview: real ui.js renders fictional rows into static, asset-free pages", async () => {
	const out = await buildPreview();
	assert.deepEqual(checkPreview(out), []);
	assert.equal(out.rows, FAKE.length);
	assert.equal(out.netCalls, 0, "the preview never touches the network");
	assert.match(out.results, /<style>[\s\S]*<\/style>/, "the real search.css is inlined");
	assert.match(out.results, /Search engine/, "the real i18n strings are applied to the markup");
	assert.match(out.detail, /Open in browser/, "the selected row fills the detail pane");
});

test("search preview drives the real handlers: Jenna facet, 3/2/1 selection, one failed import retried alone", async () => {
	const { trace } = await buildPreview({ locale: "ko" });
	assert.deepEqual(trace.facet.rows, ["9", "8", "10", "7"], "rows 7-10, per-year descending");
	assert.equal(trace.facet.selected, "선택 3편 · 화면에 2편 · 필터 밖 1편");
	assert.match(trace.facet.evidence, /^OpenAlex 기준 · 저널 IF 추정 10\.1 · PDF 후보 있음$/);
	assert.match(trace.facet.line, /같은 이름의 저자: 결과 4편 · 미보유 4편/);
	assert.equal(trace.facet.cleared, 12);
	assert.deepEqual(trace.import.selected, ["9"]);
	assert.equal(trace.import.calls.length, 3);
	assert.equal(trace.retry.calls.length, 1);
	assert.ok(trace.retry.calls[0].endsWith("demo9"));
	assert.equal(trace.importLabel, "Zotero에 3편 추가");
});

test("search preview: history entry with date and count, new rows on a re-run, owned collections, year histogram", async () => {
	const { trace } = await buildPreview({ locale: "ko" });
	assert.match(trace.history.entries[0], /12편 · 오늘$/);
	assert.deepEqual(trace.rerun.marked, ["13"], "only the paper missing from the last run is marked");
	assert.equal(trace.rerun.tip, "지난번 이 검색 이후 새로 나온 결과");
	assert.equal(trace.collections.text, "컬렉션: Tissue maps › 2025 reviews · Reading list");
	assert.match(trace.collections.tip, /^Repair atlases › Tissue maps › 2025 reviews\nReading list$/);
	assert.equal(trace.collections.hiddenOnUnowned, true, "nothing for a paper that is not in the library");
	assert.deepEqual(trace.histogram.ends, ["2022", "2026"]);
	assert.deepEqual(trace.histogram.pressed, ["1", "4", "8", "10"]);
	assert.equal(trace.histogram.clearLabel, "2025 ×");
	assert.equal(trace.histogram.cleared, 12);
});

test("search preview: library filter counts, Export/View menus, version lines and a failed single add", async () => {
	const { trace, netCalls } = await buildPreview({ locale: "ko" });
	assert.equal(trace.library.start, "전체 12 / 미보유 11 / 보유 1");
	assert.equal(trace.library.withFacet, "전체 4 / 미보유 4 / 보유 0", "counts follow the author facet");
	assert.equal(trace.library.afterImport, "전체 12 / 미보유 9 / 보유 3", "two added, one failed");
	assert.deepEqual(trace.menu.labels, ["열: 기본", "열: 전체", "제목 아래 소속", "지표", "상세"]);
	assert.deepEqual(trace.menu.export, ["CSV 복사", "CSV 저장"]);
	assert.equal(trace.versions.explicit.line, "출판본: Cell · 2025 · 보유 · 결과에서 보기");
	assert.equal(trace.versions.inferred.line, "출판본 추정: eLife · 2023 · 미보유 · 결과에서 보기");
	assert.equal(trace.versions.unrelated.hidden, true, "a similar title is not a link");
	assert.equal(trace.single.after.status, "추가 실패 · fictional failure");
	assert.equal(trace.single.after.selected, "선택 1편");
	assert.equal(netCalls, 0);
});
