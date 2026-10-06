/* The annotation basket's pure side: what it holds per library, in the
   reader's order, and the Markdown it copies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const M=require('../src/workspace.js');

const mark=(id,paper,over={})=>({id,key:'K'+id,parentID:paper,attachmentID:'A'+paper,text:'Text '+id,comment:'',color:'#ffd400',type:'highlight',pageLabel:String(id),pageIndex:Number(id)-1,...over});
const paper={id:'1',title:'Paper Alpha',authors:'Ada Lovelace; Charles Babbage',year:'2025',venue:'Science',doi:'10.1234/a'};

test('the basket is kept per library, in the order things were added, once each',()=>{
 const cache={};
 assert.deepEqual(M.basketItems(cache,1),[]);
 M.basketAdd(cache,1,[mark('3','1',{paper}),mark('4','1'),mark('3','1')]);
 M.basketAdd(cache,2,[mark('8','5')]);
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['3','4']);
 assert.deepEqual(M.basketItems(cache,2).map(e=>e.id),['8'],'another library has its own basket');
 const entry=M.basketItems(cache,1)[0];
 assert.deepEqual([entry.paper,entry.attachment,entry.page,entry.color,entry.paperTitle,entry.year],['1','A1','3','#ffd400','Paper Alpha','2025'],'enough is kept to show and cite it outside the current scope');
});

test('the basket moves, removes and clears, and a clear can be put back',()=>{
 const cache={};
 M.basketAdd(cache,1,['1','2','3','4'].map(id=>mark(id,'1')));
 M.basketMove(cache,1,'4',0);
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['4','1','2','3']);
 M.basketMove(cache,1,'4',+1,{relative:true});
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['1','4','2','3']);
 M.basketMove(cache,1,'1',-1,{relative:true});
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['1','4','2','3'],'the first cannot go higher');
 M.basketRemove(cache,1,['2']);
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['1','4','3']);
 const removed=M.basketClear(cache,1);
 assert.deepEqual(M.basketItems(cache,1),[]);
 M.basketRestore(cache,1,removed);
 assert.deepEqual(M.basketItems(cache,1).map(e=>e.id),['1','4','3'],'undo puts back what was there, in its order');
});

test('a basket holds at most 500 annotations; long text is kept short',()=>{
 const cache={};
 M.basketAdd(cache,1,Array.from({length:520},(_,i)=>mark(String(i+1),'1',{text:'x'.repeat(5000)})));
 assert.equal(M.basketItems(cache,1).length,500);
 assert.ok(M.basketItems(cache,1)[0].text.length<=1200);
});

test('runs of the same paper, in basket order, for a synthesis note',()=>{
 const list=[mark('1','P'),mark('2','P'),mark('3','Q'),mark('4','P')].map(M.basketEntry);
 assert.deepEqual(M.basketRuns(list).map(r=>[r.paper,r.ids]),[['P',['1','2']],['Q',['3']],['P',['4']]]);
 assert.equal(M.basketSignature(list),'1,2,3,4');
});

test('Markdown: each quote with its memo, a citation with the page, a link back, and the references',()=>{
 const list=[mark('3','1',{paper,comment:'Key result',text:'Cas9 cuts here'}),mark('4','1',{paper,pageLabel:'7',text:'Second'})].map(M.basketEntry);
 const md=M.basketMarkdown(list,{title:'Basket',attachmentKey:id=>id==='A1'?'ATT1':'',route:'library'});
 assert.match(md,/^# Basket/);
 assert.match(md,/> Cas9 cuts here/);
 assert.match(md,/Key result/);
 assert.match(md,/\(Lovelace et al\. 2025, p\. 3\)/);
 assert.match(md,/zotero:\/\/open-pdf\/library\/items\/ATT1\?page=3&annotation=K3/);
 assert.match(md,/## References[\s\S]*Lovelace, A\.?.*\(2025\)\. Paper Alpha\. \*Science\*\. https:\/\/doi\.org\/10\.1234\/a/);
 assert.equal((md.match(/Paper Alpha\. \*Science\*/g)||[]).length,1,'one reference per paper');
 // A quote over several lines stays one quote.
 const multi=M.basketMarkdown([M.basketEntry(mark('5','1',{paper,text:'line one\nline two'}))],{title:'B'});
 assert.match(multi,/> line one\n> line two/);
});
