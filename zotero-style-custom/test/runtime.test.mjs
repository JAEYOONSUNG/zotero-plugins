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
  assert.equal(columns.size, 21);
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
 Z.ItemFields={getID:name=>['volume','issue','pages'].includes(name)};plugin.setCustomFields('volume, issue');assert.equal(columns.size,23);
 const original=Z.ItemTreeManager.registerColumn;Z.ItemTreeManager.registerColumn=options=>options.dataKey==='field-pages'?false:original(options);
 assert.throws(()=>plugin.setCustomFields('volume, pages'));assert.equal(columns.size,23);assert.ok(plugin.dynamicFieldMap.has('issue'));
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
 Z.Prefs.set('extensions.style-custom.unreadBold',true);Z.Prefs.set('extensions.style-custom.titleTags',true);Z.Prefs.set('extensions.style-custom.titleHeatmap',true);
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

test('supplementary attachments are told apart from the main PDF by publisher naming conventions',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item,Z}=fixture();const ref=item(1);
 const file=(id,name)=>[id,{id,attachmentFilename:name,isFileAttachment:()=>true,attachmentContentType:'application/pdf'}];
 const files=new Map([file(1,'Roisne-Hamelin 2024 Molecular Cell.pdf'),file(2,'mmc1.pdf'),file(3,'1-s2.0-supplementary-information.pdf'),file(4,'media-3.xlsx'),file(5,'Structure of a Type II SMC Wadjet Complex.pdf'),
  // A title truncated mid-word ends in " si." and must not read as supplementary.
  file(6,'Horton 2019 - CcrM opens a bubble at its DNA recognition si.pdf'),file(7,'thermocas9-supple.pdf'),file(8,'pThermoBE_supp_data.docx'),file(9,'41467_2015_MOESM1323_ESM.pdf')]);
 ref.getAttachments=()=>[1,2,3,4,5,6,7,8,9];Z.Items={get:id=>files.get(id)};
 // "PDF" in a filename is not evidence either way; only an explicit marker is.
 assert.deepEqual(plugin.attachmentKinds(ref).map(k=>k.supplementary),[false,true,true,true,false,false,true,true,true]);
 assert.equal(plugin.value('files',ref),'PDF×3 · SI×6');
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 const cell=plugin.renderCell('files',0,'',{},document);const pills=[...cell.children].map(el=>el.textContent);
 assert.deepEqual(pills,['PDF ×3','SI ×6']);assert.match(cell.title,/보충자료 6개/);
});

test('an item with only a main PDF says so rather than leaving the supplementary question open',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item,Z}=fixture();const ref=item(1);
 ref.getAttachments=()=>[1];Z.Items={get:()=>({id:1,attachmentFilename:'paper.pdf',isFileAttachment:()=>true})};
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 const cell=plugin.renderCell('files',0,'',{},document);
 assert.deepEqual([...cell.children].map(el=>el.textContent),['PDF']);assert.equal(cell.title,'보충자료 없음');
});

test('status rating and impact cells carry colour that tracks the value instead of one flat style',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item}=fixture();const ref=item(1);
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 const P=plugin.palette(document);
 const status=label=>{plugin.value=(key)=>key==='status'?String({unread:0,reading:1,done:2}[label]):'';return plugin.renderCell('status',0,'',{},document).firstChild.style.color;};
 assert.deepEqual([status('unread'),status('reading'),status('done')],[P.muted,P.orange,P.green]);
 // A 16.6 and a 56.1 must not read as the same journal.
 const tier=value=>plugin.impactTier(value,P)?.color;
 assert.notEqual(tier(16.6),tier(56.1));
 assert.deepEqual([tier(0),tier(1.2),tier(3),tier(6),tier(16.6),tier(56.1)],[undefined,P.gray,P.green,P.teal,P.blue,P.purple]);
 // Citation bars are log-scaled, so a 40-citation paper is still visible next to a 900-citation one.
 assert.ok(plugin.citationShare(40)>0.5&&plugin.citationShare(40)<plugin.citationShare(900));
 assert.equal(plugin.citationShare(0),0);
});

test('the palette follows the window theme so cells stay legible in dark mode',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin}=fixture();
 window.matchMedia=query=>({matches:query==='(prefers-color-scheme: dark)'});
 const dark=plugin.palette(document);assert.equal(dark.dark,true);
 window.matchMedia=()=>({matches:false});
 const light=plugin.palette(document);assert.equal(light.dark,false);
 assert.notEqual(dark.text,light.text);assert.ok(dark.tint>light.tint);
});

test('the reading heatmap stays off unless asked for, so nothing draws under the title by default',async()=>{
 const {parseHTML}=await import('linkedom');const {document}=parseHTML('<html><body><div id="zotero-items-tree"><div class="row" id="item-tree-main-row-0"><span class="cell title"><span class="cell-text">Paper</span></span></div></div></body></html>');
 const {plugin,item}=fixture();const ref=item(1);plugin.entry(ref).readingAttachmentID=9;plugin.entry(ref).readingAttachments={'9':{pageTimes:{0:5},totalPages:3}};
 const win={document,ZoteroPane:{itemsView:{getRow:()=>({ref})}},clearInterval(){}};const state={titleNodes:new Set(),titlePositions:new Map(),titleWeights:new Map(),nodes:[],listeners:[]};plugin.windows.set(win,state);
 plugin.enhanceTitles(win,state,[ref]);
 assert.equal(document.querySelector('.style-custom-title-strip'),null,'an unrequested strip reads as a rendering bug');
});

test('every shipped default preference agrees with the default the code and schema use',async()=>{
 const {readFileSync}=await import('node:fs');
 const shipped=new Map();
 for(const line of readFileSync(new URL('../prefs.js',import.meta.url),'utf8').split('\n')){
  const m=/^pref\("extensions\.style-custom\.([^"]+)",\s*(.+?)\);/.exec(line.trim());
  if(m)shipped.set(m[1],m[2]);
 }
 assert.ok(shipped.size,'prefs.js should ship defaults');
 const runtime=readFileSync(new URL('../src/runtime.js',import.meta.url),'utf8');
 const workbench=readFileSync(new URL('../src/workbench.js',import.meta.url),'utf8');
 const schema=(await import('../src/settings-schema.js')).default.schema.settings;
 for(const [key,value] of shipped){
  // Zotero.Prefs.get returns the shipped default, so a differing code fallback is dead.
  for(const [name,source] of [['runtime',runtime],['workbench',workbench]]){
   for(const m of source.matchAll(new RegExp(`pref\\\\('${key}',\\\\s*([^)]+)\\\\)`,'g'))){
    assert.equal(m[1].trim(),value,`${name} fallback for ${key} contradicts prefs.js`);
   }
  }
  const row=schema.find(r=>r.key===key);
  if(row&&['boolean','number'].includes(row.type))assert.equal(String(row.default),value,`schema default for ${key} contradicts prefs.js`);
 }
});

// The whole supplementary path with the network and the archive faked, because
// a scope slip here ("bytes is not defined") only shows up at run time.
function supplementaryFixture({article, archive, attach} = {}) {
  const f = fixture();
  const ref = f.item(1);
  const fields = {title: 'An antiplasmid system', DOI: '10.1038/s41467-024-48219-y', date: '2024'};
  ref.getField = key => fields[key] || '';
  ref.getCreators = () => [{firstName: 'A', lastName: 'Zongo'}];
  ref.getAttachments = () => [];
  const requests = [];
  f.Z.HTTP = {request: async (method, url, options) => {
    requests.push(url);
    if (/\/search\?/.test(url)) return {response: {resultList: {result: [article ?? {
      id: '38744896', source: 'MED', pmid: '38744896', pmcid: 'PMC11096173',
      doi: '10.1038/s41467-024-48219-y', hasSuppl: 'Y', isOpenAccess: 'Y'}]}}};
    assert.equal(options.responseType, 'arraybuffer');
    return {response: (archive ?? new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])).buffer};
  }};
  const imported = [];
  f.plugin.attachSupplementary = async (item, bytes, opts) => {
    // The caller must hand over real bytes, not an undefined binding.
    assert.ok(bytes instanceof Uint8Array && bytes.length, 'attachSupplementary needs the archive bytes');
    imported.push({item, length: bytes.length, opts});
    return attach ?? {status: 'ok', added: 2, skipped: 0};
  };
  return {...f, ref, requests, imported};
}

test('a supplementary fetch reaches the attach step with the downloaded bytes', async () => {
  const f = supplementaryFixture();
  const result = await f.plugin.fetchSupplementary(f.ref, {pdfOnly: true});
  assert.deepEqual({status: result.status, added: result.added}, {status: 'ok', added: 2});
  assert.equal(f.imported.length, 1);
  assert.equal(f.imported[0].length, 6);
  assert.equal(f.imported[0].opts.pdfOnly, true);
  assert.match(f.requests[0], /\/search\?query=DOI/);
  assert.equal(f.requests[1], 'https://www.ebi.ac.uk/europepmc/webservices/rest/PMC11096173/supplementaryFiles');
});

test('a closed-access article is reported as unavailable, not as a corrupt archive', async () => {
  const xml = new TextEncoder().encode('<errorBean><errMsg>Article with id PMC1 is not open access one</errMsg></errorBean>');
  const f = supplementaryFixture({archive: xml});
  const result = await f.plugin.fetchSupplementary(f.ref);
  assert.equal(result.status, 'none');
  assert.match(result.reason, /not open access/);
  assert.equal(f.imported.length, 0, 'nothing should be written for a non-archive response');
});

test('an article with no supplementary material, or none in PMC, says which', async () => {
  const none = await supplementaryFixture({article: {pmcid: 'PMC1', doi: '10.1038/s41467-024-48219-y', hasSuppl: 'N'}})
    .plugin.fetchSupplementary((await supplementaryFixture()).ref);
  assert.equal(none.status, 'none');
  const f = supplementaryFixture({article: {id: '1', source: 'MED', pmid: '1', doi: '10.1038/s41467-024-48219-y', hasSuppl: 'Y'}});
  const notArchived = await f.plugin.fetchSupplementary(f.ref);
  assert.equal(notArchived.status, 'none');
  assert.match(notArchived.reason, /PMC/);
  assert.equal(f.requests.length, 1, 'no download should be attempted');
});

test('an oversized archive is refused before anything is written to disk', async () => {
  const f = supplementaryFixture({archive: new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(60).fill(0)])});
  const result = await f.plugin.fetchSupplementary(f.ref, {maxBytes: 8});
  assert.equal(result.status, 'error');
  assert.match(result.reason, /MB/);
  assert.equal(f.imported.length, 0);
});

test('downloading for several items totals the outcomes and keeps going past a failure', async () => {
  const f = supplementaryFixture();
  const good = f.ref, bad = f.item(2);
  bad.getField = () => '';
  bad.getCreators = () => [];
  const totals = await f.plugin.downloadSupplementary([good, bad, good]);
  assert.equal(totals.ok, 2);
  assert.equal(totals.added, 4);
  assert.equal(totals.unsupported, 1, 'an item with no identifier cannot be looked up');
});

test('a supplementary attachment stays identifiable after a file mover renames it', () => {
  const {plugin, item, Z} = fixture();
  const ref = item(1);
  // ZotMoov rewrites both the filename and the title to the parent's template.
  const renamed = {id: 2, isFileAttachment: () => true, attachmentFilename: 'Zongo 2024 - An antiplasmid system 1.pdf',
    getTags: () => [{tag: plugin.SUPPLEMENTARY_TAG, type: 1}]};
  const main = {id: 3, isFileAttachment: () => true, attachmentFilename: 'Zongo 2024 - An antiplasmid system.pdf',
    getTags: () => []};
  ref.getAttachments = () => [2, 3];
  Z.Items = {get: id => ({2: renamed, 3: main})[id]};
  assert.deepEqual(plugin.attachmentKinds(ref).map(k => k.supplementary), [true, false]);
  assert.equal(plugin.value('files', ref), 'PDF×1 · SI×1');
});

test('re-downloading does not attach the same supplementary file twice', async () => {
  const f = supplementaryFixture();
  // Restore the real attach path, with only the archive reading faked out.
  const entries = ['41467_2024_48219_MOESM1_ESM.pdf', '41467_2024_48219_MOESM2_ESM.pdf'];
  const tagged = [];
  f.plugin.attachSupplementary = async function (item, bytes, {pdfOnly} = {}) {
    const record = this.entry(item);
    const imported = new Set(Array.isArray(record.supplementaryFiles) ? record.supplementaryFiles : []);
    let added = 0, skipped = 0;
    for (const file of this.supplementaryTools.classifyEntries(entries, {pdfOnly})) {
      if (imported.has(file.name.toLowerCase())) { skipped++; continue; }
      tagged.push(file.name); imported.add(file.name.toLowerCase()); added++;
    }
    if (added) record.supplementaryFiles = [...imported];
    return {status: added ? 'ok' : skipped ? 'already' : 'none', added, skipped};
  };
  const first = await f.plugin.fetchSupplementary(f.ref);
  assert.deepEqual({status: first.status, added: first.added}, {status: 'ok', added: 2});
  const second = await f.plugin.fetchSupplementary(f.ref);
  assert.deepEqual({status: second.status, added: second.added, skipped: second.skipped},
    {status: 'already', added: 0, skipped: 2});
  assert.equal(tagged.length, 2, 'the same two files must not be imported again');
});

test('column labels are the plain field name, with no plugin suffix', async () => {
  const {plugin} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  for (const [, label] of plugin.columnDefinitions) {
    assert.doesNotMatch(label, /Custom/, `"${label}" should not advertise the plugin in every heading`);
    assert.doesNotMatch(label, /·/);
  }
  assert.deepEqual(plugin.columnDefinitions.slice(0, 3).map(c => c[1]), ['IF', 'Cited Count', 'Status']);
});

test('citation bars all start at the same x, so their lengths can be compared', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const track = count => {
    plugin.value = key => key === 'citations' ? String(count) : '';
    const cell = plugin.renderCell('citations', 0, '', {}, document);
    return {number: cell.firstChild.style, bar: cell.lastChild.firstChild.style.width};
  };
  // A one-digit and a four-digit count must reserve the same width for the number.
  const small = track(7), large = track(1234);
  assert.equal(small.number.minWidth, large.number.minWidth);
  assert.equal(small.number.textAlign, 'right');
  assert.equal(small.number.flex, 'none', 'a growing number column would shift the bar');
  // The bar itself still reflects the count.
  assert.ok(parseFloat(large.bar) > parseFloat(small.bar));
});

const TOPIC = {id: 'https://openalex.org/T1', subfield: {id: 'https://openalex.org/S1'},
  field: {id: 'https://openalex.org/F1'}, domain: {id: 'https://openalex.org/D1'}};

function discoverFixture({work, batch, profile, authorWorks, citing} = {}) {
  const f = fixture();
  const ref = f.item(1);
  const fields = {title: 'An antiplasmid system', DOI: '10.1038/s41467-024-48219-y', date: '2024'};
  ref.getField = key => fields[key] || '';
  ref.getCreators = () => [{firstName: 'A', lastName: 'Zongo'}];
  const asked = [];
  f.Z.HTTP = {request: async (method, url) => {
    asked.push(url);
    if (/\/works\/doi:/.test(url)) return {response: work ?? {
      id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1038/s41467-024-48219-y',
      title: 'An antiplasmid system', publication_year: 2024, cited_by_count: 12,
      topics: [TOPIC],
      authorships: [{author: {id: 'https://openalex.org/A1', display_name: 'A Zongo'},
        author_position: 'first', institutions: [{display_name: 'Institut Pasteur'}]}],
      related_works: ['https://openalex.org/W9'], referenced_works: ['https://openalex.org/W7']}};
    if (/cites%3A|cites:/.test(url)) return {response: {results: citing ?? []}};
    if (/\/authors\//.test(url)) return {response: profile ?? {
      id: 'https://openalex.org/A1', display_name: 'A Zongo', works_count: 40, cited_by_count: 900,
      summary_stats: {h_index: 21}, last_known_institutions: [{display_name: 'Institut Pasteur'}],
      topics: [{display_name: 'Plasmid biology', count: 18}]}};
    if (/author\.id/.test(url)) return {response: {results: authorWorks ?? [
      {id: 'https://openalex.org/W5', title: 'Newest paper', publication_year: 2026,
       doi: 'https://doi.org/10.1/new', cited_by_count: 0},
      {id: 'https://openalex.org/W1', title: 'An antiplasmid system', publication_year: 2024,
       doi: 'https://doi.org/10.1038/s41467-024-48219-y', cited_by_count: 12}]}};
    return {response: {results: batch ?? [
      {id: 'https://openalex.org/W9', title: 'A similar paper', publication_year: 2022, cited_by_count: 80,
       doi: 'https://doi.org/10.1/similar', topics: [TOPIC]},
      {id: 'https://openalex.org/W7', title: 'A cited paper', publication_year: 2019, cited_by_count: 300,
       doi: 'https://doi.org/10.1/cited', topics: [TOPIC]}]}};
  }};
  return {...f, ref, asked};
}

test('related papers come back ranked, with the ones already shelved marked', async () => {
  const f = discoverFixture();
  f.plugin.cache.items = {x: {doi: '10.1/cited'}};
  const {work, suggestions} = await f.plugin.relatedWorks(f.ref);
  assert.equal(work.title, 'An antiplasmid system');
  // The paper's own bibliography outranks OpenAlex's computed "related".
  assert.deepEqual(suggestions.map(s => [s.title, s.source, s.inLibrary]), [
    ['A cited paper', 'reference', true],
    ['A similar paper', 'related', false]
  ]);
  assert.match(f.asked[0], /works\/doi:/);
  assert.match(f.asked[1], /openalex_id/);
});

test('a paper with neither DOI nor title is refused before any request is made', async () => {
  const f = discoverFixture();
  f.ref.getField = () => '';
  await assert.rejects(() => f.plugin.relatedWorks(f.ref), /DOI/);
  assert.equal(f.asked.length, 0);
});

test('authors are resolved from the paper itself, carrying their OpenAlex ids', async () => {
  const f = discoverFixture();
  const people = await f.plugin.authorsOf(f.ref);
  assert.deepEqual(people, [{id: 'A1', name: 'A Zongo', institution: 'Institut Pasteur', position: 'first'}]);
});

test("an author's recent work arrives newest first, with standing and subject area", async () => {
  const f = discoverFixture();
  f.plugin.cache.items = {x: {doi: '10.1038/s41467-024-48219-y'}};
  const {profile, works} = await f.plugin.authorActivity('A1');
  assert.equal(profile.hIndex, 21);
  assert.deepEqual(profile.topics.map(t => t.name), ['Plasmid biology']);
  assert.deepEqual(works.map(w => [w.year, w.inLibrary]), [[2026, false], [2024, true]]);
});

test('a failed profile lookup still returns the work list rather than losing everything', async () => {
  const f = discoverFixture();
  const original = f.Z.HTTP.request;
  f.Z.HTTP.request = async (method, url) => {
    if (/\/authors\//.test(url)) throw new Error('rate limited');
    return original(method, url);
  };
  const {profile, works} = await f.plugin.authorActivity('A1');
  assert.equal(profile, null);
  assert.equal(works.length, 2);
});

test('an author id that is really a work id is rejected', async () => {
  await assert.rejects(() => discoverFixture().plugin.authorActivity('W123'), /식별자/);
});

test('papers that cite this one lead the list, and off-topic results never reach it', async () => {
  const f = discoverFixture({
    citing: [{id: 'https://openalex.org/W5', title: 'What came after', publication_year: 2026,
      doi: 'https://doi.org/10.1/after', cited_by_count: 400, topics: [TOPIC]}],
    batch: [
      {id: 'https://openalex.org/W7', title: 'A cited paper', publication_year: 2019,
       doi: 'https://doi.org/10.1/cited', cited_by_count: 300, topics: [TOPIC]},
      // OpenAlex really does return results like this; they must not be shown.
      {id: 'https://openalex.org/W9', title: 'A pedagogy paper in another field', publication_year: 2024,
       doi: 'https://doi.org/10.1/off', cited_by_count: 0,
       topics: [{id: 'https://openalex.org/T9', subfield: {id: 'https://openalex.org/S9'},
         field: {id: 'https://openalex.org/F9'}, domain: {id: 'https://openalex.org/D9'}}]}
    ]});
  const {suggestions} = await f.plugin.relatedWorks(f.ref);
  assert.deepEqual(suggestions.map(s => [s.title, s.source]), [
    ['What came after', 'citing'],
    ['A cited paper', 'reference']
  ]);
  assert.ok(f.asked.some(url => /cites/.test(url)), 'citing works should be requested');
});

test('losing the citing-works request still returns the rest of the suggestions', async () => {
  const f = discoverFixture();
  const original = f.Z.HTTP.request;
  f.Z.HTTP.request = async (method, url) => {
    if (/cites/.test(url)) throw new Error('rate limited');
    return original(method, url);
  };
  const {suggestions} = await f.plugin.relatedWorks(f.ref);
  assert.deepEqual(suggestions.map(s => s.source), ['reference', 'related']);
});

test('a repeated lookup is served from memory, and a failed one is not remembered', async () => {
  const f = discoverFixture();
  const first = await f.plugin.relatedWorksCached(f.ref);
  const asked = f.asked.length;
  const second = await f.plugin.relatedWorksCached(f.ref);
  assert.equal(f.asked.length, asked, 'a second look should not hit the network');
  assert.equal(first, second);

  // A lookup that throws must leave nothing behind to be served as the answer.
  const g = discoverFixture();
  g.Z.HTTP.request = async () => { throw new Error('offline'); };
  await assert.rejects(() => g.plugin.relatedWorksCached(g.ref));
  assert.equal(g.plugin.discoverCache.size, 0);
  g.Z.HTTP.request = discoverFixture().Z.HTTP.request;
  assert.ok((await g.plugin.relatedWorksCached(g.ref)).work, 'a retry should be allowed to succeed');
});

test('the lookup cache evicts the least recently used entry rather than growing without bound', async () => {
  const f = discoverFixture();
  f.plugin.DISCOVER_CACHE_LIMIT = 3;
  for (const key of ['a', 'b', 'c']) await f.plugin.discoverCached(key, async () => key);
  // Touching 'a' makes 'b' the oldest.
  await f.plugin.discoverCached('a', async () => 'stale');
  await f.plugin.discoverCached('d', async () => 'd');
  assert.deepEqual([...f.plugin.discoverCache.keys()], ['c', 'a', 'd']);
});

test('an import goes through the same translator path Zotero uses, into the open collection', async () => {
  const f = discoverFixture();
  const translated = [];
  f.Z.Translate = {Search: class {
    setIdentifier(id) { this.id = id; }
    async getTranslators() { return ['a-translator']; }
    setTranslator(list) { this.translators = list; }
    async translate(options) { translated.push([this.id, this.translators, options]); return [{getField: () => 'Saved'}]; }
  }};
  f.Z.Libraries.userLibraryID = 1;
  const win = {ZoteroPane: {getSelectedCollection: () => ({id: 7}), getSelectedLibraryID: () => 3}};
  const saved = await f.plugin.importWork({doi: '10.1/x', title: 'A paper'}, win);
  assert.equal(saved[0].getField(), 'Saved');
  const [identifier, translators, options] = translated[0];
  assert.deepEqual(identifier, {DOI: '10.1/x'});
  assert.deepEqual(translators, ['a-translator']);
  assert.equal(options.libraryID, 3);
  assert.deepEqual(options.collections, [7]);
  assert.equal(options.saveAttachments, true, 'the PDF is the reason for importing');
});

test('a suggestion with no DOI is refused before a translator is asked for', async () => {
  const f = discoverFixture();
  f.Z.Translate = {Search: class { async getTranslators() { throw new Error('should not be reached'); } }};
  await assert.rejects(() => f.plugin.importWork({title: 'No identifier'}, {}), /DOI/);
});

test('an identifier no translator recognises is reported rather than silently doing nothing', async () => {
  const f = discoverFixture();
  f.Z.Translate = {Search: class {
    setIdentifier() {} setTranslator() {}
    async getTranslators() { return []; }
  }};
  await assert.rejects(() => f.plugin.importWork({doi: '10.1/x'}, {}), /번역기/);
});

test('following an author records what was already published, so later news is genuinely new', async () => {
  const f = discoverFixture();
  const {works} = await f.plugin.authorActivity('A1');
  await f.plugin.watchAuthor({id: 'A1', name: 'A Zongo', institution: 'Institut Pasteur',
    seen: works.map(w => w.id)});
  const first = await f.plugin.authorUpdates('A1');
  assert.equal(first.watching, true);
  assert.deepEqual(first.fresh, [], 'nothing is new the moment you start following');

  // A paper appears that was not there before.
  f.plugin.discoverCache.clear();
  const original = f.Z.HTTP.request;
  f.Z.HTTP.request = async (method, url) => {
    if (/author\.id/.test(url)) return {response: {results: [
      {id: 'https://openalex.org/W77', title: 'Just published', publication_year: 2026,
       doi: 'https://doi.org/10.1/just', cited_by_count: 0},
      {id: 'https://openalex.org/W5', title: 'Newest paper', publication_year: 2026,
       doi: 'https://doi.org/10.1/new', cited_by_count: 0}]}};
    return original(method, url);
  };
  const later = await f.plugin.authorUpdates('A1');
  assert.deepEqual(later.fresh.map(w => w.title), ['Just published']);

  // Marking as read clears it, and does not re-flag it next time.
  await f.plugin.markAuthorSeen('A1', later.works);
  assert.deepEqual((await f.plugin.authorUpdates('A1')).fresh, []);
});

test('an author who is not followed is never reported as having news', async () => {
  const f = discoverFixture();
  const {watching, fresh, works} = await f.plugin.authorUpdates('A1');
  assert.equal(watching, false);
  assert.deepEqual(fresh, [], 'an unfollowed author has no baseline, so nothing can be new');
  assert.equal(works.length, 2, 'their recent work is still shown');
});

test('following the same author twice updates the entry instead of duplicating it', async () => {
  const f = discoverFixture();
  await f.plugin.watchAuthor({id: 'A1', name: 'Old name'});
  await f.plugin.watchAuthor({id: 'a1', name: 'New name', institution: 'Somewhere'});
  assert.equal(f.plugin.watchedAuthors().length, 1);
  assert.equal(f.plugin.watchedAuthors()[0].name, 'New name');
  await f.plugin.unwatchAuthor('A1');
  assert.deepEqual(f.plugin.watchedAuthors(), []);
});

test('the watchlist refuses a work id and will not grow without bound', async () => {
  const f = discoverFixture();
  await assert.rejects(() => f.plugin.watchAuthor({id: 'W123'}), /식별자/);
  f.plugin.cache.watchedAuthors = Array.from({length: 100}, (_, i) => ({id: 'A' + i, name: 'x', seen: []}));
  await assert.rejects(() => f.plugin.watchAuthor({id: 'A999', name: 'one too many'}), /100/);
  // Re-following someone already on the list is not growth.
  await f.plugin.watchAuthor({id: 'A5', name: 'already there'});
  assert.equal(f.plugin.watchedAuthors().length, 100);
});

test('a corrupt watchlist on disk is ignored rather than crashing the tab', async () => {
  const f = discoverFixture();
  for (const bad of [null, 'nonsense', [null, 3, {name: 'no id'}]]) {
    f.plugin.cache.watchedAuthors = bad;
    assert.deepEqual(f.plugin.watchedAuthors(), []);
  }
});

function attachmentFixture() {
  const {plugin, item, Z} = fixture();
  const parent = item(1);
  const make = (id, tags = []) => ({
    id, isFileAttachment: () => true, attachmentFilename: 'file' + id + '.pdf',
    getTags: () => tags.map(tag => ({tag, type: 1})),
    addTag(tag) { tags.push(tag); }, removeTag(tag) { tags.splice(tags.indexOf(tag), 1); },
    async saveTx() { this.saved = (this.saved || 0) + 1; }
  });
  const files = new Map([[2, make(2)], [3, make(3, [plugin.SUPPLEMENTARY_TAG])]]);
  parent.getAttachments = () => [2, 3];
  Z.Items = {get: id => files.get(id)};
  plugin.refreshWindows = async () => { plugin.refreshed = (plugin.refreshed || 0) + 1; };
  return {plugin, parent, files, Z};
}

test('a file the user downloaded themselves can be marked supplementary by hand', async () => {
  const {plugin, files} = attachmentFixture();
  const changed = await plugin.setSupplementary([files.get(2)], true);
  assert.equal(changed, 1);
  assert.equal(plugin.isSupplementary(files.get(2)), true);
  assert.equal(plugin.refreshed, 1, 'the column should repaint');

  // Marking something already marked is not a change, and costs no write.
  assert.equal(await plugin.setSupplementary([files.get(2)], true), 0);
  assert.equal(files.get(2).saved, 1);
});

test('a wrongly marked file can be unmarked', async () => {
  const {plugin, files} = attachmentFixture();
  assert.equal(plugin.isSupplementary(files.get(3)), true);
  assert.equal(await plugin.setSupplementary([files.get(3)], false), 1);
  assert.equal(plugin.isSupplementary(files.get(3)), false);
  assert.equal(await plugin.setSupplementary([files.get(3)], false), 0);
});

test('selecting a paper offers its files; selecting files uses exactly those', async () => {
  const {plugin, parent, files} = attachmentFixture();
  const win = selected => ({ZoteroPane: {getSelectedItems: () => selected}});
  // A parent stands for its own attachments.
  assert.deepEqual(plugin.selectedAttachments(win([parent])).map(a => a.id), [2, 3]);
  // An explicit file selection is not widened to its siblings.
  assert.deepEqual(plugin.selectedAttachments(win([files.get(3)])).map(a => a.id), [3]);
  assert.deepEqual(plugin.selectedAttachments(win([])), []);
  assert.deepEqual(plugin.selectedAttachments({}), []);
});

test('the SI badge opens the supplementary file rather than just describing it', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, parent} = attachmentFixture();
  window.ZoteroPane = {itemsView: {getRow: () => ({ref: parent})}};
  const opened = [];
  plugin.libraryService.openItem = async (...args) => { opened.push(args); };
  const cell = plugin.renderCell('files', 0, '', {}, document);
  const badge = [...cell.children].find(el => el.textContent.startsWith('SI'));
  assert.ok(badge, 'the marked file should be badged');
  assert.equal(badge.style.cursor, 'pointer');
  badge.dispatchEvent(new window.Event('click', {bubbles: true}));
  await Promise.resolve();
  assert.deepEqual(opened, [[3]], 'clicking opens the supplementary attachment');
});

test('an item can be marked with a colour, and the mark cleared again', async () => {
  const {plugin, item} = fixture();
  const a = item(1), b = item(2);
  assert.equal(plugin.highlightOf(a), null);
  assert.equal(await plugin.setHighlight([a, b], 'teal'), 2);
  assert.equal(plugin.highlightOf(a), 'teal');
  // Setting the colour it already has is not a change, so nothing is rewritten.
  assert.equal(await plugin.setHighlight([a], 'teal'), 0);
  assert.equal(await plugin.setHighlight([a], null), 1);
  assert.equal(plugin.highlightOf(a), null);
  assert.equal(plugin.highlightOf(b), 'teal', 'clearing one item leaves the other');
  await assert.rejects(() => plugin.setHighlight([a], 'chartreuse'), RangeError);
});

test('a colour that is no longer offered is ignored rather than painted as something else', () => {
  const {plugin, item} = fixture();
  const ref = item(1);
  plugin.entry(ref).highlight = 'chartreuse';
  assert.equal(plugin.highlightOf(ref), null);
  // Every offered colour must exist in the palette, or the bar would be blank.
  const {parseHTML} = require('linkedom');
  for (const colour of plugin.highlightColours()) assert.ok(colour.label, colour.key);
});

test('the colour is a bar at the end of the row, so it cannot fight the selection', async () => {
  const {parseHTML} = await import('linkedom');
  const {document} = parseHTML('<html><body><div id="zotero-items-tree"><div class="row" id="item-tree-main-row-0"><span class="cell title"><span class="cell-text">Paper</span></span></div></div></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  await plugin.setHighlight([ref], 'purple');
  const win = {document, ZoteroPane: {itemsView: {getRow: () => ({ref})}}, clearInterval() {}};
  const state = {titleNodes: new Set(), titlePositions: new Map(), titleWeights: new Map(), nodes: [], listeners: []};
  plugin.windows.set(win, state);
  plugin.enhanceTitles(win, state, [ref]);
  const bar = document.querySelector('.style-custom-highlight');
  assert.ok(bar, 'a marked row should carry a bar');
  assert.match(bar.style.cssText, /inset-inline-end:\s*0/);
  assert.match(bar.style.cssText, /pointer-events:\s*none/, 'the bar must not swallow clicks');
  assert.equal(bar.style.background, plugin.palette(document).purple);

  // Clearing the colour removes the bar rather than leaving a stale one.
  await plugin.setHighlight([ref], null);
  plugin.enhanceTitles(win, state, [ref]);
  assert.equal(document.querySelector('.style-custom-highlight'), null);
});

test('the status glyph changes shape with progress, not just colour', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const glyph = label => {
    plugin.value = key => key === 'status' ? String({unread: 0, reading: 1, done: 2}[label]) : '';
    return plugin.renderCell('status', 0, '', {}, document).firstChild.textContent;
  };
  // Empty, half, full: legible even to a reader who cannot separate the colours.
  assert.deepEqual([glyph('unread'), glyph('reading'), glyph('done')], ['○', '◐', '●']);
});

test('filled stars use gold with enough area to read, empty ones are plainly empty', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const P = plugin.palette(document);
  plugin.value = key => key === 'rating' ? '3' : '';
  const stars = [...plugin.renderCell('rating', 0, '', {}, document).children];
  assert.deepEqual(stars.map(s => s.textContent), ['★', '★', '★', '☆', '☆']);
  assert.deepEqual(stars.map(s => s.style.color), [P.gold, P.gold, P.gold, P.faint, P.faint]);
  assert.equal(stars[0].style.fontSize, '13px');
  assert.notEqual(P.gold, P.faint);
});

test('cleaning up star tags moves the rating first, so nothing is lost', async () => {
  const {plugin, item} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  // The common case: the rating lives only in the visible tag.
  const onlyStars = item(1, {tags: [{tag: '★★★★'}, {tag: 'Topic'}]});
  assert.equal(plugin.state(onlyStars).rating, 4);
  const {moved} = await plugin.migrateStarTags([onlyStars]);
  assert.equal(moved, 1);
  const tags = onlyStars.getTags().map(t => t.tag);
  assert.ok(tags.includes('style-custom:rating:4'), 'the rating must survive');
  assert.ok(!tags.some(t => /[★⭐]/.test(t)), 'the visible tag is what was cluttering the title');
  assert.ok(tags.includes('Topic'), 'unrelated tags are untouched');
  assert.equal(plugin.state(onlyStars).rating, 4, 'the rating still reads back the same');
});

test('an item that cannot be edited is counted, not silently skipped', async () => {
  const {plugin, item} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  const locked = item(1, {tags: [{tag: '★★'}]});
  locked.isEditable = () => false;
  const {moved, skipped} = await plugin.migrateStarTags([locked]);
  assert.deepEqual({moved, skipped}, {moved: 0, skipped: 1});
  assert.ok(locked.getTags().some(t => t.tag === '★★'), 'a read-only item is left alone');
});

test('items carrying a star tag are found, and ones without are not', () => {
  const {plugin, item, Z} = fixture();
  const starred = item(1, {tags: [{tag: '⭐⭐⭐'}]});
  const emoji = item(2, {tags: [{tag: '★★️'}]});
  const plain = item(3, {tags: [{tag: 'Topic'}, {tag: 'style-custom:rating:3'}]});
  Z.Items = {...(Z.Items || {}), getAll: () => [starred, emoji, plain]};
  assert.deepEqual(plugin.starTagItems().map(i => i.id), [starred.id, emoji.id]);
});

test('the toolbar button uses a monochrome glyph, never the coloured app icon', async () => {
  const {readFileSync} = await import('node:fs');
  const workbench = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  const image = /toolbar\.setAttribute\('image',runtime\.rootURI\+'([^']+)'\)/.exec(workbench);
  assert.ok(image, 'the toolbar button should set an image');
  // The app icon is a filled colour squircle; in a toolbar it looks like a sticker.
  assert.equal(image[1], 'content/icons/style-custom-toolbar.svg');
  const glyph = readFileSync(new URL('../' + image[1], import.meta.url), 'utf8');
  assert.match(glyph, /viewBox="0 0 20 20"/, 'Zotero draws its toolbar icons on a 20px grid');
  assert.match(glyph, /fill="context-fill"/, 'the glyph must take its colour from the theme');
  assert.doesNotMatch(glyph, /#[0-9a-f]{3,6}/i, 'a hard-coded colour would not follow dark mode');
});

function legacyFixture() {
  const {plugin, item, Z} = fixture();
  const paper = item(1);
  paper.key = 'AAAA1111';
  paper.getAttachments = () => [77];
  const other = item(2);
  other.key = 'BBBB2222';
  other.getAttachments = () => [];
  const makeNote = (id, key, page, data) => ({
    id, key: 'NOTE' + id, isNote: () => true, isRegularItem: () => false,
    getNote: () => `<div class="zotero-note znv1">${key}\n{"readingTime":{"page":${page},"data":${JSON.stringify(data)}}}</div>`
  });
  const notes = [makeNote(10, 'AAAA1111', 16, {0: 600, 1: 900}), makeNote(11, 'BBBB2222', 4, {0: 120}),
    makeNote(12, 'ZZZZ9999', 4, {0: 50})];
  Z.Items = {...(Z.Items || {}), getAll: () => [paper, other, ...notes]};
  return {plugin, paper, other, Z};
}

test('reading history is lifted out of the old plugin notes into our own store', async () => {
  const f = legacyFixture();
  const preview = await f.plugin.importLegacyReading({dryRun: true});
  assert.deepEqual({notes: preview.notes, imported: preview.imported, seconds: preview.seconds},
    {notes: 3, imported: 2, seconds: 1620});
  assert.equal(f.plugin.entry(f.paper).seconds, undefined, 'a dry run writes nothing');

  const result = await f.plugin.importLegacyReading();
  assert.equal(result.imported, 2);
  assert.equal(result.unresolved, 1, 'a note naming a paper that is gone cannot be placed');
  assert.equal(f.plugin.entry(f.paper).seconds, 1500);
  // Per-page times let the pages column work, not just the total.
  assert.deepEqual(f.plugin.entry(f.paper).readingAttachments['77'],
    {pageTimes: {0: 600, 1: 900}, totalPages: 16});
  assert.equal(f.plugin.entry(f.other).seconds, 120);
  assert.equal(f.plugin.entry(f.other).readingAttachments, undefined, 'no attachment, no page detail');
});

test('our own tracking wins: importing never shortens a longer record', async () => {
  const f = legacyFixture();
  f.plugin.entry(f.paper).seconds = 9000;
  const result = await f.plugin.importLegacyReading();
  assert.equal(f.plugin.entry(f.paper).seconds, 9000, 'the longer total must survive');
  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 1);
  // Running it twice is not additive.
  const again = await f.plugin.importLegacyReading();
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 2);
});

test('a citation row grows with its text and stays operable by keyboard', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item, Z} = fixture();
  const ref = item(1);
  ref.getField = key => ({title: 'A paper with a long title', date: '2024'})[key] || '';
  ref.getCreators = () => [{firstName: 'A', lastName: 'Author'}];
  const copied = [];
  Z.Utilities = {Internal: {copyTextToClipboard: text => copied.push(text)}};
  Z.QuickCopy = null;
  const win = {document, addEventListener() {}, removeEventListener() {}, setTimeout(){}, Event: window.Event};
  await plugin.citationPanel(win, [ref]);
  await new Promise(resolve => setTimeout(resolve, 0));

  const rows = [...document.querySelectorAll('.sc-cite-row')];
  assert.equal(rows.length, plugin.citationFormats.PANEL_STYLES.length);
  // A <button> does not grow with wrapped content in Gecko, so the rows piled
  // on top of each other. They must not be buttons.
  for (const row of rows) {
    assert.notEqual(row.tagName.toLowerCase(), 'button', 'a button will not grow with wrapped text');
    assert.equal(row.getAttribute('role'), 'button', 'it still has to act like one');
    assert.equal(row.getAttribute('tabindex'), '0', 'and be reachable by keyboard');
  }
  // Enter copies, the same as a click.
  rows[0].dispatchEvent(Object.assign(new window.Event('keydown', {bubbles: true}), {key: 'Enter'}));
  assert.equal(copied.length, 1);
  assert.match(copied[0], /Author/);
  // The export links are still buttons, which is correct: their labels do not wrap.
  assert.equal(document.querySelectorAll('.sc-cite-exports button').length,
    plugin.citationFormats.EXPORTS.length);
});

// --- Paper signals: retraction, open access, preprint -> published ---

const CROSSREF_RETRACTED = {DOI: '10.1/paper', type: 'journal-article', title: ['A paper'], relation: {},
  'updated-by': [{DOI: '10.1/notice', type: 'retraction', label: 'Retraction', updated: {'date-parts': [[2010, 2, 6]]}}]};
const CROSSREF_CLEAN = {DOI: '10.1/paper', type: 'journal-article', title: ['A paper'], relation: {}};
const OA_GOLD = {id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1/paper', type: 'article',
  is_retracted: false, open_access: {is_oa: true, oa_status: 'gold', oa_url: 'https://oa.example/paper.pdf'},
  primary_location: {version: 'publishedVersion', source: {display_name: 'A Journal', type: 'journal'}},
  locations: [{version: 'publishedVersion', source: {display_name: 'A Journal', type: 'journal'}}]};

// `answers` pairs a matcher against the request URL with {status, response};
// anything unmatched answers 404, as the live services do.
function signalsFixture({DOI = '10.1/paper', answers = []} = {}) {
  const f = fixture();
  const ref = f.item(1);
  const fields = {title: 'A paper', DOI, date: '2024'};
  ref.getField = key => fields[key] || '';
  ref.getCreators = () => [];
  const asked = [], opened = [];
  f.Z.launchURL = url => opened.push(url);
  f.Z.HTTP = {request: async (method, url, options) => {
    asked.push(url);
    assert.equal(options.successCodes, false, 'a 404 is an answer about the paper, not a transport failure');
    const hit = answers.find(([match]) => match.test(url));
    return hit ? hit[1] : {status: 404, response: null};
  }};
  f.plugin.active = true;
  return {...f, ref, asked, opened};
}

const crossrefAnswer = payload => [/api\.crossref\.org/, {status: 200, response: {message: payload}}];
const openAlexAnswer = payload => [/openalex\.org\/works\/doi:/, {status: 200, response: payload}];

test('a retracted paper is fetched, cached and painted as something you cannot miss', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_RETRACTED), openAlexAnswer(OA_GOLD)]});
  window.ZoteroPane = {itemsView: {getRow: () => ({ref: f.ref})}};

  // Before the lookup the cell must not read as reassurance.
  const blank = f.plugin.renderCell('signals', 0, '', {}, document);
  assert.equal(blank.textContent, '—');
  assert.match(blank.title, /아직 조회하지/);

  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.deepEqual(summary, {ok: 1, 'not-found': 0, unsupported: 0, error: 0});
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted');

  const cell = f.plugin.renderCell('signals', 0, '', {}, document);
  const badge = cell.firstChild;
  assert.equal(badge.textContent, 'RETRACTED');
  // Every other badge is a tinted pill; this one is filled, so it cannot be
  // skimmed past in a list of fifty rows.
  assert.doesNotMatch(badge.style.background, /rgba/);
  assert.equal(badge.style.color, '#FFFFFF');
  badge.dispatchEvent(new window.Event('click', {bubbles: true}));
  assert.deepEqual(f.opened, ['https://doi.org/10.1/notice'], 'the badge opens the retraction notice');
});

test('the signals column sorts the worst news to the top and leaves unchecked papers out of it', async () => {
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_RETRACTED), openAlexAnswer(OA_GOLD)]});
  const unchecked = f.item(2);
  unchecked.getField = key => ({title: 'Another paper', DOI: '10.1/other'})[key] || '';
  assert.equal(f.plugin.value('signals', unchecked), '', 'an unchecked paper has no verdict to sort by');
  await f.plugin.refreshPaperSignals([f.ref]);
  const bad = f.plugin.value('signals', f.ref);

  const g = signalsFixture({answers: [crossrefAnswer(CROSSREF_CLEAN), openAlexAnswer(OA_GOLD)]});
  await g.plugin.refreshPaperSignals([g.ref]);
  const good = g.plugin.value('signals', g.ref);
  assert.ok(bad < good, `retracted (${bad}) must sort above clean (${good})`);
});

test('a lookup that fails leaves a recorded retraction standing', async () => {
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_RETRACTED), openAlexAnswer(OA_GOLD)]});
  await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted');
  f.Z.HTTP.request = async () => { throw new Error('offline'); };
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(summary.error, 1);
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted', 'a blinking network must not clear a retraction');
  assert.equal(f.errors.length, 1);
});

test('a DOI neither service knows records nothing rather than a clean bill of health', async () => {
  const f = signalsFixture({answers: []});
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.deepEqual(summary, {ok: 0, 'not-found': 1, unsupported: 0, error: 0});
  assert.equal(f.plugin.signalsOf(f.ref), null);
  assert.equal(f.errors.length, 0, 'a 404 is not an error to log');
});

test('a paper with no DOI is never sent to either service', async () => {
  const f = signalsFixture({DOI: ''});
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.deepEqual(summary, {ok: 0, 'not-found': 0, unsupported: 1, error: 0});
  assert.deepEqual(f.asked, [], 'a title search would answer about a different paper');
});

test('only a preprint falls back to the title search, and the published version it finds is offered', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const published = {id: 'https://openalex.org/W2', doi: 'https://doi.org/10.1/published', type: 'article',
    publication_year: 2024, open_access: {is_oa: true, oa_status: 'hybrid', oa_url: 'https://oa.example/p.pdf'},
    primary_location: {version: 'publishedVersion', landing_page_url: 'https://doi.org/10.1/published',
      source: {display_name: 'A Journal', type: 'journal'}},
    locations: [
      {version: 'publishedVersion', landing_page_url: 'https://doi.org/10.1/published',
        source: {display_name: 'A Journal', type: 'journal'}},
      {version: 'acceptedVersion', landing_page_url: 'https://doi.org/10.1101/2022.11.11.516073',
        source: {display_name: 'bioRxiv', type: 'repository'}}]};
  // OpenAlex 404s the preprint's own DOI once it has merged it into the
  // published work, which is why the title search exists at all.
  const f = signalsFixture({DOI: '10.1101/2022.11.11.516073', answers: [
    crossrefAnswer({DOI: '10.1101/2022.11.11.516073', type: 'posted-content', subtype: 'preprint',
      title: ['A paper'], relation: {}}),
    [/title\.search/, {status: 200, response: {results: [published]}}]]});
  window.ZoteroPane = {itemsView: {getRow: () => ({ref: f.ref})}};
  await f.plugin.refreshPaperSignals([f.ref]);
  assert.ok(f.asked.some(url => /title\.search/.test(url)), 'the fallback is made for a preprint');
  assert.equal(f.plugin.signalsOf(f.ref).published.doi, '10.1/published');

  const cell = f.plugin.renderCell('signals', 0, '', {}, document);
  const badge = [...cell.children].find(el => el.textContent.startsWith('게재됨'));
  badge.dispatchEvent(new window.Event('click', {bubbles: true}));
  assert.deepEqual(f.opened, ['https://doi.org/10.1/published']);

  // A published article that is simply missing from OpenAlex must not go
  // title-searching: the first same-titled hit is not this paper.
  const g = signalsFixture({answers: [crossrefAnswer(CROSSREF_CLEAN)]});
  await g.plugin.refreshPaperSignals([g.ref]);
  assert.equal(g.asked.filter(url => /title\.search/.test(url)).length, 0);
  assert.equal(g.plugin.signalsOf(g.ref).status, 'ok');
});

test('the open-access link is offered only to a shelf that cannot already open the paper', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_CLEAN), openAlexAnswer(OA_GOLD)]});
  window.ZoteroPane = {itemsView: {getRow: () => ({ref: f.ref})}};
  await f.plugin.refreshPaperSignals([f.ref]);

  const oaBadge = () => [...f.plugin.renderCell('signals', 0, '', {}, document).children]
    .find(el => el.textContent.startsWith('OA'));
  assert.equal(oaBadge().style.cursor, 'pointer');
  oaBadge().dispatchEvent(new window.Event('click', {bubbles: true}));
  assert.deepEqual(f.opened, ['https://oa.example/paper.pdf']);

  // Give the item a PDF of its own and the link becomes noise.
  f.ref.getAttachments = () => [9];
  f.Z.Items = {get: () => ({id: 9, deleted: false, isFileAttachment: () => true,
    attachmentFilename: 'paper.pdf', getTags: () => []})};
  assert.equal(oaBadge().style.cursor, '');
});

test('a caller identifies itself, falling back to the Zotero account address', () => {
  const {plugin, Z} = fixture();
  // The preference was read but never shipped, so this was always empty and
  // every request went to the anonymous pool -- which is what got rate limited.
  Z.Prefs.set('extensions.style-custom.citationEmail', 'me@lab.org', true);
  assert.equal(plugin.contactEmail(), 'me@lab.org');

  // ZotPoP already asks for this; the two plugins should not ask twice.
  Z.Prefs.set('extensions.style-custom.citationEmail', '', true);
  Z.Prefs.set('extensions.zotpop.email', 'shared@lab.org', true);
  assert.equal(plugin.contactEmail(), 'shared@lab.org');

  Z.Prefs.set('extensions.zotpop.email', '', true);
  Z.Prefs.set('sync.server.username', 'account@example.edu', true);
  assert.equal(plugin.contactEmail(), 'account@example.edu', 'the Zotero account stands in');

  // A Zotero username is often not an address; sending rubbish is worse than nothing.
  Z.Prefs.set('sync.server.username', 'jaeyoon', true);
  assert.equal(plugin.contactEmail(), '');
  Z.Prefs.set('extensions.style-custom.citationEmail', 'not an email', true);
  assert.equal(plugin.contactEmail(), '');
});

test('the shipped preferences cover every preference the code reads', async () => {
  const {readFileSync} = await import('node:fs');
  const shipped = new Set([...readFileSync(new URL('../prefs.js', import.meta.url), 'utf8')
    .matchAll(/pref\("extensions\.style-custom\.([^"]+)"/g)].map(m => m[1]));
  const source = readFileSync(new URL('../src/runtime.js', import.meta.url), 'utf8');
  const read = [...source.matchAll(/this\.pref\('([A-Za-z][A-Za-z0-9]*)'/g)].map(m => m[1]);
  const schema = new Set((await import('../src/settings-schema.js')).default.schema.settings.map(row => row.key));
  const known = new Set([...shipped, ...schema]);
  const lower = new Map([...known].map(key => [key.toLowerCase(), key]));
  const missing = [...new Set(read)].filter(key => !known.has(key));
  // A capitalised misspelling is not a preference, it is always undefined --
  // which is how the OpenAlex key silently stopped being sent.
  for (const key of missing) {
    const near = lower.get(key.toLowerCase());
    assert.equal(near, undefined, `"${key}" differs from the declared "${near}" only by case`);
  }
  // contactEmail was read in two places and shipped in none, so it silently
  // stayed empty. Any preference the code reads must exist somewhere.
  assert.deepEqual(missing, [], `preferences read but never shipped: ${missing.join(', ')}`);
});

test('the OpenAlex key is found wherever it was entered, so sweeps are never anonymous', () => {
  const {plugin, Z} = fixture();
  // Both plugins offer a field for it; whichever the user filled must work.
  Z.Prefs.set('extensions.zotpop.openAlexApiKey', 'from-zotpop', true);
  assert.equal(plugin.openAlexKey(), 'from-zotpop');
  Z.Prefs.set('extensions.style-custom.openalexApiKey', 'from-style-custom', true);
  assert.equal(plugin.openAlexKey(), 'from-style-custom', 'this plugin’s own field wins');
  assert.equal(plugin.discoverOptions().apiKey, 'from-style-custom');
  Z.Prefs.set('extensions.style-custom.openalexApiKey', '  ', true);
  assert.equal(plugin.openAlexKey(), 'from-zotpop', 'blank is not a key');
});
