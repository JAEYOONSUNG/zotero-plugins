/* global module */
"use strict";
var CustomStyleRuntime = class CustomStyleRuntime {
  // What OpenAlex files that is not a paper: repository deposits, datasets, reviews of reviews.
  static NOT_A_PAPER = /^(dataset|other|paratext|peer-review|grant|libguides|supplementary-materials)$/i;
  constructor({ Zotero, model, marquee, reading, storage, legacy = {}, catalog = [], citations, io, paths }) {
    Object.assign(this, { Z: Zotero, model, marquee, reading, storage, legacy, io, paths });
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
    this.attentionTools = typeof CustomStyleAttention !== "undefined" ? CustomStyleAttention : require("./attention.js");
    this.legacyReading = typeof CustomStyleLegacyReading !== "undefined" ? CustomStyleLegacyReading : require("./legacy-reading.js");
    this.journalTools2 = typeof CustomStyleJournalMetrics !== "undefined" ? CustomStyleJournalMetrics : require("./journal-metrics.js");
    this.portraitTools = typeof CustomStyleAuthorPortrait !== "undefined" ? CustomStyleAuthorPortrait : require("./author-portrait.js");
    this.fileTools = typeof CustomStyleAttachmentKinds !== "undefined" ? CustomStyleAttachmentKinds : require("./attachment-kinds.js");
    this.itemKinds = typeof CustomStyleItemKinds !== "undefined" ? CustomStyleItemKinds : require("./item-kinds.js");
    this.patentTools = typeof CustomStylePatents !== "undefined" ? CustomStylePatents : require("./patents.js");
    this.journalIdentity = typeof CustomStyleJournalIdentity !== "undefined" ? CustomStyleJournalIdentity : require("./journal-identity.js");
    this.affiliationTools = typeof CustomStyleAffiliations !== "undefined" ? CustomStyleAffiliations : require("./affiliations.js");
    this.graphTools = typeof CustomStylePaperGraph !== "undefined" ? CustomStylePaperGraph : require("./paper-graph.js");
    this.itemCells = typeof CustomStyleItemCells !== "undefined" ? CustomStyleItemCells : require("./item-cells.js");
    this.pathTools = typeof CustomStyleReadingPath !== "undefined" ? CustomStyleReadingPath : require("./reading-path.js");
    // Held in memory only: a lookup is cheap to repeat and must not go stale on disk.
    this.discoverCache = new Map();
    // Portrait records older than this were made by the ORCID-homepage-only
    // search; their misses are asked again once, with Wikidata.
    this.PORTRAIT_VERSION = 3;
    this.DISCOVER_CACHE_LIMIT = 60;
    // Raised whenever the reading-order algorithm or the stored plan's shape
    // changes: a plan kept by an older version is asked again.
    this.PATH_VERSION = 6;
    this.citationJob = null;
    this.citationProgress = null;
    this.metadataIDs = new Set();
    this.metadataQueue = Promise.resolve();
    this.activityQueue=Promise.resolve();this.tabItems=new Map();
    this.i18n=typeof CustomStyleI18N!=='undefined'?CustomStyleI18N:require('./i18n.js');
    try{this.i18n.load((typeof CustomStyleStrings!=='undefined'?CustomStyleStrings:require('./strings.js')).en);}catch(error){}
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
    // Listening, a summary, a chat and a translation inside the reader. Idle until a reader opens the panel.
    const ReaderAssist=typeof CustomStyleReaderAssist!=="undefined"?CustomStyleReaderAssist:require("./reader-assist.js");
    this.readerAssist=ReaderAssist.create({Zotero:this.Z,runtime:this});
  }
  // English unless the chosen language is Korean (the setting, not the OS).
  text(english, korean) { return this.i18n ? (this.i18n.isKorean() ? korean : english) : english; }
  pref(name, fallback) { return this.Z.Prefs.get("extensions.style-custom." + name, true) ?? fallback; }
  isRegular(item) { return !!item?.isRegularItem?.() && !item.isFeedItem && !item.deleted; }
  canEdit(item) {
    if(!this.isRegular(item))return false;
    const library = this.Z.Libraries.get(item.libraryID);
    return this.isRegular(item) && item.isEditable() && !!library?.editable && library.libraryType !== "feed";
  }
  identity(item) { return `${item.libraryID}:${item.key}`; }
  entry(item) { const id = this.identity(item); if (!this.memoChecked?.has(id) && typeof item?.getNotes === 'function') { try { this.adoptMemoNote(item); } catch (_) {} } return this.cache.items[id] ||= {}; }
  /* Rows for papers that are no longer in any library. Deleting a paper left
     its reading time, ratings and citation counts in the store, where they were
     re-read and re-written on every save. Run once per start, never during one. */
  async pruneDeletedItems() {
    const store = this.cache.items;
    if (!store || typeof store !== 'object') return 0;
    const works = this.paperWorks();
    const keys = Object.keys(store), workKeys = Object.keys(works);
    if (keys.length + workKeys.length < 200) return 0;
    const alive = new Set();
    for (const library of this.Z.Libraries?.getAll?.() || []) {
      // A trashed paper is not alive even if a listing still hands it back.
      for (const item of await this.libraryItems(library.libraryID) || []) if (!item?.deleted) alive.add(this.identity(item));
    }
    if (!alive.size) return 0;
    /* A trashed preprint that was merged into its published version is "gone" to
       the library sweep but its undo ledger still points at it: its row stays
       until the merge is undone or the ledger is cleared. */
    const ledgered = new Set();
    for (const rec of Object.values(this.mergeLedger())) {
      if (rec?.preprintKey) ledgered.add(rec.preprintKey);
      else { try { const gone = this.Z.Items.get(Number(rec?.preprint)); if (gone) ledgered.add(this.identity(gone)); } catch (_) {} }
    }
    let removed = 0;
    // The works store (citation lists, authors) is keyed the same way; 11 trashed papers left rows there
    // that the sweeps and the self-check counted as papers (1,214 against 1,204 live).
    for (const key of keys) if (!alive.has(key) && !ledgered.has(key)) { delete store[key]; removed++; }
    for (const key of workKeys) if (!alive.has(key) && !ledgered.has(key)) { delete works[key]; removed++; }
    if (removed) { this.dirty = true; this.scheduleFlush(5000); }
    return removed;
  }
  // Zotero.Items.getAll returns a Promise. Six call sites iterated it directly,
  // which throws, so every library-wide sweep in this plugin failed on the first
  // line and no unit test could see it: the fixture handed back a plain array.
  // Confirmed by the in-Zotero self-check on the user's own library.
  async libraryItems(libraryID) {
    const id = libraryID ?? this.Z.Libraries.userLibraryID;
    if (!this.Z.Items?.getAll) return [];
    const found = await this.Z.Items.getAll(id);
    return Array.isArray(found) ? found : [];
  }
  // One place to ask for a string, so nothing has to reach for the module.
  t(value) { return this.i18n ? this.i18n.t(value) : value; }
  // Every message a menu action reports, in the chosen language. It goes to
  // the panel's status line (the panel opens if it was closed), never to a
  // modal Zotero.alert: the reader is working in Zotero and a pop-up stops
  // them. Multi-line messages are translated a line at a time so a report of
  // figures reads; the status line joins them and keeps the full text as a tooltip.
  say(win, message, {error = false} = {}) {
    const lines = String(message == null ? '' : message).split('\n').map(line => this.t(line)).filter(Boolean);
    const target = [this.windows.get(win), ...[...this.windows.values()].filter(s => !s?.workbench?.panel?.ownerDocument?.defaultView?.closed)]
      .find(state => state?.workbench?.notify);
    try {
      if (target) return Promise.resolve(target.workbench.notify(lines.join(' · '), {error, full: lines.join('\n')}));
    } catch (e) { this.Z.logError?.(e); }
    this.Z.debug?.('Style Custom: ' + lines.join(' | '));
    return Promise.resolve();
  }

  // Which language the panel speaks. English is the default: a preference
  // never set, empty or unknown gives English. `auto` follows Zotero's own
  // locale, and 'ko-KR' is Korean; people who chose either keep it.
  applyLocale() {
    if (!this.i18n) return 'en-US';
    let choice = 'en-US';
    try { choice = this.pref('language', 'en-US'); } catch (error) { }
    return this.i18n.use(choice, this.Z);
  }

  featureEnabled(id) { return this.pref('feature.'+id,true)!==false; }
  // The schema is a list of 117 entries and this walked it on every lookup.
  // The read-time column calls it for every cell, so a viewport scanned it
  // thousands of times a frame to find the same row.
  settingDefinition(key) {
    if (!this.settingIndex) {
      this.settingIndex = new Map((this.settingsSchema?.settings || []).map(row => [row.key, row]));
    }
    return this.settingIndex.get(key);
  }
  getSetting(key) {
    const definition=this.settingDefinition(key);if(!definition)throw new Error('Unknown setting: '+key);
    // A note is read, never written: its text is what the runtime found, not a
    // stored preference, so it never reaches the preference store or validate().
    if(definition.type==='note')return key==='updateStatus'?this.updateSummary():this.journalFigureSummary();
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
    // Anything remembered from a preference is dropped the moment one is set.
    this.timeFormatMemo = null;
    this.bumpState();
    this.settingWriteDepth=(this.settingWriteDepth||0)+1;
    try{if(key==='customFields')this.setCustomFields(value);else if(key==='panelCSS')this.setPanelCSS(value);else this.Z.Prefs.set('extensions.style-custom.'+key,value,true);}finally{this.settingWriteDepth--; }
    // After the write: read before it, the language applied was the one being replaced.
    if (key === 'language') { this.applyLocale(); this.timeFormatMemo = null; this.bumpState(); this.relabelColumns(); this.rebuildMenus(); }
    if(key==='workbenchDensity'){this.cache.workbenchUI={...(this.cache.workbenchUI||{}),density:value};this.dirty=true;}
    if(apply)await this.applySettings([key]);return this.getSetting(key);
  }
  async resetSettings(category) {
    if(!this.settingsSchema.categories.some(row=>row.id===category))throw new Error('Unknown category');
    // What the reader typed -- a server address, a model name, an email, CSS -- is kept, as keys are: a reset brings back defaults, not blanks.
    const rows=this.settingsSchema.settings.filter(row=>row.category===category&&row.type!=='action'&&row.type!=='note'&&!row.secret&&!row.keepOnReset);
    for(const row of rows)await this.setSetting(row.key,row.default,{apply:false});
    await this.applySettings(rows.map(row=>row.key));return {reset:rows.length,secretsPreserved:true,kept:this.settingsSchema.settings.filter(row=>row.category===category&&row.keepOnReset).map(row=>row.key)};
  }
  async applySettings(keys=[]) {
    if(!this.active||this.stopping)return;
    this.syncFeatureColumns();
    if(keys.includes('feature.styleEditor'))this.setPanelCSS(this.pref('panelCSS',''));
    if(!this.featureEnabled('citedCountColumn'))this.citationJob?.controller.abort();
    for(const [win,state]of this.windows){
      if(win.closed)continue;
      this.timeFormatMemo = null; this.bumpState();
      if(keys.some(key=>['recordReading','recordIntervalMs','idleSeconds'].includes(key)))this.attachMotion(win,state,{marquee:false,reading:true});
      if(keys.includes('hoverColumn'))this.attachCells(win,state);
      if(keys.some(key=>['marquee','hoverDelay','scrollSpeed'].includes(key)))this.attachMotion(win,state,{marquee:true,reading:false});
      if(keys.some(key=>key.startsWith('reader')||key.startsWith('margin')||key.startsWith('feature.')||key==='verticalTabs'))await this.readerTools.applyPreferences?.(win);
      state.signature=null;await state.workbench?.applyPreferences?.();
    }
    await this.flush();await this.refreshWindows();
  }
  async runSettingAction(action) {
    // Revealing a folder is the one action with nothing to do with the library
    // window, so it is answered before one is demanded.
    if(action==='journalFolder')return this.revealJournalFolder();
    const win=this.Z.getMainWindow?.();if(!win)throw new Error('Zotero 문헌 창을 열어 주세요.');
    const selected=this.selected(win);
    if(action==='workbench')return this.openWorkbench(win);
    if(action==='columns')return this.useColumns(win);
    if(action==='cancelCitations'){this.citationJob?.controller.abort();return;}
    if(action==='updates')return this.checkUpdatesNow();
    if(!selected.length)throw new Error('문헌 목록에서 대상 문헌을 선택하세요.');
    if(action==='citations')return this.refreshCitations(selected,{force:true});
    if(action==='journals')return this.refreshJournalMetrics(selected,win.DOMParser);
    if(action==='ranks')return this.refreshPublicationRanks(selected);
    throw new Error('Unknown action');
  }
  /* Journal figures arrive in two layers. The archive carries only what may be
     passed on: OpenAlex, which is CC0. Figures an institution licenses to a
     reader -- a Journal Citation Reports export -- are never packaged and never
     published; they are read from a folder in the Zotero data directory and win
     wherever they exist. bootstrap.js records which layer each table came from;
     this is how the reader is told, and how the self-check reports it. */
  journalFigureLayers() {
    const layers=this.journalLayers||{};
    const table=(file,count)=>({file,layer:layers[file]||null,count:Number.isFinite(count)?count:0});
    return {
      dir:this.journalDir||'',
      tables:[
        table('if-catalog.json',Array.isArray(this.catalog)?this.catalog.length:0),
        table('journal-registry.json',this.journalIdentity?._registrySize?.()||0),
        table('jcr-categories.json',this.jcrCatalog?.journals?.length||0)
      ]
    };
  }
  journalFigureSummary() {
    const {dir,tables}=this.journalFigureLayers();
    const word=layer=>this.t(layer==='local'?'내 폴더':layer==='shipped'?'배포본':'읽지 않음');
    const parts=tables.map(row=>row.file+' '+word(row.layer));
    parts.push(this.t('폴더 {0}').replace('{0}',dir||this.t('읽지 않음')));
    return parts.join(' · ');
  }
  // Reveals the folder in the file manager, which is outside Zotero: the button
  // that calls this carries data-opens so no sweep presses it.
  async revealJournalFolder() {
    const dir=this.journalDir;
    if(!dir)throw new Error('지표 폴더 위치를 읽지 못했습니다. Zotero를 다시 시작하세요.');
    try{await this.io?.makeDirectory?.(dir,{ignoreExisting:true,createAncestors:true});}catch(error){this.Z.debug?.('Style Custom: '+(error&&error.message));}
    if(typeof this.Z.File?.reveal==='function')await this.Z.File.reveal(dir);
    else if(typeof this.Z.launchFile==='function')this.Z.launchFile(dir);
    else if(typeof this.Z.launchURL==='function')this.Z.launchURL('file://'+dir);
    else throw new Error('이 Zotero에서는 폴더를 열 수 없습니다. 파일 관리자에서 직접 여세요.');
    return this.t('파일 관리자에서 폴더를 열었습니다.');
  }
  /* The feed named in the manifest, read through Zotero's add-on manager so
     the new file is verified against its hash and swapped in without a
     restart. Every decision lives in updater.js, where it is tested. */
  async createUpdater() {
    const Updater = globalThis.PluginUpdater;
    if (!Updater || !this.id || !this.rootURI) return null;
    const manifest = await this.Z.HTTP.request('GET', this.rootURI + 'manifest.json', { responseType: 'json' });
    const updateURL = manifest?.response?.applications?.zotero?.update_url;
    if (!/^https:\/\//.test(String(updateURL || ''))) return null;
    return Updater.create({
      id: this.id, version: this.version, updateURL, appVersion: this.Z.version,
      request: async url => (await this.Z.HTTP.request('GET', url, { responseType: 'json', timeout: 20000, errorDelayMax: 0 })).response,
      install: entry => this.installAddon(entry),
      compare: (a, b) => globalThis.Services?.vc ? globalThis.Services.vc.compare(a, b) : Updater.compareVersions(a, b),
      prefs: { get: name => this.pref(name, undefined), set: (name, value) => this.Z.Prefs.set('extensions.style-custom.' + name, value, true) },
      busy: () => !!this.citationJob || this.settingWriteDepth > 0,
      log: message => this.Z.debug('Style Custom: ' + message)
    });
  }
  async installAddon(entry) {
    const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const install = await AddonManager.getInstallForURL(entry.update_link, { hash: entry.update_hash, name: 'Style Custom', version: entry.version });
    await new Promise((resolve, reject) => {
      const fail = what => () => reject(new Error(what + (install.error ? ' (' + install.error + ')' : '')));
      install.addListener({ onInstallEnded: () => resolve(), onInstallFailed: fail('install failed'), onDownloadFailed: fail('download failed'),
        onInstallCancelled: fail('install cancelled'), onDownloadCancelled: fail('download cancelled') });
      install.install();
    });
  }
  async checkUpdatesNow() {
    if (!this.updater) throw new Error('이 설치본에는 업데이트 주소가 없습니다. GitHub 배포 목록에서 받은 파일로 다시 설치하세요.');
    const result = await this.updater.run({ reason: 'user', force: true });
    if (result.status === 'error') throw new Error(this.t('새 버전을 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요. ({0})').replace('{0}', result.message));
    if (result.status === 'installed') return this.t('{0} 버전을 설치했습니다. 새 버전은 바로 적용됩니다.').replace('{0}', result.entry.version);
    return this.t('최신 버전입니다 ({0}).').replace('{0}', this.version || '');
  }
  /* The daily check wrote its result and nothing read it: a feed that kept
     failing looked exactly like being up to date. */
  updateSummary() {
    const last = this.updater?.lastResult?.();
    if (!last) return this.t('아직 확인하지 않았습니다.');
    const when = this.localStamp(last.at);
    const at = when ? this.formatStamp(when) : '';
    const said = {installed: this.t(`${last.latest || ''} 설치함`), current: this.t('최신'), available: this.t(`${last.latest || ''} 있음`), off: this.t('자동 설치 꺼짐'), deferred: this.t('사용 중이라 다음에 설치'), error: this.t(`실패 · ${last.message || ''}`)}[last.status] || String(last.status || '');
    return `${at} · ${said}`;
  }
  getSettingsStatus() {
    const win=this.Z.getMainWindow?.(),selected=win?this.selected(win):[];const reader=win?.Zotero_Tabs&&this.Z.Reader?.getByTabID?.(win.Zotero_Tabs.selectedID),attachment=reader&&this.Z.Items.get(reader.itemID),item=(attachment?.parentID&&this.Z.Items.get(attachment.parentID))||selected[0];
    return {version:this.version||'',recordReading:this.getSetting('recordReading'),selectedTitle:item?String(item.getField('title')||''):'선택한 문헌 없음',readSeconds:item?this.state(item).seconds:0,citationStatus:this.citationJob?'조회 중':'대기',storagePath:this.Z.DataDirectory?.dir?this.Z.DataDirectory.dir+'/style-custom.json':'Zotero 데이터 폴더/style-custom.json'};
  }
  columnFeature(key) {
    return {if:'IFColumn',oaCitedness:'IFColumn',citations:'citedCountColumn',status:'statusColumn',rating:'ratingColumn',time:'readTimeColumn',tags:'tagsColumn',progress:'readTimeColumn',remark:'remarkColumn',publication:'publicationTagsColumn',authors:'creatorColumn',added:'dateAddedColumn',modified:'dateAddedColumn',lastRead:'Recent',tagCount:'textTagsColumn',summary:'tldr',annotationCount:'annotationColumn',noteCount:'renderItemNotes',venue:'publicationColumn',collections:'collectionsColumn'}[key];
  }
  /* What is registered for one of the plugin's columns. Kept in one place so a change of
     language can register the same column again under its new title. */
  columnOptions(dataKey,label,width) {
    return {pluginID:this.id,dataKey,label:this.t(label),width,minWidth:['if','oaCitedness'].includes(dataKey)?56:50,enabledTreeIDs:['main'],hidden:!['journalMark','if','citations','status','rating','time','more'].includes(dataKey),...(dataKey==='more'?{fixedWidth:true,noPadding:true,minWidth:28}:{}),zoteroPersist:['width','hidden','sortDirection','ordinal'],dataProvider:item=>this.isRegular(item)?this.value(dataKey,item):(['if','oaCitedness','citations','time','progress'].includes(dataKey)?this.sortKey(''):''),renderCell:(index,value,column,first,doc)=>this.renderCell(dataKey,index,value,column,doc)};
  }
  /* Item-tree column titles are fixed when a column is registered, and Zotero has no call to
     change one. After a language change each is registered again, immediately (so the tree
     never sees a gap), with the same options; width, order, visibility and sort direction are
     persisted by Zotero under the column's key (zoteroPersist), which does not change. */
  relabelColumns() {
    const manager=this.Z.ItemTreeManager;
    if(!manager||!this.featureColumns)return 0;
    let done=0;
    for(const [dataKey,label,width]of this.columnDefinitions||[]){
      const existing=this.featureColumns.get(dataKey);
      if(!existing)continue;
      try{
        manager.unregisterColumn(existing);
        const key=manager.registerColumn(this.columnOptions(dataKey,label,width));
        if(!key)throw new Error('Could not register Custom column: '+dataKey);
        this.columns=this.columns.map(entry=>entry===existing?key:entry);
        this.featureColumns.set(dataKey,key);done++;
      }catch(error){this.Z.logError(error);}
    }
    try{manager.refreshColumns?.();}catch(error){this.Z.logError(error);}
    return done;
  }
  syncFeatureColumns() {
    this.featureColumns||=new Map();
    for(const [dataKey,label,width]of this.columnDefinitions||[]){
      const feature=this.columnFeature(dataKey),existing=this.featureColumns.get(dataKey);
      if(feature&&!this.featureEnabled(feature)){
        if(existing){this.Z.ItemTreeManager.unregisterColumn(existing);this.columns=this.columns.filter(key=>key!==existing);this.featureColumns.delete(dataKey);}continue;
      }
      if(existing)continue;
      const key=this.Z.ItemTreeManager.registerColumn(this.columnOptions(dataKey,label,width));
      if(!key)throw new Error('Could not register Custom column: '+dataKey);this.columns.push(key);this.featureColumns.set(dataKey,key);
    }
  }
  /* A stored time as a Date: Zotero's "YYYY-MM-DD HH:MM:SS" is UTC with no
     zone written, and the plugin's own ISO strings carry theirs. */
  localStamp(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const utc = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? text.replace(' ', 'T') + 'Z' : text;
    const time = Date.parse(utc);
    return Number.isFinite(time) ? new Date(time) : null;
  }
  formatStamp(date) {
    const two = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  formatReadTime(seconds, options) {
    // Both settings are read for every cell in the column. They are preferences,
    // so they change when a preference changes and not once per row; the memo
    // is dropped whenever one is set.
    if (!this.timeFormatMemo) {
      this.timeFormatMemo = {zero: this.getSetting('showZeroReadTime'), format: this.getSetting('timeFormat')};
    }
    const {zero, format} = this.timeFormatMemo;
    const value=Math.max(0,Math.floor(Number(seconds)||0));if(!value&&!zero)return '';
    if(format==='seconds')return value+this.t('초');
    const h=Math.floor(value/3600),m=Math.floor(value%3600/60),s=value%60;
    if(format==='clock')return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':');
    /* The panel's own wording (options.compact): the two largest units only, and never a unit that is zero --
       "39h 52m", "20m", "40s" -- so a figure fits its tile instead of wrapping as "39h 52m 40s". The items-tree
       column keeps the exact one, because it ticks while a paper is open. */
    if(options&&options.compact)return h?(m?`${h}h ${m}m`:`${h}h`):m?`${m}m`:`${s}s`;
    return h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;
  }
  /* One reading tick changes one paper. Every tick used to repaint every
     reading cell in the list, recomputing each row's state and the palette
     per cell; now only that paper's cells, with the palette once per window.
     The status cell is drawn as renderCell draws it -- this path used to put
     the stored English word ("reading") back into a Korean list. */
  refreshReadingDisplays(itemID) {
    const only = itemID != null ? `[data-item-id="${String(itemID).replace(/[^\w-]/g, '')}"]` : '';
    for(const [win,state]of this.windows){if(win.closed)continue;
      const cells=win.document.querySelectorAll?.('[data-style-custom-reading]'+only)||[];
      if(cells.length){const P=this.palette(win.document);
      for(const cell of cells){const item=this.Z.Items?.get(Number(cell.dataset.itemId));if(!this.isRegular(item))continue;const value=this.state(item);
        if(cell.dataset.styleCustomReading==='time'){cell.textContent=this.formatReadTime(value.seconds);cell.style.color=value.seconds<=0?P.faint:P.text;cell.style.fontWeight=value.seconds>=3600?'590':'';}
        else if(cell.firstChild&&cell.lastChild){const own=this.statusTone(item,value.status,P),tone=own?own.mark:({unread:P.muted,reading:P.reading,done:P.done}[value.status]||P.muted);cell.firstChild.textContent={unread:'\u25cb',reading:'\u25d0',done:'\u25cf'}[value.status]||'\u25cb';cell.firstChild.style.color=tone;cell.lastChild.textContent=value.status==='unread'?'':this.t({reading:'읽는 중',done:'완료'}[value.status]||'');cell.lastChild.style.color=value.status==='unread'?P.muted:own?own.ink:tone;cell.lastChild.style.fontWeight=value.status==='unread'?'400':'590';}}}
      state.workbench?.refreshMetrics?.(itemID);
    }
  }
  async start({ id, version, rootURI }) {
    this.id = id; this.version=version; this.rootURI = rootURI;
    const loaded = await this.storage.read();
    if (!loaded || loaded.schema !== 1 || !loaded.items || typeof loaded.items !== "object" || Array.isArray(loaded.items)) {
      throw new Error("Style Custom cache has an unsupported format; existing file was preserved");
    }
    this.cache = loaded; this.active = true;
    this.retireLooseMoves();
    try { this.dedupeStoredNews(); this.reclassifyStoredNews(); } catch (error) { this.Z.logError?.(error); }
    try { this.dedupePaperPeople(); } catch (error) { this.Z.logError?.(error); }
    try { if (this.recheckStoredLinks()) this.dirty = true; } catch (error) { this.Z.logError?.(error); }
    for (const entry of Object.values(loaded.items)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Style Custom item cache");
      if (entry.citationPending) { delete entry.citationPending; this.dirty=true; }
      // A promotion is in flight only while the process lives; an older build wrote this flag to disk.
      if ('promoting' in entry) { delete entry.promoting; this.dirty=true; }
    }
    this.applyLocale();
    this.rebuildJournals();
    this.labels = { unread: "unread", reading: "reading", done: "done" };
    this.columnDefinitions = [["journalMark","저널","110"], ["if","IF","90"], ["citations","피인용","120"],
      ["status","상태","100"], ["rating","별점","100"],
      ["time","읽은 시간","120"], ["tags","태그","140"],
      ["files","파일","110"],
      ["progress","쪽","100"],["remark","메모","180"],
      ["publication","저널 태그","160"],["authors","작성자","160"],
      ["added","추가일","130"],["modified","수정일","130"],
      ["lastRead","마지막 읽음","130"],["tagCount","태그 수","70"],
      ["translatedTitle","번역 제목","220"],["summary","요약","220"],
      ["annotationCount","주석 수","90"],["noteCount","노트 수","70"],["venue","출판물","170"],
      // A different scale from the JIF beside it, so a column of its own, hidden until asked for.
      ["oaCitedness","OA 2년 평균 피인용","110"],
      ["signals","신호","160"],["affiliation","소속","210"],
      // The same facts as Affiliation, one to a column, so each can be sorted and
      // read on its own: who did the work, who answers for it, and how their lab stands.
      ["firstInstitution","1저자 기관","170"],["correspondingInstitution","교신 기관","170"],["institutionTier","기관 등급","80"],
      // Deep collection trees (Defense system › CRISPR-Cas › Type I Cas) made a
      // search result's folder invisible until the sidebar was clicked open.
      ["collections","컬렉션","160"],
      // A narrow button at the far right that opens the same menu as a right click on the row.
      ["more","⋯","28"]];
    this.syncFeatureColumns();
    try{this.setCustomFields(this.pref('customFields',''),{persist:false});}catch(error){this.Z.logError(error);}
    this.prefPane = await this.Z.PreferencePanes.register({ pluginID: id, src: rootURI + "content/preferences.xhtml", label: "Style Custom",image:rootURI+"content/icons/style-custom.svg",scripts:[rootURI+"src/settings.js"],stylesheets:[rootURI+"content/preferences.css"] });
    // A copy installed once keeps itself current from the GitHub feed. Not
    // during a self-check: its run must not be cut short by an upgrade.
    try { this.updater = await this.createUpdater(); if (this.updater && !this.Z.Prefs.get('extensions.style-custom.selfCheck', true)) this.updater.start(); }
    catch (error) { this.Z.logError(error); }
    for (const name of ["marquee", "hoverDelay", "scrollSpeed", "recordReading", "autoStatus", "autoCitations", "metadataCitations"]) {
      this.observers.push(this.Z.Prefs.registerObserver("extensions.style-custom." + name, () => {
        if (!this.active||this.settingWriteDepth) return;
        if (name === "autoCitations" || name === "metadataCitations") {
          if (!this.pref(name,true) && this.citationJob?.background) this.citationJob.controller.abort();
        } else for (const [win, state] of this.windows) { if(name!=="autoStatus")this.attachMotion(win,state,{marquee:name!=="recordReading",reading:name==="recordReading"});state.signature=null; }
      }, true));
    }
    if (this.Z.Notifier) this.itemObserver = this.Z.Notifier.registerObserver({notify:(event,type,ids,extraData)=>{
      /* An annotation moved or recoloured within the same second as the last
         paint has the same count and the same date, so the strip's memo is
         also dropped here, for the paper whose annotation changed -- during a
         sync too. A deletion may leave nothing to look up; then all of it. */
      if(type==='item'&&event!=='redraw'&&event!=='select')this.invalidateHeldRows();
      if(type==='item'&&this.annotationMemo?.size){
        for(const id of ids||[]){
          const changed=this.Z.Items?.get?.(id);
          if(!changed||['delete','trash'].includes(event)){this.annotationMemo.clear();break;}
          if(!changed.isAnnotation?.())continue;
          // Moved to another paper's PDF, it changes two strips, and the old parent is no longer on the item: moves clear all.
          const paper=this.Z.Items.get(changed.parentID)?.parentID;
          if(paper!=null&&event!=='modify')this.annotationMemo.delete(paper);else{this.annotationMemo.clear();break;}
        }
      }
      if(type==='item'&&(event==='modify'||event==='add'))for(const id of ids||[]){try{this.mirrorMemoNote(id);}catch(error){this.Z.logError?.(error);}}
      if(type==='item'&&event==='modify')for(const id of ids||[]){try{const changed=this.Z.Items?.get?.(id);if(changed)this.forgetIfIdentityChanged(changed);}catch(error){this.Z.logError?.(error);}}
      /* A sync rewrites every item it touches. Answering each one queues a
         lookup per paper, so the queue is left alone while a sync runs and the
         plugin's own writes are never treated as news. */
      if(this.Z.Sync?.Runner?.syncInProgress) return;
      if(type === "item" && (event === "add" || event === "modify"))
        this.scheduleMetadataCitations((ids||[]).filter(id=>!extraData?.[id]?.styleCustomCitations&&!extraData?.[id]?.styleCustomActivity));
      if(type==='tab') {
        const itemIDs=(ids||[]).map(id=>extraData?.[id]?.itemID||this.Z.Reader?.getByTabID?.(id)?.itemID||this.tabItems.get(id)).filter(Boolean);
        if(['add','select','close'].includes(event)&&this.pref('touchDateOnRead',false))for(const id of new Set(itemIDs))this.activityQueue=this.activityQueue.then(()=>this.touchReadingItem(id)).catch(error=>this.Z.logError(error));
        for(const [win]of this.windows)for(const tab of this.readerTools.tabs(win))if(tab.itemID)this.tabItems.set(tab.id,tab.itemID);
        if(event==='close')for(const id of ids||[])this.tabItems.delete(id);
      }
      /* A move, a rename or a delete anywhere in the tree can change a path
         that some cached paper still points at (a renamed ancestor reaches
         every descendant), so the whole memo goes rather than guessing which
         papers it touched. */
      if((type==='collection'||type==='collection-item')&&this.collectionMemo?.size)this.collectionMemo.clear();
    }},["item","tab","collection","collection-item"],"style-custom-citations");
    this.Z.debug("Style Custom " + version + " ready");
    // Off the start path: a library sweep must not delay a window opening.
    this.scheduleFlush(60000);
    Promise.resolve().then(() => this.pruneDeletedItems()).catch(error => this.Z.logError(error));
    Promise.resolve().then(() => this.brightenStatusTagColors()).catch(error => this.Z.logError(error));
  }
  /* The coloured-tag dots Zotero draws before a title for /unread, /reading and
     /done were set in muted tones that read as dull at that size (the user,
     2026-10-05). Brighter ones replace exactly those muted values, once; a
     colour the user picked themselves is left alone. */
  async brightenStatusTagColors() {
    const BRIGHT = {"/unread": {from: ["#6196bc"], to: "#2F8CFF"}, "/reading": {from: ["#c8963a"], to: "#FFB020"}, "/done": {from: ["#6d9b7e"], to: "#22C55E"}};
    const Tags = this.Z.Tags;
    if (typeof Tags?.getColors !== "function" || typeof Tags?.setColor !== "function") return 0;
    let changed = 0;
    for (const lib of this.Z.Libraries?.getAll?.() || []) {
      const colors = Tags.getColors(lib.libraryID);
      for (const [name, rule] of Object.entries(BRIGHT)) {
        const now = colors?.get?.(name);
        if (!now || !rule.from.includes(String(now.color || "").toLowerCase())) continue;
        await Tags.setColor(lib.libraryID, name, rule.to, now.position);
        changed++;
      }
    }
    return changed;
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
    const impactKey = this.journalTools.name(item.getField("publicationTitle")) + "|" + String(item.getField("ISSN") || "") + "|c2";
    if (cached.impactKey !== impactKey) { merged.impactFactor = null; merged.impactSource = null; merged.impactYear = null; }
    for (const [field, source] of [["citations", "citationSource"], ["impactFactor", "impactSource"]]) {
      if (number(live[field])) { merged[field] = live[field]; merged[source] = live[source]; if (field === 'citations') merged.citationCheckedAt = null; }
      else if (!number(merged[field])) { merged[field] = null; merged[source] = null; }
    }
    if(providerRank&&live.impactSource?.startsWith('easyScholar'))merged.impactYear=null;
    /* A renamed journal's figure belongs to the successor. For a paper from
       before the rename there is none (a 1976 J Gen Microbiol paper was showing
       Microbiology's 4.3); after it, the figure stays but is marked as the
       successor's. An IF typed into Extra is the reader's own and stays. */
    const detail = this.journals.lookupDetail ? this.journals.lookupDetail(item) : {record: this.journals.lookup(item), successor: null, predates: false};
    const journal = detail.record;
    merged.impactSuccessor = '';
    if (journal) {
      merged.impactFactor = journal.impactFactor;
      merged.impactYear = journal.year;
      merged.impactSource = `${journal.title} · JIF ${journal.year ?? this.t("연도 미표기")} · ${journal.sourceURL} · checked ${journal.checkedAt}`;
      if (detail.successor) merged.impactSuccessor = detail.successor.to;
    } else if (detail.predates && !number(live.impactFactor)) {
      merged.impactFactor = null; merged.impactYear = null; merged.impactSource = null;
      merged.impactSuccessor = '';
    }
    merged.impactKey = impactKey;
    const lookup=old.citationLookup;
    if (lookup?.status === "ok" && lookup.identity === citationKey && Number.isSafeInteger(lookup.count) && lookup.count >= 0) {
      merged.citations=lookup.count;
      merged.citationSource=lookup.source;
      merged.citationCheckedAt=lookup.checkedAt;
    }
    /* The works sweep (OpenAlex, by DOI) also records a citation count and the
       time it was read. The column shows whichever of the two readings is newer;
       on the same day the larger count stands, since counts only grow. */
    const swept = this.paperWorks()[this.identity(item)];
    if (swept && !swept.missing && number(swept.citations) && (swept.doi || '') === (this.discoverTools.bareDOI(this.bibliographyRecord(item).DOI) || '')) {
      const theirs = Date.parse(swept.checkedAt || ''), mine = Date.parse(merged.citationCheckedAt || '');
      // An undated stored count (typed into Extra) yields only to a larger one.
      const newer = Number.isFinite(mine) ? Number.isFinite(theirs) && (theirs > mine || (theirs === mine && swept.citations > merged.citations))
        : swept.citations > (merged.citations ?? -1);
      if (newer || !number(merged.citations)) {
        merged.citations = swept.citations;
        merged.citationSource = 'OpenAlex works sweep';
        merged.citationCheckedAt = swept.checkedAt || null;
      }
    }
    merged.citationKey=citationKey;
    // The old plugin's Total(DOI) carries no provider and no date: a figure of unknown age (BBNBV83D 439
    // against 123 now). Shown marked, never sorted or summed as if current; a refresh replaces it.
    merged.citationLegacy = number(merged.citations) && /^Style cache: Total\(DOI\)/.test(String(merged.citationSource || ''));
    const own = number(old.seconds) ? old.seconds : 0;
    const prior = number(cached.seconds) ? cached.seconds : 0;
    merged.seconds = Math.max(own, prior, number(live.seconds) ? live.seconds : 0);
    if (JSON.stringify(cached) !== JSON.stringify(merged)) { old.metrics = merged; this.dirty = true; }
    return merged;
  }
  /* One computation of a row's state per repaint, not one per column.

     state() rebuilds everything: it reads the legacy store, resolves the
     journal rank, builds a citation identity and merges three objects. Five
     columns ask for it -- IF, citations, status, rating, read time -- and
     Zotero asks each column for its sort value and then its cell, so a forty
     row viewport recomputed all of that four hundred times a frame. Scrolling
     spent about a tenth of a second per screen deciding facts that had not
     changed.

     The memo is keyed on a generation counter, bumped whenever anything is
     written, and expires on its own after a fifth of a second. The counter is
     what makes it correct; the expiry is what keeps a missed bump from being
     visible for longer than a blink. */
  bumpState() { this.stateGeneration = (this.stateGeneration || 0) + 1; }

  state(item) {
    const id = item && item.id != null ? String(item.libraryID) + ':' + item.id : null;
    const generation = this.stateGeneration || 0;
    const now = Date.now();
    /* The memo is only consulted when nothing is waiting to be written.

     `dirty` means the cache has been changed and not yet saved, which is
     exactly the window in which a remembered answer is the old answer. Keying
     on it makes this correct by construction rather than by remembering to
     invalidate at each of the places that mutate: the live reading-time cell
     reads state during the same tick that increments it, before any flush, and
     a memo keyed only on a counter served it the previous second's figure. */
    const settled = !this.dirty;
    if (id != null && settled) {
      if (!this.stateCache) this.stateCache = new Map();
      const hit = this.stateCache.get(id);
      if (hit && hit.generation === generation && now - hit.at < 200) return hit.value;
    }
    const value = this.computeState(item);
    if (id != null && settled) {
      if (!this.stateCache) this.stateCache = new Map();
      // A viewport is tens of rows; the cap is there so a sweep over a whole
      // library cannot grow this without bound.
      if (this.stateCache.size > 600) this.stateCache.clear();
      this.stateCache.set(id, {generation, at: now, value});
    }
    return value;
  }

  computeState(item) {
    const metrics = this.metrics(item);
    const tags = item.getTags(), counted = this.pref("autoStatus", true)&&this.featureEnabled("readStatus") ? metrics.seconds : 0;
    const state = this.model.readState(tags, item.getField("extra"), counted);
    let statusReason = this.model.statusReason?.(tags, counted) || '';
    if (this.entry(item).unreadOverride && state.status !== "done") { state.status = "unread"; statusReason = 'tag-unread'; }
    return { ...metrics, ...state, statusReason,lastRead:this.entry(item).lastRead||'',dateAdded:String(item.getField('dateAdded')||''),dateModified:String(item.getField('dateModified')||'') };
  }
  value(key, item) {
    try {
      const state = this.state(item);
      /* A sort key, not the figure: see sortKey. The cell draws the figure
         from displayValue. The IF column is Clarivate's JIF alone; OpenAlex's
         two-year citedness, a different scale, has its own column. */
      if (key === "citations" && state.citationLegacy) return this.sortKey("");
      if (key === "if" || key === "oaCitedness" || key === "citations") return this.sortKey(this.displayValue(key, item));
      if (key === "journalMark") return this.journalAbbreviationOf(item);

      if (key === "status") return String({unread:0,reading:1,done:2}[state.status]);
      if (key === "rating") return String(state.rating);
      /* Sort keys like IF's (see sortKey): Zotero compares text, so "12.25" came
         after "12.5" and a paper with no reading record sat on top of 0% and
         50% whenever the list ran highest first. The cell draws displayValue. */
      if (key === "time") return this.sortKey(this.displayValue(key, item));
      if (key === "progress") return this.sortKey(this.displayValue(key, item));
      if (["remark","translatedTitle","summary"].includes(key)) return String(this.entry(item)[key]||"");
      if (key === "affiliation") {
        const where = this.affiliationOf(item);
        if (!where) return "";
        // The sort key is the text, so it names the lab and the country the
        // badge draws, and nothing the badge does not.
        return [where.first?.institution, where.corresponding && where.corresponding.institution !== where.first?.institution
          ? where.corresponding.institution : '', where.countries.join('/')]
          .filter(Boolean).join(' · ');
      }
      if (key === "firstInstitution" || key === "correspondingInstitution") {
        // When the first author is also the corresponding author, the column
        // says so by naming the same lab again, not by pointing sideways.
        const where = this.affiliationOf(item);
        const row = key === "firstInstitution" ? where?.first : (where?.corresponding || where?.first);
        return row ? [row.institution || row.name, row.country].filter(Boolean).join(' · ') : "";
      }
      if (key === "institutionTier") {
        // Sorted by the figure behind the label, so the column orders labs by
        // standing rather than by the alphabet of the tier names.
        const where = this.affiliationOf(item);
        const h = where?.hIndex ?? Math.max(where?.first?.hIndex || 0, where?.corresponding?.hIndex || 0);
        return h > 0 ? String(h).padStart(5, "0") : "";
      }
      if (key === "publication") return this.publicationTags(item).join(' · ');
      if (key === "venue") return ['publicationTitle','proceedingsTitle','university','publisher'].map(field=>item.getField(field)).find(Boolean)||'';
      // The full path is the sort key, so two papers in the same deep folder
      // group together; the cell shortens it, but sorting never does.
      if (key === "collections") return this.collectionEntries(item).map(e=>e.path).join(' · ');
      if (key === "authors") return (item.getCreators?.()||[]).map(c=>[c.firstName,c.lastName||c.name].filter(Boolean).join(' ')).join('; ');
      if (key === "added"||key === "modified")return String(item.getField(key==='added'?'dateAdded':'dateModified')||'');
      // Kept in UTC so it sorts; drawn in the reader's own clock (see localStamp).
      if (key === "lastRead")return String(this.entry(item).lastRead||'');
      if (key === "tagCount")return String(item.getTags().filter(t=>!/^style-custom:/.test(t.tag)).length);
      if (key === "noteCount")return String(item.getNotes?.().length||0);
      // An ordinal key, not a label: the column has to sort the worst news to
      // the top. Empty until the paper has been looked up, so an unchecked
      // paper is never mistaken for a clean one.
      if (key === "signals")return this.signalTools.sortKey(this.signalsOf(item));
      if (key === "files") {const kinds=this.attachmentKinds(item);if(!kinds.length)return "";
        const of=want=>kinds.filter(k=>k.kind===want).length;
        // The sort key is the text, so it has to name every kind the cell draws:
        // the main files by format (a lone data.xlsx is not "PDF"), and files no verdict could place.
        return [...this.fileFormats(kinds.filter(k=>k.kind==='article')).map(([label,list])=>`${label}×${list.length}`),of('supplementary')?`SI×${of('supplementary')}`:"",
          of('duplicate')?`중복×${of('duplicate')}`:"",of('foreign')?`다른논문×${of('foreign')}`:"",of('unknown')?`미확인×${of('unknown')}`:""]
          .filter(Boolean).join(" · ");}
      if (key === "annotationCount")return String((item.getAttachments?.()||[]).reduce((n,id)=>n+(this.Z.Items.get(id)?.deleted?0:(this.Z.Items.get(id)?.getAnnotations?.()||[]).filter(annotation=>!annotation.deleted).length),0));
      if (key.startsWith('field-'))return String(item.getField(key.slice(6))||'');
      return item.getTags().map(t => t.tag).filter(t => !/^\/(unread|reading|done)$/.test(t) && !/^style-custom:/.test(t) && !/^[★⭐]+$/.test(t)).join(" · ");
    } catch (error) { this.Z.logError(error); return ""; }
  }
  // The path from the library root, oldest ancestor first. A collection
  // deleted mid-walk, or a cycle Zotero should never produce, stops the walk
  // instead of looping.
  collectionPath(id) {
    const names = [], seen = new Set();
    let current = this.Z.Collections.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(String(current.name || ""));
      current = current.parentID ? this.Z.Collections.get(current.parentID) : null;
    }
    return names.join(" › ");
  }
  /* One id+path pair per collection a paper is filed in, sorted by path so
     the column, the context menu and the panel line all read the same order.
     Kept per paper until its membership changes -- rebuilding every path on
     every repaint was one tree walk per row per column redraw, for a library
     with collections nested five deep. */
  collectionEntries(item) {
    if (!this.isRegular(item)) return [];
    this.collectionMemo ||= new Map();
    const ids = (item.getCollections?.() || []).slice().sort((a, b) => a - b).join(",");
    const held = this.collectionMemo.get(item.id);
    if (held && this.itemObserver != null && held.ids === ids) return held.entries;
    const entries = (item.getCollections?.() || [])
      .map(id => ({ id, path: this.collectionPath(id) }))
      .filter(entry => entry.path)
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    this.collectionMemo.set(item.id, { ids, entries });
    if (this.collectionMemo.size > 3000) this.collectionMemo.delete(this.collectionMemo.keys().next().value);
    return entries;
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
  // Verdicts read from a document's own first page, stored per attachment after
  // a scan. The filename rule stays as a fallback, but on this library it found
  // one supplementary file in 1,229 because every attachment had been renamed.
  fileVerdicts() {
    const store = this.cache.fileKinds;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.fileKinds = {});
  }

  /* The main files grouped by what they are: PDF, or the file's own extension
     (XLSX, EPUB, HTML), PDF first. */
  fileFormats(kinds) {
    const groups = new Map();
    for (const kind of kinds || []) {
      const label = kind.pdf ? 'PDF' : (String(kind.name || '').match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toUpperCase() || this.t('파일');
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(kind);
    }
    return [...groups].sort((a, b) => (b[0] === 'PDF') - (a[0] === 'PDF'));
  }
  attachmentKinds(item) {
    const kinds = [];
    const read = this.fileVerdicts();
    for (const id of item.getAttachments?.() || []) {
      const attachment = this.Z.Items.get(id);
      if (!attachment || attachment.deleted || !attachment.isFileAttachment?.()) continue;
      const name = String(attachment.attachmentFilename || attachment.getDisplayTitle?.() || '');
      const pdf = /\.pdf$/i.test(name) || attachment.attachmentContentType === 'application/pdf';
      const verdict = read[String(id)] || null;
      // A verdict from reading the file wins; the filename is what is left when
      // nothing has read it yet.
      const kind = verdict ? verdict.kind
        : this.isSupplementary(attachment) ? 'supplementary' : 'article';
      kinds.push({id, kind, why: verdict?.why || '', read: !!verdict,
        supplementary: kind === 'supplementary', pdf, name});
    }
    return kinds;
  }

  // Zotero extracts every PDF's text for its own search index and leaves it in
  // the storage folder. Reading that costs nothing and needs no PDF parser.
  async attachmentText(attachment, {limit = 60000} = {}) {
    // Injected rather than reached for: PathUtils and IOUtils are bootstrap
    // globals, absent under test, and a sweep that quietly reads nothing is
    // exactly the failure this class has already shipped once.
    const io = this.io || (typeof IOUtils !== 'undefined' ? IOUtils : null);
    const paths = this.paths || (typeof PathUtils !== 'undefined' ? PathUtils : null);
    try {
      const key = attachment?.key;
      if (!key || !io || !paths) return '';
      const path = paths.join(this.Z.DataDirectory.dir, 'storage', key, '.zotero-ft-cache');
      if (!await io.exists(path)) return '';
      const raw = await io.readUTF8(path);
      return String(raw).slice(0, limit).replace(/\s+/g, ' ').trim();
    } catch (error) { return ''; }
  }

  // Everything the scan found that the user can act on, gathered once so the
  // panel can list it. Detection with nowhere to go is half a feature.
  async attachmentFindings(libraryID) {
    const found = {supplementary: [], duplicate: [], foreign: [], unknown: [], missing: [], broken: [], orphan: [], unread: 0};
    const papers = [], orphans = [], records = [], holders = new Set(), noFile = [];
    const field = (item, key) => { try { return String(item.getField?.(key) || '').trim(); } catch (_) { return ''; } };
    for (const item of await this.libraryItems(libraryID)) {
      if (!this.isRegular(item)) continue;
      const all = this.attachmentKinds(item);
      // A link whose file is gone is not a file: the paper cannot be read from it,
      // and downloading is not the fix, relinking is.
      const kinds = [];
      for (const kind of all) {
        const attachment = this.Z.Items.get(Number(kind.id));
        let exists = true;
        try { if (typeof attachment?.fileExists === 'function') exists = !!(await attachment.fileExists()); } catch (_) { exists = true; }
        if (exists) { kinds.push(kind); continue; }
        let path = '';
        try { path = String(attachment.getFilePath?.() || attachment.attachmentPath || ''); } catch (_) { path = String(attachment?.attachmentPath || ''); }
        found.broken.push({id: String(item.id), title: field(item, 'title'), year: field(item, 'date').slice(0, 4),
          file: kind.name, path, brokenID: kind.id});
      }
      const paper = {id: String(item.id), title: field(item, 'title'), year: field(item, 'date').slice(0, 4)};
      papers.push(paper);
      records.push({...paper, doi: this.discoverTools.bareDOI(field(item, 'DOI')) || ''});
      if (kinds.length) holders.add(paper.id);
      if (!kinds.length) {
        // Only a paper with no link at all is a candidate for "PDF 찾기".
        if (!all.length) noFile.push({item, paper});
        continue;
      }
      found.unread += kinds.filter(kind => !kind.read).length;
      // An item whose every file is a supplement is a supplement that was filed
      // as its own bibliography entry -- twenty-two of them here, and only five
      // say so in the title.
      if (kinds.every(kind => kind.kind === 'supplementary')) orphans.push({item, paper, kinds});
      for (const kind of kinds) {
        if (!found[kind.kind]) continue;
        found[kind.kind].push({...paper, fileID: kind.id, file: kind.name, why: kind.why});
      }
    }
    // Which papers without a file are worth a download attempt: not a program or
    // a dataset with neither DOI nor URL, and not a copy of a paper whose other
    // copy already has the file.
    const copyHolds = new Set();
    for (const group of this.constructor.duplicateGroups(records)) {
      if (group.items.some(row => holders.has(row.id))) for (const row of group.items) copyHolds.add(row.id);
    }
    const PAPER_TYPE = /^(journalArticle|preprint|conferencePaper|book|bookSection|thesis|report|magazineArticle|newspaperArticle)$/;
    for (const {item, paper} of noFile) {
      const type = String(item.itemType || '');
      const hasID = !!(field(item, 'DOI') || field(item, 'url'));
      let why = '';
      if (type && !PAPER_TYPE.test(type) && !hasID) why = '논문이 아니고 DOI·주소도 없어 PDF 찾기에서 뺐습니다';
      else if (copyHolds.has(paper.id)) why = '같은 논문의 다른 사본에 파일이 있어 PDF 찾기에서 뺐습니다';
      found.missing.push({...paper, findable: !why, ...(why ? {why} : {})});
    }
    for (const {item, paper, kinds} of orphans) {
      const first = this.Z.Items.get(Number(kinds[0].id));
      const text = first ? await this.attachmentText(first, {limit: 4000}) : '';
      const home = this.fileTools.findHome({id: paper.id, title: paper.title, text}, papers);
      found.orphan.push({...paper, fileID: kinds[0].id, file: kinds[0].name, home});
    }
    return found;
  }

  /* Moving a supplement onto the paper it belongs to, and retiring the stub
     entry that was holding it. Zotero's trash makes this undoable; nothing is
     deleted and no file on disk is touched. */
  async rehomeSupplement(fileID, homeID, {trashStub = true} = {}) {
    const attachment = this.Z.Items.get(Number(fileID));
    const home = this.Z.Items.get(Number(homeID));
    if (!attachment || !home) throw new Error('문헌을 찾지 못했습니다. 목록에서 다시 선택한 뒤 실행하세요.');
    if (!this.isRegular(home)) throw new Error('보충자료는 일반 문헌에만 붙일 수 있습니다. 첨부파일이나 노트 말고 문헌을 고르세요.');
    const stub = attachment.parentItemID ? this.Z.Items.get(attachment.parentItemID) : null;
    if (stub && stub.id === home.id) return {moved: 0, trashed: 0};
    attachment.parentItemID = home.id;
    await attachment.saveTx();
    let trashed = 0;
    // Only a stub with nothing left on it goes: an entry that still holds its
    // own article is a real paper that happened to carry someone's supplement.
    // The file that was just moved is excluded by id rather than by trusting the
    // stub's own list to have been refreshed by the save.
    const left = (stub?.getAttachments?.() || []).filter(id => {
      if (Number(id) === Number(fileID)) return false;
      const child = this.Z.Items.get(id);
      return child && !child.deleted;
    });
    if (trashStub && stub && !left.length) {
      stub.deleted = true;
      await stub.saveTx();
      trashed = 1;
    }
    this.dirty = true;
    await this.flush();
    await this.refreshWindows();
    return {moved: 1, trashed};
  }

  // Sending a duplicate to the trash, which Zotero can undo. Nothing here
  // deletes anything: the file itself is left where it is.
  async trashAttachments(ids) {
    let moved = 0, skipped = 0;
    for (const id of ids) {
      const attachment = this.Z.Items.get(Number(id));
      if (!attachment || attachment.deleted) { skipped++; continue; }
      if (attachment.libraryID != null && !this.Z.Libraries.get(attachment.libraryID)?.editable) { skipped++; continue; }
      attachment.deleted = true;
      if (typeof attachment.saveTx === 'function') await attachment.saveTx(); else await attachment.save();
      delete this.fileVerdicts()[String(id)];
      moved++;
    }
    if (moved) { this.dirty = true; await this.flush(); await this.refreshWindows(); }
    return {moved, skipped};
  }

  // Zotero's own text extraction, asked for by name. It is what fills
  // .zotero-ft-cache, so a file indexed here is a file this scan can read.
  async indexAttachments(attachments, {signal} = {}) {
    const wanted = attachments.filter(Boolean);
    if (!wanted.length) return 0;
    const service = this.Z.FullText || this.Z.Fulltext;
    if (!service?.indexItems) return 0;
    try {
      await service.indexItems(wanted.map(attachment => attachment.id), {ignoreErrors: true});
      signal?.throwIfAborted?.();
      return wanted.length;
    } catch (error) { this.Z.logError(error); return 0; }
  }

  async scanAttachmentKinds(items, {signal, onProgress, buildIndex = true} = {}) {
    const store = this.fileVerdicts();
    const result = {items: 0, files: 0, article: 0, supplementary: 0, duplicate: 0, foreign: 0, unknown: 0, unread: 0, indexed: 0};
    const list = [...new Set(items)].filter(item => this.isRegular(item));
    for (const [index, item] of list.entries()) {
      if (signal?.aborted || !this.active || this.stopping) break;
      onProgress?.(index, list.length);
      const files = [], attachments = new Map();
      for (const id of item.getAttachments?.() || []) {
        const attachment = this.Z.Items.get(id);
        if (!attachment || attachment.deleted || !attachment.isFileAttachment?.()) continue;
        const name = String(attachment.attachmentFilename || attachment.getDisplayTitle?.() || '');
        if (!(/\.pdf$/i.test(name) || attachment.attachmentContentType === 'application/pdf')) continue;
        attachments.set(String(id), attachment);
        files.push({id: String(id), name, text: await this.attachmentText(attachment)});
      }
      if (!files.length) continue;
      result.items++;
      result.files += files.length;
      // A file Zotero has not indexed yet has no text to read, and eleven of
      // this library's attachments were in that state. Asking Zotero to index
      // them is the difference between "cannot tell" and an answer, and it is
      // the same extraction its own search would do.
      const blank = files.filter(file => !file.text);
      if (blank.length && buildIndex) {
        const indexed = await this.indexAttachments(blank.map(file => attachments.get(file.id)), {signal});
        result.indexed += indexed;
        for (const file of blank) file.text = await this.attachmentText(attachments.get(file.id));
      }
      if (files.every(file => !file.text)) { result.unread += files.length; continue; }
      result.unread += files.filter(file => !file.text).length;
      const verdicts = this.fileTools.classifyGroup(files, {title: String(item.getField('title') || '')});
      for (const verdict of verdicts) {
        store[String(verdict.id)] = {kind: verdict.kind, why: verdict.why,
          duplicateOf: verdict.duplicateOf || null, checkedAt: new Date().toISOString()};
        result[verdict.kind] = (result[verdict.kind] || 0) + 1;
      }
      this.dirty = true;
    }
    if (result.items) { await this.flush(); await this.refreshWindows(); }
    return result;
  }
  /* Painting a row re-parsed every annotation's position JSON, every paint,
     for every visible row. The answer is kept per paper until its annotations
     change: count and latest modification, read without parsing anything. */
  annotationDistribution(item) {
    /* While the notifier is watching, its word is the invalidation: a held
       answer is used without touching a single annotation. Without it (a
       test, a window not yet watched), attachments and counts are compared. */
    this.annotationMemo ||= new Map();
    const held=this.annotationMemo.get(item.id);
    const attachments=(item.getAttachments?.()||[]).join(',');
    if(held&&this.itemObserver!=null&&held.attachments===attachments)return held.pages;
    const signature=[];
    for(const id of item.getAttachments?.()||[]){const attachment=this.Z.Items.get(id);if(!attachment||attachment.deleted)continue;const list=attachment.getAnnotations?.()||[];let latest='';for(const a of list)if(String(a.dateModified||'')>latest)latest=String(a.dateModified);signature.push(id+':'+list.length+':'+latest);}
    const key=signature.join('|');
    if(held&&held.key===key){held.attachments=attachments;return held.pages;}
    const pages=this.annotationPagesOf(item);
    this.annotationMemo.set(item.id,{key,pages,attachments});
    if(this.annotationMemo.size>3000)this.annotationMemo.delete(this.annotationMemo.keys().next().value);
    return pages;
  }
  annotationPagesOf(item) {
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
    /* Asked for every cell of every row while the list scrolls. matchMedia
       builds a new query object each time; one per window is kept (its
       `matches` is live, so a theme change is still seen). */
    const win = doc?.defaultView;
    let dark = false;
    if (win && typeof win.matchMedia === 'function') {
      this.themeQueries ||= new WeakMap();
      let held = this.themeQueries.get(win);
      if (!held || held.fn !== win.matchMedia) { held = {fn: win.matchMedia, query: win.matchMedia('(prefers-color-scheme: dark)')}; this.themeQueries.set(win, held); }
      dark = !!held.query?.matches;
    }
    // Pastel: the hue stays, the saturation drops to about a third, and the
    // lightness of every colour is chosen so they all land on the same contrast
    // against the surface behind them. Evenness is the point -- in the old set
    // gold sat at 2.1 against white and blue at 4.7, so one badge shouted and
    // another was hard to read, which is what made the row look loud.
    // The pill tint is raised instead, so the softness lives in the fills.
    return dark
      // Lifted a step in saturation from the first pastel set, which read as
      // muddy on a white ground; the evenness across hues is kept.
      ? {blue:'#7EA3E1',green:'#2BB771',orange:'#D79256',red:'#E3888B',purple:'#BC8EE5',teal:'#2FB0C9',gold:'#C09D2D',amber:'#D1963D',star:'#FFD35C',reading:'#7FC3A3',done:'#3FA372',gray:'#98989D',faint:'#676770',muted:'#A0A0A6',text:'#E8E8ED',tint:0.28,dark:true}
      : {blue:'#3068CA',green:'#1C7A4B',orange:'#9D5C25',red:'#C92F34',purple:'#9043D3',teal:'#207585',gold:'#7E681E',amber:'#8F6322',star:'#FFC233',reading:'#3C775C',done:'#2D7854',gray:'#6A6A6F',faint:'#8B95A2',muted:'#6E6E73',text:'#1C1C1E',tint:0.18,dark:false};
  }
  tint(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
  }
  // Impact-factor bands. Chosen so the common 2-10 range stays calm and only a
  // genuinely exceptional journal earns the strongest colour.
  /* The journal cell: the publisher's mark, then the figure in readable ink.

     The mark is where the colour lives. It is the one thing in the row that is
     not written anywhere else, and a reader recognises "Nature portfolio" or
     "Cell Press" at a glance in a way that a purple 56.1 never conveyed. The
     number goes back to plain ink with weight carrying how high it is, which
     ends the five-hue rainbow down a single column. */
  // The journal a paper is in, as the mark module identifies it, with the title
  // the identification was made from.
  journalIdentityOf(item) {
    const title = this.isRegular(item)
      ? String(item.getField('publicationTitle') || item.getField('proceedingsTitle') || '') : '';
    let issn = '';
    try { issn = String(item.getField('ISSN') || ''); } catch (_) {}
    const identity = title ? this.journalIdentity.identify(title, {issn}) : null;
    return identity ? {title, identity} : null;
  }
  // The journal's standard abbreviation: Zotero's own field when the record has
  // one, otherwise the abbreviation the mark module derives from the title.
  journalAbbreviationOf(item) {
    const found = this.journalIdentityOf(item);
    // A title the curated table knows always gets the table's form, so the
    // column reads in one style ("Nat Commun", never "Nat. Commun." beside it).
    if (found && this.journalIdentity.ABBREVIATIONS[found.title]) return this.journalIdentity.ABBREVIATIONS[found.title];
    const own = this.isRegular(item) ? String(item.getField('journalAbbreviation') || '').trim() : '';
    // Some translators file the full title in the abbreviation field; that is
    // not an abbreviation, so the derived one is used instead. Trailing periods
    // ("Front. Genet.") are dropped for the same one-style reason.
    const same = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (own && (!found || same(own) !== same(found.title))) return own.replace(/\.(?=\s|$)/g, '');
    return found?.identity.mark || '';
  }
  // The abbreviation in the publisher's colour. Its own column now: beside the IF
  // it crowded the number, and the colour belongs on the journal's name anyway.
  journalMarkNode(doc, item, P) {
    const found = this.journalIdentityOf(item);
    if (!found) return null;
    const tone = this.journalIdentity.colours(found.identity, {dark: P.dark});
    const mark = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    mark.textContent = this.journalAbbreviationOf(item);
    const bg = tone.badge || tone.fill, ink = tone.badge ? tone.badgeInk : tone.ink, edge = tone.badge ? 'transparent' : tone.edge;
    // One box: 14px tall, the line exactly as tall, so the 9px text sits in the middle of it rather than on
    // its upper edge. floor-exempt: user-requested original size, 2026-10-04.
    const px = this.journalIdentity.BADGE_FONT_PX || 9, box = 14;
    mark.style.cssText = `flex:none;display:inline-block;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;vertical-align:middle;`
      + `min-width:22px;height:${box}px;padding:0 4px;border-radius:3px;white-space:nowrap;`
      + `background:${bg};color:${ink};box-shadow:inset 0 0 0 .5px ${edge};`
      + `font-size:${px}px;font-weight:700;letter-spacing:.02em;line-height:${box}px;font-variant-numeric:normal;`;
    mark.title = found.identity.label ? `${found.title} · ${found.identity.label}` : found.title;
    return mark;
  }
  /* The same publisher mark, from a venue name alone.

     journalMarkNode needs an item; the related-papers, watched-author and
     recent lists only have a venue string off a search result. One row of
     "2023 · Nature Reviews Microbiology · 인용 707" reads; forty of them in a
     row are a wall of grey, and the publisher was the one thing in each that a
     reader recognises at a glance. */
  journalMarkForVenue(doc, venue, P) {
    const title = String(venue || '').trim();
    if (!title) return null;
    const identity = this.journalIdentity.identify(title);
    if (!identity) return null;
    const tone = this.journalIdentity.colours(identity, {dark: P.dark});
    const mark = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    mark.textContent = this.journalIdentity.ABBREVIATIONS[title] || this.journalIdentity.abbreviate(title) || identity.mark;
    const bg = tone.badge || tone.fill, ink = tone.badge ? tone.badgeInk : tone.ink, edge = tone.badge ? 'transparent' : tone.edge;
    // floor-exempt: user-requested original size (9px in a 14px box), 2026-10-04.
    const px = this.journalIdentity.BADGE_FONT_PX || 9;
    mark.style.cssText = `flex:none;display:inline-flex;align-items:center;justify-content:center;`
      + `min-width:22px;height:14px;padding:0 4px;border-radius:3px;white-space:nowrap;vertical-align:middle;`
      + `background:${bg};color:${ink};box-shadow:inset 0 0 0 .5px ${edge};`
      + `font-size:${px}px;font-weight:700;letter-spacing:.02em;line-height:1;font-variant-numeric:normal;`;
    mark.title = identity.label ? `${title} · ${identity.label}` : title;
    return mark;
  }

  /* Mirrors workbench.js's jcrIndex/jcrMatch/jcrBestStanding (kept as a
     separate, minimal copy rather than requiring the workbench module from
     here): the captured JCR catalog's own journals, indexed once by ISSN and
     by exact lower-cased title, so the item-list IF tooltip can name the
     official quartile and category rank without scanning the catalog on
     every cell. Only worth building for the real Clarivate catalog -- the
     shipped OpenAlex placeholder never fills categoryMetrics, so it would
     never match. */
  static _jcrCatalogIndex = new WeakMap();
  _jcrIndex(catalog) {
    let entry = CustomStyleRuntime._jcrCatalogIndex.get(catalog);
    if (entry) return entry;
    const byIssn = new Map(), byTitle = new Map();
    for (const journal of catalog.journals || []) {
      for (const raw of journal.issns || []) {
        const key = String(raw).replace(/[^0-9xX]/g, '').toUpperCase();
        if (key.length === 8 && !byIssn.has(key)) byIssn.set(key, journal);
      }
      const folded = this.journalTools.name(journal.title);
      if (folded && !byTitle.has(folded)) byTitle.set(folded, journal);
    }
    entry = { byIssn, byTitle }; CustomStyleRuntime._jcrCatalogIndex.set(catalog, entry);
    return entry;
  }
  _jcrMatch(catalog, venue, issns) {
    if (!catalog || !venue) return null;
    const { byIssn, byTitle } = this._jcrIndex(catalog);
    for (const raw of issns || []) {
      const key = String(raw || '').replace(/[^0-9xX]/g, '').toUpperCase();
      if (key.length === 8 && byIssn.has(key)) return byIssn.get(key);
    }
    return byTitle.get(this.journalTools.name(venue)) || null;
  }
  // The one category worth leading with: the best quartile, then the highest percentile in a tie.
  _jcrBestStanding(journal) {
    const rows = (journal.categoryMetrics || []).filter(m => m.quartile != null || m.rank != null);
    if (!rows.length) return null;
    return rows.slice().sort((a, b) => (a.quartile ?? 5) - (b.quartile ?? 5) || (b.percentile ?? -1) - (a.percentile ?? -1))[0];
  }

  paintJournal(cell, item, doc, P, {figure, estimate, name, successor} = {}) {
    const identityInfo = this.journalIdentityOf(item);
    const title = identityInfo?.title
      || (this.isRegular(item) ? String(item.getField('publicationTitle') || item.getField('proceedingsTitle') || '') : '');
    const number = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    const value = Number(figure);
    /* One decimal, always, and the number pushed to the right edge.

       "3", "15", "56.1" and "~6.2" mixed in one column put the decimal points
       in four different places, so the eye could not run down it. Every
       figure now reads to a tenth, in tabular digits, right-aligned, so the
       points line up and the column can be scanned. */
    number.textContent = figure == null ? '—' : (estimate || successor ? '~' : '') + (Number.isFinite(value) ? value.toFixed(1) : String(figure));
    number.style.cssText = `font-variant-numeric:tabular-nums;margin-inline-start:auto;text-align:right;flex:none;`
      // Only how high the figure is, and only in weight. The tier used to be
      // said twice: once by a colour and once by the number right beside it.
      + `font-weight:${value >= 10 ? 640 : value >= 5 ? 560 : 400};`
      + `color:${figure == null ? P.faint : estimate ? P.muted : P.text};`;
    cell.appendChild(number);
    const tier = this.impactTier(value, P);
    /* The official standing, when the captured JCR catalog has this journal:
       Q1 8/140 says more, field-by-field, than a tier name derived only from
       the raw number. Nothing invented -- no catalog, no match or no
       quartile recorded all leave this off, the same as before. */
    const journal = (!estimate && figure != null && this.jcrCatalog)
      ? this._jcrMatch(this.jcrCatalog, title, [...(identityInfo?.identity?.issns || []), ...(String(this.isRegular(item) ? item.getField('ISSN') || '' : '').match(/\d{4}-?\d{3}[\dXx]/g) || [])]) : null;
    const standing = journal ? this._jcrBestStanding(journal) : null;
    const standingText = standing && standing.quartile != null
      ? ` · Q${standing.quartile}${standing.rank != null && standing.rankTotal != null ? ` ${standing.rank}/${standing.rankTotal}` : ''}${standing.categoryKey ? ' ' + standing.categoryKey : ''}`
      : '';
    cell.title = figure == null
      ? (title ? `${title} · ${this.t('공식 IF를 아직 확인하지 못했습니다.')}` : this.t('저널 정보가 없습니다.'))
      : estimate
        ? `≈ ${figure} · ${this.t('OpenAlex 2년 평균 피인용')} · ${name || title}\n${this.t('공식 JIF가 아니라 추정치입니다.')}`
        : `${title}${tier ? ' · ' + this.t(tier.name) : ''} · IF ${figure}${standingText}`
          // The figure is a renamed journal's successor's: marked "~" and said so.
          + (successor ? '\n' + this.t("후속 저널 {0}의 IF입니다. 이 논문이 실린 시점의 저널과 같은 값이 아닐 수 있습니다.").replace('{0}', successor) : '');
    return cell;
  }

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
    /* A word in its colour, not a capsule: the tinted, fully rounded pill was
       the decoration the reader asked to have taken off. The colour stays
       where it means something (a tag's, a retraction's); the shape goes. */
    el.style.cssText = `display:inline-flex;align-items:center;border-radius:3px;padding:0 2px;`
      + `font-size:11px;font-weight:590;line-height:15px;letter-spacing:-0.01em;white-space:nowrap;`
      + `color:${color};`;
    return el;
  }
  // Log scale: citation counts span several orders of magnitude, so a linear bar
  // would leave almost every row empty.
  citationShare(count) {
    if (!(count > 0)) return 0;
    return Math.min(1, Math.log10(count + 1) / Math.log10(1001));
  }
  // One person's lab as a row reads it: the flag, then the name of the institution.
  affiliationLine(doc, row, role, P) {
    if (!row) return null;
    const wrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:3px;min-width:0;";
    if (row.flag) {
      const flag = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      flag.textContent = row.flag;
      flag.style.cssText = "font-size:11px;line-height:1;flex:none;";
      wrap.appendChild(flag);
    }
    const name = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    // OpenAlex names carry their country ("BGI Group (China)") and the flag already says it.
    const institution = row.institution ? String(row.institution).replace(/\s*\([^)]+\)\s*$/, row.flag ? "" : "$&").trim() || row.institution : "";
    name.textContent = institution || (row.name ? this.t("소속 미상") : "—");
    if (!institution && row.name) name.title = `${row.name} · ${this.t("소속 미상")}`;
    name.style.cssText = `font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`
      + `color:${institution ? (role === "first" ? P.text : P.muted) : P.faint};${institution ? "" : "font-style:italic;"}`;
    wrap.appendChild(name);
    return wrap;
  }
  // The tier as a pill. The three buckets step down in colour -- blue, teal,
  // grey -- so a column of them reads as a scale rather than as a list of words.
  tierPill(doc, where, P) {
    const tier = where?.tier;
    // A tier with no label is one that sorts but is not worth drawing: the
    // middle bucket sat on three rows in four, which is a texture, not a mark.
    if (!tier || !tier.label) return null;
    // T4 used P.faint, a placeholder grey at 3.04:1 on white (2.45:1 in dark). Its own hue, walked until it reads (4.5:1).
    const tone = tier.key === 't4' ? this.journalIdentity.readable(P.faint, !!P.dark)
      : {t1: P.blue, t2: P.teal, t3: P.gray}[tier.key] || P.blue;
    const badge = this.pill(doc, tier.label, tone, P);
    badge.style.fontWeight = "600";
    const h = where.hIndex ?? Math.max(where.first?.hIndex || 0, where.corresponding?.hIndex || 0);
    badge.title = this.t(tier.note) + (h > 0 ? ` · ${this.t("기관 h-index")} ${h}` : "");
    return badge;
  }
  // Everything the affiliation columns know, for a tooltip.
  affiliationNote(where) {
    return [
      where.first ? `${this.t("1저자")} ${where.first.name} · ${where.first.institution || this.t("소속 미상")}`
        + (where.first.country ? ` (${where.first.country})` : "")
        + (where.first.hIndex ? ` · ${this.t("기관 h-index")} ${where.first.hIndex}` : "") : null,
      where.corresponding ? `${this.t("교신저자")} ${where.corresponding.name} · ${where.corresponding.institution || this.t("소속 미상")}`
        + (where.corresponding.country ? ` (${where.corresponding.country})` : "")
        + (where.corresponding.hIndex ? ` · ${this.t("기관 h-index")} ${where.corresponding.hIndex}` : "") : null,
      where.correspondingKnown ? null : this.t("교신저자 표시가 없어 마지막 저자를 교신저자로 간주했습니다."),
      where.firstIsCorresponding ? this.t("1저자가 교신저자를 겸합니다.") : null,
      where.extraCorresponding ? this.t(`교신저자가 ${where.extraCorresponding + 1}명입니다.`) : null,
      where.international ? this.t("국제 공동연구") : null
    ].filter(Boolean).join("\n");
  }
  /* One line saying why a status is shown, for the status cell's tooltip. */
  statusWhy(item) {
    const state = this.state(item);
    const minutes = Math.max(1, Math.round((state.seconds || 0) / 60));
    if (state.statusReason === 'time-over-auto-unread')
      return this.t("자동으로 붙은 /unread 태그가 있지만 읽은 시간 {0}분이 기록되어 읽는 중으로 표시합니다. 직접 안 읽음으로 고르면 유지됩니다.").replace("{0}", String(minutes));
    if (state.statusReason === 'time') return this.t("태그 없이 읽은 시간 {0}분이 기록되어 읽는 중으로 표시합니다.").replace("{0}", String(minutes));
    return '';
  }
  renderCell(key, index, value, column, doc) {
    const cell = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cell.className = "cell " + (column.className || "");
    Object.assign(cell.style, { overflow: "hidden", textOverflow: "ellipsis", alignItems: "center", display: "flex", gap: "5px" });
    const P = this.palette(doc);
    if (["if","oaCitedness","citations","time","progress","tagCount","noteCount","annotationCount"].includes(key)) cell.style.fontVariantNumeric = "tabular-nums";
    // Five stars are one rating, not five marks spread across the cell.
    if (key === "rating") cell.style.gap = "1px";
    const item = doc.defaultView?.ZoteroPane?.itemsView?.getRow(index)?.ref;
    if (key === "more") { if (this.isRegular(item)) cell.appendChild(this.moreButton(doc, index, item)); cell.style.justifyContent = "center"; return cell; }
    // Read current data when painting: do not reuse a previously cached empty cell.
    if (this.isRegular(item)) {value=["if","oaCitedness","citations","time","progress"].includes(key)?this.displayValue(key,item):this.value(key,item);if(['time','status'].includes(key)){cell.dataset.styleCustomReading=key;cell.dataset.itemId=String(item.id);}}
    // A sort key handed in without its row is never drawn as text.
    else if (typeof value === "string" && /^[012]\|/.test(value)) value = "";
    if (value === "") {
      if (key === "if" && this.isRegular(item)) {
        // The catalogue covers 86 journals; this library spans 255. Rather than
        // a blank, show OpenAlex's two-year mean citedness -- a different figure
        // from a Clarivate JIF, so it is marked and never presented as one.
        const estimate = this.journalCitedness(item);
        this.paintJournal(cell, item, doc, P, {figure: null, estimate: false});
        cell.style.color = P.faint;
        if (estimate) { cell.title = this.t("공식 JIF 미확인. OpenAlex 값은 ‘OA 2년 평균 피인용’ 열에서 확인할 수 있습니다."); return cell; }
        cell.title = this.t(item.getField("publicationTitle") ? "이 저널의 공식 IF를 아직 확인하지 못했습니다. 저널명과 ISSN을 확인하세요." : "저널 정보가 없습니다. 프리프린트·책·데이터셋에는 저널 IF가 적용되지 않을 수 있습니다.");
      }
      if (key === "citations" && this.isRegular(item)) {
        const state=this.entry(item), id=this.citationTools.identity(this.citationRecord(item));
        cell.textContent=state.citationPending===id?"…":"—";
        cell.style.color=P.faint;
        const attempt=state.citationAttempt?.identity===id?state.citationAttempt:null;
        cell.title=state.citationPending===id?this.t("인용 수 조회 중"):!this.openAlexKey()&&!attempt?this.t("OpenAlex 키가 없어 자동 조회를 쉬고 있습니다. 설정 → 인용 수·IF에 키를 넣거나, 우클릭 → 선택한 문헌 인용 수 새로고침을 실행하세요."):attempt?this.t({"not-found":"일치하는 논문의 인용 수를 찾지 못했습니다.",error:"조회 실패: 기존 값은 유지됩니다.",unsupported:"확인 가능한 논문 식별자가 부족합니다."}[attempt.status]||"")+(attempt.reason?" "+attempt.reason:""):this.t("아직 조회하지 않은 인용 수입니다. 0회 인용과 구분합니다.")+(this.citationRecord(item).doi?"":" "+this.t("DOI가 없어도 제목·연도·1저자가 정확히 일치하면 찾습니다. 우클릭 → 인용 수 새로고침."));
      }
      // "Not checked" and "nothing wrong" are different answers, and only one
      // of them is safe to read as reassurance.
      if (key === "signals" && this.isRegular(item)) {
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = this.signalTools.bareDOI(this.citationRecord(item).doi)
          ? this.t("철회·공개접근 신호를 아직 조회하지 않았습니다. 문헌 목록 오른쪽 클릭 메뉴에서 조회하세요.")
          : this.t("DOI가 없어 철회 여부를 확인할 수 없습니다.");
      }
      // "Not looked up" and "no lab" are different answers, and a single-author
      // paper has a first author but nobody else to answer for it.
      if (["affiliation", "firstInstitution", "correspondingInstitution", "institutionTier"].includes(key) && this.isRegular(item)) {
        const where = this.affiliationOf(item);
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = where ? this.affiliationNote(where) : this.t("아직 조회하지 않았습니다. 연구 작업 패널 → 정리 › 관계 그래프 → 인용 목록 가져오기");
      }
      // Blank on purpose: an unfiled paper is not an error, so it says nothing
      // in the cell and only names itself in the tooltip.
      if (key === "collections" && this.isRegular(item)) cell.title = this.t("컬렉션 없음");
      // Blank as the read-time column is: nothing measured is not 0%.
      if (key === "progress" && this.isRegular(item)) cell.title = this.t("읽기 기록 없음 · Zotero 리더에서 PDF를 열면 읽은 쪽을 셉니다");
      return cell;
    }
    let label = value;
    if (key === "status") {
      label = ["unread", "reading", "done"][Number(value)] || "unread";
      // An empty, half and full circle reads as progress; one dot does not.
      // One hue deepening as the paper progresses, rather than three unrelated
      // colours: nothing started is neutral, in progress is a light sage, and
      // finished is the full green. The glyph carries the same progression, so
      // the two reinforce each other instead of each saying something else.
      const own = this.isRegular(item) ? this.statusTone(item, label, P) : null;
      const tone = own ? own.mark : {unread: P.muted, reading: P.reading, done: P.done}[label];
      const dot = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      dot.textContent = {unread: "○", reading: "◐", done: "●"}[label];
      dot.style.cssText = `font-size:11px;line-height:1;color:${tone};`;
      const text = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      // Thirty rows saying "unread" were the column's texture; the hollow circle says it alone.
      // 완료, not 읽음: the panel's own status word, so a paper marked done reads the same everywhere.
      text.textContent = label === "unread" ? "" : this.t({unread: "안 읽음", reading: "읽는 중", done: "완료"}[label]);
      text.style.cssText = `color:${label === "unread" ? P.muted : own ? own.ink : tone};font-weight:${label === "unread" ? 400 : 590};`;
      cell.append(dot, text);
      if (this.isRegular(item)) {
        cell.title = this.t({unread: "안 읽음", reading: "읽는 중", done: "완료"}[label]) + "\n" + this.t("선택한 행에서 클릭하면 상태를 고릅니다 (여러 행을 선택했으면 모두 바뀝니다)");
        // Why this status, when it is not simply the reader's own tag.
        const why = this.statusWhy(item);
        if (why) cell.title += "\n" + why;
        cell.style.cursor = "pointer";
        // The first click on a row selects it, as everywhere in Zotero; only a click on a row already selected changes it.
        const armed = this.guardClick(cell, doc, index);
        cell.addEventListener("click", event => {
          if (!armed()) return;
          event.stopPropagation();
          if (!this.canEdit(item)) return;
          // A click on a selected row speaks for every selected row.
          this.pickStatus(doc, cell, this.rowSelection(doc, item), label);
        });
      }
    } else if (key === "rating") {
      const rating = Number(value);
      label = "★".repeat(rating) + "☆".repeat(5-rating);
      for (let n=1;n<=5;n++) {
        const star = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        star.textContent = n<=rating ? "★" : "☆"; star.title = (n===rating ? this.t("클릭하면 별점을 지웁니다") : this.t(`${n}/5로 매기기`)) + "\n" + this.t("선택한 행에서 클릭합니다. 여러 행을 선택했으면 모두에 매깁니다."); star.setAttribute("role","button");
        // A filled star is a mark, not text: it can be the light warm colour a
        // star is supposed to be instead of the dark ochre that reads as dirt.
        star.style.cssText = `cursor:pointer;font-size:13px;line-height:1;color:${n<=rating?P.star:P.faint};`;
        const armed = this.guardClick(star, doc, index);
        star.addEventListener("click", event => { if (!armed()) return; event.stopPropagation(); this.rateFromCell(doc, item, n); });
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
      strip.setAttribute('aria-label',this.t('주석 위치 분포'));strip.style.cssText='display:flex;gap:2px;overflow:hidden;flex:1;align-items:center;';
      for(const page of pages.slice(0,120)){
        const marker=doc.createElementNS('http://www.w3.org/1999/xhtml','button');marker.type='button';marker.title=this.t(`첨부 ${page.attachmentID} · ${page.pageIndex+1}페이지 · 주석 ${page.count}개`);
        marker.setAttribute('aria-label',marker.title);marker.tabIndex=-1;marker.style.cssText='border:0;padding:0;min-width:4px;flex:1;height:12px;cursor:pointer;';
        let start=0;const stops=[];for(const[color,count]of page.colors){const end=start+count/page.count*100;stops.push(`${color} ${start}% ${end}%`);start=end;}
        marker.style.background=stops.length===1?page.colors[0][0]:`linear-gradient(0deg,${stops.join(',')})`;
        const armed=this.guardClick(marker,doc,index);
        marker.addEventListener('click',event=>{if(!armed())return;event.stopPropagation();this.libraryService.openItem(page.attachmentID,{pageIndex:page.pageIndex}).catch(error=>this.Z.logError(error));});strip.appendChild(marker);
      }
      cell.appendChild(strip);cell.title=this.t(`주석 ${value}개 · ${pages.length}개 페이지에 분포`)+(pages.length>120?' · '+this.t('앞 120개 위치 표시'):'')+'. '+this.t('색 막대를 클릭하면 해당 PDF 페이지로 이동합니다.');
    } else if(['added','modified'].includes(key)&&this.getSetting('dateDisplay')==='relative') {
      /* Zotero stores these in UTC without a zone; read as local time, a paper
         added a minute ago in Seoul said "9시간 전". */
      const when=this.localStamp(value),timestamp=when?when.getTime():NaN,age=Math.max(0,Date.now()-timestamp),minutes=Math.floor(age/60000),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
      cell.textContent=Number.isFinite(timestamp)?days?this.t(`${days}일 전`):hours?this.t(`${hours}시간 전`):minutes?this.t(`${minutes}분 전`):this.t('방금'):value;
    } else if(['added','modified','lastRead'].includes(key)) {
      const when=this.localStamp(value);
      cell.textContent=when?this.formatStamp(when):String(value||'');
    } else if (key === "time") {
      const seconds = Number(value);
      label = this.formatReadTime(seconds);
      cell.textContent = label;
      // Untouched papers recede; the longer the session, the more present the number.
      cell.style.color = seconds <= 0 ? P.faint : P.text;
      if (seconds >= 3600) cell.style.fontWeight = "590";
      /* Nothing recorded is not a measured zero. This plugin times the Zotero
         reader and nothing else, so a paper read on paper or in another app
         has no record -- saying "0초" about it claims a measurement that was
         never made. */
      cell.title = seconds > 0 ? this.t(`실제로 읽은 시간 ${Math.floor(seconds)}초`)
        : this.t('읽기 기록 없음 · Zotero 리더에서 잰 시간이 없습니다');
    } else if (key === "progress") {
      const p=this.isRegular(item)?this.pageProgress(item):{percent:Number(value)};
      cell.textContent=p.percent+'%';
      cell.style.backgroundImage=`linear-gradient(90deg,${this.tint(P.blue,P.dark?0.34:0.18)} ${p.percent}%,transparent ${p.percent}%)`;
      cell.title=p.total?this.t(`${p.total}쪽 중 ${p.visited}쪽 읽음`):cell.textContent;
    } else if (key === "files" && this.isRegular(item)) {
      // Three different things turn up as "an extra PDF", and they are not the
      // same: a supplementary file, the same file twice, and a different paper
      // filed here by mistake. Calling all three "SI x2" is what made this
      // badge not worth looking at.
      const kinds = this.attachmentKinds(item);
      const of = want => kinds.filter(k => k.kind === want);
      const article = of('article'), si = of('supplementary');
      const duplicate = of('duplicate'), foreign = of('foreign'), unsure = of('unknown');
      const unread = kinds.filter(k => !k.read).length;
      for (const [format, files] of this.fileFormats(article)) {
        const plain = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        plain.textContent = files.length > 1 ? `${format} ×${files.length}` : format;
        plain.style.cssText = `font-size:11px;color:${P.muted};`;
        plain.title = files.map(k => k.name).join("\n");
        cell.appendChild(plain);
      }
      const badge = (label, tone, files, note) => {
        const pill = this.pill(doc, label, tone, P);
        pill.style.cursor = "pointer";
        pill.title = note + "\n" + files.map(k => `${k.name}${k.why ? ` — ${k.why}` : ""}`).join("\n");
        // Like the status cell and the stars: the first click on a row selects it.
        const armed = this.guardClick(pill, doc, index);
        pill.addEventListener("click", event => {
          if (!armed()) return;
          event.stopPropagation();
          this.libraryService.openItem(files[0].id).catch(error => this.Z.logError(error));
        });
        cell.appendChild(pill);
      };
      if (si.length) badge(si.length > 1 ? `SI ×${si.length}` : "SI", P.purple, si,
        this.t("보충자료 — 클릭하면 열립니다"));
      // A duplicate is clutter the user can act on, and saying so is the only
      // way they ever find out.
      if (duplicate.length) badge(duplicate.length > 1 ? `${this.t("중복")} ×${duplicate.length}` : this.t("중복"), P.gray, duplicate,
        this.t("이 문헌에 같은 파일이 두 번 붙어 있습니다 — 클릭하면 열립니다"));
      // A different paper filed here is a real error, not a nuance.
      if (foreign.length) badge(this.t("다른 논문"), P.red, foreign,
        this.t("첨부된 문서가 이 문헌의 제목을 전혀 쓰지 않습니다 — 클릭해서 확인하세요"));
      if (unsure.length && !si.length && !foreign.length) {
        const mark = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        mark.textContent = "?";
        mark.style.cssText = `font-size:11px;color:${P.faint};`;
        mark.title = this.t("첫 페이지만으로는 종류를 판단하지 못한 파일입니다.");
        cell.appendChild(mark);
      }
      cell.title = [
        article.length ? this.t(`본문 ${article.length}개`) : null,
        si.length ? this.t(`보충자료 ${si.length}개`) : null,
        duplicate.length ? this.t(`중복 ${duplicate.length}개`) : null,
        foreign.length ? this.t(`다른 논문 ${foreign.length}개`) : null,
        !kinds.length ? this.t("첨부파일 없음") : null,
        unsure.length ? this.t(`종류 미확인 ${unsure.length}개`) : null,
        unread ? this.t(`${unread}개는 아직 내용을 읽어보지 않았습니다 (우클릭 → 첨부파일 종류 판별)`) : null
      ].filter(Boolean).join(" · ");
      return cell;
    } else if (key === "signals" && this.isRegular(item)) {
      const signals = this.signalsOf(item);
      // The OA link is only offered when the shelf cannot already open the
      // paper, so it stays a way in rather than a decoration.
      const hasPDF = this.attachmentKinds(item).some(kind => kind.pdf && !kind.supplementary);
      for (const badge of this.signalTools.badges(signals, {hasPDF})) {
        const tone = P[badge.tone] || P.gray;
        const chip = this.pill(doc, this.t(badge.text), tone, P);
        chip.title = this.t(badge.title);
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
          const armed = this.guardClick(chip, doc, index);
          chip.addEventListener("click", event => { if (!armed()) return; event.stopPropagation(); this.Z.launchURL?.(badge.url); });
        }
        cell.appendChild(chip);
      }
      cell.title = signals ? `${this.t(signals.status)} · ${this.t(`확인 ${signals.checkedAt}`)}` : "";
      return cell;
    } else if (["firstInstitution", "correspondingInstitution", "institutionTier"].includes(key) && this.isRegular(item)) {
      const where = this.affiliationOf(item);
      if (!where) {
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = this.t("아직 조회하지 않았습니다. 연구 작업 패널 → 정리 › 관계 그래프 → 인용 목록 가져오기");
        return cell;
      }
      if (key === "institutionTier") {
        const pill = this.tierPill(doc, where, P);
        if (pill) cell.appendChild(pill);
        else { cell.textContent = "—"; cell.style.color = P.faint; }
        cell.title = this.affiliationNote(where);
        return cell;
      }
      const role = key === "firstInstitution" ? "first" : "corresponding";
      const row = where[role] || (role === "corresponding" ? where.first : null);
      if (!row) {
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = this.affiliationNote(where);
        return cell;
      }
      // The tier capsule leads, so a column of them lines up down the left edge
      // and the lab names start at the same place on every row.
      if (row.tier) {
        const pill = this.tierPill(doc, {tier: row.tier, hIndex: row.hIndex}, P);
        if (pill) cell.appendChild(pill);
      }
      const line = this.affiliationLine(doc, row, "first", P);
      if (line) cell.appendChild(line);
      cell.title = this.affiliationNote(where);
      return cell;
    } else if (key === "affiliation" && this.isRegular(item)) {
      const where = this.affiliationOf(item);
      if (!where) {
        cell.textContent = "—";
        cell.style.color = P.faint;
        cell.title = this.t("아직 조회하지 않았습니다. 연구 작업 패널 → 정리 › 관계 그래프 → 인용 목록 가져오기");
        return cell;
      }
      const line = (row, role) => this.affiliationLine(doc, row, role, P);
      const first = line(where.first, "first");
      if (first) cell.appendChild(first);
      // Only when it is a different lab: repeating one name twice says nothing.
      if (where.corresponding && where.corresponding.institution !== where.first?.institution) {
        const arrow = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        arrow.textContent = "→";
        arrow.style.cssText = `font-size:11px;color:${P.faint};flex:none;`;
        cell.appendChild(arrow);
        const second = line(where.corresponding, "corresponding");
        if (second) cell.appendChild(second);
      }
      if (where.tier) {
        const badge = this.tierPill(doc, where, P);
        if (badge) cell.appendChild(badge);
      }
      cell.title = this.affiliationNote(where);
      return cell;
    } else if (key === "journalMark" && this.isRegular(item)) {
      const mark = this.journalMarkNode(doc, item, P);
      if (mark) cell.appendChild(mark);
      cell.title = mark?.title || "";
      return cell;
    } else if (key === "if") {
      this.paintJournal(cell, item, doc, P, {figure: label, estimate: false, successor: this.isRegular(item) ? this.metrics(item).impactSuccessor || '' : ''});
    } else if (key === "oaCitedness") {
      const estimate = this.isRegular(item) ? this.journalCitedness(item) : null;
      this.paintJournal(cell, item, doc, P, {figure: label, estimate: true, name: estimate?.name});
    } else if (key === "citations") {
      const count = Number(value);
      const number = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      // A legacy count (no provider, no date) is drawn "~" and grey: a figure of unknown age, not a current one.
      const legacy = this.isRegular(item) && !!this.metrics(item).citationLegacy;
      number.textContent = legacy ? "~" + label : label;
      // A fixed, right-aligned number column so every bar starts at one x.
      number.style.cssText = `font-variant-numeric:tabular-nums;min-width:3.4em;text-align:right;`
        + `flex:none;font-weight:${count >= 100 && !legacy ? 590 : 400};color:${count > 0 && !legacy ? P.text : P.muted};`;
      cell.appendChild(number);
      /* Grey means "too young to judge", not "few citations".

         The bar used to turn grey below a hundred citations, which said the
         same thing the number beside it said and punished every paper for
         being new. A paper published within the last three years has not had
         time to be cited; its count is not yet evidence of anything. So the
         bar is grey while the paper is that young, blue once it has had its
         chance, and the length is the count on a log scale either way. */
      const year = Number(String(this.isRegular(item) ? item.getField('date') : '').match(/\b(1[5-9]|20)\d{2}\b/)?.[0]);
      const young = Number.isFinite(year) && year >= new Date().getFullYear() - 2;
      const track = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      track.style.cssText = `flex:1;min-width:14px;max-width:56px;height:4px;border-radius:100px;overflow:hidden;background:${this.tint(P.gray, 0.16)};`;
      const fill = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
      fill.style.cssText = `display:block;height:100%;border-radius:100px;width:${(this.citationShare(count) * 100).toFixed(1)}%;background:${this.tint(young ? P.gray : P.blue, young ? 0.7 : 0.9)};`;
      track.title = young ? this.t(`출판 3년 이내 (${year}) — 아직 인용이 쌓이는 중이라 회색 · 길이는 로그 눈금`) : this.t('피인용 수 · 길이는 로그 눈금');
      track.appendChild(fill); cell.appendChild(track);
    } else if (key === "collections" && this.isRegular(item)) {
      // The cell keeps only the last two levels of a tree that can run five
      // deep; the tooltip is the only place every level is spelled out.
      const entries = this.collectionEntries(item);
      cell.textContent = entries.map(e => e.path.split(" › ").slice(-2).join(" › ")).join(" · ");
      cell.title = entries.map(e => e.path).join("\n");
      return cell;
    } else { cell.textContent = label; }
    // Only where nothing better was written above: this line used to replace the
    // journal name and tier with the bare figure, and the status with raw English.
    if (!["time","progress","annotationCount"].includes(key) && !cell.title) {
      cell.title = key === "rating" && this.isRegular(item) ? this.t("별점 · 클릭해서 매깁니다") : this.t(label);
    }
    if (this.isRegular(item) && ["if","citations"].includes(key)) {
      // The number is a door: citations to the papers around this one, IF to the journal's page.
      cell.style.cursor = "pointer";
      const armed = this.guardClick(cell, doc, index);
      cell.addEventListener("click", () => { if (!armed()) return; const win = doc.defaultView; this.windows.get(win)?.workbench?.show(key === "citations" ? "related" : "journals"); });
      const metrics = this.metrics(item);
      const source = metrics[key === "if" ? "impactSource" : "citationSource"] || this.t("저장된 메타데이터");
      if (key === "if" && cell.title) cell.title += ` · ${source}`; else cell.title = `${label} · ${source}`;
      if (key === "citations" && metrics.citationCheckedAt) cell.title += ` · ${metrics.citationCheckedAt}`;
      if (key === "citations" && metrics.citationLegacy) cell.title += "\n" + this.t("옛 캐시의 값으로 날짜와 출처를 알 수 없습니다(legacy · unverified). 정렬과 합계에는 넣지 않습니다. 우클릭 → 인용 수 새로고침으로 제목·연도·1저자가 정확히 일치하는 논문을 찾아 바꿉니다.");
      if (key === "citations" && this.entry(item).citationAttempt?.status === "error") cell.title += " · " + this.t("최근 조회 실패, 마지막 확인값 유지");
    }
    return cell;
  }
  selected(win) {
    const selected=win.ZoteroPane?.getSelectedItems();if(selected)return selected.filter(item=>this.isRegular(item));
    const reader=this.Z.Reader?._readers?.find(r=>r._window===win),attachment=reader&&this.Z.Items.get(reader.itemID);
    const parent=attachment?.parentID?this.Z.Items.get(attachment.parentID):attachment;
    return this.isRegular(parent)?[parent]:[];
  }
  openWorkbench(win,tab='explore',focus) {return this.windows.get(win)?.workbench?.show(tab,focus);}
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
    // The setting is read once per row, not once per tag (it is a preference read and a validation each time).
    const mode=this.getSetting('tagDisplayMode'),prefix=mode==='prefixed'?this.getSetting('textTagPrefix'):'';
    return item.getTags().filter(t=>!/^\/(unread|reading|done)$/.test(t.tag)&&!/^style-custom:/.test(t.tag)&&!/^[★⭐]+$/.test(t.tag)).map(t=>{
      let color;try{color=this.Z.Tags?.getColor(item.libraryID,t.tag)?.color;}catch(_){}
      return {tag:t.tag,color:/^#[0-9a-f]{6}$/i.test(color||'')?color:null};
    }).filter(tag=>mode==='colored'?!!tag.color:mode==='prefixed'?tag.tag.startsWith(prefix):true);
  }
  /* The status cell in the colours of the dots Zotero draws before a title for
     the /unread, /reading and /done tags (brightened in brightenStatusTagColors),
     so the column and the dot tell one story: amber reading, green done, blue
     unread. The glyph is the dot's own colour; the word is the same hue at a
     readable lightness. An unread paper without the /unread tag has no dot, so
     its circle stays neutral. Null when the library gives the tag no colour. */
  statusTone(item, status, P) {
    if (!item || !['unread', 'reading', 'done'].includes(status)) return null;
    let color = null;
    try { color = this.Z.Tags?.getColor?.(item.libraryID, '/' + status)?.color; } catch (_) {}
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return null;
    if (status === 'unread') {
      let tagged = false;
      try { tagged = (item.getTags?.() || []).some(t => (t?.tag ?? t) === '/unread'); } catch (_) {}
      if (!tagged) return null;
    }
    const dark = !!P?.dark;
    this.inkMemo ||= new Map();
    const key = color.toLowerCase() + (dark ? ':d' : ':l');
    let ink = this.inkMemo.get(key);
    if (!ink) { ink = this.journalIdentity?.readable ? this.journalIdentity.readable(color, dark) : color; this.inkMemo.set(key, ink); }
    return {mark: color, ink};
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
    const win=this.Z.getMainWindow?.();if(!win?.fetch)throw new Error('이 창에서는 저널 지표를 조회할 수 없습니다. Zotero 기본 창에서 다시 실행하세요.');
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
    // Memoised on the same terms as state(): only while nothing is waiting to
    // be written, so a page turn is never served the previous page's figure.
    // The Pages column asks through both the sort value and the cell.
    const memoKey = attachmentID == null && item && item.id != null
      ? String(item.libraryID) + ':' + item.id : null;
    const generation = this.stateGeneration || 0;
    const settled = !this.dirty;
    if (memoKey != null && settled) {
      if (!this.progressCache) this.progressCache = new Map();
      const hit = this.progressCache.get(memoKey);
      if (hit && hit.generation === generation && Date.now() - hit.at < 200) return hit.value;
    }
    const computed = this.computePageProgress(item, attachmentID);
    if (memoKey != null && settled) {
      if (this.progressCache.size > 600) this.progressCache.clear();
      this.progressCache.set(memoKey, {generation, at: Date.now(), value: computed});
    }
    return computed;
  }

  computePageProgress(item,attachmentID) {
    const entry=this.entry(item);let old;
    const id=attachmentID??entry.readingAttachmentID;
    const bucket=id&&entry.readingAttachments?.[String(id)];
    // The page the reader was last on, when it was recorded: where 이어 읽기 goes back to.
    if(bucket)return {...this.workspaceTools.progress(bucket),attachmentID:Number(id),lastPageIndex:Number.isInteger(bucket.lastPageIndex)?bucket.lastPageIndex:null};
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
  async starTagItems(libraryID) {
    const found = [];
    for (const item of await this.libraryItems(libraryID)) {
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
  ratingTagOf(item) {
    for (const tag of item?.getTags?.() || []) {
      const match = /^style-custom:rating:([0-5])$/.exec(String(tag?.tag ?? tag));
      if (match) return Number(match[1]);
    }
    return null;
  }

  async visibleRatingTagItems(libraryID) {
    const found = [];
    for (const item of await this.libraryItems(libraryID)) {
      if (!this.isRegular(item)) continue;
      if (this.ratingTagOf(item) !== null) found.push(item);
    }
    return found;
  }

  // Eight attachments in this library carry a rating tag, because the rating was
  // set while the attachment row was selected. An attachment has no Extra field
  // to move it into, so a child's rating goes to its parent paper -- where the
  // Rating column actually shows it -- and the stray tag goes. A standalone
  // attachment has no parent and is not a paper, so its tag is reported and left
  // alone rather than quietly thrown away.
  async strayRatingTags(libraryID) {
    const children = [], orphans = [];
    for (const item of await this.libraryItems(libraryID)) {
      if (this.isRegular(item)) continue;
      const rating = this.ratingTagOf(item);
      if (rating === null) continue;
      let parent = null;
      try {
        const id = item.parentItemID ?? item.parentID;
        if (id) parent = await this.Z.Items.getAsync(id);
      } catch (error) { this.Z.logError(error); }
      if (parent && this.isRegular(parent)) children.push({item, parent, rating});
      else orphans.push({item, rating});
    }
    return {children, orphans};
  }

  async moveStrayRatingTags(libraryID) {
    const {children, orphans} = await this.strayRatingTags(libraryID);
    const result = {moved: 0, alreadyRated: 0, skipped: 0, orphans: orphans.length};
    for (const {item, parent, rating} of children) {
      // canEdit answers for papers; an attachment is never one, so it is asked
      // about directly rather than through a check that rejects it by type.
      const writable = item?.isEditable?.() !== false && this.Z.Libraries.get(item.libraryID)?.editable;
      if (!writable || !this.canEdit(parent)) { result.skipped++; continue; }
      const existing = this.state(parent).rating;
      // A rating the user set on the paper itself outranks one set on its PDF.
      if (existing > 0) result.alreadyRated++;
      else { await this.edit([parent], {rating}); result.moved++; }
      const kept = (item.getTags() || []).filter(tag => !/^style-custom:rating:[0-5]$/.test(String(tag?.tag ?? tag)));
      item.setTags(kept);
      if (typeof item.saveTx === 'function') await item.saveTx(); else await item.save();
    }
    return result;
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
      this.paintKind(row,item,state,win);
      if(!this.isRegular(item))continue;
      this.paintVenue(row,item,state,win);
      const cell=row.querySelector('.cell.title');if(!cell)continue;
      const titleText=cell.querySelector('.cell-text');
      if(titleText){
        this.paintTitleMarkup(titleText,item,win);
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
        if(!tags){tags=win.document.createElementNS('http://www.w3.org/1999/xhtml','span');tags.className='style-custom-title-tags';tags.style.cssText='font-size:11px;white-space:nowrap;pointer-events:none;';cell.appendChild(tags);state.titleNodes.add(tags);}
        tags.replaceChildren();const visible=this.displayTags(item).slice(0,this.getSetting('titleTagLimit'));const rating=this.state(item).rating;if(rating)visible.unshift({tag:'★'.repeat(rating),color:null});
        for(const value of visible){const badge=win.document.createElementNS('http://www.w3.org/1999/xhtml','span');badge.textContent=value.tag;badge.title=value.tag;badge.style.marginInlineStart='4px';if(value.color)badge.style.color=value.color;tags.appendChild(badge);}
      }else tags?.remove();
    }
    this.paintHighlights(win,state);
    for(const n of [...state.titleNodes])if(!n.isConnected)state.titleNodes.delete(n);
  }
  /* A long Extra field -- a TLDR and a citation line -- renders taller than the
     row Zotero measured for it, and the rows below draw over its last lines. The
     row is given the height its value actually needs. Measured from the DOM the
     bug showed: value 124px, row 111px, next row starting 11px too early. */
  fixItemPaneRows(doc) {
    let fixed = 0;
    for (const row of doc.querySelectorAll('#zotero-item-pane .meta-row')) {
      const value = row.querySelector('editable-text[multiline], .value');
      if (!value) continue;
      const need = value.getBoundingClientRect?.().height || 0, have = row.getBoundingClientRect?.().height || 0;
      if (need > have + 1) { row.style.minHeight = Math.ceil(need) + 'px'; fixed++; }
      else if (row.style.minHeight && need + 1 < have) row.style.removeProperty('min-height');
    }
    return fixed;
  }
  watchItemPane(win, state) {
    const pane = win.document.getElementById('zotero-item-pane');
    if (!pane || !win.MutationObserver) return;
    let timer = null;
    const schedule = () => { if (timer) win.clearTimeout(timer); timer = win.setTimeout(() => { timer = null; try { this.fixItemPaneRows(win.document); } catch (error) { this.Z.logError(error); } }, 120); };
    const observer = new win.MutationObserver(schedule);
    observer.observe(pane, {subtree: true, childList: true, attributes: true, attributeFilter: ['value', 'hidden', 'open']});
    win.addEventListener('resize', schedule);
    state.listeners.push([win, 'resize', schedule]);
    state.itemPaneObserver = observer;
    schedule();
  }
  // The journal's own name, in its publisher's colour: Science reads red and
  // Cell blue in Zotero's own Publication column, with no second column needed.
  // The previous colour is kept so the cell can be given back as it was.
  paintVenue(row,item,state,win) {
    const cell=row.querySelector('.cell.publicationTitle');
    const text=cell?.querySelector('.cell-text')||cell;
    if(!text)return;
    state.venueColors||=new Map();
    const found=this.featureEnabled('publicationColumn')!==false?this.journalIdentityOf(item):null;
    if(found){
      const P=this.palette(win.document);
      const tone=this.journalIdentity.colours(found.identity,{dark:P.dark});
      if(!state.venueColors.has(text))state.venueColors.set(text,[text.style.color,text.style.fontWeight]);
      text.style.color=tone.ink;
      text.style.fontWeight='600';
      text.dataset.styleCustomVenue=found.identity.family;
    }
    else if(state.venueColors.has(text)){
      const[color,weight]=state.venueColors.get(text);text.style.color=color;text.style.fontWeight=weight;delete text.dataset.styleCustomVenue;state.venueColors.delete(text);
    }
  }
  // Europe PMC hands back every supplementary file of an article as one zip.
  // Nothing is written until the archive is open and its entries are triaged.
  async fetchSupplementary(item, {pdfOnly = false, signal, refetch = false, maxBytes = 200 * 1024 * 1024} = {}) {
    const record = this.bibliographyRecord(item);
    // A paper whose supplement is already on the shelf needs no request. The
    // old check compared publisher filenames, which a file mover renames away,
    // so the twenty-nine supplements this library already holds would all have
    // been fetched again as duplicates.
    if (!refetch) {
      const held = this.attachmentKinds(item).filter(kind => kind.kind === 'supplementary');
      if (held.length) {
        return {status: 'already', added: 0, skipped: held.length,
          reason: `이미 보충자료 ${held.length}개가 있습니다`};
      }
    }
    const url = this.supplementaryTools.searchURL(record, {email: this.contactEmail()});
    if (!url) return {status: 'unsupported', reason: '식별자가 없어 조회할 수 없습니다', added: 0};
    const search = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 20000});
    const article = this.supplementaryTools.pickArticle(search?.response, record);
    if (!article) return {status: 'not-found', reason: 'Europe PMC에서 찾지 못했습니다', added: 0};
    if (article.needsConfirmation) return this.supplementaryCandidate(article);
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

  // A title-only hit that failed the strict check: shown for the user to
  // confirm, never downloaded.
  supplementaryCandidate(article) {
    return {status: 'needs-confirmation', added: 0,
      reason: '제목만 비슷한 논문이라 확인이 필요합니다',
      candidate: {pmcid: article.id, title: article.title, year: article.year, authors: article.authors}};
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
    // A file fetched from the supplementary endpoint needs no scan to know what
    // it is: record the verdict now, so the badge is right the moment it lands
    // rather than after the next sweep.
    if (attachment.id != null) {
      this.fileVerdicts()[String(attachment.id)] = {kind: 'supplementary',
        why: '출판사의 보충자료 파일로 내려받았습니다', duplicateOf: null,
        checkedAt: new Date().toISOString()};
      this.dirty = true;
    }
    try {
      attachment.addTag(this.SUPPLEMENTARY_TAG, 1);
      // Zotero's auto-rename gives every child the parent's title, which makes
      // four different files look like four copies of one. Restore a name that
      // says which file this is; the tag is what survives if it is renamed again.
      if (file) attachment.setField('title', this.supplementaryTools.attachmentTitle(file));
      await attachment.saveTx({skipSelect: true, skipDateModifiedUpdate: true});
    } catch (error) { this.Z.logError(error); }
  }

  /* What a download would actually get, before one is started.

     Measured over this library: of 1,146 papers with a DOI, 697 are in PMC,
     506 of those have supplementary material, and 336 of those are open access
     -- which is the only set whose archive the endpoint will hand over. A sweep
     over everything therefore spends a thousand requests to fetch a few hundred
     files, and says nothing about which. One search request per paper answers
     that first, and costs no downloads at all. */
  async previewSupplementary(items, {signal, onProgress} = {}) {
    const report = {checked: 0, already: 0, noIdentifier: 0, notFound: 0,
      notArchived: 0, noSupplement: 0, closed: 0, available: [], errors: 0};
    const list = [...new Set(items)].filter(item => this.isRegular(item));
    for (const [index, item] of list.entries()) {
      if (signal?.aborted || !this.active || this.stopping) break;
      onProgress?.(index, list.length);
      if (this.attachmentKinds(item).some(kind => kind.kind === 'supplementary')) { report.already++; continue; }
      const record = this.bibliographyRecord(item);
      const url = this.supplementaryTools.searchURL(record, {email: this.contactEmail()});
      if (!url) { report.noIdentifier++; continue; }
      try {
        const search = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 20000});
        report.checked++;
        const article = this.supplementaryTools.pickArticle(search?.response, record);
        if (!article) { report.notFound++; continue; }
        if (article.needsConfirmation) { (report.candidates ||= []).push({id: String(item.id), title: record.title, ...this.supplementaryCandidate(article).candidate}); continue; }
        if (article.source !== 'PMC') { report.notArchived++; continue; }
        if (!article.hasSupplementary) { report.noSupplement++; continue; }
        // Europe PMC hands over the archive only for open-access articles; the
        // rest answer 200 with an XML error, which is a wasted download.
        if (!article.openAccess) { report.closed++; continue; }
        report.available.push({id: String(item.id), title: record.title, pmcid: article.id});
      } catch (error) { this.Z.logError(error); report.errors++; }
    }
    return report;
  }

  async downloadSupplementary(items, {pdfOnly = false, refetch = false, onProgress} = {}) {
    const totals = {ok: 0, added: 0, none: 0, 'not-found': 0, unsupported: 0, error: 0, already: 0};
    const failures = [];
    for (const [index, item] of items.entries()) {
      onProgress?.(index, items.length, item);
      try {
        const result = await this.fetchSupplementary(item, {pdfOnly, refetch});
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
    const extra = field('extra'), url = field('url');
    const pmcid = (/^\s*PMCID:\s*(PMC\d+)/im.exec(extra) || /ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+)/i.exec(url) || [])[1] || '';
    return {
      pmid: base.pmid ? String(base.pmid) : '', pmcid,
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
    if (!translators?.length) throw new Error('이 식별자를 읽을 수 있는 번역기가 없습니다. DOI·PMID·arXiv 번호 중 하나로 다시 시도하세요.');
    translate.setTranslator(translators);
    const saved = await translate.translate({
      libraryID: libraryID ?? this.Z.Libraries.userLibraryID,
      collections: collections?.length ? collections : undefined,
      saveAttachments: true
    });
    if (!saved?.length) throw new Error('가져오지 못했습니다. 잠시 뒤 다시 시도하세요.');
    return saved;
  }

  /* Zotero's own PDF finder for one paper: open-access sources and the
     institution's resolvers, as the item menu's "Find Available PDF".
     Opens no window; the caller reports found / none. */
  async findPDF(itemID) {
    const item = this.Z.Items.get(Number(itemID));
    if (!item || !this.isRegular(item)) return {status: 'none'};
    if (typeof this.Z.Attachments?.addAvailablePDF !== 'function') return {status: 'unsupported'};
    const attachment = await this.Z.Attachments.addAvailablePDF(item);
    return {status: attachment ? 'found' : 'none', attachment: attachment || null};
  }

  /* 자료 정리: the clean-up list. Two kinds of paper held more than once.
     (1) A preprint whose published version is also on the shelf: the reader
     keeps the published one; mergePreprintIntoPublished carries tags, status,
     rating, memo and notes over, relates the two, and trashes the preprint
     (Zotero's trash and the panel's 8 s strip both undo it).
     (2) The same DOI, or the same title and year, held twice or more; those are
     listed and shown in Zotero's own Duplicate Items pane, never merged here. */
  static duplicateGroups(records) {
    const tools = typeof CustomStylePaperSignals !== "undefined" ? CustomStylePaperSignals : require("./paper-signals.js");
    // Markup in a title ("<i>E. coli</i>") is not part of the words being compared.
    const flat = value => String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(?:[a-z]+|#\d+);/gi, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const parent = new Map();
    const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
    const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(x, y); };
    const doiOf = row => String(row.doi || '').trim().toLowerCase();
    const isPre = row => tools.PREPRINT_PREFIXES.test(doiOf(row));
    const byDOI = new Map(), byTitle = new Map(), via = new Map();
    for (const row of records || []) {
      parent.set(row.id, row.id);
      const doi = doiOf(row);
      if (doi) { if (byDOI.has(doi)) { join(row.id, byDOI.get(doi)); via.set(row.id, 'doi'); via.set(byDOI.get(doi), 'doi'); } else byDOI.set(doi, row.id); }
      const title = flat(row.title);
      if (title.split(' ').filter(word => word.length > 2).length >= 4) {
        for (const other of byTitle.get(title) || []) {
          // Two different DOIs are two different papers, unless one is the preprint of the other.
          const pair = isPre(row) !== isPre(other);
          if (doiOf(row) && doiOf(other) && doiOf(row) !== doiOf(other) && !pair) continue;
          // A blank year matches any year; a preprint and its article may be a year or two apart.
          const ya = Number(row.year), yb = Number(other.year);
          if (ya && yb && Math.abs(ya - yb) > (pair ? 2 : 0)) continue;
          join(row.id, other.id);
          if (!via.has(row.id)) via.set(row.id, 'title'); if (!via.has(other.id)) via.set(other.id, 'title');
        }
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(row);
      }
    }
    const groups = new Map();
    for (const row of records || []) { const root = find(row.id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(row); }
    return [...groups.values()].filter(rows => rows.length > 1).map(rows => ({
      reason: rows.some(row => via.get(row.id) === 'doi') ? 'doi' : 'title', items: rows
    })).sort((a, b) => b.items.length - a.items.length || String(a.items[0].title).localeCompare(String(b.items[0].title)));
  }
  /* Two things in the tags that no automatic rule should settle for the reader:
     a paper carrying more than one of /unread /reading /done, and a rating tag on
     a standalone attachment (no paper to move it to). Found read-only; each has a
     repair the reader presses (fixStatusTags, removeOrphanRatingTags). */
  async tagFindings(libraryID) {
    const status = [], ratingTags = [];
    const field = (item, key) => { try { return String(item.getField?.(key) || '').trim(); } catch (_) { return ''; } };
    for (const item of await this.libraryItems(libraryID)) {
      if (!item || item.deleted) continue;
      let tags = [];
      try { tags = (item.getTags?.() || []).map(tag => String(tag?.tag ?? tag)); } catch (_) {}
      if (this.isRegular(item)) {
        const kinds = new Set(tags.map(tag => /^\/(unread|reading|done)$/i.exec(tag.trim())?.[1]?.toLowerCase()).filter(Boolean));
        if (kinds.size > 1) status.push({id: String(item.id), title: field(item, 'title'), year: field(item, 'date').match(/\b(1[5-9]|20)\d{2}\b/)?.[0] || '',
          tags: [...kinds].map(kind => '/' + kind), shown: this.state(item).status});
      } else if (!(item.parentItemID ?? item.parentID) && tags.some(tag => /^style-custom:rating:[0-5]$/.test(tag))) {
        ratingTags.push({id: String(item.id), key: item.key, title: field(item, 'title') || String(item.key || item.id), year: '',
          tags: tags.filter(tag => /^style-custom:rating:[0-5]$/.test(tag))});
      }
    }
    return {status, ratingTags};
  }
  // Keep the state the plugin shows now, drop the other status tags (edit() writes one status tag and removes the rest).
  async fixStatusTags(ids) {
    const byStatus = new Map();
    for (const id of ids || []) {
      const item = await this.Z.Items.getAsync(Number(id));
      if (!this.canEdit(item)) continue;
      const status = this.state(item).status;
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(item);
    }
    let fixed = 0;
    for (const [status, items] of byStatus) { await this.edit(items, {status}); fixed += items.length; }
    return {fixed};
  }
  // A rating tag on an attachment with no parent paper has nowhere to go; the reader chose to delete it.
  async removeOrphanRatingTags(ids) {
    let removed = 0;
    for (const id of ids || []) {
      const item = await this.Z.Items.getAsync(Number(id));
      // A standalone attachment only: a note or an annotation is not what the finding named, and a trashed one is left alone.
      if (!item || item.deleted || this.isRegular(item) || item.isNote?.() || item.isAnnotation?.() || (item.parentItemID ?? item.parentID) || item.isEditable?.() === false) continue;
      const before = [...(item.getTags() || [])];
      const kept = before.filter(tag => !/^style-custom:rating:[0-5]$/.test(String(tag?.tag ?? tag)));
      if (kept.length === before.length) continue;
      item.setTags(kept);
      // A save that fails puts the tags back in memory, so a later save of this item cannot write the removal after all.
      try { if (typeof item.saveTx === 'function') await item.saveTx(); else await item.save(); }
      catch (error) { try { item.setTags(before); } catch (_) {} throw error; }
      removed++;
    }
    return {removed};
  }
  async cleanupFindings(libraryID) {
    const items = (await this.libraryItems(libraryID)).filter(item => this.isRegular(item) && !item.deleted);
    const field = (item, key) => { try { return String(item.getField?.(key) || '').trim(); } catch (_) { return ''; } };
    const bare = value => this.discoverTools.bareDOI(value);
    const record = item => ({id: String(item.id), title: field(item, 'title'), year: field(item, 'date').match(/\b(1[5-9]|20)\d{2}\b/)?.[0] || '', doi: bare(field(item, 'DOI')) || ''});
    const byDOI = new Map();
    for (const item of items) { const doi = bare(field(item, 'DOI')); if (doi && !byDOI.has(doi)) byDOI.set(doi, item); }
    const merge = [];
    for (const item of items) {
      const published = this.signalsOf(item)?.published;
      if (!published?.doi) continue;
      const held = byDOI.get(bare(published.doi));
      if (!held || held.id === item.id) continue;
      merge.push({...record(item), publishedID: String(held.id), publishedTitle: field(held, 'title'), linked: this._isLinked(item, held)});
    }
    const mergeIDs = new Set(merge.map(row => row.id));
    // A preprint offered for merging is not also reported as a copy of itself.
    const copies = this.constructor.duplicateGroups(items.map(record)).map(group => ({
      ...group, items: group.items.filter(row => !mergeIDs.has(row.id) || group.items.every(other => mergeIDs.has(other.id)))
    })).filter(group => group.items.length > 1);
    // A preprint and a journal article found by title, with no stored published-version signal,
    // belong in the merge list too, not only in "held more than once".
    const byID = new Map(items.map(item => [String(item.id), item]));
    const rest = [];
    for (const group of copies) {
      const pre = group.items.filter(row => this._isPreprintItem(byID.get(row.id)));
      const art = group.items.filter(row => !this._isPreprintItem(byID.get(row.id)));
      if (!pre.length || !art.length) { rest.push(group); continue; }
      for (const row of pre) {
        if (mergeIDs.has(row.id)) continue;
        const target = byID.get(art[0].id);
        merge.push({...row, publishedID: art[0].id, publishedTitle: field(target, 'title'), linked: this._isLinked(byID.get(row.id), target)});
        mergeIDs.add(row.id);
      }
      if (art.length > 1) rest.push({...group, items: art});
    }
    return {merge, copies: rest};
  }
  // What a merge did, kept so the undo can reverse exactly that and nothing else.
  mergeLedger() {
    const store = this.cache.mergeUndo;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.mergeUndo = {});
  }
  _isPreprintItem(item) {
    // Zotero's own item type is the first and strongest evidence; a DOI prefix only speaks for an item of another type.
    if (String(item?.itemType || '') === 'preprint') return true;
    const doi = this.signalTools.bareDOI(String(item?.getField?.('DOI') || ''));
    if (doi && this.signalTools.PREPRINT_PREFIXES.test(doi)) return true;
    try { return !!this.signalsOf?.(item)?.preprint; } catch (_) { return false; }
  }
  /* One merge or undo at a time per preprint: two of them interleaving
     overwrote the undo ledger (the second saw the children already moved and
     recorded none), and undo then left them on the published item. */
  _mergeSerial(preprintID, job) {
    const queues = this._mergeQueues || (this._mergeQueues = new Map()), key = String(preprintID);
    const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(job);
    queues.set(key, run);
    const clear = () => { if (queues.get(key) === run) queues.delete(key); };
    run.then(clear, clear);
    return run;
  }
  mergePreprintIntoPublished(preprintID, options = {}) {
    return this._mergeSerial(preprintID, () => this._mergePreprintIntoPublished(preprintID, options));
  }
  async _mergePreprintIntoPublished(preprintID, {publishedID} = {}) {
    const preprint = this.Z.Items.get(Number(preprintID));
    // State is read when this job's turn comes, not when it was asked for: an earlier merge may have finished meanwhile.
    if (preprint && preprint.deleted && this.mergeLedger()[String(preprint.id)]) throw new Error('이 프리프린트는 이미 게재본에 합쳐졌습니다. 되돌리려면 휴지통에서 복원하세요.');
    // Zotero's own trash restore leaves a ledger behind with the preprint back in the library: undo it first, then this merge may run again.
    if (preprint && !preprint.deleted && this.mergeLedger()[String(preprint.id)]) await this._undoMerge(this.mergeLedger()[String(preprint.id)], {untrash: false});
    if (!preprint || !this.isRegular(preprint)) throw new Error('프리프린트를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 시도하세요.');
    const given = publishedID != null ? this.Z.Items.get(Number(publishedID)) : null;
    const held = given && this.isRegular(given) && !given.deleted ? given : (await this.publishedStatus(preprint))?.held;
    if (!held || held.id === preprint.id) throw new Error('게재본이 이 라이브러리에 없어 합칠 수 없습니다. 게재본을 먼저 라이브러리에 추가하세요.');
    if (held.libraryID !== preprint.libraryID) throw new Error('게재본이 다른 라이브러리에 있어 합치지 못했습니다. 같은 라이브러리로 옮긴 뒤 다시 시도하세요.');
    if (this._isPreprintItem(held)) throw new Error('게재본으로 찾은 항목도 프리프린트입니다. 실제 게재본을 라이브러리에 추가한 뒤 합치세요.');
    if (!this.canEdit(preprint) || !this.canEdit(held)) throw new Error('이 라이브러리는 편집할 수 없습니다. 편집할 수 있는 라이브러리에서 시도하세요.');
    const copied = {tags: 0, notes: 0, files: 0, collections: 0, related: 0, memo: false, status: null, rating: null};
    const rec = {preprint: preprint.id, held: held.id, children: [], tags: [], collections: [], related: [], linked: false, replaces: '', memo: null, status: null, rating: null};
    const isMemoNote = note => (note.getTags?.() || []).some(tag => tag.tag === this.constructor.MEMO_NOTE_TAG);
    const childIDs = () => [...new Set([...(preprint.getAttachments?.() || []), ...(preprint.getNotes?.() || [])])];
    const isStatus = tag => /^\/(unread|reading|done)$/i.test(String(tag).trim());
    let mergeToken, memoPersisted = false;
    try {
      // Files, their annotations and the user's notes MOVE to the published item:
      // the trash is emptied after 30 days and must never hold the only copy.
      // Done first, so a failure here leaves nothing else touched.
      for (const id of childIDs()) {
        const child = this.Z.Items.get(Number(id));
        if (!child || child.deleted || (child.isNote?.() && isMemoNote(child))) continue;
        const before = child.parentItemID ?? preprint.id;
        child.parentItemID = held.id;
        try { await child.saveTx(); } catch (error) { child.parentItemID = before; throw error; }
        rec.children.push({id: child.id, from: preprint.id, note: !!child.isNote?.()});
        if (child.isNote?.()) copied.notes++; else copied.files++;
      }
      const movedIDs = new Set(rec.children.map(child => Number(child.id)));
      // The plugin's own memo mirror is the only child allowed to go with the preprint (its text is carried below).
      const stuck = childIDs().filter(id => !movedIDs.has(Number(id))).map(id => this.Z.Items.get(Number(id)))
        .filter(child => child && !child.deleted && !(child.isNote?.() && isMemoNote(child)));
      if (stuck.length) throw new Error('프리프린트의 첨부파일·노트 일부를 옮기지 못해 합치지 않았습니다. 아무것도 휴지통으로 보내지 않았으니 Zotero에서 확인한 뒤 다시 시도하세요.');
      // Reading time, per-page records and the resume position go with the files, before anything that can still fail.
      rec.preprintKey = this.identity(preprint);
      rec.reading = this._moveReading(preprint, held);

      const have = new Set(held.getTags().map(tag => tag.tag));
      const carry = preprint.getTags().filter(tag => !have.has(tag.tag) && !isStatus(tag.tag) && tag.tag !== this.constructor.MEMO_NOTE_TAG);
      if (carry.length) { held.setTags([...held.getTags(), ...carry.map(tag => ({tag: tag.tag, type: tag.type || 0}))]); copied.tags = carry.length; rec.tags = carry.map(tag => tag.tag); }
      for (const id of preprint.getCollections?.() || []) {
        if (held.inCollection?.(id)) continue;
        held.addToCollection(id); rec.collections.push(id); copied.collections++;
      }
      for (const key of [...(preprint.relatedItems || [])]) {
        if (key === held.key || held.relatedItems?.includes?.(key)) continue;
        const other = this.Z.Items.getByLibraryAndKey?.(preprint.libraryID, key);
        if (!other || other.deleted || other.id === held.id) continue;
        held.addRelatedItem(other); other.addRelatedItem(held); await other.saveTx();
        rec.related.push(key); copied.related++;
      }
      const linked = !this._isLinked(preprint, held);
      if (linked) { preprint.addRelatedItem(held); held.addRelatedItem(preprint); await preprint.saveTx(); rec.linked = true; }
      const uri = this.Z.URI?.getItemURI?.(preprint);
      if (uri && typeof held.addRelation === 'function' && !(held.getRelationsByPredicate?.('dc:replaces') || []).includes(uri)) { held.addRelation('dc:replaces', uri); rec.replaces = uri; }
      if (carry.length || linked || rec.collections.length || rec.related.length || rec.replaces) await held.saveTx();
      const rank = {unread: 0, reading: 1, done: 2};
      const from = this.state(preprint), to = this.state(held);
      const patch = {};
      if (rank[from.status] > rank[to.status]) { patch.status = from.status; copied.status = from.status; rec.status = {before: to.status, after: from.status}; }
      if (from.rating > 0 && !(to.rating > 0)) { patch.rating = from.rating; copied.rating = from.rating; rec.rating = {before: to.rating || 0, after: from.rating}; }
      if (Object.keys(patch).length) await this.edit([held], patch);
      const memo = String(this.entry(preprint).remark || ''), mine = String(this.entry(held).remark || '');
      if (memo && memo !== mine && !mine.includes(memo)) {
        const after = mine ? mine + '\n\n' + memo : memo;
        const noteBefore = this.memoNoteOf(held), htmlBefore = noteBefore ? String(noteBefore.getNote()) : null, syncedBefore = this.entry(held).memoSynced;
        // The merged text is only in memory until it is saved: the paper is pending from before it is set until it is saved or rolled back.
        // One pending token for the whole merge: it is released in the outer finally, after any rollback (an editor must not see "settled" while the memo is still going back).
        mergeToken = this._memoPending(held, 1, mine, after);
        {
          this.entry(held).remark = after; this._memoBump(this.entry(held)); copied.memo = true; rec.memo = {before: mine, after, rev: this.entry(held).memoRev || 0};
          await this.flush();
          memoPersisted = true; // from here on a failure is a note or sync problem: the memo is saved and is never rolled back
          if (this.getSetting('memoToNote')) {
            const wrote = await this.memoToNote(held);
            // What the note was, and what the merge made it, so undo can put the note and its sync baseline back with the memo.
            const noteAfter = this.memoNoteOf(held);
            // `after` is exactly the HTML the merge submitted, never what the note holds when the save returns (an outside edit may be in it): undo restores only a note that still equals it.
            if (noteAfter && wrote?.wrote) rec.memo.note = {id: noteAfter.id, created: !noteBefore, before: htmlBefore, after: String(wrote.html), syncedBefore: syncedBefore === undefined ? null : syncedBefore, syncedAfter: this.entry(held).memoSynced ?? null};
          }
        }
      }
    } catch (error) {
      // Nothing was trashed; put back whatever was already moved or copied.
      // The merge owns only the revision of its own remark write (rec.memo.rev); once the memo is saved it owns nothing more.
      try { await this._undoMerge(rec, {untrash: false, skipMemo: memoPersisted, ownedMemoRev: rec.memo?.rev}); } catch (undoError) { this.Z.logError?.(undoError); }
      throw error;
    } finally { if (mergeToken !== undefined) this._memoPending(held, -1, undefined, undefined, mergeToken); }
    this.mergeLedger()[String(preprint.id)] = rec; this.dirty = true;
    try { await this.flush(); } catch (_) {}
    preprint.deleted = true;
    await preprint.saveTx();
    this.bumpState?.();
    await this.refreshWindows();
    return {published: held, preprint, copied};
  }
  /* Undo puts the memo and its note back exactly as the merge recorded them, but only when neither
     moved since. If either did, nothing is picked for the user: both texts go into the conflict box. */
  async _undoMemo(held, memo, {ownedRev} = {}) {
    // Returns true only when the memo and its note are both back exactly as before the merge.
    const norm = this.constructor.memoNorm, row = this.entry(held), saved = memo.note;
    // The memo is changed in memory before it is saved: the paper is pending until undo has saved it or given up.
    const pendingToken = this._memoPending(held, 1, String(row.remark ?? ''), memo.before);
    try {
    // A rollback of a failed merge restores only what the merge still owns: if the memo was saved since (its revision moved), that save stands.
    if (ownedRev !== undefined && (row.memoRev || 0) !== ownedRev) return false;
    // A note undo had trashed and could not bring back (its compensation save failed) is brought back first, on any retry.
    if (saved && saved.pendingUndelete) {
      const trashed = this.Z.Items.get(Number(saved.id));
      if (trashed && trashed.deleted) {
        try { trashed.deleted = false; await trashed.saveTx(); } catch (error) { trashed.deleted = true; this.Z.logError?.(error); return false; }
      }
      saved.pendingUndelete = false;
    }
    const note = saved ? this.Z.Items.get(Number(saved.id)) : this.memoNoteOf(held);
    const live = note && !note.deleted ? note : null;
    const there = live ? this.constructor.memoFromNoteHTML(live.getNote()) : '';
    const memoSame = String(row.remark || '') === memo.after;
    if (!saved) {
      if (!memoSame) return false;
      row.remark = memo.before; this._memoBump(row);
      if (row.memoConflict) {
        if (!live) delete row.memoConflict;
        else {
          const situation = this._memoSituation(row, there, row.memoSynced);
          if (situation === 'push') delete row.memoConflict; else this._memoNoWrite(row, live, situation);
        }
      }
      this._memoBump(row); await this.flush(); return !row.memoConflict;
    }
    let restoredAll = false;
    const noteSame = !!live && String(live.getNote()) === saved.after;
    if (memoSame && noteSame) {
      const id = this.identity(held), inflight = this.memoInflight || (this.memoInflight = new Map());
      const rev0 = row.memoRev || 0; // anything that changes the memo, baseline or conflict during the awaits below bumps it
      inflight.set(id, norm(saved.created ? '' : this.constructor.memoFromNoteHTML(saved.before)));
      let editedMeanwhile = false;
      try {
        if (saved.created) live.deleted = true; else live.setNote(saved.before);
        await live.saveTx();
        // A note undo created is deleted only if nobody touched it: read after the await, against what the merge wrote.
        if (saved.created && String(live.getNote()) !== saved.after) {
          editedMeanwhile = true;
          // What the note holds is read before anything else is attempted: it is the conflict's remote side whatever happens next.
          saved.editedNote = String(live.getNote());
          saved.pendingUndelete = true;
          try { live.deleted = false; await live.saveTx(); saved.pendingUndelete = false; }
          catch (error) { live.deleted = true; this.Z.logError?.(error); } // still in the trash: the ledger remembers, a retry brings it back first
        }
      } finally { inflight.delete(id); }
      // Only a note that reads back as exactly what undo restored may set the baseline; anything else was written by someone else.
      // (A note edit made during that save reaches mirrorMemoNote, which waits for this job and judges it afterwards.)
      const restored = saved.created ? !editedMeanwhile : String(live.getNote()) === saved.before;
      const moved = (row.memoRev || 0) !== rev0; // a memo saved meanwhile is the newest word, whatever text it holds
      if (!restored) {
        // The note was edited while undo saved it: that edit stays, the old baseline stays, and both current sides wait in the conflict box.
        if (!moved && String(row.remark || '') === memo.after) row.remark = memo.before;
        const now = editedMeanwhile && saved.editedNote !== undefined ? this.constructor.memoFromNoteHTML(saved.editedNote) : this.constructor.memoFromNoteHTML(live.getNote()), local = String(row.remark || '');
        if (norm(local) === norm(now)) this._memoSetBase(row, now, live);
        else row.memoConflict = {local, remote: now, at: new Date().toISOString()};
      } else if (!moved && String(row.remark || '') === memo.after) {
        row.remark = memo.before; delete row.memoConflict; restoredAll = true;
        if (saved.syncedBefore === null) { delete row.memoSynced; delete row.memoSyncedVer; } else row.memoSynced = saved.syncedBefore;
      } else {
        // A memo was saved while the note was put back: it stays, and the baseline is the note as it now is.
        if (saved.created) { delete row.memoSynced; delete row.memoSyncedVer; delete row.memoConflict; }
        else this._memoSetBase(row, this.constructor.memoFromNoteHTML(live.getNote()), live);
      }
      this._memoBump(row);
    } else if (norm(String(row.remark || '')) !== norm(there)) {
      row.memoConflict = {local: String(row.remark || ''), remote: there, at: new Date().toISOString()}; this._memoBump(row);
    }
    await this.flush();
    return restoredAll;
    } finally { this._memoPending(held, -1, undefined, undefined, pendingToken); }
  }
  /* The preprint's reading history moves to the published item: seconds, the per-page
     record of each file, the page to resume at and the last-read time. Moved, not
     copied, so the two never count the same minutes. A record the published item
     already holds for the same file is merged page by page (the larger figure wins:
     it is the same reading) and is not added a second time to the seconds.
     Returns what the undo needs, or null when there was nothing to move. */
  _moveReading(preprint, held) {
    const pe = this.entry(preprint), he = this.entry(held);
    const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const secondsOf = (item, e) => { if (Number.isFinite(e.seconds)) return num(e.seconds); try { return num(this.metrics(item).seconds); } catch (_) { return 0; } };
    const pages = b => Object.values(b?.pageTimes || {}).reduce((a, v) => a + num(v), 0);
    const buckets = clone(pe.readingAttachments) || {};
    if (pe.pageTimes && pe.readingAttachmentID && !buckets[String(pe.readingAttachmentID)]) {
      buckets[String(pe.readingAttachmentID)] = {pageTimes: clone(pe.pageTimes), totalPages: Number(pe.totalPages) || 0, lastRead: pe.lastRead};
    }
    const preSeconds = secondsOf(preprint, pe);
    if (!preSeconds && !Object.keys(buckets).length && !pe.lastRead) return null;
    const r = {
      seconds: 0, ids: Object.keys(buckets),
      preBefore: {seconds: clone(pe.seconds), lastRead: clone(pe.lastRead), readingAttachments: clone(pe.readingAttachments), readingAttachmentID: clone(pe.readingAttachmentID),
        pageTimes: clone(pe.pageTimes), totalPages: clone(pe.totalPages), metricsSeconds: clone(pe.metrics?.seconds)},
      heldBefore: {seconds: clone(he.seconds), lastRead: clone(he.lastRead), readingAttachmentID: clone(he.readingAttachmentID), buckets: {}},
      heldBase: secondsOf(held, he)
    };
    let overlap = 0;
    he.readingAttachments ||= {};
    for (const [id, bucket] of Object.entries(buckets)) {
      const mine = he.readingAttachments[id];
      r.heldBefore.buckets[id] = clone(mine) ?? null;
      if (!mine) { he.readingAttachments[id] = bucket; continue; }
      overlap += pages(mine);
      const pt = {...(mine.pageTimes || {})};
      for (const [page, v] of Object.entries(bucket.pageTimes || {})) pt[page] = Math.max(num(pt[page]), num(v));
      const later = Date.parse(bucket.lastRead || '') > Date.parse(mine.lastRead || '') ? bucket : mine;
      he.readingAttachments[id] = {...mine, pageTimes: pt, totalPages: Math.max(Number(mine.totalPages) || 0, Number(bucket.totalPages) || 0),
        ...(later.lastRead ? {lastRead: later.lastRead} : {}), ...(Number.isInteger(later.lastPageIndex) ? {lastPageIndex: later.lastPageIndex} : {})};
    }
    r.seconds = Math.max(0, preSeconds - Math.min(preSeconds, overlap));
    he.seconds = r.heldBase + r.seconds;
    const newer = Date.parse(pe.lastRead || '') > Date.parse(he.lastRead || '');
    if (pe.lastRead && (newer || !he.lastRead)) he.lastRead = pe.lastRead;
    if (pe.readingAttachmentID && (newer || !he.readingAttachmentID)) he.readingAttachmentID = pe.readingAttachmentID;
    r.after = {seconds: he.seconds, lastRead: he.lastRead, readingAttachmentID: he.readingAttachmentID};
    pe.seconds = 0; if (pe.metrics) pe.metrics.seconds = 0;
    for (const key of ['readingAttachments', 'pageTimes', 'totalPages', 'readingAttachmentID', 'lastRead']) delete pe[key];
    this.dirty = true; this.bumpState?.();
    return r;
  }
  _undoReading(preprint, held, r) {
    const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    const put = (e, key, value) => { if (value === undefined) delete e[key]; else e[key] = clone(value); };
    const he = held ? this.entry(held) : null, pe = preprint ? this.entry(preprint) : null;
    const moved = {};
    if (he) {
      // Reading done since the merge stays where it was done; only what the merge added comes off.
      he.seconds = Math.max(0, (Number.isFinite(he.seconds) ? he.seconds : r.after.seconds) - r.seconds);
      if (he.lastRead === r.after.lastRead) put(he, 'lastRead', r.heldBefore.lastRead);
      if (he.readingAttachmentID === r.after.readingAttachmentID) put(he, 'readingAttachmentID', r.heldBefore.readingAttachmentID);
      for (const id of r.ids) {
        const current = he.readingAttachments?.[id], before = r.heldBefore.buckets[id];
        if (current) moved[id] = current;
        if (before) { he.readingAttachments[id] = clone(before); } else if (he.readingAttachments) delete he.readingAttachments[id];
      }
      if (he.readingAttachments && !Object.keys(he.readingAttachments).length && !r.heldBefore.hadBuckets) delete he.readingAttachments;
    }
    if (pe) {
      const b = r.preBefore;
      put(pe, 'seconds', b.seconds); put(pe, 'lastRead', b.lastRead); put(pe, 'readingAttachmentID', b.readingAttachmentID);
      put(pe, 'pageTimes', b.pageTimes); put(pe, 'totalPages', b.totalPages);
      if (pe.metrics && b.metricsSeconds !== undefined) pe.metrics.seconds = b.metricsSeconds;
      const restored = clone(b.readingAttachments) || {};
      for (const id of r.ids) {
        // A file nobody else had a record for goes back as it now stands (with any reading done since); a shared one goes back as it was.
        if (moved[id] && !r.heldBefore.buckets[id]) restored[id] = clone(moved[id]);
        else if (!restored[id] && moved[id]) restored[id] = clone(moved[id]);
      }
      if (Object.keys(restored).length) pe.readingAttachments = restored; else delete pe.readingAttachments;
    }
    this.dirty = true; this.bumpState?.();
  }
  async _undoMerge(rec, {untrash = true, ownedMemoRev, skipMemo = false} = {}) {
    const get = id => this.Z.Items.get(Number(id));
    const held = get(rec.held), preprint = get(rec.preprint);
    let memoRestored = true;
    for (const child of [...rec.children].reverse()) {
      const item = get(child.id);
      if (item && held && item.parentItemID === held.id) { item.parentItemID = child.from; await item.saveTx(); }
    }
    if (held) {
      let changed = false;
      if (rec.tags.length) { held.setTags(held.getTags().filter(tag => !rec.tags.includes(tag.tag))); changed = true; }
      for (const id of rec.collections) { held.removeFromCollection?.(id); changed = true; }
      for (const key of rec.related) {
        const other = this.Z.Items.getByLibraryAndKey?.(held.libraryID, key);
        held.removeRelatedItem?.(other || {key}); changed = true;
        if (other) { other.removeRelatedItem?.(held); await other.saveTx(); }
      }
      if (rec.linked && preprint) { held.removeRelatedItem?.(preprint); preprint.removeRelatedItem?.(held); await preprint.saveTx(); changed = true; }
      if (rec.replaces) { held.removeRelation?.('dc:replaces', rec.replaces); changed = true; }
      if (changed) await held.saveTx();
      const patch = {};
      if (rec.status && this.state(held).status === rec.status.after) patch.status = rec.status.before;
      if (rec.rating && this.state(held).rating === rec.rating.after) patch.rating = rec.rating.before;
      if (Object.keys(patch).length) await this.edit([held], patch);
      if (rec.memo && !skipMemo) memoRestored = await this._memoSerial(held, () => this._undoMemo(held, rec.memo, {ownedRev: ownedMemoRev}));
    }
    if (rec.reading) { this._undoReading(preprint, held, rec.reading); rec.reading = null; }
    if (untrash && preprint?.deleted) { preprint.deleted = false; await preprint.saveTx(); }
    // A memo or note that undo could not put back (edited meanwhile) keeps the ledger: the record of what the merge did is not thrown away.
    if (memoRestored) { delete this.mergeLedger()[String(rec.preprint)]; } else rec.memoUnrestored = true;
    this.dirty = true;
    try { await this.flush(); } catch (_) {}
  }
  restorePreprint(preprintID) { return this._mergeSerial(preprintID, () => this._restorePreprint(preprintID)); }
  async _restorePreprint(preprintID) {
    const item = this.Z.Items.get(Number(preprintID));
    if (!item) return false;
    const rec = this.mergeLedger()[String(item.id)];
    // The ledger decides, not the trash flag: Zotero's own restore may have run already.
    if (rec) await this._undoMerge(rec, {untrash: !!item.deleted});
    else if (item.deleted) { item.deleted = false; await item.saveTx(); }
    else return false;
    this.bumpState?.(); await this.refreshWindows();
    return true;
  }
  // The main window's own Duplicate Items pane; no window of ours opens.
  async showInDuplicatesPane(win, libraryID, ids) {
    const pane = win?.ZoteroPane;
    if (!pane || typeof pane.setVirtual !== 'function') throw new Error('Zotero 중복 항목 보기를 쓸 수 없습니다. Zotero를 다시 시작한 뒤 시도하세요.');
    await pane.setVirtual(libraryID, 'duplicates', true, true);
    try { await pane.itemsView?.waitForLoad?.(); } catch (_) {}
    let selected = false;
    try { if (typeof pane.selectItems === 'function') selected = !!(await pane.selectItems((ids || []).map(Number).filter(Number.isFinite))); } catch (_) {}
    return {selected};
  }
  // Zotero's "Find Available PDF" over a list, one at a time; cancelled between papers.
  async findPDFs(ids, {signal, onProgress} = {}) {
    const result = {found: 0, none: 0, failed: 0, cancelled: false, unsupported: false, done: 0, total: ids.length};
    for (const id of ids) {
      onProgress?.(result.done, ids.length, id);
      if (signal?.aborted) { result.cancelled = true; break; }
      try {
        const out = await this.findPDF(id);
        if (out.status === 'unsupported') { result.unsupported = true; break; }
        if (out.status === 'found') result.found++; else result.none++;
      } catch (error) { result.failed++; this.Z.logError?.(error); }
      result.done++;
    }
    if (result.found) { this.bumpState?.(); await this.refreshWindows?.(); }
    return result;
  }

  /* The paper already on the shelf for a work about to be imported: by DOI,
     else by title when the title is long enough to be evidence (four words)
     and neither side's year or DOI disagrees. Same rule ZotPoP applies. */
  async findExistingWork(libraryID, work) {
    const bare = value => this.discoverTools.bareDOI(value);
    const flat = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const field = (item, key) => { try { return String(item.getField(key) || '').trim(); } catch (_) { return ''; } };
    const doi = bare(work?.doi), title = flat(work?.title);
    const items = (await this.libraryItems(libraryID)).filter(item => this.isRegular(item));
    if (doi) { const hit = items.find(item => bare(field(item, 'DOI')) === doi); if (hit) return hit; }
    const words = title.split(' ').filter(w => /[^a-z0-9]/.test(w) ? w.length >= 2 : w.length > 2);
    if (words.length < 4) return null;
    const year = String(work?.year || '').match(/\b(1[5-9]|20)\d{2}\b/)?.[0];
    return items.find(item => {
      if (flat(field(item, 'title')) !== title) return false;
      const theirs = field(item, 'date').match(/\b(1[5-9]|20)\d{2}\b/)?.[0];
      if (year && theirs && theirs !== year) return false;
      const theirDOI = bare(field(item, 'DOI'));
      return !(doi && theirDOI && theirDOI !== doi);
    }) || null;
  }

  /* Newly imported papers inherit the reading state a fresh item has and land
     in the collection selected behind the panel -- which the result names
     (collectionName), so the caller can say where it went. A paper already
     held is reported (existing) and not imported twice. */
  // `target.libraryID` pins the library (a published version goes where its
  // preprint is, not where the pane happens to be); the selected collection is
  // used only when it belongs to that library.
  async importWork(work, win, target = {}) {
    if (!work?.doi) throw new Error('DOI가 없어 자동으로 가져올 수 없습니다. 문헌 정보에 DOI를 넣은 뒤 다시 실행하세요.');
    const selected = win?.ZoteroPane?.getSelectedCollection?.();
    const libraryID = target.libraryID ?? win?.ZoteroPane?.getSelectedLibraryID?.();
    const collection = selected && (selected.libraryID == null || libraryID == null || selected.libraryID === libraryID) ? selected : null;
    const known = await this.findExistingWork(libraryID, work);
    if (known) return Object.assign([known], {existing: true, collectionName: ''});
    const saved = await this.importByIdentifier({DOI: work.doi}, {
      libraryID,
      collections: collection ? [collection.id] : undefined
    });
    return Object.assign(saved, {existing: false, collectionName: collection?.name || ''});
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

  /* How long each kind of OpenAlex answer is trusted. Past this a record is
     "stale": it is still shown, with the date it was checked, and it is asked
     again only for the one paper or journal the reader opens or refreshes. Expiry
     never starts a bulk fetch -- the sweeps below still ask only about what has
     never been asked. A not-found answer comes back sooner than a found one. */
  static get EXPIRY_DAYS() { return {citationList: 30, citers: 30, journalMetric: 90, notFound: 14, authorWorks: 30}; }
  static get JOURNAL_VERSION() { return 2; }
  expiredAt(at, days) {
    const time = Date.parse(at);
    return !Number.isFinite(time) || Date.now() - time > days * 864e5;
  }
  checkedDate(at) {
    const time = Date.parse(at);
    return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
  }

  // A row written before version 2 may hold a zero that was really "missing"
  // (Number(null)); it reads as unknown until the journal is refetched.
  trustedJournalRow(row) {
    if (!row || (row.v || 1) >= this.constructor.JOURNAL_VERSION) return row;
    if (row.citedness !== 0 && row.apc !== 0) return row;
    return {...row, citedness: row.citedness === 0 ? null : row.citedness, apc: row.apc === 0 ? null : row.apc};
  }

  // {state: 'none' | 'missing' | 'fresh' | 'stale', found, checkedAt, why}
  journalStatus(item) {
    const record = this.journalRecord(item);
    if (!record.name && !record.issn) return {state: 'none', found: false, checkedAt: '', why: ''};
    const row = this.journalCache()[this.journalTools2.cacheKey(record)];
    if (!row) return {state: 'missing', found: false, checkedAt: '', why: ''};
    const E = this.constructor.EXPIRY_DAYS, found = row.citedness != null;
    const old = (row.v || 1) < this.constructor.JOURNAL_VERSION && (row.citedness === 0 || row.apc === 0);
    const expired = this.expiredAt(row.checkedAt, found ? E.journalMetric : E.notFound);
    return {state: old || expired ? 'stale' : 'fresh', found, checkedAt: row.checkedAt || '',
      why: old ? 'version' : expired ? 'expired' : ''};
  }

  // One lookup per journal: 1,116 items in this library share 255 journals, so
  // caching by journal is the difference between a sweep that fits the daily
  // budget and one that cannot. An expired row is returned as it is; only
  // `refresh` (the reader's press, or opening that journal) asks again.
  async fetchJournalMetric(record, {signal, refresh = false} = {}) {
    const key = this.journalTools2.cacheKey(record);
    if (!record.name && !record.issn) return null;
    const store = this.journalCache();
    if (store[key] && !refresh) return store[key];
    const url = this.journalTools2.lookupURL(record, this.discoverOptions());
    if (!url) return null;
    const payload = await this.discoverJSON(url, {signal});
    const source = this.journalTools2.pickSource(payload, record);
    const now = new Date().toISOString(), version = this.constructor.JOURNAL_VERSION;
    if (!source || source.citedness == null) {
      // Remember the miss too, or every sweep pays for it again. A journal that
      // was found before keeps its figures: "not found now" is not "never was".
      const before = store[key];
      store[key] = before && before.citedness != null && !((before.v || 1) < version && before.citedness === 0)
        ? {...before, checkedAt: now, v: version}
        : {citedness: null, checkedAt: now, v: version};
      this.dirty = true;
      return store[key];
    }
    store[key] = {
      v: version,
      citedness: source.citedness, name: source.name, issn: source.issn,
      openAlexID: source.id, checkedAt: now,
      ...this.journalProfileFields(source), profileAt: now
    };
    this.dirty = true;
    return store[key];
  }

  // The reader asked about this one journal: ask OpenAlex again for it alone.
  async refreshJournal(item, {signal} = {}) {
    const hit = await this.fetchJournalMetric(this.journalRecord(item), {signal, refresh: true});
    await this.flush();
    return hit;
  }

  journalProfileFields(source) {
    return {
      hIndex: source.hIndex ?? null, works: source.works ?? null, cited: source.cited ?? null,
      publisher: source.publisher || '', country: source.country || '', homepage: source.homepage || '',
      isOA: !!source.isOA, inDoaj: !!source.inDoaj, apc: source.apc ?? null,
      topics: Array.isArray(source.topics) ? source.topics : [], fields: Array.isArray(source.fields) ? source.fields : []
    };
  }

  // What is known about the journal a paper is in, from the cache alone: the
  // OpenAlex figures and profile when they have been fetched, nothing otherwise.
  journalProfile(item) {
    const record = this.journalRecord(item);
    if (!record.name && !record.issn) return null;
    const hit = this.trustedJournalRow(this.journalCache()[this.journalTools2.cacheKey(record)]);
    return hit && hit.citedness != null ? hit : null;
  }

  /* Journals cached before the profile fields existed have a figure and
     nothing else. Fifty at a time, by ISSN, they are filled in once: 255
     journals in this library cost six requests. A journal without an ISSN
     anywhere keeps its figure and is marked as asked, so the sweep does not
     repeat itself. */
  async refreshJournalProfiles({signal, onProgress} = {}) {
    const store = this.journalCache();
    // Profiles filled before the topic hierarchy (domain, subfield) was kept
    // are asked once more; the date is when that shipped.
    const HIERARCHY_SINCE = '2026-09-19T03:00:00Z';
    const stale = Object.entries(store).filter(([, hit]) => hit && hit.citedness != null && (!hit.profileAt || hit.profileAt < HIERARCHY_SINCE));
    const result = {journals: stale.length, filled: 0, requests: 0, budgetGone: false};
    if (!stale.length) return result;
    const byISSN = new Map();
    const now = new Date().toISOString();
    for (const [key, hit] of stale) {
      const code = this.journalTools2.cleanISSN(hit.issn || (key.startsWith('issn:') ? key.slice(5) : ''));
      if (code.length === 8) byISSN.set(code, [...(byISSN.get(code) || []), key]);
      else { hit.profileAt = now; this.dirty = true; }
    }
    const codes = [...byISSN.keys()];
    for (let start = 0; start < codes.length; start += 50) {
      if (signal?.aborted) break;
      const batch = codes.slice(start, start + 50);
      onProgress?.(start, codes.length);
      const url = this.journalTools2.profilesURL(batch, this.discoverOptions());
      if (!url) break;
      try {
        const payload = await this.discoverJSON(url, {signal});
        result.requests++;
        for (const source of this.journalTools2.readSources(payload)) {
          const keys = new Set();
          for (const code of source.issns) for (const key of byISSN.get(code) || []) keys.add(key);
          for (const key of keys) {
            Object.assign(store[key], this.journalProfileFields(source), {profileAt: now});
            if (!store[key].openAlexID && source.id) store[key].openAlexID = source.id;
            result.filled++;
          }
        }
        // Journals the batch did not answer for are marked as asked.
        for (const code of batch) for (const key of byISSN.get(code) || []) if (!store[key].profileAt || store[key].profileAt < HIERARCHY_SINCE) store[key].profileAt = now;
        this.dirty = true;
      } catch (error) {
        if (this.outOfBudget(error)) { result.budgetGone = true; break; }
        this.Z.logError(error);
      }
      if (start + 50 < codes.length) await this.pause(150);
    }
    await this.flush();
    return result;
  }

  // The catalogue's JIF always wins; this only fills what it does not cover.
  journalCitedness(item) {
    const record = this.journalRecord(item);
    if (!record.name && !record.issn) return null;
    const hit = this.trustedJournalRow(this.journalCache()[this.journalTools2.cacheKey(record)]);
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
      // Only journals never asked about: an expired or old-version row waits for the reader to open or refresh it.
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
    const notes = await this.libraryItems(this.Z.Libraries.userLibraryID);
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
  async resolveAuthor(name, options = {}) {
    return (await this.resolveAuthorDetailed(name, options)).hit;
  }
  // The answer plus, when nothing was clear enough to adopt, the few candidates
  // whose name fits (never one whose given name differs) for the user to settle.
  async resolveAuthorDetailed(name, {institution, topics, orcid, coauthors, signal} = {}) {
    const options = this.discoverOptions();
    const wanted = {name, institution, topics, orcid, coauthors};
    const uncertain = new Map();
    for (const {query, confirm} of this.discoverTools.authorQueries(name, {institution})) {
      const url = this.discoverTools.authorSearchURL(query, options);
      if (!url) continue;
      const found = this.discoverTools.readAuthors(await this.discoverJSON(url, {signal}));
      const hit = this.discoverTools.pickAuthor(found, {...wanted, confirm});
      if (hit) return {hit, candidates: []};
      // A guessed query pulls in arbitrary namesakes; only the plain forms of
      // the name are worth putting in front of the user.
      if (!confirm) for (const row of this.discoverTools.uncertainAuthors(found, wanted)) if (!uncertain.has(row.id)) uncertain.set(row.id, row);
    }
    return {hit: null, candidates: [...uncertain.values()].slice(0, 3)};
  }

  async importWatchedAuthors(people, {onProgress, signal} = {}) {
    const result = {added: 0, already: 0, unresolved: [], pending: 0, failed: 0};
    for (const [index, person] of people.entries()) {
      onProgress?.(index, people.length, person);
      try {
        const {hit, candidates} = await this.resolveAuthorDetailed(person.name,
          {institution: person.institution, topics: person.topics, orcid: person.orcid, coauthors: person.coauthors, signal});
        if (!hit) {
          result.unresolved.push(person.name);
          if (candidates.length) { await this.keepAuthorCandidates(person, candidates); result.pending++; }
          continue;
        }
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

  // Candidates the matcher would not adopt on its own. They are kept, with the
  // evidence for each, until the user follows one or dismisses the lot.
  pendingAuthorCandidates() {
    const saved = this.cache.authorCandidates;
    return Array.isArray(saved) ? saved.filter(row => row && row.key && Array.isArray(row.candidates)) : [];
  }
  async keepAuthorCandidates(person, candidates) {
    const key = String(person.name || '').trim().toLowerCase() + '|' + String(person.institution || '').trim().toLowerCase();
    const rows = this.pendingAuthorCandidates().filter(row => row.key !== key);
    rows.push({key, name: String(person.name || ''), institution: String(person.institution || ''),
      candidates: candidates.map(c => ({id: c.id, name: c.name, institutions: c.institutions || [], works: c.works ?? null,
        hIndex: c.hIndex ?? null, orcid: c.orcid || '', evidence: c.evidence || []})),
      at: new Date().toISOString()});
    this.cache.authorCandidates = rows.slice(-100);
    this.dirty = true;
    await this.flush();
  }
  async dismissAuthorCandidate(key) {
    this.cache.authorCandidates = this.pendingAuthorCandidates().filter(row => row.key !== key);
    this.dirty = true;
    await this.flush();
  }
  // The user's own choice: follow the candidate they picked, with their
  // current papers as the baseline so nothing old reads as new.
  async confirmAuthorCandidate(key, authorID) {
    const row = this.pendingAuthorCandidates().find(entry => entry.key === key);
    const pick = row?.candidates.find(c => c.id === authorID);
    if (!pick) return null;
    const {works} = await this.authorActivity(pick.id, {limit: 25});
    const added = await this.watchAuthor({id: pick.id, name: pick.name,
      institution: row.institution || pick.institutions?.[0] || '', seen: (works || []).map(work => work.id)});
    await this.dismissAuthorCandidate(key);
    return added;
  }

  // Fifty authors per request means following people is nearly free; what the
  // file actually carries is their stored news, so the limit sits there.
  get WATCH_LIMIT() { return 500; }
  // Enough ids that a prolific lab's back catalogue cannot roll off the end and
  // be re-announced as new.
  get SEEN_LIMIT() { return 400; }
  // What is shown per author, and (separately) what is kept: the display cap
  // must not decide what is stored, or papers nobody has seen vanish.
  get NEWS_LIMIT() { return 50; }
  get NEWS_STORE_LIMIT() { return 200; }
  // An unseen paper stays this long after its publication date.
  get NEWS_RETENTION_DAYS() { return 180; }
  // The key the panel's 확인함 store uses for a paper: bare DOI, else the work id.
  static seenWorkKey(work) {
    return String(work?.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim() || String(work?.id || '');
  }
  // Marks the reader made in the panel. Older marks carried a library prefix ("1:10.1/x").
  panelSeenKeys() {
    const stored = this.cache?.workbenchUI?.inboxSeen || {};
    return new Set(Object.keys(stored).map(key => key.replace(/^\d*:/, '')));
  }
  /* Every paper not yet marked seen stays, newest first, up to NEWS_LIMIT per
     author; marked ones only fill what is left, so the oldest dropped are
     always ones the reader has already dealt with. */
  keepNews(works, panelSeen = this.panelSeenKeys(), limit = this.NEWS_LIMIT) {
    const sorted = CustomStyleRuntime.dedupeNews(works, (winner, twin) => { if (this.carrySeen?.(winner, twin)) panelSeen.add(CustomStyleRuntime.seenWorkKey(winner)); }).sort((a, b) => String(b.date || b.year || '').localeCompare(String(a.date || a.year || '')));
    const open = sorted.filter(work => !panelSeen.has(CustomStyleRuntime.seenWorkKey(work))).slice(0, limit);
    const room = Math.max(0, limit - open.length);
    const done = sorted.filter(work => panelSeen.has(CustomStyleRuntime.seenWorkKey(work))).slice(0, room);
    const keep = new Set([...open, ...done]);
    return sorted.filter(work => keep.has(work));
  }

  static samePlace(a, b, rorA, rorB) {
      const initials = name => String(name || '').split(/[\s-]+/).filter(w => w && !/^(of|the|and|for|at|de|du|des|la|le)$/i.test(w)).map(w => w[0]).join('').toUpperCase();
      const lower = v => String(v || '').toLowerCase().trim();
      const inner = (a, b, rorA, rorB) => {
        if (rorA && rorB) return rorA === rorB;
        if (!a || !b) return false;
        if (lower(a) === lower(b) || lower(a).includes(lower(b)) || lower(b).includes(lower(a))) return true;
        // "University of Illinois at Urbana-Champaign" and the same without
        // "at" are one campus written two ways.
        const bare = name => lower(name).replace(/[,.]/g, '').split(/\s+/).filter(w => w && !/^(of|the|and|for|at|in|de|du|des|la|le)$/.test(w)).join(' ');
        if (bare(a) && bare(a) === bare(b)) return true;
        if (initials(a) === lower(b).toUpperCase() || initials(b) === lower(a).toUpperCase()) return true;
        // "UC Berkeley" for "University of California, Berkeley": the
        // leading words shortened, the campus kept.
        const headed = name => { const w = String(name).replace(/[,.]/g, '').split(/\s+/).filter(Boolean); return w.length > 2 ? (initials(w.slice(0, -1).join(' ')) + ' ' + w[w.length - 1]).toLowerCase() : ''; };
        // One letter off is a typo, not another university: the remembered
        // place is typed by hand when an author is followed ("UC berkely").
        const near = (x, y) => { if (!x || !y || Math.abs(x.length - y.length) > 1 || x.length < 8) return false; let i = 0, j = 0, slips = 0; while (i < x.length && j < y.length) { if (x[i] === y[j]) { i++; j++; continue; } if (++slips > 1) return false; if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; } } return slips + (x.length - i) + (y.length - j) <= 1; };
        const plainA = lower(a).replace(/[,.]/g, ''), plainB = lower(b).replace(/[,.]/g, '');
        if ((headed(a) && (headed(a) === plainB || near(headed(a), plainB))) || (headed(b) && (headed(b) === plainA || near(headed(b), plainA))) || near(plainA, plainB)) return true;
        // "Harvard Medical School" is inside "Harvard University": a unit
        // named after its university, which OpenAlex files under the
        // university. The first word has to be the proper name, not a
        // generic like "University" or "National".
        const UNIT = /\b(school|institute|center|centre|laboratory|laboratories|lab|hospital|college|faculty|department|division|clinic|medical)\b/;
        const GENERIC = /^(university|national|institute|the|state|college|school|center|centre|royal|federal|medical|general|technical|academy|hospital|max|mass)$/;
        const first = name => (bare(name).split(' ')[0] || '');
        if (first(a) && first(a) === first(b) && !GENERIC.test(first(a)) && (UNIT.test(plainA) || UNIT.test(plainB))) return true;
        // "DTU" for "Technical University of Denmark": an acronym written in
        // the local order, so its letters are compared as a set.
        const acronym = name => { const m = String(name).trim().match(/^([A-Z]{2,5})(?:\s|$)/); return m ? m[1].split('').sort().join('') : ''; };
        const letters = name => initials(name).split('').sort().join('');
        return (!!acronym(a) && acronym(a) === letters(b)) || (!!acronym(b) && acronym(b) === letters(a));
      };
      return inner(a, b, rorA, rorB);
  }

  // --- Followed authors' news: namesakes and twins ---

  // A name or title reduced to its letters and digits (Unicode, NFKC), for comparing.
  static newsKey(text) { return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }

  /* One paper once. The same OpenAlex id twice, the "Angewandte Chemie" and
     "... International Edition" records of one article, and a preprint beside
     its journal version all arrived as separate news. By id first, then by
     the full normalised title; of a preprint/article pair the journal version
     stays and carries a note of the preprint. */
  static dedupeNews(works, onMerge) {
    const byID = new Map(), list = [];
    for (const work of works || []) {
      if (!work) continue;
      if (work.id && byID.has(work.id)) continue;
      if (work.id) byID.set(work.id, work);
      list.push(work);
    }
    const groups = new Map();
    list.forEach((work, index) => {
      const key = CustomStyleRuntime.newsKey(work.title);
      if (key.length < 10) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    const drop = new Set();
    for (const indexes of groups.values()) {
      if (indexes.length < 2) continue;
      const rank = index => { const w = list[index]; return (w.preprint ? 0 : 4) + (w.inLibrary ? 2 : 0) + (w.doi ? 1 : 0); };
      let best = indexes[0];
      for (const index of indexes) if (rank(index) > rank(best)) best = index;
      const winner = list[best];
      for (const index of indexes) {
        if (index === best) continue;
        drop.add(index);
        const twin = list[index];
        if (typeof onMerge === 'function') onMerge(winner, twin);
        if (twin.preprint && !winner.preprint && !winner.preprintOf) winner.preprintOf = {id: twin.id, venue: twin.venue || '', doi: twin.doi || '', date: twin.date || ''};
        if (twin.inLibrary) winner.inLibrary = true;
      }
    }
    return list.filter((work, index) => !drop.has(index));
  }

  /* Where a stored or fresh paper stands for one followed author.
     item: {id, places: [{name, ror}] or null when unknown, country, subfield, people: [names]}
     ctx:  {confirmed, knownPlaces, knownCountries, evidence (folded coauthor names), selfKey}
     A paper that names no institution is not taken on trust: it passes only
     when it shares a coauthor with papers already verified for this author. */
  static newsVerdict(item, ctx) {
    if (ctx.confirmed.has(item.id)) return {verdict: 'ok', basis: 'confirmed'};
    if (!Array.isArray(item.places)) return {verdict: 'unclassified', basis: ''};
    if (!item.places.length) {
      const shared = (item.people || []).some(name => { const key = CustomStyleRuntime.newsKey(name); return key && key !== ctx.selfKey && ctx.evidence.has(key); });
      return shared ? {verdict: 'ok', basis: 'coauthor'} : {verdict: 'unverified', basis: ''};
    }
    if (!ctx.knownPlaces.length) return {verdict: 'ok', basis: 'open'};
    if (item.places.some(h => ctx.knownPlaces.some(pl => CustomStyleRuntime.samePlace(pl.name, h.name, pl.ror || '', h.ror || '')))) return {verdict: 'ok', basis: 'place'};
    if (item.country && ctx.knownCountries.has(item.country) && ctx.subfieldKnown && item.subfield === ctx.subfieldKnown) return {verdict: 'ok', basis: 'country'};
    return {verdict: 'unverified', basis: ''};
  }

  static newsContext(row, profileNow, extraEvidence = []) {
    const knownPlaces = [
      {name: row.institution, ror: row.institutionRor}, {name: row.institutionGiven, ror: ''},
      {name: row.previousInstitution, ror: row.previousInstitutionRor},
      ...(row.places || []), ...(row.placesSeen || []), ...(profileNow?.places || [])
    ].filter(pl => pl && pl.name);
    const confirmed = new Set(row.confirmed || []);
    const evidence = new Set(extraEvidence);
    for (const work of row.news || []) {
      if (work && (['place', 'country', 'confirmed'].includes(work.verified) || confirmed.has(work.id))) {
        for (const name of work.people || []) { const key = CustomStyleRuntime.newsKey(name); if (key) evidence.add(key); }
      }
    }
    return {
      confirmed, knownPlaces, evidence, selfKey: CustomStyleRuntime.newsKey(row.name),
      knownCountries: new Set(row.countriesSeen || []), subfieldKnown: row.subfield || ''
    };
  }

  /* Stored news is judged again by the rules now in force, with no request.
     A paper whose stored record names its institutions is classified like a
     fresh one; one swept before the classifier existed has nothing to judge
     by, so it is marked `unclassified` -- unless it shares a coauthor with
     verified papers, or the row has verified papers and it shares none, in
     which case it is held as unverified. Returns how many moved. */
  static reclassifyNewsRow(row, profileNow, extraEvidence = []) {
    if (!Array.isArray(row?.news) || !row.news.length) return {moved: 0, unclassified: 0};
    const ctx = CustomStyleRuntime.newsContext(row, profileNow, extraEvidence);
    const kept = [], moved = [];
    let unclassified = 0;
    for (const work of row.news) {
      if (!work) continue;
      if (work.verified) { kept.push(work); continue; }
      const item = {id: work.id, places: Array.isArray(work.places) ? work.places.map(name => ({name, ror: ''})) : null,
        country: work.country || '', subfield: work.subfield || '', people: work.people || []};
      let result = CustomStyleRuntime.newsVerdict(item, ctx);
      if (result.verdict === 'unclassified') {
        // No institutions stored: the coauthors are the only evidence left.
        const shared = (work.people || []).some(name => { const key = CustomStyleRuntime.newsKey(name); return key && key !== ctx.selfKey && ctx.evidence.has(key); });
        result = shared ? {verdict: 'ok', basis: 'coauthor'} : ctx.evidence.size ? {verdict: 'unverified', basis: ''} : result;
      }
      if (result.verdict === 'unverified') { moved.push(work); continue; }
      if (result.verdict === 'unclassified') { work.unclassified = true; unclassified++; }
      else { work.verified = result.basis; delete work.unclassified; }
      kept.push(work);
    }
    if (moved.length) {
      const held = new Map((row.unverified || []).map(w => [w.id, w]));
      for (const work of moved) if (!held.has(work.id) && !(row.rejected || []).includes(work.id)) held.set(work.id, {
        id: work.id, title: work.title, venue: work.venue, doi: work.doi, type: String(work.type || ''), date: work.date || '',
        people: (work.people || []).slice(0, 6), places: work.places || [], country: work.country || '', subfield: work.subfield || ''
      });
      row.unverified = [...held.values()].sort((m, n) => String(n.date || '').localeCompare(String(m.date || ''))).slice(0, 20);
    }
    row.news = kept;
    return {moved: moved.length, unclassified};
  }

  /* One person once on a stored work. 240 of 1,140 stored people lists named someone twice; the sweep
     already writes them clean, but rows stored before that stayed as they were and asking OpenAlex again
     (metered) was the only cure. Cleaned in memory at load, same person by id, else by normalised name
     and position, and written with the next ordinary flush. */
  static dedupePeople(list) {
    const seen = new Map(), out = [];
    for (const person of list || []) {
      if (!person) continue;
      const name = String(person.name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const key = person.id ? 'id:' + person.id : name ? 'n:' + name + '|' + String(person.position || '') : '';
      if (!key) { out.push(person); continue; }
      if (seen.has(key)) { const kept = seen.get(key); if (person.corresponding && !kept.corresponding) kept.corresponding = true; continue; }
      const copy = {...person};
      seen.set(key, copy); out.push(copy);
    }
    return out;
  }
  dedupePaperPeople() {
    let cleaned = 0;
    for (const work of Object.values(this.paperWorks())) {
      if (!work || !Array.isArray(work.people)) continue;
      const next = CustomStyleRuntime.dedupePeople(work.people);
      if (next.length !== work.people.length) { work.people = next; cleaned++; }
    }
    if (cleaned) this.dirty = true;
    this.peopleCleaned = cleaned;
    return cleaned;
  }

  /* A paper marked 확인함 under one record stays marked when a twin takes its place (the preprint
     marked seen, then merged into its journal version): the mark is copied to the survivor. */
  carrySeen(winner, twin) {
    const store = this.cache?.workbenchUI?.inboxSeen;
    if (!store || typeof store !== 'object') return false;
    const bare = key => key.replace(/^\d*:/, '');
    const from = CustomStyleRuntime.seenWorkKey(twin), to = CustomStyleRuntime.seenWorkKey(winner);
    if (from === to) return false;
    const mine = Object.keys(store).find(key => bare(key) === from);
    if (!mine) return false;
    if (Object.keys(store).some(key => bare(key) === to)) return true;
    store[to] = store[mine];
    this.dirty = true;
    return true;
  }
  // Rows stored with twins (the same id, ange/anie, a preprint beside its journal version) are merged at load.
  dedupeStoredNews() {
    let removed = 0;
    for (const row of this.watchedAuthors?.() || []) {
      if (!Array.isArray(row.news) || row.news.length < 2) continue;
      const next = CustomStyleRuntime.dedupeNews(row.news, (winner, twin) => this.carrySeen?.(winner, twin));
      if (next.length !== row.news.length) { removed += row.news.length - next.length; row.news = next; this.dirty = true; }
    }
    return removed;
  }
  // The panel's safety net: the same one-paper-once rule, asked through the instance.
  dedupeNews(list) { return CustomStyleRuntime.dedupeNews(list, (winner, twin) => this.carrySeen?.(winner, twin)); }

  /* Papers stored before the namesake check (“미분류”) judged now: read back
     by id, fifty to a filter request, with the followed author's own
     authorship -- any of a merged person's records -- and classified by the
     same rules as a sweep. A namesake's paper moves to 확인 필요; the rest
     stay as news, verified. Asks nothing when there is nothing unclassified. */
  async classifyStoredNews({signal} = {}) {
    const rows = this.watchedAuthors();
    const wanted = new Map();
    for (const row of rows) for (const work of row.news || []) {
      if (!work?.unclassified || !/^W\d+$/.test(String(work.id || ''))) continue;
      if (!wanted.has(work.id)) wanted.set(work.id, []);
      wanted.get(work.id).push({row, work});
    }
    const result = {asked: wanted.size, settled: 0, held: 0, requests: 0, budgetGone: false};
    if (!wanted.size) return result;
    const ids = [...wanted.keys()], touched = new Set(), options = this.discoverOptions();
    for (let i = 0; i < ids.length; i += this.discoverTools.AUTHOR_BATCH) {
      if (signal?.aborted) break;
      const url = this.discoverTools.watchedNewsURL(ids.slice(i, i + this.discoverTools.AUTHOR_BATCH), options);
      if (!url) continue;
      let payload;
      try { payload = await this.discoverJSON(url, {signal}); result.requests++; }
      catch (error) {
        if (this.outOfBudget(error)) { result.budgetGone = true; break; }
        this.Z.logError(error); continue;
      }
      for (const found of this.discoverTools.readWorks(payload)) {
        for (const {row, work} of wanted.get(found.id) || []) {
          const mine = new Set(CustomStyleRuntime.authorIDsOf(row));
          const own = (found.people || []).find(p => p.id && mine.has(p.id));
          // The record no longer names this author at all: nothing ties the paper to them.
          work.places = own ? (own.institutions?.length ? own.institutions.map(h => h.institution) : own.institution ? [own.institution] : []).filter(Boolean).slice(0, 4) : [];
          work.country = own?.country || '';
          if (found.subfieldName) work.subfield = found.subfieldName;
          if (own) { work.position = own.position || work.position || ''; work.corresponding = !!own.corresponding; }
          touched.add(row);
        }
      }
    }
    for (const row of touched) {
      const before = new Set((row.news || []).map(work => work.id));
      CustomStyleRuntime.reclassifyNewsRow(row, null);
      const after = new Set((row.news || []).map(work => work.id));
      for (const id of before) if (wanted.has(id) && wanted.get(id).some(entry => entry.row === row)) {
        if (!after.has(id)) result.held++;
        else if (!row.news.find(work => work.id === id)?.unclassified) result.settled++;
      }
    }
    if (touched.size) { this.cache.watchedAuthors = this.watchedAuthors(); this.dirty = true; await this.flush(); }
    return result;
  }

  reclassifyStoredNews() {
    let moved = 0;
    for (const row of this.watchedAuthors?.() || []) {
      const before = JSON.stringify([row.news, row.unverified]);
      moved += CustomStyleRuntime.reclassifyNewsRow(row, null).moved;
      if (JSON.stringify([row.news, row.unverified]) !== before) this.dirty = true;
    }
    return moved;
  }

  // Pacing, without reaching for a global the rest of this class does not use:
  // Zotero.Promise is a bootstrap-scope global here and absent under test.
  pause(ms) {
    const win = this.Z.getMainWindow?.();
    if (win?.setTimeout) return new Promise(resolve => win.setTimeout(resolve, ms));
    if (this.Z.Promise?.delay) return this.Z.Promise.delay(ms);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Moves recorded by the earlier rules -- read off the papers, first from
  // the newest authorship alone, then across the window -- are taken back.
  // Every one found live was a second appointment, an institute inside the
  // university, or the same place under two names. A move made from the
  // author record itself carries `rule: 2`.
  retireLooseMoves() {
    for (const row of this.watchedAuthors()) {
      if (!row.moved || row.moved.rule === 2) continue;
      if (row.previousInstitution) row.institution = row.previousInstitution;
      delete row.previousInstitution;
      delete row.moved;
      // The ROR was taken from the place the row was wrongly moved to.
      delete row.institutionRor;
      this.dirty = true;
    }
  }

  watchedAuthors() {
    const saved = this.cache.watchedAuthors;
    return Array.isArray(saved) ? saved.filter(row => row && typeof row.id === 'string') : [];
  }

  /* Every OpenAlex id of a followed person: their own, then the other records
     one ORCID sits on (`alsoIds`), so the sweep and the person view read all. */
  static authorIDsOf(row) {
    const short = value => String(value || '').replace(/^https?:\/\/openalex\.org\//i, '').toUpperCase();
    return [...new Set([row?.id, ...(Array.isArray(row?.alsoIds) ? row.alsoIds : [])].map(short).filter(id => /^A\d+$/.test(id)))];
  }
  // The followed row a given id belongs to, as its own id or one of its other records.
  watchedRowOf(authorID) {
    const id = this.discoverTools.shortID(authorID);
    if (!id) return null;
    return this.watchedAuthors().find(row => row.id === id || (Array.isArray(row.alsoIds) && row.alsoIds.includes(id))) || null;
  }
  // The ids to ask OpenAlex about for one person: all of a followed person's records, else the one given.
  authorIDs(authorID) {
    const row = this.watchedRowOf?.(authorID);
    return row ? CustomStyleRuntime.authorIDsOf(row) : [this.discoverTools.shortID(authorID)].filter(Boolean);
  }

  async watchAuthor(person) {
    const id = this.discoverTools.shortID(person?.id);
    if (!id.startsWith('A')) throw new Error('저자 식별자가 올바르지 않습니다. 관심 저자 목록에서 저자를 다시 고르세요.');
    /* One person on several OpenAlex records (one ORCID, two ids): all are
       followed as one row. A row already kept for one of them is folded in --
       what it had seen stays seen and its unseen news stays. */
    const given = [...(Array.isArray(person?.alsoIds) ? person.alsoIds : []), ...(Array.isArray(person?.ids) ? person.ids : [])];
    const alsoGiven = given.map(value => this.discoverTools.shortID(value)).filter(value => /^A\d+$/.test(value) && value !== id);
    const wanted = new Set([id, ...alsoGiven]);
    const ofPerson = this.watchedAuthors().filter(row => CustomStyleRuntime.authorIDsOf(row).some(value => wanted.has(value)));
    const alsoIds = [...new Set([...alsoGiven, ...ofPerson.flatMap(row => CustomStyleRuntime.authorIDsOf(row))])].filter(value => value !== id).slice(0, 10);
    const rest = this.watchedAuthors().filter(row => !ofPerson.includes(row));
    // The old cap was 100 because each author used to cost a request of their
    // own. The user already follows 109, so adding anyone simply failed. One
    // sweep now covers fifty per request, and the real cost is the stored news,
    // so the limit is set where the file size starts to matter instead.
    if (rest.length >= this.WATCH_LIMIT) {
      throw new Error(`관심 저자는 ${this.WATCH_LIMIT}명까지 저장합니다. 목록에서 몇 명을 해제하세요.`);
    }
    const folded = ofPerson;
    const seen = [...new Set([...(Array.isArray(person.seen) ? person.seen : []), ...folded.flatMap(row => row.seen || [])])];
    const news = folded.flatMap(row => Array.isArray(row.news) ? row.news : []);
    this.cache.watchedAuthors = [...rest, {
      id, name: String(person.name || id), institution: String(person.institution || ''),
      ...(alsoIds.length ? {alsoIds} : {}),
      // What was already known when the author was added, so "new" means new to the user.
      seen: seen.slice(0, this.SEEN_LIMIT),
      ...(news.length ? {news: this.keepNews ? this.keepNews(news) : news} : {}),
      checkedAt: new Date().toISOString()
    }];
    this.dirty = true;
    await this.flush();
    return this.cache.watchedAuthors[this.cache.watchedAuthors.length - 1];
  }

  async unwatchAuthor(authorID) {
    const id = this.discoverTools.shortID(authorID);
    // Any of a merged person's ids lets the whole person go.
    this.cache.watchedAuthors = this.watchedAuthors().filter(row => !CustomStyleRuntime.authorIDsOf(row).includes(id) && row.id !== id);
    this.dirty = true;
    await this.flush();
  }

  // The undo of unwatchAuthor: the row comes back whole (baseline, news, check dates) where it was.
  async restoreWatchedAuthor(row, index = -1) {
    if (!row?.id) return false;
    const rows = this.watchedAuthors();
    if (rows.some(entry => entry.id === row.id)) return false;
    const next = [...rows];
    next.splice(index < 0 || index > next.length ? next.length : index, 0, JSON.parse(JSON.stringify(row)));
    this.cache.watchedAuthors = next;
    this.dirty = true;
    await this.flush();
    return true;
  }

  /* 읽기 대기 for other plugins (ZotPoP): the same store and keys as the
     workbench's own queue (`libraryID:key` in cache.workbenchUI.readingQueue),
     so 읽기 진행 shows what is added here. items are Zotero items or ids;
     reason is the one line shown under the queue row. Returns how many were
     added; finished, started and already-waiting papers are left alone. */
  _queueItem(item) { return item && typeof item === 'object' ? item : this.Z.Items.get(Number(item)); }
  isQueued(item) {
    const ref = this._queueItem(item);
    if (!ref?.key) return false;
    return this._waiting(ref, (this.cache?.workbenchUI?.readingQueue || {})[this.identity(ref)]);
  }
  _waiting(ref, entry) {
    if (!entry) return false;
    const read = Date.parse(this.entry(ref).lastRead || '');
    return !(Number.isFinite(read) && read > Date.parse(entry.at || ''));
  }
  async queueForReading(items, { reason, source } = {}) {
    const list = Array.isArray(items) ? items : items == null ? [] : [items];
    const next = { ...(this.cache.workbenchUI?.readingQueue || {}) };
    const line = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let added = 0;
    for (const raw of list) {
      const ref = this._queueItem(raw);
      if (!ref?.key || (typeof ref.isRegularItem === 'function' && !ref.isRegularItem())) continue;
      const status = this.state(ref)?.status;
      if (status === 'done' || status === 'reading') continue;
      const key = this.identity(ref);
      if (this._waiting(ref, next[key])) continue;
      next[key] = { at: new Date().toISOString(), people: [], ...(line || source ? { reason: { ...(line ? { text: line } : {}), ...(source ? { source: String(source).slice(0, 40) } : {}) } } : {}) };
      added++;
    }
    if (!added) return 0;
    this.cache.workbenchUI = { ...(this.cache.workbenchUI || {}), readingQueue: next };
    this.dirty = true;
    await this.flush();
    try { for (const [win, state] of this.windows) if (!win.closed) state.workbench?.refreshReading?.(); } catch (error) { this.Z.logError?.(error); }
    return added;
  }

  // The watchlist existed but could not be read at a glance: every row showed
  // the same "last checked" date, so the only way to learn whether anyone had
  // published was to open all 109 of them one by one. That is exactly the cost
  // this plugin is meant to remove. One sweep answers it for everyone at once,
  // and stores the answer so the list itself shows who has news.
  /* Whether a watched author's new papers are still standing.

     A retraction on a paper you are reading is the fact the signals column
     exists for; a retraction on a paper by someone you follow is the same
     fact one step out. Crossref answers it free and unmetered, so this asks
     Crossref alone and touches no OpenAlex budget, once per DOI, and records
     the verdict on the news item so the row can carry it. */
  async sweepWatchedSignals({signal, onProgress} = {}) {
    const rows = this.watchedAuthors();
    const jobs = [];
    for (const row of rows) for (const work of row.news || []) {
      if (work.doi && !work.signals) jobs.push(work);
    }
    let checked = 0, flagged = 0;
    // Five at a time: Crossref answers a polite request in about a second, and
    // one at a time turned a long watchlist into a sweep nobody waited for.
    for (let start = 0; start < jobs.length; start += 5) {
      if (signal?.aborted || !this.active || this.stopping) break;
      onProgress?.(start, jobs.length);
      await Promise.all(jobs.slice(start, start + 5).map(async work => {
        try {
          const {signals} = await this.fetchPaperSignals(null, {signal, crossrefOnly: true, record: {DOI: work.doi, title: work.title}});
          if (!signals) return;
          work.signals = {status: signals.status, rank: signals.rank, checkedAt: signals.checkedAt};
          checked++;
          if (signals.rank >= 1) flagged++;
          this.dirty = true;
        } catch (error) { this.Z.logError(error); }
      }));
    }
    if (checked) { this.cache.watchedAuthors = this.watchedAuthors(); await this.flush(); }
    return {checked, flagged, total: jobs.length};
  }

  /* One sweep at a time: a second press (or the backfill) while one runs
     waits for that one instead of asking OpenAlex the same thing again. */
  sweepWatchedAuthors(options = {}) {
    if (this.authorSweepJob) return this.authorSweepJob;
    const job = CustomStyleRuntime.prototype.sweepWatchedAuthorsOnce.call(this, options);
    this.authorSweepJob = job;
    const clear = () => { if (this.authorSweepJob === job) this.authorSweepJob = null; };
    job.then(clear, clear);
    return job;
  }
  async sweepWatchedAuthorsOnce({months = 18, onProgress, signal} = {}) {
    const rows = this.watchedAuthors();
    const result = {authors: rows.length, withNews: 0, works: 0, added: 0, requests: 0, budgetGone: false, remaining: 0};
    if (!rows.length) return result;
    // A sweep is a request for what is new: the author pages asked earlier are forgotten.
    for (const key of [...(this.discoverCache?.keys?.() || [])]) if (String(key).startsWith('author:')) this.discoverCache.delete(key);
    const options = this.discoverOptions();
    /* Every OpenAlex id of every person: a merged person (one ORCID on two
       records) is asked about under all of them, in one batch, and what any
       of them signed is that person's news. */
    const idsOf = row => CustomStyleRuntime.authorIDsOf(row);
    const byID = new Map();
    for (const row of rows) for (const id of [this.discoverTools.shortID(row.id), ...idsOf(row)]) if (id && !byID.has(id)) byID.set(id, row);
    const batches = this.discoverTools.authorBatches(rows.map(row => idsOf(row).length > 1 ? idsOf(row) : row.id));
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
    /* One request per fifty authors answers where each of them is now:
       OpenAlex's own list of current appointments, with RORs. Reading a
       move off the papers instead -- first institution on the newest
       authorship, then every institution across the window -- produced
       seven, then six, "moves" in 109 authors, and not one was a move: a
       second appointment, an institute inside the university, a school
       named after it, the same place spelled two ways. */
    const profiles = new Map();
    result.profiles = 0;
    for (const batch of batches) {
      if (signal?.aborted) break;
      const url = this.discoverTools.watchedProfilesURL(batch, options);
      if (!url) continue;
      try {
        const payload = await this.discoverJSON(url, {signal});
        result.requests++;
        for (const profile of this.discoverTools.readProfiles(payload)) { profiles.set(profile.id, profile); result.profiles++; }
      } catch (error) {
        if (this.outOfBudget(error)) { result.budgetGone = true; result.remaining = batches.length; break; }
        this.Z.logError(error);
      }
      await this.pause(150);
    }
    if (result.budgetGone) return result;
    /* Stored news older than this sweep's window would keep 미분류 for ever:
       it is read back by id first (nothing is asked when none is left). */
    if (typeof this.classifyStoredNews === 'function') {
      try {
        const settled = await this.classifyStoredNews({signal});
        result.requests += settled.requests;
        result.classified = settled;
        if (settled.budgetGone) { result.budgetGone = true; result.remaining = batches.length; return result; }
      } catch (error) { this.Z.logError(error); }
    }
    /* A batch that failed (a 503, a timeout) used to fall through as "checked,
       nothing new": its authors' news was replaced by nothing and their
       last-checked date moved on. They are now left exactly as they were, and
       a batch cut off at the page limit keeps its authors' old date, so the
       next sweep starts where this one could not reach. */
    const failed = new Set(), unfinished = new Set(), resumed = new Map();
    const startedAt = new Date().toISOString();
    /* A batch cut off last time carries on from where it stopped: the same
       fifty authors, the same window, the saved cursor. Starting again from
       the first page re-read what was read and never reached the rest. */
    const resumeOf = batch => {
      const key = batch.join(','), saved = byID.get(batch[0])?.resume;
      return saved && saved.batch === key && saved.cursor && batch.every(id => byID.get(id)?.resume?.batch === key) ? saved : null;
    };
    for (const [index, batch] of batches.entries()) {
      if (signal?.aborted) { result.remaining = batches.length - index; break; }
      onProgress?.(index, batches.length);
      const carried = resumeOf(batch);
      let cursor = carried ? carried.cursor : '*';
      const since = carried ? carried.since : sinceFor(batch);
      const remember = next => { for (const id of batch) { const row = byID.get(id); if (row) row.resume = {batch: batch.join(','), cursor: next, since, at: carried ? carried.at : startedAt}; } };
      if (carried) for (const id of batch) resumed.set(id, carried.at);
      try {
        // Cursor paging, because a batch of fifty active labs clears 200 works
        // easily and a truncated page would silently under-report the news.
        for (let page = 0; page < 8 && cursor; page++) {
          const url = this.discoverTools.watchedWorksURL(batch, {...options, since, cursor});
          if (!url) break;
          const payload = await this.discoverJSON(url, {signal});
          result.requests++;
          const works = this.discoverTools.readWorks(payload);
          for (const [id, list] of this.discoverTools.attribute(works, batch)) {
            const owner = byID.get(id)?.id || id;
            const had = found.get(owner) || [];
            found.set(owner, [...had, ...list.filter(work => !had.includes(work))]);
          }
          cursor = works.length ? payload?.meta?.next_cursor || '' : '';
          if (cursor) { remember(cursor); await this.pause(150); }
        }
        if (cursor) for (const id of batch) unfinished.add(id);
        else for (const id of batch) { const row = byID.get(id); if (row) delete row.resume; }
      } catch (error) {
        // The batch whose later pages the budget stopped is part-read: kept as such, not called complete.
        if (this.outOfBudget(error)) { result.budgetGone = true; result.remaining = batches.length - index; for (const id of batch) unfinished.add(id); if (cursor !== '*') remember(cursor); break; }
        this.Z.logError(error);
        for (const id of batch) failed.add(id);
        /* The pages this batch read are thrown away with it, so the place it
           got to is too: the next run starts where this one started, or it
           would step over what these pages held. */
        for (const id of batch) { const row = byID.get(id); if (!row) continue; if (carried) row.resume = {...carried}; else delete row.resume; }
      }
    }
    result.failed = failed.size;result.unfinished = unfinished.size;
    const owned = this.libraryDOIs();
    const checkedAt = new Date().toISOString();
    for (const row of rows) {
      // A batch that never ran must not be recorded as "checked, nothing new" --
      // that would hide real news behind a clean-looking row.
      if (!found.has(row.id) && (result.budgetGone || result.remaining)) continue;
      if (failed.has(this.discoverTools.shortID(row.id)) || failed.has(row.id)) continue;
      const seen = new Set(row.seen || []);
      /* A paper published before this author was followed is not news.

         The baseline taken when someone is followed is their twenty-five
         newest works, but the sweep window reaches at least eighteen months
         back. Everything between those two is "not seen", so for a prolific
         author it all arrives as new. Measured on a fifty-four-work author:
         every 확인함 was followed by the next eight older papers, back to
         2025-04, not one of them published since the day they were followed.
         The inbox never emptied, and the papers that really were new sat
         underneath the back catalogue.

         So anything older than the last check -- less two months of slack,
         because a publication date can precede the day OpenAlex indexed it --
         is recorded as already known rather than shown. */
      // The last sweep, not the day the author was followed: an old follow date
      // would push every paper since then behind the floor.
      const checkedAtOf = Date.parse(row.sweptAt || row.checkedAt || '');
      const floor = Number.isFinite(checkedAtOf)
        ? new Date(checkedAtOf - 60 * 864e5).toISOString().slice(0, 10) : '';
      const fresh = [], backlog = [];
      const panelSeen = this.panelSeenKeys();
      const wasShown = new Set((row.news || []).map(work => work.id));
      for (const work of found.get(row.id) || []) {
        if (seen.has(work.id)) continue;
        // Something the inbox already showed and nobody marked is never filed away unseen.
        const stillOpen = wasShown.has(work.id) && !panelSeen.has(CustomStyleRuntime.seenWorkKey(work));
        (floor && work.date && work.date < floor && !stillOpen ? backlog : fresh).push(work);
      }
      fresh.sort((a, b) => String(b.date || b.year || '').localeCompare(String(a.date || a.year || '')));
      if (backlog.length) {
        row.seen = [...new Set([...backlog.map(work => work.id), ...(row.seen || [])])].slice(0, this.SEEN_LIMIT);
        seen.clear();
        for (const id of row.seen) seen.add(id);
      }
      /* Only papers. Of 64 "new papers" across 109 watched authors, 15 were
         PNNL repository deposits and one a Zenodo record -- copies of work
         already published, filed as datasets. OpenAlex types them; the type
         used to be fetched and thrown away, so a bioRxiv preprint could not
         be shown as one either. */
      const samePlace = CustomStyleRuntime.samePlace;
      /* Namesakes. OpenAlex sometimes merges two people of one name into one
         profile, so every work carrying the followed id arrived as news. The
         followed author's own authorship names the institutions that signed
         the paper: if none is a place this row knows (the one followed with,
         its listed appointments, places on papers already accepted or
         confirmed, the profile's current places), and it is not the same
         country and field as before, the paper is held as unverified and
         is neither counted nor shown as news until the reader confirms it.
         A paper that lists no institution passes. */
      const rowIDs = new Set([row.id, this.discoverTools.shortID(row.id), ...idsOf(row)]);
      const profileNow = profiles.get(row.id) || idsOf(row).map(id => profiles.get(id)).find(Boolean);
      const rejected = new Set(row.rejected || []);
      const ownOf = work => (work.people || []).find(p => p.id && rowIDs.has(p.id));
      const placesOf = work => {
        const own = ownOf(work);
        const list = own?.institutions?.length ? own.institutions.map(h => ({name: h.institution, ror: h.ror || ''}))
          : (own?.institution ? [{name: own.institution, ror: own.ror || ''}] : []);
        return list.filter(pl => pl.name);
      };
      const asItem = work => ({id: work.id, places: placesOf(work), country: ownOf(work)?.country || '',
        subfield: work.subfieldName || '', people: (work.people || []).map(p => p.name).filter(Boolean)});
      /* What was stored before this sweep is judged first, by the same rules:
         a namesake paper kept from an earlier sweep must not stay in the
         news just because this sweep did not find it again. */
      CustomStyleRuntime.reclassifyNewsRow(row, profileNow);
      const ctx = CustomStyleRuntime.newsContext(row, profileNow);
      const knownCountries = ctx.knownCountries;
      const candidates = fresh.filter(work => !rejected.has(work.id));
      const verdicts = new Map();
      // Papers that name an institution first; their coauthors then vouch for the ones that name none.
      for (const work of candidates) {
        const item = asItem(work);
        if (item.places.length || ctx.confirmed.has(work.id)) verdicts.set(work.id, CustomStyleRuntime.newsVerdict(item, ctx));
      }
      for (const work of candidates) {
        const result = verdicts.get(work.id);
        if (result && ['place', 'country', 'confirmed'].includes(result.basis))
          for (const name of asItem(work).people) { const key = CustomStyleRuntime.newsKey(name); if (key) ctx.evidence.add(key); }
      }
      for (const work of candidates) if (!verdicts.has(work.id)) verdicts.set(work.id, CustomStyleRuntime.newsVerdict(asItem(work), ctx));
      const confirmed = ctx.confirmed;
      const checked = candidates.map(work => ({work, verdict: verdicts.get(work.id).verdict, basis: verdicts.get(work.id).basis}));
      const basisOf = new Map(checked.map(c => [c.work.id, c.basis]));
      const held = checked.filter(c => c.verdict === 'unverified').map(c => c.work)
        .filter(work => !CustomStyleRuntime.NOT_A_PAPER.test(String(work.type || '')));
      const placesSeen = new Map((row.placesSeen || []).map(pl => [pl.name, pl]));
      for (const {work, verdict} of checked) {
        if (verdict !== 'ok') continue;
        const own = ownOf(work);
        for (const h of own?.institutions || []) if (h.institution && !placesSeen.has(h.institution)) placesSeen.set(h.institution, {name: h.institution, ror: h.ror || ''});
        if (own?.country) knownCountries.add(own.country);
      }
      row.placesSeen = [...placesSeen.values()].slice(-30);
      row.countriesSeen = [...knownCountries].slice(-10);
      const papers = checked.filter(c => c.verdict === 'ok').map(c => c.work).filter(work => !CustomStyleRuntime.NOT_A_PAPER.test(String(work.type || '')));
      {
        const keepHeld = new Map((row.unverified || []).filter(w => !confirmed.has(w.id) && !rejected.has(w.id)).map(w => [w.id, w]));
        for (const work of held) keepHeld.set(work.id, {
          id: work.id, title: work.title, venue: work.venue, doi: work.doi, type: String(work.type || ''),
          date: work.date || (work.year ? String(work.year) : ''),
          people: (work.people || []).slice(0, 6).map(p => p.name).filter(Boolean),
          places: (ownOf(work)?.institutions || []).map(h => h.institution).slice(0, 4),
          country: ownOf(work)?.country || '',
          subfield: work.subfieldName || ''
        });
        row.unverified = [...keepHeld.values()].sort((m, n) => String(n.date || '').localeCompare(String(m.date || ''))).slice(0, 20);
      }
      const short = this.discoverTools.shortID(row.id);
      /* What this row was already showing before the sweep. Without it, a
         sweep that finds nothing still announces every paper the reader has
         not got round to marking, so the weekly check reads the same both
         when something happened and when nothing did. */
      const announced = new Set((row.news || []).map(work => work.id));
      /* When each stored paper was first announced: its own stamp, else the
         sweep that stored it (rows saved before the stamp existed). */
      const announcedBy = row.sweptAt || row.checkedAt || '';
      const foundAtOf = new Map((row.news || []).filter(Boolean).map(work => [work.id, work.foundAt || announcedBy]));
      const storeLimit = this.NEWS_STORE_LIMIT || 200;
      const toNews = work => ({
        id: work.id, title: work.title, venue: work.venue, doi: work.doi,
        type: String(work.type || ''),
        preprint: /preprint/i.test(String(work.type || '')) || /rxiv|research square|preprints?\b|ssrn/i.test(String(work.venue || '')),
        date: work.date || (work.year ? String(work.year) : ''),
        inLibrary: !!work.doi && owned.has(work.doi),
        // The first few names, so a new collaborator can be spotted later
        // without another request.
        people: (work.people || []).slice(0, 6).map(p => p.name).filter(Boolean),
        // What the same record says about this followed author's part in it and how often it is cited, so the inbox can say so without a request.
        citations: Number.isInteger(work.citations) ? work.citations : null,
        position: ownOf(work)?.position || '',
        corresponding: !!ownOf(work)?.corresponding,
        // What the namesake check went by, kept so stored news can be judged again on load.
        places: placesOf(work).map(pl => pl.name).slice(0, 4),
        country: ownOf(work)?.country || '', subfield: work.subfieldName || '',
        verified: basisOf.get(work.id) || '',
        foundAt: foundAtOf.get(work.id) || checkedAt
      });
      /* Always merged, never replaced: a refresh that finds nothing (the date
         floor hides everything already known) must not empty what the reader
         has not looked at. An earlier item stays until it is marked seen,
         rejected, or older than the retention. */
      const retention = Date.now() - (this.NEWS_RETENTION_DAYS || 180) * 864e5;
      // Its own stamp; for one stored before stamps, the later of its date and the sweep that stored it (undated: kept, as before).
      const announcedAt = old => old.foundAt ? Date.parse(old.foundAt)
        : old.date ? Math.max(Date.parse(old.date) || 0, Date.parse(announcedBy) || 0) : NaN;
      const found_ = new Set(papers.map(work => work.id));
      const heldIDs = new Set((row.unverified || []).map(w => w?.id));
      const earlier = (row.news || []).filter(old => old && !found_.has(old.id)
        && !heldIDs.has(old.id)
        && !panelSeen.has(CustomStyleRuntime.seenWorkKey(old)) && !seen.has(old.id) && !rejected.has(old.id)
        // Kept 180 days from when it was announced: a paper published long ago but found last week is still unread news.
        && !(announcedAt(old) < retention));
      for (const old of earlier) if (!old.foundAt && Number.isFinite(announcedAt(old))) old.foundAt = new Date(announcedAt(old)).toISOString();
      row.news = this.keepNews([...papers.map(toNews), ...earlier], panelSeen, storeLimit);
      /* Two things the same records say for free.

         Where the author signs from now. The watched row remembers the lab it
         was added with; a new paper signed from somewhere else is a move --
         a lab relocating, a postdoc going independent -- and that is the
         kind of news a person watching someone actually wants. Only the
         author's own authorship counts, and only when it names a place.

         Who they publish with for the first time. A name not seen on any of
         their earlier papers is a collaboration starting, which tends to
         come before the topic shift it produces. */
      /* A move is claimed only when the old place has stopped appearing.

         The first version took the first institution on the newest authorship
         and called any difference a move. Run live, that produced
         "Harvard University → Broad Institute" for someone appointed at both,
         "UC Berkeley → QB3" for an institute inside Berkeley, and
         "DTU → Technical University of Denmark" for one place under two
         names. OpenAlex lists every institution an author signs with, in no
         fixed order, and a person watching someone would have read each of
         those as news. So: every institution on every new paper is collected;
         if the remembered one is still among them, nothing has changed; a
         move needs at least two new papers signed without it, and "to" is the
         place that appears most. */
      /* The same place under two names is not a move. OpenAlex names are
         canonical, but a watched row may have been added with "MIT" by hand;
         so a ROR match settles it when both sides have one, and otherwise a
         name that is the other's initials, or contained in it, is the same
         institution. Anything left is a real change of address. */
      const profile = profileNow;
      // Kept for the portrait search: Wikidata is found by ORCID.
      if (profile?.orcid) row.orcid = profile.orcid;
      // Kept so the list can be grouped by what people work on; no request of its own.
      if (profile?.subfield) row.subfield = profile.subfield;
      if (profile?.field) row.field = profile.field;
      const now = profile ? profile.places : [];
      if (now.length) {
        const had = Array.isArray(row.places) ? row.places : null;
        const same = (h, pl) => (h.ror && pl.ror) ? h.ror === pl.ror : samePlace(h.name, pl.name, '', '');
        if (!had) {
          /* First sight of the record: adopt OpenAlex's own name for the
             place the author was followed with -- "MIT chemistry" becomes
             "Massachusetts Institute of Technology" -- keeping the text
             given. When nothing listed resembles it, the current
             appointment is the baseline, and that is not news either. */
          const match = now.find(pl => samePlace(row.institution, pl.name, row.institutionRor, pl.ror)) || now[0];
          if (row.institution && match.name !== row.institution) row.institutionGiven = row.institution;
          row.institution = match.name;
          row.institutionRor = match.ror;
        } else {
          const still = now.filter(pl => had.some(h => same(h, pl)));
          if (!still.length) {
            // Every appointment on record has gone from the list: a move,
            // to the newest of the places now listed.
            const to = [...now].sort((m, n) => (n.until || 0) - (m.until || 0) || (n.since || 0) - (m.since || 0))[0];
            row.moved = {from: row.institution, to: to.name, at: checkedAt.slice(0, 10), rule: 2, since: to.since || null};
            row.previousInstitution = row.institution;
            row.previousInstitutionRor = row.institutionRor;
            row.institution = to.name;
            row.institutionRor = to.ror;
          } else if (row.moved && row.previousInstitution && now.some(pl => samePlace(row.previousInstitution, pl.name, row.previousInstitutionRor || '', pl.ror))) {
            // The old place is listed again: the move was a stint.
            row.institution = row.previousInstitution;
            row.institutionRor = row.previousInstitutionRor || '';
            delete row.previousInstitution; delete row.previousInstitutionRor; delete row.moved;
          } else if (!still.some(pl => (pl.ror && pl.ror === row.institutionRor) || pl.name === row.institution)) {
            // The place shown has dropped off while another appointment
            // remains: show the one still listed.
            row.institution = still[0].name;
            row.institutionRor = still[0].ror;
          }
        }
        row.places = now.map(pl => ({name: pl.name, ror: pl.ror, since: pl.since || null}));
      }
      /* Who they are publishing with for the first time.

         The history this is measured against used to be the names carried
         from earlier *news* -- at most eight papers, and only ones the sweep
         happened to surface. A collaborator of ten years who was not on that
         handful came up as "처음 함께 낸 저자", which is the one thing this
         line must never say wrongly. It is measured instead against every
         paper of theirs in the window, which the sweep already holds.

         A consortium paper names hundreds of people who have not started
         working with anyone, so a paper over fifteen authors says nothing
         about collaboration and is left out. */
      const windowWorks = found.get(row.id) || [];
      const newsIDs = new Set(papers.map(work => work.id));
      const known = new Set(row.coauthorsSeen || []);
      for (const work of windowWorks) {
        if (newsIDs.has(work.id)) continue;
        for (const person of work.people || []) if (person.name && !rowIDs.has(person.id)) known.add(person.name);
      }
      const fresherNames = [];
      for (const work of papers) {
        if ((work.people || []).length > 15) continue;
        for (const person of work.people || []) {
          if (!person.name || rowIDs.has(person.id)) continue;
          if (!known.has(person.name) && !fresherNames.includes(person.name)) fresherNames.push(person.name);
        }
      }
      // Only meaningful once there is a record to compare against: with
      // nothing else of theirs in the window, every colleague would be new.
      row.newCoauthors = known.size ? fresherNames.slice(0, 8) : [];
      row.coauthorsSeen = [...known, ...fresherNames].slice(-400);
      /* A finished run moves the date to now. A run that finished a carried
         batch moves it only to when that batch was begun: works newer than
         that sit on the pages it skipped, and the next check must see them. */
      if (!unfinished.has(short) && !unfinished.has(row.id)) row.sweptAt = resumed.get(short) || resumed.get(row.id) || checkedAt;
      /* Two different numbers, because they answer two different questions.
         `works` is what is still waiting to be looked at; `added` is what this
         run actually turned up. Datasets and repository deposits are in
         neither: of 64 "new papers" over 109 authors, sixteen were copies of
         work already published. */
      const waiting = row.news.filter(work => !panelSeen.has(CustomStyleRuntime.seenWorkKey(work))).length;
      if (waiting) result.withNews++;
      result.works += waiting;
      result.added += row.news.filter(work => !announced.has(work.id)).length;
    }
    // The list as it stands now, not as it stood when the requests went out.
    this.cache.watchedAuthors = this.watchedAuthors();
    this.dirty = true;
    try { result.signals = await this.sweepWatchedSignals({signal}); } catch (error) { this.Z.logError(error); }
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

  /* A paper held as "동명이인일 수 있음". Confirming files it as ordinary news
     and teaches the row the places and country it was signed from, so the
     same lab's next papers pass; rejecting marks it seen and remembers it, so
     no later sweep brings it back. */
  async resolveNamesake(authorID, workID, accept) {
    const id = this.discoverTools.shortID(authorID);
    const rows = this.watchedAuthors();
    const row = rows.find(entry => entry.id === id);
    const work = row && (row.unverified || []).find(w => w.id === workID);
    if (!work) return false;
    row.unverified = row.unverified.filter(w => w.id !== workID);
    if (accept) {
      row.confirmed = [...new Set([workID, ...(row.confirmed || [])])].slice(0, 200);
      const placesSeen = new Map((row.placesSeen || []).map(pl => [pl.name, pl]));
      for (const name of work.places || []) if (!placesSeen.has(name)) placesSeen.set(name, {name, ror: ''});
      row.placesSeen = [...placesSeen.values()].slice(-30);
      if (work.country) row.countriesSeen = [...new Set([...(row.countriesSeen || []), work.country])].slice(-10);
      const owned = this.libraryDOIs();
      row.news = this.keepNews([{
        id: work.id, title: work.title, venue: work.venue, doi: work.doi, type: work.type,
        preprint: /preprint/i.test(work.type || '') || /rxiv|research square|preprints?\b|ssrn/i.test(work.venue || ''),
        date: work.date, inLibrary: !!work.doi && owned.has(work.doi), people: work.people || [],
        citations: null, position: '', corresponding: false,
        places: work.places || [], country: work.country || '', subfield: work.subfield || '', verified: 'confirmed'
      }, ...(row.news || [])], this.panelSeenKeys(), this.NEWS_STORE_LIMIT || 200);
    } else {
      row.rejected = [...new Set([workID, ...(row.rejected || [])])].slice(0, 200);
      row.seen = [...new Set([workID, ...(row.seen || [])])].slice(0, this.SEEN_LIMIT);
    }
    this.cache.watchedAuthors = rows;
    this.dirty = true;
    await this.flush();
    return true;
  }

  // --- A face and a circle of colleagues for a followed author ---

  portraitCache() {
    const store = this.cache.authorPortraits;
    return store && typeof store === 'object' && !Array.isArray(store)
      ? store : (this.cache.authorPortraits = {});
  }

  portraitOf(authorID) {
    const hit = this.portraitCache()[this.discoverTools.shortID(authorID)];
    return hit && hit.url ? hit : null;
  }

  async fetchText(url, {signal, limit = 1_000_000} = {}) {
    const response = await this.Z.HTTP.request('GET', url,
      {responseType: 'text', timeout: 12000, successCodes: false,
       headers: {Accept: 'text/html,application/xhtml+xml'}});
    signal?.throwIfAborted?.();
    if (response?.status !== 200) return null;
    // A homepage that redirects to Google Scholar is not read either: the page that answered is what counts.
    if (/^https?:\/\/scholar\.google\./i.test(String(response.responseURL || ''))) return null;
    const type = String(response.getResponseHeader?.('Content-Type') || '');
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    const body = String(response.responseText || response.response || '');
    return body.length > limit ? body.slice(0, limit) : body;
  }

  /* Wikidata's API, gently. It sheds load with 429 when busy; the answer is
     to wait what it asks (up to half a minute) once, and then to give up for
     this round rather than to hammer it or to record "no photo". */
  async wikidataJSON(url, {signal} = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 20000, successCodes: false,
        headers: {'Api-User-Agent': `StyleCustomZoteroPlugin/${this.version || 'dev'} (Zotero plugin; author portraits)`}});
      signal?.throwIfAborted?.();
      if (response?.status === 200) return response.response;
      if (response?.status === 429 && attempt === 0) {
        const wait = Math.min(30, Number(response.getResponseHeader?.('Retry-After')) || 10);
        await this.pause(wait * 1000);
        continue;
      }
      const error = new Error(response?.status === 429 ? 'Wikidata is limiting requests right now' : `Wikidata answered ${response?.status}`);
      error.busy = response?.status === 429;
      throw error;
    }
    return null;
  }

  /* Faces for followed authors, for one or for the whole watchlist.

     It used to look in one place: a homepage the author had listed on ORCID,
     asked for once, when that author's page was opened. Most researchers list
     none, and the ORCID request never said it wanted JSON, which ORCID does not
     send unless asked -- 109 watched authors had 4 lookups and 0 faces.

     Now, in order, and in batches where the source allows:
       1. the ORCID, from the watchlist's own profile sweep, else OpenAlex's
          profile batch (50 people a request);
       2. Wikidata by ORCID -- a freely licensed photograph on Wikimedia Commons
          (two requests per 50 people), and the person's official website;
       3. failing a photograph, that website and the ones listed on ORCID, read
          for a portrait named as this person (author-portrait.js decides).
     A miss is remembered for two months; a busy Wikidata is not a miss. */
  async findPortraits(people, {signal, onProgress, refresh = false} = {}) {
    const tools = this.portraitTools, store = this.portraitCache(), discover = this.discoverTools;
    const result = {asked: 0, found: 0, wikimedia: 0, scholar: 0, homepage: 0, none: 0, busy: false, requests: 0};
    const want = (Array.isArray(people) ? people : [])
      .map(person => ({...person, id: discover.shortID(person?.id)}))
      .filter(person => person.id.startsWith('A'))
      .filter(person => {
        const known = store[person.id];
        return refresh || !known || tools.stale(known.checkedAt) || (!known.url && (known.v || 1) < this.PORTRAIT_VERSION);
      });
    result.asked = want.length;
    if (!want.length) return result;

    const lacking = want.filter(person => !tools.bareOrcid(person.orcid)).map(person => person.id);
    for (let i = 0; i < lacking.length; i += discover.AUTHOR_BATCH) {
      const url = discover.watchedProfilesURL(lacking.slice(i, i + discover.AUTHOR_BATCH), this.discoverOptions());
      if (!url) continue;
      try {
        result.requests++;
        for (const profile of discover.readProfiles(await this.discoverJSON(url, {signal}))) {
          const person = want.find(row => row.id === profile.id);
          if (person && profile.orcid) person.orcid = profile.orcid;
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (this.outOfBudget(error)) break;
        this.Z.logError(error);
      }
    }

    const byOrcid = new Map();
    const orcids = [...new Set(want.map(person => tools.bareOrcid(person.orcid)).filter(Boolean))];
    try {
      const qids = [];
      for (let i = 0; i < orcids.length; i += tools.WIKIDATA_SEARCH_BATCH) {
        onProgress?.('wikidata', i, orcids.length);
        result.requests++;
        qids.push(...tools.readWikidataSearch(await this.wikidataJSON(tools.wikidataSearchURL(orcids.slice(i, i + tools.WIKIDATA_SEARCH_BATCH)), {signal})));
        await this.pause(800);
      }
      for (let i = 0; i < qids.length; i += tools.WIKIDATA_ENTITY_BATCH) {
        result.requests++;
        const found = tools.readWikidataEntities(await this.wikidataJSON(tools.wikidataEntitiesURL(qids.slice(i, i + tools.WIKIDATA_ENTITY_BATCH)), {signal}));
        for (const [orcid, row] of found) byOrcid.set(orcid, row);
        await this.pause(800);
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      result.busy = !!error?.busy;
      this.Z.logError(error);
    }

    for (const [index, person] of want.entries()) {
      signal?.throwIfAborted?.();
      onProgress?.('pages', index, want.length);
      const orcid = tools.bareOrcid(person.orcid);
      const known = byOrcid.get(orcid);
      const record = {url: '', source: '', page: '', orcid, v: this.PORTRAIT_VERSION, checkedAt: new Date().toISOString()};
      if (known?.image) {
        record.url = tools.commonsThumb(known.image, 160);
        record.page = tools.commonsPage(known.image);
        record.source = 'Wikimedia Commons';
        result.wikimedia++;
      } else if (known?.scholar && await this.scholarHasPhoto(known.scholar, result, signal)) {
        record.url = tools.scholarPhoto(known.scholar);
        record.page = tools.scholarPage(known.scholar);
        record.source = 'Google Scholar';
        result.scholar++;
      } else {
        const pages = known?.site ? [known.site] : [];
        const listURL = tools.orcidURL(orcid);
        if (listURL) {
          try {
            result.requests++;
            pages.push(...tools.readResearcherURLs(await this.discoverJSON(listURL, {signal, headers: {Accept: 'application/json'}})));
          } catch (error) { if (error?.name === 'AbortError') throw error; this.Z.logError(error); }
        }
        // A Google Scholar profile page is not read: the photo there is taken, if at all, by its ID from Wikidata above.
        for (const page of [...new Set(pages)].filter(url => !/^https?:\/\/scholar\.google\./i.test(url)).slice(0, 2)) {
          let markup = null;
          try { result.requests++; markup = await this.fetchText(page, {signal}); }
          catch (error) { if (error?.name === 'AbortError') throw error; this.Z.logError(error); continue; }
          const found = markup ? tools.choose(markup, page, person.name) : null;
          // A page's own claim about its picture can point at another page:
          // one DTU profile's "image" answered with HTML. Only an image counts.
          if (found && !(await this.isImage(found.url, {signal}))) continue;
          if (found) { record.url = found.url; record.source = found.source; record.page = page; result.homepage++; break; }
        }
        // Wikidata could not be asked: this is not an answer, so nothing is kept.
        if (!record.url && result.busy) continue;
        await this.pause(150);
      }
      store[person.id] = record;
      if (record.url) result.found++; else result.none++;
      this.dirty = true;
    }
    await this.flush();
    return result;
  }

  // What a HEAD request says a URL is: null when it did not answer, '' when it
  // answered without a type.
  async imageType(url, {signal} = {}) {
    try {
      const response = await this.Z.HTTP.request('HEAD', url, {timeout: 10000, successCodes: false});
      signal?.throwIfAborted?.();
      if (!(response?.status >= 200 && response?.status < 400)) return null;
      return String(response?.getResponseHeader?.('Content-Type') || '');
    } catch (error) { if (error?.name === 'AbortError') throw error; return null; }
  }

  // Whether the row under a click was already selected before it: an unknown answer counts as yes, so nothing stops working where the tree cannot say.
  rowSelected(doc, index) {
    const selection = doc?.defaultView?.ZoteroPane?.itemsView?.selection;
    return typeof selection?.isSelected === 'function' ? !!selection.isSelected(index) : true;
  }
  /* The papers a click on this row stands for: every selected paper when the
     row is one of them, otherwise just the row. */
  rowSelection(doc, item) {
    let chosen = [];
    try { chosen = doc.defaultView?.ZoteroPane?.getSelectedItems?.() || []; } catch (_) {}
    chosen = chosen.filter(ref => this.isRegular(ref));
    return chosen.length > 1 && chosen.some(ref => ref.id === item.id) ? chosen : [item];
  }
  /* A star in the rating column. Like the status cell, a click on a selected
     row speaks for every selected row. The same star again clears, but only
     when every one of them already has that rating; otherwise it sets it. */
  rateFromCell(doc, item, n) {
    const win = doc.defaultView;
    const items = this.rowSelection(doc, item).filter(ref => this.canEdit(ref));
    if (!items.length) return Promise.resolve();
    const now = ref => { try { return Number(this.state(ref)?.rating) || 0; } catch (_) { return 0; } };
    const rating = items.every(ref => now(ref) === n) ? 0 : n;
    return this.edit(items, {rating})
      .then(() => { if (items.length > 1) return this.say(win, (rating ? this.t("별점을 매겼습니다") + " · " + "★".repeat(rating) : this.t("별점을 지웠습니다")) + " · ×" + items.length); })
      .catch(e => { this.Z.logError(e); return this.say(win, e?.message || String(e), {error: true}); });
  }
  /* Reading status from the item list: a small menu of the three states with
     the current one checked, as a native popup like Zotero's own menus. Where
     a popup cannot be made the click cycles Unread -> Reading -> Done. The
     write is edit(), the path the context menu and the panel use. */
  pickStatus(doc, cell, items, rendered) {
    const words = {unread: "안 읽음", reading: "읽는 중", done: "완료"};
    /* The state now, not the one the cell was drawn with: reading time can have
       turned a paper from unread to reading since the paint, and choosing
       Unread must not be skipped as "same". Skipped only when every selected
       paper already has the choice. */
    const nowOf = item => { try { return this.state(item)?.status || null; } catch (_) { return null; } };
    const allAre = status => items.length > 0 && items.every(item => (nowOf(item) ?? rendered) === status);
    const current = nowOf(items[0]) ?? rendered;
    const apply = status => {
      const win = doc.defaultView;
      return this.edit(items, {status})
        .then(() => this.say(win, this.t("읽기 상태를 바꿨습니다") + " · " + this.t(words[status]) + (items.length > 1 ? " · ×" + items.length : "")))
        .catch(e => { this.Z.logError(e); return this.say(win, e?.message || String(e), {error: true}); });
    };
    const make = tag => doc.createXULElement?.(tag);
    let popup = null;
    try { popup = make("menupopup"); } catch (_) {}
    const host = doc.getElementById?.("mainPopupSet") || doc.documentElement;
    if (!popup || !host || typeof popup.openPopup !== "function") {
      return apply({unread: "reading", reading: "done", done: "unread"}[current] || "reading");
    }
    // Each state with the icon its cell shows, so the menu reads like the column.
    const P = this.palette(doc);
    const icon = status => {
      // The colour the cell and the title's tag dot use for this state.
      const own = status === "unread" ? null : this.statusTone(items[0], status, P);
      const colour = own ? own.mark : status === "done" ? P.done : status === "reading" ? P.reading : P.gray;
      const shape = status === "done" ? `<circle cx="8" cy="8" r="5.5" fill="${colour}"/>`
        : status === "reading" ? `<circle cx="8" cy="8" r="5" fill="none" stroke="${colour}" stroke-width="1.5"/><path d="M8 3a5 5 0 0 0 0 10z" fill="${colour}"/>`
        : `<circle cx="8" cy="8" r="5" fill="none" stroke="${colour}" stroke-width="1.5"/>`;
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${shape}</svg>`);
    };
    const title = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    for (const status of ["unread", "reading", "done"]) {
      const entry = make("menuitem");
      entry.setAttribute("label", title(this.t(words[status])));
      entry.classList?.add("menuitem-iconic");
      entry.setAttribute("image", icon(status));
      entry.setAttribute("type", "checkbox");
      if (allAre(status)) entry.setAttribute("checked", "true");
      entry.addEventListener("command", () => { if (!allAre(status)) apply(status); });
      popup.appendChild(entry);
    }
    popup.addEventListener("popuphidden", () => popup.remove?.(), {once: true});
    host.appendChild(popup);
    popup.openPopup(cell, "after_start", 0, 0, true, false);
    return null;
  }
  /* The "more" column's button: a click behaves like a right click on its row. */
  moreButton(doc, index, item) {
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.type = "button"; button.className = "sc-more"; button.textContent = "⋯";
    button.title = this.t("이 행의 메뉴 · 셀을 우클릭하면 그 열의 작업이 맨 위에 나옵니다"); button.setAttribute("aria-label", this.t("더 보기"));
    button.setAttribute("data-opens", "menu"); button.tabIndex = -1;
    // The menu is for the row (openRowMenu selects an unselected row itself); the press must not reach the list and narrow a multi-selection.
    for (const type of ["mousedown", "mouseup"]) button.addEventListener(type, event => event.stopPropagation());
    button.addEventListener("click", event => {
      event.stopPropagation(); event.preventDefault();
      this.openRowMenu(doc, button, index, item).catch(error => this.Z.logError(error));
    });
    return button;
  }
  async openRowMenu(doc, anchor, index, item) {
    const win = doc.defaultView, pane = win.ZoteroPane, popup = doc.getElementById("zotero-itemmenu");
    if (!pane || !popup) return;
    if (!this.rowSelected(doc, index)) pane.itemsView?.selection?.select?.(index);
    await pane.buildItemContextMenu();
    popup.openPopup(anchor, "after_end", 0, 0, true, false);
  }
  /* The key (our own, un-namespaced, or Zotero's) of the column a cell belongs to. */
  columnKeyFor(win, cell) {
    const columns = win.ZoteroPane?.itemsView?.tree?._getVisibleColumns?.() || [];
    const column = columns.find(c => cell.classList.contains(c.dataKey));
    if (!column) return null;
    for (const [own, namespaced] of this.featureColumns || []) if (namespaced === column.dataKey) return own;
    return column.dataKey;
  }
  /* Focus a field in the item pane's info box, opening the pane if it is collapsed. */
  editField(win, item, field) {
    const pane = win.ZoteroPane;
    if (pane?.itemPane?.collapsed) pane.itemPane.collapsed = false;
    const box = win.document.getElementById("zotero-editpane-info-box");
    if (box) box.open = true;
    if (field === "creator") { box?.querySelector?.('[id^="creator-0-"]')?.focus?.(); return; }
    if (typeof box?.focusField === "function") box.focusField(field);
    else throw new Error(this.t("항목 창에서 이 필드를 찾지 못했습니다."));
  }
  /* Filter Zotero's list to one journal through its own search box. */
  async filterListBy(win, text) {
    const search = win.document.getElementById("zotero-tb-search");
    const box = search?.searchTextbox || win.document.getElementById("zotero-tb-search-textbox");
    if (!box) throw new Error(this.t("검색창을 찾지 못했습니다."));
    // The default quick search covers title, creators and year only; a journal needs all fields.
    // Switched only for this search: when the box is cleared, the reader's own mode comes back.
    const before = this.Z.Prefs.get("search.quicksearch-mode");
    if (before === "titleCreatorYear") {
      this.Z.Prefs.set("search.quicksearch-mode", "fields");
      const restore = () => { if (box.value) return; box.removeEventListener("input", restore); search?.removeEventListener?.("command", restore); try { this.Z.Prefs.set("search.quicksearch-mode", before); } catch (ignored) {} };
      box.addEventListener("input", restore); search?.addEventListener?.("command", restore);
    }
    box.value = String(text).replace(/"/g, "");
    await win.ZoteroPane.search();
    this.say(win, this.t("목록을 이 저널로 걸렀습니다. 검색창의 ×로 해제합니다."));
  }
  attachCells(win, state) {
    state.cellsCleanup?.(); state.cellsCleanup = null;
    state.cellsCleanup = this.itemCells.attach(win, state, this, {hover: this.getSetting("hoverColumn")});
  }
  /* Zotero selects a row on mousedown, so by the click it is always selected.
     The cell asks on its own mousedown, which runs before the tree's, and the
     click reads that answer. */
  /* On a row that is already selected the control acts and the row's selection must
     stay as it is. Zotero changes the selection on mouseup (a press-and-release on one
     of several selected rows narrows the selection to that row), so stopping `click` is
     not enough: mousedown and mouseup are kept from the row too, as Zotero's own
     `.cell.clickable` cells do. On an unselected row the press goes through, and the
     row selects as it always does. */
  guardClick(cell, doc, index) {
    const keep = event => { if (cell.dataset.wasSelected === 'true') event.stopPropagation(); };
    cell.addEventListener('mousedown', event => { cell.dataset.wasSelected = String(this.rowSelected(doc, index)); keep(event); });
    cell.addEventListener('mouseup', keep);
    return () => cell.dataset.wasSelected !== 'false';
  }

  /* The figure a metric column draws: '' when there is none. */
  /* state() for the panel's own lists and totals: a legacy count (no provider, no
     date) is not a current figure, so it is not summed, ranked or averaged there. */
  panelState(item) {
    const state = this.state(item);
    if (!state.citationLegacy) return state;
    return {...state, citations: null, legacyCitations: state.citations,
      citationSource: `legacy · unverified: ${state.citations} (${state.citationSource}), not counted`};
  }
  displayValue(key, item) {
    const state = this.state(item);
    if (key === "if") return state.impactFactor != null && Number.isFinite(Number(state.impactFactor)) ? String(state.impactFactor) : "";
    if (key === "oaCitedness") { const estimate = this.journalCitedness(item); return estimate && Number.isFinite(Number(estimate.citedness)) ? String(estimate.citedness) : ""; }
    if (key === "citations") return state.citations == null ? "" : String(state.citations);
    if (key === "time") return String(Math.max(0, Number(state.seconds) || 0));
    if (key === "progress") { const p = this.pageProgress(item); return p.percent === null || p.percent === undefined ? "" : String(p.percent); }
    return "";
  }
  /* Zotero compares column values as numeric-aware text (Intl.Collator
     numeric) and multiplies the result by the direction, so "12.5" sorted
     below "12.25" and blank rows came first whenever the list ran highest
     first. A number becomes the ordered bits of its double, twenty digits,
     behind "1|"; a blank becomes "2|" going up and "0|" going down, so it is
     last both ways. (Zotero 9.0.6 itemTree.js: compareString, the direction
     multiply, getSortDirection.) */
  sortKey(figure) {
    const n = figure === "" || figure == null ? NaN : Number(figure);
    if (!Number.isFinite(n) || n < 0) {
      let direction = 1;
      try { direction = this.Z.getMainWindow?.()?.ZoteroPane?.itemsView?.getSortDirection?.() === -1 ? -1 : 1; } catch (_) {}
      return direction === 1 ? "2|" : "0|";
    }
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, n === 0 ? 0 : n, false);
    return "1|" + view.getBigUint64(0, false).toString().padStart(20, "0");
  }

  // A menu choice is "already so" only when every selected paper is already so.
  alreadySo(items, key, value) {
    const states = (items || []).filter(item => this.isRegular(item)).map(item => this.state(item));
    const same = state => key === 'rating' ? Number(state.rating || 0) === Number(value) : state[key] === value;
    return states.length > 0 && states.every(same);
  }

  // Scholar's photo when the person uploaded one, not its grey placeholder.
  async scholarHasPhoto(id, result, signal) {
    result.requests++;
    return this.portraitTools.scholarIsPhoto(await this.imageType(this.portraitTools.scholarPhoto(id), {signal}));
  }

  async isImage(url, options = {}) {
    const type = await this.imageType(url, options);
    // A server that will not say is given the benefit; one that says HTML is not.
    return type != null && (!type || /^image\//i.test(type));
  }

  // One author, when their page is opened: the same search, for one.
  async fetchPortrait(person, {signal, refresh = false} = {}) {
    const id = this.discoverTools.shortID(person?.id);
    if (!id.startsWith('A')) return null;
    await this.findPortraits([{...person, id}], {signal, refresh});
    return this.portraitOf(id);
  }

  // Every followed author at once, from the watchlist's button.
  // One search at a time: the button and the quiet pass after a news sweep
  // share it rather than asking Wikidata twice.
  async findWatchedPortraits(options = {}) {
    if (this.portraitJob) return this.portraitJob;
    this.portraitJob = this.findPortraits(this.watchedAuthors(), options);
    try { return await this.portraitJob; } finally { this.portraitJob = null; }
  }

  // How many followed authors have never been looked for, or are due again.
  portraitsDue() {
    const store = this.portraitCache(), tools = this.portraitTools;
    return this.watchedAuthors().filter(person => {
      const known = store[this.discoverTools.shortID(person?.id)];
      return !known || tools.stale(known.checkedAt) || (!known.url && (known.v || 1) < this.PORTRAIT_VERSION);
    }).length;
  }

  // No extra requests: the works the author tab already fetched carry every
  // authorship, so the circle of colleagues is already in hand.
  coauthorsOf(authorID, works) {
    const ids = this.authorIDs ? this.authorIDs(authorID) : [];
    return this.portraitTools.coauthors(works, ids.length > 1 ? ids : authorID);
  }

  // What this author has published since the user last looked.
  async authorUpdates(authorID, {limit = 25, signal} = {}) {
    const id = this.discoverTools.shortID(authorID);
    const watched = this.watchedRowOf ? this.watchedRowOf(id) : this.watchedAuthors().find(row => row.id === id);
    /* Asked once per session: the card, 관심 등록, 확인함 and every co-author
       chip reopened this page and each paid two metered requests. A merged
       person's works are asked for under every id they carry. */
    const ids = watched ? CustomStyleRuntime.authorIDsOf(watched) : [id];
    const {profile, works} = await this.authorActivityCached(watched ? watched.id : id, {limit, signal, ...(ids.length > 1 ? {ids} : {})});
    const seen = new Set(watched?.seen || []);
    // Papers held under 확인 필요 or turned down are not news: the list and the
    // detail read one classification.
    const held = new Set([...(watched?.unverified || []).map(w => w?.id), ...(watched?.rejected || [])]);
    // The same count as the card on the watchlist, which leaves out datasets.
    const fresh = watched ? works.filter(work => !seen.has(work.id) && !held.has(work.id) && !CustomStyleRuntime.NOT_A_PAPER.test(String(work.type || ''))) : [];
    return {profile, works, fresh, watching: !!watched, checkedAt: watched?.checkedAt || null};
  }

  // Marking as read is explicit: opening the tab should not quietly clear the news.
  async markAuthorSeen(authorID, works) {
    const id = this.discoverTools.shortID(authorID);
    const rows = this.watchedAuthors();
    const row = rows.find(entry => entry.id === id) || rows.find(entry => (entry.alsoIds || []).includes(id));
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
  /* The address sent to OpenAlex and Crossref to join their polite pool.

     It used to fall back to the Zotero sync username when that looked like an
     email. Plenty of people sign in to Zotero with their email, so for them
     this plugin would have started putting their address in the URL of every
     request to two outside services, and in those services' logs, without ever
     saying so. Nobody agreed to that by setting up sync.

     Only an address the person typed into this setting is used, and it is only
     ever theirs to give. */
  contactEmail() {
    const clean = value => String(value == null ? '' : value).trim();
    const set = clean(this.pref('citationEmail', '')) || clean(this.Z.Prefs.get('extensions.zotpop.email', true));
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set) ? set : '';
  }

  // The schema key is all lower case. A capitalised misspelling is not a
  // preference, it is always undefined, so the citation sweep ran anonymous and
  // spent OpenAlex's unauthenticated $0.01/day in about ten requests while a
  // perfectly good key sat in ZotPoP's prefs.
  // The USPTO Open Data Portal key, if the user has one. Nothing patent-related
  // runs without it, and the key is sent only to api.uspto.gov.
  patentsKey() {
    return String(this.pref('usptoApiKey', '') || '').trim();
  }

  /* Patents by the followed authors. A filing is the earliest public sign of
     where a lab is heading, often a year before the paper. One request per
     author, at most once a week each, newest first; the first look is the
     baseline and later ones report what was not there before. */
  async sweepWatchedPatents({signal, onProgress, maxAgeDays = 7} = {}) {
    const key = this.patentsKey();
    const rows = this.watchedAuthors();
    const result = {authors: rows.length, checked: 0, withPatents: 0, fresh: 0, requests: 0, skipped: '', unauthorized: false, budgetGone: false};
    if (!key) { result.skipped = 'no-key'; return result; }
    const stale = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const due = rows.filter(row => !row.patentsAt || Date.parse(row.patentsAt) < stale);
    for (const [index, row] of due.entries()) {
      if (signal?.aborted || !this.active || this.stopping) break;
      onProgress?.(index, due.length);
      const url = this.patentTools.searchURL(row.name);
      if (!url) continue;
      try {
        const payload = await this.discoverJSON(url, {signal, headers: this.patentTools.headers(key)});
        result.requests++;
        const found = this.patentTools.readPatents(payload).filter(patent => this.patentTools.matchesInventor(patent, row.name));
        const seen = new Set(row.patentsSeen || []);
        const fresh = seen.size || row.patentsAt ? found.filter(patent => !seen.has(patent.id)) : [];
        row.patents = found.slice(0, 8).map(patent => ({...patent, fresh: fresh.includes(patent)}));
        row.newPatents = fresh.slice(0, 8).map(patent => patent.id);
        row.patentsSeen = [...new Set([...seen, ...found.map(patent => patent.id)])].slice(-200);
        row.patentsAt = new Date().toISOString();
        result.checked++;
        if (found.length) result.withPatents++;
        result.fresh += fresh.length;
        this.dirty = true;
      } catch (error) {
        const status = Number(error?.status || error?.xmlhttp?.status || 0);
        if (status === 401 || status === 403) { result.unauthorized = true; break; }
        if (this.outOfBudget(error) || status === 429) { result.budgetGone = true; break; }
        this.Z.logError(error);
      }
      if (index + 1 < due.length) await this.pause(1000);
    }
    if (result.checked) { this.cache.watchedAuthors = this.watchedAuthors(); await this.flush(); }
    return result;
  }

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

  /* Once OpenAlex has said the day's budget is spent, every loop that met the
     refusal stopped -- but the next feature asked again, and the next. The
     refusal is remembered until the budget resets (midnight UTC), and an
     OpenAlex request in that window fails at once without being sent. */
  async discoverJSON(url, {signal, headers} = {}) {
    const openAlex = /^https:\/\/api\.openalex\.org\//.test(String(url));
    if (openAlex && this.openAlexSpentUntil && Date.now() < this.openAlexSpentUntil) {
      throw Object.assign(new Error('OpenAlex insufficient budget (held until reset)'), {status: 429, held: true});
    }
    try {
      const response = await this.Z.HTTP.request('GET', url, {responseType: 'json', timeout: 30000, ...(headers ? {headers} : {})});
      signal?.throwIfAborted?.();
      return response?.response;
    } catch (error) {
      // Only OpenAlex's own refusal: a 429 whose body says so. The message carries the URL, and a title with "budget" in it is not a spent budget.
      const status = Number(error?.status ?? error?.xmlhttp?.status ?? 0);
      let body = '';
      try { const raw = error?.xmlhttp?.response; body = typeof raw === 'string' ? raw : JSON.stringify(raw || ''); } catch (_) {}
      if (openAlex && status === 429 && /insufficient budget|budget exceeded|daily .*limit/i.test(body)) {
        const now = new Date();
        this.openAlexSpentUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      }
      throw error;
    }
  }

  /* Titles for bare OpenAlex IDs -- the papers a citation map knows only as
     "W2091…". One request per fifty, remembered in the store, so the list
     under the graph costs nothing the second time. */
  async worksByID(ids, {signal} = {}) {
    const tools = this.discoverTools;
    const store = this.cache.workMeta && typeof this.cache.workMeta === 'object' ? this.cache.workMeta : (this.cache.workMeta = {});
    const want = [...new Set((ids || []).map(id => tools.shortID(id)).filter(Boolean))];
    const missing = want.filter(id => !store[id]);
    for (let i = 0; i < missing.length; i += 50) {
      const url = tools.worksByIDsURL(missing.slice(i, i + 50), this.discoverOptions());
      if (!url) continue;
      for (const work of tools.readWorks(await this.discoverJSON(url, {signal}))) {
        const id = tools.shortID(work.id);
        store[id] = {id, title: work.title || '', year: work.year || null, venue: work.venue || '', doi: work.doi || '',
          authors: (work.authors || []).slice(0, 5), citations: work.citations ?? null, type: work.type || ''};
      }
      this.dirty = true;
    }
    // Only the most recent few hundred stay; the store is not a second library.
    const keys = Object.keys(store);
    if (keys.length > 600) for (const key of keys.slice(0, keys.length - 600)) delete store[key];
    if (missing.length) await this.flush();
    return Object.fromEntries(want.filter(id => store[id]).map(id => [id, store[id]]));
  }

  /* Which library "held" refers to: the one the reader is looking at, else their own. */
  currentLibraryID() {
    let id = null;
    try { id = this.Z.getMainWindow?.()?.ZoteroPane?.getSelectedLibraryID?.(); } catch (_) { }
    return Number(id) || this.Z.Libraries.userLibraryID;
  }
  /* The active (not trashed) regular items with a DOI, read live from Zotero, each with the library it is in.
     The stored rows only say which items exist: they carry no DOI, and a trashed paper's row outlives the paper. */
  /* Built once and reused: itemForDOI is asked once per result row, and reading
     every item each time was 1,200 lookups x 200 rows. The Zotero item notifier
     drops it on any add, modify, trash or delete; a click re-verifies only the
     one item it returns. */
  invalidateHeldRows() { this._heldCache = null; }
  _heldRows() {
    const sig = Object.keys(this.cache.items || {}).length + ':' + Object.keys(this.cache.works || {}).length;
    if (this._heldCache?.sig === sig) return this._heldCache.rows;
    const rows = this._readHeldRows();
    this._heldCache = {sig, rows};
    return rows;
  }
  _readHeldRows() {
    const keys = new Set([...Object.keys(this.cache.items || {}), ...Object.keys(this.cache.works || {})]);
    const rows = [];
    for (const identity of keys) {
      const at = identity.indexOf(':');
      if (at < 1) continue;
      let item = null;
      try { item = this.Z.Items.getByLibraryAndKey?.(Number(identity.slice(0, at)), identity.slice(at + 1)); } catch (_) { }
      if (!item || item.deleted || item.isRegularItem?.() === false || item.isFeedItem) continue;
      let doi = '';
      try { doi = this.discoverTools.bareDOI(item.getField?.('DOI')); } catch (_) { }
      if (doi) rows.push({doi, item, libraryID: item.libraryID ?? Number(identity.slice(0, at))});
    }
    return rows;
  }

  // The paper on this library's shelf behind a DOI a suggestion names, so "보유" can lead to it.
  itemForDOI(doi, libraryID = this.currentLibraryID()) {
    const want = this.discoverTools.bareDOI(doi);
    if (!want) return null;
    const find = () => this._heldRows().find(row => row.doi === want && row.libraryID === Number(libraryID))?.item || null;
    const found = find();
    if (!found) return null;
    // Verify this one item live; if it changed since the map was built, rebuild once.
    let live = false;
    try { live = !found.deleted && this.discoverTools.bareDOI(found.getField?.('DOI')) === want; } catch (_) { }
    if (live) return found;
    this.invalidateHeldRows();
    return find();
  }
  // The same paper in a different library, for "held in another library".
  itemInOtherLibrary(doi, libraryID = this.currentLibraryID()) {
    const want = this.discoverTools.bareDOI(doi);
    if (!want) return null;
    return this._heldRows().find(row => row.doi === want && row.libraryID !== Number(libraryID))?.item || null;
  }

  // Every DOI already on this library's shelf, so a suggestion can say "you have this".
  libraryDOIs(libraryID = this.currentLibraryID()) {
    const owned = new Set();
    for (const row of this._heldRows()) if (row.libraryID === Number(libraryID)) owned.add(row.doi);
    return owned;
  }
  // DOIs held in some other library and not in this one.
  otherLibraryDOIs(libraryID = this.currentLibraryID()) {
    const here = this.libraryDOIs(libraryID), other = new Set();
    for (const row of this._heldRows()) if (row.libraryID !== Number(libraryID) && !here.has(row.doi)) other.add(row.doi);
    return other;
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
      // A failed lookup must not be remembered as the answer -- but only this
      // lookup's entry goes: a newer one under the same key may already be
      // running after a "search again".
      if (this.discoverCache.get(key) === pending) this.discoverCache.delete(key);
      throw error;
    });
    this.discoverCache.set(key, pending);
    while (this.discoverCache.size > this.DISCOVER_CACHE_LIMIT) {
      this.discoverCache.delete(this.discoverCache.keys().next().value);
    }
    return pending;
  }

  relatedWorksCached(item, options = {}) {
    const seed = this.workFingerprint(item);this.noteFingerprint(item, seed);
    return this.discoverCached('related:' + this.identity(item) + '|' + seed, () => this.relatedWorks(item, options));
  }
  authorActivityCached(authorID, options = {}) {
    const ids = Array.isArray(options.ids) && options.ids.length > 1 ? '|' + options.ids.join('|') : '';
    return this.discoverCached('author:' + this.discoverTools.shortID(authorID) + ids, () => this.authorActivity(authorID, options));
  }
  authorsOfCached(item, options = {}) {
    const seed = this.workFingerprint(item);this.noteFingerprint(item, seed);
    return this.discoverCached('authors:' + this.identity(item) + '|' + seed, () => this.authorsOf(item, options));
  }

  /* One sweep for the citation map and the affiliations alike.

     Both come off the same OpenAlex record, so asking twice would be asking the
     same question twice. Fifty papers per request, and a paper already answered
     is skipped, so a second run over a library costs almost nothing. */
  paperWorks() {
    const store = this.cache.works;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.works = {});
  }

  institutionTable() {
    const store = this.cache.institutions;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.institutions = {});
  }

  /* Citation lists expire: 30 days for a found list, 14 for "OpenAlex has no
     such paper". An expired row is kept and shown with its date; it is asked
     again only by a press on that paper (refreshPaperLists) or by the graph's
     own fetch button with `stale`. No background sweep passes `stale`. */
  paperRowStatus(row) {
    if (!row) return 'missing';
    const E = this.constructor.EXPIRY_DAYS;
    return this.expiredAt(row.checkedAt, row.missing ? E.notFound : E.citationList) ? 'stale' : 'fresh';
  }
  citedByRowStatus(row) {
    if (!row) return 'missing';
    return this.expiredAt(row.checkedAt, this.constructor.EXPIRY_DAYS.citers) ? 'stale' : 'fresh';
  }
  // For one paper, what the graph should say about its stored lists.
  citationState(item) {
    const key = this.identity(item), works = this.paperWorks()[key], citers = this.citedByStore()[key];
    return {works: {state: this.paperRowStatus(works), checkedAt: works?.checkedAt || '', missing: !!works?.missing},
      citers: {state: this.citedByRowStatus(citers), checkedAt: citers?.checkedAt || ''}};
  }
  // The reader's press on one paper: its own lists again, nothing else.
  async refreshPaperLists(item, {signal} = {}) {
    const key = this.identity(item), hadCiters = !!this.citedByStore()[key];
    const works = await this.sweepPaperWorks([item], {signal, refetch: true});
    let citers = null;
    const row = this.paperWorks()[key];
    if (hadCiters && row?.openalex && !signal?.aborted) citers = await this.sweepCitedBy([item], {signal, refetch: true, limit: 50});
    if (works.found || works.missing || citers?.asked) { this.bumpState?.(); await this.refreshWindows?.(); }
    return {works, citers};
  }

  async sweepPaperWorks(items, {signal, onProgress, refetch = false, stale = false} = {}) {
    const store = this.paperWorks();
    const report = {asked: 0, found: 0, noDOI: 0, missing: 0, already: 0, references: 0, errors: 0, institutions: 0};
    const options = this.discoverOptions();
    const wanted = [];
    for (const item of [...new Set(items)]) {
      if (!this.isRegular(item)) continue;
      const key = this.identity(item);
      const doi = this.discoverTools.bareDOI(this.bibliographyRecord(item).DOI);
      // Kept only while it was fetched for the DOI the paper still has.
      /* Entries written before schema 2 (the last-author fallback, 2026-09-28)
         lack the corresponding/last author; they are refetched once, in the same
         batches of fifty. A "missing" answer has nothing to enrich and stays. */
      if (!refetch && store[key] && (store[key].doi || '') === (doi || '') && (store[key].missing || store[key].v >= 2)
        && !(stale && doi && this.paperRowStatus(store[key]) === 'stale')) { report.already++; continue; }
      if (!doi) { report.noDOI++; store[key] = {doi: '', missing: true, checkedAt: new Date().toISOString()}; continue; }
      wanted.push({key, doi, item});
    }
    const extraRows = [];
    for (let start = 0; start < wanted.length; start += 50) {
      if (signal?.aborted || !this.active || this.stopping) break;
      const batch = wanted.slice(start, start + 50);
      onProgress?.(start, wanted.length);
      const url = this.discoverTools.worksByDOIsURL(batch.map(row => row.doi), options);
      if (!url) continue;
      try {
        const works = this.discoverTools.readWorks(await this.discoverJSON(url, {signal}));
        report.asked += batch.length;
        const byDOI = new Map(works.map(work => [this.discoverTools.bareDOI(work.doi), work]));
        for (const row of batch) {
          const work = byDOI.get(row.doi);
          if (!work) {
            report.missing++;
            // A list found before is not lost to one empty answer; it is dated again.
            if (store[row.key]?.openalex && store[row.key].doi === row.doi) store[row.key].checkedAt = new Date().toISOString();
            else store[row.key] = {doi: row.doi, missing: true, checkedAt: new Date().toISOString()};
            continue;
          }
          report.found++;
          extraRows.push({item: row.item, count: work.citations, checkedAt: new Date().toISOString()});
          report.references += work.references.length;
          store[row.key] = {
            v: 2, doi: row.doi, openalex: work.id, year: work.year, citations: work.citations,
            venue: work.venue, references: (work.references||[]).slice(0, 500),
            // Only the two authorships the row will show. A consortium paper has
            // hundreds, and none of the rest is ever read.
            /* The two the row shows, as principals() picks them: without a
               corresponding flag the last author stands in, and was dropped
               here, so the row lost its lab. Kept once each, with the flag. */
            people: (() => {
              const picked = this.affiliationTools.principals(work.people);
              if (!picked) return [];
              const keep = [picked.first, picked.corresponding, ...work.people.filter(person => person.corresponding)].filter(Boolean);
              const seenPeople = new Set();
              return keep.filter(person => { const k = person.id || String(person.name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); if (seenPeople.has(k)) return false; seenPeople.add(k); return true; }).slice(0, 4);
            })(),
            checkedAt: new Date().toISOString()
          };
        }
        this.dirty = true;
      } catch (error) { this.Z.logError(error); report.errors++; }
    }
    report.institutions = await this.sweepInstitutions({signal});
    // The cache just learned these counts; an Extra line that disagrees is brought along (when the reader has that on).
    if (extraRows.length && typeof this.syncCitationExtras === 'function') {
      try { report.extras = (await this.syncCitationExtras(extraRows.filter(r => Number.isSafeInteger(r.count)))).written || 0; } catch (error) { this.Z.logError(error); }
    }
    if (report.found || report.noDOI || report.missing) { await this.flush(); await this.refreshWindows(); }
    return report;
  }

  citedByStore() {
    const store = this.cache.citedBy;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.citedBy = {});
  }

  /* Who cited each paper, which the shelf cannot say.

     References point backwards. Who built on a paper afterwards is the other
     half, and the half that says whether a thread is still moving -- but the
     citing papers are by definition ones the library may not hold, so they have
     to be asked for. One request per paper, so this is scoped to what the user
     is actually looking at rather than run over everything. */
  async sweepCitedBy(items, {signal, onProgress, limit = 40, refetch = false, stale = false} = {}) {
    const store = this.citedByStore();
    const works = this.paperWorks();
    const report = {asked: 0, found: 0, citers: 0, already: 0, noWork: 0, errors: 0};
    const options = this.discoverOptions();
    const list = [...new Set(items)].filter(item => this.isRegular(item));
    for (const [index, item] of list.entries()) {
      if (signal?.aborted || !this.active || this.stopping) break;
      onProgress?.(index, list.length);
      const key = this.identity(item);
      if (!refetch && store[key] && !(stale && this.citedByRowStatus(store[key]) === 'stale')) { report.already++; continue; }
      const work = works[key];
      if (!work?.openalex) { report.noWork++; continue; }
      const url = this.discoverTools.citingURL(work.openalex, {...options, limit});
      if (!url) { report.noWork++; continue; }
      try {
        const citing = this.discoverTools.readWorks(await this.discoverJSON(url, {signal}));
        report.asked++;
        if (citing.length) report.found++;
        report.citers += citing.length;
        store[key] = {
          openalex: work.openalex,
          // Only what the map draws. A citing work's own reference list would
          // multiply the cache by a hundred for something never shown.
          citers: citing.map(row => ({id: row.id, title: row.title, year: row.year,
            citations: row.citations, venue: row.venue})),
          checkedAt: new Date().toISOString()
        };
        this.dirty = true;
      } catch (error) { this.Z.logError(error); report.errors++; }
    }
    if (report.asked) { await this.flush(); await this.refreshWindows(); }
    return report;
  }

  // Shaped for the graph: paper id -> the works that cite it.
  citedByFor(items) {
    const store = this.citedByStore();
    const out = {};
    for (const item of items) {
      const row = store[this.identity(item)];
      if (row?.citers?.length) out[String(item.id)] = row.citers;
    }
    return out;
  }

  // Every institution the stored works mention, looked up once.
  async sweepInstitutions({signal} = {}) {
    const known = this.institutionTable();
    const works = Object.values(this.paperWorks());
    /* "Not found" is an answer only from a batch OpenAlex answered, and it
       expires after ninety days. A failed, cancelled or never-sent batch used
       to write "unknown" for good, and those institutions were never asked
       again. */
    const now = Date.now(), NOT_FOUND_DAYS = 90;
    for (const [ror, row] of Object.entries(known)) {
      if (row?.unknown && (!row.checkedAt || now - Date.parse(row.checkedAt) > NOT_FOUND_DAYS * 864e5)) delete known[ror];
    }
    /* An institution's h-index drifts (WashU 1885 to 2004 crossed a tier), so a
       found row is asked again after 180 days. Rows written before checkedAt
       existed count as stale once. The old figure stays until the new one arrives. */
    const STALE_DAYS = 180;
    const stale = Object.entries(known).filter(([, row]) => row && !row.unknown && row.ror
      && (!row.checkedAt || !(now - Date.parse(row.checkedAt) <= STALE_DAYS * 864e5))).map(([ror]) => ror);
    const wanted = [...new Set([...this.affiliationTools.institutionsNeeded(works.map(work => ({people: work?.people})), known), ...stale])];
    if (!wanted.length) return 0;
    const options = this.discoverOptions();
    let added = 0;
    for (let start = 0; start < wanted.length; start += 50) {
      if (signal?.aborted || !this.active || this.stopping) break;
      const batch = wanted.slice(start, start + 50);
      const url = this.discoverTools.institutionsURL(batch, options);
      if (!url) continue;
      try {
        const checkedAt = new Date().toISOString();
        const returned = new Set();
        for (const row of this.discoverTools.readInstitutions(await this.discoverJSON(url, {signal}))) {
          known[row.ror] = {...row, checkedAt};
          returned.add(row.ror);
          added++;
        }
        for (const ror of batch) {
          if (!known[ror]) known[ror] = {ror, name: '', hIndex: null, unknown: true, checkedAt};
          else if (!returned.has(ror)) known[ror].checkedAt = checkedAt;
        }
        this.dirty = true;
      } catch (error) {
        this.Z.logError(error);
        if (this.outOfBudget(error)) break;
      }
    }
    return added;
  }

  /* Where a followed author works, as far as the data already on disk says:
     the country and h-index of the institution by name, read from the papers'
     author records and the institution table. No request is made; an
     institution never seen in either has no country and no tier. */
  placeOf(institution) {
    const key = value => String(value || '').replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
    const wanted = key(institution);
    if (!wanted) return null;
    const table = this.institutionTable(), works = this.paperWorks();
    const signature = `${Object.keys(table).length}:${Object.keys(works).length}`;
    if (!this.placeIndex || this.placeIndex.signature !== signature) {
      const byName = new Map();
      const add = (name, country, ror) => {
        const k = key(name);
        if (!k) return;
        const row = byName.get(k) || {country: '', ror: ''};
        if (!row.country && country) row.country = String(country).toUpperCase();
        if (!row.ror && ror) row.ror = ror;
        byName.set(k, row);
      };
      for (const row of Object.values(table)) if (row && !row.unknown) add(row.name, row.country, row.ror);
      for (const work of Object.values(works)) for (const person of work?.people || []) add(person.institution, person.country, person.ror);
      this.placeIndex = {signature, byName};
    }
    const hit = this.placeIndex.byName.get(wanted);
    if (!hit) return null;
    const record = hit.ror ? table[hit.ror] : null;
    const hIndex = record?.hIndex ?? null;
    return {country: hit.country || record?.country || '', flag: this.affiliationTools.flag(hit.country || record?.country),
      hIndex, tier: hIndex ? this.affiliationTools.tierOf(hIndex) : null};
  }

  // What the row should say about where this paper came from.
  affiliationOf(item) {
    const work = this.paperWorks()[this.identity(item)];
    if (!work || !Array.isArray(work.people) || !work.people.length) return null;
    return this.affiliationTools.summarise(work.people, this.institutionTable());
  }

  async relatedWorks(item, {limit = 40, signal, have} = {}) {
    const options = this.discoverOptions();
    if (!this.discoverTools.workURL(this.bibliographyRecord(item), options)) throw new Error('이 문헌에는 DOI나 제목이 없어 조회할 수 없습니다. 둘 중 하나를 채운 뒤 다시 실행하세요.');
    const work = await this.seedWork(item, {signal});
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

  /* 새로 나온 관련 논문: what has been published lately on top of a whole
     shelf, rather than on top of one paper.

     Every other discovery feature here starts from a paper the reader has
     already opened. This one starts from a collection, a selection or the
     library, and answers the question that otherwise means leaving Zotero for
     a journal alert: has anything come out in the last few months that builds
     on what I hold. Ranked by how many of the reader's own papers each new
     one cites -- six of mine is my corner of the field, one much-cited method
     paper is usually somebody else's.

     Held papers whose OpenAlex record has never been fetched are counted, not
     skipped in silence: "nothing new" and "most of this shelf was never asked
     about" are different answers, and only one of them is reassurance. */
  async sweepFreshCiters(items, {days = 90, limit = 40, pages = 3, signal, onProgress} = {}) {
    const tools = this.discoverTools, options = this.discoverOptions();
    const store = this.paperWorks();
    const since = new Date(Date.now() - Math.max(1, days) * 864e5).toISOString().slice(0, 10);
    const report = {since, days, rows: [], seeds: 0, noWork: 0, found: 0, requests: 0,
      budgetGone: false, partial: false, truncated: false, at: new Date().toISOString()};
    const titleOf = new Map();
    for (const item of [...new Set(items)]) {
      if (!this.isRegular(item)) continue;
      const id = tools.shortID(store[this.identity(item)]?.openalex || '');
      if (!id.startsWith('W')) { report.noWork++; continue; }
      if (!titleOf.has(id)) titleOf.set(id, String(item.getField?.('title') || ''));
    }
    const seeds = [...titleOf.keys()];
    report.seeds = seeds.length;
    if (!seeds.length) return report;
    const batches = tools.freshBatches(seeds);
    const works = [];
    for (const [index, batch] of batches.entries()) {
      if (signal?.aborted || !this.active || this.stopping) break;
      let cursor = '*';
      for (let page = 0; page < Math.max(1, pages) && cursor; page++) {
        onProgress?.(index, batches.length);
        const url = tools.freshCitersURL(batch, {...options, since, cursor});
        if (!url) break;
        try {
          const payload = await this.discoverJSON(url, {signal});
          report.requests++;
          const found = tools.readWorks(payload);
          report.found += found.length;
          /* Each page is reduced to the part of it that matters before the
             next one is asked for. A whole library is twenty-odd batches, and
             every result arrives carrying its own bibliography -- hundreds of
             ids, of which only the handful that name a held paper is ever
             read. Kept whole, a sweep over this library would hold well over a
             hundred megabytes of reference lists in memory at once. */
          const held = new Set(seeds);
          for (const work of found) {
            if (CustomStyleRuntime.NOT_A_PAPER.test(String(work.type || ''))) continue;
            const cites = (work.references || []).filter(id => held.has(id));
            if (cites.length) works.push({...work, references: cites});
          }
          cursor = payload?.meta?.next_cursor || null;
          if (!found.length) break;
          // A shelf with more citers than the pages asked for says so, rather
          // than presenting the newest six hundred as the whole answer.
          if (cursor && page + 1 >= Math.max(1, pages)) report.truncated = true;
        } catch (error) {
          this.Z.logError(error);
          if (this.outOfBudget(error)) report.budgetGone = true;
          report.partial = true;
          break;
        }
      }
      if (report.budgetGone) break;
    }
    report.rows = tools.rankFreshCiters(works, {seeds, have: this.libraryDOIs(), limit,
      titleOf: id => titleOf.get(id)})
      /* The full reference list of each result existed only to work out which
         held papers it stands on, and `cites` is that answer. The rest is
         dropped before this is kept: the data file is read and written whole,
         and hundreds of ids per row would be paid for on every save. */
      .map(({references, subjects, people, abstract, finding, related, ...row}) => row);
    return report;
  }

  freshCiterStore() {
    const store = this.cache.freshCiters;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.freshCiters = {});
  }

  /* The same answer for a day, because it is a question about months.

     A partial answer is shown but never kept: a second visit would read it as
     the whole answer, and a spent budget is exactly the moment that happens. */
  async freshCitersCached(key, items, {maxAgeHours = 24, refresh = false, ...options} = {}) {
    const store = this.freshCiterStore();
    const saved = store[key];
    const age = saved ? Date.now() - Date.parse(saved.at) : Infinity;
    // The key carries what shelf this was asked about, so a changed shelf is a
    // different question; only the window has to be checked here.
    if (!refresh && saved && Number.isFinite(age) && age < maxAgeHours * 3600e3
      && saved.days === (options.days ?? 90)) return saved;
    const report = await this.sweepFreshCiters(items, options);
    if (!report.partial && !report.budgetGone) {
      store[key] = report;
      const keys = Object.keys(store).sort((a, b) => Date.parse(store[a].at) - Date.parse(store[b].at));
      while (keys.length > 20) delete store[keys.shift()];
      this.dirty = true;
      await this.flush();
    }
    return report;
  }

  /* Everything the reading order is built from: the paper, its references
     fifty at a time (each arrives with its own list, which is what makes the
     layers), the works citing it -- the most cited and the newest, since a
     well-cited paper's fifty most-cited citers are years old -- and one batch
     for the classics the references agree on and the paper leaves out.

     The batches run together. One that fails costs only its own fifty, and the
     plan says it is partial rather than passing a gap off as an answer; running
     out of the day's OpenAlex budget before anything came back is an error the
     panel explains, not an empty plan. */
  async readingPath(item, {signal, have, onProgress, maxReferences = 150} = {}) {
    const options = {...this.discoverOptions(), fields: this.discoverTools.PATH_FIELDS};
    const tools = this.discoverTools;
    const record = this.bibliographyRecord(item);
    const hasDOI = !!tools.bareDOI(record.DOI);
    const found0 = await this.findSeed(item, {signal, fields: options.fields + ',abstract_inverted_index'});
    if (found0.refused) throw this.sameWorkError(found0);
    const seed = found0.work;
    if (!seed) return null;
    const partial = [];
    let budgetGone = false;
    const settle = async (label, promise) => {
      try { return await promise; } catch (error) {
        if (signal?.aborted) throw error;
        if (this.outOfBudget(error)) budgetGone = true;
        this.Z.logError(error);
        partial.push(label);
        return null;
      }
    };
    const ids = seed.references.slice(0, maxReferences);
    const chunks = [];
    for (let start = 0; start < ids.length; start += 50) chunks.push(ids.slice(start, start + 50));
    let done = 0;
    const total = chunks.length + 2;
    const tick = () => onProgress?.(++done, total);
    const fetchWorks = list => {
      const batchURL = tools.worksByIDsURL(list, options);
      return batchURL ? this.discoverJSON(batchURL, {signal}).then(tools.readWorks) : Promise.resolve([]);
    };
    const citing = sort => {
      // Fifty most cited, because the obvious sequel is often among them (the
      // evolved CAST paper, cited 103 times, sat at 31st); twenty-five newest.
      const citingURL = tools.citingURL(seed.id, {...options, sort, limit: sort.startsWith('cited') ? 50 : 25});
      return citingURL ? this.discoverJSON(citingURL, {signal}).then(tools.readWorks) : Promise.resolve([]);
    };
    const [refChunks, cited, recent] = await Promise.all([
      Promise.all(chunks.map(list => settle('references', fetchWorks(list)).finally(tick))),
      settle('citers', citing('cited_by_count:desc')).finally(tick),
      settle('citers', citing('publication_date:desc')).finally(tick)
    ]);
    signal?.throwIfAborted?.();
    const refs = refChunks.flatMap(list => list || []);
    const citers = [...(cited || []), ...(recent || [])];
    if (ids.length && !refs.length && !citers.length && budgetGone) {
      const error = new Error('OpenAlex 오늘 한도를 다 써서 참고문헌을 읽지 못했습니다. 설정에서 OpenAlex 키를 넣거나 내일 다시 찾으세요.');
      error.status = 429;
      throw error;
    }
    const wanted = this.pathTools.foundationCandidates(seed, refs);
    const found = wanted.length ? await settle('foundations', fetchWorks(wanted.map(row => row.id))) || [] : [];
    signal?.throwIfAborted?.();
    // A merged record answers under a new id; its count belongs to the old one
    // and cannot be matched, so it is left out rather than shown as "0 papers".
    const count = new Map(wanted.map(row => [row.id, row.count]));
    const foundations = found.filter(work => count.has(work.id)).map(work => ({...work, count: count.get(work.id)}));
    const plan = this.pathTools.plan(seed, {refs, citers, foundations, have: have ?? this.libraryDOIs()});
    if (!plan) return null;
    /* The line of development behind the paper. Most of what it needs is
       already here -- the references and their own reference lists -- so this
       is at most one more request, for the works a generation above that the
       foundation pass did not already fetch. */
    const wantedMilestones = this.pathTools.milestoneCandidates(seed, refs);
    const known = new Map([...refs, ...found].filter(Boolean).map(work => [work.id, work]));
    const missing = wantedMilestones.map(row => row.id).filter(id => !known.has(id)).slice(0, 50);
    const extra = missing.length ? await settle('milestones', fetchWorks(missing)) || [] : [];
    signal?.throwIfAborted?.();
    plan.milestones = this.pathTools.milestones(seed, refs, [...known.values(), ...extra],
      {have: have ?? this.libraryDOIs()});
    // Authors for what is on screen: one small request, and a plan without
    // them is still a plan.
    const shown = [...plan.steps.flatMap(step => [...step.works, ...step.more]), ...plan.rest.slice(0, 20)];
    // The same request brings each shown paper's abstract, for the line that
    // says what it established.
    // Title and type come along so a review's line is its scope, not a result.
    const authorURL = tools.worksByIDsURL(shown.map(work => work.id).slice(0, 50), {...options, fields: 'id,title,type,authorships,abstract_inverted_index'});
    if (authorURL) {
      const people = await settle('authors', this.discoverJSON(authorURL, {signal}).then(tools.readWorks));
      const byID = new Map((people || []).map(work => [work.id, work]));
      for (const work of [...shown, ...plan.rest]) {
        const hit = byID.get(work.id);
        if (!hit) continue;
        work.authors = hit.authors;
        if (hit.finding) work.finding = hit.finding;
      }
    }
    // Only the steps show a finding line; the leftover list does not.
    await this.fillAbstracts(plan.steps.flatMap(step => [...step.works, ...step.more]).filter(work => !work.finding && !work.seed), {signal});
    plan.counts.total = seed.references.length;
    plan.counts.fetched = refs.length;
    plan.counts.citedBy = seed.citations;
    plan.partial = [...new Set(partial)];
    plan.budgetGone = budgetGone;
    plan.titleMatched = !hasDOI;
    return plan;
  }

  /* The rows OpenAlex has no abstract for, from Europe PMC: one request per
     thirty. A failed request leaves the rows as they were and is not taken
     for "no abstract". */
  async fillAbstracts(works, {signal} = {}) {
    const tools = this.discoverTools;
    const need = (works || []).filter(work => !work.finding && work.doi);
    for (let start = 0; start < need.length; start += 30) {
      const chunk = need.slice(start, start + 30);
      const url = tools.abstractsURL(chunk.map(work => work.doi));
      if (!url) continue;
      let found = null;
      try { found = tools.readAbstracts(await this.discoverJSON(url, {signal}), chunk.map(work => work.doi)); }
      catch (error) { if (signal?.aborted) throw error; this.Z.logError(error); }
      if (!found) continue;
      for (const work of chunk) {
        const body = found[tools.bareDOI(work.doi)];
        if (!body) continue;
        const finding = tools.findingOf(body, {review: this.pathTools.isReview(work)});
        if (finding) { work.finding = finding; work.findingSource = 'Europe PMC'; }
      }
    }
  }

  /* Kept on disk, so a paper opened again after a restart costs nothing: a
     plan is about thirty rows once the reference lists it was computed from
     are dropped. Three weeks, then asked again, since the citing side grows.
     A plan with holes in it is shown but not kept: the next visit asks again. */
  readingPathStore() {
    const store = this.cache.readingPaths;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.readingPaths = {});
  }

  compactPlan(plan) {
    // The abstract is read once, to decide the plan's mode; never stored.
    const keep = ['id', 'doi', 'title', 'year', 'citations', 'venue', 'type', 'openAccess', 'pdfURL', 'cited', 'after',
      'seed', 'start', 'step', 'needs', 'needIDs', 'shared', 'refCiters', 'review', 'versions', 'finding', 'findingSource', 'rank', 'sameSubject'];
    const slim = work => {
      const out = {};
      for (const key of keep) if (work[key] !== undefined && work[key] !== null && work[key] !== false) out[key] = work[key];
      // Twelve names are enough for the row's "외 N명" to stay right for most papers.
      if (work.authors?.length) out.authors = work.authors.slice(0, 12);
      return out;
    };
    // The leftover references are a list to scan, not to rank: sixty rows of
    // the bare facts keep a stored plan near 15 KB instead of 40.
    const bare = work => ({id: work.id, doi: work.doi, title: work.title, year: work.year, citations: work.citations,
      venue: work.venue, type: work.type, pdfURL: work.pdfURL, openAccess: work.openAccess || undefined,
      refCiters: work.refCiters, shared: work.shared, ...(work.authors?.length ? {authors: work.authors.slice(0, 5)} : {})});
    return {...plan, v: this.PATH_VERSION, steps: plan.steps.map(step => ({key: step.key, works: step.works.map(slim), more: step.more.map(slim)})),
      // The timeline's own rows: the support count is what the line is made of.
      milestones: plan.milestones ? {...plan.milestones,
        line: plan.milestones.line.map(work => ({...bare(work), support: work.support, cited: work.cited || undefined, inLibrary: work.inLibrary || undefined}))} : undefined,
      rest: plan.rest.slice(0, 60).map(bare), restTotal: plan.rest.length};
  }

  /* What a paper is, to OpenAlex: its DOI, or its title and year when it has
     none. Everything looked up for it is only good while this stays the same. */
  workFingerprint(item) {
    const record = this.bibliographyRecord(item);
    const doi = this.discoverTools.bareDOI(record.DOI);
    return doi ? 'doi:' + doi : 'title:' + String(record.title || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + '|' + (record.year || '');
  }
  /* A DOI filled in or corrected: the reference list, the citers, the reading
     plan and the session's lookups made for the old one are dropped, and the
     next look asks again. Nothing is requested here. */
  // "다시 찾기": the session's answer for this paper, under any identity it has had, is dropped.
  forgetLookup(item, prefix) {
    const key = this.identity(item);
    for (const cached of [...this.discoverCache.keys()]) if (cached === prefix + key || String(cached).startsWith(prefix + key + '|')) this.discoverCache.delete(cached);
  }
  // Remembered when a lookup starts, so the first edit after it is judged against what was looked up.
  noteFingerprint(item, seed = this.workFingerprint(item)) {
    (this.fingerprints ||= new Map()).set(this.identity(item), seed);
  }
  forgetIfIdentityChanged(item) {
    if (!this.isRegular(item)) return false;
    const key = this.identity(item), now = this.workFingerprint(item);
    this.fingerprints ||= new Map();
    // The first change seen this session is judged against the DOI the stored reference list was fetched for.
    const stored = this.paperWorks()[key];
    const before = this.fingerprints.get(key) ?? (stored?.doi ? 'doi:' + stored.doi : undefined);
    this.fingerprints.set(key, now);
    if (before === undefined || before === now) return false;
    const works = this.paperWorks(), citers = this.citedByStore();
    if (works[key]) delete works[key];
    if (citers[key]) delete citers[key];
    // The retraction and open-access signals were about the old DOI too.
    if (this.entry(item).signals) delete this.entry(item).signals;
    this.forgetReadingPath(item);
    for (const cached of [...this.discoverCache.keys()]) if (['related:', 'authors:'].some(prefix => String(cached).startsWith(prefix + key + '|'))) this.discoverCache.delete(cached);
    this.dirty = true;
    return true;
  }

  forgetReadingPath(item) {
    const key = this.identity(item);
    for (const cached of [...this.discoverCache.keys()]) if (String(cached).startsWith('path:' + key + '|') || cached === 'path:' + key) this.discoverCache.delete(cached);
    if (this.readingPathStore()[key]) { delete this.readingPathStore()[key]; this.dirty = true; }
  }

  readingPathCached(item, options = {}) {
    const key = this.identity(item);
    this.demoteStoredLink(item);
    const saved = this.readingPathStore()[key];
    const age = saved ? Date.now() - Date.parse(saved.at) : Infinity;
    const seed = this.workFingerprint(item);
    // A plan kept by an older version of the algorithm is asked again, not
    // shown in a shape the panel no longer draws; nor one made for a DOI the
    // paper no longer has.
    // A plan kept without the identity it was made for is asked again once: it cannot be told apart from one made for an old DOI.
    if (saved?.plan?.v === this.PATH_VERSION && age < 21 * 864e5 && saved.seed === seed) return Promise.resolve(saved.plan);
    this.noteFingerprint(item, seed);
    const keep = plan => {
      if (!plan) return plan;
      if (plan.partial?.length) { this.discoverCache.delete('path:' + key + '|' + seed); return plan; }
      // The paper changed identity while this was being worked out: shown, not kept under the new one.
      if (this.workFingerprint(item) !== seed) return plan;
      const store = this.readingPathStore();
      store[key] = {at: new Date().toISOString(), seed, plan: this.compactPlan(plan)};
      const keys = Object.keys(store).sort((a, b) => Date.parse(store[a].at) - Date.parse(store[b].at));
      while (keys.length > 40) delete store[keys.shift()];
      this.dirty = true;
      this.flush?.();
      return store[key].plan;
    };
    /* The lookup is shared: a second caller can be handed a promise the first
       caller has since abandoned. Its abort is not this caller's, so it asks
       again -- and the retry's plan, already kept, is not kept twice. */
    return this.discoverCached('path:' + key + '|' + seed, () => this.readingPath(item, options)).then(keep, error => {
      if (error?.name === 'AbortError' && !options.signal?.aborted && !options.retried) {
        return this.readingPathCached(item, {...options, retried: true});
      }
      throw error;
    });
  }

  // Resolved from the paper's own authorships, never from the name alone.
  /* The paper OpenAlex means by this item. By DOI it is the answer; by title
     the first search hit was taken as the paper, and a paper without a DOI
     showed another lab's authors and another paper's neighbours. Five hits
     are asked for and one must match the title and year, as the reading
     order already required. */
  async seedWork(item, {signal, fields} = {}) {
    const found = await this.findSeed(item, {signal, fields});
    if (found.refused) throw this.sameWorkError(found);
    return found.work;
  }

  /* Links from a paper without a DOI to an OpenAlex work. Only a normalised
     exact title, a year within one and the same first-author family name make
     one on their own; near matches wait here as candidates for the reader's
     "Is this the same paper?" and a yes is the only other way a link exists.
     Everything is keyed by the paper and valid while its title and year are
     as they were. */
  workLinkStore() {
    const store = this.cache.workLinks;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.workLinks = {});
  }
  workLinkRow(item) {
    const row = this.workLinkStore()[this.identity(item)];
    return row && row.seed === this.workFingerprint(item) ? row : null;
  }
  workCandidates(item) {
    return (this.workLinkRow(item)?.candidates || []).slice();
  }
  sameWorkError(found) {
    const error = new Error('OpenAlex가 찾은 논문이 선택한 문헌과 제목이 다릅니다. 문헌에 DOI를 채운 뒤 다시 찾으세요.');
    error.candidates = found.candidates || [];
    error.code = 'same-paper';
    return error;
  }
  setCandidates(item, candidates) {
    const store = this.workLinkStore(), key = this.identity(item), seed = this.workFingerprint(item);
    const row = store[key]?.seed === seed ? store[key] : (store[key] = {seed});
    const rejected = new Set(row.rejected || []);
    row.candidates = (candidates || []).filter(c => c?.id && !rejected.has(c.id) && c.id !== row.confirmed);
    if (!row.candidates.length && !row.confirmed && !(row.rejected || []).length) delete store[key];
    this.dirty = true;
  }
  async confirmWorkLink(item, workID) {
    const store = this.workLinkStore(), key = this.identity(item), seed = this.workFingerprint(item);
    const row = store[key]?.seed === seed ? store[key] : (store[key] = {seed});
    row.confirmed = this.discoverTools.shortID(workID);
    row.candidates = [];
    this.forgetReadingPath(item);
    this.forgetLookup(item, 'related:'); this.forgetLookup(item, 'authors:');
    this.dirty = true;
    await this.flush?.();
    return row.confirmed;
  }
  async rejectWorkLink(item, workID) {
    const store = this.workLinkStore(), key = this.identity(item), seed = this.workFingerprint(item);
    const row = store[key]?.seed === seed ? store[key] : (store[key] = {seed});
    const id = this.discoverTools.shortID(workID);
    row.rejected = [...new Set([id, ...(row.rejected || [])])].slice(0, 50);
    row.candidates = (row.candidates || []).filter(c => c.id !== id);
    if (row.confirmed === id) delete row.confirmed;
    this.dirty = true;
    await this.flush?.();
    return row;
  }

  /* The paper OpenAlex means: {work, candidates, refused}. By DOI the DOI
     answers. Without one, a link the reader confirmed wins; otherwise the
     three-fact match; otherwise the near matches become candidates. */
  async findSeed(item, {signal, fields} = {}) {
    const tools = this.discoverTools, record = this.bibliographyRecord(item);
    const hasDOI = !!tools.bareDOI(record.DOI);
    const options = this.discoverOptions();
    const url = tools.workURL(record, {...options, ...(fields ? {fields} : {}), candidates: 5});
    if (!url) return {work: null, candidates: [], refused: false};
    if (!hasDOI) {
      const confirmed = this.workLinkRow(item)?.confirmed;
      if (confirmed) {
        const byID = tools.worksByIDsURL([confirmed], {...options, ...(fields ? {fields} : {})});
        const got = tools.readWorks(await this.discoverJSON(byID, {signal}))[0];
        if (got) return {work: got, candidates: [], refused: false, confirmed: true};
      }
    }
    const payload = await this.discoverJSON(url, {signal});
    if (hasDOI) return {work: tools.readWork(payload), candidates: [], refused: false};
    const hits = tools.readWorks(payload);
    const {match, candidates} = tools.matchWork(hits, record);
    if (match && !(this.workLinkRow(item)?.rejected || []).includes(match.id)) return {work: match, candidates: [], refused: false};
    const rejected = new Set(this.workLinkRow(item)?.rejected || []);
    const open = candidates.filter(c => !rejected.has(c.id));
    this.setCandidates(item, open);
    return {work: null, candidates: open, refused: hits.length > 0};
  }

  /* Links stored before the three-fact rule: a kept reading plan for a paper
     without a DOI names the work it was built on. One that no longer passes
     is demoted to a candidate for the reader to confirm; the plan, derived
     from the wrong paper, is dropped, and nothing else is deleted. No request. */
  recheckStoredLinks() {
    const tools = this.discoverTools, store = this.readingPathStore();
    let demoted = 0;
    for (const key of Object.keys(store)) {
      const [libraryID, itemKey] = key.split(':');
      const item = this.Z.Items.getByLibraryAndKey?.(Number(libraryID), itemKey);
      if (!item || !this.isRegular(item)) continue;
      if (this.demoteStoredLink(item)) demoted++;
    }
    return demoted;
  }
  demoteStoredLink(item) {
    const tools = this.discoverTools, key = this.identity(item), saved = this.readingPathStore()[key];
    if (!saved) return false;
    const record = this.bibliographyRecord(item);
    if (tools.bareDOI(record.DOI)) return false;
    const seedRow = (saved.plan?.steps || []).flatMap(step => [...(step.works || []), ...(step.more || [])]).find(work => work?.seed);
    if (!seedRow) return false;
    const work = {...seedRow, people: (seedRow.authors || []).map(name => ({name}))};
    if (this.workLinkRow(item)?.confirmed === seedRow.id) return false;
    if (tools.matchWork([work], record).match) return false;
    this.setCandidates(item, [{id: seedRow.id, doi: seedRow.doi || '', title: seedRow.title, year: seedRow.year ?? null,
      venue: seedRow.venue || '', authors: (seedRow.authors || []).slice(0, 3)}]);
    delete this.readingPathStore()[key];
    this.discoverCache.delete('path:' + key + '|' + this.workFingerprint(item));
    this.dirty = true;
    return true;
  }

  async authorsOf(item, {signal} = {}) {
    const work = await this.seedWork(item, {signal});
    return work?.people?.filter(person => person.id) || [];
  }

  async authorActivity(authorID, {limit = 25, signal, ids} = {}) {
    const options = this.discoverOptions();
    const worksURL = this.discoverTools.shortID(authorID).startsWith('A')
      ? this.discoverTools.authorWorksURL(Array.isArray(ids) && ids.length > 1 ? [authorID, ...ids] : authorID, {...options, limit}) : null;
    if (!worksURL) throw new Error('저자 식별자가 올바르지 않습니다. 관심 저자 목록에서 저자를 다시 고르세요.');
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

  /* Every work of one person, for the person view's "Papers" list.

     Asked when the user opens the person (or presses 새로고침), never in the
     background: one request per 200 works, cursor paging, a page cap of 25 so a
     consortium-sized profile cannot run away. The answer is kept per author for
     30 days (EXPIRY_DAYS.authorWorks) and reused until then; a press on 새로고침
     is the only way to ask again sooner. Two openings at once share one request.
     `held` is worked out on every read from the library, never stored. */
  authorWorksStore() {
    const store = this.cache.authorWorks;
    return store && typeof store === 'object' && !Array.isArray(store) ? store : (this.cache.authorWorks = {});
  }
  authorWorksKey(authorID, orcid) {
    const id = this.discoverTools.shortID(authorID), iD = this.discoverTools.orcidDashed(orcid);
    return id.startsWith('A') ? id : iD ? 'orcid:' + iD : '';
  }
  async authorAllWorks(authorID, {orcid = '', refresh = false, signal} = {}) {
    // A followed person on several OpenAlex records is read under all of them, kept under their own id.
    const followed = this.watchedRowOf?.(authorID);
    if (followed && followed.id !== this.discoverTools.shortID(authorID)) authorID = followed.id;
    const ids = followed ? CustomStyleRuntime.authorIDsOf(followed) : [];
    const idsKey = ids.length > 1 ? ids.join('|') : '';
    const key = this.authorWorksKey(authorID, orcid);
    if (!key) throw new Error('저자 식별자가 올바르지 않습니다. 관심 저자 목록에서 저자를 다시 고르세요.');
    const store = this.authorWorksStore();
    const owned = () => this.libraryDOIs();
    const shape = (row, cached) => ({works: row.works.map(work => ({...work, inLibrary: !!work.doi && owned().has(work.doi)})),
      checkedAt: row.checkedAt, truncated: !!row.truncated, cached});
    const hit = store[key];
    if (!refresh && hit && hit.v === 1 && Array.isArray(hit.works) && (hit.ids || '') === idsKey && !this.expiredAt(hit.checkedAt, this.constructor.EXPIRY_DAYS.authorWorks)) return shape(hit, true);
    this.authorWorksPending = this.authorWorksPending || new Map();
    /* One fetch per person, shared by whoever asks while it runs, with its own
       controller: it stops when every one of them has gone (the panel closed,
       the window unloaded), and also when the plugin itself is stopping. It
       checks before each request and again before the cache is written, so a
       closed panel neither pages on nor leaves a half-grown cache behind. */
    let entry = !refresh && this.authorWorksPending.get(key);
    if (!entry) {
      const Controller = this.Z.getMainWindow?.()?.AbortController || globalThis.AbortController;
      const controller = new Controller();
      const check = () => { if (controller.signal.aborted || !this.active || this.stopping) { const error = new Error('Author works fetch aborted'); error.name = 'AbortError'; throw error; } };
      entry = {controller, holders: 0};
      entry.job = (async () => {
        const options = this.discoverOptions(), tools = this.discoverTools, PAGES = 25;
        const all = new Map();
        let cursor = '*', truncated = false;
        for (let page = 0; page < PAGES && cursor; page++) {
          check();
          const url = tools.authorAllWorksURL(authorID, {...options, orcid, cursor, ids});
          if (!url) break;
          const payload = await this.discoverJSON(url, {signal: controller.signal});
          check();
          const works = tools.readAuthorWorks(payload, {authorID, ids, orcid});
          for (const work of works) if (!all.has(work.id)) all.set(work.id, work);
          cursor = works.length ? payload?.meta?.next_cursor || '' : '';
          if (cursor && page === PAGES - 1) truncated = true;
          if (cursor) { await this.pause(150); check(); }
        }
        check();
        const row = {v: 1, checkedAt: new Date().toISOString(), truncated, works: [...all.values()].sort(tools.byNewest), ...(idsKey ? {ids: idsKey} : {})};
        store[key] = row;
        // Forty people at most: each holds a few hundred rows.
        const keys = Object.keys(store);
        if (keys.length > 40) for (const old of keys.sort((a, b) => String(store[a]?.checkedAt).localeCompare(String(store[b]?.checkedAt))).slice(0, keys.length - 40)) delete store[old];
        this.dirty = true;
        return row;
      })();
      this.authorWorksPending.set(key, entry);
      const clear = () => { if (this.authorWorksPending.get(key) === entry) this.authorWorksPending.delete(key); };
      entry.job.then(clear, clear);
    }
    entry.holders++;
    const leave = () => { if (--entry.holders <= 0) entry.controller.abort(); };
    if (signal) { if (signal.aborted) leave(); else signal.addEventListener('abort', leave, {once: true}); }
    try { return shape(await entry.job, false); }
    finally { signal?.removeEventListener?.('abort', leave); }
  }
  // Whether a fresh copy is held, so the panel can say "from <date>" without asking.
  authorWorksState(authorID, orcid = '') {
    const row = this.authorWorksStore()[this.authorWorksKey(authorID, orcid)];
    return row ? {checkedAt: row.checkedAt, stale: this.expiredAt(row.checkedAt, this.constructor.EXPIRY_DAYS.authorWorks), count: row.works?.length || 0} : null;
  }

  // --- Paper signals: retraction, open access, preprint -> published ---

  // Signals found for another DOI than the paper has now are not this paper's.
  signalsOf(item) {
    const signals = this.signalTools.repair(this.entry(item).signals || null);
    if (signals?.doi && this.discoverTools.bareDOI(this.bibliographyRecord(item).DOI) !== signals.doi) return null;
    return signals;
  }

  /* 논문 비교 evidence: what each paper says, in the reader's own words, kept
     locally per item (`libraryID:key`) next to the other per-paper records. */
  static get EVIDENCE_FIELDS() { return [['species', '생물종/균주'], ['construct', 'construct'], ['condition', '조건'], ['control', '대조군'], ['result', '결과'], ['limit', '한계']]; }
  evidenceOf(item) {
    const row = item?.key ? (this.cache?.evidence || {})[this.identity(item)] : null;
    const out = {};
    for (const [key] of this.constructor.EVIDENCE_FIELDS) out[key] = String(row?.[key] || '');
    return out;
  }
  async setEvidence(item, patch) {
    if (!item?.key) throw new Error('문헌을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도하세요.');
    const known = new Set(this.constructor.EVIDENCE_FIELDS.map(([key]) => key));
    const store = this.cache.evidence && typeof this.cache.evidence === 'object' ? this.cache.evidence : (this.cache.evidence = {});
    const id = this.identity(item), row = {...(store[id] || {})};
    for (const [key, value] of Object.entries(patch || {})) if (known.has(key)) row[key] = String(value ?? '').slice(0, 4000);
    for (const key of Object.keys(row)) if (!row[key].trim()) delete row[key];
    if (Object.keys(row).length) store[id] = row; else delete store[id];
    this.dirty = true;
    await this.flush();
    return this.evidenceOf(item);
  }

  /* 읽기 메모 -> 노트. The memo lives in the local JSON; this keeps one child
     note per paper, tagged style-custom:memo, in step with it so the text is
     in Zotero (synced, searchable, exportable). The note is never opened. The
     local memo then mirrors the note: it is read back from it after the write,
     and an edit made to the note in Zotero flows back into the memo. */
  static get MEMO_NOTE_TAG() { return 'style-custom:memo'; }
  static memoNoteHTML(text) {
    const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<div data-style-custom="memo">' + String(text ?? '').split(/\r?\n/).map(line => '<p>' + esc(line) + '</p>').join('') + '</div>';
  }
  static memoFromNoteHTML(html) {
    const text = String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return text.replace(/\n+$/, '');
  }
  memoNoteOf(item) {
    const ids = typeof item?.getNotes === 'function' ? item.getNotes() : [];
    for (const id of ids || []) {
      const note = this.Z.Items.get(id);
      if (note && !note.deleted && (note.getTags?.() || []).some(tag => tag.tag === this.constructor.MEMO_NOTE_TAG)) return note;
    }
    return null;
  }
  /* The memo and its note never merge by themselves. `memoSynced` is the exact
     text both sides last agreed on (with the note's version then). Against it:
       note unchanged, memo changed  -> the memo is written to the note;
       memo unchanged, note changed  -> the note's text becomes the memo;
       both changed                  -> nothing is written: row.memoConflict holds
                                        both texts until the user picks one (or both).
     A job only moves the baseline to text it wrote itself and read back. */
  static memoSep() { return '\n\n--- 이 컴퓨터의 메모 ---\n'; }
  static memoNorm(text) { return String(text ?? '').replace(/\n+$/, ''); }
  _memoSetBase(row, text, note) {
    row.memoSynced = String(text);
    const version = note && (note.version ?? note.dateModified);
    if (version === undefined || version === null) delete row.memoSyncedVer; else row.memoSyncedVer = version;
    delete row.memoConflict; this._memoBump(row);
  }
  /* The memo revision: a counter bumped on every change to remark, memoSynced or memoConflict, whoever made it. A writer that
     wants to undo its own write compares it with the value captured right after that write; text equality is not ownership. */
  /* A memo write is "pending" from the moment it is in memory until its storage write (and note job) has resolved or been rolled back.
     Each write has a token; the in-memory remark of a pending write is not yet the persisted memo. Listeners hear when one settles so
     editors can reconcile again. Everything about a pending stretch is gone once the last write settles. */
  memoPendingList(item) { return [...(this.memoPendingMap?.get(this.identity(item)) || [])]; }
  memoWritePending(item) { return this.memoPendingList(item).length > 0; }
  // The memo as it was before the oldest unsettled write: what a rollback goes back to.
  memoPendingPrior(item) { return this.memoPendingList(item)[0]?.prior; }
  // The texts the memo may be once the writes now pending settle: the one before the first, and each write's own.
  memoChainTexts(item) { const list = this.memoPendingList(item); return list.length ? [list[0].prior, ...list.map(w => w.value)] : []; }
  _memoPending(item, delta, prior, value, token) {
    const map = this.memoPendingMap || (this.memoPendingMap = new Map()), id = this.identity(item), list = map.get(id) || [];
    let made;
    if (delta > 0) { made = 'w' + (this._memoToken = (this._memoToken || 0) + 1); list.push({token: made, prior: String(prior ?? ''), value: String(value ?? '')}); map.set(id, list); return made; }
    const at = token === undefined ? 0 : list.findIndex(w => w.token === token);
    if (at >= 0) list.splice(at, 1);
    if (list.length) map.set(id, list); else map.delete(id);
    for (const listener of [...(this.memoListeners || [])]) { try { listener(item); } catch (error) { this.Z.logError?.(error); } }
    return undefined;
  }
  addMemoListener(listener) { (this.memoListeners || (this.memoListeners = new Set())).add(listener); return () => this.memoListeners.delete(listener); }
  // A memo change made in memory with no write of its own: registered pending until the next flush has settled.
  _memoPersist(item, prior, value) {
    const token = this._memoPending(item, 1, prior, value);
    Promise.resolve().then(() => this.flush()).catch(error => this.Z.logError?.(error)).finally(() => this._memoPending(item, -1, undefined, undefined, token));
  }
  _memoBump(row) { row.memoRev = (row.memoRev || 0) + 1; this.dirty = true; return row.memoRev; }
  /* What a note's text means for a paper's memo, without writing anything to the note:
     'same' (agreed), 'pull' (memo unchanged since the baseline: take the note), 'push'
     (note unchanged: the memo is the newer side), 'conflict' (both changed, or no baseline to tell). */
  _memoSituation(row, there, base) {
    const norm = this.constructor.memoNorm, local = String(row.remark || '');
    if (norm(local) === norm(there)) return 'same';
    if (base === undefined) return !local.trim() ? 'pull' : !String(there).trim() ? 'push' : 'conflict';
    const localChanged = norm(local) !== norm(base), remoteChanged = norm(there) !== norm(base);
    return !remoteChanged ? 'push' : !localChanged ? 'pull' : 'conflict';
  }
  _memoNoWrite(row, note, situation) {
    // An open conflict is never settled by adopting the note: the memo is newer than the baseline or the conflict would not exist.
    if (situation === 'pull' && row.memoConflict) situation = 'conflict';
    const there = this.constructor.memoFromNoteHTML(note.getNote());
    if (situation === 'same') { if (row.memoSynced !== there || row.memoConflict) this._memoSetBase(row, there, note); return true; }
    if (situation === 'pull') {
      // Adopted into memory: pending until the cache holding it has been written (or failed to be).
      const prior = String(row.remark || ''), item = note.parentID !== undefined ? this.Z.Items?.get?.(note.parentID) : null;
      row.remark = there; this._memoSetBase(row, there, note);
      if (item) this._memoPersist(item, prior, there);
      return true;
    }
    if (situation === 'conflict') {
      const had = row.memoConflict, local = String(row.remark || '');
      if (!had || had.local !== local || had.remote !== there) { row.memoConflict = {local, remote: there, at: new Date().toISOString()}; this._memoBump(row); return true; }
    }
    return false;
  }
  /* A tagged memo note that exists already (written on another computer and
     synced, or by an earlier session) is read once per paper and per session. */
  adoptMemoNote(item, {inJob = false} = {}) {
    const id = this.identity(item), checked = this.memoChecked || (this.memoChecked = new Set());
    if (checked.has(id)) return false;
    // An operation on this paper is in flight (undo, merge, a conflict choice): adoption waits for the next look once it is over.
    if (!inJob && this.memoQueues?.has(id)) return false;
    checked.add(id);
    if (typeof item?.getNotes !== 'function') return false;
    const note = this.memoNoteOf(item);
    if (!note) return false;
    const row = this.cache.items[id] ||= {};
    const there = this.constructor.memoFromNoteHTML(note.getNote());
    if (!there.trim()) return false;
    return this._memoNoWrite(row, note, this._memoSituation(row, there, row.memoSynced));
  }
  /* A note written by this plugin, expected back from the notifier: it is our own echo, not news. */
  _memoWrite(item, note, text) {
    const id = this.identity(item), inflight = this.memoInflight || (this.memoInflight = new Map()), norm = this.constructor.memoNorm(text);
    inflight.set(id, norm);
    note.setNote(this.constructor.memoNoteHTML(text));
    return note.saveTx().finally(() => { if (inflight.get(id) === norm) inflight.delete(id); });
  }
  _memoSerial(item, job, {revisioned = false} = {}) {
    const id = this.identity(item);
    const queues = this.memoQueues || (this.memoQueues = new Map()), revisions = this.memoRevisions || (this.memoRevisions = new Map());
    const revision = revisioned ? (revisions.get(id) || 0) + 1 : 0;
    if (revisioned) revisions.set(id, revision);
    const previous = queues.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => revisioned && revisions.get(id) !== revision
      ? {created: false, text: String(this.cache.items[id]?.remark || ''), skipped: true}
      : job());
    queues.set(id, run);
    const clear = () => { if (queues.get(id) === run) queues.delete(id); };
    run.then(clear, clear);
    return run;
  }
  async memoToNote(item, {prior} = {}) {
    if (!this.isRegular(item)) throw new Error('메모를 노트로 옮길 문헌을 찾지 못했습니다. 목록을 새로 고친 뒤 다시 시도하세요.');
    if (!this.canEdit(item)) throw new Error('이 라이브러리는 편집할 수 없어 노트를 만들지 못했습니다. 편집할 수 있는 라이브러리에서 시도하세요.');
    /* One queue per paper, and a revision: a job that a newer call has
       overtaken writes nothing (the newer one carries the latest text). */
    return this._memoSerial(item, () => this._memoToNote(item, {prior}), {revisioned: true});
  }
  async _memoToNote(item, {prior} = {}) {
    this.adoptMemoNote(item, {inJob: true});
    const row = this.entry(item), text = String(row.remark || '');
    let note = this.memoNoteOf(item);
    if (!text.trim() && !note) throw new Error('메모가 비어 있어 옮길 내용이 없습니다. 메모를 먼저 적으세요.');
    const created = !note;
    if (note) {
      const there = this.constructor.memoFromNoteHTML(note.getNote());
      const base = row.memoSynced !== undefined ? row.memoSynced : (prior !== undefined ? String(prior) : undefined);
      const situation = this._memoSituation(row, there, base);
      if (situation !== 'push') {
        // Nothing is written: agreed, adopted from the note, or held for the user.
        const changed = this._memoNoWrite(row, note, situation);
        // The revision the returned text was current at is taken here, before any await: a later change by anyone makes this answer stale.
        const answer = {created: false, text: String(row.remark || ''), wrote: false, adopted: situation === 'pull', conflict: situation === 'conflict', rev: row.memoRev || 0};
        // A failed sync-info flush still carries the revision after this job's last memo-field change.
        if (changed) { try { await this.flush(); } catch (error) { error.memoRev = answer.rev; throw error; } this.bumpState?.(); }
        return answer;
      }
    } else {
      note = new this.Z.Item('note');
      note.libraryID = item.libraryID; note.parentID = item.id;
      note.setTags([{tag: this.constructor.MEMO_NOTE_TAG, type: 0}]);
    }
    // A memo typed during the write is fine (it is newer, and the baseline is the note as written); the baseline or the conflict being changed by someone else is not.
    const syncedBefore = row.memoSynced, conflictBefore = row.memoConflict, rev0 = row.memoRev || 0;
    await this._memoWrite(item, note, text);
    // The baseline moves only when the note reads back as exactly what this job wrote AND nobody else moved the baseline or the conflict meanwhile.
    const mirrored = this.constructor.memoFromNoteHTML(note.getNote());
    if (row.memoSynced === syncedBefore && row.memoConflict === conflictBefore && this.constructor.memoNorm(mirrored) === this.constructor.memoNorm(text)) this._memoSetBase(row, mirrored, note);
    else if ((row.memoRev || 0) !== rev0) {
      // The note no longer reads back as what this job wrote and the memo was saved meanwhile: the latest memo is not replaced by the note, both wait as a conflict.
      row.memoConflict = {local: String(row.remark || ''), remote: mirrored, at: new Date().toISOString()}; this._memoBump(row);
    }
    else this._memoNoWrite(row, note, this._memoSituation(row, mirrored, row.memoSynced));
    const answer = {created, text: String(row.remark || ''), wrote: true, adopted: false, conflict: !!row.memoConflict, rev: row.memoRev || 0, html: this.constructor.memoNoteHTML(text)};
    try { await this.flush(); } catch (error) { error.memoRev = answer.rev; throw error; }
    this.bumpState?.();
    return answer;
  }
  /* The user's answer to a conflict: 'note' | 'local' | 'both'. `seen` is what the box showed;
     if either side changed since, nothing is written and the new texts are returned. */
  resolveMemoConflict(item, choice, {seen} = {}) {
    if (!this.canEdit(item)) throw new Error('이 라이브러리는 편집할 수 없습니다. 편집할 수 있는 라이브러리에서 시도하세요.');
    return this._memoSerial(item, () => this._resolveMemoConflict(item, choice, {seen}));
  }
  async _resolveMemoConflict(item, choice, {seen} = {}) {
    if (!['note', 'local', 'both'].includes(choice)) throw new Error('알 수 없는 선택입니다. 노트 내용 쓰기, 이 메모 쓰기, 둘 다 합치기 중에서 고르세요.');
    const row = this.entry(item);
    // Settling a conflict changes the memo in memory before it is saved: the paper is pending until it is.
    const pendingToken = this._memoPending(item, 1, String(row.remark ?? ''), String(row.remark ?? ''));
    try {
    if (!row.memoConflict) return {resolved: false, conflict: null, text: String(row.remark || ''), rev: row.memoRev || 0};
    const norm = this.constructor.memoNorm;
    let note = this.memoNoteOf(item);
    const there = note ? this.constructor.memoFromNoteHTML(note.getNote()) : '', local = String(row.remark || '');
    if (seen && (norm(seen.local) !== norm(local) || norm(seen.remote) !== norm(there))) {
      row.memoConflict = {local, remote: there, at: new Date().toISOString()}; this._memoBump(row);
      const answer = {resolved: false, stale: true, conflict: row.memoConflict, text: local, rev: row.memoRev || 0};
      await this.flush();
      return answer;
    }
    const rev0 = row.memoRev || 0; // the memo, baseline and conflict as judged above; compared again after the note is written
    const final = choice === 'note' ? there : choice === 'local' ? local
      : (there.trim() && local.trim() ? there + this.constructor.memoSep() + local : there.trim() ? there : local);
    if (choice !== 'note' && norm(final) !== norm(there)) {
      if (!note) { note = new this.Z.Item('note'); note.libraryID = item.libraryID; note.parentID = item.id; note.setTags([{tag: this.constructor.MEMO_NOTE_TAG, type: 0}]); }
      await this._memoWrite(item, note, final);
      if (norm(this.constructor.memoFromNoteHTML(note.getNote())) !== norm(final)) throw new Error('노트를 쓰는 사이 노트가 다시 바뀌어 아무것도 확정하지 않았습니다. 두 내용을 다시 확인하세요.');
      // The memo was saved while the note was written (even back to the same text): the newer memo stays, nothing is confirmed, and both sides go back into the box.
      if ((row.memoRev || 0) !== rev0 || String(row.remark || '') !== local) {
        const now = String(row.remark || ''), remote = this.constructor.memoFromNoteHTML(note.getNote());
        row.memoConflict = {local: now, remote, at: new Date().toISOString()}; this._memoBump(row);
        const answer = {resolved: false, stale: true, conflict: row.memoConflict, text: String(row.remark || ''), rev: row.memoRev || 0};
        await this.flush(); this.bumpState?.();
        return answer;
      }
    }
    row.remark = final; this._memoSetBase(row, note ? this.constructor.memoFromNoteHTML(note.getNote()) : final, note);
    const answer = {resolved: true, conflict: null, text: final, rev: row.memoRev || 0};
    await this.flush(); this.bumpState?.();
    return answer;
    } finally { this._memoPending(item, -1, undefined, undefined, pendingToken); }
  }
  /* An edit made to the memo note inside Zotero (or arriving by sync). Judged against the
     baseline, never suppressed: only the text this plugin is itself writing is its own echo. */
  mirrorMemoNote(noteID) {
    const ctx = this._memoNoteContext(noteID);
    if (!ctx) return false;
    const norm = this.constructor.memoNorm;
    if (this.memoInflight?.get(ctx.id) === norm(ctx.text)) return false;
    // Another operation on this paper is running: the note change is judged after it, against the state it leaves.
    if (this.memoQueues?.has(ctx.id)) return this._memoSerial(ctx.parent, async () => this._mirrorMemoNote(noteID));
    return this._mirrorMemoNote(noteID);
  }
  _memoNoteContext(noteID) {
    const note = this.Z.Items?.get?.(noteID);
    // A deleted note is not news: Zotero fires 'modify' for the save that deleted it, and its text must not come back as the memo.
    if (!note || note.deleted || !note.isNote?.() || !note.parentID) return null;
    if (!(note.getTags?.() || []).some(tag => tag.tag === this.constructor.MEMO_NOTE_TAG)) return null;
    const parent = this.Z.Items.get(note.parentID);
    if (!parent) return null;
    return {note, parent, id: this.identity(parent), text: this.constructor.memoFromNoteHTML(note.getNote())};
  }
  _mirrorMemoNote(noteID) {
    const ctx = this._memoNoteContext(noteID);
    if (!ctx) return false;
    const {note, parent, text, id} = ctx, norm = this.constructor.memoNorm;
    if (this.memoInflight?.get(id) === norm(text)) return false;
    const row = this.entry(parent);
    if (row.memoSynced !== undefined && norm(text) === norm(row.memoSynced) && !row.memoConflict) return false;
    const situation = this._memoSituation(row, text, row.memoSynced);
    if (situation === 'push') {
      // The note is back at the baseline: a pending conflict is over, the memo is simply the newer side.
      if (row.memoConflict) { delete row.memoConflict; this._memoBump(row); this.flush?.().catch?.(error => this.Z.logError?.(error)); return true; }
      return false;
    }
    const changed = this._memoNoWrite(row, note, situation);
    if (changed) { this.bumpState?.(); this.flush?.().catch?.(error => this.Z.logError?.(error)); }
    return changed;
  }

  /* Compare-and-swap for a user's write of the memo: `base` is the stored text the editor was loaded from (or last
     confirmed). If the stored memo is no longer that, nothing may be written; the caller gets both texts. */
  memoStaleWrite(item, text, base) {
    if (base === undefined || base === null) return null;
    const row = this.entry(item), stored = String(row.remark || ''), submitted = String(text ?? '');
    if (stored === String(base) || stored === submitted) return null;
    return {stale: true, stored, conflict: {local: submitted, remote: stored}, rev: row.memoRev || 0};
  }

  /* 프리프린트 -> 게재본. A stored signal says a preprint has a published
     version; this says whether that version is already on the shelf and
     whether the two are linked (related items). */
  _isLinked(item, other) {
    try { return !!item?.relatedItems?.includes?.(other.key) || !!other?.relatedItems?.includes?.(item.key); } catch (_) { return false; }
  }
  async publishedStatus(item, {held: given} = {}) {
    const published = this.signalsOf(item)?.published;
    if (!published?.doi) return null;
    const held = given === undefined
      ? await this.findExistingWork(item.libraryID, {doi: published.doi, title: '', year: published.year})
      : given;
    return {published, held: held || null, linked: !!held && this._isLinked(item, held)};
  }
  // Every preprint in the library whose published version is not yet linked: one pass, no request.
  async unlinkedPublished(libraryID) {
    const items = (await this.libraryItems(libraryID)).filter(item => this.isRegular(item));
    const byDOI = new Map();
    for (const item of items) { const doi = this.discoverTools.bareDOI(item.getField?.('DOI')); if (doi && !byDOI.has(doi)) byDOI.set(doi, item); }
    const rows = [];
    for (const item of items) {
      const published = this.signalsOf(item)?.published;
      if (!published?.doi) continue;
      const held = byDOI.get(this.discoverTools.bareDOI(published.doi)) || null;
      if (held && held.id === item.id) continue;
      const linked = !!held && this._isLinked(item, held);
      if (!linked) rows.push({item, published, held});
    }
    return rows;
  }
  /* Imports the published version (the duplicate check of importWork), or
     uses the copy already held, relates the two, and -- for a copy just
     brought in -- carries over tags, reading status and the memo. The
     preprint stays; nothing is deleted. */
  async connectPublished(preprint, {win} = {}) {
    const status = await this.publishedStatus(preprint);
    if (!status) throw new Error('이 문헌에는 게재본 기록이 없습니다. 자료 점검에서 철회·게재 신호를 먼저 채우세요.');
    const {published} = status;
    let held = status.held, imported = false;
    if (!held) {
      const saved = await this.importWork({doi: published.doi, title: '', year: published.year, venue: published.venue}, win, {libraryID: preprint.libraryID});
      held = saved?.[0];
      if (!held) throw new Error('게재본을 가져오지 못했습니다. 잠시 뒤 다시 시도하세요.');
      imported = !saved.existing;
    }
    if (held.libraryID !== preprint.libraryID) throw new Error('게재본이 다른 라이브러리에 있어 연결하지 못했습니다. 같은 라이브러리로 옮긴 뒤 다시 시도하세요.');
    if (held.id === preprint.id) return {item: held, imported: false, linked: false};
    let linked = false;
    if (!this._isLinked(preprint, held)) {
      preprint.addRelatedItem(held); held.addRelatedItem(preprint);
      await preprint.saveTx(); await held.saveTx();
      linked = true;
    }
    if (imported) {
      const mine = preprint.getTags(), has = new Set(held.getTags().map(tag => tag.tag));
      const carry = mine.filter(tag => !has.has(tag.tag));
      if (carry.length) { held.setTags([...held.getTags(), ...carry.map(tag => ({tag: tag.tag, type: tag.type || 0}))]); await held.saveTx(); }
      const from = this.state(preprint)?.status;
      if ((from === 'done' || from === 'reading') && this.state(held)?.status !== from) await this.edit([held], {status: from});
      const memo = String(this.entry(preprint).remark || '');
      if (memo && !this.entry(held).remark) {
        const pendingToken = this._memoPending(held, 1, '', memo);
        try { this.entry(held).remark = memo; this._memoBump(this.entry(held)); await this.flush(); } finally { this._memoPending(held, -1, undefined, undefined, pendingToken); }
      }
    }
    this.bumpState?.();
    await this.refreshWindows();
    return {item: held, imported, linked};
  }

  // Crossref answers 404 for a DOI it has never registered, and OpenAlex
  // answers 404 for a preprint DOI it has merged into the published work.
  // Both are answers about the paper, not transport failures, so they must not
  // abort the other half of the lookup.
  async signalsJSON(url, {signal} = {}) {
    const openAlex = /^https:\/\/api\.openalex\.org\//.test(String(url));
    // The same hold as every other OpenAlex request: a spent budget is not asked again today.
    if (openAlex && this.openAlexSpentUntil && Date.now() < this.openAlexSpentUntil)
      throw Object.assign(new Error("Insufficient budget"), {status: 429, held: true});
    const response = await this.Z.HTTP.request("GET", url,
      {responseType: "json", timeout: 20000, successCodes: false});
    signal?.throwIfAborted?.();
    // A 429 is not an answer about the paper. Left as null it reads as "no
    // notices found", so a sweep during a budget outage would walk the whole
    // library, learn nothing, and report it as a clean bill of health.
    if (response?.status === 429) {
      let body = ''; try { body = typeof response.response === 'string' ? response.response : JSON.stringify(response.response || ''); } catch (_) {}
      if (openAlex && /insufficient budget|budget exceeded|daily .*limit/i.test(body)) { const now = new Date(); this.openAlexSpentUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); }
      throw Object.assign(new Error("Insufficient budget"), {status: 429});
    }
    if (response?.status === 200) return response.response;
    /* Only a 404 says the service does not know the paper. A 503, a 401 or a
       dropped connection is no answer at all: read as "nothing", it turned a
       recorded retraction into a clean paper. It is thrown, and the caller
       leaves the earlier answer standing. */
    if (response?.status === 404) return null;
    throw Object.assign(new Error(`HTTP ${response?.status ?? 0} · ${String(url).split('?')[0]}`), {status: Number(response?.status ?? 0)});
  }

  async fetchPaperSignals(item, {signal, crossrefOnly = false, record: given = null} = {}) {
    // An item from the library, or -- passed explicitly -- a bare record with
    // a DOI: a watched author's new paper is the second kind, and nothing
    // else about it is known. Explicit, because guessing from the object's
    // shape misread every test double that stubs bibliographyRecord.
    const record = given || this.bibliographyRecord(item);
    const options = this.discoverOptions();
    const crossrefURL = this.signalTools.crossrefURL(record, options);
    const openAlexURL = crossrefOnly ? null : this.signalTools.openAlexURL(record, options);
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
    // Not when only Crossref was asked for, nor when OpenAlex is out for the day.
    if (!openAlex && !crossrefOnly && !openAlexOut && (crossref?.isPreprint || this.signalTools.PREPRINT_PREFIXES.test(this.signalTools.bareDOI(record.DOI)))) {
      const titleURL = this.signalTools.openAlexTitleURL(record, options);
      // The title lookup is extra: its failure does not throw away what Crossref already said.
      let hits = null;
      try { hits = titleURL ? await this.signalsJSON(titleURL, {signal}) : null; }
      catch (error) { if (error?.name === 'AbortError') throw error; if (this.outOfBudget(error)) openAlexOut = true; else this.Z.logError(error); }
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

  /* What happened around a paper: issues (notices, comments) and reactions
     (Bluesky, Hacker News, Wikipedia). Lazy, one paper at a time, answered
     from the per-DOI cache in this.cache.attention. No email goes out: the
     requests carry a plain User-Agent only. Altmetric is asked only when the
     reader has typed a key into extensions.style-custom.altmetricKey. */
  attention() {
    if (this._attention) return this._attention;
    const store = {
      get: key => (this.cache.attention && typeof this.cache.attention === 'object' ? this.cache.attention[key] : null) || null,
      set: (key, value) => { const all = this.cache.attention && typeof this.cache.attention === 'object' && !Array.isArray(this.cache.attention) ? this.cache.attention : (this.cache.attention = {}); all[key] = value; this.dirty = true; }
    };
    const fetch = async (url, {method = 'GET', headers, timeout} = {}) => {
      if (/^https:\/\/api\.openalex\.org\//.test(url) && this.openAlexSpentUntil && Date.now() < this.openAlexSpentUntil) return {status: 429, json: null, url: ''};
      const response = await this.Z.HTTP.request(method, url, {responseType: 'json', timeout: timeout || 8000, successCodes: false, headers});
      // Zotero follows redirects; the address reached is on the request object.
      return {status: response?.status ?? 0, json: response?.response ?? null, url: response?.responseURL || response?.channel?.URI?.spec || ''};
    };
    return this._attention = this.attentionTools.create({
      fetch, store,
      userAgent: `StyleCustomZoteroPlugin/${this.version || 'dev'} (Zotero plugin; paper attention)`,
      altmetricKey: () => this.pref('altmetricKey', ''),
      openAlexKey: () => this.openAlexKey(),
      openAlexHeld: () => !!(this.openAlexSpentUntil && Date.now() < this.openAlexSpentUntil)
    });
  }

  /* The LinkedIn profile a person listed on their own public ORCID record, or ''. Asked only when the
     reader presses LinkedIn on an author; remembered for a month either way. No email, no key. */
  async orcidLinkedIn(orcid) {
    const id = String(orcid || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i)?.[0];
    if (!id) return '';
    const store = (this.cache.orcidLinks ||= {}), kept = store[id];
    if (kept && Date.now() - kept.at < 30 * 864e5) return kept.url;
    let url = '';
    try {
      const reply = await this.Z.HTTP.request('GET', `https://pub.orcid.org/v3.0/${id}/researcher-urls`,
        {responseType: 'json', timeout: 15000, headers: {Accept: 'application/json'}, successCodes: false});
      const rows = reply?.response?.['researcher-url'] || [];
      url = rows.map(row => String(row?.url?.value || '')).find(value => /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i.test(value)) || '';
    } catch (_) { url = ''; }
    store[id] = {url, at: Date.now()};
    this.scheduleFlush?.();
    return url;
  }

  async paperIssues(item, {signal, force = false} = {}) {
    const record = this.bibliographyRecord(item);
    // Signals already fetched OpenAlex's retraction flag: reuse it and spend no budget.
    const known = this.signalsOf(item);
    const openAlex = known && !known.partial ? known.rank >= 3 : undefined;
    return this.attention().issues(record.DOI, {signal, force, openAlex});
  }

  async paperReactions(item, {signal, force = false} = {}) {
    const record = this.bibliographyRecord(item);
    return this.attention().reactions(record.DOI, [record.url], {signal, force});
  }

  // The same two questions for a work known only by its DOI (a row in a list of related papers).
  async doiIssues(doi, {signal, force = false} = {}) { return this.attention().issues(doi, {signal, force}); }
  async doiReactions(doi, urls, {signal, force = false} = {}) { return this.attention().reactions(doi, urls || [], {signal, force}); }
  // What an earlier look left in the cache, never a request: the list badge reads this.
  cachedIssueStatus(doi) { return this.attention().peekIssues(doi)?.summary?.status || null; }

  async refreshPaperSignals(items, {signal, onProgress, pace = 0} = {}) {
    const summary = {ok: 0, "not-found": 0, unsupported: 0, error: 0, remaining: 0, budgetGone: false, newRetracted: 0, newPublished: 0};
    const queue = [...new Set(items)].filter(item => this.isRegular(item));
    for (const [index, item] of queue.entries()) {
      if (!this.active || this.stopping || signal?.aborted) { summary.remaining = queue.length - index; break; }
      onProgress?.(index, queue.length);
      try {
        // The paper's identity when asked; a host without the lookup (a test stand-in) is not checked.
        const identify = typeof this.workFingerprint === 'function' ? () => this.workFingerprint(item) : () => null;
        const asked = identify();
        const {signals, reason, openAlexOut} = await this.fetchPaperSignals(item, {signal});
        if (openAlexOut) summary.partialOnly = (summary.partialOnly || 0) + 1;
        // The DOI was changed while the answer was on its way: it is about the old one.
        if (identify() !== asked) { summary.error++; continue; }
        if (!signals) { summary[reason]++; continue; }
        /* Half an answer does not overrule a whole one: with OpenAlex out, a
           retraction recorded earlier (perhaps from OpenAlex) stays unless this
           answer is as bad or worse. */
        const before = this.entry(item).signals;
        const sameDOI = !before?.doi || typeof this.bibliographyRecord !== 'function' || before.doi === this.discoverTools.bareDOI(this.bibliographyRecord(item).DOI);
        /* What a half answer can still add to a record it does not replace:
           Crossref's published version. Its time goes in incompleteCheckedAt;
           checkedAt is only ever set by a complete check, so the 30/90-day
           re-check is not pushed back by one that could not finish. */
        const mergeHalf = () => {
          if (signals.published && !before.published) { before.published = signals.published; summary.newPublished++; }
          before.incompleteCheckedAt = signals.checkedAt; this.dirty = true; summary.ok++;
        };
        if (signals.partial && before && sameDOI && (Number(before.rank) || 0) > (Number(signals.rank) || 0)) { mergeHalf(); continue; }
        // A re-check with OpenAlex out must not downgrade a complete record to half of one.
        if (signals.partial && before && !before.partial && sameDOI && (Number(signals.rank) || 0) <= (Number(before.rank) || 0)) {
          mergeHalf(); continue;
        }
        if (typeof this.bibliographyRecord === 'function') signals.doi = this.discoverTools.bareDOI(this.bibliographyRecord(item).DOI) || undefined;
        this.entry(item).signals = signals;
        // What this check turned up that the last one did not have.
        if ((Number(signals.rank) || 0) >= 3 && (Number(before?.rank) || 0) < 3) summary.newRetracted++;
        if (signals.published && !before?.published) summary.newPublished++;
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
    const label = {files: '첨부파일 종류', works: '인용 목록·소속', signals: '철회·공개접근 신호', journals: '저널 지표', authors: '관심 저자 새 논문', patents: '관심 저자 특허'}[stage] || stage;
    const text = `${label} 채우는 중 ${done + 1}/${total}`;
    for (const [target, state] of this.windows) {
      if (target.closed) continue;
      try { state?.workbench?.setStatus?.(text); } catch (error) { this.Z.logError(error); }
    }
  }

  backfillSummary(report) {
    const lines = [];
    if (report.files) {
      lines.push(`첨부파일: 본문 ${report.files.article} · 보충자료 ${report.files.supplementary}`
        + (report.files.duplicate ? ` · 중복 ${report.files.duplicate}` : '')
        + (report.files.foreign ? ` · 다른 논문 ${report.files.foreign}` : ''));
    }
    if (report.works) {
      lines.push(`인용 목록: ${report.works.found}편 · 참고문헌 ${report.works.references}건`
        + ` · 기관 ${report.works.institutions}곳`
        + (report.works.missing ? ` · OpenAlex에 없음 ${report.works.missing}` : '')
        + (report.works.noDOI ? ` · DOI 없음 ${report.works.noDOI}` : ''));
    }
    if (report.signals) {
      lines.push(`철회·공개접근 신호: ${report.signals.ok}편 확인`
        + (report.signals['not-found'] ? ` · ${report.signals['not-found']}편은 기록 없음` : '')
        + (report.signals.error ? ` · ${report.signals.error}편 조회 실패` : ''));
      if (report.signals.newRetracted || report.signals.newPublished) {
        lines.push(`  새로 철회 ${report.signals.newRetracted || 0} · 새로 게재 ${report.signals.newPublished || 0}`);
      }
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
      lines.push('', 'OpenAlex 하루 한도를 다 썼습니다. 한국 시간 오전 9시에 초기화되고, 다시 실행하면 남은 것부터 이어서 채웁니다.');
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
  /* A verdict is not forever: a paper is retracted, a preprint gets published,
     long after the one look. Older than 90 days is asked again; a preprint
     with no published version yet, 30. */
  get SIGNAL_RECHECK_DAYS() { return 90; }
  get PREPRINT_RECHECK_DAYS() { return 30; }
  signalsStale(known, now = Date.now()) {
    if (!known) return true;
    if (known.partial) return true;
    const at = Date.parse(known.checkedAt || '');
    // A record with no date cannot be aged; it is left as it is.
    if (!Number.isFinite(at)) return false;
    const days = known.preprint && !known.published ? this.PREPRINT_RECHECK_DAYS : this.SIGNAL_RECHECK_DAYS;
    return now - at > days * 864e5;
  }

  async itemsNeedingSignals(libraryID) {
    const wanted = [];
    for (const item of await this.libraryItems(libraryID)) {
      if (!this.isRegular(item)) continue;
      // A partial entry carries Crossref's retraction verdict but not the
      // open-access half, so it is asked again rather than left half-answered.
      const known = this.entry(item).signals;
      if (known && !this.signalsStale(known)) continue;
      // Without a DOI there is nothing to ask Crossref, so asking wastes a turn.
      if (!this.signalTools.bareDOI(this.citationRecord(item).doi)) continue;
      wanted.push(item);
    }
    return wanted;
  }

  // What the panel needs to say there is work to do, counted without asking
  // the network anything.
  async backfillPending(libraryID) {
    let signals = 0, files = 0;
    const journals = new Set();
    for (const item of await this.libraryItems(libraryID)) {
      if (!this.isRegular(item)) continue;
      if (this.attachmentKinds(item).some(kind => !kind.read)) files++;
      const known = this.entry(item).signals;
      if (this.signalsStale(known) && this.signalTools.bareDOI(this.citationRecord(item).doi)) signals++;
      const record = this.journalRecord(item);
      if (!record.name && !record.issn) continue;
      // Only journals the curated catalogue does not already answer.
      if (this.displayValue('if', item) !== '' || this.displayValue('oaCitedness', item) !== '') continue;
      const key = this.journalTools2.cacheKey(record);
      if (!this.journalCache()[key]) journals.add(key);
    }
    const authors = this.watchedAuthors().filter(row => !row.sweptAt).length;
    return {signals, journals: journals.size, authors, files};
  }

  async backfill({libraryID, signal, onProgress, pace = 250} = {}) {
    const report = {files: null, works: null, signals: null, journals: null, authors: null, patents: null, budgetGone: false, stage: null};
    const note = (stage, done, total) => onProgress?.({stage, done, total});

    // Reading files costs no request, so it goes first and finishes even when
    // the day's API budget is already gone.
    report.stage = 'files';
    const unread = (await this.libraryItems(libraryID)).filter(item => {
      if (!this.isRegular(item)) return false;
      return this.attachmentKinds(item).some(kind => !kind.read);
    });
    if (unread.length) {
      report.files = await this.scanAttachmentKinds(unread,
        {signal, onProgress: (done, total) => note('files', done, total)});
    }
    if (signal?.aborted || !this.active || this.stopping) return report;

    // Fifty papers per request, so the whole library's citation record and every
    // affiliation behind it cost about as much as one page of search results.
    report.stage = 'works';
    report.works = await this.sweepPaperWorks(await this.libraryItems(libraryID),
      {signal, onProgress: (done, total) => note('works', done, total)});
    if (signal?.aborted || !this.active || this.stopping) return report;

    report.stage = 'signals';
    const papers = await this.itemsNeedingSignals(libraryID);
    if (papers.length) {
      report.signals = await this.refreshPaperSignals(papers,
        {signal, pace, onProgress: (done, total) => note('signals', done, total)});
      if (report.signals.budgetGone) { report.budgetGone = true; return report; }
    }
    if (signal?.aborted || !this.active || this.stopping) return report;

    report.stage = 'journals';
    const all = await this.libraryItems(libraryID);
    report.journals = await this.refreshJournalCitedness(all.filter(item => this.isRegular(item)),
      {signal, onProgress: (done, total) => note('journals', done, total)});
    if (report.journals.budgetGone) { report.budgetGone = true; return report; }
    report.journals.profiles = await this.refreshJournalProfiles({signal, onProgress: (done, total) => note('journals', done, total)});
    if (report.journals.profiles.budgetGone) { report.budgetGone = true; return report; }
    if (signal?.aborted || !this.active || this.stopping) return report;

    report.stage = 'authors';
    report.authors = await this.sweepWatchedAuthors(
      {signal, onProgress: (done, total) => note('authors', done, total)});
    report.budgetGone = !!report.authors.budgetGone;
    if (report.budgetGone) { report.stage = 'authors'; return report; }
    if (signal?.aborted || !this.active || this.stopping) return report;

    // Only with a USPTO key; the sweep says so itself otherwise.
    report.stage = 'patents';
    report.patents = await this.sweepWatchedPatents({signal, onProgress: (done, total) => note('patents', done, total)});
    report.stage = 'done';
    return report;
  }

  async exportWithTranslator(items, translatorID) {
    try {
      const Export = this.Z.Translate?.Export;
      if (typeof Export !== 'function' || !items?.length) return '';
      const translation = new Export();
      translation.setItems(items);
      translation.setTranslator(translatorID);
      await translation.translate();
      return String(translation.string || '').trim();
    } catch (error) { this.Z.logError?.(error); return ''; }
  }
  // Zotero's own CSL processor is authoritative when the style is installed;
  // the local formatter only covers the case where it is not.
  async citationText(items, style) {
    const records = items.map(item => this.bibliographyRecord(item));
    if (style.url) {
      /* Zotero's citation processor, directly, for any number of papers: the
         Quick Copy route stops at fifty, and past that the dialog fell back to
         the hand-made format without a word. One processor for the whole
         selection keeps numbering and same-author disambiguation whole. */
      if (typeof this.Z.Cite?.makeFormattedBibliographyOrCitationList === 'function' && this.Z.Styles?.get) {
        let processor = null;
        try {
          // The style list is loaded before it is asked; a dialog opened early found nothing and fell back.
          await this.Z.Styles.init?.();
          const installed = this.Z.Styles.get(style.url);
          if (!installed) throw Object.assign(new Error('style not installed'), {quiet: true});
          // The language Quick Copy is set to write citations in, as Zotero itself uses; the interface's only when none is set.
          let locale = '';
          try { locale = this.Z.Prefs.get('export.quickCopy.locale') || ''; } catch (_) {}
          processor = installed.getCiteProc(locale || this.Z.locale || 'en-US', 'text');
          const produced = String(this.Z.Cite.makeFormattedBibliographyOrCitationList(processor, items, 'text') || '').trim();
          if (produced) return produced;
        } catch (error) { if (!error?.quiet) this.Z.logError(error); }
        finally { try { processor?.free?.(); } catch (_) {} }
      }
      try {
        const output = await this.Z.QuickCopy?.getContentFromItems?.(items, 'bibliography=' + style.url);
        const produced = String(output?.text || '').trim();
        if (produced) return produced;
      } catch (error) { this.Z.logError(error); }
    }
    /* The export formats go through Zotero's own translators first: they know
       every item type (a book is not @article) and give two "smith2020"s
       distinct keys. The hand-written ones below are the fallback. */
    const EXPORT_TRANSLATORS = {bibtex: '9cb70025-a888-4a29-a210-93ec52da40d4', ris: '32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7', endnote: '881f60f2-0802-411a-9228-ce5f47b64c7d'};
    if (EXPORT_TRANSLATORS[style.key]) {
      const produced = await this.exportWithTranslator(items, EXPORT_TRANSLATORS[style.key]);
      if (produced) return produced;
    }
    if (style.key === 'bibtex') {
      const seen = new Map();
      return records.map(r => {
        const text = this.citationFormats.bibtex(r);
        const key = /^@\w+\{([^,]+),/.exec(text)?.[1] || 'ref';
        const n = seen.get(key) || 0; seen.set(key, n + 1);
        return n ? text.replace(`{${key},`, `{${key}${String.fromCharCode(96 + n)},`) : text;
      }).join('\n\n');
    }
    if (style.key === 'ris') return records.map(r => this.citationFormats.ris(r)).join('\n\n');
    // EndNote had a button and no branch: every press ended in "Unknown citation style".
    if (style.key === 'endnote') return records.map(r => this.citationFormats.endnote(r)).join('\n\n');
    return records.map(r => this.citationFormats.format(style.key, r)).join('\n\n');
  }
  // Google Scholar shows every style at once and lets you pick by eye. A stack of
  // menu items makes you choose a format before you can see what it looks like.
  async citationPanel(win, items) {
    if (!items.length) throw new Error(this.t('문헌을 먼저 선택하세요.'));
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
    panel.setAttribute('aria-label', this.t('인용문'));
    backdrop.appendChild(panel);

    const head = html('div');
    head.className = 'sc-cite-head';
    const title = html('h2');
    title.textContent = items.length > 1 ? this.t('인용 · {0}개').replace('{0}', items.length) : this.t('인용문');
    const close = html('button');
    close.type = 'button';
    close.className = 'sc-cite-close';
    close.setAttribute('aria-label', this.t('닫기'));
    close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    head.append(title, close);
    panel.appendChild(head);

    const rows = html('div');
    rows.className = 'sc-cite-rows';
    panel.appendChild(rows);

    const note = html('p');
    note.className = 'sc-cite-note';
    note.textContent = this.t('행을 누르면 복사됩니다.');
    panel.appendChild(note);

    const dismiss = () => { backdrop.remove(); win.removeEventListener('keydown', onKey, true); };
    // Escape closes; Tab stays inside the dialog, wrapping at either end.
    const onKey = event => {
      if (event.key === 'Escape') { event.stopPropagation(); dismiss(); return; }
      if (event.key !== 'Tab') return;
      const stops = [...panel.querySelectorAll('button,[tabindex="0"]')].filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (!stops.length) return;
      const first = stops[0], last = stops[stops.length - 1], current = doc.activeElement;
      if (event.shiftKey && (current === first || !panel.contains(current))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (current === last || !panel.contains(current))) { event.preventDefault(); first.focus(); }
    };
    panel.setAttribute('aria-modal', 'true');
    close.addEventListener('click', dismiss);
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) dismiss(); });
    win.addEventListener('keydown', onKey, true);

    const hint = note.textContent;
    const flash = (element, text) => {
      note.textContent = text;
      element.dataset.copied = 'true';
      win.setTimeout(() => { delete element.dataset.copied; note.textContent = hint; }, 900);
    };

    const activate = (element, run) => {
      element.addEventListener('click', run);
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); }
      });
    };
    const addRow = style => {
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
        .catch(error => { this.Z.logError(error); value.textContent = this.t('만들 수 없음'); row.setAttribute('aria-disabled', 'true'); });
      row.setAttribute('aria-label', style.label);
      activate(row, () => {
        if (row.getAttribute('aria-disabled') === 'true' || !value.textContent.trim()) return;
        this.Z.Utilities.Internal.copyTextToClipboard(value.textContent);
        flash(row, this.t('{0} 인용문을 복사했습니다.').replace('{0}', style.label));
      });
      return row;
    };
    for (const style of this.citationFormats.PANEL_STYLES) addRow(style);

    /* Any style installed in Zotero -- the journal a paper is going to, most
       often -- found by name here and drawn as one more row, instead of a trip
       to Zotero's own settings. The last five chosen come back next time.
       Nothing is downloaded: only what is already installed is offered. */
    const others = html('div');
    others.className = 'sc-cite-others';
    const find = html('input');
    find.type = 'search';
    find.className = 'sc-cite-find';
    find.placeholder = this.t('설치한 다른 인용 스타일 찾기');
    find.setAttribute('aria-label', find.placeholder);
    const found = html('div');
    found.className = 'sc-cite-found';
    found.setAttribute('role', 'list');
    others.append(find, found);
    panel.insertBefore(others, note);
    const shown = new Set(this.citationFormats.PANEL_STYLES.map(style => style.url).filter(Boolean));
    const choose = style => {
      if (shown.has(style.styleID)) return;
      shown.add(style.styleID);
      addRow({key: 'csl', label: style.title, url: style.styleID});
      const recent = (this.cache.citationStyles || []).filter(id => id !== style.styleID);
      this.cache.citationStyles = [style.styleID, ...recent].slice(0, 5);
      this.dirty = true;
    };
    let installed = [], generation = 0;
    Promise.resolve(this.Z.Styles?.init?.()).then(() => {
      installed = (this.Z.Styles?.getVisible?.() || []).filter(style => style?.styleID && style.title);
      for (const id of this.cache.citationStyles || []) { const style = installed.find(s => s.styleID === id); if (style) choose(style); }
    }).catch(error => this.Z.logError(error));
    find.addEventListener('input', () => {
      const mine = ++generation, q = find.value.trim().toLowerCase();
      found.replaceChildren();
      if (!q || mine !== generation) return;
      for (const style of installed.filter(s => s.title.toLowerCase().includes(q) && !shown.has(s.styleID)).slice(0, 8)) {
        const pick = html('button');
        pick.type = 'button';
        pick.className = 'sc-cite-pick';
        pick.textContent = style.title;
        pick.setAttribute('role', 'listitem');
        pick.addEventListener('click', () => { choose(style); found.replaceChildren(); find.value = ''; });
        found.appendChild(pick);
      }
      if (!found.childNodes.length) { const none = html('p'); none.className = 'sc-cite-note'; none.textContent = this.t('맞는 설치 스타일이 없습니다.'); found.appendChild(none); }
    });

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
          flash(link, this.t('{0} 형식을 복사했습니다.').replace('{0}', format.label));
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
    if (!output.trim()) throw new Error('인용문을 만들 정보가 모자랍니다. 저자·연도·제목을 채운 뒤 다시 실행하세요.');
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
        await this.refreshCitations(items,{syncExtra:false});
        for(const item of items) {
          if(!this.active||this.stopping||!this.featureEnabled("citedCountColumn")||!this.pref("metadataCitations",true))break;
          try { await this.persistCitation(item,this.entry(item).citationLookup); }
          catch(error){this.Z.logError(error);}
        }
      }).catch(error=>this.Z.logError(error));
      return this.metadataQueue;
    },1200);
  }
  /* Extra's "Citations:" line follows the cache. 354 items showed a line that
     disagreed with the count the cache now held, because only the background
     writer ever touched it. When a refresh the reader asked for brings a new
     count and "citations in Extra" is on, an existing line is rewritten in the
     same refresh: one transaction, no Date Modified bump, nothing added to a
     paper that has no line, an equal count left alone. */
  async syncCitationExtras(rows) {
    if (!this.active || this.stopping || !this.featureEnabled("citedCountColumn") || !this.pref("metadataCitations", true)) return {written: 0};
    const owned = /^\s*Citations:\s*\d[\d,]*(?:\s+\([^\r\n]*\))?\s*$/i;
    const todo = [];
    for (const {item, count, checkedAt} of rows || []) {
      if (!this.canEdit(item) || item.hasChanged?.() || !Number.isSafeInteger(count) || count < 0) continue;
      const stamp = Date.parse(checkedAt);
      if (!Number.isFinite(stamp)) continue;
      const before = String(item.getField("extra") || ""), lines = before.split(/\r?\n/);
      const line = lines.find(l => owned.test(l));
      if (line === undefined) continue;
      if (Number(String(line.match(/\d[\d,]*/)?.[0] || "").replace(/,/g, "")) === count) continue;
      const written = `Citations: ${count} (OpenAlex, ${new Date(stamp).toISOString().slice(0, 10)})`;
      todo.push({item, before, after: [...lines.filter(l => !owned.test(l)), written].join("\n").replace(/^\n/, ""), line: written});
    }
    if (!todo.length) return {written: 0};
    const done = [];
    const work = this.queue.then(async () => {
      try {
        await this.Z.DB.executeTransaction(async () => {
          for (const row of todo) {
            /* Extra as it is now, not as it was before this waited its turn in the
               queue: a rating or a note saved meanwhile is kept, and only the
               Citations line is replaced. */
            if (!this.canEdit(row.item) || row.item.hasChanged?.()) continue;
            const now = String(row.item.getField("extra") || ""), lines = now.split(/\r?\n/);
            if (!lines.some(l => owned.test(l))) continue;
            row.before = now;
            row.after = [...lines.filter(l => !owned.test(l)), row.line].join("\n").replace(/^\n/, "");
            if (row.after === now) continue;
            row.item.setField("extra", row.after);
            await row.item.save({notifierData: {styleCustomCitations: true}, skipSelect: true, skipDateModifiedUpdate: true});
            done.push(row);
          }
        });
      } catch (error) {
        for (const row of todo) { try { if (row.item.getField("extra") === row.after) row.item.setField("extra", row.before); } catch (_) {} }
        throw error;
      }
      for (const row of done) this.entry(row.item).citationExtra = {identity: this.citationTools.identity(this.citationRecord(row.item)), line: row.line};
      this.dirty = true;
    });
    this.queue = work.catch(() => {});
    try { await work; } catch (error) { this.Z.logError?.(error); return {written: 0, error: String(error?.message || error)}; }
    return {written: done.length};
  }
  async persistCitation(item,result,{flush=true}={}) {
    if(!this.active||this.stopping||!this.canEdit(item)||item.hasChanged?.()||result?.status!=="ok"||!Number.isSafeInteger(result.count)||result.count<0)return false;
    if(!this.cache.citationExtraNoticeShown){
      /* The first time the plugin writes into a field the user can see, it
         says so, once -- in the panel, the next time it is open. This ran in
         the background and used a modal alert, which stopped whatever the
         reader was doing, a PDF included, to say it. */
      this.cache.citationExtraNoticeShown=true;this.cache.citationExtraNoticePending=true;this.dirty=true;
    }
    if(!["OpenAlex","Crossref"].includes(result.source)||result.identity!==this.citationTools.identity(this.citationRecord(item)))return false;
    if(!Number.isFinite(Date.parse(result.checkedAt)))return false;
    const before=String(item.getField("extra")||"");
    const line=`Citations: ${result.count} (${result.source}, ${new Date(result.checkedAt).toISOString().slice(0,10)})`;
    const lines=before.split(/\r?\n/),owned=/^\s*Citations:\s*\d[\d,]*(?:\s+\([^\r\n]*\))?\s*$/i;
    const after=[...lines.filter(l=>!owned.test(l)),line].join("\n").replace(/^\n/,"");
    if(before===after)return false;
    item.setField("extra",after);
    // A count refreshed in the background is not an edit: left to bump Date
    // Modified, one backfill made every paper in the library "recent".
    try {await item.saveTx({notifierData:{styleCustomCitations:true},skipSelect:true,skipDateModifiedUpdate:true});}
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
        report.lookup=lookup?await this.refreshCitations(items,{syncExtra:false}):{cachedOnly:true};
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
      // The citation lookups honour the same OpenAlex hold as every other request.
      const openAlex=/^https:\/\/api\.openalex\.org\//.test(String(url));
      if(openAlex&&this.openAlexSpentUntil&&Date.now()<this.openAlexSpentUntil){finish(reject,Object.assign(new Error("Insufficient budget"),{status:429,held:true}));return;}
      try {
        Promise.resolve(this.Z.HTTP.request("GET",url,{headers,responseType:"json",timeout:15000,successCodes:false,errorDelayMax:0,cancellerReceiver:fn=>{cancel=fn;if(signal.aborted)cancel();}}))
          .then(response=>{
            try {
              const status=Number(response.status??200);
              if(openAlex&&status===429){let body='';try{body=typeof response.response==='string'?response.response:JSON.stringify(response.response||'');}catch(_){}if(/insufficient budget|budget exceeded|daily .*limit/i.test(body)){const d=new Date();this.openAlexSpentUntil=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1);}}
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
    let lastPaint=0;const okRows=[];
    const ctx={signal:job.controller.signal,email:this.contactEmail(),openalexApiKey:this.openAlexKey(),
      onProgress:progress=>{this.citationProgress=progress;options.onProgress?.(progress);},
      onResult:async result=>{
        const item=byKey.get(result.key);
        if(!this.active||job.controller.signal.aborted||!item||this.citationTools.identity(this.citationRecord(item))!==result.identity)return;
        const entry=this.entry(item);entry.citationAttempt=result;
        if(result.status==="ok"){entry.citationLookup=result;if(["OpenAlex","Crossref"].includes(result.source))okRows.push({item,count:result.count,checkedAt:result.checkedAt});}
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
      .then(async()=>{
        // A refresh the reader asked for also brings an existing Extra line up to date. The background writers persist for themselves.
        if(options.syncExtra!==false&&!options.background&&okRows.length)await this.syncCitationExtras(okRows);
        return summary;
      }).catch(error=>{if(error.name!=="AbortError")throw error;return {...summary,cancelled:true};})
      .finally(async()=>{
        for(const item of selection)delete this.entry(item).citationPending;
        if(this.citationJob===job)this.citationJob=null;
        this.dirty=true;await this.flush();await this.refreshWindows();
      });
    return job.promise;
  }
  rebuildJournals() {
    /* One record per title, but a JCR record is never displaced by a publisher-page
       record, whichever comes later in the catalog or the cache. */
    const records = new Map();
    // Two journals can share a title (Microbiology: the Russian one and the Society's):
    // the ISSNs are part of the identity, so they are kept apart and journals.lookup decides.
    const keyOf = r => this.journalTools.name(r.title) + '|' + (r.issns || []).map(i => this.journalTools.issn(i)).filter(Boolean).sort().join(',');
    const offer = r => {
      const key = keyOf(r), previous = records.get(key);
      if (previous && previous.authority === 'jcr' && r.authority !== 'jcr') return;
      records.set(key, r);
    };
    for (const r of this.catalog) offer(r);
    for (const r of Object.values(this.cache.journals || {})) {
      if (!this.journalTools.valid(r)) continue;
      const previous = records.get(keyOf(r));
      if (!previous || (r.year || 0) >= (previous.year || 0) && r.checkedAt >= previous.checkedAt) offer(r);
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
  async addReading(item, seconds, location, shown) {
    if (!this.active || !this.isRegular(item) || !Number.isFinite(seconds) || seconds <= 0) return;
    const record = this.entry(item);
    if (!Number.isFinite(record.seconds)) record.seconds = this.metrics(item).seconds;
    /* The first real reading (30 s) of a paper tagged /unread turns the tag to
       /reading through the ordinary edit path; clearing the override alone left
       the /unread tag standing and the two disagreed. */
    const unreadTagged = record.unreadOverride || (item.getTags?.() || []).some(tag => /^\/unread$/i.test(String(tag?.tag ?? tag).trim()));
    record.seconds += seconds; record.unreadOverride = false; this.dirty = true;
    // In-progress promotions live in a Set, not in the cache: anything on the entry is flushed to disk.
    const promotingKey = `${item.libraryID}:${item.key ?? item.id}`;
    this._promoting ||= new Set();
    if (this.pref('autoStatus', true) && this.featureEnabled('readStatus') && unreadTagged && record.seconds >= 30 && !this._promoting.has(promotingKey) && this.canEdit(item)) {
      this._promoting.add(promotingKey);
      this.edit([item], {status: 'reading'}).catch(error => this.Z.logError(error)).finally(() => { this._promoting.delete(promotingKey); });
    }
    record.lastRead=new Date().toISOString();
    if(Number.isInteger(location?.attachmentID)&&location.attachmentID>0&&Number.isInteger(location.pageIndex)&&location.pageIndex>=0&&location.pageIndex<100000&&Number.isInteger(location.totalPages)&&location.totalPages>location.pageIndex&&location.totalPages<=100000){record.readingAttachments||={};const bucket=record.readingAttachments[String(location.attachmentID)]||={pageTimes:{},totalPages:location.totalPages};bucket.pageTimes||={};bucket.pageTimes[location.pageIndex]=(Number(bucket.pageTimes[location.pageIndex])||0)+seconds;bucket.totalPages=location.totalPages;bucket.lastRead=record.lastRead;bucket.lastPageIndex=shown&&shown.attachmentID===location.attachmentID&&Number.isInteger(shown.pageIndex)&&shown.pageIndex>=0&&shown.pageIndex<bucket.totalPages?shown.pageIndex:location.pageIndex;record.readingAttachmentID=location.attachmentID;}
    this.refreshReadingDisplays(item.id);
    /* The cells are already repainted in place. A full store write and an item
       tree rebuild every second was the rest of this method; the seconds are
       now written at most twice a minute, and on stop. */
    this.scheduleFlush(30000);
  }
  /* A write that can wait. Anything that must be on disk now calls flush(). */
  scheduleFlush(delay = 30000) {
    if (this.flushTimer || this.stopping) return;
    // A window supplies the clock; during startup there may not be one yet, and
    // the plugin's own sandbox has no timers at all. Then the write simply waits
    // for the next explicit flush.
    const host = this.Z.getMainWindow?.() || (typeof globalThis.setTimeout === 'function' ? globalThis : null);
    if (typeof host?.setTimeout !== 'function') return;
    const timer = host.setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush().catch(error => this.Z.logError(error));
    }, delay);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    this.flushTimer = timer;
  }
  cancelScheduledFlush() {
    if (!this.flushTimer) return;
    const host = this.Z.getMainWindow?.() || (typeof globalThis.clearTimeout === 'function' ? globalThis : null);
    if (typeof host?.clearTimeout === 'function') host.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
  flush() {
    this.cancelScheduledFlush();
    // A write is a change, whether or not a window is refreshed after it.
    this.bumpState();
    const work = this.writeQueue.then(async () => {
      if (!this.dirty) return;
      const snapshot = JSON.parse(JSON.stringify(this.cache));
      this.dirty = false;
      try { await this.storage.write(snapshot); this.writeFailed = false; }
      catch (error) {
        this.dirty = true;
        /* A disk that will not take the file loses reading time, ratings and
           citation counts silently. Say it once, in the panel, and not again
           until a write succeeds. */
        if (!this.writeFailed) {
          this.writeFailed = true;
          for (const [, state] of this.windows) {
            try { state.workbench?.setStatus?.('저장하지 못했습니다. 디스크 공간과 Zotero 폴더 권한을 확인하세요. 지금까지의 기록은 창을 닫기 전까지 남아 있습니다.'); } catch (ignored) {}
          }
        }
        throw error;
      }
    });
    this.writeQueue = work.catch(error => this.Z.logError(error));
    return work;
  }
  async refreshWindows() {
    // Anything worth repainting for is worth recomputing for.
    this.bumpState();
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
  /* Double-clicking a column's resizer fits the column to its content.

     Zotero's header lets you drag a resizer and nothing else; every desktop
     table fits on double-click and people reach for it. The table is
     virtualised, so "content" is the rows currently drawn -- which is what a
     reader is looking at, and what every spreadsheet fits to as well.

     A resize in Zotero is a trade between a column and its right-hand
     neighbour, so the fit gives or takes the difference from that neighbour
     the same way a drag does, and stores the result through the table's own
     onResize so it persists like a drag would. */
  /* A patent or a thesis, marked where the eye lands.

     A row called US20240352440A1.pdf sat in the list like any other PDF, and
     a thesis was one more journalArticle without a journal. Neither is a
     paper: no impact factor applies, no journal colour, a different reason
     to be on the shelf. A small chip before the title says which it is, on
     a regular item by its type or title and on a bare attachment by the file
     name -- the case the user actually hit. */
  /* Zotero keeps a title's inline markup in the field and prints it as text
     in the tree: "<i>Bacillus subtilis</i>". Six inline tags are drawn as
     what they mean; anything else stays literal. The tree redraws its rows
     on every refresh and this pass runs after each, so the cell is rebuilt
     only while it still shows a tag. */
  richText(doc, parent, text) {
    const parts = String(text).split(/(<\/?(?:i|b|em|strong|sub|sup)>)/i);
    const stack = [parent];
    for (const part of parts) {
      if (!part) continue;
      const m = part.match(/^<(\/?)(i|b|em|strong|sub|sup)>$/i);
      if (!m) { stack[stack.length - 1].appendChild(doc.createTextNode(part)); continue; }
      const tag = m[2].toLowerCase();
      if (m[1]) { if (stack.length > 1 && stack[stack.length - 1].localName === tag) stack.pop(); continue; }
      const el = doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
      stack[stack.length - 1].appendChild(el); stack.push(el);
    }
  }

  paintTitleMarkup(titleText, item, win) {
    if (!titleText || !item) return false;
    const title = String(item.getField?.('title') || '');
    if (!/<\/?(i|b|em|strong|sub|sup)>/i.test(title)) return false;
    // Drawn already: the cell's words no longer equal the raw field.
    if (String(titleText.textContent || '') !== title) return false;
    titleText.replaceChildren();
    this.richText(win.document, titleText, title);
    return true;
  }

  get MENU_ICONS() {
    return {
      circle:[['circle',{cx:8,cy:8,r:5}]],
      half:[['circle',{cx:8,cy:8,r:5}],['path',{d:'M8 3a5 5 0 010 10z',fill:'currentColor',stroke:'none'}]],
      disc:[['circle',{cx:8,cy:8,r:5,fill:'currentColor'}]],
      search:[['circle',{cx:7.25,cy:7.25,r:4.25}],['line',{x1:10.5,y1:10.5,x2:13.5,y2:13.5}]],
      related:[['circle',{cx:4.4,cy:11.4,r:2.1}],['circle',{cx:11.5,cy:4.6,r:2.1}],['line',{x1:6,y1:9.9,x2:10,y2:6.1}]],
      authors:[['circle',{cx:8,cy:5.6,r:2.5}],['path',{d:'M3.3 13.1c.7-2.5 2.5-3.8 4.7-3.8s4 1.3 4.7 3.8'}]],
      star:[['path',{d:'M8 2.6l1.7 3.6 3.9.5-2.8 2.7.7 3.9L8 11.4l-3.5 1.9.7-3.9L2.4 6.7l3.9-.5z'}]],
      journals:[['line',{x1:4,y1:12.6,x2:4,y2:8.6}],['line',{x1:8,y1:12.6,x2:8,y2:5}],['line',{x1:12,y1:12.6,x2:12,y2:10}],['line',{x1:2.4,y1:12.6,x2:13.6,y2:12.6}]],
      reading:[['path',{d:'M8 4.8C6.7 3.7 5.1 3.2 3 3.2v8.6c2.1 0 3.7.5 5 1.6 1.3-1.1 2.9-1.6 5-1.6V3.2c-2.1 0-3.7.5-5 1.6z'}],['line',{x1:8,y1:4.8,x2:8,y2:13.4}]],
      quote:[['path',{d:'M6.5 4.5C4.6 4.9 3.4 6.2 3.4 8.4V11.5h3.4V8.4H5.2c0-1.2.6-2 1.7-2.4zM12.6 4.5c-1.9.4-3.1 1.7-3.1 3.9V11.5h3.4V8.4h-1.6c0-1.2.6-2 1.7-2.4z'}]],
      columns:[['rect',{x:2.6,y:3.2,width:10.8,height:9.6,rx:1.2}],['line',{x1:6.2,y1:3.2,x2:6.2,y2:12.8}],['line',{x1:9.8,y1:3.2,x2:9.8,y2:12.8}]],
      panel:[['rect',{x:2.6,y:3.2,width:10.8,height:9.6,rx:1.2}],['line',{x1:6.4,y1:3.2,x2:6.4,y2:12.8}],['line',{x1:8.4,y1:6,x2:11.2,y2:6}],['line',{x1:8.4,y1:8.4,x2:11.2,y2:8.4}]],
      graph:[['circle',{cx:8,cy:3.6,r:1.7}],['circle',{cx:3.7,cy:11.8,r:1.7}],['circle',{cx:12.3,cy:11.8,r:1.7}],['line',{x1:6.9,y1:5.1,x2:4.6,y2:10.2}],['line',{x1:9.1,y1:5.1,x2:11.4,y2:10.2}],['line',{x1:5.4,y1:11.8,x2:10.6,y2:11.8}]],
      refresh:[['path',{d:'M12.8 8a4.8 4.8 0 01-8.4 3.2M3.2 8a4.8 4.8 0 018.4-3.2'}],['path',{d:'M11.6 2.4v2.6H9M4.4 13.6V11h2.6'}]],
      citations:[['path',{d:'M5.5 4.5C3.8 4.5 2.5 5.8 2.5 7.5S3.8 10.5 5.5 10.5c.3 0 .6 0 .8-.1-.4 1-1.3 1.7-2.3 2v1.1c2.3-.4 4-2.4 4-4.8V7.5c0-1.7-1.3-3-3-3zM12.5 4.5c-1.7 0-3 1.3-3 3s1.3 3 3 3c.3 0 .6 0 .8-.1-.4 1-1.3 1.7-2.3 2v1.1c2.3-.4 4-2.4 4-4.8V7.5c0-1.7-1.3-3-3-3z',fill:'currentColor',stroke:'none'}]],
      stop:[['rect',{x:3.5,y:3.5,width:9,height:9,rx:1.5}]],
      attachments:[['path',{d:'M11.5 7.2l-4.6 4.6a2.4 2.4 0 01-3.4-3.4l5.4-5.4a1.7 1.7 0 012.4 2.4l-5.2 5.2a.9.9 0 01-1.3-1.3l4.5-4.5'}]],
      fill:[['rect',{x:2.6,y:3.2,width:10.8,height:9.6,rx:1.2}],['path',{d:'M2.6 8.6l3.2-2.4 2.6 2 2.2-1.6 2.8 2.2V12.8H2.6z',fill:'currentColor',stroke:'none',opacity:'.6'}]],
      signal:[['path',{d:'M8 2.8l5.4 9.6H2.6z'}],['line',{x1:8,y1:6.4,x2:8,y2:9.2}],['circle',{cx:8,cy:10.9,r:.5,fill:'currentColor'}]],
      download:[['path',{d:'M8 2.8v7.2M4.8 7.2L8 10.4l3.2-3.2'}],['path',{d:'M3 12.8h10'}]],
      palette:[['circle',{cx:8,cy:8,r:5.4}],['circle',{cx:5.6,cy:7,r:.9,fill:'currentColor'}],['circle',{cx:8.4,cy:5.2,r:.9,fill:'currentColor'}],['circle',{cx:10.6,cy:7.6,r:.9,fill:'currentColor'}],['path',{d:'M8 13.4c-1-1.2-.4-2.6.8-2.8 1.3-.2 1.9-1.3 1.4-2.2'}]],
      collections:[['path',{d:'M2.6 5.1c0-.7.6-1.3 1.3-1.3h2.3l1 1.2h4.9c.7 0 1.3.6 1.3 1.3v5.5c0 .7-.6 1.3-1.3 1.3H3.9c-.7 0-1.3-.6-1.3-1.3z'}]]
    };
  }

  paintKind(row, item, state, win) {
    const cell = row.querySelector('.cell.title');
    if (!cell || !item) return;
    let chip = cell.querySelector('.style-custom-kind');
    const found = this.itemKinds.kindOf({
      itemType: item.itemType,
      title: item.getField?.('title'),
      filename: item.isAttachment?.() && !item.parentItemID ? (item.attachmentFilename || item.getField?.('title')) : ''
    });
    if (!found) { chip?.remove(); return; }
    const P = this.palette(win.document);
    const label = found.kind === 'patent' ? '특허' : '학위논문';
    const tone = found.kind === 'patent' ? P.amber : P.purple;
    if (!chip) {
      chip = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      chip.className = 'style-custom-kind';
      // floor-exempt: user-requested original size (9px), 2026-10-04.
      chip.style.cssText = `display:inline-block;margin-inline-end:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:700;line-height:14px;vertical-align:middle;pointer-events:none;`;
      cell.insertBefore(chip, cell.firstChild);
      state.titleNodes.add(chip);
    }
    chip.textContent = label;
    chip.style.background = this.tint(tone, 0.16);
    chip.style.color = tone;
    chip.title = found.kind === 'patent'
      ? `${found.number ? this.itemKinds.office(found.number) + ' ' + this.t('특허') + ' ' + found.number : this.t('특허')} · ${this.t(found.why === 'file name' ? '파일 이름으로 판별' : found.why === 'title' ? '제목으로 판별' : '항목 유형')}`
      : `${this.t('학위논문')} · ${this.t(found.why === 'title' ? '제목으로 판별' : '항목 유형')}`;
  }

  attachColumnFit(win, state) {
    const doc = win.document;
    // A host without a real document (tests, some headless windows) has no
    // header to fit; register nothing rather than fail the whole window setup.
    if (typeof doc?.addEventListener !== 'function') return;
    // What the last double-click found, for the self-check: a fit that does
    // nothing looks the same as one that never ran, and the user cannot tell.
    state.columnFit = { seen: 0, fitted: 0, last: '' };
    const onDouble = event => { try { fit(event); } catch (error) { state.columnFit.last = 'error: ' + (error.message || error); this.Z.logError(error); } if (state.columnFit.last && !state.columnFit.last.includes(' → ')) { try { this.Z.Prefs.set('extensions.style-custom.columnFitLast', new Date().toISOString() + ' ' + state.columnFit.last, true); } catch (ignored) {} } };
    const fit = event => {
      const resizer = event.target?.closest?.('.virtualized-table-header .resizer');
      if (!resizer) return;
      state.columnFit.seen++;
      const tree = win.ZoteroPane?.itemsView?.tree;
      if (!tree?._columns?.onResize || !tree.props?.id) { state.columnFit.last = 'no tree: ' + [!!tree, !!tree?._columns?.onResize, tree?.props?.id].join(','); return; }
      const edgeKey = [...resizer.classList].find(name => !['resizer', 'draggable', 'react-draggable'].includes(name) && !name.startsWith('react-draggable-'));
      if (!edgeKey) { state.columnFit.last = 'no key in ' + resizer.className; return; }
      const visible = tree._getVisibleColumns?.() || [];
      /* Zotero draws each column's resizer at that column's LEFT edge and
         names it after that column, so the edge the user sees at the right of
         "Publication" is the resizer of the column after it. A double-click
         there fits the column to the LEFT of the edge, as a spreadsheet does;
         fitting the resizer's own column squeezed Publication instead, since
         the room came out of its neighbours. */
      const index = visible.findIndex(column => column.dataKey === edgeKey) - 1;
      const column = visible[index], neighbour = visible[index + 1];
      if (!column || !neighbour) { state.columnFit.last = 'no pair at ' + edgeKey; return; }
      const dataKey = column.dataKey;
      event.stopPropagation(); event.preventDefault();
      const escape = win.CSS.escape(dataKey);
      const head = doc.querySelector(`#${tree.props.id} .virtualized-table-header .cell.${escape}`);
      const next = doc.querySelector(`#${tree.props.id} .virtualized-table-header .cell.${win.CSS.escape(neighbour.dataKey)}`);
      if (!head || !next) { state.columnFit.last = 'no header cells for ' + dataKey; return; }
      /* What the cells hold. scrollWidth is the floor, but a cell that clips
         its text behind an ellipsis can report the clipped width, and then
         the fit finds nothing to do. So the text is also measured with the
         cell's own font, and elements (journal marks, kind chips) by their
         boxes; a clipped element is entered the same way. */
      let ctx = null;
      try { ctx = doc.createElementNS('http://www.w3.org/1999/xhtml', 'canvas').getContext('2d'); } catch (ignored) {}
      const styleOf = el => { try { return win.getComputedStyle?.(el) || null; } catch (ignored) { return null; } };
      const px = value => parseFloat(value) || 0;
      /* scrollWidth only says something when the content overflows; for a
         box wider than its text it is the box's own width, and a fit that
         trusted it grew the column by its padding at every double-click. */
      const overflow = el => ((el.scrollWidth || 0) > (el.clientWidth || 0) ? el.scrollWidth : 0);
      const contentWidth = el => {
        const style = styleOf(el);
        let sum = 0;
        for (const node of el.childNodes) {
          if (node.nodeType === 3) {
            if (ctx && style && node.textContent.trim()) {
              ctx.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              sum += ctx.measureText(node.textContent).width;
            }
          }
          else if (node.nodeType === 1) {
            const inner = styleOf(node);
            const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect().width : 0;
            /* A box stretched across its cell (a right-aligned figure is a
               block as wide as the column) says how wide the column is, not
               what it holds: measured by its box, each fit added the padding
               again and IF grew at every double-click. Such a box is
               measured by its content, like a clipped one. */
            const stretched = inner && (inner.display === 'block' || inner.display === 'flex' || px(inner.flexGrow) > 0 || box >= (el.clientWidth || 0) - 1 - px(style?.paddingLeft) - px(style?.paddingRight));
            sum += (inner && (inner.overflow === 'hidden' || stretched) ? contentWidth(node) : Math.max(box, overflow(node)))
              + (inner ? px(inner.marginLeft) + px(inner.marginRight) : 0);
          }
        }
        if (style) sum += px(style.paddingLeft) + px(style.paddingRight);
        return Math.max(sum, overflow(el), ...[...el.children].map(child => (overflow(child) ? child.scrollWidth + (child.offsetLeft || 0) : 0)));
      };
      let widest = 0, byScroll = 0, cells = 0, widestText = '';
      for (const cell of doc.querySelectorAll(`#${tree.props.id} .virtualized-table-body .cell.${escape}`)) {
        cells++;
        byScroll = Math.max(byScroll, overflow(cell));
        const width = contentWidth(cell);
        if (width > widest) { widest = width; widestText = String(cell.textContent || '').trim().slice(0, 60); }
      }
      // The header's own word, measured the same way (its label box grows
      // with the column, so its scrollWidth would only echo the width back).
      const label = head.querySelector('.cell-text, span');
      if (label) {
        let labelWidth = overflow(label);
        const style = styleOf(label);
        if (ctx && style && label.textContent.trim()) { ctx.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; labelWidth = Math.max(labelWidth, ctx.measureText(label.textContent).width); }
        widest = Math.max(widest, labelWidth ? labelWidth + 22 : 0);
      }
      const PAD = 16, MIN = 20, SHARE = 0.6, ALWAYS = 320;
      const cellFor = key => doc.querySelector(`#${tree.props.id} .virtualized-table-header .cell.${win.CSS.escape(key)}`);
      const widths = new Map();
      for (const c of visible) { const cell = c.dataKey === dataKey ? head : c.dataKey === neighbour.dataKey ? next : cellFor(c.dataKey); if (cell) widths.set(c.dataKey, cell.getBoundingClientRect().width); }
      const floor = c => (c.minWidth || MIN) + PAD;
      /* A fit changes this one column and nothing else. When the columns no
         longer fit the list, the list rolls sideways (rollTable) instead of
         squeezing the others, as a spreadsheet would. A column still takes
         at most SHARE of the window's list, a bound that does not move as
         the rolled list grows, and may always reach ALWAYS pixels. */
      const body = doc.querySelector(`#${tree.props.id} .virtualized-table-body`);
      const viewport = (body && body.clientWidth > 16) ? body.clientWidth - 16 : [...widths.values()].reduce((a, b) => a + b, 0);
      const cap = viewport ? Math.max(floor(column), ALWAYS, Math.round(viewport * SHARE)) : Infinity;
      const want = Math.round(Math.min(Math.max(floor(column), widest + PAD), cap));
      const current = widths.get(dataKey);
      const delta = want - current;
      // Already the right width: the same double-click must leave it alone.
      if (Math.abs(delta) < 1) { state.columnFit.fitted++; state.columnFit.last = `${dataKey}: ${Math.round(current)} already fits (content ${Math.round(widest)})`; return; }
      /* Every flexible column is stored together with the fitted one, at the
         width it was given, so what Zotero writes to disk is the layout on
         screen and the next launch restores it, rolled or flat. Zotero's own
         drag stores only the pair it moved and leaves the rest stale. */
      const stored = this.storedWidths(win, tree);
      const changes = {};
      for (const c of visible) if (!c.fixedWidth && !c.staticWidth) changes[c.dataKey] = Math.round(stored.get(c.dataKey) || widths.get(c.dataKey) || 0);
      const width = want;
      changes[dataKey] = width;
      tree._columns.onResize(changes, true);
      this.rollTable(win, state);
      state.columnFit.fitted++; state.columnFit.last = `${dataKey}: ${Math.round(current)} → ${Math.round(width)} (content ${Math.round(widest)} by text, ${Math.round(byScroll)} by scrollWidth, ${cells} cells, widest "${widestText}", ${state.tableRoll?.rolling ? 'list rolls to ' + Math.round(state.tableRoll.wanted) : 'fits the list'})`;
      // Left where it can be read without a window, for the next report of a fit that did nothing.
      try { this.Z.Prefs.set('extensions.style-custom.columnFitLast', new Date().toISOString() + ' ' + state.columnFit.last, true); } catch (ignored) {}
    };
    doc.addEventListener('dblclick', onDouble, true);
    state.listeners.push([doc, 'dblclick', onDouble, true]);
    this.attachTableRoll(win, state);
    this.attachColumnDrag(win, state);
  }

  /* Dragging a column edge. Zotero trades width between the two columns at
     the edge, so the columns further right stay where they are; with a list
     that rolls sideways the user expects a spreadsheet: the column to the
     left of the edge changes and everything after it follows. The drag is
     taken over at the document, before Zotero's own handler sees the
     mousedown; the mouseup is swallowed too, or the header would sort. */
  attachColumnDrag(win, state) {
    const doc = win.document;
    if (typeof doc?.addEventListener !== 'function') return;
    state.columnDrag = { drags: 0, last: '' };
    let drag = null;
    const treeOf = () => win.ZoteroPane?.itemsView?.tree;
    const onDown = event => {
      try {
        if (event.button !== 0 || drag) return;
        const resizer = event.target?.closest?.('.virtualized-table-header .resizer');
        const tree = treeOf();
        if (!resizer || !tree?.props?.id || !tree._columns?.onResize || !resizer.closest(`#${tree.props.id}`)) return;
        const edgeKey = [...resizer.classList].find(name => !['resizer', 'draggable', 'react-draggable'].includes(name) && !name.startsWith('react-draggable-'));
        const visible = tree._getVisibleColumns?.() || [];
        let index = visible.findIndex(c => c.dataKey === edgeKey) - 1;
        while (index >= 0 && (visible[index].fixedWidth || visible[index].staticWidth)) index--;
        const column = visible[index];
        if (!column) return;
        const root = doc.getElementById(tree.props.id);
        const cellFor = key => root?.querySelector(`.virtualized-table-header .cell.${win.CSS.escape(key)}`);
        // As Zotero does at a drag's start: every column set to the width it
        // shows, so nothing jumps when the drag begins.
        const rects = {};
        for (const c of visible) { const cell = cellFor(c.dataKey); if (cell && !c.fixedWidth) rects[c.dataKey] = cell.getBoundingClientRect().width; }
        tree._columns.onResize(rects);
        const start = rects[column.dataKey];
        if (!(start > 0)) return;
        event.stopPropagation(); event.preventDefault();
        drag = { tree, column, visible, startX: event.clientX, start, width: start, min: (column.minWidth || 20) + 16, root };
        root?.classList.add('resizing');
      }
      catch (error) { this.Z.logError(error); }
    };
    const onMove = event => {
      if (!drag) return;
      event.stopPropagation(); event.preventDefault();
      const width = Math.round(Math.max(drag.min, drag.start + (event.clientX - drag.startX)));
      if (width === drag.width) return;
      drag.width = width;
      try { drag.tree._columns.onResize({ [drag.column.dataKey]: width }); this.rollTable(win, state); }
      catch (error) { this.Z.logError(error); }
    };
    const onUp = event => {
      if (!drag) return;
      event.stopPropagation(); event.preventDefault();
      const done = drag; drag = null;
      done.root?.classList.remove('resizing');
      try {
        // Stored with every flexible column, so the layout on disk is the one on screen.
        const stored = this.storedWidths(win, done.tree), changes = {};
        for (const c of done.visible) if (!c.fixedWidth && !c.staticWidth && stored.has(c.dataKey)) changes[c.dataKey] = Math.round(stored.get(c.dataKey));
        changes[done.column.dataKey] = done.width;
        done.tree._columns.onResize(changes, true);
        this.rollTable(win, state);
        state.columnDrag.drags++; state.columnDrag.last = `${done.column.dataKey}: ${Math.round(done.start)} → ${done.width}`;
      }
      catch (error) { this.Z.logError(error); }
    };
    for (const [name, fn] of [['mousedown', onDown], ['mousemove', onMove], ['mouseup', onUp]]) { doc.addEventListener(name, fn, true); state.listeners.push([doc, name, fn, true]); }
  }

  /* The width each visible column was given, from the stylesheet Zotero
     writes: a flexible column's flex-basis plus the 16 px Zotero takes off,
     a fixed or static column's min-width. What the flex layout then shows
     may be wider (spare room) or narrower (squeezed); this is the truth the
     roll and the fit work from. Without a rule, the width Zotero stores. */
  storedWidths(win, tree) {
    const sheet = tree._columns?._stylesheet?.sheet, map = tree._columns?._columnStyleMap || {};
    const widths = new Map();
    for (const c of tree._getVisibleColumns?.() || []) {
      const rule = sheet?.cssRules?.[map[win.CSS.escape(c.dataKey)]]?.style;
      let width;
      if (c.fixedWidth || c.staticWidth) width = parseFloat(rule?.minWidth) || parseFloat(c.width) || 0;
      else if (rule && parseFloat(rule.flexBasis) >= 0) width = parseFloat(rule.flexBasis) + 16;
      else width = parseFloat(c.width) || 0;
      widths.set(c.dataKey, width);
    }
    return widths;
  }

  /* Zotero's item list has no sideways scroll: columns that do not fit are
     squeezed until nothing in them reads, and a fit had to be paid for by
     another column. When the widths the columns were given add up to more
     than the list, the rows and the header are made that wide, the list
     scrolls sideways and the header follows it. Nothing is squeezed; a
     narrower window shows a scrollbar instead. */
  rollTable(win, state) {
    const doc = win.document, tree = win.ZoteroPane?.itemsView?.tree;
    if (!tree?.props?.id || !tree._columns) return null;
    const root = doc.getElementById(tree.props.id);
    // The id and the .virtualized-table class sit on the same element.
    const table = root?.classList?.contains('virtualized-table') ? root : root?.querySelector('.virtualized-table');
    const header = root?.querySelector('.virtualized-table-header');
    const body = root?.querySelector('.virtualized-table-body'), list = body?.querySelector('.windowed-list');
    if (!table || !header || !body || !list) { state.tableRoll = { error: 'missing ' + [!table && 'table', !header && 'header', !body && 'body', !list && 'list'].filter(Boolean).join(', ') }; return null; }
    let wanted = 0;
    for (const width of this.storedWidths(win, tree).values()) wanted += width;
    const PADDING = 16; // the body's own inline padding
    const available = body.clientWidth - PADDING;
    const rolling = wanted > 0 && available > 0 && wanted > available + 1;
    if (rolling) {
      const scrollbar = parseFloat(header.style.getPropertyValue('--scrollbar-width')) || Math.max(0, (body.offsetWidth || 0) - (body.clientWidth || 0));
      list.style.minWidth = wanted + 'px';
      header.style.width = (wanted + PADDING + scrollbar) + 'px';
      header.style.transform = `translateX(${-(body.scrollLeft || 0)}px)`;
      table.style.overflow = 'hidden';
    }
    else if (list.style.minWidth || header.style.width || table.style.overflow) {
      list.style.removeProperty('min-width'); header.style.removeProperty('width'); header.style.removeProperty('transform'); table.style.removeProperty('overflow');
      if (body.scrollLeft) body.scrollLeft = 0;
    }
    const flipped = !!state.tableRoll && state.tableRoll.rolling !== rolling;
    state.tableRoll = { wanted: Math.round(wanted), available: Math.round(available), rolling };
    if (flipped) { try { tree._debouncedRerender?.(); } catch (ignored) {} }
    return state.tableRoll;
  }

  attachTableRoll(win, state) {
    const doc = win.document;
    if (typeof doc?.addEventListener !== 'function' || typeof win.setTimeout !== 'function') return;
    let timer = null;
    const schedule = () => { if (timer) return; timer = win.setTimeout(() => { timer = null; try { this.rollTable(win, state); } catch (error) { this.Z.logError(error); } }, 50); };
    const follow = event => { const header = event.target?.parentNode?.querySelector?.('.virtualized-table-header'); if (header && header.style.width) header.style.transform = `translateX(${-(event.target.scrollLeft || 0)}px)`; };
    // The list is built after the window: watch for it, then for its columns.
    let observer = null;
    const watch = () => {
      const tree = win.ZoteroPane?.itemsView?.tree, root = tree?.props?.id && doc.getElementById(tree.props.id);
      const body = root?.querySelector('.virtualized-table-body'), header = root?.querySelector('.virtualized-table-header');
      if (!body || !header) return false;
      body.addEventListener('scroll', follow); state.listeners.push([body, 'scroll', follow]);
      if (typeof win.MutationObserver === 'function') { observer = new win.MutationObserver(schedule); observer.observe(header, { childList: true }); }
      schedule();
      return true;
    };
    let tries = 0;
    const tryWatch = () => { if (watch() || ++tries > 40) return; win.setTimeout(tryWatch, 500); };
    tryWatch();
    const onUp = () => schedule();
    doc.addEventListener('mouseup', onUp); state.listeners.push([doc, 'mouseup', onUp]);
    win.addEventListener('resize', schedule); state.listeners.push([win, 'resize', schedule]);
    state.rollCleanup = () => { observer?.disconnect(); if (timer) win.clearTimeout(timer); const tree = win.ZoteroPane?.itemsView?.tree, root = tree?.props?.id && doc.getElementById(tree.props.id); for (const [node, prop] of [[root?.querySelector('.windowed-list'), 'min-width'], [root?.querySelector('.virtualized-table-header'), 'width'], [root?.querySelector('.virtualized-table-header'), 'transform'], [root?.classList?.contains('virtualized-table') ? root : root?.querySelector('.virtualized-table'), 'overflow']]) node?.style.removeProperty(prop); };
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
      onTick:(item,seconds,location,shown)=>this.addReading(item,seconds,location,shown), onError:error=>this.Z.logError(error) });}
  }
  /* The plugin's own menus in one window: the item context menu entry and the Tools menu
     entry. Built here so a change of language can take them down and put them up again
     in every window (rebuildMenus); the labels are said in the language of the moment. */
  buildMenus(win, state) {
    const doc = win.document, popup = doc.getElementById("zotero-itemmenu");
    if (popup) {
      // Menu labels pass through the dictionary like everything the panel writes.
      const make = (tag,label,parent) => { const node=doc.createXULElement(tag); if(label)node.setAttribute("label",this.t(label));parent?.appendChild(node);return node; };
      const menu=make("menu","Style Custom",popup);menu.id="style-custom-itemmenu";state.nodes.push(menu);(state.menuNodes ||= []).push(menu);
      // A door that needs no paper selected: the Tools menu, beside ZotPoP's.
      const tools=doc.getElementById("menu_ToolsPopup");
      if(tools&&!doc.getElementById("style-custom-tools-item")){
        const entry=make("menu","Style Custom",tools);entry.id="style-custom-tools-item";state.nodes.push(entry);(state.menuNodes ||= []).push(entry);
        const sub=make("menupopup",null,entry);
        const door=(label,fn)=>{const node=make("menuitem",label,sub);node.addEventListener("command",()=>Promise.resolve().then(fn).catch(e=>{this.Z.logError(e);this.say(win,e.message);}));return node;};
        door("연구 작업 패널",()=>state.workbench?.toggle(true));
        door("설정…",()=>{const id=this.prefPane&&(this.prefPane.id||this.prefPane);if(typeof this.Z.Utilities?.Internal?.openPreferences==="function")this.Z.Utilities.Internal.openPreferences(id);else throw new Error("설정 창을 열 수 없습니다. Zotero 설정에서 Style Custom을 여세요.");});
      }
      const body=make("menupopup",null,menu);
      /* Every entry carries a small drawn sign, so a list of twenty verbs
         can be scanned by shape; the signs are the same strokes the panel's
         sidebar uses, inlined as data URIs because a menuitem takes an image
         URL and nothing else. */
      const ink=this.palette(doc).text||'#1c1c1e';
      const glyph=name=>{const shapes=this.MENU_ICONS[name];if(!shapes)return '';const body=shapes.map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')}/>`).join('');return 'data:image/svg+xml;utf8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="${ink}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);};
      /* A menu entry is a verb, not a sentence. What each one covers moves to
         the tooltip, so the menu stays the width of its longest verb. */
      const action=(label,callback,parent=body,icon='',hint='')=>{ const node=make("menuitem",label,parent);if(hint)node.setAttribute("tooltiptext",this.t(hint));if(icon&&this.MENU_ICONS[icon]){node.classList.add("menuitem-iconic");node.setAttribute("image",glyph(icon));}node.addEventListener("command",()=>Promise.resolve().then(callback).catch(e=>{this.Z.logError(e);this.say(win,e.message);}));return node; };
      const iconic=(node,icon)=>{if(node&&this.MENU_ICONS[icon]){node.classList.add(node.localName==="menu"?"menu-iconic":"menuitem-iconic");node.setAttribute("image",glyph(icon));}return node;};
      /* The parent entry sits among other plugins' entries, which carry signs;
         without one, Style Custom is the only unmarked line in the menu. */
      iconic(menu,"panel");iconic(doc.getElementById("style-custom-tools-item"),"panel");
      const statusItems={};
      for(const status of ["unread","reading","done"]) statusItems[status]=action(({unread:"안 읽음",reading:"읽는 중",done:"완료"})[status],()=>this.edit(this.selected(win),{status}),body,{unread:"circle",reading:"half",done:"disc"}[status]);
      /* The paper you are looking at is the best query you have. The search
         tab used to open empty and ask you to type in what was already on the
         row under the pointer. */
      action("ZotPoP에서 이 논문 검색",()=>{
        const items=this.selected(win);
        if(!items.length)throw new Error("문헌을 먼저 선택하세요.");
        const zotpop=this.Z.ZotPoP;
        if(!zotpop||typeof zotpop.openSearch!=='function')throw new Error("ZotPoP이 설치되어 있지 않습니다. 도구 → 부가 기능에서 설치한 뒤 다시 시도하세요.");
        const item=items[0], record=this.bibliographyRecord(item);
        const authors=(record.creators||[]).slice(0,2).map(c=>c.lastName||c.name).filter(Boolean).join(' ');
        zotpop.openSearch(win,{title:record.title||'',authors,year:record.year||'',doi:record.DOI||''});
      },body,"search");
      make("menuseparator",null,body);
      const ratings=make("menupopup",null,iconic(make("menu","별점",body),"star"));
      const ratingItems={};
      for(let rating=0;rating<=5;rating++)ratingItems[rating]=action(rating?"★".repeat(rating):"별점 지우기",()=>this.edit(this.selected(win),{rating}),ratings);
      make("menuseparator",null,body);
      // It marks and unmarks as well as downloads, so it is named for what it holds.
      const suppl=make("menupopup",null,iconic(make("menu","보충자료",body),"download"));
      action("선택한 파일을 보충자료로 표시",async()=>{
        const files=this.selectedAttachments(win);
        if(!files.length)throw new Error("첨부파일을 선택하세요.");
        const changed=await this.setSupplementary(files,true);
        this.say(win,`${changed}개를 보충자료로 표시했습니다.`);
      },suppl);
      action("보충자료 표시 해제",async()=>{
        const files=this.selectedAttachments(win);
        if(!files.length)throw new Error("첨부파일을 선택하세요.");
        const changed=await this.setSupplementary(files,false);
        this.say(win,`${changed}개의 표시를 해제했습니다.`);
      },suppl);
      make("menuseparator",null,suppl);
      action("먼저 세어만 보기",async()=>{
        const chosen=this.selected(win);
        const items=chosen.length?chosen:await this.libraryItems(win.ZoteroPane?.getSelectedLibraryID?.());
        const report=await this.previewSupplementary(items,
          {onProgress:(done,total)=>this.showBackfillProgress(win,'files',done,total)});
        this.say(win,
          `받을 수 있는 논문 ${report.available.length}편\n\n`
          +`이미 있음 ${report.already} · 식별자 없음 ${report.noIdentifier}\n`
          +`PMC에 없음 ${report.notFound+report.notArchived} · 보충자료 없음 ${report.noSupplement}\n`
          +`오픈액세스가 아니라 받을 수 없음 ${report.closed}`
          +(report.errors?`\n조회 실패 ${report.errors}`:""));
      },suppl,"","선택한 문헌(선택이 없으면 라이브러리 전체)의 받을 수 있는 논문이 몇 편인지만 세고, 내려받지는 않습니다.");
      for(const [label,pdfOnly,hint] of [["보충자료 PDF 받기",true,"선택한 문헌의 PMC 보충자료 중 PDF만 내려받아 첨부합니다."],["보충자료 모두 받기",false,"선택한 문헌의 PMC 보충자료를 형식 구분 없이 내려받아 첨부합니다."]])action(label,async()=>{
        const items=this.selected(win);
        if(!items.length)throw new Error("문헌을 먼저 선택하세요.");
        const result=await this.downloadSupplementary(items,{pdfOnly});
        this.say(win,
          `보충자료 ${result.added}개 추가 · 이미 있음 ${result.already} · 없음 ${result.none} · 미확인 ${result["not-found"]} · 실패 ${result.error}`
          +(result.failures.length?"\n\n"+result.failures.slice(0,5).join("\n"):""));
      },suppl,"",hint);
      const marks=make("menupopup",null,iconic(make("menu","색 표시",body),"palette"));
      for(const colour of this.highlightColours())action(colour.label,async()=>{
        const changed=await this.setHighlight(this.selected(win),colour.key);
        if(!changed)throw new Error("문헌을 먼저 선택하세요.");
      },marks);
      make("menuseparator",null,marks);
      action("색 지우기",async()=>{const n=await this.setHighlight(this.selected(win),null);this.say(win,`${n}개 문헌의 색을 지웠습니다.`);},marks);
      /* Seven entries acted on the whole library, not the paper under the
         pointer; among twenty-six lines nothing said which. They have a menu. */
      const upkeep=make("menupopup",null,iconic(make("menu","라이브러리 정리",body),"fill"));
      action("라이브러리 저널 지표 채우기",async()=>{
        const items=await this.libraryItems(win.ZoteroPane?.getSelectedLibraryID?.());
        const papers=items.filter(item=>this.isRegular(item));
        this.say(win,"저널 지표를 조회합니다. 저널마다 한 번만 조회하고 결과는 보관합니다.");
        const result=await this.refreshJournalCitedness(papers);
        const lines=[`저널 ${result.journals}종 중 ${result.found}종 지표 확인 · ${result.missing}종은 OpenAlex에도 없음`];
        if(result.failed) lines.push(`${result.failed}종 조회 실패`);
        if(result.budgetGone) lines.push(`OpenAlex 하루 한도를 다 썼습니다. ${result.remaining}종이 남았고, 한국 시간 오전 9시에 초기화됩니다.\n지금까지 받은 값은 저장했으니 내일 다시 실행하면 남은 것부터 이어서 채웁니다.`);
        else lines.push("공식 JIF가 있는 저널은 그대로 두고, 없는 저널만 ~추정치로 채웁니다.");
        this.say(win,lines.join("\n"));
      },upkeep,"journals","이 라이브러리의 저널마다 OpenAlex를 한 번 조회해, 공식 JIF가 없는 저널만 추정치로 채웁니다.");
      action("읽기 기록 가져오기",async()=>{
        const preview=await this.importLegacyReading({dryRun:true});
        if(!preview.imported){this.say(win,`가져올 읽기 기록이 없습니다. (노트 ${preview.notes}개 · 이미 보유 ${preview.skipped}개 · 대상 불명 ${preview.unresolved}개)`);return;}
        const hours=(preview.seconds/3600).toFixed(1);
        const result=await this.importLegacyReading();
        this.say(win,`읽기 기록 ${result.imported}편 · ${hours}시간을 가져왔습니다.\n이미 더 많이 기록된 ${result.skipped}편은 그대로 두었습니다.`+(result.unresolved?`\n대상 문헌을 찾지 못한 노트 ${result.unresolved}개`:""));
      },upkeep,"reading","이전 플러그인이 노트에 남긴 읽기 시간을 찾아 옮깁니다.");
      action("제목 앞 별 태그 정리",async()=>{
        const found=await this.starTagItems(win.ZoteroPane?.getSelectedLibraryID?.());
        if(!found.length){this.say(win,"정리할 별 태그가 없습니다.");return;}
        const {moved,skipped}=await this.migrateStarTags(found);
        this.say(win,`${moved}개 항목의 별 태그를 정리했습니다. 평점은 그대로 유지됩니다.`+(skipped?` · 편집할 수 없어 건너뜀 ${skipped}개`:""));
      },upkeep,"star","이 라이브러리 전체에서 ★ 태그를 별점으로 옮기고 태그를 지웁니다.");
      action("평점 태그를 Extra로 옮기기",async()=>{
        const found=await this.visibleRatingTagItems(win.ZoteroPane?.getSelectedLibraryID?.());
        if(!found.length){this.say(win,"태그로 남은 평점이 없습니다.");return;}
        const {fixed,skipped}=await this.hideRatingTags(found);
        const stray=await this.moveStrayRatingTags(win.ZoteroPane?.getSelectedLibraryID?.());
        const lines=[`${fixed}개 항목의 평점을 Extra의 "Rating: N"으로 옮기고 태그를 지웠습니다. 별점은 그대로입니다.`+(skipped?` · 편집할 수 없어 건너뜀 ${skipped}개`:"")];
        if(stray.moved||stray.alreadyRated)lines.push(`첨부파일에 붙어 있던 평점 ${stray.moved+stray.alreadyRated}개를 정리했습니다(${stray.moved}개는 본 문헌으로 옮김).`);
        if(stray.orphans)lines.push(`독립 첨부파일 ${stray.orphans}개는 본 문헌이 없어 태그를 그대로 두었습니다.`);
        lines.push("Extra는 동기화되고 직접 고칠 수 있으며, 태그 목록에는 나타나지 않습니다.");
        this.say(win,lines.join("\n"));
      },upkeep,"star",`이 라이브러리 전체에서 태그로 남은 평점을 Extra의 "Rating: N"으로 옮기고 태그를 지웁니다.`);
      make("menuseparator",null,body);
      // Reads as 인용 수 next to four other 인용 수 entries; the copy-citation dialog gets its own verb.
      action("인용문 복사…",()=>this.citationPanel(win,this.selected(win)),body,"quote","선택한 문헌을 APA·MLA·Vancouver 등 형식으로 만들어 복사합니다.");
      action("커스텀 열로 전환",()=>this.useColumns(win),upkeep,"columns","Zotero Style의 옛 열을 숨기고 이 플러그인의 열을 켭니다.");
      action("연구 작업 패널",()=>state.workbench?.toggle(true),body,"panel");
      action("관계 그래프 열기",()=>state.workbench?.show('graph'),body,"graph");
      /* The paper under the pointer is already the question. Both of these
         used to mean opening the panel, finding the tab and pressing 「현재
         선택 가져오기」 to hand it the paper that was selected all along. */
      action("이 논문의 관련 논문",()=>{
        if(this.selected(win).length!==1)throw new Error("관련 논문은 문헌 하나를 기준으로 찾습니다. 문헌을 하나만 선택하세요.");
        state.workbench?.show('related');
      },body,"related","이 논문을 인용한 논문, 이 논문이 인용한 문헌, 주제가 가까운 논문을 OpenAlex에서 찾습니다.");
      action("이 논문 책임저자 추적",()=>{
        if(this.selected(win).length!==1)throw new Error("책임저자는 문헌 하나에서 찾습니다. 문헌을 하나만 선택하세요.");
        state.workbench?.show('authors','pi');
      },body,"authors","마지막에 이름을 올린 저자를 이 논문의 책임저자로 보고, 그 사람의 최근 논문·소속 이동·특허를 엽니다.");
      /* Deep collection trees hid every folder a search result sat in behind
         a sidebar click. One paper, so the submenu names collections that
         belong to it; several selected or a child row have none to offer. */
      const filedMenu=make("menu","컬렉션으로 이동",body);iconic(filedMenu,"collections");
      const filedPopup=make("menupopup",null,filedMenu);
      make("menuseparator",null,body);
      body.addEventListener("popupshowing",()=>{
        /* Greyed means "already so" -- for every selected paper, not the first:
           with twenty selected and the first already read, "완료" was greyed
           and the other nineteen could not be marked. */
        try{
          const chosen=this.selected(win);
          for(const [status,node] of Object.entries(statusItems))node.disabled=this.alreadySo(chosen,'status',status);
          for(const [rating,node] of Object.entries(ratingItems))node.disabled=this.alreadySo(chosen,'rating',rating);
          stopItem.hidden=!this.citationJob;
          // this.selected() already drops child rows, so one paper here means
          // one regular item was under the pointer, never an attachment.
          filedMenu.hidden=chosen.length!==1;
          if(chosen.length===1){
            const paper=chosen[0],entries=this.collectionEntries(paper);
            filedPopup.replaceChildren();
            if(!entries.length){const empty=make("menuitem","들어 있는 컬렉션 없음",filedPopup);empty.disabled=true;}
            else for(const{id,path}of entries){
              const entry=make("menuitem",path,filedPopup);
              entry.addEventListener("command",()=>Promise.resolve().then(async()=>{
                await win.ZoteroPane.collectionsView.selectCollection(Number(id));
                win.ZoteroPane.selectItem(paper.id);
              }).catch(e=>{this.Z.logError(e);this.say(win,e.message);}));
            }
          }
        }catch(error){this.Z.logError(error);}
      });
      action("지표·읽기 기록 새로고침",async()=>{state.signature=null;await this.refreshWindows();await this.flush();},body,"refresh","저장된 값을 다시 읽어 열을 새로 그립니다. 네트워크는 쓰지 않습니다.");
      action("선택한 문헌 인용 수 새로고침",async()=>{
        const result=await this.refreshCitations(this.selected(win),{force:true});
        this.say(win,`인용 수 확인 ${result.ok}개 · 미확인 ${result["not-found"]}개 · 식별자 부족 ${result.unsupported}개 · 조회 오류 ${result.error}개${result.cancelled?" · 중지됨":""}`);
      },body,"citations","선택한 문헌의 인용 수를 OpenAlex에서 다시 가져옵니다.");
      const stopItem=action("인용 수 조회 중지",()=>{if(!this.citationJob)throw new Error("진행 중인 인용 수 조회가 없습니다. 중지할 것이 없습니다.");this.citationJob.controller.abort();this.say(win,"인용 수 조회를 중지했습니다. 지금까지 받은 값은 저장했습니다.");},body,"stop");
      action("첨부파일 종류 판별",async()=>{
        const chosen=this.selected(win);
        const items=chosen.length?chosen:await this.libraryItems(win.ZoteroPane?.getSelectedLibraryID?.());
        const result=await this.scanAttachmentKinds(items,
          {onProgress:(done,total)=>this.showBackfillProgress(win,'files',done,total)});
        this.say(win,
          `문헌 ${result.items}개 · PDF ${result.files}개를 첫 페이지로 판별했습니다.\n`
          +`본문 ${result.article} · 보충자료 ${result.supplementary} · 중복 ${result.duplicate} · 다른 논문 ${result.foreign}`
          +(result.unknown?` · 판단 불가 ${result.unknown}`:"")
          +(result.indexed?`\n본문이 없던 ${result.indexed}개는 Zotero가 먼저 본문을 읽어 두었습니다.`:"")
          +(result.unread?`\n${result.unread}개는 색인을 만든 뒤에도 본문을 읽지 못했습니다(스캔 PDF일 수 있습니다).`:""));
      },body,"attachments","선택한 문헌(선택이 없으면 라이브러리 전체)의 PDF를 첫 페이지로 읽어 본문·보충자료·중복·다른 논문으로 나눕니다.");
      action("빈 칸 채우기",async()=>{
        if(this.backfilling){this.stopBackfill();this.say(win,"채우기를 중지했습니다. 지금까지 받은 값은 저장했습니다.");return;}
        const report=await this.runBackfill({libraryID:win.ZoteroPane?.getSelectedLibraryID?.(),
          onProgress:({stage,done,total})=>this.showBackfillProgress(win,stage,done,total)});
        this.say(win,this.backfillSummary(report));
      },upkeep,"fill","철회 신호·저널 지표·관심 저자의 새 논문을 한 번에 채웁니다.");
      action("철회·공개접근 확인",async()=>{
        const result=await this.refreshPaperSignals(this.selected(win));
        this.say(win,`신호 확인 ${result.ok}개 · 미확인 ${result["not-found"]}개 · DOI 없음 ${result.unsupported}개 · 조회 오류 ${result.error}개`);
      },body,"signal","선택한 문헌이 철회됐는지, 공개접근본이 있는지 확인합니다.");
      action("라이브러리 전체 인용 수 조회",async()=>{const r=await this.syncLibraryCitations(win.ZoteroPane.getSelectedLibraryID?.()||this.Z.Libraries.userLibraryID);this.say(win,r.cancelled?`인용 수 저장 ${r.saved||0}개 · 확인 불가 ${r.unavailable||0}개 · 중지됨`:`인용 수 저장 ${r.saved||0}개 · 확인 불가 ${r.unavailable||0}개`);},upkeep,"citations","이 라이브러리의 모든 문헌에 인용 수를 채우고 Extra에 기록합니다.");
      action("저널 IF 공식 값 새로고침",async()=>{
        const result = await this.refreshJournalMetrics(this.selected(win), win.DOMParser);
        this.say(win,`IF 확인 ${result.updated}개 · 조회 실패 ${result.failed}개 · 미등록 저널 ${result.unknown}개. 기존 확인된 값은 유지됩니다.`);
      },body,"journals","선택한 문헌의 저널 중 출판사 페이지 수치(86종)가 있는 저널만 그 페이지에서 다시 읽습니다. JCR 내보내기와 OpenAlex 값은 바뀌지 않습니다.");
    }
  }
  rebuildMenus() {
    for (const [win, state] of this.windows) {
      if (win.closed) continue;
      try {
        for (const node of (state.menuNodes || []).splice(0)) { try { node.remove(); } catch (_) {} state.nodes = state.nodes.filter(entry => entry !== node); }
        this.buildMenus(win, state);
      } catch (error) { this.Z.logError(error); }
    }
  }
  addWindow(win) {
    if (!this.active || this.stopping || this.windows.has(win)) return;
    const state = { nodes:[], listeners:[], signature:null,titleNodes:new Set(),titlePositions:new Map(),titleWeights:new Map() }; this.windows.set(win,state);
    const unload = () => {this.removeWindow(win).catch(error=>this.Z.logError(error));};
    win.addEventListener("unload", unload, { once: true });
    state.listeners.push([win, "unload", unload]);
    this.attachMotion(win,state);
    this.attachColumnFit(win,state);
    try{this.attachCells(win,state);}catch(error){this.Z.logError(error);}
    this.watchItemPane(win,state);
    state.readerCleanup=this.readerTools.attach(win);
    for(const tab of this.readerTools.tabs(win))if(tab.itemID)this.tabItems.set(tab.id,tab.itemID);
    state.workbench=this.Workbench.attach(win,{runtime:this,library:this.Library.create({Zotero:this.Z,runtime:this}),reader:this.readerTools,model:this.workspaceTools,assist:this.assist});
    const doc = win.document;
    state.menuNodes = [];
    this.buildMenus(win, state);
    const poll = async () => {
      if (!this.active || win.closed || state.polling) return;
      state.polling = true;
      try {
        const view=win.ZoteroPane?.itemsView;
        const rows=[...doc.querySelectorAll("#zotero-items-tree .row")];
        const records=rows.map(row=>view?.getRow(Number(row.id.match(/-row-(\d+)$/)?.[1]))?.ref).filter(item=>this.isRegular(item));
        /* Reading time and the last-read stamp change every second a paper is
           open; their cells are repainted in place (refreshReadingDisplays).
           Counted here, they rebuilt the whole list every five seconds, and the
           flush beside them rewrote the store as often. */
        const signature=JSON.stringify(records.map(item=>{const {seconds,lastRead,...rest}=this.state(item);return [this.identity(item),rest];}));
        if(state.signature!==null && signature!==state.signature) await view?.refreshAndMaintainSelection();
        state.signature=signature;this.enhanceTitles(win,state,records); if(this.dirty)this.scheduleFlush(30000);
        if(this.featureEnabled("citedCountColumn")&&this.pref("autoCitations",true)&&!this.citationJob&&!this.stopping) {
          // Without a key, OpenAlex list requests come out of a budget of about
          // ten a day shared with ZotPoP's searches; the background job waits
          // for a key rather than spending them before the user has searched once.
          if(this.openAlexKey())this.refreshCitations(records,{background:true}).catch(error=>this.Z.logError(error));
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
      if (!this.active) throw new Error(this.text("Plugin is disabled.", "플러그인이 꺼져 있습니다. 도구 → 부가 기능에서 Style Custom을 켜세요."));
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
            let extra = null;
            if (Object.prototype.hasOwnProperty.call(change, 'rating')) {
              const before = String(item.getField('extra') || '');
              const after = this.model.updateExtra(before, {rating: change.rating});
              if (after !== before) { item.setField('extra', after); extra = after; }
            }
            // Capture Zotero's normalized representation, not our input order.
            touched.push({ item, written: item.getTags(), extra });
            await item.save();
          }
        });
      }
      catch (error) {
        // The DB transaction rolls back persisted tags, but previous saves may
        // already have updated cached Items. Reload only after the rollback ends.
        for (const { item, written, extra } of touched) {
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
            /* The rating lives in Extra, and the rollback undid that too: an
               earlier paper's cached Extra still said the new rating. Reloaded
               only while it still holds what this edit wrote, so an Extra edit
               made meanwhile by someone else is not thrown away. */
            const extraToo = extra != null && String(item.getField("extra") || "") === extra;
            if (extraToo) item._clearChanged("itemData");
            await item.reload(["primaryData", "tags", ...(extraToo ? ["itemData"] : [])], true);
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
    cleanup(()=>state.itemPaneObserver?.disconnect());
    cleanup(()=>state.rollCleanup?.());cleanup(()=>state.cellsCleanup?.());
    for(const row of win.document.querySelectorAll('#zotero-item-pane .meta-row[style*="min-height"]'))cleanup(()=>row.style.removeProperty('min-height'));
    for(const node of state.titleNodes||[])cleanup(()=>node.remove());
    for(const[cell,position]of state.titlePositions||[])cleanup(()=>{if(cell.style.position==='relative'){if(position)cell.style.position=position;else cell.style.removeProperty('position');}});
    for(const[node,weight]of state.titleWeights||[])cleanup(()=>{if(node.style.fontWeight==='700')node.style.fontWeight=weight;});
    for(const[node,[color,weight]]of state.venueColors||[])cleanup(()=>{node.style.color=color;node.style.fontWeight=weight;delete node.dataset.styleCustomVenue;});
    for(const[target,name,callback,capture]of state.listeners||[])cleanup(()=>target.removeEventListener(name,callback,capture||false));
    for(const node of state.nodes||[])cleanup(()=>node.remove());
    cleanup(()=>state.readingCleanup?.());
    await Promise.all(pending);
    if(errors.length)throw errors[0];
  }
  async stop({keepColumns=false}={}) {
    if(this.stopPromise)return this.stopPromise;
    this.stopping=true;
    try { this.updater?.stop(); } catch (ignored) {}
    this.stopPromise=(async()=>{
      const errors=[];
      const attempt=async fn=>{try{await fn();}catch(error){errors.push(error);}};
      await attempt(()=>this.assist.stop());await attempt(()=>this.readerAssist.stop());await attempt(()=>this.readerTools.stop());
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
      // Unregistering a column while Zotero quits deletes its saved width and
      // order from treePrefs.json; on quit the columns stay and Zotero drops them
      // itself with the plugin.
      if(!keepColumns)for(const column of this.columns.splice(0))await attempt(()=>this.Z.ItemTreeManager.unregisterColumn(column));
      if(this.prefPane){const pane=this.prefPane;this.prefPane=null;await attempt(()=>this.Z.PreferencePanes.unregister(pane));}
      this.tabItems.clear();
      if(errors.length){for(const error of errors.slice(1))this.Z.logError(error);throw errors[0];}
    })();
    return this.stopPromise;
  }

};
if(typeof module!=="undefined")module.exports=CustomStyleRuntime;
