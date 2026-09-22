import test from 'node:test';
import assert from 'node:assert/strict';
import Library from '../src/library.js';
function fixture() {
 const items=new Map(),opened=[],entryCache={};let next=20;
 class Item {
  constructor(type='journalArticle',id=++next,libraryID=1){Object.assign(this,{id,key:'K'+id,libraryID,type,itemTypeID:type,tags:[],relatedItems:[],fields:{title:'Title '+id},html:'',dirty:false});}
  isRegularItem(){return this.type==='journalArticle';}isNote(){return this.type==='note';}isAttachment(){return this.type==='attachment';}isAnnotation(){return this.type==='annotation';}isFileAttachment(){return this.isAttachment()&&this.attachmentContentType!=='link';}
  isEditable(){return this.libraryID!==2;}hasChanged(){return this.dirty;}getField(k){return this.fields[k]||'';}getTags(){return this.tags.map(t=>({...t}));}setTags(tags){this.tags=tags;this.dirty=true;}getCreators(){return [{firstName:'Ada',lastName:'Lovelace'}];}
  getNotes(){return [...items.values()].filter(i=>i.parentID===this.id&&i.isNote()).map(i=>i.id);}getAttachments(){return [...items.values()].filter(i=>i.parentID===this.id&&i.isAttachment()).map(i=>i.id);}getAnnotations(){return [...items.values()].filter(i=>i.parentID===this.id&&i.isAnnotation());}
  getNote(){return this.html;}getNoteTitle(){return this.html.replace(/<[^>]*>/g,'').slice(0,20);}setNote(html){this.html=html;}getFilePathAsync(){return Promise.resolve('/tmp/sample.pdf');}
  addRelatedItem(item){if(!this.relatedItems.includes(item.key))this.relatedItems.push(item.key);this.dirty=true;}
  getRelations(){return {'dc:relation':this.relatedItems.map(key=>'http://zotero.org/users/local/abc/items/'+key),...(this.otherRelations||{})};}setRelations(value){this.relatedItems=(value['dc:relation']||[]).map(uri=>uri.startsWith('http://zotero.org/users/local/abc/items/')?uri.split('/').pop():uri);this.otherRelations=Object.fromEntries(Object.entries(value).filter(([k])=>k!=='dc:relation'));this.dirty=true;}
  async save(){if(this.fail)throw Error('write failed');items.set(this.id,this);this.dirty=false;return this.id;}
  _clearChanged(){this.dirty=false;}async reload(){if(this.before){Object.assign(this,structuredClone(this.before));}}
 }
 const Z={Item,Relations:{relatedItemPredicate:'dc:relation'},Items:{getAsync:async id=>items.get(id),getAll:async id=>[...items.values()].filter(i=>i.libraryID===id)},Libraries:{userLibraryID:1,get:id=>[1,2].includes(id)?{editable:id===1,libraryType:'user'}:null},ItemTypes:{getName:id=>id},Promise:{delay:async()=>{}},URI:{getItemURI:i=>'http://zotero.org/users/local/abc/items/'+i.key},Collections:{getByLibrary:()=>[{id:4,name:'Research',parentID:null,getChildItems:()=>[...items.values()]}]},DB:{executeTransaction:async fn=>{for(const i of items.values())i.before={tags:structuredClone(i.tags),relatedItems:[...i.relatedItems],dirty:i.dirty};return fn();}},Reader:{open:async(...args)=>opened.push(['reader',...args])},getMainWindow:()=>({ZoteroPane:{openNoteWindow:id=>opened.push(['note',id]),viewItems:list=>opened.push(['items',list.map(i=>i.id)])}}),EditorInstance:{createNoteFromAnnotations:async(input,opts)=>{assert.equal(opts.noSave,true);const note=new Item('note');note.setNote('<div data-schema-version="9"><a href="zotero://open-pdf/library/items/K2?annotation=K3">Source</a><p>'+input[0].annotationText+'</p></div>');return note;}}};
 const runtime={entry:i=>entryCache[i.id]||=( {}),flush:async()=>{}};
 const add=(type,id,props={})=>{const i=new Item(type,id);Object.assign(i,props);items.set(id,i);return i;};
 const parent=add('journalArticle',1,{tags:[{tag:'science/method',type:1},{tag:'science/data',type:0}]});
 const attachment=add('attachment',2,{parentID:1,attachmentContentType:'application/pdf'});
 const annotation=add('annotation',3,{parentID:2,annotationText:'Quote',annotationComment:'Comment',annotationType:'highlight',annotationColor:'#ffff00',annotationPageLabel:'iii',annotationPosition:'{"pageIndex":2}'});
 const note=add('note',4,{parentID:1,html:'<p>Hello <b>rich</b> note</p>'});
 return {service:Library.create({Zotero:Z,runtime}),Z,runtime,items,add,parent,attachment,annotation,note,opened};
}
test('snapshot scope and DTOs exclude child/trash, resolve related IDs',async()=>{
 const f=fixture();const second=f.add('journalArticle',5);f.parent.relatedItems=['K5'];f.add('journalArticle',6,{libraryID:2});f.add('journalArticle',7,{deleted:true});
 const rows=await f.service.snapshot(1);assert.deepEqual(rows.map(r=>r.id),['1','5']);assert.equal(rows[0].authors,'Ada Lovelace');assert.equal(rows[0].itemType,'journalArticle');assert.deepEqual(rows[0].related,['5']);assert.equal(typeof rows[0].abstract,'string');
 await assert.rejects(f.service.snapshot(99));
});
test('graphs preserve string IDs, dedupe undirected edges and bound size',()=>{
 const s=fixture().service,rows=[{id:1,title:'A',related:['2'],tags:['x'],authors:'Ada'},{id:'2',title:'B',related:[1],tags:['x'],authors:'Ada'}];
 for(const mode of ['related','tags','authors']){const g=s.graph(rows,{mode});assert.equal(g.edges.length,1);assert.deepEqual(g.edges[0],{source:'1',target:'2',kind:mode});}
 assert.equal(s.graph(rows,{query:'A'}).nodes.length,2);assert.equal(s.graph(rows,{query:'missing'}).nodes.length,0);
 assert.equal(s.graph(Array.from({length:510},(_,i)=>({id:i,title:'x'}))).nodes.length,500);assert.equal(s.graph(Array.from({length:510},(_,i)=>({id:i}))).truncated,true);assert.throws(()=>s.graph([],{mode:'bogus'}));
});
test('nested tags count distinct items for prefixes and retain slash status',()=>{
 const tree=fixture().service.tagTree([{id:1,tags:['science/a','science/b','/done','style-custom:rating:4']},{id:2,tags:['science/a']}]);
 assert.equal(tree.find(n=>n.path==='science').count,2);assert.equal(tree.find(n=>n.path==='science').children[0].count,2);assert.ok(tree.find(n=>n.path==='/done'));assert.equal(tree.length,2);
});
test('notes, annotations and attachments retain source metadata with explicit selection',async()=>{
 const f=fixture();assert.equal((await f.service.notes([1]))[0].text,'Hello rich note');assert.match((await f.service.notes([4]))[0].html,/<b>/);assert.equal((await f.service.notes([])).length,0);
 const a=(await f.service.annotations([1]))[0];assert.equal(a.pageIndex,2);assert.equal(a.attachmentID,'2');assert.equal(a.parentID,'1');assert.equal((await f.service.annotations([3])).length,1);
 assert.equal((await f.service.attachments([1]))[0].path,'/tmp/sample.pdf');
 f.annotation.annotationPosition='bad';assert.equal((await f.service.annotations([1]))[0].pageIndex,null);
});
test('backlinks find related items and note navigation links without substring key matches',async()=>{
 const f=fixture();f.add('journalArticle',5,{relatedItems:['K1']});f.note.html='<a href="zotero://open-pdf/library/items/K2?annotation=K3">Quote</a>';
 f.add('note',6,{html:'<a href="zotero://select/library/items/K10">Different</a>'});
 const links=await f.service.backlinks(1);assert.deepEqual(links.map(v=>v.id).sort(),['4','5']);
});
test('createNote escapes plain text and annotation extraction uses native rich-source serialization',async()=>{
 const f=fixture();const id=await f.service.createNote(1,'<img onerror="bad">\n& test');assert.match(f.items.get(Number(id)).html,/&lt;img/);assert.doesNotMatch(f.items.get(Number(id)).html,/<img/);
 const noteID=await f.service.noteFromAnnotations([3]);const note=f.items.get(Number(noteID));assert.match(note.html,/zotero:\/\/open-pdf/);assert.equal(note.parentID,1);assert.equal(note.libraryID,1);
 const other=f.add('journalArticle',6);f.add('attachment',7,{parentID:6,attachmentContentType:'application/pdf'});f.add('annotation',8,{parentID:7});await assert.rejects(f.service.noteFromAnnotations([3,8]),/share/);
});
test('tag edits preserve retained types and additive edits preserve state markers',async()=>{
 const f=fixture();f.parent.tags.push({tag:'style-custom:rating:4',type:0});
 await f.service.addTags([1],['science/method','new']);assert.equal(f.parent.tags.length,4);assert.equal(f.parent.tags[0].type,1);assert.ok(f.parent.tags.find(t=>t.tag==='style-custom:rating:4'));
 await f.service.setTags([1],['science/method','replacement']);assert.deepEqual(f.parent.tags,[{tag:'science/method',type:1},{tag:'replacement',type:0}]);
 await assert.rejects(f.service.addTags(undefined,['x']));
});
test('batch edit checks all items before mutations, rejects dirty/cross-library and reloads failures',async()=>{
 const f=fixture();const other=f.add('journalArticle',5,{libraryID:2});const original=JSON.stringify(f.parent.tags);
 await assert.rejects(f.service.setTags([1,5],['x']),/read-only/);assert.equal(JSON.stringify(f.parent.tags),original);
 f.parent.dirty=true;await assert.rejects(f.service.addTags([1],['x']),/unsaved/);f.parent.dirty=false;
 other.libraryID=1;other.fail=true;await assert.rejects(f.service.setTags([1,5],['x']),/write failed/);assert.equal(JSON.stringify(f.parent.tags),original);
 other.libraryID=2;await assert.rejects(f.service.relate([1,5]),/same library/);
});
test('relate is symmetric and preserves unrelated relations',async()=>{
 const f=fixture();f.add('journalArticle',5);f.parent.relatedItems=['K9'];await f.service.relate([1,5]);assert.deepEqual(f.parent.relatedItems,['K9','K5']);assert.deepEqual(f.items.get(5).relatedItems,['K1']);
});
test('remarks use own cache and failures restore previous value',async()=>{
 const f=fixture();const original=f.parent.fields.extra;await f.service.setRemark(1,'remark');assert.equal(f.runtime.entry(f.parent).remark,'remark');assert.equal(f.parent.fields.extra,original);
 f.runtime.flush=async()=>{throw Error('disk');};await assert.rejects(f.service.setRemark(1,'lost'));assert.equal(f.runtime.entry(f.parent).remark,'remark');
});
test('native opening routes notes and annotations, collection counts exclude children',async()=>{
 const f=fixture();await f.service.openItem(4);await f.service.openItem(3,{pageIndex:2});assert.deepEqual(f.opened,[['note',4],['reader',2,{pageIndex:2,annotationKey:'K3'}]]);
 assert.equal((await f.service.collections(1))[0].count,1);
});

test('transaction guard rejection does not reload or discard newly dirty user state',async()=>{
 const f=fixture();let reloads=0;f.parent.reload=async()=>{reloads++;};
 f.Z.DB.executeTransaction=async fn=>{f.parent.dirty=true;f.parent.tags.push({tag:'user edit',type:0});return fn();};
 await assert.rejects(f.service.addTags([1],['plugin edit']),/unsaved/);
 assert.equal(reloads,0);assert.ok(f.parent.tags.find(t=>t.tag==='user edit'));assert.ok(!f.parent.tags.find(t=>t.tag==='plugin edit'));
});

test('backlinks do not confuse the same item key in another library route',async()=>{
 const f=fixture();f.note.html='<a href="zotero://select/groups/999/items/K1">Other library</a>';
 assert.deepEqual(await f.service.backlinks(1),[]);
});

test('failed later tag save restores DB tags and retains concurrent additions, removals, type changes',async()=>{
 const f=fixture();f.parent.tags=[{tag:'keep',type:0},{tag:'remove',type:0},{tag:'type',type:0}];const other=f.add('journalArticle',5);
 other.save=async()=>{f.parent.setTags([{tag:'keep',type:0},{tag:'type',type:1},{tag:'plugin',type:0},{tag:'user',type:0}]);throw Error('late failure');};
 await assert.rejects(f.service.addTags([1,5],['plugin']),/late failure/);
 assert.deepEqual(f.parent.tags,[{tag:'keep',type:0},{tag:'type',type:1},{tag:'user',type:0}]);assert.equal(f.parent.dirty,true);
});
test('failed relation batch retains external relation changes without failed plugin edges',async()=>{
 const f=fixture();f.parent.relatedItems=['K9','K8'];const other=f.add('journalArticle',5);
 other.save=async()=>{f.parent.setRelations({'dc:relation':['K9','K5','K7'],'owl:sameAs':['https://example.org/user']});throw Error('late failure');};
 await assert.rejects(f.service.relate([1,5]),/late failure/);
 assert.deepEqual(f.parent.relatedItems,['K9','K7']);assert.deepEqual(f.parent.otherRelations,{'owl:sameAs':['https://example.org/user']});assert.equal(f.parent.dirty,true);
});

test('exact tag removal preserves nested descendants, status, rating and retained types',async()=>{
 const f=fixture();f.parent.tags=[{tag:'topic',type:1},{tag:'topic/nested',type:1},{tag:'/done',type:0},{tag:'style-custom:rating:4',type:0},{tag:'★★★★',type:0},{tag:'other',type:1}];
 await f.service.removeTags([1],['topic']);assert.deepEqual(f.parent.tags,[{tag:'topic/nested',type:1},{tag:'/done',type:0},{tag:'style-custom:rating:4',type:0},{tag:'★★★★',type:0},{tag:'other',type:1}]);
 await assert.rejects(f.service.removeTags(undefined,['other']));f.parent.dirty=true;await assert.rejects(f.service.removeTags([1],['other']),/unsaved/);assert.ok(f.parent.tags.some(t=>t.tag==='other'));
});

test('older failed remark flush does not overwrite a newer successful remark',async()=>{
 const f=fixture();let rejectFirst;const first=new Promise((_,reject)=>{rejectFirst=reject;});let calls=0;f.runtime.flush=()=>++calls===1?first:Promise.resolve();
 const old=f.service.setRemark(1,'Older remark');await Promise.resolve();await Promise.resolve();const expected=assert.rejects(old,/older failure/);await f.service.setRemark(1,'Newer remark');rejectFirst(Error('older failure'));await expected;assert.equal(f.runtime.entry(f.parent).remark,'Newer remark');
});

test('remark save revisions are shared by window services including identical newer values',async()=>{
 const f=fixture(),otherWindow=Library.create({Zotero:f.Z,runtime:f.runtime});let rejectFirst;const pending=new Promise((_,reject)=>{rejectFirst=reject;});let calls=0;f.runtime.flush=()=>++calls===1?pending:Promise.resolve();
 const first=f.service.setRemark(1,'Same text');await Promise.resolve();await Promise.resolve();const rejected=assert.rejects(first);await otherWindow.setRemark(1,'Same text');rejectFirst(Error('old window failed'));await rejected;assert.equal(f.runtime.entry(f.parent).remark,'Same text');
});

test('R01 branch rename merges existing destinations without losing types or sibling tags',async()=>{
 const f=fixture();f.parent.tags=[{tag:'topic',type:1},{tag:'topic/a',type:1},{tag:'topic/ab',type:0},{tag:'topicish',type:1},{tag:'target/a',type:0},{tag:'/done',type:0},{tag:'style-custom:rating:4',type:0}];
 const result=await f.service.renameTagBranch([1],'topic','target');assert.deepEqual(result,{updatedItems:1,renamedTags:3,mergedTags:1});
 const byName=new Map(f.parent.tags.map(t=>[t.tag,t.type]));assert.equal(byName.get('target'),1);assert.equal(byName.get('target/a'),0);assert.equal(byName.get('target/ab'),0);assert.equal(byName.get('topicish'),1);assert.ok(byName.has('/done'));assert.ok(byName.has('style-custom:rating:4'));assert.equal(f.parent.tags.length,6);
});
test('R01 exact rename and scoped guards prevent subtree and cross-library changes',async()=>{
 const f=fixture();await f.service.renameTagBranch([1],'science/method','method',{subtree:false});assert.ok(f.parent.tags.some(t=>t.tag==='science/data'));assert.ok(f.parent.tags.some(t=>t.tag==='method'));
 const other=f.add('journalArticle',5,{libraryID:2});await assert.rejects(f.service.renameTagBranch([1,5],'method','changed'),/same library/);assert.ok(f.parent.tags.some(t=>t.tag==='method'));
 await assert.rejects(f.service.renameTagBranch([1],'/done','done'));await assert.rejects(f.service.renameTagBranch([1],'method','style-custom:rating:0'));
});
test('R01 moving a branch below itself maps each original suffix once and rolls back batch failure',async()=>{
 const f=fixture();f.parent.tags=[{tag:'a',type:1},{tag:'a/b',type:0}];await f.service.renameTagBranch([1],'a','a/new');assert.deepEqual(f.parent.tags,[{tag:'a/new',type:1},{tag:'a/new/b',type:0}]);
 const other=f.add('journalArticle',5,{tags:[{tag:'a/new',type:0}],fail:true});const before=structuredClone(f.parent.tags);await assert.rejects(f.service.renameTagBranch([1,5],'a/new','target'),/write failed/);assert.deepEqual(f.parent.tags,before);
});

test('R02 recolor validates complete parent chain before changing annotation color',async()=>{
 const f=fixture();assert.equal(await f.service.recolorAnnotations([3],'#FF6666'),1);assert.equal(f.annotation.annotationColor,'#ff6666');assert.equal(f.annotation.annotationComment,'Comment');assert.equal(f.annotation.annotationText,'Quote');
 f.parent.dirty=true;await assert.rejects(f.service.recolorAnnotations([3],'#00ff00'),/unsaved/);assert.equal(f.annotation.annotationColor,'#ff6666');f.parent.dirty=false;f.attachment.libraryID=2;await assert.rejects(f.service.recolorAnnotations([3],'#00ff00'));await assert.rejects(f.service.recolorAnnotations([3],'red'));
});
test('R02 failed bulk recolor preserves newer annotation comments and user colors',async()=>{
 const f=fixture(),other=f.add('annotation',5,{parentID:2,annotationColor:'#aaaaaa',annotationComment:'Other'});const originals=new Map([[3,{annotationColor:'#ffff00',annotationComment:'Comment'}],[5,{annotationColor:'#aaaaaa',annotationComment:'Other'}]]);
 for(const annotation of [f.annotation,other])annotation.reload=async()=>{Object.assign(annotation,originals.get(annotation.id));};
 other.save=async()=>{f.annotation.annotationColor='#00ff00';f.annotation.annotationComment='User comment while saving';throw Error('second annotation failed');};
 await assert.rejects(f.service.recolorAnnotations([3,5],'#ff0000'),/second annotation failed/);assert.equal(f.annotation.annotationColor,'#00ff00');assert.equal(f.annotation.annotationComment,'User comment while saving');assert.equal(other.annotationColor,'#aaaaaa');
});
test('R02 a parent becoming dirty mid-batch aborts later recolors without discarding parent edits',async()=>{
 const f=fixture(),other=f.add('annotation',5,{parentID:2,annotationColor:'#111111'});f.annotation.reload=async()=>{f.annotation.annotationColor='#ffff00';};f.annotation.save=async()=>{f.parent.dirty=true;f.parent.tags.push({tag:'user draft',type:0});};
 await assert.rejects(f.service.recolorAnnotations([3,5],'#ff0000'),/unsaved/);assert.equal(f.annotation.annotationColor,'#ffff00');assert.equal(other.annotationColor,'#111111');assert.ok(f.parent.tags.some(t=>t.tag==='user draft'));assert.equal(f.parent.dirty,true);
});

test('R03 selected relation removal is symmetric and preserves other links and predicates',async()=>{
 const f=fixture(),second=f.add('journalArticle',5,{relatedItems:['K1','K8']});f.parent.relatedItems=['K5','K9'];f.parent.otherRelations={'owl:sameAs':['https://example.org/identity']};
 assert.equal(await f.service.unrelate([1,5]),2);assert.deepEqual(f.parent.relatedItems,['K9']);assert.deepEqual(second.relatedItems,['K8']);assert.deepEqual(f.parent.otherRelations,{'owl:sameAs':['https://example.org/identity']});assert.equal(await f.service.unrelate([1,5]),0);
});
test('R03 relation removal rejects cross-library input and restores links after later failure',async()=>{
 const f=fixture(),second=f.add('journalArticle',5,{relatedItems:['K1']});f.parent.relatedItems=['K5'];second.fail=true;await assert.rejects(f.service.unrelate([1,5]),/write failed/);assert.deepEqual(f.parent.relatedItems,['K5']);second.libraryID=2;await assert.rejects(f.service.unrelate([1,5]),/same library/);
});
test('R03 unlink handles one-sided edges and retains concurrent unrelated edits on rollback',async()=>{
 const f=fixture(),second=f.add('journalArticle',5,{relatedItems:[]});f.parent.relatedItems=['K5','K9'];assert.equal(await f.service.unrelate([1,5]),1);assert.deepEqual(f.parent.relatedItems,['K9']);
 f.parent.relatedItems=['K5','K9'];second.relatedItems=['K1'];second.save=async()=>{f.parent.relatedItems=['K9','K7'];throw Error('late unlink failure');};await assert.rejects(f.service.unrelate([1,5]),/late unlink failure/);assert.deepEqual(f.parent.relatedItems,['K5','K9','K7']);assert.equal(f.parent.dirty,true);
});

test('R04 collection scope returns deduplicated direct or recursive regular item IDs',async()=>{
 const f=fixture(),second=f.add('journalArticle',5),deleted=f.add('journalArticle',6,{deleted:true});const collections=new Map();
 collections.set(10,{id:10,libraryID:1,getChildItems:()=>[f.parent,f.attachment,deleted],getChildCollections:()=>[collections.get(11)]});collections.set(11,{id:11,libraryID:1,getChildItems:()=>[f.parent,second],getChildCollections:()=>[]});f.Z.Collections.getAsync=async id=>collections.get(id);
 assert.deepEqual(await f.service.collectionItems(10,{libraryID:1}),['1']);assert.deepEqual(await f.service.collectionItems(10,{libraryID:1,recursive:true}),['1','5']);
 await assert.rejects(f.service.collectionItems(10,{libraryID:2}),/library/);await assert.rejects(f.service.collectionItems(10,{}),/library/i);
});
test('R04 collection scope rejects foreign descendants and terminates cycles',async()=>{
 const f=fixture(),root={id:10,libraryID:1,getChildItems:()=>[f.parent]},child={id:11,libraryID:2,getChildItems:()=>[]};root.getChildCollections=()=>[child];child.getChildCollections=()=>[root];f.Z.Collections.getAsync=async id=>id===10?root:child;
 await assert.rejects(f.service.collectionItems(10,{libraryID:1,recursive:true}),/library/);child.libraryID=1;assert.deepEqual(await f.service.collectionItems(10,{libraryID:1,recursive:true}),['1']);
});
test('R04 querying another library collection does not change default note scope',async()=>{
 const f=fixture(),other=f.add('journalArticle',5,{libraryID:2});f.add('note',6,{libraryID:2,parentID:5,html:'Other library note'});await f.service.snapshot(1);
 f.Z.Collections.getAsync=async()=>({id:12,libraryID:2,getChildItems:()=>[other]});assert.deepEqual(await f.service.collectionItems(12,{libraryID:2}),['5']);assert.deepEqual((await f.service.notes()).map(n=>n.id),['4']);
 f.Z.Collections.getAsync=async()=>({id:10,libraryID:1,getChildItems:()=>[other]});await assert.rejects(f.service.collectionItems(10,{libraryID:1}),/another library/);
});

test('R13 annotation backlinks distinguish two highlights in the same attachment',async()=>{
 const f=fixture();f.add('annotation',5,{parentID:2,annotationText:'Other quote'});const uri=f.Z.URI.getItemURI(f.attachment);
 f.note.html='<span data-annotation="'+encodeURIComponent(JSON.stringify({attachmentURI:uri,annotationKey:'K3'}))+'">Quote A</span>';
 f.add('note',6,{html:'<span data-annotation="'+encodeURIComponent(JSON.stringify({attachmentURI:uri,annotationKey:'K5'}))+'">Quote B</span>'});
 f.add('note',7,{html:'<a href="zotero://open-pdf/library/items/K2?page=1&amp;annotation=K3">Specific quote</a>'});f.add('note',8,{html:'<a href="zotero://open-pdf/library/items/K2?page=1">Whole attachment</a>'});
 assert.deepEqual((await f.service.backlinks(3)).map(n=>n.id),['4','7']);assert.deepEqual((await f.service.backlinks(5)).map(n=>n.id),['6']);
});
test('R13 annotation backlinks accept escaped metadata and reject group or annotation-key collisions',async()=>{
 const f=fixture(),uri=f.Z.URI.getItemURI(f.attachment);
 f.note.html='<span data-annotation="'+JSON.stringify({attachmentURI:uri,annotationKey:'K3'}).replace(/"/g,'&quot;')+'">Escaped</span>';
 f.add('note',5,{html:'<a href="zotero://open-pdf/groups/999/items/K2?annotation=K3">Other library</a>'});
 f.add('note',6,{html:'<a href="zotero://select/library/items/K30">Other annotation</a>'});
 f.add('note',7,{html:'<a href="'+encodeURIComponent('zotero://select/library/items/K3')+'">Direct</a>'});
 f.add('note',8,{html:'<span data-annotation="'+encodeURIComponent(JSON.stringify({attachmentURI:'http://zotero.org/groups/999/items/K2',annotationKey:'K3'}))+'">Foreign annotation</span>'});
 assert.deepEqual((await f.service.backlinks(3)).map(n=>n.id),['4','7']);
});
test('R13 malformed or ambiguous annotation references and quoted markup do not create backlinks',async()=>{
 const f=fixture(),data=encodeURIComponent(JSON.stringify({attachmentURI:f.Z.URI.getItemURI(f.attachment),annotationKey:'K3'}));f.note.html='<p>&lt;span data-annotation="'+data+'"&gt;example&lt;/span&gt;</p>';
 f.add('note',5,{html:'<a href="zotero://open-pdf/library/items/K2?annotation=K3&amp;annotation=K5">Ambiguous</a>'});f.add('note',6,{html:'<span data-annotation="%invalid">Broken</span>'});assert.deepEqual(await f.service.backlinks(3),[]);
});

function mergeFixture(){
 const f=fixture();Object.assign(f.annotation,{annotationText:'First paragraph',annotationComment:'First comment',annotationColor:'#ffff00',annotationSortIndex:'00002|000001|00000',annotationPosition:JSON.stringify({pageIndex:2,rects:[[0,0,10,10]]}),tags:[{tag:'one',type:1}]});
 const second=f.add('annotation',5,{parentID:2,annotationType:'highlight',annotationText:'Second paragraph',annotationComment:'Second comment',annotationColor:'#ffff00',annotationSortIndex:'00003|000001|00000',annotationPosition:JSON.stringify({pageIndex:3,rects:[[1,1,20,20]]}),tags:[{tag:'two',type:0}]});
 const originalTransaction=f.Z.DB.executeTransaction;f.Z.DB.executeTransaction=async fn=>originalTransaction(async()=>{for(const item of f.items.values())item.before={...item.before,annotationType:item.annotationType,annotationText:item.annotationText,annotationComment:item.annotationComment,annotationColor:item.annotationColor,annotationSortIndex:item.annotationSortIndex,annotationPosition:item.annotationPosition,deleted:item.deleted};return fn();});
 return {...f,second};
}
test('R15 adjacent-page merge preserves geometry, paragraphs, comments and tags in reading order',async()=>{
 const f=mergeFixture();assert.equal(await f.service.mergeAnnotations([5,3]),'3');assert.equal(f.second.deleted,true);assert.equal(f.annotation.deleted,undefined);assert.deepEqual(JSON.parse(f.annotation.annotationPosition),{pageIndex:2,rects:[[0,0,10,10]],nextPageRects:[[1,1,20,20]]});assert.equal(f.annotation.annotationText,'First paragraph\n\nSecond paragraph');assert.equal(f.annotation.annotationComment,'First comment\n\nSecond comment');assert.deepEqual(f.annotation.tags,[{tag:'one',type:1},{tag:'two',type:0}]);
});
test('R15 merge rejects stale, external, mismatched or unsupported selections without writes',async()=>{
 const f=mergeFixture();await assert.rejects(f.service.mergeAnnotations([3,5],{isCurrent:()=>false}),/changed|active/);f.second.annotationIsExternal=true;await assert.rejects(f.service.mergeAnnotations([3,5]),/external/i);f.second.annotationIsExternal=false;
 f.second.annotationColor='#ff0000';await assert.rejects(f.service.mergeAnnotations([3,5]),/color/);f.second.annotationColor='#ffff00';f.second.annotationPosition=JSON.stringify({pageIndex:4,rects:[[1,1,20,20]]});await assert.rejects(f.service.mergeAnnotations([3,5]),/adjacent/);assert.equal(f.second.deleted,undefined);assert.equal(f.annotation.annotationText,'First paragraph');
});
test('R15 failure trashing an extra annotation rolls back survivor geometry and recoverable deletion',async()=>{
 const f=mergeFixture(),oldPosition=f.annotation.annotationPosition;f.second.fail=true;await assert.rejects(f.service.mergeAnnotations([3,5]),/write failed/);assert.equal(f.annotation.annotationPosition,oldPosition);assert.equal(f.annotation.annotationText,'First paragraph');assert.deepEqual(f.annotation.tags,[{tag:'one',type:1}]);assert.equal(f.second.deleted,undefined);
});
test('R15 combines existing next-page rectangles and refuses three-page or malformed geometry',async()=>{
 const f=mergeFixture();f.annotation.annotationPosition=JSON.stringify({pageIndex:2,rects:[[0,0,10,10]],nextPageRects:[[2,2,5,5]]});await f.service.mergeAnnotations([3,5]);assert.deepEqual(JSON.parse(f.annotation.annotationPosition).nextPageRects,[[2,2,5,5],[1,1,20,20]]);
 const other=mergeFixture();other.second.annotationPosition=JSON.stringify({pageIndex:3,rects:[[1,1,20,20]],nextPageRects:[[2,2,30,30]]});await assert.rejects(other.service.mergeAnnotations([3,5]),/adjacent/);other.second.annotationPosition=JSON.stringify({pageIndex:2,rects:[[9,9,1,1]]});await assert.rejects(other.service.mergeAnnotations([3,5]),/geometry/);assert.equal(other.second.deleted,undefined);
});
test('R15 rollback preserves edits made to the survivor while an extra save fails',async()=>{
 const f=mergeFixture();f.second.save=async()=>{f.annotation.annotationComment='Concurrent user comment';f.annotation.setTags([...f.annotation.getTags(),{tag:'user tag',type:0}]);throw Error('merge failed');};
 await assert.rejects(f.service.mergeAnnotations([3,5]),/merge failed/);assert.equal(f.annotation.annotationText,'First paragraph');assert.equal(f.annotation.annotationComment,'Concurrent user comment');assert.deepEqual(f.annotation.tags,[{tag:'one',type:1},{tag:'user tag',type:0}]);assert.equal(f.second.deleted,undefined);
});
test('R15 reader change after survivor save rolls back before deleting the other annotation',async()=>{
 const f=mergeFixture();let active=true;f.annotation.save=async()=>{active=false;};await assert.rejects(f.service.mergeAnnotations([3,5],{isCurrent:()=>active}),/changed/);assert.equal(f.annotation.annotationText,'First paragraph');assert.equal(f.second.deleted,undefined);
});

test('the snapshot carries the ISSN so a journal number can be searched for',async()=>{
 const f=fixture();f.parent.fields.ISSN='2041-1723';
 const rows=await f.service.snapshot(1);
 assert.equal(rows[0].issn,'2041-1723');
 const bare=f.add('journalArticle',8);
 const all=await f.service.snapshot(1);
 assert.equal(all.find(r=>r.id===String(bare.id)).issn,'','an item with no ISSN gets an empty string, never undefined');
});
