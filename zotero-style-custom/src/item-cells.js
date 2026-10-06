/* The items list, one cell at a time: a hover highlight for the column under
   the pointer, column-specific entries at the top of Zotero's item context
   menu, and the style of the narrow "more" column. Every write goes through a
   runtime function that already exists; this file only decides what to offer. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CustomStyleItemCells = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const STYLE_ID = "style-custom-cells";
  const TREE = "#zotero-items-tree";
  const MARK = "data-sc-cell-menu";

  const attr = value => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  /* The static part: the "more" button. The hover rules follow per column. */
  function baseCSS() {
    return `
${TREE} .cell .sc-more{appearance:none;-moz-appearance:none;margin:0;padding:0;max-height:none;border:0;background:transparent;width:24px;height:22px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:15px;line-height:1;color:#6B7280;cursor:pointer}
${TREE} .row:hover .cell .sc-more{color:#111827}
${TREE} .cell .sc-more:hover{background:rgba(17,24,39,.08);color:#111827}
${TREE} .row.selected .cell .sc-more{color:inherit;opacity:.85}
${TREE} .row.selected .cell .sc-more:hover{background:rgba(255,255,255,.2);opacity:1}
@media (prefers-color-scheme: dark){
${TREE} .cell .sc-more{color:#9AA3B2}
${TREE} .row:hover .cell .sc-more{color:#E5E7EB}
${TREE} .cell .sc-more:hover{background:rgba(255,255,255,.12);color:#F3F4F6}
}
`;
  }

  /* One pair of rules per visible column: the body cells of the column (not on
     a selected row, whose blue keeps priority) and its header. The pointer's
     column is named on the tree root, so rows recycled by scrolling need
     nothing. */
  function hoverCSS(keys, escape) {
    const esc = escape || (s => s);
    const out = [];
    const dark = [];
    const hovered = [];
    for (const key of keys) {
      const col = `${TREE}[data-sc-hover-col="${attr(key)}"]`;
      const cls = `.cell.${esc(key)}`;
      // The cell box is shorter than its row; the tint reaches the row's full height (the gap is
      // measured into --sc-hover-pad on hover) so the column reads as one band, not a strip of slivers.
      out.push(`${col} .virtualized-table-body .row:not(.selected) ${cls}{background-color:#F1F6FF;box-shadow:0 calc(-1 * var(--sc-hover-pad, 0px)) 0 #F1F6FF,0 var(--sc-hover-pad, 0px) 0 #F1F6FF}`);
      out.push(`${col} .virtualized-table-header ${cls}{background-color:#E8F0FF;box-shadow:inset 0 -2px 0 #7FAEFF}`);
      dark.push(`${col} .virtualized-table-body .row:not(.selected) ${cls}{background-color:#1E2A3D;box-shadow:0 calc(-1 * var(--sc-hover-pad, 0px)) 0 #1E2A3D,0 var(--sc-hover-pad, 0px) 0 #1E2A3D}`);
      dark.push(`${col} .virtualized-table-header ${cls}{background-color:#22314A;box-shadow:inset 0 -2px 0 #5B8EE6}`);
      /* The box under the pointer is found by the browser's own :hover, in the column named on the tree.
         Zotero redraws cells (a reading tick each second, any notifier) and a mark set on one cell
         element vanished with it, so the box flickered and then stayed off (the user, 2026-10-07). */
      hovered.push(`${col} .virtualized-table-body .row:hover ${cls}`);
    }
    out.push(`${TREE}[data-sc-hover-col] .virtualized-table-body .row:not(.selected):hover{background-color:rgba(58,63,75,.045)}`);
    // The fill stays off a selected row: white selected text on this pale blue read at 1.2:1. It keeps only its outline.
    // The hovered cell: a soft rounded box as tall as the row, 3px inside it, drawn behind the cell's content.
    const box = `content:"";position:absolute;left:-2px;right:-2px;top:calc(3px - var(--sc-hover-pad, 0px));bottom:calc(3px - var(--sc-hover-pad, 0px));border-radius:8px;pointer-events:none;z-index:-1`;
    const sel = (suffix, state) => hovered.map(h => h.replace('.row:hover', '.row' + state + ':hover') + suffix).join(',');
    if (hovered.length) {
      out.push(`${sel('', '')}{position:relative;isolation:isolate;overflow:visible}`);
      out.push(`${sel('::before', ':not(.selected)')}{${box};background-color:#E3EDFF;box-shadow:inset 0 0 0 1.5px #5B9BFF}`);
      out.push(`${sel('::before', '.selected')}{${box};box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.9)}`);
    }
    dark.push(`${TREE}[data-sc-hover-col] .virtualized-table-body .row:not(.selected):hover{background-color:rgba(255,255,255,.04)}`);
    if (hovered.length) dark.push(`${sel('::before', ':not(.selected)')}{${box};background-color:#26385A;box-shadow:inset 0 0 0 1.5px #7FAEFF}`);
    return out.join("\n") + `\n@media (prefers-color-scheme: dark){\n${dark.join("\n")}\n}\n`;
  }

  function frame(win, fn) {
    if (typeof win.requestAnimationFrame === "function") return win.requestAnimationFrame(fn);
    if (typeof win.setTimeout === "function") return win.setTimeout(fn, 16);
    fn(); return 0;
  }
  function unframe(win, id) {
    if (!id) return;
    if (typeof win.cancelAnimationFrame === "function") win.cancelAnimationFrame(id);
    else if (typeof win.clearTimeout === "function") win.clearTimeout(id);
  }

  // What each column key asks of the menu.
  const JOURNAL = new Set(["journalMark", "publication", "venue", "publicationTitle", "journalAbbreviation"]);
  const METRIC = new Set(["if", "oaCitedness"]);
  const AUTHOR = new Set(["affiliation", "firstInstitution", "correspondingInstitution", "institutionTier"]);
  const FIELDS = {
    title: "title", year: "date", date: "date", publisher: "publisher", publicationTitle: "publicationTitle",
    journalAbbreviation: "journalAbbreviation", language: "language", accessDate: "accessDate",
    libraryCatalog: "libraryCatalog", callNumber: "callNumber", rights: "rights", archive: "archive",
    extra: "extra", venue: "publicationTitle"
  };
  function groupOf(key) {
    if (JOURNAL.has(key)) return "journal";
    if (METRIC.has(key)) return "metric";
    if (AUTHOR.has(key)) return "author";
    if (["citations", "status", "rating", "time", "progress", "lastRead", "tags", "tagCount", "files"].includes(key)) return key === "progress" || key === "lastRead" ? "time" : key === "tagCount" ? "tags" : key;
    return "field";
  }

  /* The entries for one cell. Each is {label, run, disabled, checked, children}
     or {separator:true}. ctx = {rt, win, item, items, key, text}. */
  function plan(ctx) {
    const {rt, win, item, items, key, text} = ctx;
    const out = [];
    const say = message => rt.say(win, message);
    const journalName = () => String(rt.journalRecord?.(item)?.name || "").trim();
    const group = groupOf(key);
    // Several selected rows: the entries that make sense for many act on all of them and say how many.
    const many = Array.isArray(items) && items.length > 1 ? items : null;
    const counted = (label, manyLabel) => many ? {label: rt.t(manyLabel).replace("{0}", String(many.length)), raw: true} : {label};
    if (group === "journal" || group === "metric") {
      const name = journalName();
      if (!name) return [{label: "저널 정보가 없습니다", disabled: true}];
      out.push({label: "저널 지표 보기", run: () => rt.openWorkbench(win, "journals", "journal:" + name)});
      if (group === "journal") {
        out.push({label: "이 저널로 목록 거르기", run: () => rt.filterListBy?.(win, name)});
        out.push({label: "저널명 복사", run: () => { rt.Z.Utilities.Internal.copyTextToClipboard(name); say("저널명을 복사했습니다."); }});
      } else {
        out.push({label: "이 저널 지표 새로고침", run: async () => {
          await rt.refreshJournal(item);
          await rt.refreshWindows?.();
          say(name + " · " + rt.t("저널 지표를 새로 받았습니다."));
        }});
      }
    } else if (group === "citations") {
      out.push({...counted("인용 수 새로고침", "선택한 {0}편 인용 수 새로고침"), run: async () => {
        const result = await rt.refreshCitations(many || [item], {force: true});
        say(`인용 수 확인 ${result.ok}개 · 미확인 ${result["not-found"]}개 · 식별자 부족 ${result.unsupported}개 · 조회 오류 ${result.error}개`);
      }});
      out.push({label: "이 논문을 인용한 논문 보기", run: () => rt.openWorkbench(win, "related")});
    } else if (group === "status") {
      const words = {unread: "안 읽음", reading: "읽는 중", done: "완료"};
      const current = rt.state?.(item)?.status;
      for (const status of ["unread", "reading", "done"]) {
        out.push({label: words[status], checked: current === status, run: () => rt.edit(items, {status})
          .then(() => say(rt.t("읽기 상태를 바꿨습니다") + " · " + rt.t(words[status])))});
      }
    } else if (group === "rating") {
      const current = Number(rt.state?.(item)?.rating) || 0;
      for (let rating = 0; rating <= 5; rating++) {
        out.push({label: rating ? "★".repeat(rating) : "별점 지우기", checked: current === rating, run: () => rt.edit(items, {rating})});
      }
    } else if (group === "time") {
      out.push({label: "읽기 진행 열기", run: () => rt.openWorkbench(win, "reading")});
    } else if (group === "tags") {
      out.push({...counted("태그 추가…", "선택한 {0}편에 태그 추가…"), run: async () => {
        const prompt = (win.Services || globalThis.Services)?.prompt;
        const value = {value: ""};
        if (!prompt || !prompt.prompt(win, rt.t("태그 추가"), rt.t("추가할 태그 이름"), value, null, {})) return;
        const tag = String(value.value || "").trim();
        if (!tag) return;
        await rt.libraryService.addTags((many || [item]).map(ref => ref.id), [tag]);
        await rt.refreshWindows?.();
      }});
      const tags = (rt.displayTags?.(item) || []).slice(0, 25);
      if (tags.length) {
        out.push({label: "태그 지우기", children: tags.map(t => ({label: t.tag, raw: true, run: async () => {
          await rt.libraryService.removeTags([item.id], [t.tag]);
          await rt.refreshWindows?.();
        }}))});
      }
    } else if (group === "files") {
      out.push({label: "PDF 열기", run: async () => {
        const best = await item.getBestAttachment?.();
        if (!best) throw new Error("열 수 있는 첨부파일이 없습니다.");
        await rt.libraryService.openItem(best.id);
      }});
      out.push({label: "PDF 찾기", run: async () => {
        const result = await rt.findPDF(item.id);
        say(result.status === "found" ? "PDF를 찾아 첨부했습니다." : "받을 수 있는 PDF를 찾지 못했습니다.");
      }});
      out.push({label: "첨부 미리보기에서 보기", run: () => rt.openWorkbench(win, "attachments")});
    } else if (group === "author") {
      const work = rt.paperWorks?.()[rt.identity(item)];
      const picked = work && rt.affiliationTools.principals(work.people);
      const person = key === "firstInstitution" ? picked?.first : (picked?.corresponding || picked?.first);
      const id = person && rt.discoverTools.shortID(person.id);
      const followed = !!id && (rt.watchedAuthors?.() || []).some(row => row.id === id);
      out.push({label: followed ? "이미 관심 저자입니다" : "이 저자 팔로우", disabled: !id || followed, run: async () => {
        await rt.watchAuthor({id, name: person.name, institution: person.institution || ""});
        say("{0}을(를) 관심 저자에 추가했습니다.".replace("{0}", person.name));
      }});
      out.push({label: "저자 보기", run: () => rt.openWorkbench(win, "authors", "pi")});
      out.push({label: "소속 복사", run: () => {
        const value = String(text || rt.value(key, item) || "");
        rt.Z.Utilities.Internal.copyTextToClipboard(value); say("소속을 복사했습니다.");
      }});
    } else {
      const field = key === "firstCreator" || key === "authors" ? "creator" : key.startsWith("field-") ? key.slice(6) : FIELDS[key];
      if (field) out.push({label: "이 항목 편집", run: () => rt.editField(win, item, field)});
      out.push({label: "값 복사", run: () => {
        const value = String(text || (field && field !== "creator" ? item.getField(field) : "") || "");
        rt.Z.Utilities.Internal.copyTextToClipboard(value); say("값을 복사했습니다.");
      }});
    }
    return out;
  }

  /* One window: hover highlight (when enabled), the contextmenu record and the
     popup entries. Everything is undone by the returned function. */
  function attach(win, state, rt, {hover = true} = {}) {
    const doc = win.document;
    if (typeof doc?.addEventListener !== "function") return () => {};
    const mine = [];
    const listen = (target, name, fn, capture) => {
      target.addEventListener(name, fn, capture);
      const entry = [target, name, fn, capture];
      mine.push(entry); (state.listeners ||= []).push(entry);
    };
    const escape = s => (win.CSS?.escape ? win.CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
    let style = null, known = new Set(), rootNode = null, lastCell = null, pending = null, raf = 0;
    const debug = state.cellsDebug = {overs: 0, trustedOvers: 0, outs: 0, clears: 0, applies: 0};

    const ensureStyle = () => {
      if (style) return style;
      style = doc.createElementNS(XHTML, "style");
      style.id = STYLE_ID;
      style.textContent = baseCSS();
      (doc.head || doc.documentElement).appendChild(style);
      return style;
    };
    ensureStyle();

    const visibleKeys = () => {
      const tree = win.ZoteroPane?.itemsView?.tree;
      return (tree?._getVisibleColumns?.() || []).map(c => c.dataKey);
    };
    const keyOf = cell => {
      const keys = visibleKeys();
      for (const k of keys) if (cell.classList.contains(k)) return k;
      return null;
    };
    const rules = keys => {
      known = new Set(keys);
      ensureStyle().textContent = baseCSS() + (hover ? hoverCSS(keys, escape) : "");
    };
    const clear = () => {
      debug.clears++;
      if (lastCell) { lastCell.removeAttribute("data-sc-hover-cell"); lastCell = null; }
      if (rootNode) { rootNode.removeAttribute("data-sc-hover-col"); try { rootNode.style?.removeProperty?.("--sc-hover-pad"); } catch (_) {} rootNode = null; }
      // Rows are recycled while scrolling: a mark can sit on a cell this closure no longer holds.
      try {
        for (const stale of doc.querySelectorAll?.("[data-sc-hover-cell]") || []) stale.removeAttribute("data-sc-hover-cell");
        for (const stale of doc.querySelectorAll?.(TREE + "[data-sc-hover-col]") || []) stale.removeAttribute("data-sc-hover-col");
      } catch (_) {}
    };
    const apply = target => {
      const cell = target?.closest?.(".cell");
      const row = cell?.closest?.(".row");
      const tree = row?.closest?.(TREE);
      if (!cell || !row || !tree) { clear(); return; }
      if (cell === lastCell) return;
      const key = keyOf(cell);
      if (!key) { clear(); return; }
      if (!known.has(key)) rules(visibleKeys());
      debug.applies++;
      if (lastCell) lastCell.removeAttribute("data-sc-hover-cell");
      lastCell = cell; cell.setAttribute("data-sc-hover-cell", "");
      rootNode = tree; tree.setAttribute("data-sc-hover-col", key);
      // How far the cell falls short of its row, top and bottom: the tint and the box fill that gap.
      try {
        const gap = Math.max(0, Math.round(((row.getBoundingClientRect?.().height || 0) - (cell.getBoundingClientRect?.().height || 0)) / 2));
        tree.style?.setProperty?.("--sc-hover-pad", gap + "px");
      } catch (_) {}
    };
    if (hover) {
      const over = event => {
        debug.overs++; if (event.isTrusted) debug.trustedOvers++;
        if (event.buttons) return;
        pending = event.target;
        if (raf) return;
        raf = -1;
        const id = frame(win, () => { raf = 0; try { apply(pending); } catch (error) { rt.Z.logError?.(error); } });
        if (raf === -1) raf = id;
      };
      // Leaving the tree: mouseout with nowhere to go or a target outside it, and mouseleave of the tree itself (or the window).
      const out = event => {
        debug.outs++;
        const to = event.relatedTarget;
        // No target: a tooltip or popup took the pointer, which may still be over the list. Look again
        // a moment later and keep the highlight while the list is still hovered.
        if (!to && rootNode && event.isTrusted) {
          const tree = rootNode;
          win.setTimeout?.(() => { try { if (!tree.matches?.(':hover')) { pending = null; clear(); } } catch (_) { pending = null; clear(); } }, 120);
          return;
        }
        if (!to || !(to.closest?.(TREE))) { pending = null; clear(); }
      };
      const leave = () => { pending = null; clear(); };
      listen(doc, "mouseover", over, true);
      listen(doc.documentElement, "mouseleave", leave, false);
      const treeNode = doc.querySelector?.(TREE);
      if (treeNode) listen(treeNode, "mouseleave", leave, false);
      /* In Zotero the document-level capture listener for mouseout never fired (the
         self-check counted 0), while the same registration for mouseover did; the
         window sees the capture phase first, before anything on the document can
         stop it, and the tree itself hears the bubble. */
      listen(win, "mouseout", out, true);
      if (treeNode) listen(treeNode, "mouseout", out, false);
      // A scroll moves rows under a still pointer; the mark would sit on a row that is no longer hovered.
      listen(doc, "scroll", leave, true);
      listen(win, "blur", leave, false);
    }

    // The column the right click landed on; Zotero opens its menu afterwards.
    let context = null;
    const onContext = event => {
      context = null;
      const cell = event.target?.closest?.(".cell");
      const row = cell?.closest?.(".row");
      if (!cell || !row || !row.closest?.(TREE)) return;
      const key = rt.columnKeyFor?.(win, cell);
      if (!key || key === "more") return;
      const index = Number(String(row.id || "").match(/-row-(\d+)$/)?.[1]);
      const item = win.ZoteroPane?.itemsView?.getRow(index)?.ref;
      if (!rt.isRegular(item)) return;
      context = {key, itemID: item.id, text: String(cell.textContent || "").trim(), at: Date.now()};
    };
    listen(doc, "contextmenu", onContext, true);

    const popup = doc.getElementById?.("zotero-itemmenu");
    const drop = () => { for (const node of [...(popup?.querySelectorAll?.(`[${MARK}]`) || [])]) node.remove(); };
    const build = (entry, parent) => {
      if (entry.separator) { const s = doc.createXULElement("menuseparator"); s.setAttribute(MARK, "1"); parent.appendChild(s); return; }
      const node = doc.createXULElement(entry.children ? "menu" : "menuitem");
      node.setAttribute(MARK, "1");
      node.setAttribute("label", entry.raw ? entry.label : rt.t(entry.label));
      if (entry.disabled) node.setAttribute("disabled", "true");
      if (entry.checked) { node.setAttribute("type", "checkbox"); node.setAttribute("checked", "true"); }
      if (entry.children) {
        const sub = doc.createXULElement("menupopup"); node.appendChild(sub);
        for (const child of entry.children) build(child, sub);
      } else if (entry.run) {
        node.addEventListener("command", () => Promise.resolve().then(entry.run).catch(error => { rt.Z.logError?.(error); rt.say(win, error?.message || String(error), {error: true}); }));
      }
      parent.appendChild(node);
    };
    if (popup) {
      listen(popup, "popupshowing", event => {
        if (event.target !== popup) return;
        drop();
        const asked = context; context = null;
        if (!asked || Date.now() - asked.at > 10000) return;
        const item = rt.Z.Items.get(asked.itemID);
        if (!rt.isRegular(item)) return;
        const entries = plan({rt, win, item, items: rt.rowSelection(doc, item), key: asked.key, text: asked.text});
        if (!entries.length) return;
        const first = popup.firstChild;
        const holder = {appendChild: node => popup.insertBefore(node, first)};
        for (const entry of entries) build(entry, holder);
        build({separator: true}, holder);
      }, false);
      listen(popup, "popuphidden", event => { if (event.target === popup) drop(); }, false);
    }

    return () => {
      unframe(win, raf); raf = 0; clear(); drop();
      for (const entry of mine) {
        try { entry[0].removeEventListener(entry[1], entry[2], entry[3] || false); } catch (_) {}
        const at = state.listeners?.indexOf(entry); if (at >= 0) state.listeners.splice(at, 1);
      }
      mine.length = 0;
      style?.remove(); style = null;
    };
  }

  return Object.freeze({attach, plan, hoverCSS, baseCSS, groupOf});
});
