import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Model = require('../src/data.js');
const Runtime = require('../src/runtime.js');

function fixture() {
  const records = new Map();
  const extras = new Map();
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
  function item(id, { libraryID = 1, tags = [{ tag: '#method/CRISPR', type: 1 }], fail = false, extra = '' } = {}) {
    records.set(id, structuredClone(tags));
    extras.set(id, extra);
    return {
      id, libraryID, key: String(id), tags: structuredClone(tags), reloadCount: 0, pendingTags: null,
      // The rating now lives in Extra, so the item has to have one: a fixture
      // without setField let a write path ship that throws on a real item.
      fields: {extra}, pendingFields: null,
      getField(name) { return String((this.pendingFields ?? this.fields)[name] ?? ''); },
      setField(name, value) { this.pendingFields = {...(this.pendingFields ?? this.fields), [name]: String(value)}; },
      isRegularItem: () => true, isEditable: () => libraryID !== 2,
      hasChanged() { return this.pendingTags !== null || this.pendingFields !== null; },
      getTags() { return structuredClone(this.pendingTags ?? this.tags); },
      setTags(tags) { this.pendingTags = structuredClone(tags); },
      _clearChanged(field) { assert.ok(['tags', 'extra'].includes(field)); if (field === 'tags') this.pendingTags = null; else this.pendingFields = null; },
      async save() {
        if (fail) throw new Error('injected disk failure');
        this.tags = structuredClone(this.pendingTags ?? this.tags); this.pendingTags = null;
        this.fields = {...(this.pendingFields ?? this.fields)}; this.pendingFields = null;
        records.set(id, structuredClone(this.tags)); extras.set(id, this.fields.extra ?? '');
      },
      async reload() { this.reloadCount++; this.tags = structuredClone(records.get(id)); this.fields = {extra: extras.get(id) ?? ''}; this.pendingFields = null; }
    };
  }
  const plugin = new Runtime({ Zotero: Z, model: Model, marquee: { attach: () => () => {} }, reading: { attach: () => () => {} }, storage: { read: async () => ({schema:1,items:{}}), write: async () => {} } });
  return { Z, plugin, item, records, extras, columns, observers, errors };
}

test('startup registers typed, namespaced columns and stop removes all registrations', async () => {
  const { plugin, columns, observers } = fixture();
  await plugin.start({ id: 'test@focus', version: '0.1', rootURI: 'file:///focus/' });
  assert.equal(columns.size, 28);
  assert.equal(observers.size, 7);
  await plugin.stop();
  assert.equal(columns.size, 0);
  assert.equal(observers.size, 0);
  await plugin.stop();
});

test('bulk changes persist, preserve unrelated tags, and serial rapid actions compose', async () => {
  const { plugin, item, records, extras } = fixture();
  plugin.active = true;
  const items = [item(1), item(2)];
  await Promise.all([plugin.edit(items, { status: 'reading' }), plugin.edit(items, { rating: 4 })]);
  for (const [id, value] of records) {
    // The status is still a tag and the rating is now the Extra line; reading
    // them together is what the item tree does, and both have to be saved.
    assert.deepEqual(Model.readState(value, extras.get(id)), { status: 'reading', rating: 4 });
    assert.deepEqual(value[0], { tag: '#method/CRISPR', type: 1 });
    assert.equal(extras.get(id), 'Rating: 4');
    assert.equal(value.find(tag => /rating/i.test(tag.tag)), undefined, 'no rating tag is left behind');
  }
  await plugin.edit(items, { status: 'unread', rating: 0 });
  for (const [id, value] of records) {
    assert.deepEqual(Model.readState(value, extras.get(id)), {status:'unread',rating:0});
    assert.equal(extras.get(id), '', 'clearing the rating removes the line rather than writing zero');
  }
});

test('a rating written into Extra leaves every other line of it alone', async () => {
  const { plugin, item, extras } = fixture();
  plugin.active = true;
  const paper = item(1, {extra: 'PMID: 40112233\nCitations: 12 (OpenAlex, 2026-09-01)'});
  await plugin.edit([paper], {rating: 5});
  assert.equal(extras.get(1), 'PMID: 40112233\nCitations: 12 (OpenAlex, 2026-09-01)\nRating: 5');
  await plugin.edit([paper], {rating: 2});
  assert.equal(extras.get(1), 'PMID: 40112233\nCitations: 12 (OpenAlex, 2026-09-01)\nRating: 2');
  await plugin.edit([paper], {rating: 0});
  assert.equal(extras.get(1), 'PMID: 40112233\nCitations: 12 (OpenAlex, 2026-09-01)');
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
  assert.equal(Model.readState(first.tags, first.getField('extra')).rating, 2);
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
  await assert.rejects(plugin.edit([reference], { rating: 3 }), /꺼져 있습니다/);
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
 assert.equal(plugin.state(reference).status,'unread','imported seconds do not outrank an explicit /unread tag');
 assert.equal(plugin.metrics(reference).impactFactor,47.3);
 assert.equal(plugin.metrics(reference).citations,2112);
 plugin.entry(reference).seconds = plugin.metrics(reference).seconds;
 await plugin.addReading(reference, 5);
 await plugin.queue;
 assert.equal(plugin.metrics(reference).seconds,125);
 assert.equal(plugin.state(reference).status,'reading','the first reading tick rewrote /unread to /reading');
 assert.ok(!reference.getTags().some(t=>t.tag==='/unread'));
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

test('the first background write into Extra is explained in the panel later, never by a modal alert',async()=>{
 const {plugin,item,Z}=fixture();plugin.active=true;const ref=citationItem(item,1);ref.fields.extra='';
 ref.setField=(k,v)=>ref.fields[k]=v;ref.saveTx=async()=>{};ref.getCreators=()=>[{creatorTypeID:8,lastName:'Author'}];
 let alerts=0;Z.alert=()=>{alerts++;};Z.getMainWindow=()=>({});
 const result={status:'ok',count:4,source:'OpenAlex',checkedAt:new Date().toISOString(),identity:plugin.citationTools.identity(plugin.citationRecord(ref))};
 await plugin.persistCitation(ref,result);
 assert.equal(alerts,0,'nothing stops the reader');
 assert.equal(plugin.cache.citationExtraNoticePending,true,'the panel says it next time it is open');
});

test('automatic metadata writes preserve unrelated Extra, verified zero and own notifier marker without repeat saves',async()=>{
 const {plugin,item}=fixture();plugin.active=true;const ref=citationItem(item,1);ref.fields.extra='PMID: 123\nNotes: keep this\nCitations: 999 (Old source, 2020-01-01)';
 let saves=0;ref.setField=(k,v)=>ref.fields[k]=v;ref.saveTx=async options=>{saves++;assert.equal(options.notifierData.styleCustomCitations,true);assert.equal(options.skipSelect,true);assert.equal(options.skipDateModifiedUpdate,true,'a background count is not an edit');};
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
 assert.deepEqual(plugin.pageProgress(ref,100),{total:10,visited:1,percent:10,pages:{0:5},attachmentID:100,lastPageIndex:0});
 assert.deepEqual(plugin.pageProgress(ref),{total:3,visited:1,percent:33,pages:{1:7},attachmentID:200,lastPageIndex:1},'the page last open is kept, for 이어 읽기');
 assert.equal(plugin.metrics(ref).seconds,12);assert.ok(plugin.entry(ref).lastRead);
 // Time to the page it was spent on, resume at the page up when it was counted -- on the same PDF only.
 await plugin.addReading(ref,4,{attachmentID:100,pageIndex:0,totalPages:10},{attachmentID:100,pageIndex:5,totalPages:10});
 assert.equal(plugin.pageProgress(ref,100).lastPageIndex,5);assert.equal(plugin.pageProgress(ref,100).pages[0],9);
 await plugin.addReading(ref,1,{attachmentID:100,pageIndex:0,totalPages:10},{attachmentID:200,pageIndex:2,totalPages:3});
 assert.equal(plugin.pageProgress(ref,100).lastPageIndex,0,'another PDF on screen is not this one’s place');
 const before=JSON.stringify(plugin.entry(ref).readingAttachments);await plugin.addReading(ref,1,{attachmentID:200,pageIndex:50,totalPages:3});assert.equal(JSON.stringify(plugin.entry(ref).readingAttachments),before);
});
test('legacy unbound progress is not assigned to a PDF or another library',()=>{
 const {plugin,item,Z}=fixture();Z.Libraries.userLibraryID=1;plugin.legacy={'1':{readingTime:{page:5,data:{0:30}}}};
 assert.equal(plugin.pageProgress(item(1)).attachmentID,null);assert.equal(plugin.pageProgress(item(1)).visited,1);
 assert.equal(plugin.pageProgress(item(1),99).visited,0);assert.equal(plugin.pageProgress(item(1,{libraryID:2})).visited,0);
});
test('custom columns are validated and registration failure keeps previous fields intact',async()=>{
 const {plugin,Z,columns,item}=fixture();await plugin.start({id:'custom',version:'0.5',rootURI:'file:///custom/'});
 Z.ItemFields={getID:name=>['volume','issue','pages'].includes(name)};plugin.setCustomFields('volume, issue');assert.equal(columns.size,30);
 const original=Z.ItemTreeManager.registerColumn;Z.ItemTreeManager.registerColumn=options=>options.dataKey==='field-pages'?false:original(options);
 assert.throws(()=>plugin.setCustomFields('volume, pages'));assert.equal(columns.size,30);assert.ok(plugin.dynamicFieldMap.has('issue'));
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

test('Zotero\'s zone-less UTC dates are drawn in the reader\'s clock, and "9시간 전" is no longer a minute ago',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin}=fixture();
 window.ZoteroPane=undefined;// no row behind the cell: the value given is the one drawn
 const stored='2026-09-27 03:00:00';
 assert.equal(plugin.localStamp(stored).toISOString(),'2026-09-27T03:00:00.000Z','read as UTC, not as local time');
 assert.equal(plugin.localStamp('2026-09-27T03:00:00.000Z').toISOString(),'2026-09-27T03:00:00.000Z');
 assert.equal(plugin.localStamp(''),null);
 const local=new Date(Date.UTC(2026,8,27,3,0,0));
 const two=n=>String(n).padStart(2,'0');
 plugin.getSetting=key=>key==='dateDisplay'?'absolute':undefined;
 assert.equal(plugin.renderCell('added',0,stored,{},document).textContent,`${local.getFullYear()}-${two(local.getMonth()+1)}-${two(local.getDate())} ${two(local.getHours())}:${two(local.getMinutes())}`);
 plugin.getSetting=key=>key==='dateDisplay'?'relative':undefined;
 const minuteAgo=new Date(Date.now()-60000).toISOString().replace('T',' ').slice(0,19);
 assert.equal(plugin.renderCell('added',0,minuteAgo,{},document).textContent,'1분 전');
});

test('the citation dialog exports through Zotero\'s translators, and EndNote and duplicate BibTeX keys work without them',async()=>{
 const {plugin,item,Z}=fixture();const a=item(1),b=item(2);
 plugin.bibliographyRecord=()=>({title:'Same title',year:2020,venue:'Cell',creators:[{lastName:'Smith',firstName:'A',creatorType:'author'}]});
 delete Z.Translate;
 const endnote=await plugin.citationText([a],{key:'endnote'});
 assert.match(endnote,/^%0 Journal Article/m,'EndNote no longer ends in "Unknown citation style"');
 const bib=await plugin.citationText([a,b],{key:'bibtex'});
 const keys=[...bib.matchAll(/^@\w+\{([^,]+),/gm)].map(m=>m[1]);
 assert.equal(new Set(keys).size,2,'two smith2020s get two keys');
 let used=null;Z.Translate={Export:class{setItems(){}setTranslator(id){used=id;}async translate(){this.string='@book{smith2020book,\n}';}}};
 assert.equal(await plugin.citationText([a],{key:'bibtex'}),'@book{smith2020book,\n}','Zotero\'s own translator is asked first');
 assert.equal(used,'9cb70025-a888-4a29-a210-93ec52da40d4');
});

test('a status or rating is greyed in the menu only when every selected paper already has it',()=>{
 const {plugin,item}=fixture();const a=item(1),b=item(2);
 plugin.isRegular=()=>true;
 plugin.state=ref=>ref===a?{status:'done',rating:3}:{status:'unread',rating:0};
 assert.equal(plugin.alreadySo([a,b],'status','done'),false,'the second paper can still be marked read');
 assert.equal(plugin.alreadySo([a],'status','done'),true);
 assert.equal(plugin.alreadySo([a,b],'rating','3'),false);
 assert.equal(plugin.alreadySo([],'status','done'),false);
});

test('impact factors sort by value under Zotero\'s numeric-aware collation, with blanks last either way',()=>{
 const {plugin,item,Z}=fixture();const ref=item(1);
 let direction=1;Z.getMainWindow=()=>({ZoteroPane:{itemsView:{getSortDirection:()=>direction}}});
 const key=n=>{plugin.state=()=>({impactFactor:n});return [plugin.value('if',ref),n];};
 // Zotero 9.0.6: Intl.Collator numeric compare, the result times the direction.
 const collate=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'}).compare;
 const order=values=>values.map(key).sort((a,b)=>collate(a[0],b[0])*direction).map(pair=>pair[1]);
 assert.deepEqual(order([12.25,12.5,null,4.123,0,4.5,50]),[0,4.123,4.5,12.25,12.5,50,null],'up: 12.5 above 12.25, the blank last');
 direction=-1;
 assert.deepEqual(order([12.25,12.5,null,4.123,0,4.5,50]),[50,12.5,12.25,4.5,4.123,0,null],'down: highest first, the blank still last');
 plugin.state=()=>({impactFactor:null});plugin.journalCitedness=()=>({citedness:18.9,name:'Nature'});
 assert.equal(plugin.displayValue('if',ref),'','the IF column is the JIF alone');
 assert.equal(plugin.displayValue('oaCitedness',ref),'18.9','OpenAlex\'s figure has its own column');
});

test('a label in the item list is a word in its colour, not a tinted capsule',async()=>{
 const {parseHTML}=await import('linkedom');const {document}=parseHTML('<html><body></body></html>');const {plugin}=fixture();
 const P=plugin.palette(document);
 const chip=plugin.pill(document,'철회','#c62828',P);
 assert.doesNotMatch(chip.style.cssText,/background/,'no tinted fill');
 assert.doesNotMatch(chip.style.cssText,/border-radius:100px/,'no rounded capsule ends');
 assert.match(chip.style.cssText,/color:#c62828/,'the colour that means something stays');
 assert.match(chip.style.cssText,/font-size:11px/);
});

test('a reading tick repaints only that paper\'s cells, and the status reads in words',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item,Z}=fixture();
 const a=item(1),b=item(2);Z.Items={get:id=>({1:a,2:b})[id]};plugin.isRegular=()=>true;
 const asked=[];plugin.state=ref=>{asked.push(ref.id);return {seconds:120,status:'reading'};};
 const cell=(id,kind)=>{const c=document.createElement('span');c.dataset.styleCustomReading=kind;c.dataset.itemId=String(id);if(kind==='status'){c.append(document.createElement('span'),document.createElement('span'));}document.body.append(c);return c;};
 cell(1,'time');const status=cell(1,'status');cell(2,'time');cell(2,'status');
 window.closed=false;plugin.windows=new Map([[window,{}]]);
 plugin.refreshReadingDisplays(1);
 assert.deepEqual([...new Set(asked)],[1],'the other row is left alone');
 assert.equal(status.lastChild.textContent,'읽는 중','not the stored word "reading"');
});

test('the click that selects a row does not also change its status; a click on a selected row does',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item}=fixture();const ref=item(1);
 let selected=false;window.ZoteroPane={itemsView:{getRow:()=>({ref}),selection:{isSelected:()=>selected}}};
 plugin.isRegular=()=>true;plugin.canEdit=()=>true;plugin.value=()=>'0';const edits=[];plugin.edit=async(items,change)=>{edits.push(change);};
 const cell=plugin.renderCell('status',0,'0',{},document);
 const press=()=>{cell.dispatchEvent(new window.Event('mousedown',{bubbles:true}));selected=true;cell.dispatchEvent(new window.Event('click',{bubbles:true}));};
 press();
 assert.equal(edits.length,0,'the first click only selected the row');
 press();
 assert.deepEqual(edits,[{status:'reading'}],'the second, on a selected row, changes it');
 window.ZoteroPane=undefined;
});

test('the annotation strip is worked out once per change, and its page marks are not Tab stops',async()=>{
 const {plugin,item,Z}=fixture(),ref=item(1);ref.getAttachments=()=>[9];
 let parses=0;const note={annotationColor:'#ffd400',dateModified:'2026-09-01 00:00:00',get annotationPosition(){parses++;return JSON.stringify({pageIndex:2,rects:[[0,0,1,1]]});}};
 const list=[note];Z.Items={get:()=>({getAnnotations:()=>list})};
 plugin.annotationDistribution(ref);plugin.annotationDistribution(ref);
 assert.equal(parses,1,'the second paint reuses the first answer');
 list.push({...note,dateModified:'2026-09-02 00:00:00',annotationPosition:JSON.stringify({pageIndex:5,rects:[[0,0,1,1]]})});
 assert.equal(plugin.annotationDistribution(ref).length,2,'a new annotation is seen');
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};plugin.isRegular=()=>true;plugin.value=()=>'2';
 const cell=plugin.renderCell('annotationCount',0,'2',{},document);
 const marks=[...cell.querySelectorAll('button')];assert.ok(marks.length>0,'the strip is drawn');
 for(const b of marks)assert.equal(String(b.tabIndex??b.getAttribute('tabindex')),'-1');
 window.ZoteroPane=undefined;
});

test('an installed CSL style draws the dialog\'s citation, and the hand-made format stands in when it is missing',async()=>{
 const {plugin,item,Z}=fixture();const a=item(1);
 plugin.bibliographyRecord=()=>({title:'T',year:2020,venue:'Cell',creators:[{lastName:'Kim',firstName:'A',creatorType:'author'}]});
 const apa=plugin.citationFormats.PANEL_STYLES.find(s=>s.key==='apa');
 let asked=null;Z.QuickCopy={getContentFromItems:async(items,format)=>{asked=format;return {text:'Kim, A. (2020). T. Cell.'};}};
 assert.equal(await plugin.citationText([a],apa),'Kim, A. (2020). T. Cell.');
 assert.equal(asked,'bibliography=http://www.zotero.org/styles/apa');
 Z.QuickCopy={getContentFromItems:async()=>({text:''})};
 assert.match(await plugin.citationText([a],apa),/Kim/,'the local format when the style is not installed');
});

test('a changed annotation drops its paper\'s strip memo when Zotero says so, even mid-sync',async()=>{
 const {plugin,Z}=fixture();let observer;
 Z.Notifier={registerObserver:o=>{observer=o;return 'observer';},unregisterObserver:()=>{}};
 await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
 const annotation={id:30,parentID:20,isAnnotation:()=>true},pdf={id:20,parentID:10};
 Z.Items={...Z.Items,get:id=>({30:annotation,20:pdf})[id]};
 plugin.annotationMemo=new Map([[10,{key:'k',pages:[]}],[11,{key:'k',pages:[]}]]);
 Z.Sync={Runner:{syncInProgress:true}};
 observer.notify('add','item',[30],{});
 assert.equal(plugin.annotationMemo.has(10),false,'a new annotation: the paper it was added to');
 assert.equal(plugin.annotationMemo.has(11),true,'and no other');
 observer.notify('modify','item',[30],{});
 assert.equal(plugin.annotationMemo.has(11),false,'a changed one may have moved between papers: all');
 plugin.annotationMemo.set(12,{key:'k',pages:[]});
 observer.notify('delete','item',[99],{});
 assert.equal(plugin.annotationMemo.size,0,'a deletion clears all');
 await plugin.stop();
});

test('while Zotero\'s notifier watches, a painted strip reads no annotation at all until told something changed',()=>{
 const {plugin,item,Z}=fixture(),ref=item(1);ref.getAttachments=()=>[9];
 let touched=0;Z.Items={get:()=>({getAnnotations:()=>{touched++;return [{annotationColor:'#ffd400',annotationPosition:JSON.stringify({pageIndex:1,rects:[[0,0,1,1]]})}];}})};
 plugin.itemObserver='watching';
 plugin.annotationDistribution(ref);const first=touched;
 plugin.annotationDistribution(ref);plugin.annotationDistribution(ref);
 assert.equal(touched,first,'the second and third paints read nothing');
 plugin.annotationMemo.delete(ref.id);plugin.annotationDistribution(ref);
 assert.ok(touched>first,'after the notifier drops it, it is read again');
});

test('the collection column names every path from the root, shortest-sort groups the same folder, and a held answer is not re-walked',()=>{
 const {plugin,item,Z}=fixture();
 const nodes={10:{id:10,name:'Type I Cas',parentID:11},11:{id:11,name:'CRISPR-Cas',parentID:12},
  12:{id:12,name:'Defense system',parentID:null},20:{id:20,name:'Reviews',parentID:null}};
 let walks=0;Z.Collections={get:id=>{walks++;return nodes[id];}};
 const ref=item(1);ref.getCollections=()=>[10,20];
 assert.equal(plugin.collectionPath(10),'Defense system › CRISPR-Cas › Type I Cas');
 walks=0;
 const entries=plugin.collectionEntries(ref);
 assert.deepEqual(entries.map(e=>e.path),['Defense system › CRISPR-Cas › Type I Cas','Reviews'],'sorted by path, so the same folder groups');
 // The sort key is the full path, so it survives a search re-sort untouched.
 assert.equal(plugin.value('collections',ref),'Defense system › CRISPR-Cas › Type I Cas · Reviews');
 assert.ok(walks>0,'walked the tree to answer the first time');
 plugin.itemObserver='watching';
 const before=walks;
 assert.deepEqual(plugin.collectionEntries(ref),entries,'held answer, not a fresh walk');
 assert.equal(walks,before,'no collection was read again');
 // A child row and an item filed nowhere both draw nothing.
 const child={...ref,isRegularItem:()=>false};
 assert.deepEqual(plugin.collectionEntries(child),[]);
 assert.equal(plugin.value('collections',child),'');
 const unfiled=item(2);unfiled.getCollections=()=>[];
 assert.deepEqual(plugin.collectionEntries(unfiled),[]);
 assert.equal(plugin.value('collections',unfiled),'');
});

test('a collection rename or a paper moved into one drops every path cached under the old membership',async()=>{
 const {plugin,Z}=fixture();let observer;
 Z.Notifier={registerObserver:o=>{observer=o;return 'observer';},unregisterObserver:()=>{}};
 await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
 plugin.collectionMemo=new Map([[1,{ids:'10',entries:[{id:10,path:'Old name'}]}]]);
 observer.notify('modify','collection',[10],{});
 assert.equal(plugin.collectionMemo.size,0,'a renamed or moved collection clears the whole memo');
 plugin.collectionMemo=new Map([[1,{ids:'10',entries:[{id:10,path:'Folder'}]}]]);
 observer.notify('add','collection-item',['10-2'],{});
 assert.equal(plugin.collectionMemo.size,0,'a paper filed or unfiled clears the whole memo too');
 await plugin.stop();
});

test('the collection cell keeps only the last two levels; the tooltip names every full path, one per line',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');
 const {plugin,item}=fixture(),ref=item(1);
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 plugin.collectionEntries=r=>r===ref?[{id:10,path:'Defense system › CRISPR-Cas › Type I Cas'},{id:20,path:'Reviews'}]:[];
 const cell=plugin.renderCell('collections',0,'',{},document);
 assert.equal(cell.textContent,'CRISPR-Cas › Type I Cas · Reviews','abbreviated to the last two levels in the cell');
 assert.equal(cell.title,'Defense system › CRISPR-Cas › Type I Cas\nReviews','the full path, one per line, in the tooltip');
 plugin.collectionEntries=()=>[];
 const empty=plugin.renderCell('collections',0,'',{},document);
 assert.equal(empty.textContent,'','nothing drawn for an unfiled paper');
 assert.equal(empty.title,'컬렉션 없음','said only in the tooltip');
});

test('an installed CSL style draws any number of papers through one processor, not Quick Copy\'s fifty',async()=>{
 const {plugin,item,Z}=fixture();const items=Array.from({length:51},(_,i)=>item(i+1));
 plugin.bibliographyRecord=()=>({title:'T',year:2020,creators:[]});
 let freed=0,given=0;Z.Styles={get:url=>({getCiteProc:()=>({free(){freed++;}})})};
 Z.Cite={makeFormattedBibliographyOrCitationList:(cp,list)=>{given=list.length;return 'fifty-one entries';}};
 Z.QuickCopy={getContentFromItems:async()=>{throw new Error('should not be needed');}};
 const apa=plugin.citationFormats.PANEL_STYLES.find(s=>s.key==='apa');
 assert.equal(await plugin.citationText(items,apa),'fifty-one entries');
 assert.equal(given,51,'all of them, in one go');assert.equal(freed,1,'and the processor is let go');
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
 assert.deepEqual([...cell.children].map(el=>el.textContent),['PDF']);
 assert.match(cell.title,/본문 1개/);
 // Nothing has read the file yet, and the cell says which question is still open
 // rather than claiming there is no supplementary file.
 assert.match(cell.title,/아직 내용을 읽어보지 않았습니다/);
});

test('the files cell tells a supplement, a duplicate and a mis-filed paper apart',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');
 const {plugin,item,Z}=fixture();const ref=item(1);
 ref.getAttachments=()=>[1,2,3,4];
 const files={1:'article.pdf',2:'si.pdf',3:'again.pdf',4:'other.pdf'};
 Z.Items={get:id=>({id,attachmentFilename:files[id],isFileAttachment:()=>true})};
 plugin.cache.fileKinds={
  '1':{kind:'article'},'2':{kind:'supplementary',why:'says so in its opening words'},
  '3':{kind:'duplicate',duplicateOf:'1'},'4':{kind:'foreign',why:'never uses the title'}};
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 const cell=plugin.renderCell('files',0,'',{},document);
 // Three different things used to render as "SI x3", which is what made the
 // badge not worth looking at.
 assert.deepEqual([...cell.children].map(el=>el.textContent),['PDF','SI','중복','다른 논문']);
 assert.match(cell.title,/본문 1개 · 보충자료 1개 · 중복 1개 · 다른 논문 1개/);
 assert.equal(plugin.value('files',ref),'PDF×1 · SI×1 · 중복×1 · 다른논문×1');
});

test('status rating and impact cells carry colour that tracks the value instead of one flat style',async()=>{
 const {parseHTML}=await import('linkedom');const {document,window}=parseHTML('<html><body></body></html>');const {plugin,item}=fixture();const ref=item(1);
 window.ZoteroPane={itemsView:{getRow:()=>({ref})}};
 const P=plugin.palette(document);
 const status=label=>{plugin.value=(key)=>key==='status'?String({unread:0,reading:1,done:2}[label]):'';return plugin.renderCell('status',0,'',{},document).firstChild.style.color;};
 // One hue deepening as the paper progresses, rather than three unrelated
 // colours: nothing started is neutral, in progress a light sage, finished the
 // full green. The glyph runs the same progression, so the two agree.
 assert.deepEqual([status('unread'),status('reading'),status('done')],[P.muted,P.reading,P.done]);
 const light=hex=>{const n=parseInt(hex.slice(1),16);return (n>>16&255)+(n>>8&255)+(n&255);};
 assert.ok(light(P.reading)>light(P.done),'in progress is the lighter of the two');
 assert.notEqual(P.reading,P.done);
 // The tier still exists, for the tooltip and for sorting; what changed is that
 // it no longer paints the number, which said the same thing twice.
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
  assert.deepEqual(plugin.columnDefinitions.slice(0, 4).map(c => c[1]), ['저널', 'IF', '피인용', '상태'], 'the labels are dictionary keys; the header reads in the interface language');
});

test('citation bars all start at the same x, so their lengths can be compared', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const track = count => {
    plugin.displayValue = key => key === 'citations' ? String(count) : '';
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
  // Where the work was done and who answers for it come along with the name:
  // neither is anywhere in a Zotero record, and both are on every authorship.
  assert.deepEqual(people, [{id: 'A1', name: 'A Zongo', institution: 'Institut Pasteur',
    institutions: [{institution: 'Institut Pasteur', ror: ''}],
    ror: '', country: '', corresponding: false, position: 'first'}]);
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

test('importing a paper already on the shelf is reported and not done twice, by DOI and then by title', async () => {
  const f = discoverFixture();
  const held = f.item(1);
  let doi = '10.1038/s41467-024-48219-y';
  held.isRegularItem = () => true;
  held.getField = key => ({title: 'An antiplasmid system defends bacteria', DOI: doi, date: '2024'})[key] || '';
  f.Z.Items = {...(f.Z.Items || {}), getAll: async () => [held]};
  let translated = 0;
  f.Z.Translate = {Search: class {
    setIdentifier() {} setTranslator() {}
    async getTranslators() { return ['t']; }
    async translate() { translated++; return [{getField: () => 'Saved'}]; }
  }};
  const win = {ZoteroPane: {getSelectedCollection: () => ({id: 7, name: 'Review'}), getSelectedLibraryID: () => 1}};
  const byDOI = await f.plugin.importWork({doi: 'https://doi.org/10.1038/S41467-024-48219-Y', title: 'x'}, win);
  assert.equal(byDOI.existing, true);
  assert.equal(byDOI[0], held);
  // A preprint copy under another DOI is a different version while the shelf copy has a DOI of its own...
  const conflicting = {doi: '10.1101/2024.01.01.555', title: 'An antiplasmid system defends bacteria', year: 2024};
  await f.plugin.importWork(conflicting, win);
  assert.equal(translated, 1, 'two DOIs that disagree are two papers, so this one is imported');
  // ...and the same paper when the shelf copy has none: title and year decide.
  doi = '';
  const byTitle = await f.plugin.importWork(conflicting, win);
  assert.equal(byTitle.existing, true);
  assert.equal(translated, 1, 'nothing more was imported');
});

test('a fresh import says which collection it went into', async () => {
  const f = discoverFixture();
  f.Z.Items = {...(f.Z.Items || {}), getAll: async () => []};
  f.Z.Translate = {Search: class {
    setIdentifier() {} setTranslator() {}
    async getTranslators() { return ['t']; }
    async translate() { return [{getField: () => 'Saved'}]; }
  }};
  const win = {ZoteroPane: {getSelectedCollection: () => ({id: 7, name: 'Review'}), getSelectedLibraryID: () => 1}};
  const saved = await f.plugin.importWork({doi: '10.1/new', title: 'New'}, win);
  assert.equal(saved.existing, false);
  assert.equal(saved.collectionName, 'Review');
  const bare = await f.plugin.importWork({doi: '10.1/new2', title: 'New'}, {ZoteroPane: {getSelectedLibraryID: () => 1}});
  assert.equal(bare.collectionName, '');
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

test('the author page counts news as the watchlist card does, and asks OpenAlex once a session', async () => {
  const f = discoverFixture();
  await f.plugin.watchAuthor({id: 'A1', name: 'A Zongo', seen: []});
  f.plugin.discoverCache.clear();
  const original = f.Z.HTTP.request;
  let asked = 0;
  f.Z.HTTP.request = async (method, url) => {
    if (/author\.id/.test(url)) { asked++; return {response: {results: [
      {id: 'https://openalex.org/W77', title: 'A paper', publication_year: 2026, type: 'article', cited_by_count: 0},
      {id: 'https://openalex.org/W78', title: 'A repository deposit', publication_year: 2026, type: 'dataset', cited_by_count: 0}]}}; }
    return original(method, url);
  };
  const first = await f.plugin.authorUpdates('A1');
  assert.deepEqual(first.fresh.map(w => w.title), ['A paper'], 'a dataset is not a new paper here either');
  await f.plugin.authorUpdates('A1');
  assert.equal(asked, 1, 'opening the page again costs nothing');
});

test('titles for bare OpenAlex IDs are asked once and remembered', async () => {
  const f = discoverFixture();
  let asked = 0;
  f.Z.HTTP.request = async (method, url) => {
    asked++;
    return {response: {results: [{id: 'https://openalex.org/W99', title: 'The paper everyone cites', publication_year: 2001, doi: 'https://doi.org/10.1/W99'}]}};
  };
  f.plugin.flush = async () => {};
  const first = await f.plugin.worksByID(['W99', 'https://openalex.org/W99']);
  assert.equal(first.W99.title, 'The paper everyone cites');
  assert.equal(first.W99.doi, '10.1/w99');
  await f.plugin.worksByID(['W99']);
  assert.equal(asked, 1, 'the second time costs nothing');
});

test('after OpenAlex refuses for budget, no OpenAlex request is sent until it resets', async () => {
  const f = discoverFixture();
  let sent = 0;
  f.Z.HTTP.request = async (method, url) => { sent++; throw Object.assign(new Error('HTTP 429 ' + url), {status: 429, xmlhttp: {status: 429, response: {error: 'Insufficient budget'}}}); };
  await assert.rejects(f.plugin.discoverJSON('https://api.openalex.org/works?filter=x'));
  await assert.rejects(f.plugin.discoverJSON('https://api.openalex.org/authors/A1'), error => error.held === true);
  assert.equal(sent, 1, 'the second request never left');
  assert.equal(f.plugin.outOfBudget({status: 429}), true, 'and reads as a spent budget to every loop');
  f.Z.HTTP.request = async () => ({response: {ok: true}});
  assert.deepEqual(await f.plugin.discoverJSON('https://pub.orcid.org/v3.0/x'), {ok: true}, 'other services are not held');
  // A 404 for a paper whose title says "budget" is a 404.
  const g = discoverFixture();
  let sentAfter = 0;
  g.Z.HTTP.request = async (method, url) => { sentAfter++; if (sentAfter === 1) throw Object.assign(new Error('HTTP 404 ' + url), {status: 404}); return {response: {ok: true}}; };
  await assert.rejects(g.plugin.discoverJSON('https://api.openalex.org/works?filter=title.search:budget%20allocation'));
  assert.deepEqual(await g.plugin.discoverJSON('https://api.openalex.org/works?filter=x'), {ok: true}, 'the next request is sent');
  // The citation and signal lookups hold too.
  let later = 0;
  f.Z.HTTP.request = async () => { later++; return {status: 200, response: {}}; };
  const http = f.plugin.citationHTTP(new AbortController().signal);
  await assert.rejects(http.getJSON('https://api.openalex.org/works/doi:10.1/x'), error => error.held === true);
  await assert.rejects(f.plugin.signalsJSON('https://api.openalex.org/works/doi:10.1/x'), error => error.held === true);
  assert.equal(later, 0, 'neither left');
  await http.getJSON('https://api.crossref.org/works/10.1/x');
  assert.equal(later, 1, 'Crossref is not held');
});

test('a paper without a DOI is matched among five title hits, not taken as the first one', async () => {
  const f = discoverFixture();
  const fields = {title: 'An antiplasmid system in Vibrio', date: '2024'};
  f.ref.getField = key => fields[key] || '';
  const hit = (id, title, author) => ({id: 'https://openalex.org/' + id, title, publication_year: 2024,
    authorships: [{author: {id: 'https://openalex.org/' + author, display_name: author}, author_position: 'first', institutions: []}]});
  f.Z.HTTP.request = async (method, url) => /title\.search/.test(decodeURIComponent(url))
    ? {response: {results: [hit('W1', 'Plasmid systems in yeast', 'AWrong'), hit('W2', 'An antiplasmid system in Vibrio.', 'ARight')]}}
    : {response: {results: []}};
  const people = await f.plugin.authorsOf(f.ref);
  assert.deepEqual(people.map(p => p.name), ['ARight'], 'the second hit, which is this paper');
  f.Z.HTTP.request = async () => ({response: {results: [hit('W1', 'Plasmid systems in yeast', 'AWrong')]}});
  await assert.rejects(f.plugin.authorsOf(f.ref), /제목이 다릅니다/, 'no match is said, not guessed');
});

test('a DOI filled in or corrected drops what was fetched for the old one, and asks nothing', async () => {
  const f = discoverFixture();
  const fields = {title: 'An antiplasmid system', DOI: '10.1/old', date: '2024'};
  f.ref.getField = key => fields[key] || '';
  const key = f.plugin.identity(f.ref);
  f.plugin.paperWorks()[key] = {doi: '10.1/old', references: ['W7']};
  f.plugin.citedByStore()[key] = {citers: []};
  f.plugin.readingPathStore()[key] = {at: new Date().toISOString(), seed: 'doi:10.1/old', plan: {v: f.plugin.PATH_VERSION}};
  assert.equal(f.plugin.forgetIfIdentityChanged(f.ref), false, 'the same DOI: nothing to drop');
  fields.DOI = '10.1/new';
  let asked = 0; f.Z.HTTP.request = async () => { asked++; return {response: {}}; };
  assert.equal(f.plugin.forgetIfIdentityChanged(f.ref), true);
  assert.equal(f.plugin.paperWorks()[key], undefined);
  assert.equal(f.plugin.citedByStore()[key], undefined);
  assert.equal(f.plugin.readingPathStore()[key], undefined);
  assert.equal(asked, 0, 'the next look asks, not the edit');
  f.plugin.entry(f.ref).signals = {status: 'retracted'};
  fields.DOI = '10.1/third';
  f.plugin.forgetIfIdentityChanged(f.ref);
  assert.equal(f.plugin.entry(f.ref).signals, undefined, 'a retraction found for the old DOI is not shown on the new one');
});

test('an institution lookup that failed is asked again; "not found" holds for ninety days only', async () => {
  const f = discoverFixture();
  const key = 'x';
  f.plugin.paperWorks()[key] = {doi: '10.1/a', people: [{name: 'A', position: 'first', corresponding: true, ror: 'https://ror.org/0abc'}]};
  f.plugin.active = true;
  let fail = true, asked = 0;
  f.Z.HTTP.request = async () => { asked++; if (fail) throw Object.assign(new Error('HTTP 503'), {status: 503}); return {response: {results: []}}; };
  await f.plugin.sweepInstitutions();
  assert.equal(Object.keys(f.plugin.institutionTable()).length, 0, 'a failed batch writes nothing');
  fail = false;
  await f.plugin.sweepInstitutions();
  assert.equal(asked, 2, 'so the next sweep asks again');
  const row = Object.values(f.plugin.institutionTable())[0];
  assert.equal(row.unknown, true, 'an answered batch without it is "not found"');
  await f.plugin.sweepInstitutions();
  assert.equal(asked, 2, 'which is not asked again soon');
  row.checkedAt = new Date(Date.now() - 100 * 864e5).toISOString();
  await f.plugin.sweepInstitutions();
  assert.equal(asked, 3, 'but is after ninety days');
});

test('the last author\'s lab is kept when no one is marked corresponding', async () => {
  const f = discoverFixture();
  f.plugin.active = true;
  const person = (name, position) => ({author: {id: 'https://openalex.org/' + name, display_name: name}, author_position: position, institutions: [{id: 'https://openalex.org/I' + name, display_name: name + ' Lab', ror: 'https://ror.org/0' + name}]});
  f.Z.HTTP.request = async () => ({response: {results: [{id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1038/s41467-024-48219-y', title: 'An antiplasmid system',
    authorships: [person('First', 'first'), person('Middle', 'middle'), person('Last', 'last')], referenced_works: []}]}});
  f.plugin.flush = async () => {}; f.plugin.refreshWindows = async () => {}; f.plugin.sweepInstitutions = async () => 0;
  await f.plugin.sweepPaperWorks([f.ref]);
  const kept = f.plugin.paperWorks()[f.plugin.identity(f.ref)].people.map(p => p.name);
  assert.deepEqual(kept, ['First', 'Last'], 'the lab the row names is still there after a restart');
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
  // The cap used to be 100 while the user already followed 109, so every
  // addition failed. It is now set where the stored news starts to cost
  // something, not where one-request-per-author used to.
  f.plugin.cache.watchedAuthors = Array.from({length: 109}, (_, i) => ({id: 'A' + i, name: 'x', seen: []}));
  await f.plugin.watchAuthor({id: 'A999', name: 'still room'});
  assert.equal(f.plugin.watchedAuthors().length, 110);
  const limit = f.plugin.WATCH_LIMIT;
  f.plugin.cache.watchedAuthors = Array.from({length: limit}, (_, i) => ({id: 'A' + i, name: 'x', seen: []}));
  await assert.rejects(() => f.plugin.watchAuthor({id: 'A' + limit, name: 'one too many'}), new RegExp(String(limit)));
  // Re-following someone already on the list is not growth.
  await f.plugin.watchAuthor({id: 'A5', name: 'already there'});
  assert.equal(f.plugin.watchedAuthors().length, limit);
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
  // A filled star is a mark, not text, so it can be the light warm colour a
  // star is supposed to be rather than the dark ochre that read as dirt.
  assert.deepEqual(stars.map(s => s.style.color), [P.star, P.star, P.star, P.faint, P.faint]);
  assert.equal(stars[0].style.fontSize, '13px');
  assert.notEqual(P.star, P.faint);
  assert.notEqual(P.star, P.gold);
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
  assert.equal(onlyStars.getField('extra'), 'Rating: 4', 'the rating must survive the tag it lived in');
  assert.ok(!tags.some(t => /[★⭐]/.test(t)), 'the visible tag is what was cluttering the title');
  assert.ok(tags.includes('Topic'), 'unrelated tags are untouched');
  assert.deepEqual(tags, ['Topic'], 'no replacement tag is written in its place');
  assert.equal(plugin.state(onlyStars).rating, 4, 'the rating still reads back the same');
});

test('the rating tags already in the library move to Extra in one pass per rating', async () => {
  const {plugin, item, Z} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  // Eighty of these exist in the real library, spread over five ratings.
  const rated = [3, 5, 3, 1, 5, 5].map((n, i) =>
    item(i + 1, {tags: [{tag: 'style-custom:rating:' + n, type: 1}, {tag: 'Topic'}]}));
  Z.Items = {...(Z.Items || {}), getAll: async () => rated};
  const found = await plugin.visibleRatingTagItems(1);
  assert.equal(found.length, 6, 'an automatic rating tag still shows in the selector, so it still counts');
  let transactions = 0;
  const run = Z.DB.executeTransaction;
  Z.DB.executeTransaction = fn => { transactions++; return run.call(Z.DB, fn); };
  const {fixed, skipped} = await plugin.hideRatingTags(found);
  assert.equal(fixed, 6);
  assert.equal(skipped, 0);
  assert.equal(transactions, 3, 'three distinct ratings, three writes -- not one per item');
  for (const [i, paper] of rated.entries()) {
    assert.equal(paper.getField('extra'), 'Rating: ' + [3, 5, 3, 1, 5, 5][i],
      'grouping must never move a rating from one paper to another');
    assert.deepEqual(paper.getTags().map(t => t.tag), ['Topic']);
  }
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

test('items carrying a star tag are found, and ones without are not', async () => {
  const {plugin, item, Z} = fixture();
  const starred = item(1, {tags: [{tag: '⭐⭐⭐'}]});
  const emoji = item(2, {tags: [{tag: '★★️'}]});
  const plain = item(3, {tags: [{tag: 'Topic'}, {tag: 'style-custom:rating:3'}]});
  Z.Items = {...(Z.Items || {}), getAll: async () => [starred, emoji, plain]};
  assert.deepEqual((await plugin.starTagItems()).map(i => i.id), [starred.id, emoji.id]);
});

test('a library-wide sweep awaits Zotero rather than iterating the promise', async () => {
  // Zotero.Items.getAll returns a Promise. Six sweeps iterated it directly and
  // threw on their first line, and every test passed because the fixture handed
  // back a plain array. The fixture is now shaped like the real thing.
  const {plugin, item, Z} = fixture();
  const papers = [item(1), item(2)];
  Z.Items = {...(Z.Items || {}), getAll: async () => papers};
  assert.deepEqual((await plugin.libraryItems(1)).map(i => i.id), [1, 2]);
  // Anything that is not an array is treated as an empty library, not thrown at.
  Z.Items = {...(Z.Items || {}), getAll: async () => undefined};
  assert.deepEqual(await plugin.libraryItems(1), []);
  delete Z.Items.getAll;
  assert.deepEqual(await plugin.libraryItems(1), []);
});

test('the toolbar button uses the flat toolbar mark, in its own colours', async () => {
  const {readFileSync} = await import('node:fs');
  const workbench = readFileSync(new URL('../src/workbench.js', import.meta.url), 'utf8');
  const image = /toolbar\.setAttribute\('image',runtime\.rootURI\+'([^']+)'\)/.exec(workbench);
  assert.ok(image, 'the toolbar button should set an image');
  // The app icon is a filled colour squircle; in a toolbar it looks like a sticker.
  assert.equal(image[1], 'content/icons/style-custom-toolbar.svg');
  const glyph = readFileSync(new URL('../' + image[1], import.meta.url), 'utf8');
  assert.match(glyph, /viewBox="0 0 20 20"/, 'Zotero draws its toolbar icons on a 20px grid');
  /* The outline takes the toolbar's own ink, as Zotero's tools do, so the two
     plugin buttons sit among them as peers; one accent, on the rows of work,
     is what finds this one without making it a badge. */
  assert.match(glyph, /fill="context-fill"/, "the outline takes the toolbar's ink");
  assert.deepEqual([...new Set((glyph.match(/fill="#[0-9A-Fa-f]{6}"/g) || []))], ['fill="#4072E5"'], 'one accent');
  // Still the flat mark rather than the app icon: a filled colour squircle in a
  // toolbar looks like a sticker.
  assert.doesNotMatch(glyph, /<rect[^>]*rx="[4-9]/, 'not the rounded app tile');
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

test('another installed style is found by name, drawn as a row, and offered again next time', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item, Z} = fixture();
  const ref = item(1);
  ref.getField = key => ({title: 'A paper', date: '2024'})[key] || '';
  ref.getCreators = () => [];
  Z.Utilities = {Internal: {copyTextToClipboard() {}}};
  Z.QuickCopy = null;
  Z.Styles = {init: async () => {}, getVisible: () => [{styleID: 'http://www.zotero.org/styles/nucleic-acids-research', title: 'Nucleic Acids Research'}, {styleID: 'http://www.zotero.org/styles/cell', title: 'Cell'}],
    get: () => ({getCiteProc: () => ({free() {}})})};
  Z.Cite = {makeFormattedBibliographyOrCitationList: () => 'NAR formatted'};
  const win = {document, addEventListener() {}, removeEventListener() {}, setTimeout(){}, Event: window.Event};
  await plugin.citationPanel(win, [ref]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const find = document.querySelector('.sc-cite-find');
  find.value = 'nucleic'; find.dispatchEvent(new window.Event('input'));
  const pick = document.querySelector('.sc-cite-pick');
  assert.equal(pick.textContent, 'Nucleic Acids Research');
  pick.dispatchEvent(new window.Event('click'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const rows = [...document.querySelectorAll('.sc-cite-row')];
  assert.equal(rows.length, plugin.citationFormats.PANEL_STYLES.length + 1);
  assert.match(rows.at(-1).textContent, /Nucleic Acids Research.*NAR formatted/s);
  assert.deepEqual(plugin.cache.citationStyles, ['http://www.zotero.org/styles/nucleic-acids-research'], 'remembered for next time');
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
  assert.deepEqual(summary, {ok: 1, 'not-found': 0, unsupported: 0, error: 0, remaining: 0, budgetGone: false, newRetracted: 1, newPublished: 0});
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

test('Crossref answering 503 while OpenAlex answers does not turn a recorded retraction into a clean paper', async () => {
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_RETRACTED), openAlexAnswer(OA_GOLD)]});
  await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted');
  const real = f.Z.HTTP.request;
  f.Z.HTTP.request = async (method, url, options) => /api\.crossref\.org/.test(url) ? {status: 503, response: null} : real(method, url, options);
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(summary.error, 1, 'a server error is an error, not an answer');
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted');
});

test('a half answer with OpenAlex out does not overrule a retraction, and signals for another DOI are not shown', async () => {
  const f = signalsFixture({answers: [crossrefAnswer(CROSSREF_RETRACTED), openAlexAnswer(OA_GOLD)]});
  await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted');
  f.plugin.entry(f.ref).signals.partial = false;
  const real = f.Z.HTTP.request;
  f.Z.HTTP.request = async (method, url, options) => /openalex/.test(url) ? {status: 429, response: {error: 'Insufficient budget'}}
    : /crossref/.test(url) ? {status: 200, response: {message: CROSSREF_CLEAN}} : real(method, url, options);
  await f.plugin.refreshPaperSignals([f.ref]);
  assert.equal(f.plugin.signalsOf(f.ref).status, 'retracted', 'Crossref alone saying nothing does not clear it');
  const fields = f.ref.getField;
  f.ref.getField = key => key === 'DOI' ? '10.9/another' : fields(key);
  assert.equal(f.plugin.signalsOf(f.ref), null, 'a corrected DOI does not inherit the old one\'s retraction');
});

test('a DOI neither service knows records nothing rather than a clean bill of health', async () => {
  const f = signalsFixture({answers: []});
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.deepEqual(summary, {ok: 0, 'not-found': 1, unsupported: 0, error: 0, remaining: 0, budgetGone: false, newRetracted: 0, newPublished: 0});
  assert.equal(f.plugin.signalsOf(f.ref), null);
  assert.equal(f.errors.length, 0, 'a 404 is not an error to log');
});

test('a paper with no DOI is never sent to either service', async () => {
  const f = signalsFixture({DOI: ''});
  const summary = await f.plugin.refreshPaperSignals([f.ref]);
  assert.deepEqual(summary, {ok: 0, 'not-found': 0, unsupported: 1, error: 0, remaining: 0, budgetGone: false, newRetracted: 0, newPublished: 0});
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

test('a caller identifies itself only with an address that was offered', () => {
  const {plugin, Z} = fixture();
  // The preference was read but never shipped, so this was always empty and
  // every request went to the anonymous pool -- which is what got rate limited.
  Z.Prefs.set('extensions.style-custom.citationEmail', 'me@lab.org', true);
  assert.equal(plugin.contactEmail(), 'me@lab.org');

  // ZotPoP already asks for this; the two plugins should not ask twice.
  Z.Prefs.set('extensions.style-custom.citationEmail', '', true);
  Z.Prefs.set('extensions.zotpop.email', 'shared@lab.org', true);
  assert.equal(plugin.contactEmail(), 'shared@lab.org');

  /* The Zotero sync login is not a stand-in, though it used to be. Plenty of
     people sign in with their email, so for them this would have put their
     address in the URL of every request to two outside services, and in those
     services' logs, without ever saying so. Setting up sync is not consent to
     publish the address you signed in with. */
  Z.Prefs.set('extensions.zotpop.email', '', true);
  Z.Prefs.set('sync.server.username', 'account@example.edu', true);
  assert.equal(plugin.contactEmail(), '', 'a sync login is not consent');

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

test('a rating stranded on a PDF is lifted to the paper it belongs to', async () => {
  // Eight attachments in the real library carry one, because the rating was set
  // while the attachment row was selected. isRegular excludes them, so the
  // migration walked straight past and the tags stayed in the selector.
  const {plugin, item, Z} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  const paper = item(10, {tags: [{tag: 'Topic'}]});
  const ratedPaper = item(20, {tags: [], extra: 'Rating: 5'});
  const child = item(11, {tags: [{tag: 'style-custom:rating:4', type: 1}]});
  const duplicate = item(21, {tags: [{tag: 'style-custom:rating:2', type: 1}]});
  const orphan = item(12, {tags: [{tag: 'style-custom:rating:3', type: 1}]});
  for (const attachment of [child, duplicate, orphan]) attachment.isRegularItem = () => false;
  child.parentItemID = 10;
  duplicate.parentItemID = 20;
  const byID = new Map([[10, paper], [20, ratedPaper]]);
  Z.Items = {...(Z.Items || {}), getAll: async () => [paper, ratedPaper, child, duplicate, orphan],
    getAsync: async id => byID.get(id)};

  const {children, orphans} = await plugin.strayRatingTags(1);
  assert.deepEqual(children.map(row => row.item.id), [11, 21]);
  assert.deepEqual(orphans.map(row => row.item.id), [12]);

  const result = await plugin.moveStrayRatingTags(1);
  assert.equal(result.moved, 1, 'the paper with no rating gets the one off its PDF');
  assert.equal(result.alreadyRated, 1, 'a rating set on the paper itself outranks one set on its PDF');
  assert.equal(result.orphans, 1, 'a standalone attachment has no paper, so its tag is left rather than discarded');
  assert.equal(plugin.state(paper).rating, 4);
  assert.equal(plugin.state(ratedPaper).rating, 5, 'the existing rating is not overwritten');
  for (const attachment of [child, duplicate]) {
    assert.equal(plugin.ratingTagOf(attachment), null, 'the stray tag is gone');
  }
  assert.equal(plugin.ratingTagOf(orphan), 3, 'and the one with nowhere to go is untouched');
});

test('first author, corresponding author and tier each get a column of their own, sorted by what they show', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const labels = Object.fromEntries(plugin.columnDefinitions.map(([key, label]) => [key, label]));
  assert.deepEqual([labels.firstInstitution, labels.correspondingInstitution, labels.institutionTier], ['1저자 기관', '교신 기관', '기관 등급'], 'labels are dictionary keys, so the header speaks the interface language');

  // Nothing looked up yet: every cell says so instead of showing a blank.
  assert.equal(plugin.value('firstInstitution', ref), '');
  assert.equal(plugin.renderCell('institutionTier', 0, '', {}, document).textContent, '—');

  plugin.cache.works = {[plugin.identity(ref)]: {people: [
    {id: 'A1', name: 'Sheila Ingemann Jensen', institution: 'DTU', ror: 'dtu', country: 'DK', corresponding: false, position: 'first'},
    {id: 'A2', name: 'M Middle', institution: '', ror: '', country: '', corresponding: false, position: 'middle'},
    {id: 'A3', name: 'P I Boss', institution: 'MIT', ror: 'mit', country: 'US', corresponding: true, position: 'last'}
  ]}};
  plugin.cache.institutions = {dtu: {ror: 'dtu', name: 'Technical University of Denmark', hIndex: 640},
    mit: {ror: 'mit', name: 'MIT', hIndex: 2281}};
  assert.equal(plugin.value('firstInstitution', ref), 'Technical University of Denmark · DK');
  assert.equal(plugin.value('correspondingInstitution', ref), 'MIT · US');
  assert.equal(plugin.value('institutionTier', ref), '02281', 'the sort key is the better lab\'s h-index, zero-padded');

  const first = plugin.renderCell('firstInstitution', 0, '', {}, document);
  // 640 sorts, but draws nothing: paper-weighted, the bucket it falls in covered
  // three rows in four, which is a texture rather than a mark.
  assert.equal(first.textContent, 'T3🇩🇰Technical University of Denmark');
  assert.match(first.title, /1저자 Sheila Ingemann Jensen · Technical University of Denmark \(DK\) · 기관 h-index 640/);
  assert.match(first.title, /교신저자 P I Boss · MIT \(US\) · 기관 h-index 2281/);
  const corresponding = plugin.renderCell('correspondingInstitution', 0, '', {}, document);
  assert.equal(corresponding.textContent, 'T1🇺🇸MIT');
  const tier = plugin.renderCell('institutionTier', 0, '', {}, document);
  assert.equal(tier.textContent, 'T1');
  assert.match(tier.firstChild.title, /2000 이상.*기관 h-index 2281/);
  assert.match(tier.firstChild.style.color, /#3068CA|#7EA3E1/i, 'the top bucket is blue');

  // When the first author answers for the paper too, the column names the same
  // lab again rather than pointing at the other column.
  plugin.cache.works[plugin.identity(ref)].people.splice(1);
  assert.equal(plugin.renderCell('correspondingInstitution', 0, '', {}, document).textContent, 'T3🇩🇰Technical University of Denmark');
  assert.equal(plugin.value('correspondingInstitution', ref), 'Technical University of Denmark · DK');
  assert.equal(plugin.value('institutionTier', ref), '00640');
});

test('the publisher mark has its own column, the IF cell keeps only the figure, and the native journal cell takes the colour', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body><div id="zotero-items-tree"><div class="row" id="item-tree-main-row-0"><span class="cell title"><span class="cell-text" style="font-weight:400">Paper</span></span><span class="cell publicationTitle"><span class="cell-text">Science</span></span></div></div></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  const getField = ref.getField.bind(ref);
  ref.getField = name => name === 'publicationTitle' ? 'Science' : getField(name);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  assert.equal(plugin.value('journalMark', ref), 'Science');
  const mark = plugin.renderCell('journalMark', 0, '', {}, document);
  assert.equal(mark.textContent, 'Science');
  // Zotero's own abbreviation field wins over the derived one when the record has it.
  ref.getField = name => name === 'publicationTitle' ? 'Journal of Thermophilic Enzyme Engineering' : name === 'journalAbbreviation' ? 'J. Thermophil. Enzyme Eng.' : getField(name);
  assert.equal(plugin.value('journalMark', ref), 'J Thermophil Enzyme Eng', "Zotero's own field, minus its periods, when the table does not know the title");
  ref.getField = name => name === 'publicationTitle' ? 'Nature Communications' : getField(name);
  assert.equal(plugin.value('journalMark', ref), 'Nat Commun', 'derived from the title when the field is empty');
  ref.getField = name => name === 'publicationTitle' ? 'Molecular Cell' : name === 'journalAbbreviation' ? 'Molecular Cell' : getField(name);
  assert.equal(plugin.value('journalMark', ref), 'Mol Cell', 'a full title filed as the abbreviation is not one');
  ref.getField = name => name === 'publicationTitle' ? 'Proceedings of the National Academy of Sciences' : name === 'journalAbbreviation' ? 'Proc. Natl. Acad. Sci. U.S.A.' : getField(name);
  assert.equal(plugin.value('journalMark', ref), 'PNAS', 'a curated title takes the table form over the field');
  ref.getField = name => name === 'publicationTitle' ? 'Frontiers in Genetics' : name === 'journalAbbreviation' ? 'Front. Genet.' : getField(name);
  assert.equal(plugin.value('journalMark', ref), 'Front Genet', 'periods are dropped so the column reads in one style');
  ref.getField = name => name === 'publicationTitle' ? 'Science' : getField(name);
  assert.match(mark.firstChild.style.cssText, /background:\s*#ca2015/, 'the badge wears the exact AAAS red #ca2015');
  assert.equal(mark.firstChild.style.color, '#ffffff', 'white lettering on it');
  assert.equal(mark.title, 'Science · Science');
  plugin.displayValue = (key, target) => key === 'if' ? '56.1' : '';
  const cell = plugin.renderCell('if', 0, '56.1', {}, document);
  assert.equal(cell.textContent, '56.1', 'the figure stands alone; the mark is in its own column');
  delete plugin.value;

  const win = {document, ZoteroPane: window.ZoteroPane, clearInterval() {}};
  const state = {titleNodes: new Set(), titlePositions: new Map(), titleWeights: new Map(), nodes: [], listeners: []};
  plugin.windows.set(win, state);
  plugin.enhanceTitles(win, state, [ref]);
  const venue = document.querySelector('.cell.publicationTitle .cell-text');
  /* The name is written in the brand colour itself whenever that already reads
     on the page. The old rule re-saturated and pinned every brand at 36%
     lightness, which is why the name never quite matched the badge beside it:
     a near-black navy became a vivid blue. Science's red reads at 5.6:1 as
     printed, so it is used as printed. */
  assert.equal(venue.style.color.toLowerCase(), "#ca2015", "the journal's name is the badge's own colour when that reads");
  assert.equal(venue.style.fontWeight, '600');
  assert.equal(venue.dataset.styleCustomVenue, 'science');
  await plugin.removeWindow(win);
  assert.equal(venue.style.color, '', 'unloading gives the cell back as it was');
  assert.equal(venue.dataset.styleCustomVenue, undefined);
});

test('the IF cell tooltip carries the official JCR quartile and category rank when the captured catalog has the journal, and invents nothing when it does not', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body><div id="zotero-items-tree"><div class="row" id="item-tree-main-row-0"></div></div></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  const getField = ref.getField.bind(ref);
  ref.getField = name => name === 'publicationTitle' ? 'Journal of Thermophilic Enzyme Engineering' : getField(name);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  plugin.displayValue = key => ({if: '56.1', oaCitedness: '4.2'})[key] || '';
  // No catalog at all: the old, plain tooltip, nothing invented.
  let cell = plugin.renderCell('if', 0, '', {}, document);
  assert.doesNotMatch(cell.title, /Q\d/);
  assert.match(cell.title, /Journal of Thermophilic Enzyme Engineering.*IF 56\.1/);
  // A captured catalog that does not carry this journal: still nothing invented.
  plugin.jcrCatalog = {journals: [{title: 'Some Other Journal', issns: [], categoryMetrics: [{categoryKey: 'Other', quartile: 2, rank: 5, rankTotal: 50}]}]};
  cell = plugin.renderCell('if', 0, '', {}, document);
  assert.doesNotMatch(cell.title, /Q\d/);
  // The catalog has this exact journal (matched by title, no ISSN needed):
  // its official quartile and category rank join the tooltip.
  plugin.jcrCatalog = {journals: [{title: 'Journal of Thermophilic Enzyme Engineering', issns: [],
    categoryMetrics: [{categoryKey: 'Biochemistry & Molecular Biology', quartile: 1, rank: 8, rankTotal: 140, percentile: 95}]}]};
  cell = plugin.renderCell('if', 0, '', {}, document);
  assert.match(cell.title, /IF 56\.1 · Q1 8\/140 Biochemistry & Molecular Biology/);
  // OpenAlex's own estimate (a different figure from the official JIF) never
  // carries this, even with the very same journal in the captured catalog.
  const oaCell = plugin.renderCell('oaCitedness', 0, '', {}, document);
  assert.doesNotMatch(oaCell.title, /Q\d/);
});

test('a tall Extra field gets a row as tall as itself, and the row is given back on unload', async () => {
  const {parseHTML} = await import('linkedom');
  const {document} = parseHTML('<html><body><div id="zotero-item-pane"><div class="meta-row" id="r1"><span class="label">Extra</span><editable-text multiline="true" class="value"></editable-text></div><div class="meta-row" id="r2"><span class="label">Added</span><span class="value">x</span></div></div></body></html>');
  const rows = {r1: 111, r2: 22}, values = {r1: 124, r2: 22};
  for (const row of document.querySelectorAll('.meta-row')) {
    row.getBoundingClientRect = () => ({height: rows[row.id]});
    row.querySelector('.value').getBoundingClientRect = () => ({height: values[row.id]});
  }
  const {plugin} = fixture();
  assert.equal(plugin.fixItemPaneRows(document), 1);
  assert.equal(document.getElementById('r1').style.minHeight, '124px');
  assert.equal(document.getElementById('r2').style.minHeight, '');
  values.r1 = 40; rows.r1 = 111;
  plugin.fixItemPaneRows(document);
  assert.equal(document.getElementById('r1').style.minHeight, '', 'a value that shrank releases the row');
});

test('quitting Zotero leaves the columns registered, so their saved widths and order survive', async () => {
  const {plugin, columns} = fixture();
  await plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  const before = columns.size;
  assert.ok(before > 0);
  await plugin.stop({keepColumns: true});
  assert.equal(columns.size, before, 'APP_SHUTDOWN must not unregister: the item tree writes its layout after this and would drop them');
  const again = fixture();
  await again.plugin.start({id:'custom',version:'0.4',rootURI:'file:///custom/'});
  await again.plugin.stop();
  assert.equal(again.columns.size, 0, 'a disable or uninstall still cleans up');
});

test('a row is worked out once per repaint, and never while a change is unsaved', async () => {
  // Driven against the memo itself rather than through a fixture, because
  // metrics() marks the cache dirty the first time it meets an item and that
  // bookkeeping is not what this is about.
  const {createRequire} = await import('node:module');
  const Runtime = createRequire(import.meta.url)('../src/runtime.js');
  const host = Object.create(Runtime.prototype);
  let computed = 0;
  Object.assign(host, {dirty: false, stateGeneration: 0,
    computeState: () => { computed++; return {seconds: computed}; }});
  const paper = {id: 1, libraryID: 1};

  // Five columns ask for a row's state, and Zotero asks each for its sort value
  // and then its cell: a forty-row viewport recomputed all of it four hundred
  // times a frame.
  for (let n = 0; n < 20; n++) host.state(paper);
  assert.equal(computed, 1, 'once per repaint, not once per column');

  // `dirty` means the cache has been changed and not yet saved, which is exactly
  // the window in which a remembered answer is the old answer: the live
  // reading-time cell reads state during the tick that increments it.
  host.dirty = true;
  host.state(paper);
  host.state(paper);
  assert.equal(computed, 3, 'nothing is remembered while a write is pending');

  /* Nothing was stored while the write was pending, so what is still held is
     what was worked out before it -- and that is right: in this test nothing
     was actually written. The bump is what retires it. */
  host.dirty = false;
  computed = 0;
  host.state(paper);
  assert.equal(computed, 0, 'the answer from before the pending write still stands');
  host.bumpState();
  host.state(paper);
  assert.equal(computed, 1, 'a bump retires what was remembered');

  // The same id in two libraries is two items. Keyed on the id alone, the memo
  // handed the second one the first one's answer.
  computed = 0;
  host.state({id: 7, libraryID: 1});
  host.state({id: 7, libraryID: 2});
  assert.equal(computed, 2, 'library and id together are the key');
});

test('the settings schema is looked up by key, not walked', () => {
  const {plugin} = fixture();
  // 117 entries, walked on every lookup, and the read-time column looks up two
  // of them for every cell it draws.
  assert.ok(plugin.settingDefinition('timeFormat'));
  assert.equal(plugin.settingDefinition('no-such-setting'), undefined);
  assert.ok(plugin.settingIndex instanceof Map);
  assert.ok(plugin.settingIndex.size > 100);
});


test('the citation bar is grey while a paper is too young to judge, not while its count is low', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const P = plugin.palette(document);
  const bar = (year, citations) => {
    const ref = item(1);
    ref.getField = key => key === 'date' ? String(year) : '';
    window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
    plugin.displayValue = key => key === 'citations' ? String(citations) : '';
    const cell = plugin.renderCell('citations', 0, '', {}, document);
    const track = cell.lastChild;
    return {colour: track.firstChild.style.background, title: track.title};
  };
  const thisYear = new Date().getFullYear();
  /* Grey used to mean "under a hundred citations", which said the same thing
     the number beside it said and punished every paper for being new. A paper
     published within the last three years has not had time to be cited. */
  const young = bar(thisYear - 1, 500);
  const old = bar(thisYear - 10, 3);
  assert.equal(young.colour, plugin.tint(P.gray, 0.7), 'a well-cited new paper is still grey: its count is not evidence yet');
  assert.equal(old.colour, plugin.tint(P.blue, 0.9), 'a barely-cited old paper is blue: it has had its chance');
  assert.match(young.title, /3년 이내/);
  assert.match(young.title, new RegExp(String(thisYear - 1)));
  // Exactly three years old is still young; four is not.
  assert.equal(bar(thisYear - 2, 0).colour, plugin.tint(P.gray, 0.7));
  assert.equal(bar(thisYear - 3, 0).colour, plugin.tint(P.blue, 0.9));
  // No date at all is not "young".
  assert.equal(bar('', 0).colour, plugin.tint(P.blue, 0.9));
});

test('impact factors read to one decimal and sit on the right, so the points line up', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref})}};
  const shown = value => {
    plugin.displayValue = key => key === 'if' ? String(value) : '';
    const cell = plugin.renderCell('if', 0, '', {}, document);
    return cell.lastChild;
  };
  // "3", "15" and "56.1" in one column put the decimal points in three places.
  assert.equal(shown(3).textContent, '3.0');
  assert.equal(shown(15).textContent, '15.0');
  assert.equal(shown(56.1).textContent, '56.1');
  assert.equal(shown(104.6).textContent, '104.6');
  const number = shown(3);
  assert.equal(number.style.textAlign, 'right');
  assert.equal(number.style.marginInlineStart, 'auto', 'pushed to the right edge whatever the mark beside it is');
  assert.match(number.style.fontVariantNumeric, /tabular-nums/);
});

test('a watched author\'s "new papers" leave out repository deposits and say which are preprints', () => {
  const {plugin} = fixture();
  /* Of 64 new items across 109 watched authors, 15 were PNNL repository
     deposits and one a Zenodo record -- copies of published work, typed
     dataset by OpenAlex. The type used to be fetched and thrown away. */
  const fresh = [
    {id: 'W1', title: 'Real paper', venue: 'Nature Communications', type: 'article', date: '2026-08-01'},
    {id: 'W2', title: 'Data for EMSL Project 50414', venue: 'PNNL Repository', type: 'dataset', date: '2026-08-02'},
    {id: 'W3', title: 'Early version', venue: 'bioRxiv (Cold Spring Harbor Laboratory)', type: 'preprint', date: '2026-08-03'},
    {id: 'W4', title: 'Zenodo record', venue: 'Zenodo', type: 'other', date: '2026-08-04'}
  ];
  const owned = new Set();
  const row = {id: 'A1', seen: []};
  // The same shaping the sweep applies, isolated: type kept, deposits dropped.
  const papers = fresh.filter(work => !/^(dataset|other|paratext|peer-review|grant|libguides|supplementary-materials)$/i.test(String(work.type || '')));
  row.news = papers.map(work => ({id: work.id, type: work.type,
    preprint: /preprint/i.test(work.type) || /rxiv|research square|preprints?\b|ssrn/i.test(work.venue || ''),
    inLibrary: !!work.doi && owned.has(work.doi)}));
  assert.deepEqual(row.news.map(n => n.id), ['W1', 'W3'], 'the dataset and the record are gone');
  assert.deepEqual(row.news.map(n => n.preprint), [false, true], 'and the preprint is marked as one');
  // The same regex the runtime uses, so this test breaks if it drifts.
  const source = plugin.constructor.toString();
  assert.match(source, /dataset\|other\|paratext\|peer-review\|grant\|libguides\|supplementary-materials/);
});

test('a patent PDF sitting as a bare attachment gets a chip in the title cell', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body><div class="row"><span class="cell title"><span class="cell-text">US20240352440A1.pdf</span></span></div></body></html>');
  const {plugin} = fixture();
  const state = {titleNodes: new Set()};
  const attachment = {itemType: 'attachment', attachmentFilename: 'US20240352440A1.pdf', parentItemID: null,
    isAttachment: () => true, isRegularItem: () => false, getField: key => key === 'title' ? 'US20240352440A1.pdf' : ''};
  const row = document.querySelector('.row');
  plugin.paintKind(row, attachment, state, window);
  const chip = row.querySelector('.style-custom-kind');
  assert.ok(chip, 'a chip is drawn before the title');
  assert.equal(chip.textContent, '특허');
  assert.match(chip.title, /미국 특허 US20240352440A1/);
  assert.match(chip.title, /파일 이름으로 판별/);
  assert.equal(row.querySelector('.cell.title').firstChild, chip, 'and it leads the cell');
  // A thesis by its item type.
  const thesis = {itemType: 'thesis', isAttachment: () => false, isRegularItem: () => true, getField: key => key === 'title' ? 'Acetate metabolism' : ''};
  plugin.paintKind(row, thesis, state, window);
  assert.equal(row.querySelector('.style-custom-kind').textContent, '학위논문');
  // A paper takes the chip away again when the row is recycled.
  const paper = {itemType: 'journalArticle', isAttachment: () => false, isRegularItem: () => true, getField: key => key === 'title' ? 'Structure of a SMC complex' : ''};
  plugin.paintKind(row, paper, state, window);
  assert.equal(row.querySelector('.style-custom-kind'), null);
});

test('double-clicking the edge at the right of a column fits that column to its widest visible cell', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl">
    <div class="virtualized-table-header"><div class="cell title"><span class="cell-text">Title</span></div><div class="cell year"><div class="resizer year"></div><span>Year</span></div></div>
    <div class="virtualized-table-body"><div class="row"><span class="cell title">short</span></div><div class="row"><span class="cell title">a much longer title text</span></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'year', minWidth: 20}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns,
    _columns: {onResize: (widths, store) => resized.push([widths, store])}}}};
  window.CSS = {escape: s => s};
  // linkedom has no layout: give the cells the widths a browser would measure.
  for (const el of document.querySelectorAll('.cell.title')) Object.defineProperty(el, 'scrollWidth', {value: el.textContent.length * 7});
  Object.defineProperty(document.querySelector('.cell-text'), 'scrollWidth', {value: 30});
  const head = document.querySelector('.virtualized-table-header .cell.title');
  const next = document.querySelector('.virtualized-table-header .cell.year');
  head.getBoundingClientRect = () => ({width: 120}); next.getBoundingClientRect = () => ({width: 80});
  const state = {listeners: []};
  plugin.attachColumnFit(window, state);
  const event = new window.Event('dblclick', {bubbles: true});
  document.querySelector('.resizer.year').dispatchEvent(event);
  assert.equal(resized.length, 1, 'one resize, applied through the table\'s own onResize');
  const [widths, store] = resized[0];
  assert.equal(store, true, 'stored, so it persists like a drag');
  // widest cell = 24 chars * 7 = 168, plus 16 padding = 184. Nothing else
  // changes: when the columns no longer fit, the list rolls sideways.
  assert.deepEqual(widths, {title: 184, year: 80}, 'the fitted column at its content, the rest as they are');
  assert.ok(state.listeners.some(([, name]) => name === 'dblclick'), 'and the listener is registered for cleanup');
});

test('a fit changes that column alone, whatever the columns around it hold', async () => {
  /* Earlier versions paid for a fit with the neighbours, then with every
     column in proportion, and each left the layout in a worse state. */
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl">
    <div class="virtualized-table-header"><div class="cell title"><span class="cell-text">Title</span></div><div class="cell year"><div class="resizer year"></div><span>Year</span></div><div class="cell journal"><span>Journal</span></div><div class="cell fixed"><span>F</span></div></div>
    <div class="virtualized-table-body"><div class="row"><span class="cell title">a much longer title text</span></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'year', minWidth: 20}, {dataKey: 'journal', minWidth: 40}, {dataKey: 'fixed', minWidth: 20, fixedWidth: true}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns, _columns: {onResize: (widths, store) => resized.push([widths, store])}}}};
  window.CSS = {escape: s => s};
  for (const el of document.querySelectorAll('.cell.title')) Object.defineProperty(el, 'scrollWidth', {value: el.textContent.length * 7});
  Object.defineProperty(document.querySelector('.cell-text'), 'scrollWidth', {value: 30});
  const size = {title: 120, year: 36, journal: 200, fixed: 300};
  for (const [key, width] of Object.entries(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width});
  const state = {listeners: []};
  plugin.attachColumnFit(window, state);
  document.querySelector('.resizer.year').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.equal(resized.length, 1);
  const [widths] = resized[0];
  // Wants 24 * 7 + 16 = 184, and gets it; year and journal are stored as they are, the fixed column is left to Zotero.
  assert.deepEqual(widths, {title: 184, year: 36, journal: 200});
  assert.equal(state.columnFit.fitted, 1);
  assert.match(state.columnFit.last, /title: 120 → 184/);
});

test('a column takes at most 60% of the list, and always may reach 320 px', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl">
    <div class="virtualized-table-header"><div class="cell title"><span class="cell-text">Title</span></div><div class="cell year"><span>Year</span></div><div class="cell venue"><div class="resizer venue"></div><span>Venue</span></div><div class="cell fixed"><div class="resizer fixed"></div><span>F</span></div><div class="cell journal"><span>Journal</span></div></div>
    <div class="virtualized-table-body"><div class="row"><span class="cell venue">Proceedings of the National Academy of Sciences</span></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'year', minWidth: 20}, {dataKey: 'venue', minWidth: 20}, {dataKey: 'fixed', minWidth: 20, fixedWidth: true}, {dataKey: 'journal', minWidth: 40}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns, _columns: {onResize: (widths, store) => resized.push([widths, store])}}}};
  window.CSS = {escape: s => s};
  // 47 characters at 7 px: 329 of text, 345 with padding, under 60% of 800.
  for (const el of document.querySelectorAll('.cell.venue')) Object.defineProperty(el, 'scrollWidth', {value: el.textContent.length * 7});
  const size = {title: 400, year: 60, venue: 40, fixed: 100, journal: 200};
  for (const [key, width] of Object.entries(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width});
  const state = {listeners: []};
  plugin.attachColumnFit(window, state);
  // The edge at the right of the venue column is the fixed column's resizer.
  document.querySelector('.resizer.fixed').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.equal(resized.length, 1);
  const [widths] = resized[0];
  assert.deepEqual(widths, {title: 400, year: 60, venue: 345, journal: 200});
  assert.match(state.columnFit.last, /venue: 40 → 345/);
  // A 400 px table: 60% is 240, but 320 is always allowed.
  Object.assign(size, {title: 100, journal: 60, fixed: 100});
  for (const [key, width] of Object.entries(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width});
  document.querySelector('.resizer.fixed').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.deepEqual(resized[1][0], {title: 100, year: 60, venue: 320, journal: 60});
});

test('a column wider than its text shrinks to it, and a narrower one grows to it', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl">
    <div class="virtualized-table-header"><div class="cell title"><span class="cell-text">Title</span></div><div class="cell year"><span>Year</span></div><div class="cell venue"><div class="resizer venue"></div><span>Venue</span></div><div class="cell journal"><div class="resizer journal"></div><span>Journal</span></div></div>
    <div class="virtualized-table-body"><div class="row"><span class="cell venue">Nucleic Acids Research</span></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'year', minWidth: 20}, {dataKey: 'venue', minWidth: 20}, {dataKey: 'journal', minWidth: 40}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns, _columns: {onResize: (widths, store) => resized.push([widths, store])}}}};
  window.CSS = {escape: s => s};
  for (const el of document.querySelectorAll('.cell.venue')) Object.defineProperty(el, 'scrollWidth', {value: el.textContent.length * 7});
  const size = {title: 500, year: 60, venue: 40, journal: 200};
  for (const [key, width] of Object.entries(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width});
  const state = {listeners: []};
  plugin.attachColumnFit(window, state);
  document.querySelector('.resizer.journal').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  // 22 characters at 7 px plus padding: 170.
  assert.deepEqual(resized[0][0], {title: 500, year: 60, venue: 170, journal: 200});
  // The same edge with the venue already wider than its text.
  size.venue = 300;
  document.querySelector('.resizer.journal').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.deepEqual(resized[1][0], {title: 500, year: 60, venue: 170, journal: 200});
});

test('a second double-click on a fitted column changes nothing, and a cell wider than its text does not grow by its padding', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl">
    <div class="virtualized-table-header"><div class="cell title"><span class="cell-text">Title</span></div><div class="cell venue"><div class="resizer venue"></div><span>Venue</span></div><div class="cell journal"><div class="resizer journal"></div><span>Journal</span></div></div>
    <div class="virtualized-table-body"><div class="row"><span class="cell venue">Nucleic Acids Research</span></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'venue', minWidth: 20}, {dataKey: 'journal', minWidth: 40}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns, _columns: {onResize: (widths, store) => resized.push([widths, store])}}}};
  window.CSS = {escape: s => s};
  // A browser measures text: 7 px a character here, and every cell has 8 px of padding a side.
  const createElementNS = document.createElementNS.bind(document);
  document.createElementNS = (ns, tag) => tag === 'canvas' ? {getContext: () => ({font: '', measureText: text => ({width: text.length * 7})})} : createElementNS(ns, tag);
  window.getComputedStyle = el => ({font: '13px sans-serif', overflow: 'visible', marginLeft: '0px', marginRight: '0px', paddingLeft: el.classList.contains('cell') ? '8px' : '0px', paddingRight: el.classList.contains('cell') ? '8px' : '0px'});
  const cell = document.querySelector('.virtualized-table-body .cell.venue');
  const size = {title: 500, venue: 40, journal: 200};
  const box = (scroll, client) => { Object.defineProperty(cell, 'scrollWidth', {value: scroll, configurable: true}); Object.defineProperty(cell, 'clientWidth', {value: client, configurable: true}); };
  box(162, 40); // 40 wide with 154 px of text: it overflows
  for (const key of Object.keys(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width: size[key]});
  const state = {listeners: []};
  plugin.attachColumnFit(window, state);
  document.querySelector('.resizer.journal').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  // 154 of text, 16 of cell padding, 16 of room: 186.
  assert.deepEqual(resized[0][0], {title: 500, venue: 186, journal: 200});
  // Now 186 wide: nothing overflows, scrollWidth is just the box again.
  size.venue = 186; size.title = 354; box(186, 186);
  document.querySelector('.resizer.journal').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.equal(resized.length, 1, 'no second resize: the column already fits');
  assert.match(state.columnFit.last, /already fits/);
  // Dragged wider by hand: the fit brings it back to the text, not to the box plus padding.
  size.venue = 260; size.title = 280; box(260, 260);
  document.querySelector('.resizer.journal').dispatchEvent(new window.Event('dblclick', {bubbles: true}));
  assert.equal(resized.length, 2);
  assert.deepEqual(resized[1][0], {title: 280, venue: 186, journal: 200});
});

test('when the columns add up to more than the list, the list rolls sideways and the header follows', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl"><div class="virtualized-table">
    <div class="virtualized-table-header"><div class="cell title"><span>Title</span></div><div class="cell year"><span>Year</span></div><div class="cell venue"><span>Venue</span></div></div>
    <div class="virtualized-table-body"><div class="windowed-list"></div></div>
  </div></div></body></html>`);
  const {plugin} = fixture();
  const rules = {title: {flexBasis: '284px'}, year: {minWidth: '60px'}, venue: {flexBasis: '184px'}};
  const columns = [{dataKey: 'title'}, {dataKey: 'year', staticWidth: true, width: 60}, {dataKey: 'venue'}];
  window.ZoteroPane = {itemsView: {tree: {props: {id: 'tbl'}, _getVisibleColumns: () => columns,
    _columns: {onResize() {}, _stylesheet: {sheet: {cssRules: [{style: rules.title}, {style: rules.year}, {style: rules.venue}]}}, _columnStyleMap: {title: 0, year: 1, venue: 2}}}}};
  window.CSS = {escape: s => s};
  const body = document.querySelector('.virtualized-table-body'), header = document.querySelector('.virtualized-table-header');
  const list = document.querySelector('.windowed-list'), table = document.querySelector('.virtualized-table');
  Object.defineProperty(body, 'clientWidth', {value: 516, configurable: true}); // 500 of columns after the 16 of padding
  header.style.setProperty('--scrollbar-width', '15px');
  const state = {listeners: []};
  // 300 + 60 + 200 = 560 wanted, 500 available: the rows and the header are made 560 wide.
  assert.deepEqual(plugin.rollTable(window, state), {wanted: 560, available: 500, rolling: true});
  assert.equal(list.style.minWidth, '560px');
  assert.equal(header.style.width, '591px', 'the header adds its padding and the scrollbar it leaves room for');
  assert.equal(table.style.overflow, 'hidden');
  // The user scrolls the body: the header is moved by as much.
  body.scrollLeft = 120;
  plugin.attachTableRoll(window, state);
  body.dispatchEvent(new window.Event('scroll'));
  assert.equal(header.style.transform, 'translateX(-120px)');
  // A column shrinks so that everything fits again: the list is a plain list.
  rules.title.flexBasis = '184px';
  assert.deepEqual(plugin.rollTable(window, state), {wanted: 460, available: 500, rolling: false});
  assert.equal(list.style.minWidth, '');
  assert.equal(header.style.width, '');
  assert.equal(table.style.overflow, '');
  state.rollCleanup?.();
});

test('dragging a column edge changes the column to its left only; the columns after it follow', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML(`<html><body><div id="tbl" class="virtualized-table">
    <div class="virtualized-table-header"><div class="cell title"><span>Title</span></div><div class="cell venue"><div class="resizer venue"><div></div></div><span>Venue</span></div><div class="cell journal"><div class="resizer journal"><div></div></div><span>Journal</span></div></div>
    <div class="virtualized-table-body"><div class="windowed-list"></div></div>
  </div></body></html>`);
  const {plugin} = fixture();
  const resized = [];
  const columns = [{dataKey: 'title', minWidth: 50}, {dataKey: 'venue', minWidth: 20}, {dataKey: 'journal', minWidth: 40}];
  const rules = {title: {flexBasis: '284px'}, venue: {flexBasis: '184px'}, journal: {flexBasis: '84px'}};
  const tree = {props: {id: 'tbl'}, _getVisibleColumns: () => columns, _columns: {
    onResize: (widths, store) => { resized.push([widths, !!store]); for (const [k, w] of Object.entries(widths)) rules[k].flexBasis = (w - 16) + 'px'; },
    _stylesheet: {sheet: {cssRules: [{style: rules.title}, {style: rules.venue}, {style: rules.journal}]}}, _columnStyleMap: {title: 0, venue: 1, journal: 2}}};
  window.ZoteroPane = {itemsView: {tree}};
  window.CSS = {escape: s => s};
  const size = {title: 300, venue: 200, journal: 100};
  for (const key of Object.keys(size)) document.querySelector(`.virtualized-table-header .cell.${key}`).getBoundingClientRect = () => ({width: size[key]});
  Object.defineProperty(document.querySelector('.virtualized-table-body'), 'clientWidth', {value: 616, configurable: true});
  const state = {listeners: []};
  plugin.attachColumnDrag(window, state);
  // Press on the edge at the right of the venue column (the journal column's resizer) and pull it 60 px left.
  const handle = document.querySelector('.resizer.journal div');
  // linkedom has no MouseEvent: a plain event carrying the two fields the handler reads.
  const mouse = (type, clientX, target = document) => { const event = new window.Event(type, {bubbles: true, cancelable: true}); event.clientX = clientX; event.button = 0; target.dispatchEvent(event); return event; };
  const down = mouse('mousedown', 500, handle);
  assert.ok(down.defaultPrevented, 'taken over before Zotero sees it');
  assert.deepEqual(resized[0], [{title: 300, venue: 200, journal: 100}, false], 'every column set to what it shows, as Zotero does');
  assert.ok(document.getElementById('tbl').classList.contains('resizing'));
  mouse('mousemove', 470); mouse('mousemove', 440);
  assert.deepEqual(resized.at(-1), [{venue: 140}, false], 'the venue alone follows the pointer');
  const up = mouse('mouseup', 440);
  assert.ok(up.defaultPrevented, 'swallowed, or the header would sort');
  assert.deepEqual(resized.at(-1), [{title: 300, venue: 140, journal: 100}, true], 'stored with every flexible column');
  assert.ok(!document.getElementById('tbl').classList.contains('resizing'));
  assert.equal(state.columnDrag.last, 'venue: 200 → 140');
  // Below its minimum it stops.
  mouse('mousedown', 440, handle); mouse('mousemove', 0); mouse('mouseup', 0);
  assert.equal(resized.at(-1)[0].venue, 36);
});

test('the tree draws the italics and subscripts of a title instead of its tags', async () => {
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body><div class="row"><span class="cell title"><span class="cell-text">x</span></span></div></body></html>');
  const {plugin} = fixture();
  const row = document.querySelector('.row');
  const cell = row.querySelector('.cell.title');
  let text = cell.querySelector('.cell-text');
  if (!text) { text = document.createElement('span'); text.className = 'cell-text'; cell.appendChild(text); }
  text.textContent = 'Establishing a <i>Bacillus subtilis</i> CO<sub>2</sub> route <script>x</script>';
  const item = {itemType: 'journalArticle', isAttachment: () => false, isRegularItem: () => true,
    getField: key => key === 'title' ? 'Establishing a <i>Bacillus subtilis</i> CO<sub>2</sub> route <script>x</script>' : ''};
  assert.equal(plugin.paintTitleMarkup(text, item, window), true);
  assert.equal(text.querySelector('i').textContent, 'Bacillus subtilis');
  assert.equal(text.querySelector('sub').textContent, '2');
  assert.equal(text.querySelector('script'), null, 'only the six inline tags are drawn');
  assert.equal(text.textContent, 'Establishing a Bacillus subtilis CO2 route <script>x</script>');
  // Already drawn: left alone until the tree prints the tags again.
  assert.equal(plugin.paintTitleMarkup(text, item, window), false);
  const plain = {itemType: 'journalArticle', getField: key => key === 'title' ? 'No markup here' : ''};
  text.textContent = 'No markup here';
  assert.equal(plugin.paintTitleMarkup(text, plain, window), false);
});

test('every entry of the item menu carries a drawn sign', () => {
  const {plugin} = fixture();
  const icons = plugin.MENU_ICONS;
  for (const name of ['circle', 'half', 'disc', 'search', 'star', 'journals', 'reading', 'quote', 'columns', 'panel', 'graph', 'refresh', 'citations', 'stop', 'attachments', 'fill', 'signal', 'download', 'palette', 'related', 'authors']) {
    assert.ok(Array.isArray(icons[name]) && icons[name].length, name);
  }
  // Each verb in the menu names one of those signs as its last argument.
  const source = plugin.constructor.toString();
  const expected = {'ZotPoP에서 이 논문 검색': 'search', '라이브러리 저널 지표 채우기': 'journals', '인용문 복사…': 'quote', '커스텀 열로 전환': 'columns', '연구 작업 패널': 'panel',
    '관계 그래프 열기': 'graph', '지표·읽기 기록 새로고침': 'refresh', '인용 수 조회 중지': 'stop', '철회·공개접근 확인': 'signal',
    '이 논문의 관련 논문': 'related', '이 논문 책임저자 추적': 'authors'};
  for (const [label, icon] of Object.entries(expected)) {
    const at = source.indexOf('action("' + label + '"');
    assert.ok(at >= 0, label);
    const next = source.indexOf('action("', at + 8);
    const call = source.slice(at, next < 0 ? undefined : next);
    assert.ok(call.includes('"' + icon + '")') || call.includes('"' + icon + '",'), `${label} carries ${icon}`);
    assert.ok(Array.isArray(icons[icon]), icon);
  }
});

test('the item menu opens the panel on the paper under the pointer, not on an empty tab', () => {
  /* Both entries used to mean: open the panel, find the tab, then press
     「현재 선택 가져오기」 to hand it the paper that was already selected. */
  const {plugin} = fixture();
  const source = plugin.constructor.toString();
  for (const [label, tab, focus] of [['이 논문의 관련 논문', "'related'", ''], ['이 논문 책임저자 추적', "'authors'", "'pi'"]]) {
    const at = source.indexOf('action("' + label + '"');
    assert.ok(at >= 0, label);
    const call = source.slice(at, source.indexOf('action("', at + 8));
    assert.ok(call.includes('show(' + tab + (focus ? ',' + focus : '') + ')'), `${label} opens ${tab}`);
    // One paper, or the question has no subject; the message says which to fix.
    assert.match(call, /selected\(win\)\.length!==1/, `${label} asks for exactly one paper`);
    assert.match(call, /문헌을 하나만 선택하세요/, `${label} says what to do about it`);
  }
});

test('the item menu\'s "컬렉션으로 이동" submenu jumps the left pane to the collection and then to the paper, and is hidden for anything but exactly one paper',()=>{
  const {plugin} = fixture();
  const source = plugin.constructor.toString();
  assert.match(source, /make\("menu","컬렉션으로 이동",body\)/, 'the submenu is built beside the other verbs');
  // this.selected(win) already drops child rows, so this one guard covers
  // multi-selection and a click on an attachment/note/annotation alike.
  assert.match(source, /filedMenu\.hidden=chosen\.length!==1/);
  assert.match(source, /들어 있는 컬렉션 없음/, 'no collections still shows a line, not a blank submenu');
  assert.match(source, /collectionsView\.selectCollection\(Number\(id\)\)/, 'jumps the left pane first');
  assert.match(source, /win\.ZoteroPane\.selectItem\(paper\.id\)/, 'then selects the paper there');
  assert.match(source, /this\.collectionEntries\(paper\)/, 'lists the full path per collection, not the abbreviated cell text');
});

test('rows for papers that have left the library are dropped, and a small store is left alone', async () => {
 const {plugin, Z, item} = fixture(); Z.Libraries.userLibraryID = 1;
 plugin.active = true;
 const alive = item(42, {});
 Z.Libraries.getAll = () => [{libraryID: 1}];
 Z.Items = {...(Z.Items || {}), getAll: async () => [alive]};
 plugin.cache.items = {};
 for (let n = 0; n < 250; n++) plugin.cache.items['1:GONE' + n] = {seconds: 5};
 plugin.cache.items[plugin.identity(alive)] = {seconds: 99};
 assert.equal(await plugin.pruneDeletedItems(), 250, 'every key with no item behind it goes');
 assert.equal(plugin.cache.items[plugin.identity(alive)].seconds, 99, 'the paper that is still here keeps its reading time');
 // A store this small is not worth a library sweep.
 plugin.cache.items = {'1:ONLY': {seconds: 1}};
 assert.equal(await plugin.pruneDeletedItems(), 0);
 assert.deepEqual(Object.keys(plugin.cache.items), ['1:ONLY']);
 plugin.cancelScheduledFlush();
});

test('a write that fails says so once in the panel, and says it again only after a write succeeds', async () => {
 const {plugin, Z, item} = fixture(); Z.Libraries.userLibraryID = 1;
 plugin.active = true;
 const said = [];
 plugin.windows.set({closed: false}, {workbench: {setStatus: text => said.push(text)}});
 plugin.storage = {write: async () => { throw new Error('read-only volume'); }};
 plugin.dirty = true;
 await assert.rejects(() => plugin.flush(), /read-only/);
 assert.equal(said.length, 1, 'the panel is told');
 assert.match(said[0], /저장하지 못했습니다/);
 assert.equal(plugin.dirty, true, 'and nothing is treated as saved');
 plugin.dirty = true;
 await assert.rejects(() => plugin.flush(), /read-only/);
 assert.equal(said.length, 1, 'the same failure is not repeated at every tick');
 plugin.storage = {write: async () => {}};
 plugin.dirty = true; await plugin.flush();
 plugin.storage = {write: async () => { throw new Error('read-only volume'); }};
 plugin.dirty = true;
 await assert.rejects(() => plugin.flush(), /read-only/);
 assert.equal(said.length, 2, 'a failure after a good write is news again');
 plugin.cancelScheduledFlush();
});

test('a menu verb stays short and says the rest in its tooltip', () => {
 const {plugin} = fixture();
 const source = plugin.constructor.toString();
 const labels = [...source.matchAll(/action\("([^"]+)"/g)].map(m => m[1]);
 assert.ok(labels.length > 15, 'the menu was read');
 // A menu is as wide as its longest line; what a verb covers belongs in the
 // tooltip, not in brackets after the verb.
 for (const label of labels) {
  assert.ok(label.length <= 22, `menu verb too long: ${label} (${label.length})`);
  assert.ok(!/\(.*·.*\)/.test(label), `menu verb carries a list in brackets: ${label}`);
 }
 for (const label of ['빈 칸 채우기', '첨부파일 종류 판별', '철회·공개접근 확인']) {
  const at = source.indexOf('action("' + label + '"');
  const next = source.indexOf('action("', at + 8);
  assert.match(source.slice(at, next < 0 ? undefined : next), /,"[^"]{10,}"\);\s*$/m, `${label} explains itself in a tooltip`);
 }
});

test('audit #10: the download-verb entries, the copy-citation entry and the library-wide upkeep entries each carry a verb and a scope-honest tooltip', () => {
 const {plugin} = fixture();
 const source = plugin.constructor.toString();
 // "PDF만"/"모든 파일" read as attaching downloaded files with no verb and no
 // tooltip; each now names the action and says what it reaches.
 assert.doesNotMatch(source, /\["PDF만",true\]|\["모든 파일",false\]/, 'the bracketed-list labels are gone');
 assert.match(source, /\["보충자료 PDF 받기",true,"선택한 문헌의 PMC 보충자료 중 PDF만 내려받아 첨부합니다\."\]/);
 assert.match(source, /\["보충자료 모두 받기",false,"선택한 문헌의 PMC 보충자료를 형식 구분 없이 내려받아 첨부합니다\."\]/);
 // "인용…" read as citation *counts*, next to four other 인용 수 entries; it is the copy-citation dialog.
 assert.doesNotMatch(source, /action\("인용…"/);
 assert.match(source, /action\("인용문 복사…",\(\)=>this\.citationPanel\(win,this\.selected\(win\)\),body,"quote","선택한 문헌을 APA·MLA·Vancouver 등 형식으로 만들어 복사합니다\."\)/);
 for (const [label, hintFragment] of [
  ['선택한 문헌 인용 수 새로고침', '선택한 문헌의 인용 수를 OpenAlex에서 다시 가져옵니다.'],
  ['라이브러리 저널 지표 채우기', '이 라이브러리의 저널마다 OpenAlex를 한 번 조회해'],
  ['제목 앞 별 태그 정리', '이 라이브러리 전체에서 ★ 태그를 별점으로 옮기고 태그를 지웁니다.'],
  ['평점 태그를 Extra로 옮기기', '이 라이브러리 전체에서 태그로 남은 평점을'],
  ['커스텀 열로 전환', 'Zotero Style의 옛 열을 숨기고 이 플러그인의 열을 켭니다.'],
 ]) {
  const at = source.indexOf('action("' + label + '"');
  assert.ok(at >= 0, label);
  const next = source.indexOf('action("', at + 8);
  const call = source.slice(at, next < 0 ? undefined : next);
  assert.ok(call.includes(hintFragment), `${label} carries its new hint`);
 }
 // 첨부파일 종류 판별 and 먼저 세어만 보기 both act on the whole library when
 // nothing is selected -- both hints now say so, in the same words.
 for (const label of ['첨부파일 종류 판별', '먼저 세어만 보기']) {
  const at = source.indexOf('action("' + label + '"');
  const next = source.indexOf('action("', at + 8);
  assert.match(source.slice(at, next < 0 ? undefined : next), /선택한 문헌\(선택이 없으면 라이브러리 전체\)의/, `${label} states its scope`);
 }
 // 읽음 → 완료: the menu's own status entry now matches the panel's word for done.
 assert.doesNotMatch(source, /done:\s*"읽음"/);
 assert.match(source, /done:\s*"완료"/);
});

test('an error message tells the reader what to do next', () => {
 const fs = require('node:fs');
 const files = ['src/runtime.js', 'src/assist.js', 'src/library.js', 'src/workbench.js', 'src/workspace.js'];
 const dead = [];
 for (const file of files) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  for (const match of source.matchAll(/throw new Error\((['"])([^'"]{8,})\1\)/g)) {
   const text = match[2];
   if (!/[가-힣]/.test(text)) continue;
   // An error ends by telling the reader what to do, which in Korean means an
   // imperative. The two exceptions are messages where there is nothing to do.
   if (/(세요|십시오)\.?$/.test(text)) continue;
   if (['요청이 중지되었습니다.', '되돌릴 보드가 없습니다. 보드를 지운 뒤에만 되돌릴 수 있습니다.',
        '비교하려면 최소 한 편은 남아 있어야 합니다.', '진행 중인 인용 수 조회가 없습니다. 중지할 것이 없습니다.'].includes(text)) continue;
   dead.push(`${file}: ${text}`);
  }
 }
 assert.deepEqual(dead, [], 'every error ends with what to do about it');
});

/* The reading order's fetch. A fake OpenAlex that answers by the shape of the
   URL, and can be told to fail one kind of request. */
function pathFixture({fields = {title: 'A seed paper', DOI: '10.1/seed', date: '2022'}, fail = () => null, searchHits, europe} = {}) {
  const f = fixture();
  const ref = f.item(1);
  ref.getField = key => fields[key] || '';
  ref.getCreators = () => [];
  const asked = [];
  const W = (id, title, refs, extra = {}) => ({id: 'https://openalex.org/' + id, title, publication_year: 2015,
    doi: 'https://doi.org/10.1/' + id.toLowerCase(), cited_by_count: 50, type: 'article', topics: [TOPIC],
    referenced_works: refs.map(r => 'https://openalex.org/' + r), ...extra});
  const seed = W('W1', 'A seed paper', ['W7', 'W8', 'W9'], {publication_year: 2022});
  f.Z.HTTP = {request: async (method, url) => {
    asked.push(url);
    const failure = fail(url);
    if (failure) throw failure;
    if (/\/works\/doi:/.test(url)) return {response: seed};
    if (/title\.search/.test(url)) return {response: {results: searchHits ?? [seed]}};
    if (/europepmc/.test(url)) return {response: europe ?? {hitCount: 1, resultList: {result: [
      {doi: '10.1/w8', source: 'MED', abstractText: 'Background here. <i>We show</i> that the first paper binds DNA.'}]}}};
    if (/authorships/.test(decodeURIComponent(url)) && !/referenced_works/.test(decodeURIComponent(url))) return {response: {results: [
      {id: 'https://openalex.org/W7', authorships: [{author: {display_name: 'Ada Lovelace'}}]}]}};
    if (/cites/.test(url)) return {response: {results: []}};
    return {response: {results: [W('W7', 'An earlier paper', ['W8'], {publication_year: 2010}),
      W('W9', 'Another earlier paper', ['W8'], {publication_year: 2011}),
      W('W8', 'The first paper', [], {publication_year: 2005})]}};
  }};
  return {...f, ref, asked};
}
const budget = () => Object.assign(new Error('Insufficient budget'), {status: 429});

test('the reading order asks for authors only for the rows it shows, and keeps the plan across restarts', async () => {
  const f = pathFixture();
  const plan = await f.plugin.readingPathCached(f.ref);
  assert.ok(plan.steps.some(step => step.key === 'seed'));
  assert.ok(!f.asked.some(url => /openalex_id/.test(url) && /authorships/.test(url) && /referenced_works/.test(url)),
    'the bulk reference batches do not carry authorships');
  const rows = plan.steps.flatMap(step => [...step.works, ...step.more]).concat(plan.rest);
  assert.deepEqual(rows.find(w => w.id === 'W7')?.authors, ['Ada Lovelace']);
  assert.ok(f.plugin.cache.readingPaths[f.plugin.identity(f.ref)], 'kept on disk');
  assert.ok(!/"(references|builtOn)":\[/.test(JSON.stringify(f.plugin.cache.readingPaths)), 'without the reference lists');
  const asked = f.asked.length;
  f.plugin.discoverCache.clear();
  await f.plugin.readingPathCached(f.ref);
  assert.equal(f.asked.length, asked, 'a restart (empty memory cache) is served from disk');
  f.plugin.forgetReadingPath(f.ref);
  await f.plugin.readingPathCached(f.ref);
  assert.ok(f.asked.length > asked, 'asking again really asks again');
});

test('a reading plan made for one DOI is not kept under a DOI changed while it was being made', async () => {
  const fields = {title: 'A seed paper', DOI: '10.1/seed', date: '2022'};
  const f = pathFixture({fields});
  const making = f.plugin.readingPathCached(f.ref);
  fields.DOI = '10.1/other';
  await making;
  assert.equal(f.plugin.readingPathStore()[f.plugin.identity(f.ref)], undefined, 'not stored as the new paper\'s plan');
  f.plugin.readingPathStore()[f.plugin.identity(f.ref)] = {at: new Date().toISOString(), plan: {v: f.plugin.PATH_VERSION, stale: true}};
  const again = await f.plugin.readingPathCached(f.ref);
  assert.notEqual(again.stale, true, 'a plan kept without its identity is asked again');
});

test('a plan with a failed part says so and is not kept, and a spent budget is an error, not an empty plan', async () => {
  const f = pathFixture({fail: url => /cites/.test(url) ? budget() : null});
  const plan = await f.plugin.readingPathCached(f.ref);
  // A spent budget is spent for every part asked after it, as it is in OpenAlex.
  assert.ok(plan.partial.includes('citers'));
  assert.equal(plan.budgetGone, true);
  assert.equal(f.plugin.cache.readingPaths?.[f.plugin.identity(f.ref)], undefined, 'not kept');
  assert.equal(f.plugin.discoverCache.has('path:' + f.plugin.identity(f.ref)), false, 'not remembered in memory either');

  const g = pathFixture({fail: url => /\/works\/doi:/.test(url) ? null : budget()});
  await assert.rejects(() => g.plugin.readingPath(g.ref), /한도/);
});

test('without a DOI, a title search that finds a different paper is refused rather than analysed', async () => {
  const f = pathFixture({fields: {title: 'A seed paper', date: '2022'},
    searchHits: [{id: 'https://openalex.org/W99', title: 'Something else entirely about yeast', publication_year: 2022}]});
  await assert.rejects(() => f.plugin.readingPath(f.ref), /제목이 다릅니다/);
  const g = pathFixture({fields: {title: 'A seed paper.', date: '2022'}});
  const plan = await g.plugin.readingPath(g.ref);
  assert.equal(plan.titleMatched, true, 'a matching hit is used, and the panel is told it came from a title');
});

test('rows OpenAlex has no abstract for get their line from Europe PMC, and a bad answer is not taken for "none"', async () => {
  const f = pathFixture();
  const plan = await f.plugin.readingPath(f.ref);
  const w8 = plan.steps.flatMap(step => [...step.works, ...step.more]).concat(plan.rest).find(w => w.id === 'W8');
  assert.equal(w8.finding, 'We show that the first paper binds DNA.');
  assert.equal(w8.findingSource, 'Europe PMC');
  assert.equal(f.asked.filter(url => /europepmc/.test(url)).length, 1, 'one request for all the blank rows');

  const g = pathFixture({europe: {}});
  const again = await g.plugin.readingPath(g.ref);
  const blank = again.steps.flatMap(step => [...step.works, ...step.more]).concat(again.rest).find(w => w.id === 'W8');
  assert.ok(!blank.finding && !blank.findingSource, 'a 200 with an empty body leaves the row as it was');
});

test('a stored plan from an older algorithm is asked again, not drawn in a shape the panel no longer knows', async () => {
  const f = pathFixture();
  f.plugin.cache.readingPaths = {[f.plugin.identity(f.ref)]: {at: new Date().toISOString(), plan: {steps: [{key: 'seed', works: []}]}}};
  const plan = await f.plugin.readingPathCached(f.ref);
  assert.equal(plan.v, f.plugin.PATH_VERSION);
  assert.ok(f.asked.length > 0);
  assert.ok(plan.rest.length <= 60 && plan.restTotal >= plan.rest.length, 'the leftover list is kept short');
});

test('a caller handed a lookup another caller abandoned asks again instead of showing the abort', async () => {
  const f = pathFixture();
  let first = true;
  const original = f.plugin.readingPath.bind(f.plugin);
  f.plugin.readingPath = async (item, options) => {
    if (first) { first = false; await new Promise(resolve => setTimeout(resolve, 5)); throw Object.assign(new Error('aborted'), {name: 'AbortError'}); }
    return original(item, options);
  };
  const [a, b] = await Promise.allSettled([
    f.plugin.readingPathCached(f.ref, {signal: {aborted: true}}),
    f.plugin.readingPathCached(f.ref, {signal: {aborted: false}})
  ]);
  assert.equal(a.status, 'rejected', 'the caller that aborted sees its abort');
  assert.equal(b.status, 'fulfilled', 'the other caller gets a plan');
});

test('a failed lookup does not evict a newer one under the same key', async () => {
  const f = pathFixture();
  let reject;
  const old = f.plugin.discoverCached('k', () => new Promise((_, no) => { reject = no; }));
  await new Promise(resolve => setTimeout(resolve, 0));
  f.plugin.discoverCache.delete('k');
  const fresh = f.plugin.discoverCached('k', async () => 'new');
  reject(new Error('stale'));
  await old.catch(() => {});
  assert.equal(f.plugin.discoverCache.get('k'), fresh);
});

/* Faces for followed authors: Wikidata by ORCID first, then the person's own
   pages, and a busy Wikidata is never written down as "no photo". */
function portraitFixture({wikidataBusy = false, imageType = 'image/jpeg', orcidPages = []} = {}) {
  const f = fixture();
  const requests = [];
  f.plugin.pause = async () => {};
  f.plugin.flush = async () => {};
  f.plugin.cache.watchedAuthors = [
    {id: 'A1', name: 'Jane Q. Roe', orcid: '0000-0001-0000-0001'},
    {id: 'A2', name: 'Sam Okafor', orcid: '0000-0002-0000-0002'},
    {id: 'A3', name: 'No Trace', orcid: '0000-0003-0000-0003'},
    {id: 'A4', name: 'Mi-rae Han', orcid: '0000-0004-0000-0004'}];
  f.Z.HTTP = {request: async (method, url, options = {}) => {
    requests.push({url, accept: options.headers?.Accept});
    const json = response => ({status: 200, response, getResponseHeader: () => ''});
    if (/wikidata\.org/.test(url)) {
      if (wikidataBusy) return {status: 429, response: null, getResponseHeader: name => name === 'Retry-After' ? '1' : ''};
      if (/list=search/.test(url)) return json({query: {search: [{title: 'Q1'}, {title: 'Q2'}, {title: 'Q3'}, {title: 'Q4'}]}});
      const snak = value => ({mainsnak: {datavalue: {value}}, rank: 'normal'});
      return json({entities: {
        Q1: {id: 'Q1', claims: {P496: [snak('0000-0001-0000-0001')], P18: [snak('Jane Roe.jpg')]}},
        Q2: {id: 'Q2', claims: {P496: [snak('0000-0002-0000-0002')], P856: [snak('https://okafor-lab.example.org/')]}},
        // No Trace has a Scholar profile without a photo; Mi-rae Han has one with.
        Q3: {id: 'Q3', claims: {P496: [snak('0000-0003-0000-0003')], P1960: [snak('noPhoto0AAAJ')]}},
        Q4: {id: 'Q4', claims: {P496: [snak('0000-0004-0000-0004')], P1960: [snak('hanPhoto0AAJ')]}}}});
    }
    if (/pub\.orcid\.org/.test(url)) return {response: {'researcher-url': orcidPages.map(value => ({url: {value}}))}};
    if (method === 'HEAD' && /scholar\.googleusercontent/.test(url))
      return {status: 200, getResponseHeader: name => /content-type/i.test(name) ? (/noPhoto/.test(url) ? 'image/png' : 'image/jpeg') : ''};
    if (method === 'HEAD') return {status: 200, getResponseHeader: name => /content-type/i.test(name) ? imageType : ''};
    if (/okafor-lab/.test(url)) return {status: 200, getResponseHeader: () => 'text/html',
      responseText: '<h1>Sam Okafor</h1><img src="/people/sam-okafor.jpg" alt="Sam Okafor portrait" width="300" height="300">'};
    return {status: 404, getResponseHeader: () => 'text/html', responseText: ''};
  }};
  return {...f, requests};
}

test('followed authors get a Commons photo from Wikidata, else one from their own page', async () => {
  const f = portraitFixture();
  const result = await f.plugin.findWatchedPortraits();
  assert.deepEqual({asked: result.asked, found: result.found, wikimedia: result.wikimedia, scholar: result.scholar, homepage: result.homepage, none: result.none},
    {asked: 4, found: 3, wikimedia: 1, scholar: 1, homepage: 1, none: 1});
  assert.equal(f.plugin.portraitOf('A1').url, 'https://commons.wikimedia.org/wiki/Special:FilePath/Jane_Roe.jpg?width=160');
  assert.equal(f.plugin.portraitOf('A1').page, 'https://commons.wikimedia.org/wiki/File:Jane_Roe.jpg', 'the credit goes with the photo');
  assert.equal(f.plugin.portraitOf('A2').url, 'https://okafor-lab.example.org/people/sam-okafor.jpg');
  // Scholar's grey placeholder is a PNG and is no one's face; an uploaded photo is a JPEG.
  assert.equal(f.plugin.portraitOf('A3'), null);
  assert.equal(f.plugin.portraitOf('A4').url, 'https://scholar.googleusercontent.com/citations?view_op=view_photo&user=hanPhoto0AAJ&citpid=2');
  assert.equal(f.plugin.portraitOf('A4').page, 'https://scholar.google.com/citations?user=hanPhoto0AAJ');
  assert.equal(f.plugin.portraitsDue(), 0, 'everyone has been looked for');
  // ORCID answers in XML unless asked for JSON; the old search never asked.
  for (const r of f.requests.filter(r => /pub\.orcid\.org/.test(r.url))) assert.equal(r.accept, 'application/json');
  // Two Wikidata requests cover everyone, not one per person.
  assert.equal(f.requests.filter(r => /wikidata\.org/.test(r.url)).length, 2);
  // And the answer is kept: a second press asks nobody.
  const again = await f.plugin.findWatchedPortraits();
  assert.equal(again.asked, 0);
});

test('a Google Scholar page listed on ORCID is never fetched for a photo', async () => {
  const f = portraitFixture({orcidPages: ['https://scholar.google.com/citations?user=abcdefghijkl']});
  await f.plugin.findWatchedPortraits();
  assert.equal(f.requests.some(r => /scholar\.google\./.test(r.url)), false);
});

test('the button and the pass after a news sweep share one search', async () => {
  const f = portraitFixture();
  assert.equal(f.plugin.portraitsDue(), 4);
  const [a, b] = await Promise.all([f.plugin.findWatchedPortraits(), f.plugin.findWatchedPortraits()]);
  assert.equal(a, b, 'the second caller waits for the first search');
  assert.equal(f.requests.filter(r => /list=search/.test(r.url)).length, 1);
});

test('a busy Wikidata is not recorded as "no photo", so the next press tries again', async () => {
  const f = portraitFixture({wikidataBusy: true});
  const result = await f.plugin.findWatchedPortraits();
  assert.equal(result.busy, true);
  assert.equal(f.plugin.portraitOf('A1'), null);
  assert.equal(f.plugin.portraitCache().A1, undefined, 'no miss written for someone Wikidata could not be asked about');
  assert.equal(f.plugin.portraitCache().A3, undefined);
});

test('a homepage "photo" that answers with a web page is not counted as a face', async () => {
  const f = portraitFixture({imageType: 'text/html; charset=utf-8'});
  const result = await f.plugin.findWatchedPortraits();
  assert.equal(result.homepage, 0);
  assert.equal(f.plugin.portraitOf('A2'), null, 'Sam Okafor has no photo rather than a broken one');
  assert.ok(f.plugin.portraitOf('A1'), 'the Commons photo is unaffected');
});

/* 새로 나온 관련 논문: the sweep that asks what has just been published on top
   of a shelf. The shapes here are the ones OpenAlex answered with on this
   library's own collections in September 2026. */
function shelfFixture({results, pages} = {}) {
  const f = discoverFixture();
  f.plugin.active = true;
  f.plugin.flush = async () => {};
  const held = [1, 2, 3].map(n => {
    const ref = f.item(n);
    ref.getField = key => ({title: 'Held paper ' + n})[key] || '';
    f.plugin.paperWorks()[f.plugin.identity(ref)] = {openalex: 'https://openalex.org/W' + n, doi: '10.1/h' + n};
    return ref;
  });
  const asked = [];
  let page = 0;
  f.Z.HTTP = {request: async (method, url) => {
    asked.push(url);
    const body = pages ? pages[Math.min(page++, pages.length - 1)] : {results: results ?? []};
    return {response: body};
  }};
  return {...f, held, asked};
}
const citer = (id, {date, refs = [], type = 'article', doi = ''} = {}) => ({
  id: 'https://openalex.org/' + id, doi: doi ? 'https://doi.org/' + doi : null, title: 'New work ' + id,
  publication_year: Number(String(date).slice(0, 4)), publication_date: date, cited_by_count: 0, type,
  primary_location: {source: {display_name: 'A journal'}}, authorships: [],
  referenced_works: refs.map(r => 'https://openalex.org/' + r)
});

test('the whole shelf is asked about in one request, and the answer is ranked by how much of it each new paper builds on', async () => {
  const f = shelfFixture({results: [
    citer('W10', {date: '2026-09-01', refs: ['W1']}),
    citer('W11', {date: '2026-07-04', refs: ['W1', 'W2', 'W3']}),
    citer('W12', {date: '2026-09-20', refs: ['W2', 'W3']})
  ]});
  const report = await f.plugin.sweepFreshCiters(f.held, {days: 90});
  assert.equal(f.asked.length, 1, 'three held papers is one request, not three');
  assert.match(f.asked[0], /cites%3AW1%7CW2%7CW3/);
  assert.deepEqual(report.rows.map(r => [r.id, r.shared]), [['W11', 3], ['W12', 2], ['W10', 1]]);
  // The claim on the row names the held papers it stands on.
  assert.deepEqual(report.rows[0].citedTitles.sort(), ['Held paper 1', 'Held paper 2', 'Held paper 3']);
  assert.equal(report.seeds, 3);
  assert.equal(report.noWork, 0);
  // Hundreds of reference ids per row are not carried into the saved answer.
  assert.equal(report.rows[0].references, undefined);
});

test('held papers OpenAlex has never been asked about are counted, so "nothing new" is never written over "never asked"', async () => {
  const f = shelfFixture({results: []});
  const stranger = f.item(9);
  stranger.getField = () => 'A paper with no OpenAlex record';
  const report = await f.plugin.sweepFreshCiters([...f.held, stranger], {days: 90});
  assert.equal(report.seeds, 3);
  assert.equal(report.noWork, 1, 'the panel can say how much of the shelf could not be asked about');
  assert.deepEqual(report.rows, []);
});

test('a shelf with no OpenAlex records at all costs no request', async () => {
  const f = shelfFixture({results: []});
  const stranger = f.item(9);
  stranger.getField = () => 'Unknown';
  const report = await f.plugin.sweepFreshCiters([stranger]);
  assert.equal(f.asked.length, 0);
  assert.equal(report.seeds, 0);
});

test('datasets and peer reviews are not offered as new papers', async () => {
  const f = shelfFixture({results: [
    citer('W10', {date: '2026-09-01', refs: ['W1'], type: 'dataset'}),
    citer('W11', {date: '2026-09-02', refs: ['W1'], type: 'peer-review'}),
    citer('W12', {date: '2026-09-03', refs: ['W1'], type: 'article'})
  ]});
  const report = await f.plugin.sweepFreshCiters(f.held);
  assert.deepEqual(report.rows.map(r => r.id), ['W12']);
});

test('more citers than the pages asked for is reported, not passed off as the whole answer', async () => {
  const f = shelfFixture({pages: [
    {results: [citer('W10', {date: '2026-09-09', refs: ['W1']})], meta: {next_cursor: 'c2'}},
    {results: [citer('W11', {date: '2026-09-08', refs: ['W1']})], meta: {next_cursor: 'c3'}}
  ]});
  const report = await f.plugin.sweepFreshCiters(f.held, {pages: 2});
  assert.equal(report.requests, 2);
  assert.equal(report.truncated, true);
  assert.deepEqual(report.rows.map(r => r.id).sort(), ['W10', 'W11']);
});

test('a spent OpenAlex budget stops the sweep and the half answer is never kept as the answer', async () => {
  const f = shelfFixture();
  f.Z.HTTP = {request: async () => { throw Object.assign(new Error('Insufficient budget'), {status: 429}); }};
  const report = await f.plugin.freshCitersCached('library:1', f.held, {days: 90});
  assert.equal(report.budgetGone, true);
  assert.equal(report.partial, true);
  assert.deepEqual(f.plugin.freshCiterStore(), {}, 'nothing partial is remembered as a finished answer');
});

test('the answer is kept for a day, and asking again on purpose goes back out', async () => {
  const f = shelfFixture({results: [citer('W10', {date: '2026-09-01', refs: ['W1']})]});
  const first = await f.plugin.freshCitersCached('collection:115', f.held, {days: 90});
  assert.equal(f.asked.length, 1);
  const again = await f.plugin.freshCitersCached('collection:115', f.held, {days: 90});
  assert.equal(f.asked.length, 1, 'a question about months is not asked twice in one day');
  assert.equal(again.at, first.at, 'and the panel can say when it was checked');
  await f.plugin.freshCitersCached('collection:115', f.held, {days: 90, refresh: true});
  assert.equal(f.asked.length, 2, '다시 확인 asks again');
});

test('a page is reduced to the held papers it cites before the next page is asked for', async () => {
  // A sweep over a whole library is twenty-odd batches, each result carrying
  // its own bibliography. Only the part naming a held paper is ever read, and
  // keeping the rest would hold a hundred megabytes of ids in memory.
  const wide = citer('W10', {date: '2026-09-01', refs: ['W1', ...Array.from({length: 400}, (_, i) => 'WX' + i)]});
  const f = shelfFixture({results: [wide]});
  const report = await f.plugin.sweepFreshCiters(f.held);
  assert.deepEqual(report.rows[0].cites, ['W1']);
  assert.equal(report.rows[0].shared, 1);
  assert.equal(report.rows[0].references, undefined, 'and nothing of the other four hundred survives');
});

test('an empty reading-time cell says nothing was recorded, not that zero seconds were measured', async () => {
  /* The plugin times Zotero's reader and nothing else, so a paper read on
     paper has no record. "실제로 읽은 시간 0초" claimed a measurement that was
     never made, and looked exactly like a paper opened and closed at once. */
  const {parseHTML} = await import('linkedom');
  const {document, window} = parseHTML('<html><body></body></html>');
  const {plugin, item} = fixture();
  const ref = item(1);
  window.ZoteroPane = {itemsView: {getRow: () => ({ref}), selection: {isSelected: () => false}}};
  // renderCell reads the live value off the item rather than the argument.
  plugin.value = () => seconds;
  let seconds = 0;
  const blank = plugin.renderCell('time', 0, 0, {}, document);
  seconds = 4000;
  const read = plugin.renderCell('time', 0, 4000, {}, document);
  assert.match(String(blank.title), /읽기 기록 없음/);
  assert.doesNotMatch(String(blank.title), /0초/);
  assert.match(String(read.title), /실제로 읽은 시간 4000초/);
});

test('placeOf reads a followed author\'s country and tier from data already held, with no request', () => {
  const { plugin } = fixture();
  plugin.cache.institutions = { 'r1': { ror: 'r1', name: 'Example University', country: 'KR', hIndex: 2100 } };
  plugin.cache.works = { a: { people: [{ name: 'X', institution: 'Lab Co (Japan)', country: 'jp', ror: '' }] } };
  const hit = plugin.placeOf('Example University');
  assert.equal(hit.country, 'KR');
  assert.equal(hit.tier.key, 't1');
  assert.equal(hit.hIndex, 2100);
  assert.equal(plugin.placeOf('lab co').country, 'JP', 'name matched without its country suffix');
  assert.equal(plugin.placeOf('lab co').tier, null, 'no h-index, no tier');
  assert.equal(plugin.placeOf('Nowhere Institute'), null);
  assert.equal(plugin.placeOf(''), null);
});

test('r21 queueForReading adds to the reading queue under libraryID:key, with its reason, deduped', async () => {
  const { plugin, item, Z } = fixture();
  plugin.cache = { schema: 1, items: {} };
  const a = item(1), b = item(2), c = item(3);
  const byID = new Map([[1, a], [2, b], [3, c]]);
  Z.Items = { get: id => byID.get(id) };
  const stateOf = plugin.state.bind(plugin);
  plugin.state = ref => ref.id === 3 ? { status: 'done' } : { status: '' };
  plugin.flush = async () => { plugin.flushed = (plugin.flushed || 0) + 1; };
  let refreshed = 0;
  plugin.windows = new Map([[{ closed: false }, { workbench: { refreshReading: () => refreshed++ } }]]);
  assert.equal(plugin.isQueued(a), false);
  const n = await plugin.queueForReading([a, 2, c, a], { reason: 'ZotPoP 검색: crispr', source: 'zotpop' });
  assert.equal(n, 2, 'a and b; c is finished; a is not counted twice');
  assert.deepEqual(Object.keys(plugin.cache.workbenchUI.readingQueue).sort(), ['1:1', '1:2']);
  assert.equal(plugin.cache.workbenchUI.readingQueue['1:1'].reason.text, 'ZotPoP 검색: crispr');
  assert.equal(plugin.isQueued(a), true);
  assert.equal(plugin.isQueued(2), true, 'by id as well');
  assert.equal(plugin.isQueued(c), false);
  assert.equal(refreshed, 1, 'the open panel is refreshed');
  assert.equal(await plugin.queueForReading([a]), 0, 'already waiting');
  assert.equal(refreshed, 1, 'nothing added, nothing refreshed');
  assert.equal(await plugin.queueForReading(null), 0);
  void stateOf;
});

test('r21 evidence is kept per item under libraryID:key and empty fields are dropped', async () => {
  const { plugin, item } = fixture();
  plugin.cache = { schema: 1, items: {} };
  plugin.flush = async () => {};
  const a = item(1);
  assert.equal(plugin.evidenceOf(a).species, '');
  await plugin.setEvidence(a, { species: 'E. coli', result: 'x', bogus: 'no' });
  assert.deepEqual(Object.keys(plugin.cache.evidence), ['1:1']);
  assert.equal(plugin.evidenceOf(a).species, 'E. coli');
  assert.equal(plugin.cache.evidence['1:1'].bogus, undefined);
  await plugin.setEvidence(a, { species: '', result: '' });
  assert.equal(plugin.cache.evidence['1:1'], undefined, 'all empty: the row goes');
});

test('r21 connectPublished imports the published version, relates both, carries tags/status/memo, and deletes nothing', async () => {
  const { plugin, item, Z } = fixture();
  plugin.cache = { schema: 1, items: {} };
  plugin.flush = async () => {};
  plugin.refreshWindows = async () => {};
  const pre = item(1, { tags: [{ tag: 'topic/a', type: 0 }, { tag: '/done', type: 1 }] }), pub = item(2, { tags: [] });
  for (const ref of [pre, pub]) { const rel = []; ref.relatedItems = rel; ref.addRelatedItem = o => { if (!rel.includes(o.key)) rel.push(o.key); }; ref.saveTx = async () => {}; }
  plugin.entry(pre).signals = { doi: '', published: { doi: '10.9/pub', venue: 'Nature', year: 2025 } };
  plugin.signalsOf = ref => plugin.entry(ref).signals;
  plugin.entry(pre).remark = 'my memo';
  plugin.state = ref => ({ status: ref === pre ? 'done' : '' });
  const edits = [];
  plugin.edit = async (refs, patch) => { edits.push([refs[0].id, patch]); };
  plugin.findExistingWork = async () => null;
  let imports = 0;
  plugin.importWork = async () => { imports++; return Object.assign([pub], { existing: false }); };
  const result = await plugin.connectPublished(pre, {});
  assert.equal(imports, 1);
  assert.equal(result.imported, true);
  assert.deepEqual(pre.relatedItems, ['2']);assert.deepEqual(pub.relatedItems, ['1']);
  assert.ok(pub.pendingTags.some(t => t.tag === 'topic/a'), 'tags carried over');
  assert.deepEqual(edits, [[2, { status: 'done' }]], 'reading status carried over');
  assert.equal(plugin.entry(pub).remark, 'my memo');
  // Held already: only the link, nothing copied, no import.
  const again = item(3, { tags: [] });again.relatedItems = [];again.addRelatedItem = o => { again.relatedItems.push(o.key); };pub.relatedItems.length = 0;again.saveTx = async () => {};
  plugin.entry(again).signals = { published: { doi: '10.9/pub' } };
  plugin.findExistingWork = async () => pub;
  const r2 = await plugin.connectPublished(again, {});
  assert.equal(imports, 1);assert.equal(r2.imported, false);assert.equal(r2.linked, true);
  assert.deepEqual(again.relatedItems, ['2']);
  assert.equal(again.pendingTags, null);
  void Z;
});

test('runtime.say reports in the panel status line and never raises a modal Zotero.alert',async()=>{
 const {plugin,Z}=fixture();
 let alerts=0;Z.alert=()=>{alerts++;};
 const shown=[];const win={closed:false};
 plugin.windows.set(win,{workbench:{notify:(text,opts)=>{shown.push([text,opts]);}}});
 await plugin.say(win,'첫 줄\n둘째 줄');
 assert.equal(alerts,0,'no pop-up');
 assert.equal(shown.length,1);
 assert.match(shown[0][0],/첫 줄.*둘째 줄/);
 plugin.windows.clear();
 await plugin.say(win,'패널이 없을 때도');
 assert.equal(alerts,0,'no pop-up even with no panel open');
});
