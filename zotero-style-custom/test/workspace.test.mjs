import test from 'node:test';import assert from 'node:assert/strict';import W from '../src/workspace.js';
test('nested tag and type search preserve scientific phrases and empty filters',()=>{const items=[{id:'1',title:'Base editing without Cas9',authors:'Liu',tags:['genetics/editing'],itemType:'journalArticle',year:2025},{id:'2',title:'Base editing with Cas9',tags:['genetics'],itemType:'preprint',year:2024}];assert.deepEqual(W.filter(items,{query:'"base editing" without',tag:'genetics',type:'journalArticle'}).map(i=>i.id),['1']);assert.equal(W.filter(items,{}).length,2);assert.equal(W.filter(items,{yearFrom:2025}).length,1);});
test('matrix transposes comparable values and CSV does not execute metadata formulas',()=>{const rows=W.matrix([{title:'=DANGEROUS()',year:2025},{title:'A, "B"',year:2024}],['title','year']);assert.deepEqual(W.matrix([{title:'A',year:2025}],['title','year'],true),[['title','A'],['year',2025]]);const csv=W.csv(rows);assert.match(csv,/"'=DANGEROUS\(\)"/);assert.match(csv,/"A, ""B"""/);assert.match(csv,/"2025"/);});
test('graph layout is deterministic, bounded and removes dangling edges',()=>{const graph={nodes:Array.from({length:200},(_,i)=>({id:String(i),label:'Paper '+i})),edges:[{source:'0',target:'1'},{source:'0',target:'missing'}]};const first=W.layout(graph),second=W.layout(graph);assert.deepEqual(first,second);assert.equal(first.nodes.length,180);assert.equal(first.edges.length,1);assert.equal(first.truncated,true);assert.ok(first.nodes.every(n=>n.x>=25&&n.x<=735&&n.y>=25&&n.y<=455));});
test('reading progress never counts invalid or out-of-range pages',()=>{assert.deepEqual(W.progress({pageTimes:{0:10,1:0,2:3,999:50,bad:1},totalPages:3}),{total:3,visited:2,percent:67,pages:{0:10,1:0,2:3,999:50,bad:1}});assert.equal(W.progress({}).percent,null);});
test('canvas supports independent cards, saved positions, notes, unique edges and deletion cleanup',()=>{const cache={};const board=W.createBoard(cache,'Reading map');W.addToBoard(cache,board,[{id:1,title:'First'},{id:2,title:'Second'},{id:1,title:'duplicate'}]);assert.equal(board.nodes.length,2);const note=W.addBoardNote(cache,board,'Question');assert.equal(note.itemID,null);const[a,b]=board.nodes;assert.equal(W.moveCard(board,a.id,-100,150),true);assert.equal(a.x,0);assert.equal(a.y,150);W.linkCards(board,a.id,b.id);W.linkCards(board,b.id,a.id);assert.equal(board.edges.length,1);assert.throws(()=>W.linkCards(board,a.id,a.id));W.removeCard(board,a.id);assert.equal(board.edges.length,0);assert.equal(JSON.parse(JSON.stringify(cache)).boards[0].nodes.length,2);});
test('board deletion is undoable and restores cards and edges exactly',()=>{const cache={};const board=W.createBoard(cache,'Map');W.addToBoard(cache,board,[{id:'1',title:'Paper'}]);const original=JSON.stringify(board);assert.equal(W.deleteBoard(cache,board.id).id,board.id);assert.equal(cache.boards.length,0);assert.equal(JSON.stringify(W.restoreBoard(cache)),original);assert.equal(cache.boards.length,1);assert.equal(W.restoreBoard(cache),null);});

test('combined status year and rating filters sort known zero citations before unknown values without mutating input',()=>{
 const rows=[{id:'a',title:'Unknown',year:'',status:'done',rating:5,citations:null},{id:'b',title:'Zero',year:2025,status:'done',rating:4,citations:0},{id:'c',title:'Cited',year:2024,status:'reading',rating:5,citations:12}];
 assert.deepEqual(W.filter(rows,{status:'done',ratingMin:4,yearFrom:2024,yearTo:2026}).map(r=>r.id),['b']);
 assert.deepEqual(W.sortItems(rows,'citations-desc').map(r=>r.id),['c','b','a']);assert.deepEqual(rows.map(r=>r.id),['a','b','c']);
});

test('canvas can rename boards edit card appearance and unlink without removing either document',()=>{
 const cache={},board=W.createBoard(cache,'Old');W.addToBoard(cache,board,[{id:1,title:'A'},{id:2,title:'B'}]);const[a,b]=board.nodes;W.linkCards(board,a.id,b.id);
 W.renameBoard(board,' New ');assert.equal(board.name,'New');W.updateCard(board,a.id,{label:'Edited',color:'#AAbBcc'});assert.equal(a.color,'#aabbcc');assert.equal(a.label,'Edited');
 assert.throws(()=>W.updateCard(board,a.id,{label:'Must not apply',color:'url(bad)'}));assert.equal(a.label,'Edited');
 assert.equal(W.unlinkCards(board,b.id,a.id),1);assert.equal(board.nodes.length,2);assert.equal(board.nodes[0].itemID,'1');assert.equal(board.edges.length,0);
});

test('a search folds accents, fullwidth letters and every kind of dash',()=>{
 const items=[
  {id:'a',title:'Kinetics of translation',authors:'Hans Müller',tags:[]},
  {id:'b',title:'protein–protein interaction',authors:'Jae Yoon Sung',tags:[]},
  {id:'c',title:'Ｃａｓ９ delivery',authors:'Zhang',tags:[]}];
 assert.deepEqual(W.filter(items,{query:'Muller'}).map(i=>i.id),['a'],'an unaccented query finds the accented author');
 assert.deepEqual(W.filter(items,{query:'Müller'}).map(i=>i.id),['a'],'and the accented query still works');
 assert.deepEqual(W.filter(items,{query:'protein-protein'}).map(i=>i.id),['b'],'a hyphen finds an en dash');
 assert.deepEqual(W.filter(items,{query:'protein—protein'}).map(i=>i.id),['b'],'and an em dash finds it too');
 assert.deepEqual(W.filter(items,{query:'cas9'}).map(i=>i.id),['c'],'fullwidth letters fold to their plain form');
});

test('Korean survives the fold and is still searchable syllable by syllable',()=>{
 const items=[{id:'k',title:'단백질 접힘 연구',authors:'성재윤',tags:['효소']}];
 assert.equal(W.norm('단백질'),'단백질','the syllables come back composed');
 assert.deepEqual(W.filter(items,{query:'접힘'}).map(i=>i.id),['k']);
 assert.deepEqual(W.filter(items,{query:'효소'}).map(i=>i.id),['k']);
});

test('a typed year, item type or ISSN finds the paper',()=>{
 const items=[
  {id:'1',title:'Old work',year:1998,itemType:'journalArticle',issn:'2041-1723',tags:[]},
  {id:'2',title:'New work',year:2025,itemType:'patent',issn:'',tags:[]}];
 assert.deepEqual(W.filter(items,{query:'1998'}).map(i=>i.id),['1']);
 assert.deepEqual(W.filter(items,{query:'patent'}).map(i=>i.id),['2']);
 assert.deepEqual(W.filter(items,{query:'2041-1723'}).map(i=>i.id),['1']);
});

test('an initial matches a given name rather than any letter in the record',()=>{
 const items=[
  {id:'1',title:'Folding',authors:'Jae Yoon Sung',tags:[]},
  {id:'2',title:'Junk',authors:'Amy Sung',tags:[]}];
 assert.deepEqual(W.filter(items,{query:'J. Y. Sung'}).map(i=>i.id),['1']);
 assert.deepEqual(W.filter(items,{query:'A Sung'}).map(i=>i.id),['2']);
 assert.deepEqual(W.filter(items,{query:'z Sung'}).map(i=>i.id),[],'a letter no word starts with matches nothing');
});

test('the shared text matcher takes every token, in any order',()=>{
 assert.equal(W.matches('Reading notes on Müller 2019','muller notes'),true);
 assert.equal(W.matches('Reading notes on Müller 2019','muller absent'),false);
 assert.equal(W.matches('anything at all',''),true,'an empty query matches everything');
 assert.equal(W.matches('protein–protein','protein-protein'),true);
});

test('a typed title is ranked ahead of the papers that merely contain it',()=>{
 const items=[
  {id:'1',title:'Notes on base editing in plants'},
  {id:'2',title:'Base editing'},
  {id:'3',title:'Base editing in mice'},
  {id:'4',title:'Unrelated'}];
 assert.deepEqual(W.rankByQuery(items,'Base editing').map(i=>i.id),['2','3','1','4']);
 assert.deepEqual(W.rankByQuery(items,'').map(i=>i.id),['1','2','3','4'],'with no query the library order stands');
});
