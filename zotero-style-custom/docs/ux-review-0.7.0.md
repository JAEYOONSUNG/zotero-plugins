# Style Custom 0.7.0 independent usability review

Reviewed 2026-09-15. Scope: source-only review of `src/workbench.js`, `content/workbench.css`, and Zotero's local `attachmentPreview.js` API. No app, browser, live UI, account, or library was opened or modified. This is not a native visual acceptance report.

The planned grouped navigation, collapsible filters, active chips, density settings, command jump and explicit selection context address layout complexity. The following four findings concern workflow semantics that those layout changes alone do not resolve.

## Findings before implementation

### UX-1 — Filters can look active while having no effect on the current evidence view

**Priority: high.** `rows()` applies parent-paper year, type, status and rating filters. `drawNotes()` and `drawAnnotations()` instead call `library.notes(ids())` / `library.annotations(ids())`; `ids()` restricts only library/selection/collection scope. These views separately apply text search, but ignore the parent-paper filters.

**Concrete flow:** select a publication-year or reading-status filter in Explore, then open Notes or Annotations. Evidence from papers outside that filter can still appear, even though the global controls/chips remain active. A title/author/tag search also becomes note-content or annotation-content search without an explicit change in meaning.

**Action:** define applicability by area. Either intersect evidence parent IDs with the active paper filters, while keeping content search distinct, or disable/hide inapplicable filter controls and state clearly that they are retained for paper views. Give content-search inputs an area-specific label/placeholder. Do not silently remove filters just because the user changed areas.

**Acceptance:** with papers on both sides of a year/status filter, Notes/Annotations either show only eligible parent evidence or visibly identify the filter as inactive in that area. Returning to Explore preserves the filter. Empty results explain which scope/filter applies.

### UX-2 — Save commands do not clearly communicate pending state or the next navigation step

**Priority: high.** The generic `button()` wrapper launches asynchronous handlers without a local pending state. A rapid repeated click on `새 노트 저장` can submit the same text twice and create duplicate notes. Its handler also calls `library.openItem(id)` immediately after creation, opening the native note editor even though the button only promises saving.

**Action:** prevent duplicate submissions for a command while its own operation is pending; show a local progress label and retain enabled cancellation/navigation where appropriate. Make native-editor opening explicit, for example separate `노트 저장` and `저장 후 열기`, or label the existing combined action accurately. On failure, retain the draft and present the error near the action as well as in the shared status region.

**Acceptance:** two clicks before a deferred save resolves produce one create request. A failed save leaves the draft intact and the control usable for retry. A successful save performs exactly the navigation promised by the label. Closing or changing area does not focus an old/detached editor control.

### UX-3 — A single-paper detail view can overwhelm the user with the entire evidence history

**Priority: medium.** `paperList()` starts both note and annotation reads for one selected paper, then appends every returned note and annotation as a full card. Unlike the main paper list, these inline sections have no initial display bound or progressive disclosure.

**Concrete flow:** opening details for a frequently read paper with many highlights creates a long nested list under its metadata and remark editor. Finding the paper's overview or the next available action becomes difficult, and repeated full redraws can be expensive.

**Action:** present `노트 (n)` and `주석 (n)` as progressive sections with a bounded initial set and a clear `더 보기` or link to the full manager. Keep the paper title, metadata and remark controls above the evidence history. Preserve section expansion and current evidence position on refresh when feasible.

**Acceptance:** a fixture with hundreds of annotations has a small initial detail DOM, accurate totals and a reachable route to every annotation. The default expanded content does not bury the paper overview. Native opening still targets the exact selected note or annotation.

### UX-4 — Preview availability should be explained before presenting an empty preview surface

**Priority: medium.** `drawAttachments()` offers `미리보기` for every attachment. Zotero's native preview setter accepts only file attachments, and `attachmentPreview.isValidType` excludes generic files; linked URLs and unsupported formats can therefore lack a usable preview even when `render()` exists.

**Action:** evaluate the native preview's supported-type/file requirements or the attachment metadata before offering an actionable preview. For unsupported or missing files, retain `열기` and provide a short explanation such as `이 형식은 미리보기를 지원하지 않습니다`. Distinguish loading, unavailable, and failed preview states; do not leave an unexplained blank block.

**Acceptance:** PDF/image fixtures offer supported preview; linked-URL and unsupported-file fixtures expose an understandable fallback. Failure and cancellation remove the stale preview surface and do not affect a newer preview. Existing epoch/disposal checks remain intact.

## Final independent review

Reviewed the 0.7.0 implementation on 2026-09-15 using source inspection and fictional DOM fixtures only. Independently ran `node --test zotero-style-custom/test/workbench.test.mjs`: **44 passed, 0 failed** (final rerun after the two review regressions were fixed). Native keyboard behavior, rendered pixel layout and real-library workflows were not exercised.

### Resolution of the four initial findings

- **UX-1 resolved for the reviewed evidence views:** `ids()` now intersects scoped papers with `parentOptions()` before note/annotation/attachment queries. These views use separate content search and explain the parent-paper count in `.sc-context-detail`. Irrelevant controls/chips are hidden in non-paper tool views. The regression `collapsed filter chips remove only the requested filter and parent filters apply to note searches` verifies the ID restriction and retention of an unrelated search filter.
- **UX-2 resolved:** local `aria-busy` and disabled state reject a repeated click on the same button, and note creation no longer opens a native editor automatically; `저장한 노트 열기` is explicit. Pending note creation now also survives element replacement through a stable operation/parent key, as verified below.
- **UX-3 resolved:** inline note/annotation sections show counts, are collapsed initially, start with five entries and expose twenty more per action. Long evidence text is initially limited with an explicit full-text action. Native note/annotation opening remains ID-based.
- **UX-4 resolved for supported-type gating:** linked attachments with a null path and unsupported media types provide an explanation plus Open, rather than a blank preview. Native `isValidType` is checked after assigning the item. Previous preview-generation/disposal guards remain in place.

### Keyboard, filter and selection findings

The grouped navigation keeps all 17 areas reachable. Density and the last visited area persist in the plugin cache. Command search excludes hidden features, exposes combobox/listbox relationships, supports arrow/Home/End/Enter and traps Tab in the command input. Escape first restores focus from the command finder and then closes the workbench with focus returned to its opener. Other workbench areas become inert while the finder is open. Parent filters, individual removable chips, explicit counts of selected papers outside the current result, and two-paper relation-action requirements have corresponding DOM regressions.

Two concrete regressions were independently reproduced beyond the initial 42-test suite, then corrected and independently reverified:

1. **Pending note submission is not retained across redraws.** With a deferred `library.createNote`, click Save, invoke a normal `render()` (also done by notifier reload), then click the replacement Save button. The fixture records **two create requests for the same note draft**. The original element's busy flag is lost when the body is replaced. Track pending mutation state by operation and parent ID, and apply it to replacement controls. Existing user input and navigation should remain usable.
2. **A late area navigation overwrites newer navigation state.** Start navigation to Annotations with a deferred annotation read, navigate to Notes, then resolve the old annotation read. The fixture ends with **`state.tab === 'notes'` but `cache.workbenchUI.lastTab === 'annotations'`**. `navigate()` continues persisting and optionally focusing after a stale `render()` returns. Bind persistence/focus to the latest navigation generation and intended area; an old command must not steal focus from a new view.

### Final fix verification

- **Pending-save redraw regression resolved.** `pendingActions` now lives outside the DOM; note creation has a stable action key containing library and selected parent. A replacement button inherits the busy state, repeated submissions are rejected, and completion clears that state on any replacement control. The regression `pending note creation survives redraw without submitting the same draft twice` passes.
- **Stale navigation persistence/focus regression resolved.** `navigate()` captures `navigationEpoch` and checks it with the target area and visibility before saving the last area, and again before moving focus. Opening the command finder and closing the workbench invalidate older navigation. The regression `a late earlier navigation cannot overwrite the remembered section or move focus from the latest choice` passes.

**Final source/DOM review: accepted for the reviewed scope.** All four initial findings and both concrete follow-up regressions have verified fixes. The final independent command returned **44 passed, 0 failed**. No additional issue was found in the bounded re-review of these two fixes. Native focus/layout and real-library operation remain untested here; the standalone preview is a separate synthetic-data artifact, not evidence of native activation.

Only this review document was modified by the reviewer. No implementation code, tests, profile or native application was changed.
