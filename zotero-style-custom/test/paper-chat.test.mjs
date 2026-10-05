import test from 'node:test';
import assert from 'node:assert/strict';
import PC from '../src/paper-chat.js';

const sent=(text,page)=>({text,page,rects:[[0,0,1,1]]});
const para=(page,...texts)=>({sentences:texts.map(t=>sent(t,page))});
const paper=()=>({
 title:'Thermostable polymerase evolution',
 abstract:'We evolved a polymerase that tolerates 95 C. Activity rose four fold.',
 sections:[
  {heading:'Introduction',level:1,page:1,paragraphs:[para(1,'DNA polymerases drive PCR.','Thermal stability limits cycling speed.'),para(1,'Prior work used directed evolution of Taq.')]},
  {heading:'Methods',level:1,page:3,paragraphs:[para(3,'Libraries were built by error-prone PCR and screened by compartmentalised self-replication.'),para(3,'Kinetics were measured at 72 C with fluorescent substrates.')]},
  {heading:'Results',level:1,page:4,paragraphs:[para(4,'Variant M7 retained 80 percent activity after 30 minutes at 95 C.'),para(5,'Fidelity fell slightly, with an error rate of 2.1e-5.')]},
  {heading:'Discussion',level:1,page:6,paragraphs:[para(6,'The gain comes from a rigid thumb domain.'),para(6,'A limit is that only one template was tested.'),para(6,'Future work should test long amplicons.'),para(7,'Fourth paragraph that is not taken.')]},
  {heading:'Acknowledgements',level:1,page:8,paragraphs:[para(8,'We thank the lab.')]},
  {heading:'References',level:1,page:8,paragraphs:[para(8,'1. Smith 2020.')]}],
 captions:[{text:'Figure 2. Residual activity after heat challenge.',page:4,rects:[]}],references:[]
});

test('the paper is cut into section-level chunks with their page, plus the abstract and captions',()=>{
 const chunks=PC.buildChunks(paper());
 assert.equal(chunks[0].kind,'abstract');
 assert.ok(chunks.some(c=>c.section==='Methods'&&c.page===3));
 assert.ok(chunks.some(c=>c.kind==='caption'&&c.page===4));
 assert.ok(chunks.every(c=>c.text.length<=2000&&c.tf instanceof Map));
});

test('a very long paragraph is split near the chunk size, at sentence ends',()=>{
 const long={title:'T',abstract:'',sections:[{heading:'Results',page:2,paragraphs:[para(2,...Array.from({length:40},(_,i)=>`Sentence number ${i} says something about growth rates.`))]}]};
 const chunks=PC.buildChunks(long);
 assert.ok(chunks.length>=3);assert.ok(chunks.every(c=>c.text.length<=1400));assert.ok(chunks.every(c=>/\.$/.test(c.text)));
});

test('tokens are lowercase, stemmed, without stop words; Korean uses character pairs',()=>{
 assert.deepEqual(PC.tokenize('The Libraries were screened'),['library','screen']);
 assert.ok(PC.tokenize('screened screening').every(t=>t==='screen'));
 assert.ok(!PC.tokenize('the and of').length);
 assert.deepEqual(PC.tokenize('열안정성 효소'),['열안','안정','정성','효소']);
});

test('a question about the method ranks the methods chunk first, and the abstract is always included',()=>{
 const chunks=PC.buildChunks(paper());
 const top=PC.rank(chunks,'how were the libraries screened?',{k:3});
 assert.ok(top.some(c=>c.kind==='abstract'));
 const methods=top.find(c=>c.section==='Methods');assert.ok(methods,'the methods chunk is picked');
 const ranked=PC.rank(chunks,'error rate fidelity',{k:2,});
 assert.ok(ranked.some(c=>/Fidelity/.test(c.text)));
});

test('the section the reader is looking at is always in, even when the question does not mention it',()=>{
 const p=paper(),chunks=PC.buildChunks(p);
 const at=PC.sectionAtPage(p,6);assert.equal(p.sections[at].heading,'Discussion');
 const top=PC.rank(chunks,'what is the error rate',{k:3,page:6,sectionIndex:at});
 assert.ok(top.some(c=>c.section==='Discussion'));
 assert.ok(top.some(c=>/error rate/.test(c.text)));
 assert.equal(PC.sectionAtPage(p,1),0);
});

test('"this figure" pulls the chunks of the current page in',()=>{
 const chunks=PC.buildChunks(paper());
 const top=PC.rank(chunks,'explain this figure',{k:4,page:4,forcePage:true});
 assert.ok(top.some(c=>c.kind==='caption'||c.page===4));
});

test('ranking returns document order and never more than k plus the pinned ones',()=>{
 const chunks=PC.buildChunks(paper());
 const top=PC.rank(chunks,'polymerase activity heat',{k:4,page:4,sectionIndex:2});
 assert.deepEqual(top.map(c=>c.id),[...top.map(c=>c.id)].sort((a,b)=>a-b));
 assert.ok(top.length<=5);
});

test('the summary input holds the abstract, every section heading and the first paragraph of each section',()=>{
 const input=PC.summaryInput(paper());
 assert.match(input.text,/TITLE: Thermostable/);assert.match(input.text,/ABSTRACT: We evolved/);
 assert.match(input.text,/SECTIONS: Introduction \(p\. 1\) \| Methods \(p\. 3\)/);
 assert.match(input.text,/\[Methods, p\. 3\] Libraries were built/);
 assert.doesNotMatch(input.text,/Kinetics were measured/,'only the first paragraph of a body section');
 assert.match(input.text,/\[Discussion, p\. 6\] The gain comes[\s\S]*Future work should test long amplicons/,'more of the discussion');
 assert.doesNotMatch(input.text,/Fourth paragraph/);
 assert.doesNotMatch(input.text,/We thank the lab|Smith 2020/,'acknowledgements and references are not sent');
 assert.equal(input.truncated,false);
});

test('the summary input stays inside its budget however long the paper is',()=>{
 const big={title:'Big',abstract:'A.'.repeat(300),sections:Array.from({length:60},(_,i)=>({heading:'Section '+i,page:i+1,paragraphs:[para(i+1,'word '.repeat(400))]}))};
 const input=PC.summaryInput(big);
 assert.ok(input.chars<=PC.SUMMARY_BUDGET,`${input.chars} chars`);assert.equal(input.truncated,true);
 assert.match(input.text,/Section 59/,'the last section is still there, only shorter');
 assert.ok(PC.summaryInput(big,{budget:5000}).chars<=5000);
});

test('the summary prompt asks for a researcher\'s parts in the output language, numbers with their pages, and forbids inventing',()=>{
 const ko=PC.summaryPrompt('Korean'),en=PC.summaryPrompt('English');
 assert.match(ko,/Write in Korean/);assert.match(ko,/## 요약/);assert.match(ko,/## 내 연구와의 관계/);assert.match(ko,/## 다음에 읽을 것/);
 assert.deepEqual([...ko.matchAll(/^## (.+)$/gm)].map(m=>m[1]).slice(0,4),['요약','핵심 결과','방법','한계'],'the self-check reads the first four');
 assert.match(en,/## Key findings/);assert.match(en,/## What to read next/);
 assert.match(en,/what is new compared with earlier work/);assert.match(en,/with its numbers/);
 assert.match(en,/Do not invent numbers/);assert.match(en,/\(Section, p\. N\)/);
 assert.match(ko,/Keep technical terms[^.]*in English/,'Korean prose, the paper\'s own terms');assert.doesNotMatch(en,/Keep technical terms/);
 assert.match(en,/Leave this section out entirely when there is no MY LIBRARY block/);
});

test('the spare summary budget goes to more results paragraphs, numbers first, each cited with its own page',()=>{
 const input=PC.summaryInput(paper());
 assert.match(input.text,/\[Results, p\. 5\] Fidelity fell slightly, with an error rate of 2\.1e-5/,'the second results paragraph, on its own page');
 assert.match(input.text,/\[Results, p\. 4\] Variant M7/);
 assert.ok(PC.quantScore('80 percent after 30 min at 95 °C, n = 3, P < 0.01')>PC.quantScore('The gain comes from a rigid thumb domain.'));
});

test('a Cell paper with one long RESULTS section is summarised from its results across their pages, not the first 900 characters',(t)=>{
 const s=realPaper('cell');if(!s)return t.skip('fixture not present');
 const input=PC.summaryInput(s,{pageBase:1});
 const pages=new Set(input.parts.filter(p=>/^\[RESULTS/.test(p.label)).map(p=>p.label));
 assert.ok(pages.size>=4,[...pages].join(' '));
 assert.ok(input.parts.filter(p=>p.part==='results').reduce((n,p)=>n+p.text.length,0)>8000);
 assert.ok(input.chars<=PC.SUMMARY_BUDGET);assert.equal(input.truncated,false);assert.ok(input.coverage>0.5);
});

test('the user\'s library goes in as a labelled block, titles only, within its size',()=>{
 assert.equal(PC.libraryBlock({}),'');
 const b=PC.libraryBlock({memo:'I study Type III RM enzymes.',tags:['#topic/RM','/reading'],collections:['Restriction'],neighbours:[{title:'Type III restriction enzymes need two sites',year:1992},{title:''}]});
 assert.match(b,/^MY LIBRARY/);assert.match(b,/Tags on this paper: #topic\/RM, \/reading/);assert.match(b,/In collections: Restriction/);
 assert.match(b,/L1\. Type III restriction enzymes need two sites \(1992\)/);assert.doesNotMatch(b,/L2\./);
 assert.ok(PC.libraryBlock({memo:'x'.repeat(9000),neighbours:Array.from({length:40},(_,i)=>({title:'Paper '+i}))}).length<=2400);
});

test('a chat question is sent with the rules, the picked excerpts with their pages, the summary, and the last six turns only',()=>{
 const chunks=PC.buildChunks(paper());
 const history=Array.from({length:20},(_,i)=>({role:i%2?'assistant':'user',content:'turn '+i}));
 const {messages,picked}=PC.chatMessages({question:'How were libraries screened?',history,chunks,summary:'SUMMARY TEXT',language:'English',viewing:{page:3,section:'Methods',sectionIndex:1}});
 assert.equal(messages[0].role,'system');
 assert.match(messages[0].content,/Answer only from the excerpts/);assert.match(messages[0].content,/Answer in English/);
 assert.match(messages[0].content,/\[E\d\] \(Methods, p\. 3\)/);assert.match(messages[0].content,/SUMMARY TEXT/);
 assert.match(messages[0].content,/looking at page 3 \(Methods\)/);
 assert.match(messages[0].content,/say plainly that the paper/);
 const turns=messages.slice(1,-1);assert.equal(turns.length,12,'six turns = twelve messages');assert.equal(turns[0].content,'turn 8');
 assert.equal(messages.at(-1).content,'How were libraries screened?');
 assert.ok(picked.length>=2&&picked.length<=7);
 assert.doesNotMatch(JSON.stringify(messages),/@|apiKey|Bearer/,'nothing about the user or credentials');
});

test('the user\'s own memo and tags are sent only for the question that asks for them',()=>{
 const chunks=PC.buildChunks(paper());
 const plain=PC.chatMessages({question:'What is the claim?',chunks,language:'English',mine:null});
 assert.doesNotMatch(plain.messages[0].content,/OWN NOTES/);
 const mine=PC.chatMessages({question:'How does this relate to my research?',chunks,language:'English',mine:{memo:'I work on thermostable enzymes.',tags:['#topic/PCR']}});
 assert.match(mine.messages[0].content,/OWN NOTES[\s\S]*#topic\/PCR[\s\S]*thermostable enzymes/);
});

test('a follow-up question leans on the one before it to find its passage',(t)=>{
 const s=realPaper('crampton');if(!s)return t.skip('fixture not present');
 const chunks=PC.buildChunks(s,{pageBase:1});
 const alone=PC.chatMessages({question:'왜 그런가요?',chunks,language:'Korean'}).picked;
 assert.ok(!alone.some(c=>/^Translocation of DNA/.test(c.section)),'without the earlier question it misses');
 const history=[{role:'user',content:'How was DNA translocation shown to be unidirectional?'},{role:'assistant',content:'Yes (Results, p. 3).'}];
 const follow=PC.chatMessages({question:'왜 그런가요?',history,chunks,language:'Korean'}).picked;
 assert.ok(follow.some(c=>/^Translocation of DNA/.test(c.section)),follow.map(c=>c.section).join(' | '));
});

test('a Korean question about a quantity finds it in an English paper',(t)=>{
 const c=realPaper('crampton');
 if(c)assert.ok(PC.rank(PC.buildChunks(c,{pageBase:1}),'그 속도는 얼마였어?',{k:6}).some(x=>/^Translocation of DNA/.test(x.section)),'속도 is speed, rate');
 const s=realPaper('science');if(!s)return t.skip('fixture not present');
 const picked=PC.rank(PC.buildChunks(s,{pageBase:1}),'해상도는?',{k:6});
 assert.ok(picked.some(c=>/3\.01 and 3\.47 Å/.test(c.text)),picked.map(c=>c.section).join(' | '));
});

test('a selected passage is quoted to the model with its page and steers what is retrieved',()=>{
 const chunks=PC.buildChunks(paper());
 const q=PC.quickPrompt('passage');assert.match(q.question,/선택한 부분/);
 const {messages,picked}=PC.chatMessages({question:q.question,chunks,language:'English',passage:{text:'Fidelity fell slightly, with an error rate of 2.1e-5.',page:5}});
 assert.match(messages[0].content,/SELECTED PASSAGE \(the reader selected this on p\. 5[^)]*\):\n"Fidelity fell slightly/);
 assert.ok(picked.some(c=>c.section==='Results'));
});

test('answers end with follow-up questions, which are split off, also while the answer is still streaming',()=>{
 assert.match(PC.chatSystemPrompt('Korean'),/FOLLOW-UPS: first question \| second question/);
 assert.match(PC.chatSystemPrompt('Korean'),/Keep technical terms/);
 assert.deepEqual(PC.splitFollowUps('It rose 4-fold (Results, p. 4).\n\nFOLLOW-UPS: 대조군은? | 몇 번 반복했나요?'),{body:'It rose 4-fold (Results, p. 4).',followUps:['대조군은?','몇 번 반복했나요?']});
 assert.deepEqual(PC.splitFollowUps('Answer.\n**FOLLOW-UPS:** - What controls? \n- How many replicates?'),{body:'Answer.',followUps:['What controls?','How many replicates?']});
 assert.equal(PC.splitFollowUps('Answer so far.\nFOLL').body,'Answer so far.','a marker still arriving is held back');
 assert.equal(PC.splitFollowUps('Answer.\nFollowing the').body,'Answer.\nFollowing the','ordinary words are not');
 assert.deepEqual(PC.splitFollowUps('No marker.'),{body:'No marker.',followUps:[]});
 assert.deepEqual(PC.splitFollowUps('A.\nFOLLOW-UPS: 1. 대조군은? | 250 bp 이내 신호는 어떻게 해석되나요?').followUps,['대조군은?','250 bp 이내 신호는 어떻게 해석되나요?'],'a number that starts the question stays');
});

test('earlier turns stay inside a character budget, newest first, and lose their follow-up lines',()=>{
 const long='x'.repeat(3900);
 const history=Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',content:(i%2?long+'\nFOLLOW-UPS: a? | b?':'question '+i)}));
 const {messages}=PC.chatMessages({question:'Q',chunks:[],history,language:'English'});
 const turns=messages.slice(1,-1),chars=turns.reduce((n,m)=>n+m.content.length,0);
 assert.ok(chars<=PC.HISTORY_CHARS+4000,String(chars));assert.ok(turns.length>=2&&turns.length<12);
 assert.equal(turns[0].role,'user','the kept history starts with a question');
 assert.equal(turns.at(-1).content,long,'the newest answer whole, without its follow-ups');
});

test('failed or empty earlier turns are not sent back',()=>{
 const {messages}=PC.chatMessages({question:'Q',chunks:[],history:[{role:'user',content:'a'},{role:'assistant',content:'oops',error:true},{role:'assistant',content:''}],language:'English'});
 assert.deepEqual(messages.slice(1,-1).map(m=>m.content),['a']);
});

test('quick prompts come with the panel\'s own words and say whether they need the page or the memo',()=>{
 const t=s=>'T:'+s;
 assert.match(PC.quickPrompt('claim',t).question,/^T:이 논문의 핵심 주장/);
 assert.equal(PC.quickPrompt('figure',t).forcePage,true);assert.equal(PC.quickPrompt('mine',t).mine,true);
 assert.equal(PC.quickPrompt('nope'),null);
 assert.deepEqual(Object.keys(PC.QUICK),['claim','methods','limits','figure','mine']);
});

test('a page reference in parentheses becomes a link to that page; numbers elsewhere do not',()=>{
 const seg=PC.linkCitations('The enzyme kept 80% activity (Results, p. 4; Methods, pp. 3-4). In 2020 there were 5 variants.',{pages:12});
 assert.deepEqual(seg.filter(s=>s.type==='cite').map(s=>s.page),[4,3]);
 assert.equal(seg.map(s=>s.text).join(''),'The enzyme kept 80% activity (Results, p. 4; Methods, pp. 3-4). In 2020 there were 5 variants.','nothing is lost');
 assert.equal(PC.linkCitations('see p. 4 and page 5',{pages:12}).filter(s=>s.type==='cite').length,0,'outside parentheses it is just words');
 assert.deepEqual(PC.linkCitations('(방법, 4쪽)',{pages:12}).filter(s=>s.type==='cite').map(s=>s.page),[4]);
 assert.equal(PC.linkCitations('(Results, p. 40)',{pages:12}).filter(s=>s.type==='cite').length,0,'a page the paper does not have is not a link');
 assert.equal(PC.linkCitations('',{pages:3}).length,0);
});

test('streamed events are read as they arrive, split anywhere, and end at [DONE]',()=>{
 const got=[];const r=PC.streamReader(piece=>got.push(piece));
 const events=['data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n','data: {"choices":[{"delta":{"content":"lo"}}]}\n\n','data: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n'];
 let full='';
 // the first event arrives cut in the middle of a line
 full+=events[0].slice(0,25);r.update(full);assert.deepEqual(got,[]);
 full+=events[0].slice(25)+events[1];r.update(full);assert.deepEqual(got,['Hel','lo']);
 full+=events[2];r.update(full);r.end();
 assert.equal(r.text,'Hello world');assert.equal(r.done,true);
});

test('a server that ignored stream:true and sent one JSON document is still read',()=>{
 const r=PC.streamReader();
 r.update('{"choices":[{"message":{"content":"Whole answer"}}]}');
 assert.equal(r.end(),'Whole answer');
 assert.equal(PC.isEventStream('text/event-stream; charset=utf-8'),true);assert.equal(PC.isEventStream('application/json'),false);
});

test('lines that are comments, other events or garbage are ignored',()=>{
 const r=PC.streamReader();
 r.update(': keep-alive\n\nevent: ping\ndata: not json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
 assert.equal(r.end(),'ok');
});

/* ---- retrieval intents, Korean questions, figures, summary budget (real papers) ---- */
import {createRequire as __cr} from 'node:module';
import __fs from 'node:fs';
const __PT=__cr(import.meta.url)('../src/paper-text.js');
const realPaper=name=>{const url=new URL(`./fixtures/paper-text/${name}.json`,import.meta.url);if(!__fs.existsSync(url))return null;return __PT.structure({pages:JSON.parse(__fs.readFileSync(url,'utf8')).pages,meta:{}});};

test('"방법 요약" retrieves the Methods sections of an English paper, not just the abstract and introduction',(t)=>{
 const s=realPaper('nar2025');if(!s)return t.skip('fixture not present');
 const chunks=PC.buildChunks(s,{pageBase:1});
 const q=PC.quickPrompt('methods');
 const picked=PC.rank(chunks,q.question,{k:6,intent:q.intent});
 const parts=picked.map(c=>c.part);
 assert.ok(parts.filter(p=>p==='methods').length>=3,`methods chunks picked: ${picked.map(c=>c.section).join(' | ')}`);
});

test('a free Korean question finds English sections through the bilingual research terms',(t)=>{
 const s=realPaper('nar2025');if(!s)return t.skip('fixture not present');
 const chunks=PC.buildChunks(s,{pageBase:1});
 const picked=PC.rank(chunks,'이 논문의 한계는 뭐야?',{k:6});
 assert.ok(picked.some(c=>c.part==='discussion'),picked.map(c=>c.section).join(' | '));
 const methods=PC.rank(chunks,'실험 방법을 알려줘',{k:6});
 assert.ok(methods.some(c=>c.part==='methods'),methods.map(c=>c.section).join(' | '));
});

test('a question that matches nothing still gets the section on screen, the abstract and the discussion, not two chunks',()=>{
 const chunks=PC.buildChunks(paper(),{});
 const picked=PC.rank(chunks,'zzzz qqqq',{k:6,sectionIndex:1});
 assert.ok(picked.length>=3);
 assert.ok(picked.some(c=>c.kind==='abstract'));assert.ok(picked.some(c=>c.sectionIndex===1));assert.ok(picked.some(c=>c.part==='discussion'));
});

test('"이 그림 설명" sends the captions and tables of the page on screen first, then the body there',()=>{
 const doc=paper();
 doc.sections[1].paragraphs=Array.from({length:6},(_,i)=>({sentences:[{text:'Long body text about methods number '+i+' '+'filler words here '.repeat(20),page:2}]}));
 doc.captions=[{text:'Figure 2. Residual activity after heat challenge.',page:2},{text:'Figure 9. Elsewhere.',page:7}];
 doc.tables=[{text:'Table 1. Strains used in this study.',page:2}];
 const chunks=PC.buildChunks(doc,{pageBase:1});
 const q=PC.quickPrompt('figure');
 const picked=PC.rank(chunks,q.question,{k:6,page:3,forcePage:true,intent:q.intent});
 const texts=picked.map(c=>c.text);
 assert.ok(texts.some(t=>/^Figure 2\./.test(t)),'the caption on the page');assert.ok(texts.some(t=>/^Table 1\./.test(t)),'the table on the page');
 assert.ok(!texts.some(t=>/Figure 9/.test(t)),'not a caption from another page');
 const m=PC.chatMessages({question:q.question,chunks,viewing:{page:3},forcePage:true,intent:q.intent});
 assert.ok(m.messages[0].content.indexOf('Figure 2.')<m.messages[0].content.indexOf('Long body text'),'captions come first');
});

test('the summary leaves out back matter and keeps the methods to a sixth of the budget; title, abstract and section list always fit',(t)=>{
 const nature=realPaper('nature');if(!nature)return t.skip('fixture not present');
 const input=PC.summaryInput(nature,{pageBase:1});
 assert.ok(input.chars<=PC.SUMMARY_BUDGET);
 assert.doesNotMatch(input.text,/Reporting summary|Online content|Data availability|Code availability|Peer review|Field-specific reporting|Life sciences study design/i);
 const methodsChars=input.parts.filter(p=>p.part==='methods').reduce((n,p)=>n+p.text.length,0);
 assert.ok(methodsChars<=PC.SUMMARY_BUDGET*0.15+200,`methods use ${methodsChars} characters`);
 const natcomm=realPaper('natcomm');
 if(natcomm){const n=PC.summaryInput(natcomm,{pageBase:1});assert.doesNotMatch(n.text,/Open Access|Creative Commons|Peer review information|Author contributions/i);}
 const tiny=PC.summaryInput(nature,{pageBase:1,budget:3000});
 assert.ok(tiny.chars<=3000);assert.match(tiny.text,/^TITLE: /);assert.match(tiny.text,/ABSTRACT: /);assert.match(tiny.text,/SECTIONS: /);
});

/* ---- 0.59.24: long captions, Korean section names --------------------------- */
const longCaption=(label,panels,style)=>label+' Translation is required for efficient early transcription. '+panels.map((p,i)=>(style==='nature'?p.toLowerCase()+', ':'('+p+') ')+'Panel '+p+' shows '+('measured promoter-proximal signal under condition '+p+' with replicate spread. ').repeat(i===panels.length-1?3:4)+'END'+p+'.').join(' ');
test('a long figure caption reaches the AI whole: split into panels, the figure on screen first, nothing cut at 1,400 characters',()=>{
 const nar=longCaption('Figure 3.',['A','B','C','D','E','F'],'cell');
 const nat=longCaption('Extended Data Fig. 2 |',['A','B','C','D','E','F','G','H','I','J','K','L','M'],'nature');
 assert.ok(nar.length>1800&&nat.length>4000,`${nar.length} / ${nat.length}`);
 for(const text of [nar,nat]){
  const doc=paper();doc.captions=[{kind:'figure',label:text.startsWith('Figure')?'Figure 3':'Extended Data Fig. 2',text,page:6},{kind:'figure',label:'Figure 9',text:'Figure 9. Elsewhere.',page:8}];
  const chunks=PC.buildChunks(doc,{pageBase:1});
  const caps=chunks.filter(c=>c.kind==='caption'&&c.page===7);
  assert.ok(caps.length>=3,'cut into panels: '+caps.length);
  assert.ok(caps.every(c=>c.text.length<=1400),'no piece longer than an excerpt');
  assert.ok(caps.slice(1).every(c=>/panel [A-Ma-m]/.test(c.section)),caps.map(c=>c.section).join(' | '));
  const q=PC.quickPrompt('figure');
  const m=PC.chatMessages({question:q.question,chunks,viewing:{page:7},forcePage:true,intent:q.intent});
  const sys=m.messages[0].content;
  for(const end of text.match(/END[A-M]\./g))assert.ok(sys.includes(end),end+' is sent');
  assert.ok(!/Figure 9/.test(sys),'not the figure of another page');
 }
});
test('the real NAR 2025 Figure 3 caption (1,901 characters) is sent whole when its page is on screen',(t)=>{
 const s=realPaper('nar2025');if(!s)return t.skip('fixture not present');
 const cap=s.captions.find(c=>/^Figure 3\b/.test(c.label||c.text));assert.ok(cap&&cap.text.length>1800);
 const chunks=PC.buildChunks(s,{pageBase:1});
 const q=PC.quickPrompt('figure');
 const sys=PC.chatMessages({question:q.question,chunks,viewing:{page:cap.page+1},forcePage:true,intent:q.intent}).messages[0].content;
 const flat=sys.replace(/\s+/g,' ');
 assert.ok(flat.includes(cap.text.replace(/\s+/g,' ').slice(-80)),'the end of the caption is there');
});
test('Korean section names are classified (no ASCII \\b after Hangul), and the extraction module\'s part is used when present',()=>{
 const sec=(heading,extra={})=>({heading,level:1,page:0,paragraphs:[{sentences:[{text:'x',page:0}]}],...extra});
 assert.deepEqual(PC.partsOf({sections:[sec('서론'),sec('2. 방법'),sec('결과'),sec('논의'),sec('결론'),sec('참고문헌')]}),['intro','methods','results','discussion','discussion','back']);
 assert.deepEqual(PC.partsOf({sections:[sec('Something',{part:'methods'}),sec('Other',{kind:'back'})]}),['methods','back']);
 assert.ok(PC.expandQuery('표 1을 설명해줘').includes('table'));assert.ok(!PC.expandQuery('표본 크기').includes('table'),'표본 is a sample, not a table');
});

test('word forms meet: lifetimes/lifetime, measured/measurements, so a protocol question finds the protocol',(t)=>{
 assert.equal(PC.stem('lifetimes'),PC.stem('lifetime'));assert.equal(PC.stem('measured'),PC.stem('measurements'));
 assert.equal(PC.stem('matches'),PC.stem('match'));assert.equal(PC.stem('libraries'),'library');
 const s=realPaper('nar2025');if(!s)return t.skip('fixture not present');
 const chunks=PC.buildChunks(s,{pageBase:1});
 const a=PC.rank(chunks,'How were the mRNA lifetimes measured?',{k:6}).map(c=>c.id),b=PC.rank(chunks,'How were the mRNA lifetime measurements performed?',{k:6}).map(c=>c.id);
 const protocol=chunks.filter(c=>c.part==='methods'&&/lifetime/i.test(c.text)).map(c=>c.id);
 assert.ok(protocol.length);assert.ok(a.some(id=>protocol.includes(id)),`picked ${a} protocol ${protocol}`);assert.ok(b.some(id=>protocol.includes(id)));
});

test('a figure named in the question brings its caption and the passages citing it, in English or Korean',(t)=>{
 assert.deepEqual(PC.figureRefs('What does Figure 3E show, and Table 1? 그림 2는?').map(r=>r.kind+r.n+r.panel),['figure3E','table1','figure2']);
 assert.deepEqual(PC.figureRefs('Extended Data Fig. 4').map(r=>r.prefix+':'+r.n),['extended data:4']);
 const s=realPaper('nar2025');if(!s)return t.skip('fixture not present');
 const chunks=PC.buildChunks(s,{pageBase:1});
 for(const q of ['What does Figure 3 show?','그림 3은 무엇을 보여주나요?']){
  const picked=PC.rank(chunks,q,{k:6});
  assert.ok(picked.some(c=>c.kind==='caption'&&/^Figure 3\b/.test(c.section)),q+': '+picked.map(c=>c.section).join(' | '));
  assert.ok(picked.some(c=>c.kind==='body'&&/Fig(?:ure)?\.?\s*3/.test(c.text)),q+': a passage citing it');
  assert.ok(!picked.some(c=>c.kind==='caption'&&/^Figure [1245]\b/.test(c.section)),'not other figures');
 }
});

test('a chunk stays on one page: a paragraph that turns the page is cited on each page; the abstract on its own page',()=>{
 const p={title:'T',abstract:'An abstract.',sections:[{heading:'Abstract',kind:'abstract',page:1,paragraphs:[para(1,'An abstract.')]},
  {heading:'Results',level:1,page:3,paragraphs:[{sentences:[sent('All four mutants were made and purified to homogeneity for this assay series.',3),sent('All four mutants showed reduced activity in plaque assays against every phage tested here.',4)]}]}]};
 const chunks=PC.buildChunks(p,{pageBase:1});
 assert.equal(chunks.find(c=>c.kind==='abstract').page,2,'the abstract is on its own page');
 const reduced=chunks.find(c=>/reduced activity/.test(c.text));assert.equal(reduced.page,5);assert.doesNotMatch(reduced.text,/purified/);
 assert.match(PC.summaryInput(p,{pageBase:1}).text,/\[Results, pp\. 4–5\] All four mutants were made/);
});

test('a stream says when its answer is not whole: an error event, a length limit, or no end',()=>{
 const ev=o=>'data: '+JSON.stringify(o)+'\n\n',d=t=>ev({choices:[{delta:{content:t}}]});
 const whole=PC.streamReader();whole.update(d('a')+ev({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n');whole.end();assert.equal(whole.incomplete,null);
 const err=PC.streamReader();err.update(d('a')+ev({error:{message:'The answer stopped early'}}));err.end();assert.equal(err.incomplete,'error');assert.equal(err.text,'a');
 const len=PC.streamReader();len.update(d('a')+ev({choices:[{delta:{},finish_reason:'length'}]})+'data: [DONE]\n\n');len.end();assert.equal(len.incomplete,'length');
 const cut=PC.streamReader();cut.update(d('a'));cut.end();assert.equal(cut.incomplete,'cut');
 const json=PC.streamReader();json.update('{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}]}');json.end();assert.equal(json.incomplete,null);
});

test('a follow-up keeps the passages the previous answer stood on',()=>{
 const chunks=PC.buildChunks(paper());
 const fid=chunks.find(c=>/Fidelity/.test(c.text)).id;
 const history=[{role:'user',content:'What happened to fidelity?'},{role:'assistant',content:'It fell (Results, p. 5).',picked:[0,fid]}];
 const {picked}=PC.chatMessages({question:'How were libraries screened?',history,chunks,language:'English',k:2});
 assert.ok(picked.some(c=>c.id===fid),'the earlier evidence is still there');
 const quick=PC.chatMessages({question:'How were libraries screened?',history,chunks,language:'English',k:2,intent:{parts:['methods']}}).picked;
 assert.ok(!quick.some(c=>c.id===fid),'a quick prompt starts afresh');
});
