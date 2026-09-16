import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Model = require('../src/data.js');
const Runtime = require('../src/runtime.js');

function fixture() {
  const records = new Map();
  const columns = new Map();
  const prefs = new Map();
  const observers = new Map();
  const errors = [];
  let prefCounter = 0;
  const Z = {
    locale: 'ko-KR', debug() {}, logError: error => errors.push(error),
    Libraries: { get: id => ({ editable: id !== 2, libraryType: id === 3 ? 'feed' : 'user' }) },
    ItemTreeManager: {
      registerColumn(options) { assert.equal(typeof options.width, 'string'); const key = 'namespaced-' + options.dataKey; columns.set(key, options); return key; },
      unregisterColumn: key => columns.delete(key), refreshColumns() {}
    },
    PreferencePanes: { register: async () => 'pane-id', unregister(id) { assert.equal(id, 'pane-id'); } },
    Prefs: {
      get: name => prefs.get(name),
      registerObserver: (name, handler) => { const key = ++prefCounter; observers.set(key, { name, handler }); return key; },
      unregisterObserver: key => observers.delete(key),
      set(name, value) { prefs.set(name, value); for (const observer of observers.values()) if (observer.name === name) observer.handler(); }
    },
    DB: {
      async executeTransaction(fn) {
        const original = structuredClone(records);
        try { await fn(); }
        catch (error) { records.clear(); for (const [id, tags] of original) records.set(id, tags); throw error; }
      }
    }
  };
  function item(id, { libraryID = 1, tags = [{ tag: '#method/CRISPR', type: 1 }], fail = false } = {}) {
    records.set(id, structuredClone(tags));
    return {
      id, libraryID, key: String(id), getField: () => "", tags: structuredClone(tags), reloadCount: 0, pendingTags: null,
      isRegularItem: () => true, isEditable: () => libraryID !== 2,
      hasChanged() { return this.pendingTags !== null; },
      getTags() { return structuredClone(this.pendingTags ?? this.tags); },
      setTags(tags) { this.pendingTags = structuredClone(tags); },
      _clearChanged(field) { assert.equal(field, 'tags'); this.pendingTags = null; },
      async save() { if (fail) throw new Error('injected disk failure'); this.tags = structuredClone(this.pendingTags ?? this.tags); this.pendingTags = null; records.set(id, structuredClone(this.tags)); },
      async reload() { this.reloadCount++; this.tags = structuredClone(records.get(id)); }
    };
  }
  const plugin = new Runtime({ Zotero: Z, model: Model, marquee: { attach: () => () => {} }, reading: { attach: () => () => {} }, storage: { read: async () => ({schema:1,items:{}}), write: async () => {} } });
  return { Z, plugin, item, records, columns, observers, errors };
}

test('startup registers typed, namespaced columns and stop removes all registrations', async () => {
  const { plugin, columns, observers } = fixture();
  await plugin.start({ id: 'test@focus', version: '0.1', rootURI: 'file:///focus/' });
  assert.equal(columns.size, 19);
  assert.equal(observers.size, 7);
  await plugin.stop();
  assert.equal(columns.size, 0);
  assert.equal(observers.size, 0);
  await plugin.stop();
});

test('bulk changes persist, preserve unrelated tags, and serial rapid actions compose', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const items = [item(1), item(2)];
  await Promise.all([plugin.edit(items, { status: 'reading' }), plugin.edit(items, { rating: 4 })]);
  for (const value of records.values()) {
    assert.deepEqual(Model.readState(value), { status: 'reading', rating: 4 });
    assert.deepEqual(value[0], { tag: '#method/CRISPR', type: 1 });
  }
  await plugin.edit(items, { status: 'unread', rating: 0 });
  for (const value of records.values()) assert.deepEqual(Model.readState(value), {status:'unread',rating:0});
});

test('read-only and feed items reject the entire batch before any write', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const good = item(1);
  for (const libraryID of [2, 3]) {
    const locked = item(2, { libraryID });
    await assert.rejects(plugin.edit([good, locked], { rating: 5 }), /편집/);
    assert.deepEqual(records.get(1), [{ tag: '#method/CRISPR', type: 1 }]);
  }
});

test('failed second save rolls back storage and reloads every touched cached item', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const first = item(1);
  const second = item(2, { fail: true });
  await assert.rejects(plugin.edit([first, second], { status: 'done' }), /disk failure/);
  for (const it of [first, second]) {
    assert.deepEqual(it.tags, [{ tag: '#method/CRISPR', type: 1 }]);
    assert.deepEqual(records.get(it.id), it.tags);
    assert.equal(it.reloadCount, 1);
    assert.equal(it.pendingTags, null);
  }
  // A failed edit must not poison the serialized queue.
  await plugin.edit([first], { rating: 2 });
  assert.equal(Model.readState(first.tags).rating, 2);
});

test('preexisting unsaved item changes are not committed by a Focus action', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const reference = item(1);
  reference.setTags([{ tag: 'pending manual edit', type: 0 }]);
  await assert.rejects(plugin.edit([reference], { rating: 5 }), /다른 변경/);
  assert.deepEqual(reference.getTags(), [{ tag: 'pending manual edit', type: 0 }]);
  assert.deepEqual(records.get(1), [{ tag: '#method/CRISPR', type: 1 }]);
});

test('an item that becomes dirty while awaiting a transaction is left untouched', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const first = item(1), second = item(2);
  const saveFirst = first.save.bind(first);
  first.save = async () => {
    await saveFirst();
    second.setTags([{ tag: 'concurrent pending edit', type: 0 }]);
  };
  await assert.rejects(plugin.edit([first, second], { status: 'done' }), /다른 변경/);
  assert.deepEqual(first.getTags(), [{ tag: '#method/CRISPR', type: 1 }]);
  assert.deepEqual(second.getTags(), [{ tag: 'concurrent pending edit', type: 0 }]);
  assert.deepEqual(records.get(2), [{ tag: '#method/CRISPR', type: 1 }]);
});

test('rollback preserves a concurrent tag edit on a previously saved item without committing it', async () => {
  const { plugin, item, records } = fixture();
  plugin.active = true;
  const first = item(1), second = item(2);
  second.save = async () => {
    first.setTags([...first.getTags(), { tag: 'user-added-during-save', type: 0 }]);
    throw new Error('interleaved failure');
  };
  await assert.rejects(plugin.edit([first, second], { status: 'done' }), /interleaved/);
  assert.deepEqual(records.get(1), [{ tag: '#method/CRISPR', type: 1 }]);
  assert.deepEqual(first.getTags(), [{ tag: '#method/CRISPR', type: 1 }, { tag: 'user-added-during-save', type: 0 }]);
  assert.deepEqual(Model.readState(first.getTags()), { status: 'unread', rating: 0 });
  assert.equal(first.hasChanged(), true);
});

test('invalid patch and disabled plugin cannot write data', async () => {
  const { plugin, item, records } = fixture();
  const reference = item(1);
  await assert.rejects(plugin.edit([reference], { rating: 3 }), /비활성/);
  plugin.active = true;
  await assert.rejects(plugin.edit([reference], { rating: 6 }), /Rating/);
  assert.deepEqual(records.get(1), [{ tag: '#method/CRISPR', type: 1 }]);
  await assert.rejects(plugin.edit([], { rating: 1 }), /선택/);
});


test('time-derived status preserves done and persists independent legacy snapshots', async () => {
 const {plugin, Z, item} = fixture(); Z.Libraries.userLibraryID = 1;
 plugin.active = true;
 const reference = item(42, {tags:[{tag:'/unread',type:0}]});
 plugin.legacy = {'42':{readingTime:{data:{0:120}},citedCount:{'Total(DOI)':2112}}, Science:{rank:{sciif:'47.3'}}};
 reference.getField = field => field === 'publicationTitle' ? 'Science' : '';
 assert.equal(plugin.state(reference).status,'reading');
 assert.equal(plugin.metrics(reference).impactFactor,47.3);
 assert.equal(plugin.metrics(reference).citations,2112);
 plugin.entry(reference).seconds = plugin.metrics(reference).seconds;
 await plugin.addReading(reference, 5);
 assert.equal(plugin.metrics(reference).seconds,125);
 await plugin.edit([reference],{status:'done'});
 await plugin.addReading(reference,5);
 assert.equal(plugin.state(reference).status,'done');
 const saved = JSON.parse(JSON.stringify(plugin.cache));
 plugin.legacy={}; plugin.cache=saved;
 assert.equal(plugin.metrics(reference).seconds,130);
 assert.equal(plugin.metrics(reference).impactFactor,47.3);
 assert.equal(plugin.metrics(reference).citations,2112);
});
test('same item key in different libraries does not import ambiguous legacy counts',()=>{
 const {plugin,item,Z}=fixture(); Z.Libraries.userLibraryID=1;
 plugin.active=true; plugin.legacy={'42':{citedCount:{'Total(DOI)':99},readingTime:{data:{0:120}}}};
 assert.equal(plugin.metrics(item(42,{libraryID:2})).citations,null);
 assert.equal(plugin.metrics(item(42,{libraryID:2})).seconds,0);
});
test('cache write failure remains dirty and can be retried',async()=>{
 const {plugin}=fixture(); let count=0;
 plugin.storage.write=async()=>{if(!count++)throw new Error('disk full');};
 plugin.dirty=true;
 await assert.rejects(plugin.flush(),/disk full/);
 assert.equal(plugin.dirty,true); await plugin.flush(); assert.equal(plugin.dirty,false);
});

test('verified catalog overrides undated legacy IF and clears IF when the journal changes', async()=>{
 const {plugin,item}=fixture(); plugin.active=true;
 plugin.catalog=[{title:'Nature',aliases:[],issns:[],impactFactor:56.1,year:2025,checkedAt:'2026-09-13',sourceURL:'https://www.nature.com/nature/journal-impact',evidence:'Verified JIF'}];
 plugin.rebuildJournals();
 const reference=item(7);let journal='Nature';reference.getField=k=>k==='publicationTitle'?journal:'';
 plugin.legacy={Nature:{rank:{sciif:'50'}}};
 assert.equal(plugin.metrics(reference).impactFactor,56.1);
 assert.match(plugin.metrics(reference).impactSource,/JIF 2025/);
 journal='Unrelated Journal';assert.equal(plugin.metrics(reference).impactFactor,null);
});
test('publisher refresh updates valid metrics, keeps cached values on failures and deduplicates page requests',async()=>{
 const {plugin,item,Z}=fixture(); const {DOMParser}=await import('linkedom');plugin.active=true;
 const record={title:'Nature',aliases:[],issns:[],impactFactor:50,year:2024,checkedAt:'2025-09-13',sourceURL:'https://www.nature.com/nature/journal-impact',evidence:'Verified JIF'};
 plugin.catalog=[record];plugin.rebuildJournals();
 const first=item(1),second=item(2);for(const ref of [first,second])ref.getField=k=>k==='publicationTitle'?'Nature':'';
 let calls=0;Z.HTTP={request:async()=>{calls++;return {responseText:'<html><head><title>Journal Metrics | Nature</title></head><body>Journal Impact Factor: 56.1 (2025)</body></html>'};}};
 assert.deepEqual(await plugin.refreshJournalMetrics([first,second],DOMParser),{updated:1,failed:0,unknown:0});
 assert.equal(calls,1);assert.equal(plugin.metrics(first).impactFactor,56.1);
 Z.HTTP.request=async()=>{throw new Error('503');};
 assert.equal((await plugin.refreshJournalMetrics([first],DOMParser)).failed,1);
 assert.equal(plugin.metrics(first).impactFactor,56.1);
});

test('numeric-string legacy totals become visible without source or date invention',()=>{
 const {plugin,item,Z}=fixture();Z.Libraries.userLibraryID=1;
 plugin.legacy={'1':{citedCount:{'Total(DOI)':'123','Highly Influential':456}}};
 const ref=item(1);assert.equal(plugin.metrics(ref).citations,123);
 assert.equal(plugin.metrics(ref).citationSource,'Style cache: Total(DOI)');
});
function citationItem(item,id,doi='10.1234/fixture'){
 const reference=item(id);reference.fields={DOI:doi,title:'Precisely identified research paper',date:'2025-01-01',extra:'Citations: 999 (Old source, 2020-01-01)'};
 reference.getField=k=>reference.fields[k]||'';reference.getCreators=()=>[{creatorTypeID:1,lastName:'Liu'}];return reference;
}
test('fresh verified zero outranks stale Extra, errors preserve it and cached attempts avoid repeated requests',async()=>{
 const {plugin,item,Z}=fixture();plugin.active=true;const ref=citationItem(item,1);let calls=0,fail=false;
 Z.HTTP={request:async()=>{calls++;if(fail)throw Object.assign(Error('blocked'),{status:403});return {response:{results:[{doi:'https://doi.org/10.1234/fixture',cited_by_count:0}]}};}};
 const success=await plugin.refreshCitations([ref],{force:true});assert.equal(success.ok,1);
 assert.equal(plugin.metrics(ref).citations,0);assert.equal(plugin.metrics(ref).citationSource,'OpenAlex');assert.ok(plugin.metrics(ref).citationCheckedAt);
 const saved=JSON.parse(JSON.stringify(plugin.cache));plugin.cache=saved;
 assert.equal((await plugin.refreshCitations([ref])).skipped,1);assert.equal(calls,1);
 fail=true;const error=await plugin.refreshCitations([ref],{force:true});assert.equal(error.error,1);
 assert.equal(plugin.metrics(ref).citations,0);assert.equal(plugin.entry(ref).citationAttempt.status,'error');assert.equal(plugin.citationDue(ref),false);
});
test('DOI edits while a request runs cannot attach the old paper citation count',async()=>{
 const {plugin,item,Z}=fixture();plugin.active=true;const ref=citationItem(item,1);ref.fields.extra='';
 let deliver,started;const ready=new Promise(r=>started=r);
 Z.HTTP={request:()=>{started();return new Promise(resolve=>deliver=resolve);}};
 const pending=plugin.refreshCitations([ref],{force:true});await ready;
 ref.fields.DOI='10.1234/different';deliver({response:{results:[{doi:'https://doi.org/10.1234/fixture',cited_by_count:87}]}});
 await pending;assert.equal(plugin.metrics(ref).citations,null);assert.equal(plugin.entry(ref).citationLookup,undefined);
});
test('manual abort invokes Zotero HTTP canceller and does not turn unknown into zero',async()=>{
 const {plugin,item,Z}=fixture();plugin.active=true;const ref=citationItem(item,1);ref.fields.extra='';let cancelled=0,started;
 const ready=new Promise(r=>started=r);
 Z.HTTP={request:(_method,_url,options)=>{options.cancellerReceiver(()=>cancelled++);started();return new Promise(()=>{});}};
 const pending=plugin.refreshCitations([ref],{force:true});await ready;plugin.citationJob.controller.abort();
 const result=await pending;assert.equal(result.cancelled,true);assert.equal(cancelled,1);assert.equal(plugin.metrics(ref).citations,null);assert.equal(plugin.citationJob,null);assert.equal(plugin.entry(ref).citationPending,undefined);
});
test('invalid explicit DOI is preserved for a visible unsupported result rather than title substitution',()=>{
 const {plugin,item}=fixture();const ref=citationItem(item,1,'invalid DOI');
 assert.equal(plugin.citationRecord(ref).doi,'invalid DOI');
});

test('legacy citation identity remains invalidated across repeated renders and cache reloads',()=>{
 const {plugin,item,Z}=fixture();Z.Libraries.userLibraryID=1;
 const ref=citationItem(item,1);ref.fields.extra='';plugin.legacy={'1':{citedCount:{'Total(DOI)':'105'}}};
 assert.equal(plugin.metrics(ref).citations,105);ref.fields.DOI='10.1234/new-paper';
 assert.equal(plugin.metrics(ref).citations,null);assert.equal(plugin.metrics(ref).citations,null);
 plugin.cache=JSON.parse(JSON.stringify(plugin.cache));assert.equal(plugin.metrics(ref).citations,null);
 ref.fields.DOI='10.1234/fixture';assert.equal(plugin.metrics(ref).citations,105);
});
test('HTTP transport disables Zotero unbounded retries and manually surfaces HTTP status',async()=>{
 const {plugin,Z}=fixture();const controller=new AbortController();
 Z.HTTP={request:async(_method,_url,options)=>{
   assert.equal(options.successCodes,false);assert.equal(options.errorDelayMax,0);assert.equal(options.timeout,15000);
   return {status:503,getResponseHeader:()=> '2',response:{}};
 }};
 await assert.rejects(plugin.citationHTTP(controller.signal).getJSON('https://api.openalex.org/works'),error=>error.status===503&&error.retryAfter==='2');
 Z.HTTP.request=async()=>null;
 await assert.rejects(plugin.citationHTTP(controller.signal).getJSON('https://api.openalex.org/works'),TypeError);
});

test('title fallback reads Zotero creator type IDs through the registry, not a hardcoded numeric ID',()=>{
 const {plugin,item,Z}=fixture();Z.CreatorTypes={getID:type=>{assert.equal(type,'author');return 8;}};
 const ref=citationItem(item,1,'');ref.getCreators=()=>[{creatorTypeID:10,lastName:'Editor'},{creatorTypeID:8,lastName:'Actual Author'}];
 assert.equal(plugin.citationRecord(ref).firstAuthor,'Actual Author');
 ref.fields.DOI='10.1234/fixture';assert.equal(plugin.citationRecord(ref).firstAuthor,'');
});

test('enriching a missing author preserves an existing same-title legacy total while requiring new title verification',()=>{
 const {plugin,item,Z}=fixture();Z.Libraries.userLibraryID=1;Z.CreatorTypes={getID:()=>8};
 const ref=citationItem(item,1,'');ref.fields.extra='';ref.getCreators=()=>[];
 plugin.legacy={'1':{citedCount:{'Total(DOI)':'9'}}};assert.equal(plugin.metrics(ref).citations,9);
 ref.getCreators=()=>[{creatorTypeID:8,lastName:'Author'}];assert.equal(plugin.metrics(ref).citations,9);
 assert.equal(plugin.citationDue(ref),true);ref.fields.title='A completely different research title';assert.equal(plugin.metrics(ref).citations,null);
});

test('automatic metadata writes preserve unrelated Extra, verified zero and own notifier marker without repeat saves',async()=>{
 const {plugin,item}=fixture();plugin.active=true;const ref=citationItem(item,1);ref.fields.extra='PMID: 123\nNotes: keep this\nCitations: 999 (Old source, 2020-01-01)';
 let saves=0;ref.setField=(k,v)=>ref.fields[k]=v;ref.saveTx=async options=>{saves++;assert.equal(options.notifierData.styleCustomCitations,true);assert.equal(options.skipSelect,true);};
 const result={status:'ok',count:0,source:'OpenAlex',checkedAt:new Date().toISOString(),identity:plugin.citationTools.identity(plugin.citationRecord(ref))};
 assert.equal(await plugin.persistCitation(ref,result),true);assert.match(ref.fields.extra,/PMID: 123\nNotes: keep this\nCitations: 0 \(OpenAlex,/);
 assert.equal(await plugin.persistCitation(ref,result),false);assert.equal(saves,1);
 ref.fields.DOI='10.1234/new-paper';assert.equal(plugin.metrics(ref).citations,null);assert.equal(plugin.metrics(ref).citations,null);
});
test('dirty Extra is not overwritten and the cached verified result can be saved after user edits settle',async()=>{
 const {plugin,item}=fixture();plugin.active=true;const ref=citationItem(item,1);let dirty=true,saves=0;
 ref.hasChanged=()=>dirty;ref.setField=(k,v)=>ref.fields[k]=v;ref.saveTx=async()=>saves++;
 const result={status:'ok',count:7,source:'Crossref',checkedAt:new Date().toISOString(),identity:plugin.citationTools.identity(plugin.citationRecord(ref))};
 assert.equal(await plugin.persistCitation(ref,result),false);assert.equal(saves,0);
 dirty=false;ref.fields.extra='User note';assert.equal(await plugin.persistCitation(ref,result),true);assert.match(ref.fields.extra,/^User note\nCitations: 7/);assert.equal(saves,1);
});
test('metadata notifications coalesce, return immediately, ignore own saves and persist fresh cache without a new lookup',async()=>{
 const {plugin,item,Z}=fixture();let observer,timer;const ref=citationItem(item,1);let saves=0,lookups=0;
 ref.setField=(k,v)=>ref.fields[k]=v;ref.saveTx=async()=>saves++;
 Z.Items={getAsync:async()=>ref};Z.getMainWindow=()=>({setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{}});
 Z.Notifier={registerObserver:o=>{observer=o;return 'observer';},unregisterObserver:()=>{}};
 await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
 plugin.refreshCitations=async()=>{lookups++;};
 plugin.entry(ref).citationLookup={status:'ok',count:19,source:'OpenAlex',checkedAt:new Date().toISOString(),identity:plugin.citationTools.identity(plugin.citationRecord(ref))};
 assert.equal(observer.notify('add','item',[1],{}),undefined);observer.notify('modify','item',[1],{});
 await timer();await plugin.metadataQueue;assert.equal(lookups,1);assert.equal(saves,1);
 timer=null;observer.notify('modify','item',[1],{1:{styleCustomCitations:true}});assert.equal(timer,null);
 await plugin.stop();
});
test('startup clears persisted in-flight markers left by a previous interrupted session',async()=>{
 const {plugin}=fixture();plugin.storage.read=async()=>({schema:1,items:{'1:key':{citationPending:'old'}}});
 await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
 assert.equal(plugin.cache.items['1:key'].citationPending,undefined);await plugin.stop();
});

test('page tracking keeps separate PDF attachments and progress never opens an unrelated PDF',async()=>{
 const {plugin,item}=fixture();plugin.active=true;const ref=item(42);
 await plugin.addReading(ref,5,{attachmentID:100,pageIndex:0,totalPages:10});
 await plugin.addReading(ref,7,{attachmentID:200,pageIndex:1,totalPages:3});
 assert.deepEqual(plugin.pageProgress(ref,100),{total:10,visited:1,percent:10,pages:{0:5},attachmentID:100});
 assert.deepEqual(plugin.pageProgress(ref),{total:3,visited:1,percent:33,pages:{1:7},attachmentID:200});
 assert.equal(plugin.metrics(ref).seconds,12);assert.ok(plugin.entry(ref).lastRead);
 const before=JSON.stringify(plugin.entry(ref).readingAttachments);await plugin.addReading(ref,1,{attachmentID:200,pageIndex:50,totalPages:3});assert.equal(JSON.stringify(plugin.entry(ref).readingAttachments),before);
});
test('legacy unbound progress is not assigned to a PDF or another library',()=>{
 const {plugin,item,Z}=fixture();Z.Libraries.userLibraryID=1;plugin.legacy={'1':{readingTime:{page:5,data:{0:30}}}};
 assert.equal(plugin.pageProgress(item(1)).attachmentID,null);assert.equal(plugin.pageProgress(item(1)).visited,1);
 assert.equal(plugin.pageProgress(item(1),99).visited,0);assert.equal(plugin.pageProgress(item(1,{libraryID:2})).visited,0);
});
test('custom columns are validated and registration failure keeps previous fields intact',async()=>{
 const {plugin,Z,columns,item}=fixture();await plugin.start({id:'custom',version:'0.5',rootURI:'file:///custom/'});
 Z.ItemFields={getID:name=>['volume','issue','pages'].includes(name)};plugin.setCustomFields('volume, issue');assert.equal(columns.size,21);
 const original=Z.ItemTreeManager.registerColumn;Z.ItemTreeManager.registerColumn=options=>options.dataKey==='field-pages'?false:original(options);
 assert.throws(()=>plugin.setCustomFields('volume, pages'));assert.equal(columns.size,21);assert.ok(plugin.dynamicFieldMap.has('issue'));
 assert.throws(()=>plugin.setCustomFields('unknown'));const ref=item(1);ref.getField=key=>key==='volume'?'12':'';assert.equal(plugin.value('field-volume',ref),'12');await plugin.stop();
});
test('panel CSS is scoped and cannot load remote content or escape its rules',()=>{
 const {plugin}=fixture();assert.equal(plugin.setPanelCSS('.sc-card {border-radius:0} button {color:red}'),'#style-custom-workbench .sc-card{border-radius:0}\n#style-custom-workbench button{color:red}');
 for(const css of ['@import "https://bad";','.x {background:url(https://bad)}','body {color:red','</style>'])assert.throws(()=>plugin.setPanelCSS(css));
});
test('each window receives an independent library service and all feature panels clean up',async()=>{
 const {plugin}=fixture();plugin.active=true;const services=[],destroyed=[];plugin.attachMotion=()=>{};
 plugin.Library={create:()=>({})};plugin.Workbench={attach:(win,args)=>{services.push(args.library);return {destroy:()=>destroyed.push(win)};}};
 plugin.readerTools={attach:()=>()=>{},tabs:()=>[],stop:()=>{}};
 const make=()=>({ZoteroPane:{},document:{getElementById:()=>null,querySelectorAll:()=>[]},addEventListener(){},removeEventListener(){},setInterval:()=>1,clearInterval(){}});
 const a=make(),b=make();plugin.addWindow(a);plugin.addWindow(b);assert.notEqual(services[0],services[1]);await plugin.stop();assert.equal(destroyed.length,2);
});
test('journal rank provider uses explicit credentials and preserves quartiles separately from JIF',async()=>{
 const {plugin,Z,item}=fixture();plugin.active=true;Z.Prefs.set('extensions.style-custom.journalRankKey','private-key');let requested;
 Z.getMainWindow=()=>({AbortController,setTimeout,clearTimeout,fetch:async(url)=>{requested=url;return {ok:true,json:async()=>({data:{officialRank:{all:{sci:'Q1',sciif:'4.2',jci:2}}}})};}});
 const ref=item(1);ref.getField=key=>key==='publicationTitle'?'Test Journal':'';
 assert.equal((await plugin.refreshPublicationRanks([ref])).updated,1);assert.match(requested,/publicationName=Test%20Journal/);assert.ok(plugin.publicationTags(ref).includes('sci: Q1'));assert.equal(plugin.metrics(ref).impactFactor,4.2);assert.match(plugin.metrics(ref).impactSource,/easyScholar/);
});

test('title decorations restore native weight and layout when toggled or removed',async()=>{
 const {parseHTML}=await import('linkedom');const {document}=parseHTML('<html><body><div id="zotero-items-tree"><div class="row" id="item-tree-main-row-0"><span class="cell title"><span class="cell-text" style="font-weight:400">Paper</span></span></div></div></body></html>');
 const {plugin,item,Z}=fixture();const ref=item(1);plugin.entry(ref).readingAttachmentID=9;plugin.entry(ref).readingAttachments={'9':{pageTimes:{0:5},totalPages:3}};
 Z.Prefs.set('extensions.style-custom.unreadBold',true);Z.Prefs.set('extensions.style-custom.titleTags',true);
 const win={document,ZoteroPane:{itemsView:{getRow:()=>({ref})}},clearInterval(){}};const state={titleNodes:new Set(),titlePositions:new Map(),titleWeights:new Map(),nodes:[],listeners:[]};plugin.windows.set(win,state);
 plugin.enhanceTitles(win,state,[ref]);assert.equal(document.querySelector('.cell-text').style.fontWeight,'700');assert.ok(document.querySelector('.style-custom-title-strip'));assert.match(document.querySelector('.style-custom-title-tags').textContent,/#method/);
 Z.Prefs.set('extensions.style-custom.unreadBold',false);Z.Prefs.set('extensions.style-custom.titleTags',false);Z.Prefs.set('extensions.style-custom.titleHeatmap',false);plugin.enhanceTitles(win,state,[ref]);assert.equal(document.querySelector('.cell-text').style.fontWeight,'400');assert.equal(document.querySelector('.style-custom-title-strip'),null);
 await plugin.removeWindow(win);assert.ok(!document.querySelector('.cell.title').style.position);
});
test('additional metadata columns expose counts, publication fallback and dates without changing items',()=>{
 const {plugin,item,Z}=fixture();const ref=item(1);const fields={publisher:'Publisher',dateAdded:'2026-01-02 03:04:05',dateModified:'2026-02-03 04:05:06'};ref.getField=key=>fields[key]||'';ref.getCreators=()=>[{firstName:'Ada',lastName:'Lovelace'}];ref.getNotes=()=>[11,12];ref.getAttachments=()=>[20];Z.Items={get:()=>({getAnnotations:()=>[{},{}]})};
 assert.equal(plugin.value('venue',ref),'Publisher');assert.equal(plugin.value('authors',ref),'Ada Lovelace');assert.equal(plugin.value('noteCount',ref),'2');assert.equal(plugin.value('annotationCount',ref),'2');assert.equal(plugin.value('added',ref),fields.dateAdded);assert.equal(plugin.state(ref).dateModified,fields.dateModified);
});
test('tag display uses native tag colors while rejecting CSS payloads and hides status internals',()=>{
 const {plugin,item,Z}=fixture();const ref=item(1,{tags:[{tag:'/done'},{tag:'style-custom:rating:5'},{tag:'Topic'},{tag:'Bad'}]});Z.Tags={getColor:(_id,name)=>({color:name==='Topic'?'#12AB34':'url(https://bad)'})};assert.deepEqual(plugin.displayTags(ref),[{tag:'Topic',color:'#12AB34'},{tag:'Bad',color:null}]);
});
test('app theme button toggles the actual toolbar-theme preference',()=>{const {plugin,Z}=fixture();Z.Prefs.set('browser.theme.toolbar-theme',0);assert.equal(plugin.toggleAppTheme(),1);assert.equal(plugin.toggleAppTheme(),0);});
test('tab activity timestamp updates are opt-in, target attachment and parent, and avoid dirty records',async()=>{
 const {plugin,Z,item}=fixture();plugin.active=true;const parent=item(1),attachment={id:2,parentID:1,libraryID:1,isEditable:()=>true,hasChanged:()=>false,dateModified:'old'};let saves=[];parent.dateModified='old';for(const ref of [parent,attachment])ref.saveTx=async options=>{saves.push(ref.id);assert.equal(options.skipDateModifiedUpdate,true);};Z.Items={getAsync:async id=>id===2?attachment:parent};
 await plugin.touchReadingItem(2);assert.deepEqual(saves,[]);Z.Prefs.set('extensions.style-custom.touchDateOnRead',true);await plugin.touchReadingItem(2);assert.deepEqual(saves,[2,1]);assert.match(parent.dateModified,/^20/);parent.hasChanged=()=>true;saves=[];await plugin.touchReadingItem(2);assert.deepEqual(saves,[2]);
});
test('shutdown still unregisters every feature after reader cleanup and cache write failures',async()=>{
 const {plugin,columns,observers}=fixture();await plugin.start({id:'custom',version:'0.5.1',rootURI:'file:///custom/'});
 let readerStopped=0;plugin.readerTools={...plugin.readerTools,stop:()=>{readerStopped++;throw Error('reader teardown failed');}};
 plugin.storage.write=async()=>{throw Error('cache write failed');};plugin.dirty=true;
 await assert.rejects(plugin.stop());assert.equal(columns.size,0);assert.equal(observers.size,0);assert.equal(plugin.prefPane,null);assert.equal(plugin.active,false);
 await assert.rejects(plugin.stop());assert.equal(readerStopped,1);
});
test('one removed item does not discard other metadata IDs in a coalesced batch',async()=>{
 const {plugin,item,Z}=fixture();let timer;const ref=citationItem(item,2);let lookedUp;
 Z.Items={getAsync:async id=>{if(id===1)throw Error('removed');return ref;}};Z.getMainWindow=()=>({setTimeout:fn=>{timer=fn;return 1;},clearTimeout(){}});
 plugin.active=true;plugin.refreshCitations=async items=>{lookedUp=items;};plugin.persistCitation=async()=>false;
 plugin.scheduleMetadataCitations([1,2]);await timer();await plugin.metadataQueue;assert.deepEqual(lookedUp,[ref]);
});
test('citation retry waits use app timers that survive main-window closure and abort promptly',async()=>{
 const {plugin,item,Z}=fixture();plugin.active=true;const ref=citationItem(item,1);let release,started;
 const ready=new Promise(resolve=>started=resolve);Z.Promise={delay:()=>new Promise(resolve=>{release=resolve;started();})};
 Z.getMainWindow=()=>({AbortController,setTimeout(){throw Error('closed window timer');},clearTimeout(){}});
 plugin.citationTools={...plugin.citationTools,lookupMany:async(_records,_http,ctx)=>{await ctx.sleep(1000,ctx.signal);return [];}};
 const running=plugin.refreshCitations([ref],{force:true});
 const settled=running.catch(error=>({error}));await Promise.race([ready,new Promise(resolve=>setTimeout(resolve,20))]);
 assert.equal(typeof release,'function');plugin.citationJob.controller.abort();const result=await settled;assert.equal(result.cancelled,true);release();
});

test('annotation column maps colors to real attachment pages without inventing total pages and navigates clicked markers',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item,Z}=fixture();const ref=item(1);
 const ann=(page,color)=>({annotationPosition:JSON.stringify({pageIndex:page}),annotationColor:color});const files=new Map([[9,{id:9,getAnnotations:()=>[ann(0,'#FFD400'),ann(0,'#ff6666'),ann(5,'url(bad)'),{...ann(2,'#ffd400'),deleted:true},ann(-1,'#ffd400')]}],[10,{id:10,getAnnotations:()=>[ann(0,'#2ea8e5')]}]]);ref.getAttachments=()=>[9,10];Z.Items={get:id=>files.get(id)};
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};const calls=[];plugin.libraryService.openItem=async(...args)=>calls.push(args);
 const points=plugin.annotationDistribution(ref);assert.equal(points.length,3);assert.equal(points[0].count,2);assert.equal(points[1].colors[0][0],'#888888');assert.equal(points[2].attachmentID,10);
 const cell=plugin.renderCell('annotationCount',0,'',{},document);const buttons=cell.querySelectorAll('button');assert.equal(buttons.length,3);buttons[2].dispatchEvent(new window.Event('click',{bubbles:true}));await Promise.resolve();assert.deepEqual(calls,[[10,{pageIndex:0}]]);assert.match(cell.title,/3개 페이지/);assert.doesNotMatch(cell.innerHTML,/url\(bad\)/);
});

test('annotation distribution includes both pages of a merged highlight without double-counting the annotation total',()=>{
 const {plugin,item,Z}=fixture(),ref=item(1);ref.getAttachments=()=>[9];Z.Items={get:()=>({getAnnotations:()=>[{annotationPosition:JSON.stringify({pageIndex:4,rects:[[0,0,1,1]],nextPageRects:[[0,0,2,2]]}),annotationColor:'#ffd400'}]})};
 assert.deepEqual(plugin.annotationDistribution(ref).map(p=>p.pageIndex),[4,5]);assert.equal(plugin.value('annotationCount',ref),'1');
});
