import test from 'node:test';
import assert from 'node:assert/strict';
import M from '../src/workspace.js';

const P=(id,extra={})=>({id:String(id),title:'Paper '+id,authors:'',year:'2020',venue:'',itemType:'journalArticle',tags:[],status:'unread',rating:0,citations:null,impactFactor:null,abstract:'',...extra});
const items=[
 P(1,{title:'Deep learning for cell maps',authors:'Kim J; Lee S',year:'2022',venue:'Nature',tags:['ml/dl','cells'],status:'done',rating:5,citations:120,impactFactor:48.5,pdfCount:1,noteCount:2,annotations:3,collectionIDs:['c1'],collectionNames:['Cells'],noteTitles:['method'],abstract:'We train a network.'}),
 P(2,{title:'Protein folding review',authors:'Park H',year:'2015',venue:'Science',tags:['bio','ml'],status:'reading',rating:3,citations:900,impactFactor:44,pdfCount:1,noteCount:0,annotations:0,collectionIDs:['c2'],collectionNames:['Folding'],abstract:'A review.'}),
 P(3,{title:'Spatial transcriptomics preprint',authors:'Lee S',year:'2024',venue:'bioRxiv',itemType:'preprint',tags:['cells'],status:'unread',rating:0,pdfCount:0,noteCount:1,annotations:0,collectionIDs:['c3'],collectionNames:['Sub']}),
 P(4,{title:'Thesis on yeast',authors:'Choi Y',year:'',venue:'',itemType:'thesis',tags:[],status:'reading',remark:'Remember the yeast strain list',collectionIDs:[],collectionNames:[]}),
];
const ids=list=>list.map(i=>i.id).join(',');
const rule=(kind,extra={})=>({id:'r'+kind,kind,mode:'in',...extra});
const ex=(kind,extra={})=>rule(kind,{mode:'ex',...extra});
const run=(rules,context)=>ids(M.filter(items,{rules,context}));
const collections=[{id:'c1',name:'Cells',parentID:null},{id:'c3',name:'Sub',parentID:'c1'},{id:'c2',name:'Folding',parentID:null}];
const context=M.collectionContext(collections);

test('plain text still behaves as before, and rules are optional', () => {
 assert.equal(ids(M.filter(items,{query:'protein folding'})),'2');
 assert.equal(ids(M.filter(items,{})),'1,2,3,4');
 assert.equal(ids(M.filter(items,{rules:[]})),'1,2,3,4');
 assert.equal(ids(M.filter(items,{query:'  '})),'1,2,3,4');
});

test('search syntax: negation, phrases, fields, Korean field names', () => {
 assert.deepEqual(M.parseQuery('-word "a phrase" title:x -author:kim').map(t=>[t.neg,t.field,t.value,t.phrase]),
  [[true,'','word',false],[false,'','a phrase',true],[false,'title','x',false],[true,'author','kim',false]]);
 assert.equal(ids(M.filter(items,{query:'-protein'})),'1,3,4');
 assert.equal(ids(M.filter(items,{query:'"deep learning"'})),'1');
 assert.equal(ids(M.filter(items,{query:'"learning deep"'})),'');
 assert.equal(ids(M.filter(items,{query:'-"deep learning"'})),'2,3,4');
 assert.equal(ids(M.filter(items,{query:'title:protein'})),'2');
 assert.equal(ids(M.filter(items,{query:'-title:protein'})),'1,3,4');
 assert.equal(ids(M.filter(items,{query:'author:lee'})),'1,3');
 assert.equal(ids(M.filter(items,{query:'author:lee -title:spatial'})),'1');
 assert.equal(ids(M.filter(items,{query:'저자:lee'})),'1,3');
 assert.equal(ids(M.filter(items,{query:'tag:cells'})),'1,3');
 assert.equal(ids(M.filter(items,{query:'tag:"ml/dl"'})),'1');
 assert.equal(ids(M.filter(items,{query:'journal:nature'})),'1');
 assert.equal(ids(M.filter(items,{query:'저널:science'})),'2');
 assert.equal(ids(M.filter(items,{query:'year:2022'})),'1');
 assert.equal(ids(M.filter(items,{query:'year:2015-2022'})),'1,2');
 assert.equal(ids(M.filter(items,{query:'year:>=2024'})),'3');
 assert.equal(ids(M.filter(items,{query:'-year:2015-2022'})),'3,4','a paper with no year is not inside a range, so it stays');
 assert.equal(ids(M.filter(items,{query:'collection:folding'})),'2');
 assert.equal(ids(M.filter(items,{query:'컬렉션:cells'})),'1');
 assert.equal(ids(M.filter(items,{query:'note:yeast'})),'4','the memo is a note field');
 assert.equal(ids(M.filter(items,{query:'abstract:network'})),'1');
 assert.equal(ids(M.filter(items,{query:'초록:review'})),'2');
});

test('an unknown field name, a URL and a lone dash are plain text, not syntax', () => {
 const terms=M.parseQuery('http://x.org foo:bar - 10.1234/a');
 assert.deepEqual(terms.map(t=>[t.neg,t.field,t.value]),[[false,'','http://x.org'],[false,'','foo:bar'],[false,'','-'],[false,'','10.1234/a']]);
 assert.equal(M.plainQuery('-skip title:x keep "two words"'),'keep two words');
 assert.equal(ids(M.rankByQuery(items,'-protein')),'1,2,3,4','only negations: nothing to rank by');
 assert.equal(M.parseQuery('title:').length,1,'an empty field value is just text');
});

test('word rule: field, phrase and any-word modes, include and exclude', () => {
 assert.equal(run([rule('word',{text:'deep learning',field:'all'})]),'1');
 assert.equal(run([rule('word',{text:'learning deep',field:'all'})]),'');
 assert.equal(run([rule('word',{text:'learning deep',field:'all',phrase:false})]),'1');
 assert.equal(run([rule('word',{text:'lee',field:'author'})]),'1,3');
 assert.equal(run([ex('word',{text:'lee',field:'author'})]),'2,4');
 assert.equal(run([rule('word',{text:'review',field:'title'})]),'2');
 assert.equal(run([rule('word',{text:'review',field:'abstract'})]),'2');
 assert.equal(run([rule('word',{text:'ml',field:'tag'})]),'1,2');
 assert.equal(run([rule('word',{text:'yeast',field:'note'})]),'4');
 assert.equal(run([rule('word',{text:'method',field:'note'})]),'1','a note title counts');
 assert.equal(run([rule('word',{text:'   ',field:'all'})]),'1,2,3,4','an empty rule is not active and filters nothing');
});

test('type rule is any-of; exclude removes', () => {
 assert.equal(run([rule('type',{values:['preprint','thesis']})]),'3,4');
 assert.equal(run([ex('type',{values:['preprint','thesis']})]),'1,2');
 assert.equal(run([ex('type',{values:[]})]),'1,2,3,4');
});

test('tag rule: any / all, parent includes children, exclude', () => {
 assert.equal(run([rule('tag',{values:['ml','cells']})]),'1,2,3');
 assert.equal(run([rule('tag',{values:['ml','cells'],all:true})]),'1');
 assert.equal(run([rule('tag',{values:['ml'],children:true})]),'1,2','ml/dl counts as ml');
 assert.equal(run([rule('tag',{values:['ml'],children:false})]),'2');
 assert.equal(run([ex('tag',{values:['cells']})]),'2,4');
 assert.equal(run([ex('tag',{values:['ml','cells'],all:true})]),'2,3,4','exclude only the papers that have both');
 assert.equal(run([ex('tag',{values:['ml'],children:true})]),'3,4');
});

test('status rule is any-of', () => {
 assert.equal(run([rule('status',{values:['done','unread']})]),'1,3');
 assert.equal(run([ex('status',{values:['reading']})]),'1,3');
});

test('range rules: rating, year, IF, citations; open ends; unknown values', () => {
 assert.equal(run([rule('rating',{min:3})]),'1,2');
 assert.equal(run([rule('rating',{min:0,max:0})]),'3,4','unrated counts as 0');
 assert.equal(run([ex('rating',{min:3})]),'3,4');
 assert.equal(run([rule('year',{min:2020,max:2023})]),'1');
 assert.equal(run([rule('year',{max:2020})]),'2');
 assert.equal(run([ex('year',{min:2020})]),'2,4','no year is not 2020 or later, so exclusion keeps it');
 assert.equal(run([rule('year',{min:'',max:''})]),'1,2,3,4','a range with no bound is inactive');
 assert.equal(run([rule('impact',{min:45})]),'1');
 assert.equal(run([ex('impact',{min:45})]),'2,3,4');
 assert.equal(run([rule('citations',{min:100,max:500})]),'1');
 assert.equal(run([rule('citations',{min:100})]),'1,2');
 assert.equal(run([ex('citations',{min:100})]),'3,4');
});

test('collection rule: any-of, with or without subcollections', () => {
 assert.equal(run([rule('collection',{values:['c1'],sub:false})],context),'1');
 assert.equal(run([rule('collection',{values:['c1'],sub:true})],context),'1,3');
 assert.equal(run([rule('collection',{values:['c1','c2'],sub:true})],context),'1,2,3');
 assert.equal(run([ex('collection',{values:['c1'],sub:true})],context),'2,4');
 assert.equal(run([rule('collection',{values:['c1']})],{}),'1','without a collection tree it is the collection itself');
});

test('journal rule: exact venue, case-insensitive, any-of', () => {
 assert.equal(run([rule('journal',{values:['nature','Science']})]),'1,2');
 assert.equal(run([ex('journal',{values:['Nature']})]),'2,3,4');
 assert.equal(run([rule('journal',{values:['']})]),'1,2,3,4','blank values are dropped by cleaning, and an empty list is inactive');
});

test('has / lacks rules: PDF, annotations, notes, preprint or published', () => {
 assert.equal(run([rule('pdf')]),'1,2');
 assert.equal(run([ex('pdf')]),'3,4');
 assert.equal(run([rule('annotation')]),'1');
 assert.equal(run([ex('annotation')]),'2,3,4');
 assert.equal(run([rule('note')]),'1,3');
 assert.equal(run([ex('note')]),'2,4');
 assert.equal(run([rule('preprint',{value:'preprint'})]),'3');
 assert.equal(run([rule('preprint',{value:'published'})]),'1,2,4');
 assert.equal(run([ex('preprint',{value:'preprint'})]),'1,2,4');
});

test('rules AND together, and rules combine with the box and the old fields', () => {
 assert.equal(run([rule('tag',{values:['cells']}),ex('status',{values:['unread']})]),'1');
 assert.equal(run([rule('year',{min:2015}),ex('type',{values:['preprint']}),ex('tag',{values:['bio']})]),'1');
 assert.equal(ids(M.filter(items,{query:'-protein',type:'journalArticle',rules:[rule('tag',{values:['cells']})]})),'1');
 assert.equal(ids(M.filter(items,{status:'reading',rules:[ex('type',{values:['thesis']})]})),'2');
});

test('applyRules can skip the rule being edited', () => {
 const rules=[rule('tag',{values:['cells']}),ex('status',{values:['unread']})];
 assert.equal(ids(M.applyRules(items,rules)),'1');
 assert.equal(ids(M.applyRules(items,rules,{},'rtag')),'1,2,4');
});

test('option counts follow the other rules and count a parent tag for its children', () => {
 const counts=M.countOptions(items,'tag',{});
 assert.equal(counts.get('ml'),2);assert.equal(counts.get('ml/dl'),1);assert.equal(counts.get('cells'),2);
 assert.equal(M.countOptions(items,'tag',{children:false}).get('ml'),1);
 const typed=M.countOptions(items,'type',{rules:[ex('status',{values:['unread']})]});
 assert.equal(typed.get('journalArticle'),2);assert.equal(typed.get('preprint'),undefined);assert.equal(typed.get('thesis'),1);
 const own=[rule('type',{id:'mine',values:['thesis']})];own[0].id='mine';
 assert.equal(M.countOptions(items,'type',{rules:own}).get('journalArticle'),undefined);
 assert.equal(M.countOptions(items,'type',{rules:own,skipID:'mine'}).get('journalArticle'),2,'the rule being edited is not counted against itself');
 assert.equal(M.countOptions(items,'status',{}).get('reading'),2);
 assert.equal(M.countOptions(items,'journal',{}).get('Nature'),1);
 assert.equal(M.countOptions(items,'journal',{}).get(''),undefined,'a paper with no journal is not a journal');
 const cols=M.countOptions(items,'collection',{ctx:context});
 assert.equal(cols.get('c1'),2,'a parent collection counts its subcollection');
 assert.equal(M.countOptions(items,'collection',{ctx:context,children:false}).get('c1'),1);
});

test('collection context knows descendants, ancestors and names, and survives a cycle', () => {
 assert.deepEqual([...context.descendants.get('c1')].sort(),['c1','c3']);
 assert.deepEqual(context.ancestors.get('c3'),['c1']);
 assert.equal(context.names.get('c2'),'Folding');
 const loop=M.collectionContext([{id:'a',name:'A',parentID:'b'},{id:'b',name:'B',parentID:'a'}]);
 assert.ok(loop.ancestors.get('a').length<=50,'a cycle cannot hang the panel');
});

test('saved rules are cleaned: unknown kinds, wrong types and runaway lists are dropped', () => {
 const clean=M.cleanRules([
  {id:'a',kind:'tag',mode:'ex',values:['x',' ',7],all:1},
  {id:'a',kind:'tag',values:['y']},
  {id:'b',kind:'nope',values:['x']},
  {id:'c',kind:'year',min:'2020',max:'abc'},
  {id:'d',kind:'word',text:'',field:'title'},
  {id:'e',kind:'word',text:'hi',field:'weird'},
  {id:'f',kind:'preprint',value:'other'},
  {id:'g',kind:'pdf',mode:'other'},
  null,'x',
 ]);
 assert.deepEqual(clean.map(r=>r.kind),['tag','tag','year','word','preprint','pdf']);
 assert.equal(new Set(clean.map(r=>r.id)).size,clean.length,'ids stay unique');
 assert.deepEqual(clean[0].values,['x','7']);assert.equal(clean[0].mode,'ex');assert.equal(clean[0].all,true);
 assert.equal(clean[2].min,2020);assert.equal(clean[2].max,'');
 assert.equal(clean[3].field,'all');assert.equal(clean[3].phrase,true);
 assert.equal(clean[4].value,'preprint');assert.equal(clean[5].mode,'in');
 assert.equal(M.cleanRules('not a list').length,0);
 assert.equal(M.cleanRules(Array.from({length:100},(_,i)=>({kind:'pdf',id:'p'+i}))).length,40);
 assert.deepEqual(M.cleanRulesByTab({explore:[{kind:'pdf'}],notes:[],junk:[{kind:'zzz'}]}),{explore:[{id:'r1',kind:'pdf',mode:'in'}]});
 assert.deepEqual(M.cleanRulesByTab(null),{});assert.deepEqual(M.cleanRulesByTab([1]),{});
});

test('chip words: include is plain, a long list is shortened, ranges and has-rules read naturally', () => {
 const d=r=>M.describeRule(r,{collectionName:id=>({c1:'Cells'})[id]||id});
 assert.equal(d(rule('tag',{values:['a','b','c','d']})),'태그: a, b 외 2');
 assert.equal(d(rule('tag',{values:['a','b'],all:true})),'태그 (모두): a, b');
 assert.equal(d(rule('year',{min:2018,max:2022})),'연도: 2018–2022');
 assert.equal(d(rule('year',{min:2018,max:''})),'연도: 2018 이상');
 assert.equal(d(rule('rating',{min:'',max:2})),'별점: 2점 이하');
 assert.equal(d(rule('word',{text:'x',field:'title',phrase:true})),'제목: “x”');
 assert.equal(d(rule('collection',{values:['c1'],sub:true})),'컬렉션: Cells +하위');
 assert.equal(d(rule('pdf')),'첨부 PDF 있음');
 assert.equal(d(rule('preprint',{value:'published'})),'출판본');
 assert.equal(d(rule('status',{values:['reading']})),'읽기 상태: 읽는 중');
});

test('a large library stays fast: 1,200 papers, eight rules, counted twice', () => {
 const many=Array.from({length:1200},(_,i)=>P(i,{title:'Paper '+i+' on topic '+i%17,authors:'Author '+i%40,year:String(2000+i%25),venue:'J'+i%60,tags:['t'+i%30,'t'+i%30+'/sub'],status:['unread','reading','done'][i%3],rating:i%6,citations:i,impactFactor:i%50,pdfCount:i%2,noteCount:i%3,annotations:i%4,collectionIDs:['c'+i%9],collectionNames:['C'+i%9]}));
 const rules=[rule('tag',{values:['t1','t2'],children:true}),ex('status',{values:['done']}),rule('year',{min:2005}),ex('word',{text:'topic 3',field:'title'}),rule('pdf'),ex('note'),rule('rating',{min:1}),ex('journal',{values:['J7']})];
 const start=Date.now();
 const found=M.filter(many,{query:'-zzz title:paper',rules});
 for(const kind of ['tag','journal','status','type','collection'])M.countOptions(many,kind,{rules,ctx:{}});
 assert.ok(found.length>=0&&found.length<1200);
 assert.ok(Date.now()-start<400,'took '+(Date.now()-start)+'ms');
});

test('syntaxQuery keeps only the negations and field terms, for code that widens the plain words itself', () => {
 assert.equal(M.syntaxQuery('-a title:b c "d e" -"f g" 제목:h'),'-a title:b -"f g" title:h');
 assert.equal(M.syntaxQuery('just words'),'');
 assert.equal(ids(M.filter(items,{query:M.syntaxQuery('learning -protein year:2022')})),'1');
});

const J=(venue,extra={})=>({venue,...extra});
const journals=[J('Nature Methods',{venueAbbrs:['Nat Methods']}),J('Proceedings of the National Academy of Sciences of the United States of America',{venueAbbrs:['PNAS','Proc Natl Acad Sci U S A']}),J('Nucleic Acids Research'),J('Journal of the American Chemical Society',{journalAbbr:'J. Am. Chem. Soc.'}),J('Nature'),J('Nature Communications',{venueAbbrs:['Nat Commun']}),J('Science'),J('')];
const best=q=>M.journalChoices(journals,q).map(c=>c.venue.split(' ').slice(0,2).join(' ')+':'+c.score);

test('journals are found by full name, ISO 4 abbreviation and acronym, ignoring case and punctuation', () => {
 assert.deepEqual(best('Nat Methods'),['Nature Methods:0']);
 assert.deepEqual(best('nat. methods'),['Nature Methods:0']);
 assert.deepEqual(best('Proc. Natl. Acad. Sci'),['Proceedings of:1']);
 assert.deepEqual(best('PNAS'),['Proceedings of:0']);
 assert.deepEqual(best('pnas'),['Proceedings of:0']);
 assert.deepEqual(best('NAR'),['Nucleic Acids:0'],'the acronym of Nucleic Acids Research');
 assert.deepEqual(best('JACS'),['Journal of:0'],'the acronym, with "of the" left out');
 assert.deepEqual(best('J Am Chem Soc'),['Journal of:0'],'an abbreviation the library holds on the item');
 assert.deepEqual(best('nat comm'),['Nature Communications:1'],'a prefix of the abbreviation Nat Commun');
 assert.deepEqual(best('natur comm'),['Nature Communications:2'],'each word starts a word of the name');
 assert.deepEqual(best('methods'),['Nature Methods:2'],'contains');
 assert.deepEqual(best('zzz'),[]);
});

test('journal matches rank exact name or abbreviation or acronym, then prefix, then contains', () => {
 const ranked=M.journalChoices(journals,'nature');
 assert.deepEqual(ranked.map(c=>[c.venue,c.score]),[['Nature',0],['Nature Communications',1],['Nature Methods',1]]);
 assert.equal(M.journalChoices(journals,'').length,7,'a paper with no journal is not listed');
 assert.equal(M.journalChoices(journals,'nat methods')[0].abbreviation,'Nat Methods');
 const counted=M.journalChoices([J('Cell'),J('Cell'),J('Cellulose')],'cell');
 assert.deepEqual(counted.map(c=>[c.venue,c.score,c.count]),[['Cell',0,2],['Cellulose',1,1]]);
});

test('journal: in the search box uses the same matching', () => {
 const items=journals.map((j,i)=>P(i,j));
 assert.equal(ids(M.filter(items,{query:'journal:pnas'})),'1');
 assert.equal(ids(M.filter(items,{query:'저널:"nat methods"'})),'0');
 assert.equal(ids(M.filter(items,{query:'-저널:nat'})),'2,3,6,7');
 assert.equal(ids(M.filter(items,{query:'journal:jacs'})),'3');
});

test('saved single-value filters turn into include rules', () => {
 const rules=M.legacyRules({type:'preprint',status:'done',ratingMin:'3',yearFrom:'2020',yearTo:'',tag:'a'});
 assert.deepEqual(rules.map(r=>[r.id,r.kind,r.mode]),[['legacy-type','type','in'],['legacy-status','status','in'],['legacy-tag','tag','in'],['legacy-rating','rating','in'],['legacy-year','year','in']]);
 assert.equal(rules[3].min,3);assert.equal(rules[4].min,2020);assert.equal(rules[4].max,'');
 assert.equal(run(rules.slice(0,2)),'');
 assert.deepEqual(M.legacyRules({type:'',status:'',ratingMin:'',yearFrom:'',yearTo:''}),[]);
 assert.deepEqual(M.legacyRules(null),[]);
});
