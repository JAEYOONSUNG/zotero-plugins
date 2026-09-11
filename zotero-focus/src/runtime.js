/* global module */
"use strict";

var ZoteroFocusRuntime = class ZoteroFocusRuntime {
  constructor({ Zotero, model, marquee }) {
    this.Z = Zotero;
    this.model = model;
    this.marquee = marquee;
    this.windows = new Map();
    this.columns = [];
    this.observers = [];
    this.queue = Promise.resolve();
    this.active = false;
  }

  text(english, korean) { return String(this.Z.locale || "").startsWith("ko") ? korean : english; }

  pref(name, fallback) {
    try { return this.Z.Prefs.get("extensions.zotero-focus." + name, true) ?? fallback; }
    catch (_) { return fallback; }
  }

  async start({ id, version, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this.active = true;
    this.labels = {
      unread: this.text("Unread", "안 읽음"),
      reading: this.text("Reading", "읽는 중"),
      done: this.text("Read", "읽음")
    };
    const definitions = [
      ["focus-status", this.text("Focus · Status", "Focus · 읽기 상태"), "108", item => {
        const status = this.model.readState(item.getTags()).status;
        return ({ unread: "0", reading: "1", done: "2" })[status];
      }],
      ["focus-rating", this.text("Focus · Rating", "Focus · 별점"), "88", item => String(this.model.readState(item.getTags()).rating)],
      ["focus-tags", this.text("Focus · Tags", "Focus · 태그"), "180", item => this.model.visibleTags(item.getTags(), this.pref("tagPrefix", "")).join(" · ")]
    ];
    for (const [dataKey, label, width, read] of definitions) {
      const registered = this.Z.ItemTreeManager.registerColumn({
        pluginID: id, dataKey, label, width, minWidth: 50,
        enabledTreeIDs: ["main"],
        zoteroPersist: ["width", "hidden", "sortDirection", "ordinal"],
        dataProvider: item => {
          if (!this.isRegular(item)) return "";
          try { return read(item); }
          catch (error) { this.Z.logError(error); return ""; }
        },
        renderCell: (_index, data, column, _first, doc) => this.renderCell(dataKey, data, column, doc)
      });
      if (!registered) throw new Error("Zotero Focus: could not register " + dataKey);
      this.columns.push(registered);
    }
    this.prefPane = await this.Z.PreferencePanes.register({
      pluginID: id, src: rootURI + "content/preferences.xhtml", label: "Zotero Focus"
    });
    for (const name of ["marquee", "hoverDelay", "scrollSpeed", "tagPrefix"]) {
      const observer = this.Z.Prefs.registerObserver("extensions.zotero-focus." + name, () => {
        if (!this.active) return;
        if (name === "tagPrefix") this.Z.ItemTreeManager.refreshColumns();
        else for (const [win, state] of this.windows) this.attachMarquee(win, state);
      }, true);
      this.observers.push(observer);
    }
    this.Z.debug("Zotero Focus " + version + " ready");
  }

  isRegular(item) {
    return !!item?.isRegularItem?.() && !item.isFeedItem && !item.deleted;
  }

  canEdit(item) {
    if (!this.isRegular(item) || !item.isEditable()) return false;
    const library = this.Z.Libraries.get(item.libraryID);
    return !!library?.editable && library.libraryType !== "feed";
  }

  renderCell(key, data, column, doc) {
    const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cell.className = "cell " + (column.className || "");
    cell.style.overflow = "hidden";
    cell.style.textOverflow = "ellipsis";
    if (!data) return cell;
    let text = data;
    if (key === "focus-status") {
      const status = ["unread", "reading", "done"][Number(data)];
      text = ({ unread: "○ ", reading: "◐ ", done: "✓ " })[status] + this.labels[status];
    }
    else if (key === "focus-rating") text = this.model.formatRating(Number(data));
    cell.textContent = text;
    cell.title = text;
    return cell;
  }

  attachMarquee(win, state) {
    state.marqueeCleanup?.();
    state.marqueeCleanup = null;
    if (!this.pref("marquee", true)) return;
    const numeric = (name, fallback, min, max) => {
      const value = Number(this.pref(name, fallback));
      return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    state.marqueeCleanup = this.marquee.attach(win, {
      delay: numeric("hoverDelay", 200, 0, 2000),
      speed: numeric("scrollSpeed", 180, 30, 600)
    });
  }

  addWindow(win) {
    if (!this.active || this.windows.has(win)) return;
    const state = { nodes: [], listeners: [] };
    this.windows.set(win, state);
    try {
      this.attachMarquee(win, state);
      const doc = win.document;
      const popup = doc.getElementById("zotero-itemmenu");
      if (!popup) throw new Error("Zotero Focus: item context menu not found");
      const element = (name, label, parent) => {
        const node = doc.createXULElement(name);
        if (label) node.setAttribute("label", label);
        parent?.appendChild(node);
        return node;
      };
      const menu = element("menu", "Zotero Focus", popup);
      menu.id = "zotero-focus-itemmenu";
      state.nodes.push(menu);
      const body = element("menupopup", null, menu);
      state.actions = [];
      const action = (label, patch, parent) => {
        const node = element("menuitem", label, parent);
        node.addEventListener("command", () => {
          const items = this.selected(win);
          this.edit(items, patch).catch(error => {
            this.Z.logError(error);
            if (!win.closed) this.Z.alert(win, "Zotero Focus", this.text("Could not save the change. ", "변경을 저장하지 못했습니다. ") + error.message);
          });
        });
        state.actions.push(node);
      };
      for (const status of ["unread", "reading", "done"]) action(this.labels[status], { status }, body);
      element("menuseparator", null, body);
      const ratings = element("menupopup", null, element("menu", this.text("Rating", "별점"), body));
      for (let rating = 0; rating <= 5; rating++) {
        action(rating ? this.model.formatRating(rating) : this.text("Clear rating", "별점 지우기"), { rating }, ratings);
      }
      element("menuseparator", null, body);
      const hover = element("menuitem", this.text("Scroll long titles on hover", "긴 제목에 마우스를 올리면 스크롤"), body);
      hover.setAttribute("type", "checkbox");
      hover.setAttribute("autocheck", "false");
      hover.addEventListener("command", () => {
        this.Z.Prefs.set("extensions.zotero-focus.marquee", !this.pref("marquee", true), true);
      });
      const update = event => {
        if (event.target !== popup && event.target !== body) return;
        const items = this.selected(win);
        const disabled = !items.length || items.some(item => !this.canEdit(item));
        for (const node of state.actions) node.disabled = disabled;
        hover.setAttribute("checked", String(!!this.pref("marquee", true)));
      };
      popup.addEventListener("popupshowing", update);
      state.listeners.push([popup, "popupshowing", update]);
    }
    catch (error) {
      this.removeWindow(win);
      throw error;
    }
  }

  selected(win) {
    return (win.ZoteroPane?.getSelectedItems() || []).filter(item => this.isRegular(item));
  }

  edit(items, patch) {
    // Capture selection now; serialize commands so rapid status/rating clicks compose.
    const selection = [...new Set(items)];
    // Validate before queueing and do not let callers mutate a queued patch.
    try { this.model.updateTags([], patch); }
    catch (error) { return Promise.reject(error); }
    const change = { ...patch };
    const work = this.queue.then(async () => {
      if (!this.active) throw new Error(this.text("Plugin is disabled.", "플러그인이 비활성화되어 있습니다."));
      if (!selection.length) throw new Error(this.text("Select a reference first.", "먼저 문헌을 선택하세요."));
      if (selection.some(item => !this.canEdit(item))) throw new Error(this.text("This selection is not editable.", "선택한 문헌을 편집할 수 없습니다."));
      if (selection.some(item => item.hasChanged?.())) throw new Error(this.text("Wait for pending item changes to save, then try again.", "문헌의 다른 변경 사항이 저장된 뒤 다시 시도하세요."));
      const touched = [];
      try {
        await this.Z.DB.executeTransaction(async () => {
          for (const item of selection) {
            if (!this.canEdit(item)) throw new Error("Item is no longer editable");
            if (item.hasChanged?.()) throw new Error(this.text("Wait for pending item changes to save, then try again.", "문헌의 다른 변경 사항이 저장된 뒤 다시 시도하세요."));
            const tags = this.model.updateTags(item.getTags(), change);
            item.setTags(tags);
            // Capture Zotero's normalized representation, not our input order.
            touched.push({ item, written: item.getTags() });
            await item.save();
          }
        });
      }
      catch (error) {
        // The DB transaction rolls back persisted tags, but previous saves may
        // already have updated cached Items. Reload only after the rollback ends.
        for (const { item, written } of touched) {
          try {
            const latest = item.getTags();
            const oldByName = new Map(written.map(tag => [tag.tag, tag]));
            const newByName = new Map(latest.map(tag => [tag.tag, tag]));
            const removed = new Set(written.filter(tag => !newByName.has(tag.tag)).map(tag => tag.tag));
            const added = latest.filter(tag => !oldByName.has(tag.tag) || oldByName.get(tag.tag).type !== tag.type);
            // Zotero 9's tag loader refreshes _tags but leaves pending tag
            // changes intact after a save fails before _saveData. Clear only
            // that field before reloading the rolled-back database value.
            item._clearChanged("tags");
            await item.reload(["primaryData", "tags"], true);
            // A separate editor can change an earlier item while a later save
            // awaits. Reapply those tag differences as pending edits; do not
            // save them or lose them while undoing this failed transaction.
            if (removed.size || added.length) {
              const replaced = new Set(added.map(tag => tag.tag));
              item.setTags([...item.getTags().filter(tag => !removed.has(tag.tag) && !replaced.has(tag.tag)), ...added]);
            }
          }
          catch (reloadError) { this.Z.logError(reloadError); }
        }
        throw error;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  removeWindow(win) {
    const state = this.windows.get(win);
    if (!state) return;
    this.windows.delete(win);
    state.marqueeCleanup?.();
    for (const [target, event, handler] of state.listeners) target.removeEventListener(event, handler);
    for (const node of state.nodes) node.remove();
  }

  async stop() {
    this.active = false;
    await this.queue;
    for (const win of [...this.windows.keys()]) this.removeWindow(win);
    for (const observer of this.observers.splice(0)) {
      try { this.Z.Prefs.unregisterObserver(observer); }
      catch (error) { this.Z.logError(error); }
    }
    for (const key of this.columns.splice(0)) {
      try { this.Z.ItemTreeManager.unregisterColumn(key); }
      catch (error) { this.Z.logError(error); }
    }
    if (this.prefPane) {
      try { this.Z.PreferencePanes.unregister(this.prefPane); }
      catch (error) { this.Z.logError(error); }
      this.prefPane = null;
    }
  }
};

if (typeof module !== "undefined") module.exports = ZoteroFocusRuntime;
