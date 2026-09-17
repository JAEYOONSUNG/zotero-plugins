/* global module */
"use strict";
var CustomStyleRuntime = class CustomStyleRuntime {
  constructor({ Zotero, model, marquee, reading, storage, legacy = {}, catalog = [], citations }) {
    Object.assign(this, { Z: Zotero, model, marquee, reading, storage, legacy });
    this.windows = new Map(); this.columns = []; this.observers = [];
    this.queue = Promise.resolve(); this.writeQueue = Promise.resolve();
    this.cache = { schema: 1, items: {} }; this.active = false; this.dirty = false;
    this.journalTools = typeof CustomStyleJournals !== "undefined" ? CustomStyleJournals : require("./journals.js");
    this.catalog = catalog;
    this.journals = this.journalTools.create(catalog);
    this.citationTools = citations || (typeof CustomStyleCitations !== "undefined" ? CustomStyleCitations : require("./citations.js"));
    this.citationFormats = typeof CustomStyleCitationFormats !== "undefined" ? CustomStyleCitationFormats : require("./citation-formats.js");
    this.supplementaryTools = typeof CustomStyleSupplementary !== "undefined" ? CustomStyleSupplementary : require("./supplementary.js");
    this.SUPPLEMENTARY_TAG = 'style-custom:supplementary';
    this.discoverTools = typeof CustomStyleDiscover !== "undefined" ? CustomStyleDiscover : require("./discover.js");
    this.signalTools = typeof CustomStylePaperSignals !== "undefined" ? CustomStylePaperSignals : require("./paper-signals.js");
    this.legacyReading = typeof CustomStyleLegacyReading !== "undefined" ? CustomStyleLegacyReading : require("./legacy-reading.js");
    this.journalTools2 = typeof CustomStyleJournalMetrics !== "undefined" ? CustomStyleJournalMetrics : require("./journal-metrics.js");
    // Held in memory only: a lookup is cheap to repeat and must not go stale on disk.
    this.discoverCache = new Map();
    this.DISCOVER_CACHE_LIMIT = 60;
    this.citationJob = null;
    this.citationProgress = null;
    this.metadataIDs = new Set();
    this.metadataQueue = Promise.resolve();
    this.activityQueue=Promise.resolve();this.tabItems=new Map();
    this.settingsTools=typeof CustomStyleSettingsSchema!=='undefined'?CustomStyleSettingsSchema:require('./settings-schema.js');this.settingsSchema=this.settingsTools.schema;
    this.workspaceTools=typeof CustomStyleWorkspace!=="undefined"?CustomStyleWorkspace:require("./workspace.js");
    this.Workbench=typeof CustomStyleWorkbench!=="undefined"?CustomStyleWorkbench:require("./workbench.js");
    const Library=typeof CustomStyleLibrary!=="undefined"?CustomStyleLibrary:require("./library.js");
    this.Library=Library;
    const Reader=typeof CustomStyleReaderTools!=="undefined"?CustomStyleReaderTools:require("./reader-tools.js");
    const Assist=typeof CustomStyleAssist!=="undefined"?CustomStyleAssist:require("./assist.js");
    this.libraryService=Library.create({Zotero:this.Z,runtime:this});
    this.readerTools=Reader.create({Zotero:this.Z,runtime:this});
    this.assist=Assist.create({Zotero:this.Z,runtime:this});
  }
  text(english, korean) { return String(this.Z.locale || "").startsWith("ko") ? korean : english; }
  pref(name, fallback) { return this.Z.Prefs.get("extensions.style-custom." + name, true) ?? fallback; }
  isRegular(item) { return !!item?.isRegularItem?.() && !item.isFeedItem && !item.deleted; }
  canEdit(item) {
    if(!this.isRegular(item))return false;
    const library = this.Z.Libraries.get(item.libraryID);
    return this.isRegular(item) && item.isEditable() && !!library?.editable && library.libraryType !== "feed";
  }
  identity(item) { return `${item.libraryID}:${item.key}`; }
  entry(item) { return this.cache.items[this.identity(item)] ||= {}; }
  featureEnabled(id) { return this.pref('feature.'+id,true)!==false; }
  getSetting(key) {
    const definition=this.settingsSchema.settings.find(row=>row.key===key);if(!definition)throw new Error('Unknown setting: '+key);
    let value=this.pref(key,undefined);
    if(value===undefined){
      const reader=this.cache.readerSettings||{},margin=reader.marginOptions||{};
      const legacy={workbenchDensity:this.cache.workbenchUI?.density,readerTheme:typeof reader.theme==='object'?'custom':reader.theme,readerCustomBackground:reader.theme?.background,readerCustomForeground:reader.theme?.foreground,marginEnabled:reader.marginAnnotations,marginWidth:margin.width,marginSide:margin.side,marginFontSize:margin.fontSize,marginTextLimit:margin.textLimit,readerSidebar:reader.sidebarVisible,verticalTabs:reader.verticalTabs};
      value=legacy[key]??definition.default;
    }
    if(definition.type==='action')return null;
    try{return this.settingsTools.validate(key,value);}catch(_){return definition.default;}
  }
  async setSetting(key,value,{apply=true}={}) {
    this.settingsTools.validate(key,value);
    this.settingWriteDepth=(this.settingWriteDepth||0)+1;
    try{if(key==='customFields')this.setCustomFields(value);else if(key==='panelCSS')this.setPanelCSS(value);else this.Z.Prefs.set('extensions.style-custom.'+key,value,true);}finally{this.settingWriteDepth--; }
    if(key==='workbenchDensity'){this.cache.workbenchUI={...(this.cache.workbenchUI||{}),density:value};this.dirty=true;}
    if(apply)await this.applySettings([key]);return this.getSetting(key);
  }
  async resetSettings(category) {
    if(!this.settingsSchema.categories.some(row=>row.id===category))throw new Error('Unknown category');
    const rows=this.settingsSchema.settings.filter(row=>row.category===category&&row.type!=='action'&&!row.secret);
    for(const row of rows)await this.setSetting(row.key,row.default,{apply:false});
    await this.applySettings(rows.map(row=>row.key));return {reset:rows.length,secretsPreserved:true};
  }
  async applySettings(keys=[]) {
    if(!this.active||this.stopping)return;
    this.syncFeatureColumns();
    if(keys.includes('feature.styleEditor'))this.setPanelCSS(this.pref('panelCSS',''));
    if(!this.featureEnabled('citedCountColumn'))this.citationJob?.controller.abort();
    for(const [win,state]of this.windows){
      if(win.closed)continue;
      if(keys.some(key=>['recordReading','recordIntervalMs','idleSeconds'].includes(key)))this.attachMotion(win,state,{marquee:false,reading:true});
      if(keys.some(key=>['marquee','hoverDelay','scrollSpeed'].includes(key)))this.attachMotion(win,state,{marquee:true,reading:false});
      if(keys.some(key=>key.startsWith('reader')||key.startsWith('margin')||key.startsWith('feature.')||key==='verticalTabs'))await this.readerTools.applyPreferences?.(win);
      state.signature=null;await state.workbench?.applyPreferences?.();
    }
    await this.flush();await this.refreshWindows();
  }
  async runSettingAction(action) {
    const win=this.Z.getMainWindow?.();if(!win)throw new Error('Zotero 문헌 창을 열어 주세요.');
    const selected=this.selected(win);
    if(action==='workbench')return this.openWorkbench(win);
    if(action==='columns')return this.useColumns(win);
    if(action==='cancelCitations'){this.citationJob?.controller.abort();return;}
    if(!selected.length)throw new Error('문헌 목록에서 대상 문헌을 선택하세요.');
    if(action==='citations')return this.refreshCitations(selected,{force:true});
    if(action==='journals')return this.refreshJournalMetrics(selected,win.DOMParser);
    if(action==='ranks')return this.refreshPublicationRanks(selected);
    throw new Error('Unknown action');
  }
  getSettingsStatus() {
    const win=this.Z.getMainWindow?.(),selected=win?this.selected(win):[];const reader=win?.Zotero_Tabs&&this.Z.Reader?.getByTabID?.(win.Zotero_Tabs.selectedID),attachment=reader&&this.Z.Items.get(reader.itemID),item=(attachment?.parentID&&this.Z.Items.get(attachment.parentID))||selected[0];
    return {version:this.version||'',recordReading:this.getSetting('recordReading'),selectedTitle:item?String(item.getField('title')||''):'선택한 문헌 없음',readSeconds:item?this.state(item).seconds:0,citationStatus:this.citationJob?'조회 중':'대기',storagePath:this.Z.DataDirectory?.dir?this.Z.DataDirectory.dir+'/style-custom.json':'Zotero 데이터 폴더/style-custom.json'};
  }
  columnFeature(key) {
    return {if:'IFColumn',citations:'citedCountColumn',status:'statusColumn',rating:'ratingColumn',time:'readTimeColumn',tags:'tagsColumn',progress:'readTimeColumn',remark:'remarkColumn',publication:'publicationTagsColumn',authors:'creatorColumn',added:'dateAddedColumn',modified:'dateAddedColumn',lastRead:'Recent',tagCount:'textTagsColumn',summary:'tldr',annotationCount:'annotationColumn',noteCount:'renderItemNotes',venue:'publicationColumn'}[key];
  }
  syncFeatureColumns() {
    this.featureColumns||=new Map();
    for(const [dataKey,label,width]of this.columnDefinitions||[]){
      const feature=this.columnFeature(dataKey),existing=this.featureColumns.get(dataKey);
      if(feature&&!this.featureEnabled(feature)){
        if(existing){this.Z.ItemTreeManager.unregisterColumn(existing);this.columns=this.columns.filter(key=>key!==existing);this.featureColumns.delete(dataKey);}continue;
      }
      if(existing)continue;
      const key=this.Z.ItemTreeManager.registerColumn({pluginID:this.id,dataKey,label,width,minWidth:50,enabledTreeIDs:['main'],hidden:!['if','citations','status','rating','time','tags','files'].includes(dataKey),zoteroPersist:['width','hidden','sortDirection','ordinal'],dataProvider:item=>this.isRegular(item)?this.value(dataKey,item):'',renderCell:(index,value,column,first,doc)=>this.renderCell(dataKey,index,value,column,doc)});
      if(!key)throw new Error('Could not register Custom column: '+dataKey);this.columns.push(key);this.featureColumns.set(dataKey,key);
    }
  }
  formatReadTime(seconds) {
    const value=Math.max(0,Math.floor(Number(seconds)||0));if(!value&&!this.getSetting('showZeroReadTime'))return '';
    if(this.getSetting('timeFormat')==='seconds')return value+'초';
    const h=Math.floor(value/3600),m=Math.floor(value%3600/60),s=value%60;
    if(this.getSetting('timeFormat')==='clock')return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');
    return h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;
  }
  refreshReadingDisplays() {
    for(const [win,state]of this.windows){if(win.closed)continue;
      for(const cell of win.document.querySelectorAll?.('[data-style-custom-reading]')||[]){const item=this.Z.Items?.get(Number(cell.dataset.itemId));if(!this.isRegular(item))continue;const value=this.state(item);const P=this.palette(win.document);
        if(cell.dataset.styleCustomReading==='time'){cell.textContent=this.formatReadTime(value.seconds);cell.style.color=value.seconds<=0?P.faint:value.seconds>=3600?P.blue:P.text;cell.style.fontWeight=value.seconds>=3600?'590':'';}
        else if(cell.firstChild&&cell.lastChild){const tone={unread:P.muted,reading:P.orange,done:P.green}[value.status];cell.firstChild.textContent={unread:'\u25cb',reading:'\u25d0',done:'\u25cf'}[value.status];cell.firstChild.style.color=tone;cell.lastChild.textContent=value.status;cell.lastChild.style.color=value.status==='unread'?P.muted:tone;cell.lastChild.style.fontWeight=value.status==='unread'?'400':'590';}}
      state.workbench?.refreshMetrics?.();
    }
  }
  async start({ id, version, rootURI }) {
    this.id = id; this.version=version; this.rootURI = rootURI;
    const loaded = await this.storage.read();
    if (!loaded || loaded.schema !== 1 || !loaded.items || typeof loaded.items !== "object" || Array.isArray(loaded.items)) {
      throw new Error("Style Custom cache has an unsupported format; existing file was preserved");
    }
    this.cache = loaded; this.active = true;
    for (const entry of Object.values(loaded.items)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Style Custom item cache");
      if (entry.citationPending) { delete entry.citationPending; this.dirty=true; }
    }
    this.rebuildJournals();
    this.labels = { unread: "unread", reading: "reading", done: "done" };
    this.columnDefinitions = [["if", "IF", "90"], ["citations", "Cited Count", "120"],
      ["status", "Status", "100"], ["rating", "Rating", "100"],
      ["time", "Read Time", "120"], ["tags", "Tags", "140"],
      ["files", "Files", "110"],
      ["progress","Pages","100"],["remark","Remark","180"],
      ["publication","Journal Tags","160"],["authors","Creators","160"],
      ["added","Added","130"],["modified","Modified","130"],
      ["lastRead","Last Read","130"],["tagCount","#Tags","70"],
      ["translatedTitle","Translated Title","220"],["summary","Summary","220"],
      ["annotationCount","Annotations","90"],["noteCount","Notes","70"],["venue","Publication","170"],
      ["signals","Signals","160"]];
    this.syncFeatureColumns();
    try{this.setCustomFields(this.pref('customFields',''),{persist:false});}catch(error){this.Z.logError(error);}
    this.prefPane = await this.Z.PreferencePanes.register({ pluginID: id, src: rootURI + "content/preferences.xhtml", label: "Style Custom",image:rootURI+"content/icons/style-custom.svg",scripts:[rootURI+"src/settings.js"],stylesheets:[rootURI+"content/preferences.css"] });
    for (const name of ["marquee", "hoverDelay", "scrollSpeed", "recordReading", "autoStatus", "autoCitations", "metadataCitations"]) {
      this.observers.push(this.Z.Prefs.registerObserver("extensions.style-custom." + name, () => {
        if (!this.active||this.settingWriteDepth) return;
        if (name === "autoCitations" || name === "metadataCitations") {
          if (!this.pref(name,true) && this.citationJob?.background) this.citationJob.controller.abort();
        } else for (const [win, state] of this.windows) { if(name!=="autoStatus")this.attachMotion(win,state,{marquee:name!=="recordReading",reading:name==="recordReading"});state.signature=null; }
      }, true));
    }
    if (this.Z.Notifier) this.itemObserver = this.Z.Notifier.registerObserver({notify:(event,type,ids,extraData)=>{
      if(type === "item" && (event === "add" || event === "modify")) this.scheduleMetadataCitations((ids||[]).filter(id=>!extraData?.[id]?.styleCustomCitations));
      if(type==='tab') {
        const itemIDs=(ids||[]).map(id=>extraData?.[id]?.itemID||this.Z.Reader?.getByTabID?.(id)?.itemID||this.tabItems.get(id)).filter(Boolean);
        if(['add','select','close'].includes(event)&&this.pref('touchDateOnRead',false))for(const id of new Set(itemIDs))this.activityQueue=this.activityQueue.then(()=>this.touchReadingItem(id)).catch(error=>this.Z.logError(error));
        for(const [win]of this.windows)for(const tab of this.readerTools.tabs(win))if(tab.itemID)this.tabItems.set(tab.id,tab.itemID);
        if(event==='close')for(const id of ids||[])this.tabItems.delete(id);
      }
    }},["item","tab"],"style-custom-citations");
    this.Z.debug("Style Custom " + version + " ready");
  }
  metrics(item) {
    const old = this.entry(item);
    const liveAPI = this.Z.ZoteroStyle?.api;
    const userLibrary = item.libraryID === this.Z.Libraries.userLibraryID;
    const legacy = this.legacy && typeof this.legacy === "object" ? this.legacy : {};
    const live = this.model.readMetrics(item, {
      storage: { get: (reference, key) => liveAPI?.storage?.get(reference, key) ?? (userLibrary ? legacy[reference.key]?.[key] : undefined) },
      rankStorage: { get: (reference, key) => this.cache.journalRanks?.[this.journalTools.name(reference.key)]?.rank || legacy[reference.key]?.[key] }
    });
    const providerRank=this.cache.journalRanks?.[this.journalTools.name(item.getField('publicationTitle'))];
    if(providerRank&&live.impactSource==='Style journal cache: sciif')live.impactSource='easyScholar · '+providerRank.checkedAt+' · JIF year unspecified';
    const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const cached = old.metrics || {};
    const merged = { ...cached };
    const citationKey = this.citationTools.identity(this.citationRecord(item));
    if (old.citationExtra && old.citationExtra.identity!==citationKey && /^Extra: citations(?: |$)/.test(live.citationSource||"")
        && String(item.getField("extra")||"").split(/\r?\n/).includes(old.citationExtra.line)) {
      live.citations=null;live.citationSource=null;
    }
    if (!old.legacyCitationIdentity) { old.legacyCitationIdentity=cached.citationKey||citationKey; this.dirty=true; }
    // Adding a previously absent author is enrichment, not a conflicting paper
    // identity. Keep opaque legacy counts while the stricter title lookup runs.
    try {
      const previous=JSON.parse(old.legacyCitationIdentity), current=JSON.parse(citationKey);
      if(previous.length===6 && !previous[0] && !previous[5] && current[5] && previous.slice(0,5).every((v,i)=>v===current[i])) {
        old.legacyCitationIdentity=citationKey;this.dirty=true;
      }
    } catch(_) {}
    const changedCitation = cached.citationKey && cached.citationKey !== citationKey;
    if (changedCitation) { merged.citations=null; merged.citationSource=null; merged.citationCheckedAt=null; }
    const legacyCitation = userLibrary && old.legacyCitationIdentity===citationKey ? this.model.readLegacyCitations(legacy[item.key]?.citedCount) : {citations:null};
    if (live.citations === null && legacyCitation.citations !== null) Object.assign(live, legacyCitation);
    const impactKey = this.journalTools.name(item.getField("publicationTitle")) + "|" + String(item.getField("ISSN") || "");
    if (cached.impactKey !== impactKey) { merged.impactFactor = null; merged.impactSource = null; merged.impactYear = null; }
    for (const [field, source] of [["citations", "citationSource"], ["impactFactor", "impactSource"]]) {
      if (number(live[field])) { merged[field] = live[field]; merged[source] = live[source]; }
      else if (!number(merged[field])) { merged[field] = null; merged[source] = null; }
    }
    if(providerRank&&live.impactSource?.startsWith('easyScholar'))merged.impactYear=null;
    const journal = this.journals.lookup(item);
    if (journal) {
      merged.impactFactor = journal.impactFactor;
      merged.impactYear = journal.year;
      merged.impactSource = `${journal.title} · JIF ${journal.year ?? "연도 미표기"} · ${journal.sourceURL} · checked ${journal.checkedAt}`;
    }
    merged.impactKey = impactKey;
    const lookup=old.citationLookup;
    if (lookup?.status === "ok" && lookup.identity === citationKey && Number.isSafeInteger(lookup.count) && lookup.count >= 0) {
      merged.citations=lookup.count;
      merged.citationSource=lookup.source;
      merged.citationCheckedAt=lookup.checkedAt;
    }
    merged.citationKey=citationKey;
    const own = number(old.seconds) ? old.seconds : 0;
    const prior = number(cached.seconds) ? cached.seconds : 0;
    merged.seconds = Math.max(own, prior, number(live.seconds) ? live.seconds : 0);
    if (JSON.stringify(cached) !== JSON.stringify(merged)) { old.metrics = merged; this.dirty = true; }
    return merged;
  }
  state(item) {
    const metrics = this.metrics(item);
    const state = this.model.readState(item.getTags(), item.getField("extra"), this.pref("autoStatus", true)&&this.featureEnabled("readStatus") ? metrics.seconds : 0);
    if (this.entry(item).unreadOverride && state.status !== "done") state.status = "unread";
    return { ...metrics, ...state,lastRead:this.entry(item).lastRead||'',dateAdded:String(item.getField('dateAdded')||''),dateModified:String(item.getField('dateModified')||'') };
  }
  value(key, item) {
    try {
      const state = this.state(item);
      if (key === "if") return state.impactFactor == null ? "" : String(state.impactFactor);
      if (key === "citations") return state.citations == null ? "" : String(state.citations);
      if (key === "status") return String({unread:0,reading:1,done:2}[state.status]);
      if (key === "rating") return String(state.rating);
      if (key === "time") return String(state.seconds);
      if (key === "progress") {const p=this.pageProgress(item);return p.percent===null?"":String(p.percent);}
      if (["remark","translatedTitle","summary"].includes(key)) return String(this.entry(item)[key]||"");
      if (key === "publication") return this.publicationTags(item).join(' · ');
      if (key === "venue") return ['publicationTitle','proceedingsTitle','university','publisher'].map(field=>item.getField(field)).find(Boolean)||'';
      if (key === "authors") return (item.getCreators?.()||[]).map(c=>[c.firstName,c.lastName||c.name].filter(Boolean).join(' ')).join('; ');
      if (key === "added"||key === "modified")return String(item.getField(key==='added'?'dateAdded':'dateModified')||'');
      if (key === "lastRead")return String(this.entry(item).lastRead||'').replace('T',' ').slice(0,16);
      if (key === "tagCount")return String(item.getTags().filter(t=>!/^style-custom:/.test(t.tag)).length);
      if (key === "noteCount")return String(item.getNotes?.().length||0);
      // An ordinal key, not a label: the column has to sort the worst news to
      // the top. Empty until the paper has been looked up, so an unchecked
      // paper is never mistaken for a clean one.
      if (key === "signals")return this.signalTools.sortKey(this.signalsOf(item));
      if (key === "files") {const kinds=this.attachmentKinds(item);if(!kinds.length)return "";
        const si=kinds.filter(k=>k.supplementary).length;
        return [kinds.length-si?`PDF×${kinds.length-si}`:"",si?`SI×${si}`:""].filter(Boolean).join(" · ");}
      if (key === "annotationCount")return String((item.getAttachments?.()||[]).reduce((n,id)=>n+(this.Z.Items.get(id)?.deleted?0:(this.Z.Items.get(id)?.getAnnotations?.()||[]).filter(annotation=>!annotation.deleted).length),0));
      if (key.startsWith('field-'))return String(item.getField(key.slice(6))||'');
      return item.getTags().map(t => t.tag).filter(t => !/^\/(unread|reading|done)$/.test(t) && !/^style-custom:/.test(t) && !/^[★⭐]+$/.test(t)).join(" · ");
    } catch (error) { this.Z.logError(error); return ""; }
  }
  // Publishers name supplementary files in a handful of recognisable ways:
  // an explicit word, an "SI"/"supp" token, or a house code (Elsevier mmc1,
  // NPG media-1). Matching the stem avoids treating "PDF" alone as evidence.
  isSupplementary(attachment) {
    // A tag survives a file mover renaming the attachment; a filename does not.
    try {
      if ((attachment?.getTags?.() || []).some(t => t.tag === this.SUPPLEMENTARY_TAG)) return true;
    } catch (ignored) { }
    // One shared definition with the downloader, so a file the badge counts is
    // a file the downloader keeps.
    const stems = [attachment?.attachmentFilename, attachment?.getField?.('title'), attachment?.getDisplayTitle?.()];
    return stems.filter(Boolean).some(text => this.supplementaryTools.looksSupplementary(String(text)));
  }
  attachmentKinds(item) {
    const kinds = [];
    for (const id of item.getAttachments?.() || []) {
      const attachment = this.Z.Items.get(id);
      if (!attachment || attachment.deleted || !attachment.isFileAttachment?.()) continue;
      const name = String(attachment.attachmentFilename || attachment.getDisplayTitle?.() || '');
      const pdf = /\.pdf$/i.test(name) || attachment.attachmentContentType === 'application/pdf';
      kinds.push({id, supplementary: this.isSupplementary(attachment), pdf, name});
    }
    return kinds;
  }
  annotationDistribution(item) {
    const pages=new Map();
    for(const id of item.getAttachments?.()||[]) {
      const attachment=this.Z.Items.get(id);if(!attachment||attachment.deleted)continue;
      for(const annotation of attachment.getAnnotations?.()||[]) {
        if(annotation.deleted)continue;
        let position;try{position=JSON.parse(annotation.annotationPosition);}catch(_){continue;}
        if(!Number.isSafeInteger(position.pageIndex)||position.pageIndex<0)continue;
        const indexes=[position.pageIndex];if(Array.isArray(position.nextPageRects)&&position.nextPageRects.length&&Number.isSafeInteger(position.pageIndex+1))indexes.push(position.pageIndex+1);
        for(const index of indexes){
          const key=id+':'+index;
          if(!pages.has(key))pages.set(key,{attachmentID:id,pageIndex:index,count:0,colors:new Map()});
          const page=pages.get(key),color=/^#[a-f\d]{6}$/i.test(annotation.annotationColor)?annotation.annotationColor.toLowerCase():'#888888';
          page.count++;page.colors.set(color,(page.colors.get(color)||0)+1);
        }
      }
    }
    return [...pages.values()].sort((a,b)=>a.attachmentID-b.attachmentID||a.pageIndex-b.pageIndex).map(page=>({...page,colors:[...page.colors]}));
  }
  // Apple-like system palette. Restraint over rainbow: numbers stay monochrome,
  // colour marks only the categorical dimensions (status, rating, IF tier).
  palette(doc) {
    const dark = !!doc?.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
    return dark
      ? {blue:'#5B9DFF',green:'#3FCF8E',orange:'#FFA94D',red:'#FF7A70',purple:'#B48BF0',teal:'#3FC4D8',gold:'#FFC95C',gray:'#98989D',faint:'#4A4A50',muted:'#A0A0A6',text:'#E8E8ED',tint:0.20,dark:true}
      : {blue:'#2F6FE0',green:'#1F9D62',orange:'#E0821E',red:'#DB4F4F',purple:'#8A5CD1',teal:'#128FA8',gold:'#E9A81C',gray:'#8E8E93',faint:'#D3D7DC',muted:'#6E6E73',text:'#1C1C1E',tint:0.13,dark:false};
  }
  tint(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
  }
  // Impact-factor bands. Chosen so the common 2-10 range stays calm and only a
  // genuinely exceptional journal earns the strongest colour.
  impactTier(value, p) {
    if (!(value > 0)) return null;
    if (value >= 30) return {color: p.purple, name: '최상위'};
    if (value >= 10) return {color: p.blue, name: '상위'};
    if (value >= 5) return {color: p.teal, name: '중상위'};
    if (value >= 2) return {color: p.green, name: '중위'};
    return {color: p.gray, name: '일반'};
  }
  pill(doc, text, color, p) {
    const el = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    el.textContent = text;
    el.style.cssText = `display:inline-flex;align-items:center;border-radius:100px;padding:1px 7px;`
      + `font-size:11px;font-weight:590;line-height:15px;letter-spacing:-0.01em;white-space:nowrap;`
      + `background:${this.tint(color, p.tint)};color:${color};`;
    return el;
  }
  // Log scale: citation counts span several orders of magnitude, so a linear bar
  // would leave almost every row empty.
  citationShare(count) {
    if (!(count > 0)) return 0;
    return Math.min(1, Math.log10(count + 1) / Math.log10(1001));
  }
  renderCell(key, index, value, column, doc) {
    const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cell.className = "cell " + (column.className || "");
    Object.assign(cell.style, { overflow: "hidden", textOverflow: "ellipsis", alignItems: "center", display: "flex", gap: "5px" });
    const P = this.palette(doc);
    if (["if","citations","time"].includes(key)) cell.style.fontVariantNumeric = "tabular-nums";
    const item = doc.defaultView?.ZoteroPane?.itemsView?.getRow(index)?.ref;
    // Read current data when painting: do not reuse a previously cached empty cell.
    if (this.isRegular(item)) {value=this.value(key,item);if(['time','status'].includes(key)){cell.dataset.styleCustomReading=key;cell.dataset.itemId=String(item.id);}}
    if (value === "") {
      if (key === "if" && this.isRegular(item)) {
        // The catalogue covers 86 journals; this library spans 255. Rather than
        // a blank, show OpenAlex's two-year mean citedness -- a different figure
        // from a Clarivate JIF, so it is marked and never presented as one.
        const estimate = this.journalCitedness(item);
        if (estimate) {
          const tier = this.impactTier(estimate.citedness, P);
          cell.textContent = "~" + estimate.citedness;
          cell.style.color = tier ? tier.color : P.muted;
          cell.style.fontWeight = "400";
          cell.title = `≈ ${estimate.citedness} · OpenAlex 2년 평균 피인용 · ${estimate.name || ""}`
            + `\n공식 JIF가 아니라 추정치입니다.`;
          return cell;
        }
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = item.getField("publicationTitle") ? "이 저널의 공식 IF를 아직 확인하지 못했습니다. 저널명과 ISSN을 확인하세요." : "저널 정보가 없습니다. 프리프린트·책·데이터셋에는 저널 IF가 적용되지 않을 수 있습니다.";
      }
      if (key === "citations" && this.isRegular(item)) {
        const state=this.entry(item), id=this.citationTools.identity(this.citationRecord(item));
        cell.textContent=state.citationPending===id?"…":"—";
        cell.style.color=P.faint;
        const attempt=state.citationAttempt?.identity===id?state.citationAttempt:null;
        cell.title=state.citationPending===id?"인용 수 조회 중":attempt?({"not-found":"일치하는 논문의 인용 수를 찾지 못했습니다.",error:"조회 실패: 기존 값은 유지됩니다.",unsupported:"확인 가능한 논문 식별자가 부족합니다."}[attempt.status]||"")+(attempt.reason?" "+attempt.reason:""):"아직 조회하지 않은 인용 수입니다. 0회 인용과 구분합니다.";
      }
      // "Not checked" and "nothing wrong" are different answers, and only one
      // of them is safe to read as reassurance.
      if (key === "signals" && this.isRegular(item)) {
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = this.signalTools.bareDOI(this.citationRecord(item).doi)
          ? "철회·공개접근 신호를 아직 조회하지 않았습니다. 문헌 목록 오른쪽 클릭 메뉴에서 조회하세요."
          : "DOI가 없어 철회 여부를 확인할 수 없습니다.";
      }
      return cell;
    }
    let label = value;
    if (key === "status") {
      label = ["unread", "reading", "done"][Number(value)] || "unread";
      // An empty, half and full circle reads as progress; one dot does not.
      const tone = {unread: P.muted, reading: P.orange, done: P.green}[label];
      const dot = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      dot.textContent = {unread: "○", reading: "◐", done: "●"}[label];
      dot.style.cssText = `font-size:10px;line-height:1;color:${tone};`;
      const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      text.textContent = label;
      text.style.cssText = `color:${label === "unread" ? P.muted : tone};font-weight:${label === "unread" ? 400 : 590};`;
      cell.append(dot, text);
    } else if (key === "rating") {
      const rating = Number(value);
      label = "★".repeat(rating) + "☆".repeat(5-rating);
      for (let n=1;n<=5;n++) {
        const star = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        star.textContent = n<=rating ? "★" : "☆"; star.title = `${n}/5`;
        star.style.cssText = `cursor:pointer;font-size:13px;line-height:1;color:${n<=rating?P.gold:P.faint};`;
        star.addEventListener("click", event => { event.stopPropagation(); if (this.canEdit(item)) this.edit([item], {rating:n===rating?0:n}).catch(e=>this.Z.logError(e)); });
        cell.appendChild(star);
      }
    } else if (key === "tags" && this.isRegular(item)) {
      for(const tag of this.displayTags(item)) {
        const chip=this.pill(doc,tag.tag,tag.color||P.muted,P);chip.title=tag.tag;chip.style.fontWeight='400';
        cell.appendChild(chip);
      }
    } else if(key === 'annotationCount' && this.isRegular(item)) {
      const count=doc.createElementNS('http://www.w3.org/1999/xhtml','span');count.textContent=value;cell.appendChild(count);
      const pages=this.annotationDistribution(item),strip=doc.createElementNS('http://www.w3.org/1999/xhtml','span');
      strip.setAttribute('aria-label','주석 위치 분포');strip.style.cssText='display:flex;gap:2px;overflow:hidden;flex:1;align-items:center;';
      for(const page of pages.slice(0,120)){
        const marker=doc.createElementNS('http://www.w3.org/1999/xhtml','button');marker.type='button';marker.title=`첨부 ${page.attachmentID} · ${page.pageIndex+1}페이지 · 주석 ${page.count}개`;
        marker.setAttribute('aria-label',marker.title);marker.style.cssText='border:0;padding:0;min-width:4px;flex:1;height:12px;cursor:pointer;';
        let start=0;const stops=[];for(const[color,count]of page.colors){const end=start+count/page.count*100;stops.push(`${color} ${start}% ${end}%`);start=end;}
        marker.style.background=stops.length===1?page.colors[0][0]:`linear-gradient(0deg,${stops.join(',')})`;
        marker.addEventListener('click',event=>{event.stopPropagation();this.libraryService.openItem(page.attachmentID,{pageIndex:page.pageIndex}).catch(error=>this.Z.logError(error));});strip.appendChild(marker);
      }
      cell.appendChild(strip);cell.title=`주석 ${value}개 · ${pages.length}개 페이지에 분포${pages.length>120?' · 앞 120개 위치 표시':''}. 색 막대를 클릭하면 해당 PDF 페이지로 이동합니다.`;
    } else if(['added','modified'].includes(key)&&this.getSetting('dateDisplay')==='relative') {
      const timestamp=Date.parse(value),age=Math.max(0,Date.now()-timestamp),minutes=Math.floor(age/60000),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
      cell.textContent=Number.isFinite(timestamp)?days?days+'일 전':hours?hours+'시간 전':minutes?minutes+'분 전':'방금':value;
    } else if (key === "time") {
      const seconds = Number(value);
      label = this.formatReadTime(seconds);
      cell.textContent = label;
      // Untouched papers recede; the longer the session, the more present the number.
      cell.style.color = seconds <= 0 ? P.faint : P.text;
      if (seconds >= 3600) cell.style.fontWeight = "590";
      cell.title = `${Math.floor(seconds)} seconds of active reading`;
    } else if (key === "progress") {
      const p=this.isRegular(item)?this.pageProgress(item):{percent:Number(value)};
      cell.textContent=p.percent+'%';cell.style.backgroundImage=`linear-gradient(90deg,#245c7830 ${p.percent}%,transparent ${p.percent}%)`;
      cell.title=p.total?`${p.visited}/${p.total} pages read`:cell.textContent;
    } else if (key === "files" && this.isRegular(item)) {
      const kinds = this.attachmentKinds(item);
      const main = kinds.filter(k => !k.supplementary), si = kinds.filter(k => k.supplementary);
      if (main.length) {
        const plain = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        plain.textContent = main.length > 1 ? `PDF ×${main.length}` : "PDF";
        plain.style.cssText = `font-size:11px;color:${P.muted};`;
        plain.title = main.map(k => k.name).join("\n");
        cell.appendChild(plain);
      }
      if (si.length) {
        const pill = this.pill(doc, si.length > 1 ? `SI ×${si.length}` : "SI", P.purple, P);
        pill.title = "보충자료(supplementary) — 클릭하면 열립니다\n" + si.map(k => k.name).join("\n");
        pill.style.cursor = "pointer";
        pill.addEventListener("click", event => {
          event.stopPropagation();
          this.libraryService.openItem(si[0].id).catch(error => this.Z.logError(error));
        });
        cell.appendChild(pill);
      }
      cell.title = si.length ? `보충자료 ${si.length}개 포함` : main.length ? "보충자료 없음" : "첨부파일 없음";
      return cell;
    } else if (key === "signals" && this.isRegular(item)) {
      const signals = this.signalsOf(item);
      // The OA link is only offered when the shelf cannot already open the
      // paper, so it stays a way in rather than a decoration.
      const hasPDF = this.attachmentKinds(item).some(kind => kind.pdf && !kind.supplementary);
      for (const badge of this.signalTools.badges(signals, {hasPDF})) {
        const tone = P[badge.tone] || P.gray;
        const chip = this.pill(doc, badge.text, tone, P);
        chip.title = badge.title;
        // Every other badge is a tinted pill. A retraction is filled solid,
        // because it is the one signal that must not be skimmed past.
        if (badge.solid) {
          chip.style.background = tone;
          chip.style.color = P.dark ? "#141417" : "#FFFFFF";
          chip.style.fontWeight = "700";
          chip.style.letterSpacing = "0.03em";
        }
        if (badge.url) {
          chip.style.cursor = "pointer";
          chip.style.textDecoration = "underline";
          chip.addEventListener("click", event => { event.stopPropagation(); this.Z.launchURL?.(badge.url); });
        }
        cell.appendChild(chip);
      }
      cell.title = signals ? `${signals.status} · 확인 ${signals.checkedAt}` : "";
      return cell;
    } else if (key === "if") {
      const tier = this.impactTier(Number(value), P);
      cell.textContent = label;
      if (tier) { cell.style.color = tier.color; cell.style.fontWeight = "590"; cell.title = `${label} · ${tier.name}`; }
    } else if (key === "citations") {
      const count = Number(value);
      const number = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      number.textContent = label;
      // A fixed, right-aligned number column so every bar starts at one x.
      number.style.cssText = `font-variant-numeric:tabular-nums;min-width:3.4em;text-align:right;`
        + `flex:none;font-weight:${count >= 100 ? 590 : 400};color:${count > 0 ? P.text : P.faint};`;
      cell.appendChild(number);
      const track = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      track.style.cssText = `flex:1;min-width:14px;max-width:56px;height:2px;border-radius:100px;overflow:hidden;background:${this.tint(P.gray, 0.16)};`;
      const fill = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      fill.style.cssText = `display:block;height:100%;border-radius:100px;width:${(this.citationShare(count) * 100).toFixed(1)}%;background:${this.tint(count >= 100 ? P.blue : P.gray, 0.85)};`;
      track.appendChild(fill); cell.appendChild(track);
    } else { cell.textContent = label; }
    if (!["time","progress","annotationCount"].includes(key)) cell.title = label;
    if (this.isRegular(item) && ["if","citations"].includes(key)) {
      const metrics = this.metrics(item);
      cell.title = `${label} · ${metrics[key === "if" ? "impactSource" : "citationSource"] || "saved metadata"}`;
      if (key === "citations" && metrics.citationCheckedAt) cell.title += ` · ${metrics.citationCheckedAt}`;
      if (key === "citations" && this.entry(item).citationAttempt?.status === "error") cell.title += " · 최근 조회 실패, 마지막 확인값 유지";
    }
    return cell;
  }
  selected(win) {
    const selected=win.ZoteroPane?.getSelectedItems();if(selected)return selected.filter(item=>this.isRegular(item));
    const reader=this.Z.Reader?._readers?.find(r=>r._window===win),attachment=reader&&this.Z.Items.get(reader.itemID);
    const parent=attachment?.parentID?this.Z.Items.get(attachment.parentID):attachment;
    return this.isRegular(parent)?[parent]:[];
  }
  openWorkbench(win,tab='explore') {return this.windows.get(win)?.workbench?.show(tab);}
  toggleAppTheme() {
    const key='browser.theme.toolbar-theme',current=this.Z.Prefs.get(key,true),win=this.Z.getMainWindow?.();
    const dark=current===0||current!==1&&!!win?.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const next=dark?1:0;this.Z.Prefs.set(key,next,true);return next;
  }
  async touchReadingItem(itemID) {
    if(!this.active||this.stopping||!this.featureEnabled('updateItemDateModified')||!this.pref('touchDateOnRead',false))return;
    const item=await this.Z.Items.getAsync(Number(itemID));if(!item)return;
    const parent=item.parentID?await this.Z.Items.getAsync(item.parentID):null;
    for(const value of [item,parent].filter(Boolean)) {
      if(!this.active||this.stopping||value.deleted||!value.isEditable?.()||!this.Z.Libraries.get(value.libraryID)?.editable||value.hasChanged?.())continue;
      const before=value.dateModified,now=new Date().toISOString().slice(0,19).replace('T',' ');value.dateModified=now;
      try{await value.saveTx({skipDateModifiedUpdate:true,skipSelect:true,notifierData:{styleCustomActivity:true}});}
      catch(error){if(value.dateModified===now)value.dateModified=before;throw error;}
    }
  }
  displayTags(item) {
    return item.getTags().filter(t=>!/^\/(unread|reading|done)$/.test(t.tag)&&!/^style-custom:/.test(t.tag)&&!/^[★⭐]+$/.test(t.tag)).map(t=>{
      let color;try{color=this.Z.Tags?.getColor(item.libraryID,t.tag)?.color;}catch(_){}
      return {tag:t.tag,color:/^#[0-9a-f]{6}$/i.test(color||'')?color:null};
    }).filter(tag=>this.getSetting('tagDisplayMode')==='colored'?!!tag.color:this.getSetting('tagDisplayMode')==='prefixed'?tag.tag.startsWith(this.getSetting('textTagPrefix')):true);
  }
  publicationTags(item) {
    const result=[];const metrics=this.metrics(item);
    if(metrics.impactFactor!==null)result.push(`IF ${metrics.impactFactor}${metrics.impactYear?' ('+metrics.impactYear+')':''}`);
    const journal=String(item.getField('publicationTitle')||''),rank=this.cache.journalRanks?.[this.journalTools.name(journal)]?.rank||this.legacy?.[journal]?.rank;
    const allowed=['sci','ssci','utd24','ajg','sciBase','pku','JCR','JCI','CiteScore','中科院'];
    if(rank&&typeof rank==='object')for(const key of allowed)if(['string','number'].includes(typeof rank[key])&&String(rank[key]).trim())result.push(key+': '+rank[key]);
    return result;
  }
  setCustomFields(value,{persist=true}={}) {
    const fields=[...new Set(String(value||'').split(',').map(s=>s.trim()).filter(Boolean))];
    if(fields.length>12||fields.some(f=>!(/^[a-z][a-z0-9]*$/i.test(f))||this.Z.ItemFields?.getID&&!this.Z.ItemFields.getID(f)))throw new Error('올바른 Zotero 필드 이름을 최대 12개 입력하세요.');
    const previous=this.dynamicFieldMap||new Map(),next=new Map(),created=[];
    try {
      for(const field of fields){
        if(previous.has(field)){next.set(field,previous.get(field));continue;}
        const key=this.Z.ItemTreeManager.registerColumn({pluginID:this.id,dataKey:'field-'+field,label:field,width:'120',minWidth:40,hidden:true,enabledTreeIDs:['main'],zoteroPersist:['width','hidden','sortDirection','ordinal'],dataProvider:item=>this.isRegular(item)?this.value('field-'+field,item):'',renderCell:(index,value,column,first,doc)=>this.renderCell('field-'+field,index,value,column,doc)});
        if(!key)throw new Error('열을 등록하지 못했습니다: '+field);created.push(key);next.set(field,key);
      }
    } catch(error){for(const key of created)try{this.Z.ItemTreeManager.unregisterColumn(key);}catch(cleanup){this.Z.logError(cleanup);}throw error;}
    for(const [field,key]of previous)if(!next.has(field)){this.Z.ItemTreeManager.unregisterColumn(key);this.columns=this.columns.filter(k=>k!==key);}
    this.columns.push(...created);this.dynamicFieldMap=next;this.dynamicColumns=[...next.values()];
    if(persist)this.Z.Prefs.set('extensions.style-custom.customFields',fields.join(', '),true);
    return fields;
  }
  async refreshPublicationRanks(items) {
    const secret=String(this.pref('journalRankKey','')).trim();if(!secret)throw new Error('설정에서 본인의 easyScholar API 키를 입력하세요.');
    const win=this.Z.getMainWindow?.();if(!win?.fetch)throw new Error('현재 환경에서 저널 지표를 조회할 수 없습니다.');
    const names=[...new Set(items.map(item=>String(item.getField('publicationTitle')||'').trim()).filter(Boolean))];
    if(names.length>20)throw new Error('한 번에 20개 이하의 저널을 선택하세요.');
    const result={updated:0,missing:0};
    for(const journal of names){if(!this.active||this.stopping)break;
      const controller=new win.AbortController(),timer=win.setTimeout(()=>controller.abort(),15000);
      try{
        const response=await win.fetch('https://www.easyscholar.cc/open/getPublicationRank?secretKey='+encodeURIComponent(secret)+'&publicationName='+encodeURIComponent(journal),{signal:controller.signal,credentials:'omit'});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const data=await response.json(),raw=data?.data?.officialRank?.all;
        if(!raw||typeof raw!=='object'||Array.isArray(raw)){result.missing++;continue;}
        const rank={};for(const[key,value]of Object.entries(raw))if(/^[\p{L}\p{N}_-]{1,50}$/u.test(key)&&['string','number'].includes(typeof value))rank[key]=String(value).slice(0,200);
        if(!this.active||this.stopping)break;
        this.cache.journalRanks||={};this.cache.journalRanks[this.journalTools.name(journal)]={rank,source:'easyScholar',checkedAt:new Date().toISOString()};this.dirty=true;result.updated++;
      }catch(_){throw new Error('저널 등급을 조회하지 못했습니다. API 키와 연결을 확인하세요.');}finally{win.clearTimeout(timer);}
    }
    await this.flush();await this.refreshWindows();return result;
  }
  pageProgress(item,attachmentID) {
    const entry=this.entry(item);let old;
    const id=attachmentID??entry.readingAttachmentID;
    const bucket=id&&entry.readingAttachments?.[String(id)];
    if(bucket)return {...this.workspaceTools.progress(bucket),attachmentID:Number(id)};
    if(id && entry.pageTimes && String(id)===String(entry.readingAttachmentID))return {...this.workspaceTools.progress(entry),attachmentID:Number(id)};
    if(attachmentID!=null)return {...this.workspaceTools.progress({}),attachmentID:Number(attachmentID)};
    try{old=this.Z.ZoteroStyle?.api?.storage?.get(item,'readingTime')||(item.libraryID===this.Z.Libraries.userLibraryID?this.legacy?.[item.key]?.readingTime:null);}catch(_){}
    const pages={...(entry.pageTimes||{})};
    if(old?.data&&typeof old.data==='object')for(const [key,value]of Object.entries(old.data))if(/^\d+$/.test(key)&&Number.isFinite(Number(value))&&Number(value)>0)pages[key]=Math.max(Number(pages[key])||0,Number(value));
    const total=Number.isInteger(entry.totalPages)?entry.totalPages:Number(old?.page)||0;
    return {...this.workspaceTools.progress({pageTimes:pages,totalPages:total}),attachmentID:null};
  }
  setPanelCSS(css) {
    if(typeof css!=='string'||css.length>10000||/@|url\s*\(|expression\s*\(|-moz-binding|<\//i.test(css))throw new Error('외부 로딩 없이 단순 CSS 규칙만 입력하세요.');
    const blocks=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    if(css.replace(/([^{}]+)\{([^{}]*)\}/g,'').trim())throw new Error('CSS 규칙의 중괄호를 확인하세요.');
    const scoped=blocks.map(([,selectors,body])=>selectors.split(',').map(s=>'#style-custom-workbench '+s.trim()).join(',')+'{'+body+'}').join('\n');
    this.Z.Prefs.set('extensions.style-custom.panelCSS',css,true);
    for(const [win,state]of this.windows){if(!state.panelStyle){state.panelStyle=win.document.createElementNS('http://www.w3.org/1999/xhtml','style');win.document.documentElement.appendChild(state.panelStyle);state.nodes.push(state.panelStyle);}state.panelStyle.textContent=this.featureEnabled('styleEditor')?scoped:'';}
    return scoped;
  }
  // A "\u2605\u2605\u2605" tag is a real Zotero tag, so Zotero prints it in front of the
  // title. For most items it is also the only place the rating is stored, so it
  // cannot simply be deleted: the rating moves to the hidden tag first.
  starTagItems(libraryID) {
    const id = libraryID ?? this.Z.Libraries.userLibraryID;
    const found = [];
    for (const item of this.Z.Items.getAll ? this.Z.Items.getAll(id) : []) {
      if (!this.isRegular(item)) continue;
      const tags = (item.getTags?.() || []).map(tag => tag.tag);
      if (tags.some(tag => /^[\u2605\u2b50]+$/.test(String(tag).replace(/\ufe0f/g, '')))) found.push(item);
    }
    return found;
  }

  async migrateStarTags(items) {
    let moved = 0, skipped = 0;
    for (const item of items) {
      if (!this.canEdit(item)) { skipped++; continue; }
      // Reading first is what makes this safe: the rating is preserved, then the
      // visible tag is dropped by the same write.
      const rating = this.state(item).rating;
      await this.edit([item], {rating});
      moved++;
    }
    return {moved, skipped};
  }

  // Every item still carrying a rating tag. This library has sixteen distinct
  // tags in total and five of them are ones the user chose, so eighty rows of
  // style-custom:rating:N were most of their tag vocabulary. Marking the tag
  // automatic did not help: Zotero shows automatic tags by default.
  visibleRatingTagItems(libraryID) {
    const id = libraryID ?? this.Z.Libraries.userLibraryID;
    const found = [];
    for (const item of this.Z.Items.getAll ? this.Z.Items.getAll(id) : []) {
      if (!this.isRegular(item)) continue;
      const tags = item.getTags?.() || [];
      if (tags.some(tag => /^style-custom:rating:[0-5]$/.test(String(tag?.tag ?? tag)))) found.push(item);
    }
    return found;
  }

  // Rewriting the rating through the normal path writes Extra and drops the
  // tag in one transaction. Grouped by rating so eighty items cost six writes
  // rather than eighty; the rating is read back per item first, so the grouping
  // never moves a rating from one paper to another.
  async hideRatingTags(items) {
    let fixed = 0, skipped = 0;
    const byRating = new Map();
    for (const item of items) {
      if (!this.canEdit(item)) { skipped++; continue; }
      const rating = this.state(item).rating;
      if (!byRating.has(rating)) byRating.set(rating, []);
      byRating.get(rating).push(item);
    }
    for (const [rating, group] of byRating) {
      await this.edit(group, {rating});
      fixed += group.length;
    }
    return {fixed, skipped};
  }

  // --- Marking a row with a colour ---

  // A small, named set rather than a picker: rows only read as a grouping when
  // the same few colours repeat, and a name is what makes one mean something.
  highlightColours() {
    return [
      {key: 'red', label: '\uBE68\uAC15'}, {key: 'orange', label: '\uC8FC\uD669'},
      {key: 'gold', label: '\uB178\uB791'}, {key: 'green', label: '\uCD08\uB85D'},
      {key: 'teal', label: '\uCCAD\uB85D'}, {key: 'blue', label: '\uD30C\uB791'},
      {key: 'purple', label: '\uBCF4\uB77C'}
    ];
  }

  highlightOf(item) {
    const key = this.entry(item).highlight;
    return this.highlightColours().some(colour => colour.key === key) ? key : null;
  }

  async setHighlight(items, key) {
    const valid = key === null || this.highlightColours().some(colour => colour.key === key);
    if (!valid) throw new RangeError('Unknown highlight colour');
    let changed = 0;
    for (const item of items) {
      if (!this.isRegular(item)) continue;
      const entry = this.entry(item);
      if ((entry.highlight ?? null) === key) continue;
      if (key === null) delete entry.highlight; else entry.highlight = key;
      changed++;
    }
    if (changed) { this.dirty = true; await this.flush(); await this.refreshWindows(); }
    return changed;
  }

  // Painted as a bar down the end of the row, not a background wash: a filled
  // row fights Zotero's own selection and alternating stripes.
  paintHighlights(win, state) {
    for (const row of win.document.querySelectorAll('#zotero-items-tree .row')) {
      const item = win.ZoteroPane?.itemsView?.getRow(Number(row.id.match(/-row-(\d+)$/)?.[1]))?.ref;
      let bar = row.querySelector('.style-custom-highlight');
      const key = this.isRegular(item) ? this.highlightOf(item) : null;
      if (!key) { bar?.remove(); continue; }
      if (!bar) {
        bar = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
        bar.className = 'style-custom-highlight';
        bar.setAttribute('aria-hidden', 'true');
        bar.style.cssText = 'position:absolute;inset-inline-end:0;inset-block:2px;width:3px;border-radius:2px;pointer-events:none;';
        if (!row.style.position) { state.highlightRows ||= new Map(); state.highlightRows.set(row, row.style.position); row.style.position = 'relative'; }
        row.appendChild(bar);
        state.titleNodes.add(bar);
      }
      bar.style.background = this.palette(win.document)[key];
    }
  }

  enhanceTitles(win,state,records) {
    for(const row of win.document.querySelectorAll('#zotero-items-tree .row')) {
      const item=win.ZoteroPane?.itemsView?.getRow(Number(row.id.match(/-row-(\d+)$/)?.[1]))?.ref;
      if(!this.isRegular(item))continue;
      const cell=row.querySelector('.cell.title');if(!cell)continue;
      const titleText=cell.querySelector('.cell-text');
      if(titleText){
        if(this.featureEnabled('titleColumn')&&this.featureEnabled('ReadUnreadStatus')&&this.pref('unreadBold',false)&&this.state(item).status==='unread'){if(!state.titleWeights.has(titleText))state.titleWeights.set(titleText,titleText.style.fontWeight);titleText.style.fontWeight='700';}
        else if(state.titleWeights.has(titleText)){if(titleText.style.fontWeight==='700')titleText.style.fontWeight=state.titleWeights.get(titleText);state.titleWeights.delete(titleText);}
      }
      let strip=cell.querySelector('.style-custom-title-strip'),tags=cell.querySelector('.style-custom-title-tags');
      if(this.featureEnabled('titleColumn')&&this.pref('titleHeatmap',false)) {
        const p=this.pageProgress(item);
        if(p.total){if(!strip){strip=win.document.createElementNS('http://www.w3.org/1999/xhtml','span');strip.className='style-custom-title-strip';strip.setAttribute('aria-hidden','true');strip.style.cssText='position:absolute;left:0;right:0;bottom:0;height:3px;pointer-events:none;';if(!cell.style.position){state.titlePositions.set(cell,cell.style.position);cell.style.position='relative';}cell.appendChild(strip);state.titleNodes.add(strip);}
          const bins=Math.min(60,p.total),colors=[];for(let b=0;b<bins;b++){let seconds=0;for(let page=Math.floor(b*p.total/bins);page<Math.floor((b+1)*p.total/bins);page++)seconds+=Number(p.pages[page])||0;const a=seconds?Math.min(.8,.15+Math.log1p(seconds)/10):0;colors.push(`rgba(36,92,120,${a}) ${b/bins*100}% ${((b+1)/bins)*100}%`);}strip.style.background='linear-gradient(90deg,'+colors.join(',')+')';}
        else strip?.remove();
      }else strip?.remove();
      if(this.featureEnabled('titleColumn')&&this.pref('titleTags',false)) {
        if(!tags){tags=win.document.createElementNS('http://www.w3.org/1999/xhtml','span');tags.className='style-custom-title-tags';tags.style.cssText='font-size:10px;opacity:.85;white-space:nowrap;pointer-events:none;';cell.appendChild(tags);state.titleNodes.add(tags);}
        tags.replaceChildren();const visible=this.displayTags(item).slice(0,this.getSetting('titleTagLimit'));const rating=this.state(item).rating;if(rating)visible.unshift({tag:'★'.repeat(rating),color:null});
        for(const value of visible){const badge=win.document.createElementNS('http://www.w3.org/1999/xhtml','span');badge.textContent=value.tag;badge.title=value.tag;badge.style.marginInlineStart='4px';if(value.color)badge.style.color=value.color;tags.appendChild(badge);}
      }else tags?.remove();
    }
    this.paintHighlights(win,state);
    for(const n of [...state.titleNodes])if(!n.isConnected)state.titleNodes.delete(n);
  }
  // Europe PMC hands back every supplementary file of an article as one zip.
  // Nothing is written until the archive is open and its entries are triaged.
  async fetchSupplementary(item, {pdfOnly = false, signal, maxBytes = 200 * 1024 * 1024} = {}) {
    const record = this.bibliographyRecord(item);
    const url = this.supplementaryTools.searchURL(record, {email: this.contactEmail()});
    if (!url) return {status: 'unsupported', reason: '식별자가 없어 조회할 수 없습니다', added: 0};
    const search = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 20000});
    const article = this.supplementaryTools.pickArticle(search?.response, record);
    if (!article) return {status: 'not-found', reason: 'Europe PMC에서 찾지 못했습니다', added: 0};
    const filesURL = article.hasSupplementary ? this.supplementaryTools.supplementaryURL(article) : null;
    if (!filesURL) {
      return {status: 'none', added: 0,
        reason: article.source === 'PMC' ? '보충자료가 없는 논문입니다'
          : 'PMC에 보관된 본문이 아니라 받을 수 없습니다'};
    }
    const archive = await this.Z.HTTP.request('GET', filesURL, {responseType: 'arraybuffer', timeout: 180000});
    const buffer = archive?.response;
    if (!buffer?.byteLength) return {status: 'error', reason: '빈 응답', added: 0};
    const bytes = new Uint8Array(buffer);
    // A closed-access article answers 200 with an XML error, not an archive.
    const archiveError = this.supplementaryTools.readArchiveError(bytes);
    if (archiveError) {
      return {status: /open access/i.test(archiveError) ? 'none' : 'error', reason: archiveError, added: 0};
    }
    if (buffer.byteLength > maxBytes) {
      return {status: 'error', added: 0,
        reason: `보충자료가 ${(buffer.byteLength / 1048576).toFixed(0)}MB로 너무 커서 건너뜀습니다`};
    }
    signal?.throwIfAborted?.();
    return this.attachSupplementary(item, bytes, {pdfOnly, article});
  }

  // Zotero has no in-memory zip reader, so the archive round-trips through a
  // temporary file that is removed whether or not the import succeeds.
  async attachSupplementary(item, bytes, {pdfOnly = false, article} = {}) {
    const temp = this.Z.getTempDirectory();
    const stem = 'style-custom-suppl-' + item.id + '-' + Date.now();
    const zipPath = PathUtils.join(temp.path, stem + '.zip');
    const outDir = PathUtils.join(temp.path, stem);
    const record = this.entry(item);
    const imported = new Set(Array.isArray(record.supplementaryFiles) ? record.supplementaryFiles : []);
    const existing = new Set([...imported, ...(item.getAttachments?.() || [])
      .map(id => String(this.Z.Items.get(id)?.attachmentFilename || '').toLowerCase()).filter(Boolean)]);
    let added = 0, skipped = 0;
    try {
      await IOUtils.write(zipPath, bytes);
      await IOUtils.makeDirectory(outDir, {ignoreExisting: true});
      const reader = Components.classes['@mozilla.org/libjar/zip-reader;1']
        .createInstance(Components.interfaces.nsIZipReader);
      reader.open(this.Z.File.pathToFile(zipPath));
      reader.test(null);
      let names = [];
      try {
        const entries = reader.findEntries('*');
        while (entries.hasMore()) names.push(entries.getNext());
        for (const file of this.supplementaryTools.classifyEntries(names, {pdfOnly})) {
          if (existing.has(file.name.toLowerCase())) { skipped++; continue; }
          const target = PathUtils.join(outDir, file.name);
          reader.extract(file.entry, this.Z.File.pathToFile(target));
          const attached = await this.Z.Attachments.importFromFile({
            file: target, parentItemID: item.id,
            title: this.supplementaryTools.attachmentTitle(file)
          });
          await this.markSupplementary(attached, file);
          imported.add(file.name.toLowerCase());
          added++;
        }
      } finally { reader.close(); }
    } finally {
      await IOUtils.remove(zipPath, {ignoreAbsent: true}).catch(() => {});
      await IOUtils.remove(outDir, {recursive: true, ignoreAbsent: true}).catch(() => {});
    }
    if (added) { record.supplementaryFiles = [...imported]; this.dirty = true; }
    return {status: added ? 'ok' : skipped ? 'already' : 'none', added, skipped, article};
  }

  // Automatic detection only sees files the plugin fetched or that still carry a
  // publisher's naming. Anything downloaded by hand needs saying so by hand.
  selectedAttachments(win) {
    const chosen = win?.ZoteroPane?.getSelectedItems?.() || [];
    const direct = chosen.filter(item => item?.isFileAttachment?.());
    if (direct.length) return direct;
    // With a parent selected, its own files are the obvious subject.
    return chosen.filter(item => this.isRegular(item))
      .flatMap(item => (item.getAttachments?.() || []).map(id => this.Z.Items.get(id)))
      .filter(attachment => attachment?.isFileAttachment?.());
  }

  async setSupplementary(attachments, supplementary) {
    let changed = 0;
    for (const attachment of attachments) {
      const has = (attachment.getTags?.() || []).some(tag => tag.tag === this.SUPPLEMENTARY_TAG);
      if (has === !!supplementary) continue;
      if (supplementary) attachment.addTag(this.SUPPLEMENTARY_TAG, 1);
      else attachment.removeTag(this.SUPPLEMENTARY_TAG);
      await attachment.saveTx({skipSelect: true, skipDateModifiedUpdate: true});
      changed++;
    }
    if (changed) await this.refreshWindows();
    return changed;
  }

  // Type 1 is an automatic tag: it identifies the file without cluttering the
  // tag selector the way a manual tag would.
  async markSupplementary(attachment, file) {
    if (!attachment?.addTag) return;
    try {
      attachment.addTag(this.SUPPLEMENTARY_TAG, 1);
      // Zotero's auto-rename gives every child the parent's title, which makes
      // four different files look like four copies of one. Restore a name that
      // says which file this is; the tag is what survives if it is renamed again.
      if (file) attachment.setField('title', this.supplementaryTools.attachmentTitle(file));
      await attachment.saveTx({skipSelect: true, skipDateModifiedUpdate: true});
    } catch (error) { this.Z.logError(error); }
  }

  async downloadSupplementary(items, {pdfOnly = false, onProgress} = {}) {
    const totals = {ok: 0, added: 0, none: 0, 'not-found': 0, unsupported: 0, error: 0, already: 0};
    const failures = [];
    for (const [index, item] of items.entries()) {
      onProgress?.(index, items.length, item);
      try {
        const result = await this.fetchSupplementary(item, {pdfOnly});
        totals[result.status] = (totals[result.status] || 0) + 1;
        totals.added += result.added || 0;
        if (result.status === 'error') failures.push(this.bibliographyRecord(item).title + ': ' + result.reason);
      } catch (error) {
        this.Z.logError(error);
        totals.error++;
        failures.push(this.bibliographyRecord(item).title + ': ' + error.message);
      }
    }
    return {...totals, failures};
  }

  // Everything a citation style needs, read straight off the item.
  bibliographyRecord(item) {
    const field = key => { try { return String(item.getField(key) || '').trim(); } catch (_) { return ''; } };
    const base = this.citationRecord(item);
    return {
      title: field('title'),
      creators: (item.getCreators?.() || []).filter(c => !c.creatorType || c.creatorType === 'author'),
      year: base.year ? String(base.year) : (field('date').match(/\b(?:1[5-9]|20)\d{2}\b/) || [''])[0],
      venue: ['publicationTitle', 'proceedingsTitle', 'bookTitle', 'university', 'publisher'].map(field).find(Boolean) || '',
      volume: field('volume'), issue: field('issue'), pages: field('pages'),
      DOI: base.doi || field('DOI'), url: field('url')
    };
  }
  // The same path Zotero's own "Add Item by Identifier" takes, so the import
  // gets the full translator metadata and the PDF, not a bare stub.
  async importByIdentifier(identifier, {libraryID, collections} = {}) {
    const translate = new this.Z.Translate.Search();
    translate.setIdentifier(identifier);
    const translators = await translate.getTranslators();
    if (!translators?.length) throw new Error('이 식별자를 읽을 수 있는 번역기가 없습니다.');
    translate.setTranslator(translators);
    const saved = await translate.translate({
      libraryID: libraryID ?? this.Z.Libraries.userLibraryID,
      collections: collections?.length ? collections : undefined,
      saveAttachments: true
    });
    if (!saved?.length) throw new Error('가져오지 못했습니다.');
    return saved;
  }

  // Newly imported papers should inherit the reading state a fresh item has,
  // and land beside whatever the user was looking at.
  async importWork(work, win) {
    if (!work?.doi) throw new Error('DOI가 없어 자동으로 가져올 수 없습니다.');
    const collection = win?.ZoteroPane?.getSelectedCollection?.();
    const saved = await this.importByIdentifier({DOI: work.doi}, {
      libraryID: win?.ZoteroPane?.getSelectedLibraryID?.(),
      collections: collection ? [collection.id] : undefined
    });
    return saved;
  }

  // --- Impact figures beyond the curated catalogue ---

  journalCache() {
    const store = this.cache.journalMetrics;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.journalMetrics = {});
  }

  journalRecord(item) {
    const field = key => { try { return String(item.getField(key) || '').trim(); } catch (_) { return ''; } };
    return {name: ['publicationTitle', 'proceedingsTitle'].map(field).find(Boolean) || '', issn: field('ISSN')};
  }

  // One lookup per journal, kept for good: 1,116 items in this library share
  // 255 journals, so caching by journal is the difference between a sweep that
  // fits the daily budget and one that cannot.
  async fetchJournalMetric(record, {signal} = {}) {
    const key = this.journalTools2.cacheKey(record);
    if (!record.name && !record.issn) return null;
    const store = this.journalCache();
    if (store[key]) return store[key];
    const url = this.journalTools2.lookupURL(record, this.discoverOptions());
    if (!url) return null;
    const payload = await this.discoverJSON(url, {signal});
    const source = this.journalTools2.pickSource(payload, record);
    if (!source || source.citedness == null) {
      // Remember the miss too, or every sweep pays for it again.
      store[key] = {citedness: null, checkedAt: new Date().toISOString()};
      this.dirty = true;
      return store[key];
    }
    store[key] = {
      citedness: source.citedness, name: source.name, issn: source.issn,
      openAlexID: source.id, checkedAt: new Date().toISOString()
    };
    this.dirty = true;
    return store[key];
  }

  // The catalogue's JIF always wins; this only fills what it does not cover.
  journalCitedness(item) {
    const record = this.journalRecord(item);
    if (!record.name && !record.issn) return null;
    const hit = this.journalCache()[this.journalTools2.cacheKey(record)];
    return hit && hit.citedness != null ? hit : null;
  }

  // OpenAlex meters by the day. Running out mid-sweep is normal, not a fault:
  // stop, keep what was learned, and say how many are left, because the cache
  // is permanent and tomorrow's sweep resumes exactly where this one stopped.
  outOfBudget(error) {
    const status = Number(error?.status ?? error?.xmlhttp?.status ?? 0);
    if (status === 429) return true;
    return /insufficient budget|rate limit/i.test(String(error?.message || ''));
  }

  async refreshJournalCitedness(items, {onProgress, signal} = {}) {
    const wanted = new Map();
    for (const item of items) {
      if (!this.isRegular(item)) continue;
      const record = this.journalRecord(item);
      if (!record.name && !record.issn) continue;
      const key = this.journalTools2.cacheKey(record);
      if (!wanted.has(key) && !this.journalCache()[key]) wanted.set(key, record);
    }
    const queue = [...wanted.values()];
    const result = {journals: queue.length, found: 0, missing: 0, failed: 0, remaining: 0, budgetGone: false};
    for (const [index, record] of queue.entries()) {
      if (signal?.aborted) { result.remaining = queue.length - index; break; }
      onProgress?.(index, queue.length, record);
      try {
        const hit = await this.fetchJournalMetric(record, {signal});
        if (hit && hit.citedness != null) result.found++; else result.missing++;
      } catch (error) {
        if (this.outOfBudget(error)) {
          result.budgetGone = true;
          result.remaining = queue.length - index;
          break;
        }
        this.Z.logError(error);
        result.failed++;
      }
      // Paced so a long sweep neither trips the rate limiter nor freezes the
      // library; the column fills in behind the user as they keep reading.
      if (index + 1 < queue.length) await this.pause(120);
    }
    if (result.found || result.missing) { await this.flush(); await this.refreshWindows(); }
    return result;
  }

  // --- Taking ownership of the reading history ---

  // The only copy of this history is in another plugin's notes, so it has to be
  // read out before that plugin goes. Style Custom's own tracking always wins:
  // a longer total here means it has been counting since, and must not be lost.
  async importLegacyReading({dryRun = false} = {}) {
    const notes = this.Z.Items.getAll ? this.Z.Items.getAll(this.Z.Libraries.userLibraryID) : [];
    const byKey = new Map();
    for (const item of notes) {
      const key = item?.key;
      if (key) byKey.set(key, item);
    }
    const result = {notes: 0, imported: 0, skipped: 0, unresolved: 0, seconds: 0};
    for (const note of notes) {
      if (!note?.isNote?.()) continue;
      const parsed = this.legacyReading.parseNote(note.getNote?.() || '');
      if (!parsed) continue;
      result.notes++;
      const target = byKey.get(parsed.key);
      if (!this.isRegular(target)) { result.unresolved++; continue; }
      const entry = this.entry(target);
      if ((Number(entry.seconds) || 0) >= parsed.seconds) { result.skipped++; continue; }
      if (dryRun) { result.imported++; result.seconds += parsed.seconds; continue; }
      entry.seconds = parsed.seconds;
      entry.legacyReadingKey = parsed.key;
      const attachment = (target.getAttachments?.() || [])[0];
      if (Number.isInteger(attachment) && parsed.totalPages) {
        entry.readingAttachments ||= {};
        entry.readingAttachments[String(attachment)] = {
          pageTimes: parsed.pageTimes, totalPages: parsed.totalPages
        };
        entry.readingAttachmentID = attachment;
      }
      result.imported++;
      result.seconds += parsed.seconds;
    }
    if (result.imported && !dryRun) { this.dirty = true; await this.flush(); await this.refreshWindows(); }
    return result;
  }

  // --- Following an author over time ---

  // Resolving a person by name is the whole difficulty: an unclear field is
  // refused rather than guessed, because watching the wrong person is worse
  // than watching nobody.
  // Each query says what it takes to trust its answer: the plain forms of the
  // name stand on their own, the guessed ones only count with the institution.
  async resolveAuthor(name, {institution, topics, signal} = {}) {
    const options = this.discoverOptions();
    for (const {query, confirm} of this.discoverTools.authorQueries(name, {institution})) {
      const url = this.discoverTools.authorSearchURL(query, options);
      if (!url) continue;
      const found = this.discoverTools.readAuthors(await this.discoverJSON(url, {signal}));
      const hit = this.discoverTools.pickAuthor(found, {name, institution, topics, confirm});
      if (hit) return hit;
    }
    return null;
  }

  async importWatchedAuthors(people, {onProgress, signal} = {}) {
    const result = {added: 0, already: 0, unresolved: [], failed: 0};
    for (const [index, person] of people.entries()) {
      onProgress?.(index, people.length, person);
      try {
        const hit = await this.resolveAuthor(person.name,
          {institution: person.institution, topics: person.topics, signal});
        if (!hit) { result.unresolved.push(person.name); continue; }
        if (this.watchedAuthors().some(row => row.id === hit.id)) { result.already++; continue; }
        // Nothing published so far counts as news; only what appears from now on.
        const {works} = await this.authorActivity(hit.id, {limit: 25, signal});
        await this.watchAuthor({
          id: hit.id, name: hit.name,
          institution: person.institution || hit.institutions?.[0] || '',
          seen: works.map(work => work.id)
        });
        result.added++;
      } catch (error) { this.Z.logError(error); result.failed++; }
    }
    return result;
  }

  // Fifty authors per request means following people is nearly free; what the
  // file actually carries is their stored news, so the limit sits there.
  get WATCH_LIMIT() { return 500; }
  // Enough ids that a prolific lab's back catalogue cannot roll off the end and
  // be re-announced as new.
  get SEEN_LIMIT() { return 400; }

  // Pacing, without reaching for a global the rest of this class does not use:
  // Zotero.Promise is a bootstrap-scope global here and absent under test.
  pause(ms) {
    const win = this.Z.getMainWindow?.();
    if (win?.setTimeout) return new Promise(resolve => win.setTimeout(resolve, ms));
    if (this.Z.Promise?.delay) return this.Z.Promise.delay(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  watchedAuthors() {
    const saved = this.cache.watchedAuthors;
    return Array.isArray(saved) ? saved.filter(row => row && typeof row.id === 'string') : [];
  }

  async watchAuthor(person) {
    const id = this.discoverTools.shortID(person?.id);
    if (!id.startsWith('A')) throw new Error('저자 식별자가 올바르지 않습니다.');
    const rest = this.watchedAuthors().filter(row => row.id !== id);
    // The old cap was 100 because each author used to cost a request of their
    // own. The user already follows 109, so adding anyone simply failed. One
    // sweep now covers fifty per request, and the real cost is the stored news,
    // so the limit is set where the file size starts to matter instead.
    if (rest.length >= this.WATCH_LIMIT) {
      throw new Error(`관심 저자는 ${this.WATCH_LIMIT}명까지 저장합니다. 목록에서 몇 명을 해제하세요.`);
    }
    this.cache.watchedAuthors = [...rest, {
      id, name: String(person.name || id), institution: String(person.institution || ''),
      // What was already known when the author was added, so "new" means new to the user.
      seen: Array.isArray(person.seen) ? person.seen.slice(0, this.SEEN_LIMIT) : [],
      checkedAt: new Date().toISOString()
    }];
    this.dirty = true;
    await this.flush();
    return this.cache.watchedAuthors[this.cache.watchedAuthors.length - 1];
  }

  async unwatchAuthor(authorID) {
    const id = this.discoverTools.shortID(authorID);
    this.cache.watchedAuthors = this.watchedAuthors().filter(row => row.id !== id);
    this.dirty = true;
    await this.flush();
  }

  // The watchlist existed but could not be read at a glance: every row showed
  // the same "last checked" date, so the only way to learn whether anyone had
  // published was to open all 109 of them one by one. That is exactly the cost
  // this plugin is meant to remove. One sweep answers it for everyone at once,
  // and stores the answer so the list itself shows who has news.
  async sweepWatchedAuthors({months = 18, onProgress, signal} = {}) {
    const rows = this.watchedAuthors();
    const result = {authors: rows.length, withNews: 0, works: 0, requests: 0, budgetGone: false, remaining: 0};
    if (!rows.length) return result;
    const options = this.discoverOptions();
    const byID = new Map(rows.map(row => [this.discoverTools.shortID(row.id), row]));
    const batches = this.discoverTools.authorBatches(rows.map(row => row.id));
    const found = new Map();
    // A fixed eighteen-month window silently hides anything published between
    // following someone and first sweeping them, which for an author added two
    // years ago is two years of work. The floor is therefore the oldest "last
    // checked" in the batch, capped so a stale entry cannot ask for a career.
    const sinceFor = batch => {
      const stamps = batch
        .map(id => byID.get(id))
        .map(row => row && (row.sweptAt || row.checkedAt))
        .filter(Boolean)
        .map(stamp => Date.parse(stamp))
        .filter(Number.isFinite);
      const oldest = stamps.length === batch.length ? Math.min(...stamps) : null;
      const floor = Date.now() - Math.max(1, months) * 30 * 24 * 3600 * 1000;
      const cap = Date.now() - 6 * 365 * 24 * 3600 * 1000;
      // A margin, because a posting's publication_date can precede the day it
      // appeared, and a sweep that lands a day late would step over it.
      const start = Math.max(cap, Math.min(floor, (oldest ?? floor) - 7 * 24 * 3600 * 1000));
      return new Date(start).toISOString().slice(0, 10);
    };
    for (const [index, batch] of batches.entries()) {
      if (signal?.aborted) { result.remaining = batches.length - index; break; }
      onProgress?.(index, batches.length);
      let cursor = '*';
      try {
        // Cursor paging, because a batch of fifty active labs clears 200 works
        // easily and a truncated page would silently under-report the news.
        for (let page = 0; page < 5 && cursor; page++) {
          const url = this.discoverTools.watchedWorksURL(batch, {...options, since: sinceFor(batch), cursor});
          if (!url) break;
          const payload = await this.discoverJSON(url, {signal});
          result.requests++;
          const works = this.discoverTools.readWorks(payload);
          for (const [id, list] of this.discoverTools.attribute(works, batch)) {
            found.set(id, [...(found.get(id) || []), ...list]);
          }
          cursor = works.length ? payload?.meta?.next_cursor || '' : '';
          if (cursor) await this.pause(150);
        }
      } catch (error) {
        if (this.outOfBudget(error)) { result.budgetGone = true; result.remaining = batches.length - index; break; }
        this.Z.logError(error);
      }
    }
    const owned = this.libraryDOIs();
    const checkedAt = new Date().toISOString();
    for (const row of rows) {
      // A batch that never ran must not be recorded as "checked, nothing new" --
      // that would hide real news behind a clean-looking row.
      if (!found.has(row.id) && (result.budgetGone || result.remaining)) continue;
      const seen = new Set(row.seen || []);
      const fresh = (found.get(row.id) || [])
        .filter(work => !seen.has(work.id))
        .sort((a, b) => String(b.date || b.year || '').localeCompare(String(a.date || a.year || '')));
      row.news = fresh.slice(0, 8).map(work => ({
        id: work.id, title: work.title, venue: work.venue, doi: work.doi,
        date: work.date || (work.year ? String(work.year) : ''),
        inLibrary: !!work.doi && owned.has(work.doi)
      }));
      row.sweptAt = checkedAt;
      if (fresh.length) result.withNews++;
      result.works += fresh.length;
    }
    this.cache.watchedAuthors = rows;
    this.dirty = true;
    await this.flush();
    return result;
  }

  // Sorted so the answer is the top of the list: people with news first, most
  // recent first among them, and everyone else alphabetically underneath.
  watchedAuthorsByNews() {
    return this.watchedAuthors().slice().sort((a, b) => {
      const an = a.news?.length || 0, bn = b.news?.length || 0;
      if (an !== bn) return bn - an;
      if (an) return String(b.news[0].date || '').localeCompare(String(a.news[0].date || ''));
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  async clearAuthorNews(authorID) {
    const id = this.discoverTools.shortID(authorID);
    const rows = this.watchedAuthors();
    const row = rows.find(entry => entry.id === id);
    if (!row) return false;
    row.seen = [...new Set([...(row.news || []).map(work => work.id), ...(row.seen || [])])].slice(0, this.SEEN_LIMIT);
    row.news = [];
    row.checkedAt = new Date().toISOString();
    this.cache.watchedAuthors = rows;
    this.dirty = true;
    await this.flush();
    return true;
  }

  // What this author has published since the user last looked.
  async authorUpdates(authorID, {limit = 25, signal} = {}) {
    const id = this.discoverTools.shortID(authorID);
    const watched = this.watchedAuthors().find(row => row.id === id);
    const {profile, works} = await this.authorActivity(id, {limit, signal});
    const seen = new Set(watched?.seen || []);
    const fresh = watched ? works.filter(work => !seen.has(work.id)) : [];
    return {profile, works, fresh, watching: !!watched, checkedAt: watched?.checkedAt || null};
  }

  // Marking as read is explicit: opening the tab should not quietly clear the news.
  async markAuthorSeen(authorID, works) {
    const id = this.discoverTools.shortID(authorID);
    const rows = this.watchedAuthors();
    const row = rows.find(entry => entry.id === id);
    if (!row) return false;
    const ids = (Array.isArray(works) ? works : []).map(work => work.id).filter(Boolean);
    row.seen = [...new Set([...ids, ...(row.seen || [])])].slice(0, this.SEEN_LIMIT);
    row.checkedAt = new Date().toISOString();
    this.cache.watchedAuthors = rows;
    this.dirty = true;
    await this.flush();
    return true;
  }

  // --- Discovery: what to read next, and what an author is doing now ---

  // OpenAlex and Europe PMC both put callers who identify themselves on a
  // faster pool. This read a key that was never shipped, so it was always empty
  // and every request went to the anonymous pool -- which is where the rate
  // limiting came from. One accessor now, over the key the schema declares.
  contactEmail() {
    const clean = value => String(value == null ? '' : value).trim();
    const set = clean(this.pref('citationEmail', '')) || clean(this.Z.Prefs.get('extensions.zotpop.email', true));
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set)) return set;
    let account = '';
    try { account = String(this.Z.Prefs.get('sync.server.username', true) || '').trim(); }
    catch (ignored) { }
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account) ? account : '';
  }

  // The schema key is all lower case. A capitalised misspelling is not a
  // preference, it is always undefined, so the citation sweep ran anonymous and
  // spent OpenAlex's unauthenticated $0.01/day in about ten requests while a
  // perfectly good key sat in ZotPoP's prefs.
  openAlexKey() {
    // Trim each candidate before choosing: a field holding only spaces is not a
    // key, but it is truthy, so it would shadow a real one stored elsewhere.
    const clean = value => String(value == null ? '' : value).trim();
    return clean(this.pref('openalexApiKey', ''))
      || clean(this.Z.Prefs.get('extensions.zotpop.openAlexApiKey', true));
  }

  discoverOptions() {
    return {
      email: this.contactEmail() || undefined,
      // ZotPoP keeps the user's free OpenAlex key; reuse it when it is there.
      apiKey: this.openAlexKey() || undefined
    };
  }

  async discoverJSON(url, {signal} = {}) {
    const response = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 30000});
    signal?.throwIfAborted?.();
    return response?.response;
  }

  // Every DOI already on the shelf, so a suggestion can say "you have this".
  libraryDOIs() {
    const owned = new Set();
    for (const [, entry] of Object.entries(this.cache.items || {})) {
      const doi = this.discoverTools.bareDOI(entry?.doi);
      if (doi) owned.add(doi);
    }
    return owned;
  }

  // Least-recently-used, so revisiting a paper is instant without pinning memory.
  discoverCached(key, build) {
    if (this.discoverCache.has(key)) {
      const value = this.discoverCache.get(key);
      this.discoverCache.delete(key);
      this.discoverCache.set(key, value);
      return value;
    }
    const pending = Promise.resolve().then(build).catch(error => {
      // A failed lookup must not be remembered as the answer.
      this.discoverCache.delete(key);
      throw error;
    });
    this.discoverCache.set(key, pending);
    while (this.discoverCache.size > this.DISCOVER_CACHE_LIMIT) {
      this.discoverCache.delete(this.discoverCache.keys().next().value);
    }
    return pending;
  }

  relatedWorksCached(item, options = {}) {
    return this.discoverCached('related:' + this.identity(item), () => this.relatedWorks(item, options));
  }
  authorActivityCached(authorID, options = {}) {
    return this.discoverCached('author:' + this.discoverTools.shortID(authorID), () => this.authorActivity(authorID, options));
  }
  authorsOfCached(item, options = {}) {
    return this.discoverCached('authors:' + this.identity(item), () => this.authorsOf(item, options));
  }

  async relatedWorks(item, {limit = 40, signal, have} = {}) {
    const options = this.discoverOptions();
    const url = this.discoverTools.workURL(this.bibliographyRecord(item), options);
    if (!url) throw new Error('이 문헌에는 DOI나 제목이 없어 조회할 수 없습니다.');
    const work = this.discoverTools.readWork(await this.discoverJSON(url, {signal}));
    if (!work) return {work: null, suggestions: []};
    const ids = [...work.references, ...work.related].slice(0, 50);
    const batchURL = this.discoverTools.worksByIDsURL(ids, options);
    const citingURL = this.discoverTools.citingURL(work.id, {...options, limit: 30});
    const [found, citing] = await Promise.all([
      batchURL ? this.discoverJSON(batchURL, {signal}).then(this.discoverTools.readWorks) : [],
      // What came after the paper is the most useful answer to "what next", but
      // losing it should not cost the rest of the list.
      citingURL ? this.discoverJSON(citingURL, {signal}).then(this.discoverTools.readWorks)
        .catch(error => { this.Z.logError(error); return []; }) : []
    ]);
    return {work, suggestions: this.discoverTools.mergeSuggestions(work, found,
      {have: have ?? this.libraryDOIs(), limit, citing})};
  }

  // Resolved from the paper's own authorships, never from the name alone.
  async authorsOf(item, {signal} = {}) {
    const options = this.discoverOptions();
    const url = this.discoverTools.workURL(this.bibliographyRecord(item), options);
    if (!url) return [];
    const work = this.discoverTools.readWork(await this.discoverJSON(url, {signal}));
    return work?.people?.filter(person => person.id) || [];
  }

  async authorActivity(authorID, {limit = 25, signal} = {}) {
    const options = this.discoverOptions();
    const worksURL = this.discoverTools.authorWorksURL(authorID, {...options, limit});
    if (!worksURL) throw new Error('저자 식별자가 올바르지 않습니다.');
    const profileURL = `${this.discoverTools.API}authors/${this.discoverTools.shortID(authorID)}`
      + `?select=id,display_name,works_count,cited_by_count,summary_stats,last_known_institutions,topics,orcid`
      + this.discoverTools.credentials(options);
    const [profilePayload, worksPayload] = await Promise.all([
      this.discoverJSON(profileURL, {signal}).catch(error => { this.Z.logError(error); return null; }),
      this.discoverJSON(worksURL, {signal})
    ]);
    const [profile] = this.discoverTools.readAuthors({results: [profilePayload]});
    const owned = this.libraryDOIs();
    const works = this.discoverTools.readWorks(worksPayload)
      .map(work => ({...work, inLibrary: !!work.doi && owned.has(work.doi)}));
    return {profile: profile || null, works};
  }

  // --- Paper signals: retraction, open access, preprint -> published ---

  signalsOf(item) { return this.entry(item).signals || null; }

  // Crossref answers 404 for a DOI it has never registered, and OpenAlex
  // answers 404 for a preprint DOI it has merged into the published work.
  // Both are answers about the paper, not transport failures, so they must not
  // abort the other half of the lookup.
  async signalsJSON(url, {signal} = {}) {
    const response = await this.Z.HTTP.request("GET", url,
      {responseType: "json", timeout: 20000, successCodes: false});
    signal?.throwIfAborted?.();
    // A 429 is not an answer about the paper. Left as null it reads as "no
    // notices found", so a sweep during a budget outage would walk the whole
    // library, learn nothing, and report it as a clean bill of health.
    if (response?.status === 429) throw Object.assign(new Error("Insufficient budget"), {status: 429});
    return response?.status === 200 ? response.response : null;
  }

  async fetchPaperSignals(item, {signal} = {}) {
    const record = this.bibliographyRecord(item);
    const options = this.discoverOptions();
    const crossrefURL = this.signalTools.crossrefURL(record, options);
    const openAlexURL = this.signalTools.openAlexURL(record, options);
    if (!crossrefURL && !openAlexURL) return {signals: null, reason: "unsupported"};
    // Crossref answers the retraction question and is free and unmetered;
    // OpenAlex adds open-access and preprint-to-published and is not. When the
    // day's OpenAlex budget is gone, a retracted paper is still worth recording
    // -- it is the fact this whole column exists for -- so that half is kept
    // and the entry is marked partial for a later run to finish.
    let openAlexOut = false;
    const [crossrefPayload, openAlexPayload] = await Promise.all([
      crossrefURL ? this.signalsJSON(crossrefURL, {signal}) : null,
      openAlexURL ? this.signalsJSON(openAlexURL, {signal})
        .catch(error => { if (!this.outOfBudget(error)) throw error; openAlexOut = true; return null; })
        : null
    ]);
    const crossref = this.signalTools.readCrossref(crossrefPayload);
    let openAlex = this.signalTools.readOpenAlex(openAlexPayload);
    let published = null;
    // A merged preprint is no longer addressable by its own DOI, so the
    // published version is located by title and accepted only when the work
    // found carries this preprint's DOI among its locations.
    if (!openAlex && (crossref?.isPreprint || this.signalTools.PREPRINT_PREFIXES.test(this.signalTools.bareDOI(record.DOI)))) {
      const titleURL = this.signalTools.openAlexTitleURL(record, options);
      const hits = titleURL ? await this.signalsJSON(titleURL, {signal}) : null;
      for (const raw of Array.isArray(hits?.results) ? hits.results : []) {
        const work = this.signalTools.readOpenAlex(raw);
        const match = this.signalTools.publishedVersionOf(work, record);
        if (match) { published = match; openAlex = work; break; }
      }
    }
    if (!crossref?.valid && !openAlex) {
      // Nothing was learned and the reason was a spent budget, not the paper.
      if (openAlexOut) throw Object.assign(new Error("Insufficient budget"), {status: 429});
      return {signals: null, reason: "not-found"};
    }
    const summary = this.signalTools.summarise({crossref, openAlex, published, record});
    if (openAlexOut && summary) summary.partial = true;
    return {signals: summary, reason: "ok", openAlexOut};
  }

  async refreshPaperSignals(items, {signal, onProgress, pace = 0} = {}) {
    const summary = {ok: 0, "not-found": 0, unsupported: 0, error: 0, remaining: 0, budgetGone: false};
    const queue = [...new Set(items)].filter(item => this.isRegular(item));
    for (const [index, item] of queue.entries()) {
      if (!this.active || this.stopping || signal?.aborted) { summary.remaining = queue.length - index; break; }
      onProgress?.(index, queue.length);
      try {
        const {signals, reason, openAlexOut} = await this.fetchPaperSignals(item, {signal});
        if (openAlexOut) summary.partialOnly = (summary.partialOnly || 0) + 1;
        if (!signals) { summary[reason]++; continue; }
        this.entry(item).signals = signals;
        this.dirty = true; summary.ok++;
      } catch (error) {
        if (this.outOfBudget(error)) {
          summary.budgetGone = true;
          summary.remaining = queue.length - index;
          break;
        }
        // A failed lookup leaves the previous answer standing: a retraction
        // already recorded must not disappear because the network blinked.
        summary.error++; this.Z.logError(error);
      }
      if (pace && index + 1 < queue.length) await this.pause(pace);
    }
    if (this.active) { await this.flush(); await this.refreshWindows(); }
    return summary;
  }

  // One run at a time, cancellable, and never two windows racing the same sweep.
  // Not async: a second caller must get back the very promise already in
  // flight, not a fresh wrapper around it.
  runBackfill(options = {}) {
    if (this.backfilling) return this.backfilling;
    const controller = new (this.Z.getMainWindow?.()?.AbortController || globalThis.AbortController)();
    this.backfillController = controller;
    this.backfilling = this.backfill({...options, signal: controller.signal})
      .finally(() => { this.backfilling = null; this.backfillController = null; });
    return this.backfilling;
  }

  stopBackfill() { this.backfillController?.abort(); }

  showBackfillProgress(win, stage, done, total) {
    const label = {signals: '철회·공개접근 신호', journals: '저널 지표', authors: '관심 저자 새 논문'}[stage] || stage;
    const text = `${label} 채우는 중 ${done + 1}/${total}`;
    for (const [target, state] of this.windows) {
      if (target.closed) continue;
      try { state?.workbench?.setStatus?.(text); } catch (error) { this.Z.logError(error); }
    }
  }

  backfillSummary(report) {
    const lines = [];
    if (report.signals) {
      lines.push(`철회·공개접근 신호: ${report.signals.ok}편 확인`
        + (report.signals['not-found'] ? ` · ${report.signals['not-found']}편은 기록 없음` : '')
        + (report.signals.error ? ` · ${report.signals.error}편 조회 실패` : ''));
      if (report.signals.partialOnly) {
        lines.push(`  그중 ${report.signals.partialOnly}편은 철회 여부만 확인했습니다(공개접근 정보는 한도 복구 후 자동으로 채웁니다).`);
      }
    } else lines.push('철회·공개접근 신호: 더 확인할 문헌이 없습니다.');
    if (report.journals) lines.push(`저널 지표: ${report.journals.found}종 확인 · ${report.journals.missing}종은 OpenAlex에도 없음`);
    if (report.authors) {
      lines.push(report.authors.withNews
        ? `관심 저자: ${report.authors.withNews}명이 새 논문 ${report.authors.works}편`
        : `관심 저자: ${report.authors.authors}명 확인, 새 논문 없음`);
    }
    if (report.budgetGone) {
      lines.push('', 'OpenAlex 하루 한도를 다 썼습니다. UTC 자정에 초기화되고, 다시 실행하면 남은 것부터 이어서 채웁니다.');
    }
    return lines.join('\n');
  }

  // Three features were built, shipped, and then sat empty: not one of the
  // user's 1,214 papers had a retraction check, not one of their 255 journals
  // had a figure, and not one of their 109 followed authors had been swept.
  // Each waited on a context-menu item nobody had a reason to go looking for,
  // so the columns showed a dash and the panel showed nothing. This fills them
  // in the background instead, cheapest and highest-stakes first: a retracted
  // paper is the one fact worth interrupting someone for.
  itemsNeedingSignals(libraryID) {
    const id = libraryID ?? this.Z.Libraries.userLibraryID;
    const wanted = [];
    for (const item of this.Z.Items.getAll ? this.Z.Items.getAll(id) : []) {
      if (!this.isRegular(item)) continue;
      // A partial entry carries Crossref's retraction verdict but not the
      // open-access half, so it is asked again rather than left half-answered.
      const known = this.entry(item).signals;
      if (known && !known.partial) continue;
      // Without a DOI there is nothing to ask Crossref, so asking wastes a turn.
      if (!this.signalTools.bareDOI(this.citationRecord(item).doi)) continue;
      wanted.push(item);
    }
    return wanted;
  }

  // What the panel needs to say there is work to do, counted without asking
  // the network anything.
  backfillPending(libraryID) {
    const id = libraryID ?? this.Z.Libraries.userLibraryID;
    let signals = 0;
    const journals = new Set();
    for (const item of this.Z.Items.getAll ? this.Z.Items.getAll(id) : []) {
      if (!this.isRegular(item)) continue;
      const known = this.entry(item).signals;
      if ((!known || known.partial) && this.signalTools.bareDOI(this.citationRecord(item).doi)) signals++;
      const record = this.journalRecord(item);
      if (!record.name && !record.issn) continue;
      // Only journals the curated catalogue does not already answer.
      if (this.value('if', item) !== '') continue;
      const key = this.journalTools2.cacheKey(record);
      if (!this.journalCache()[key]) journals.add(key);
    }
    const authors = this.watchedAuthors().filter(row => !row.sweptAt).length;
    return {signals, journals: journals.size, authors};
  }

  async backfill({libraryID, signal, onProgress, pace = 250} = {}) {
    const report = {signals: null, journals: null, authors: null, budgetGone: false, stage: null};
    const note = (stage, done, total) => onProgress?.({stage, done, total});

    report.stage = 'signals';
    const papers = this.itemsNeedingSignals(libraryID);
    if (papers.length) {
      report.signals = await this.refreshPaperSignals(papers,
        {signal, pace, onProgress: (done, total) => note('signals', done, total)});
      if (report.signals.budgetGone) { report.budgetGone = true; return report; }
    }
    if (signal?.aborted || !this.active || this.stopping) return report;

    report.stage = 'journals';
    const all = this.Z.Items.getAll ? this.Z.Items.getAll(libraryID ?? this.Z.Libraries.userLibraryID) : [];
    report.journals = await this.refreshJournalCitedness(all.filter(item => this.isRegular(item)),
      {signal, onProgress: (done, total) => note('journals', done, total)});
    if (report.journals.budgetGone) { report.budgetGone = true; return report; }
    if (signal?.aborted || !this.active || this.stopping) return report;

    report.stage = 'authors';
    report.authors = await this.sweepWatchedAuthors(
      {signal, onProgress: (done, total) => note('authors', done, total)});
    report.budgetGone = !!report.authors.budgetGone;
    report.stage = report.budgetGone ? 'authors' : 'done';
    return report;
  }

  // Zotero's own CSL processor is authoritative when the style is installed;
  // the local formatter only covers the case where it is not.
  async citationText(items, style) {
    const records = items.map(item => this.bibliographyRecord(item));
    if (style.url) {
      try {
        const output = await this.Z.QuickCopy?.getContentFromItems?.(items, 'bibliography=' + style.url);
        const produced = String(output?.text || '').trim();
        if (produced) return produced;
      } catch (error) { this.Z.logError(error); }
    }
    if (style.key === 'bibtex') return records.map(r => this.citationFormats.bibtex(r)).join('\n\n');
    if (style.key === 'ris') return records.map(r => this.citationFormats.ris(r)).join('\n\n');
    return records.map(r => this.citationFormats.format(style.key, r)).join('\n\n');
  }
  // Google Scholar shows every style at once and lets you pick by eye. A stack of
  // menu items makes you choose a format before you can see what it looks like.
  async citationPanel(win, items) {
    if (!items.length) throw new Error('\uBB38\uD5CC\uC744 \uBA3C\uC800 \uC120\uD0DD\uD558\uC138\uC694.');
    const doc = win.document;
    doc.getElementById('style-custom-cite')?.remove();
    const html = tag => doc.createElementNS('http://www.w3.org/1999/xhtml', tag);

    if (!doc.getElementById('style-custom-cite-css')) {
      const sheet = html('link');
      sheet.id = 'style-custom-cite-css';
      sheet.rel = 'stylesheet';
      sheet.href = this.rootURI + 'content/citation.css';
      doc.documentElement.appendChild(sheet);
    }
    const backdrop = html('div');
    backdrop.id = 'style-custom-cite';
    const panel = html('div');
    panel.className = 'sc-cite-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '\uC778\uC6A9');
    backdrop.appendChild(panel);

    const head = html('div');
    head.className = 'sc-cite-head';
    const title = html('h2');
    title.textContent = items.length > 1 ? `\uC778\uC6A9 \u00b7 ${items.length}\uAC1C` : '\uC778\uC6A9';
    const close = html('button');
    close.type = 'button';
    close.className = 'sc-cite-close';
    close.textContent = '\u2715';
    close.setAttribute('aria-label', '\uB2EB\uAE30');
    head.append(title, close);
    panel.appendChild(head);

    const rows = html('div');
    rows.className = 'sc-cite-rows';
    panel.appendChild(rows);

    const note = html('p');
    note.className = 'sc-cite-note';
    note.textContent = '\uD589\uC744 \uB204\uB974\uBA74 \uBCF5\uC0AC\uB429\uB2C8\uB2E4.';
    panel.appendChild(note);

    const dismiss = () => { backdrop.remove(); win.removeEventListener('keydown', onKey, true); };
    const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); dismiss(); } };
    close.addEventListener('click', dismiss);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) dismiss(); });
    win.addEventListener('keydown', onKey, true);

    const flash = (element, text) => {
      note.textContent = text;
      element.dataset.copied = 'true';
      win.setTimeout(() => { delete element.dataset.copied; }, 900);
    };

    const activate = (element, run) => {
      element.addEventListener('click', run);
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); }
      });
    };
    for (const style of this.citationFormats.PANEL_STYLES) {
      const row = html('div');
      row.className = 'sc-cite-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      const label = html('span');
      label.className = 'sc-cite-label';
      label.textContent = style.label;
      const value = html('span');
      value.className = 'sc-cite-value';
      value.textContent = '\u2026';
      row.append(label, value);
      rows.appendChild(row);
      // Each style is rendered on its own so one failure cannot blank the panel.
      this.citationText(items, style)
        .then(text => { value.textContent = text; })
        .catch(error => { this.Z.logError(error); value.textContent = '\uB9CC\uB4E4 \uC218 \uC5C6\uC74C'; row.setAttribute('aria-disabled', 'true'); });
      row.setAttribute('aria-label', style.label);
      activate(row, () => {
        if (row.getAttribute('aria-disabled') === 'true' || !value.textContent.trim()) return;
        this.Z.Utilities.Internal.copyTextToClipboard(value.textContent);
        flash(row, `${style.label} \uC778\uC6A9\uBB38\uC744 \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.`);
      });
    }

    const exports = html('div');
    exports.className = 'sc-cite-exports';
    for (const format of this.citationFormats.EXPORTS) {
      const link = html('button');
      link.type = 'button';
      link.textContent = format.label;
      link.addEventListener('click', async () => {
        try {
          const text = await this.citationText(items, {key: format.key});
          this.Z.Utilities.Internal.copyTextToClipboard(text);
          flash(link, `${format.label} \uD615\uC2DD\uC744 \uBCF5\uC0AC\uD588\uC2B5\uB2C8\uB2E4.`);
        } catch (error) { this.Z.logError(error); note.textContent = error.message; }
      });
      exports.appendChild(link);
    }
    panel.appendChild(exports);

    doc.documentElement.appendChild(backdrop);
    close.focus?.();
    return backdrop;
  }

  async copyCitations(win, style) {
    const items = this.selected(win);
    if (!items.length) throw new Error('문헌을 먼저 선택하세요.');
    const output = await this.citationText(items, style);
    if (!output.trim()) throw new Error('이 문헌에서 인용문을 만들 메타데이터가 부족합니다.');
    this.Z.Utilities.Internal.copyTextToClipboard(output);
    return output;
  }
  citationRecord(item) {
    const field = key => { try { return String(item.getField(key)||"").trim(); } catch (_) { return ""; } };
    const extra=field("extra"), url=field("url");
    const explicitDOI=field("DOI") || extra.match(/^\s*DOI:\s*(.+)$/im)?.[1];
    const doi=explicitDOI ? this.citationTools.normalizeDOI(explicitDOI) || explicitDOI : this.citationTools.normalizeDOI(url);
    const pmid=field("PMID") || extra.match(/^\s*PMID:\s*(\d+)\s*$/im)?.[1] || url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1];
    const arxiv=extra.match(/^\s*arxiv:\s*(\S+)/im)?.[1] || url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+)/i)?.[1];
    const authorType=this.Z.CreatorTypes?.getID("author");
    const first=item.getCreators?.()?.find(c=>c.creatorType==="author" || authorType!==undefined && c.creatorTypeID===authorType);
    // Author corroboration is needed for title lookup, not an already exact DOI.
    // Keep DOI cache identity independent of loading optional creator metadata.
    return {key:this.identity(item),doi,pmid,arxiv,title:field("title"),year:Number(field("date").match(/\b(?:1[5-9]|20)\d{2}\b/)?.[0])||null,firstAuthor:this.citationTools.normalizeDOI(doi)?"":first?.lastName||first?.name||""};
  }
  scheduleMetadataCitations(ids) {
    if(!this.active||this.stopping||!this.featureEnabled("citedCountColumn")||!this.pref("metadataCitations",true)||!ids?.length)return;
    for(const id of ids||[])if(Number.isInteger(Number(id)))this.metadataIDs.add(Number(id));
    const win=this.Z.getMainWindow?.();if(!win)return;
    if(this.metadataTimer!=null)this.metadataTimerWindow.clearTimeout(this.metadataTimer);
    this.metadataTimerWindow=win;
    this.metadataTimer=win.setTimeout(()=>{
      this.metadataTimer=null;const batch=[...this.metadataIDs];this.metadataIDs.clear();
      this.metadataQueue=this.metadataQueue.then(async()=>{
        if(!this.active||this.stopping||!this.featureEnabled("citedCountColumn")||!this.pref("metadataCitations",true))return;
        const items=[];
        for(const id of batch){try{const item=await this.Z.Items.getAsync(id);if(this.canEdit(item))items.push(item);}catch(error){this.Z.logError(error);}}
        if(!items.length)return;
        await this.refreshCitations(items);
        for(const item of items) {
          if(!this.active||this.stopping||!this.featureEnabled("citedCountColumn")||!this.pref("metadataCitations",true))break;
          try { await this.persistCitation(item,this.entry(item).citationLookup); }
          catch(error){this.Z.logError(error);}
        }
      }).catch(error=>this.Z.logError(error));
      return this.metadataQueue;
    },1200);
  }
  async persistCitation(item,result,{flush=true}={}) {
    if(!this.active||this.stopping||!this.canEdit(item)||item.hasChanged?.()||result?.status!=="ok"||!Number.isSafeInteger(result.count)||result.count<0)return false;
    if(!["OpenAlex","Crossref"].includes(result.source)||result.identity!==this.citationTools.identity(this.citationRecord(item)))return false;
    if(!Number.isFinite(Date.parse(result.checkedAt)))return false;
    const before=String(item.getField("extra")||"");
    const line=`Citations: ${result.count} (${result.source}, ${new Date(result.checkedAt).toISOString().slice(0,10)})`;
    const lines=before.split(/\r?\n/),owned=/^\s*Citations:\s*\d[\d,]*(?:\s+\([^\r\n]*\))?\s*$/i;
    const after=[...lines.filter(l=>!owned.test(l)),line].join("\n").replace(/^\n/,"");
    if(before===after)return false;
    item.setField("extra",after);
    try {await item.saveTx({notifierData:{styleCustomCitations:true},skipSelect:true});}
    catch(error){if(item.getField("extra")===after)item.setField("extra",before);throw error;}
    this.entry(item).citationExtra={identity:result.identity,line};this.dirty=true;if(flush)await this.flush();return true;
  }
  async syncLibraryCitations(libraryID=this.Z.Libraries.userLibraryID,{lookup=true}={}) {
    if(this.bulkCitationPromise)return this.bulkCitationPromise;
    const work=(async()=>{
      const items=(await this.Z.Items.getAll(libraryID,true,false)).filter(item=>this.isRegular(item));
      const report={libraryID,total:items.length,processed:0,saved:0,unchanged:0,unavailable:0,errors:0,running:true,startedAt:new Date().toISOString()};
      this.cache.lastCitationSave=report;this.dirty=true;await this.flush();
      try {
        report.lookup=lookup?await this.refreshCitations(items):{cachedOnly:true};
        let lastFlush=0;
        for(const item of items) {
          if(!this.active||this.stopping){report.cancelled=true;break;}
          const result=this.entry(item).citationLookup;
          try {
            if(result?.status!=="ok"||result.identity!==this.citationTools.identity(this.citationRecord(item)))report.unavailable++;
            else if(await this.persistCitation(item,result,{flush:false}))report.saved++;
            else report.unchanged++;
          } catch(error){report.errors++;this.Z.logError(error);}
          report.processed++;this.dirty=true;
          if(Date.now()-lastFlush>1000){lastFlush=Date.now();await this.flush();}
        }
        return report;
      } finally {
        report.running=false;report.finishedAt=new Date().toISOString();this.dirty=true;
        await this.flush();await this.refreshWindows();
      }
    })();
    this.bulkCitationPromise=work;
    try{return await work;}finally{if(this.bulkCitationPromise===work)this.bulkCitationPromise=null;}
  }
  citationDue(item, {force=false,onlyMissing=false}={}) {
    if (force) return true;
    if (onlyMissing && this.metrics(item).citations!==null) return false;
    const id=this.citationTools.identity(this.citationRecord(item)),attempt=this.entry(item).citationAttempt;
    if (!attempt || attempt.identity!==id) return true;
    const age=Date.now()-Date.parse(attempt.checkedAt);
    const ttl=attempt.status==="error"?this.getSetting("citationRetryMinutes")*60*1000:attempt.status==="not-found"?24*60*60*1000:this.getSetting("citationRefreshDays")*24*60*60*1000;
    return !Number.isFinite(age)||age<0||age>=ttl;
  }
  citationHTTP(signal) {
    return {getJSON:(url,headers={})=>new Promise((resolve,reject)=>{
      let cancel,settled=false;
      const finish=(fn,value)=>{if(settled)return;settled=true;signal.removeEventListener("abort",abort);fn(value);};
      const abort=()=>{try{cancel?.();}catch(_){}finish(reject,Object.assign(new Error("Citation lookup cancelled"),{name:"AbortError"}));};
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted){abort();return;}
      try {
        Promise.resolve(this.Z.HTTP.request("GET",url,{headers,responseType:"json",timeout:15000,successCodes:false,errorDelayMax:0,cancellerReceiver:fn=>{cancel=fn;if(signal.aborted)cancel();}}))
          .then(response=>{
            try {
              const status=Number(response.status??200);
              if(status<200||status>=300)finish(reject,Object.assign(new Error("Citation HTTP "+status),{status,retryAfter:response.getResponseHeader?.("Retry-After")}));
              else finish(resolve,response.response);
            } catch(error){finish(reject,error);}
          },error=>finish(reject,error));
      } catch(error){finish(reject,error);}
    })};
  }
  async refreshCitations(items, options={}) {
    if(!this.active||this.stopping)return {ok:0,"not-found":0,error:0,unsupported:0,skipped:items.length};
    if(this.citationJob){if(options.background)return {busy:true};await this.citationJob.promise;return this.refreshCitations(items,options);}
    const selection=[...new Set(items)].filter(item=>this.isRegular(item)&&this.citationDue(item,options));
    const summary={ok:0,"not-found":0,error:0,unsupported:0,skipped:items.length-selection.length};
    if(!selection.length)return summary;
    const Controller=this.Z.getMainWindow?.()?.AbortController||globalThis.AbortController;
    const job={controller:new Controller(),background:!!options.background};this.citationJob=job;
    const records=selection.map(item=>this.citationRecord(item)),byKey=new Map(selection.map(item=>[this.identity(item),item]));
    for(const record of records)this.entry(byKey.get(record.key)).citationPending=this.citationTools.identity(record);
    let lastPaint=0;
    const ctx={signal:job.controller.signal,email:this.contactEmail(),openalexApiKey:this.openAlexKey(),
      onProgress:progress=>{this.citationProgress=progress;options.onProgress?.(progress);},
      onResult:async result=>{
        const item=byKey.get(result.key);
        if(!this.active||job.controller.signal.aborted||!item||this.citationTools.identity(this.citationRecord(item))!==result.identity)return;
        const entry=this.entry(item);entry.citationAttempt=result;
        if(result.status==="ok")entry.citationLookup=result;
        delete entry.citationPending;summary[result.status]++;this.dirty=true;
        if(Date.now()-lastPaint>1000){lastPaint=Date.now();await this.flush();await this.refreshWindows();}
      }};
    // Zotero's app-owned delay remains alive when a main window closes.
    const timerWindow=this.Z.getMainWindow?.();
    if(typeof this.Z.Promise?.delay==='function')ctx.sleep=(ms,signal)=>new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(fn,value)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);fn(value);};
      const abort=()=>finish(reject,Object.assign(new Error('Citation lookup cancelled'),{name:'AbortError'}));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
      try{Promise.resolve(this.Z.Promise.delay(ms)).then(()=>finish(resolve),error=>finish(reject,error));}catch(error){finish(reject,error);}
    });
    else if(timerWindow)ctx.sleep=(ms,signal)=>new Promise((resolve,reject)=>{
      const abort=()=>{timerWindow.clearTimeout(timer);signal.removeEventListener("abort",abort);reject(Object.assign(new Error("Citation lookup cancelled"),{name:"AbortError"}));};
      const timer=timerWindow.setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
      signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    });
    job.promise=this.citationTools.lookupMany(records,this.citationHTTP(job.controller.signal),ctx)
      .then(()=>summary).catch(error=>{if(error.name!=="AbortError")throw error;return {...summary,cancelled:true};})
      .finally(async()=>{
        for(const item of selection)delete this.entry(item).citationPending;
        if(this.citationJob===job)this.citationJob=null;
        this.dirty=true;await this.flush();await this.refreshWindows();
      });
    return job.promise;
  }
  rebuildJournals() {
    const records = new Map(this.catalog.map(r => [this.journalTools.name(r.title), r]));
    for (const r of Object.values(this.cache.journals || {})) {
      if (!this.journalTools.valid(r)) continue;
      const key = this.journalTools.name(r.title), previous = records.get(key);
      if (!previous || (r.year || 0) >= (previous.year || 0) && r.checkedAt >= previous.checkedAt) records.set(key,r);
    }
    this.journals = this.journalTools.create([...records.values()]);
  }
  async refreshJournalMetrics(items, DOMParser) {
    const rows = new Map(), unknown = new Set();
    for (const item of items) {
      const record = this.journals.lookup(item);
      if (record) rows.set(this.journalTools.name(record.title),record);
      else unknown.add(this.journalTools.name(item.getField("publicationTitle")) || this.identity(item));
    }
    const result = {updated:0,failed:0,unknown:unknown.size}, pages = new Map();
    for (const [key,record] of rows) {
      if (!this.active) break;
      try {
        if (/\.pdf(?:[?#]|$)/i.test(record.sourceURL)) throw new Error("Official PDF snapshot requires a new catalog release");
        if (!pages.has(record.sourceURL)) pages.set(record.sourceURL,this.Z.HTTP.request("GET",record.sourceURL,{responseType:"text",timeout:10000}));
        const response = await pages.get(record.sourceURL);
        if (!this.active) break;
        const parsed = this.journalTools.parsePage(response.responseText, record, DOMParser);
        if (!parsed) throw new Error("A matching journal and explicitly dated two-year IF could not be verified");
        this.cache.journals ||= {};
        this.cache.journals[key] = {...record,...parsed,checkedAt:new Date().toISOString().slice(0,10)};
        this.dirty = true;result.updated++;
      } catch (error) { result.failed++;this.Z.logError(error); }
    }
    if (this.active) { this.rebuildJournals(); await this.flush(); await this.refreshWindows(); }
    return result;
  }
  async addReading(item, seconds, location) {
    if (!this.active || !this.isRegular(item) || !Number.isFinite(seconds) || seconds <= 0) return;
    const record = this.entry(item);
    if (!Number.isFinite(record.seconds)) record.seconds = this.metrics(item).seconds;
    record.seconds += seconds; record.unreadOverride = false; this.dirty = true;
    record.lastRead=new Date().toISOString();
    if(Number.isInteger(location?.attachmentID)&&location.attachmentID>0&&Number.isInteger(location.pageIndex)&&location.pageIndex>=0&&location.pageIndex<100000&&Number.isInteger(location.totalPages)&&location.totalPages>location.pageIndex&&location.totalPages<=100000){record.readingAttachments||={};const bucket=record.readingAttachments[String(location.attachmentID)]||={pageTimes:{},totalPages:location.totalPages};bucket.pageTimes||={};bucket.pageTimes[location.pageIndex]=(Number(bucket.pageTimes[location.pageIndex])||0)+seconds;bucket.totalPages=location.totalPages;bucket.lastRead=record.lastRead;record.readingAttachmentID=location.attachmentID;}
    this.refreshReadingDisplays();
    await this.flush();
    await this.refreshWindows();
  }
  flush() {
    const work = this.writeQueue.then(async () => {
      if (!this.dirty) return;
      const snapshot = JSON.parse(JSON.stringify(this.cache));
      this.dirty = false;
      try { await this.storage.write(snapshot); }
      catch (error) { this.dirty = true; throw error; }
    });
    this.writeQueue = work.catch(error => this.Z.logError(error));
    return work;
  }
  async refreshWindows() {
    for (const [win, state] of this.windows) {
      if (!win.closed && !state.refreshing) {
        state.refreshing = true;
        try {
          const view = win.ZoteroPane?.itemsView;
          if (view?.collectionTreeRow) await view.refreshAndMaintainSelection();
          state.workbench?.refreshReading?.();
        }
        finally { state.refreshing = false; }
      }
    }
  }
  attachMotion(win, state, {marquee=true,reading=true}={}) {
    if(marquee){state.marqueeCleanup?.(); state.marqueeCleanup = null;
    if (this.pref("marquee",true)) state.marqueeCleanup = this.marquee.attach(win, {
      delay: Math.max(0,Math.min(2000,Number(this.pref("hoverDelay",200))||0)),
      speed: Math.max(30,Math.min(600,Number(this.pref("scrollSpeed",180))||180)) });}
    if(reading){state.readingCleanup?.();state.readingCleanup=null;
    if (this.pref("recordReading",true)) state.readingCleanup = this.reading.attach(win, {
      intervalMs: this.getSetting('recordIntervalMs'),idleMs:this.getSetting('idleSeconds')*1000,
      onSession: (item,location) => { if (this.isRegular(item)) {const record=this.entry(item);record.seconds=this.metrics(item).seconds;if(Number.isInteger(location?.attachmentID)&&location.attachmentID>0){record.readingAttachments||={};record.readingAttachments[String(location.attachmentID)]||={pageTimes:{},totalPages:Number.isInteger(location.totalPages)?location.totalPages:0};record.readingAttachmentID=location.attachmentID;}} },
      onTick:(item,seconds,location)=>this.addReading(item,seconds,location), onError:error=>this.Z.logError(error) });}
  }
  addWindow(win) {
    if (!this.active || this.stopping || this.windows.has(win)) return;
    const state = { nodes:[], listeners:[], signature:null,titleNodes:new Set(),titlePositions:new Map(),titleWeights:new Map() }; this.windows.set(win,state);
    const unload = () => {this.removeWindow(win).catch(error=>this.Z.logError(error));};
    win.addEventListener("unload", unload, { once: true });
    state.listeners.push([win, "unload", unload]);
    this.attachMotion(win,state);
    state.readerCleanup=this.readerTools.attach(win);
    for(const tab of this.readerTools.tabs(win))if(tab.itemID)this.tabItems.set(tab.id,tab.itemID);
    state.workbench=this.Workbench.attach(win,{runtime:this,library:this.Library.create({Zotero:this.Z,runtime:this}),reader:this.readerTools,model:this.workspaceTools,assist:this.assist});
    const doc = win.document, popup = doc.getElementById("zotero-itemmenu");
    if (popup) {
      const make = (tag,label,parent) => { const node=doc.createXULElement(tag); if(label)node.setAttribute("label",label);parent?.appendChild(node);return node; };
      const menu=make("menu","Style Custom",popup);menu.id="style-custom-itemmenu";state.nodes.push(menu);
      const body=make("menupopup",null,menu);
      const action=(label,callback,parent=body)=>{ const node=make("menuitem",label,parent);node.addEventListener("command",()=>Promise.resolve().then(callback).catch(e=>{this.Z.logError(e);this.Z.alert(win,"Style Custom",e.message);}));return node; };
      for(const status of ["unread","reading","done"]) action(({unread:"안 읽음",reading:"읽는 중",done:"읽음"})[status],()=>this.edit(this.selected(win),{status}));
      const ratings=make("menupopup",null,make("menu","별점",body));
      for(let rating=0;rating<=5;rating++)action(rating?"★".repeat(rating):"별점 지우기",()=>this.edit(this.selected(win),{rating}),ratings);
      make("menuseparator",null,body);
      const suppl=make("menupopup",null,make("menu","보충자료 내려받기",body));
      action("선택한 파일을 보충자료로 표시",async()=>{
        const files=this.selectedAttachments(win);
        if(!files.length)throw new Error("첨부파일을 선택하세요.");
        const changed=await this.setSupplementary(files,true);
        this.Z.alert(win,"Style Custom",`${changed}개를 보충자료로 표시했습니다.`);
      },suppl);
      action("보충자료 표시 해제",async()=>{
        const files=this.selectedAttachments(win);
        if(!files.length)throw new Error("첨부파일을 선택하세요.");
        const changed=await this.setSupplementary(files,false);
        this.Z.alert(win,"Style Custom",`${changed}개의 표시를 해제했습니다.`);
      },suppl);
      make("menuseparator",null,suppl);
      for(const [label,pdfOnly] of [["PDF만",true],["모든 파일",false]])action(label,async()=>{
        const items=this.selected(win);
        if(!items.length)throw new Error("문헌을 먼저 선택하세요.");
        const result=await this.downloadSupplementary(items,{pdfOnly});
        this.Z.alert(win,"Style Custom",
          `보충자료 ${result.added}개 추가 · 이미 있음 ${result.already} · 없음 ${result.none} · 미확인 ${result["not-found"]} · 실패 ${result.error}`
          +(result.failures.length?"\n\n"+result.failures.slice(0,5).join("\n"):""));
      },suppl);
      const marks=make("menupopup",null,make("menu","색 표시",body));
      for(const colour of this.highlightColours())action(colour.label,async()=>{
        const changed=await this.setHighlight(this.selected(win),colour.key);
        if(!changed)throw new Error("문헌을 먼저 선택하세요.");
      },marks);
      make("menuseparator",null,marks);
      action("색 지우기",async()=>{await this.setHighlight(this.selected(win),null);},marks);
      action("라이브러리 저널 지표 채우기",async()=>{
        const items=this.Z.Items.getAll?this.Z.Items.getAll(win.ZoteroPane?.getSelectedLibraryID?.()||this.Z.Libraries.userLibraryID):[];
        const papers=items.filter(item=>this.isRegular(item));
        this.Z.alert(win,"Style Custom","저널 지표를 조회합니다. 저널마다 한 번만 조회하고 결과는 보관합니다.");
        const result=await this.refreshJournalCitedness(papers);
        const lines=[`저널 ${result.journals}종 중 ${result.found}종 지표 확인 · ${result.missing}종은 OpenAlex에도 없음`];
        if(result.failed) lines.push(`${result.failed}종 조회 실패`);
        if(result.budgetGone) lines.push(`OpenAlex 하루 한도를 다 썼습니다. ${result.remaining}종이 남았고, 한도는 UTC 자정에 초기화됩니다.\n지금까지 받은 값은 저장됐으니 내일 다시 실행하면 남은 것부터 이어서 채웁니다.`);
        else lines.push("공식 JIF가 있는 저널은 그대로 두고, 없는 저널만 ~추정치로 채웁니다.");
        this.Z.alert(win,"Style Custom",lines.join("\n"));
      });
      action("읽기 기록 가져오기 (이전 플러그인 노트에서)",async()=>{
        const preview=await this.importLegacyReading({dryRun:true});
        if(!preview.imported){this.Z.alert(win,"Style Custom",`가져올 읽기 기록이 없습니다. (노트 ${preview.notes}개 · 이미 보유 ${preview.skipped}개 · 대상 불명 ${preview.unresolved}개)`);return;}
        const hours=(preview.seconds/3600).toFixed(1);
        const result=await this.importLegacyReading();
        this.Z.alert(win,"Style Custom",`읽기 기록 ${result.imported}편 · ${hours}시간을 가져왔습니다.\n이미 더 많이 기록된 ${result.skipped}편은 그대로 두었습니다.`+(result.unresolved?`\n대상 문헌을 찾지 못한 노트 ${result.unresolved}개`:""));
      });
      action("제목 앞 별 태그 정리",async()=>{
        const found=this.starTagItems(win.ZoteroPane?.getSelectedLibraryID?.());
        if(!found.length){this.Z.alert(win,"Style Custom","정리할 별 태그가 없습니다.");return;}
        const {moved,skipped}=await this.migrateStarTags(found);
        this.Z.alert(win,"Style Custom",`${moved}개 항목의 별 태그를 정리했습니다. 평점은 그대로 유지됩니다.`+(skipped?` · 편집할 수 없어 건너뜀 ${skipped}개`:""));
      });
      action("평점 태그를 Extra로 옮기기",async()=>{
        const found=this.visibleRatingTagItems(win.ZoteroPane?.getSelectedLibraryID?.());
        if(!found.length){this.Z.alert(win,"Style Custom","태그로 남은 평점이 없습니다.");return;}
        const {fixed,skipped}=await this.hideRatingTags(found);
        this.Z.alert(win,"Style Custom",`${fixed}개 항목의 평점을 Extra의 "Rating: N"으로 옮기고 태그를 지웠습니다. 별점은 그대로입니다.`+(skipped?` · 편집할 수 없어 건너뜀 ${skipped}개`:"")+"\nExtra는 동기화되고 직접 고칠 수 있으며, 태그 목록에는 나타나지 않습니다.");
      });
      action("인용…",()=>this.citationPanel(win,this.selected(win)));
      action("커스텀 열로 전환",()=>this.useColumns(win));
      action("연구 작업 패널",()=>state.workbench?.toggle(true));
      action("그래프 · 태그 · 노트 · 주석",()=>state.workbench?.show('explore'));
      action("저장된 지표와 읽기 기록 새로고침",async()=>{state.signature=null;await this.refreshWindows();await this.flush();});
      action("선택한 문헌 인용 수 새로고침",async()=>{
        const result=await this.refreshCitations(this.selected(win),{force:true});
        this.Z.alert(win,"Style Custom",`인용 수 확인 ${result.ok}개 · 미확인 ${result["not-found"]}개 · 식별자 부족 ${result.unsupported}개 · 조회 오류 ${result.error}개${result.cancelled?" · 중지됨":""}`);
      });
      action("인용 수 조회 중지",()=>this.citationJob?.controller.abort());
      action("빈 칸 채우기 (철회 신호 · 저널 지표 · 새 논문)",async()=>{
        if(this.backfilling){this.stopBackfill();this.Z.alert(win,"Style Custom","채우기를 중지했습니다. 지금까지 받은 값은 저장했습니다.");return;}
        const report=await this.runBackfill({libraryID:win.ZoteroPane?.getSelectedLibraryID?.(),
          onProgress:({stage,done,total})=>this.showBackfillProgress(win,stage,done,total)});
        this.Z.alert(win,"Style Custom",this.backfillSummary(report));
      });
      action("선택한 문헌 철회·공개접근 신호 조회",async()=>{
        const result=await this.refreshPaperSignals(this.selected(win));
        this.Z.alert(win,"Style Custom",`신호 확인 ${result.ok}개 · 미확인 ${result["not-found"]}개 · DOI 없음 ${result.unsupported}개 · 조회 오류 ${result.error}개`);
      });
      action("현재 라이브러리 인용 수 조회·메타데이터 저장",()=>this.syncLibraryCitations(win.ZoteroPane.getSelectedLibraryID?.()||this.Z.Libraries.userLibraryID));
      action("선택한 저널 IF를 공식 페이지에서 새로고침",async()=>{
        const result = await this.refreshJournalMetrics(this.selected(win), win.DOMParser);
        this.Z.alert(win,"Style Custom",`IF 확인 ${result.updated}개 · 조회 실패 ${result.failed}개 · 미등록 저널 ${result.unknown}개. 기존 확인된 값은 유지됩니다.`);
      });
    }
    const poll = async () => {
      if (!this.active || win.closed || state.polling) return;
      state.polling = true;
      try {
        const view=win.ZoteroPane?.itemsView;
        const rows=[...doc.querySelectorAll("#zotero-items-tree .row")];
        const records=rows.map(row=>view?.getRow(Number(row.id.match(/-row-(\d+)$/)?.[1]))?.ref).filter(item=>this.isRegular(item));
        const signature=JSON.stringify(records.map(item=>[this.identity(item),this.state(item)]));
        if(state.signature!==null && signature!==state.signature) await view?.refreshAndMaintainSelection();
        state.signature=signature;this.enhanceTitles(win,state,records); await this.flush();
        if(this.featureEnabled("citedCountColumn")&&this.pref("autoCitations",true)&&!this.citationJob&&!this.stopping) {
          this.refreshCitations(records,{background:true}).catch(error=>this.Z.logError(error));
        }
      } catch(error){this.Z.logError(error);} finally{state.polling=false;}
    };
    state.timer=win.setInterval(poll,5000); poll();
    const quickFilter=event=>{if(!this.featureEnabled('itemTypeFilter')||!this.pref('quickTypeFilter',true)||event.button!==0||!event.target.closest?.('.cell-icon'))return;const row=event.target.closest('.row');if(!row)return;const item=win.ZoteroPane?.itemsView?.getRow(Number(row.id.match(/-row-(\d+)$/)?.[1]))?.ref;if(!this.isRegular(item)||!state.workbench)return;event.preventDefault();event.stopPropagation();state.workbench.state.type=this.Z.ItemTypes.getName(item.itemTypeID);state.workbench.show('explore').catch(e=>this.Z.logError(e));};
    const tree=doc.getElementById('zotero-items-tree');if(tree){tree.addEventListener('click',quickFilter,true);state.listeners.push([tree,'click',quickFilter,true]);}
    const css=this.pref('panelCSS','');if(css)try{this.setPanelCSS(css);}catch(error){this.Z.logError(error);}
  }
  async useColumns(win) {
    const manager=win.ZoteroPane?.itemsView?.tree?._columns;
    if (!manager?.toggleHidden || !Array.isArray(manager._columns)) throw new Error("Column layout unavailable; right-click a column heading to select Custom columns.");
    for(let i=0;i<manager._columns.length;i++) {
      const column=manager._columns[i], key=column.dataKey;
      const old=/^zoterostyle-(IF|citedCount|status|rating|readTime|tags|textTags)$/.test(key);
      const own=this.columns.includes(key);
      if ((old&&!column.hidden)||(own&&column.hidden)) manager.toggleHidden(i);
    }
    await win.ZoteroPane.itemsView.refreshAndMaintainSelection();
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
            // The rating moves to Extra in the same write that drops its tag,
            // so the two can never disagree and no rating exists in neither.
            if (Object.prototype.hasOwnProperty.call(change, 'rating')) {
              const before = String(item.getField('extra') || '');
              const after = this.model.updateExtra(before, {rating: change.rating});
              if (after !== before) item.setField('extra', after);
            }
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
    const completed = work.then(async () => {
      if (change.status) for (const item of selection) this.entry(item).unreadOverride = change.status === "unread";
      this.dirty = true;
      await this.flush();
      await this.refreshWindows();
    });
    this.queue = completed.catch(() => {});
    return completed;
  }

  async removeWindow(win) {
    const state=this.windows.get(win);if(!state)return;
    this.windows.delete(win);
    const errors=[],pending=[];
    const cleanup=fn=>{try{pending.push(Promise.resolve(fn()).catch(error=>errors.push(error)));}catch(error){errors.push(error);}};
    cleanup(()=>win.clearInterval(state.timer));cleanup(()=>state.marqueeCleanup?.());
    cleanup(()=>state.workbench?.destroy());cleanup(()=>state.readerCleanup?.());
    for(const node of state.titleNodes||[])cleanup(()=>node.remove());
    for(const[cell,position]of state.titlePositions||[])cleanup(()=>{if(cell.style.position==='relative'){if(position)cell.style.position=position;else cell.style.removeProperty('position');}});
    for(const[node,weight]of state.titleWeights||[])cleanup(()=>{if(node.style.fontWeight==='700')node.style.fontWeight=weight;});
    for(const[target,name,callback,capture]of state.listeners||[])cleanup(()=>target.removeEventListener(name,callback,capture||false));
    for(const node of state.nodes||[])cleanup(()=>node.remove());
    cleanup(()=>state.readingCleanup?.());
    await Promise.all(pending);
    if(errors.length)throw errors[0];
  }
  async stop() {
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;
    this.stopPromise=(async()=>{
      const errors=[];
      const attempt=async fn=>{try{await fn();}catch(error){errors.push(error);}};
      await attempt(()=>this.assist.stop());await attempt(()=>this.readerTools.stop());
      if(this.itemObserver!=null){const observer=this.itemObserver;this.itemObserver=null;await attempt(()=>this.Z.Notifier.unregisterObserver(observer));}
      if(this.metadataTimer!=null){const timer=this.metadataTimer;this.metadataTimer=null;await attempt(()=>this.metadataTimerWindow.clearTimeout(timer));}
      this.metadataIDs.clear();
      const citationJob=this.citationJob;await attempt(()=>citationJob?.controller.abort());
      // Detach clocks and UI immediately, then drain already accepted writes.
      await Promise.all([...this.windows.keys()].map(win=>attempt(()=>this.removeWindow(win))));
      await attempt(()=>citationJob?.promise);await attempt(()=>this.bulkCitationPromise);
      await attempt(()=>this.metadataQueue);await attempt(()=>this.activityQueue);
      this.active=false;
      await attempt(()=>this.queue);await attempt(()=>this.flush());
      for(const observer of this.observers.splice(0))await attempt(()=>this.Z.Prefs.unregisterObserver(observer));
      for(const column of this.columns.splice(0))await attempt(()=>this.Z.ItemTreeManager.unregisterColumn(column));
      if(this.prefPane){const pane=this.prefPane;this.prefPane=null;await attempt(()=>this.Z.PreferencePanes.unregister(pane));}
      this.tabItems.clear();
      if(errors.length){for(const error of errors.slice(1))this.Z.logError(error);throw errors[0];}
    })();
    return this.stopPromise;
  }

};
if(typeof module!=="undefined")module.exports=CustomStyleRuntime;
