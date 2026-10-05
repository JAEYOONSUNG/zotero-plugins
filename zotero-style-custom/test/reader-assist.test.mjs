import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {parseHTML} from 'linkedom';
import I18N from '../src/i18n.js';
import Strings from '../src/strings.js';
import Assist from '../src/assist.js';
import RA from '../src/read-aloud.js';
import PC from '../src/paper-chat.js';
import TR from '../src/paper-translate.js';
import ReaderAssist from '../src/reader-assist.js';
import SelfCheck from '../src/selfcheck.js';
const require=createRequire(import.meta.url);
const PT=require('../src/paper-text.js');
I18N.load(Strings.en);I18N.use('en-US');

const realSetTimeout=globalThis.setTimeout.bind(globalThis),realClearTimeout=globalThis.clearTimeout.bind(globalThis);
const settle=async(n=8)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
const sent=(text,page,y=100)=>({text,page,rects:[[72,y,300,12]]});
const para=(page,...texts)=>({sentences:texts.map((t,i)=>sent(t,page,100+i*16))});
/* A small paper in the extraction module's shape: pages from 0, rectangles [x, y, w, h]. */
const paper=()=>({title:'Thermostable polymerase evolution',abstract:'We evolved a polymerase that tolerates 95 C.',
 sections:[
  {heading:'Introduction',level:1,page:0,kind:'body',paragraphs:[para(0,'DNA polymerases drive PCR.','Thermal stability limits cycling speed.')]},
  {heading:'Methods',level:1,page:2,kind:'body',paragraphs:[para(2,'Libraries were screened by compartmentalised self-replication.','Kinetics were measured at 72 C.')]},
  {heading:'Results',level:1,page:3,kind:'body',paragraphs:[para(3,'Variant M7 retained 80 percent activity after 30 minutes at 95 C.')]},
  {heading:'References',level:'back',page:9,kind:'back',paragraphs:[para(9,'Smith 2020 A paper.')]}],
 captions:[{kind:'figure',label:'Figure 1',text:'Figure 1. Residual activity after heat challenge.',page:2}],references:[{text:'Smith J. 2020. A paper.',page:9}],footnotes:[],skipped:{headers:[],footers:[],pageNumbers:[],equations:[],tables:[],other:[]},stats:{pages:10}});
const sizes=()=>Array.from({length:10},()=>({width:612,height:792,transform:[1,0,0,-1,0,792],rotation:0}));

function memoryIO(){
 const files=new Map();
 return {files,
  exists:async p=>files.has(p)||p==='/usr/bin/say'&&false,stat:async p=>files.has(p)?{size:files.get(p).length,lastModified:1}:{size:1000,lastModified:5},
  readUTF8:async p=>files.get(p),writeUTF8:async(p,text)=>{files.set(p,text);},makeDirectory:async()=>{},remove:async p=>{files.delete(p);}};
}
function fixture({prefs={},settings={},structured=paper(),withSpeech=true,voices=null,structCache=true,io=null,runtimeState=null}={}){
 const {document:doc,window:win}=parseHTML('<html><head></head><body><div id="split-view"></div></body></html>');
 const define=(name,value)=>Object.defineProperty(win,name,{value,configurable:true,writable:true});
 define('setTimeout',(fn,ms)=>realSetTimeout(fn,ms));define('clearTimeout',id=>realClearTimeout(id));define('navigator',{platform:'MacIntel'});
 define('getComputedStyle',()=>({fontSize:'13px',color:'rgb(30,30,30)',backgroundColor:'rgb(255,255,255)',display:'block',visibility:'visible',overflowX:'visible',colorScheme:''}));
 const viewWin=parseHTML('<html><body></body></html>').window,viewDoc=viewWin.document;
 Object.defineProperty(viewWin,'innerHeight',{value:800,configurable:true});
 viewWin.Element.prototype.getBoundingClientRect=function(){return this.hasAttribute&&this.hasAttribute('data-sc-ra-hl')?{top:100,bottom:112,left:0,right:10,width:10,height:12}:{top:0,bottom:0,left:0,right:0,width:0,height:0};};
 for(let i=1;i<=10;i++){const page=viewDoc.createElement('div');page.setAttribute('class','page');page.setAttribute('data-page-number',String(i));viewDoc.body.appendChild(page);}
 const synth={voices:voices||[{voiceURI:'v-en',name:'Samantha',lang:'en-US',localService:true,default:true},{voiceURI:'v-ko',name:'Yuna',lang:'ko-KR',localService:true}],queue:[],log:[],cur:null,
  getVoices(){return this.voices;},speak(u){this.queue.push(u);this.log.push(['speak',u.text]);},cancel(){this.queue.length=0;this.log.push(['cancel']);},pause(){this.log.push(['pause']);},resume(){this.log.push(['resume']);},
  begin(){const u=this.queue.shift();this.cur=u;u&&u.onstart&&u.onstart();return u;},finish(){const u=this.cur;this.cur=null;u&&u.onend&&u.onend();},step(){this.begin();this.finish();}};
 class Utt{constructor(text){this.text=text;}}
 const navs=[];
 const core={_state:{primaryViewStats:{pageIndex:2,pagesCount:10}},_primaryView:{_iframeWindow:{document:viewDoc}}};
 const frame={document:doc,closed:false,setTimeout:win.setTimeout,navigator:win.navigator};if(withSpeech){frame.speechSynthesis=synth;frame.SpeechSynthesisUtterance=Utt;}
 const reader={type:'pdf',itemID:11,tabID:'t1',_window:win,_iframeWindow:frame,_internalReader:core,navigate:async loc=>{navs.push(loc);}};
 if(doc.defaultView!==win)Object.defineProperty(doc,'defaultView',{configurable:true,get:()=>win});
 const fileIO=io||memoryIO();
 const folder='/data/style-custom-reader/';
 if(structCache)fileIO.files.set(folder+'1-ATT.struct.json',JSON.stringify({v:2,extractor:String(globalThis.StyleCustomPaperText&&globalThis.StyleCustomPaperText.VERSION||'1')+'.2',sig:'1000:5',structured,sizes:sizes(),fallback:false}));
 const attachment={id:11,key:'ATT',libraryID:1,parentID:10,getFilePathAsync:async()=> '/lib/ATT.pdf'};
 const parent={id:10,key:'ITEM',libraryID:1,isRegularItem:()=>true,getField:k=>({title:'Thermostable polymerase evolution',abstractNote:'We evolved a polymerase that tolerates 95 C.'}[k]||''),getTags:()=>[{tag:'#topic/PCR'},{tag:'/reading'}]};
 const requests=[],aiReplies=[];
 const http={async request(method,url,options){
  requests.push({method,url,options,body:options&&options.body?JSON.parse(options.body):null});
  if(url.endsWith('reader-assist.css'))return {response:fs.readFileSync(new URL('../content/reader-assist.css',import.meta.url),'utf8'),status:200};
  if(/deepl\.com/.test(url)){const r=http.deepl?http.deepl(requests.at(-1)):null;if(r)return r;if(method==='GET')return {status:200,response:{character_count:100,character_limit:500000}};return {status:200,response:{translations:requests.at(-1).body.text.map(x=>({text:'KO:'+x}))}};}
  const next=aiReplies.shift();
  if(typeof next==='function')return next(options);
  const content=next||'AI answer (Methods, p. 3).';
  return {status:200,response:{choices:[{message:{content}}]},responseText:JSON.stringify({choices:[{message:{content}}]}),getResponseHeader:()=> 'application/json'};
 }};
 const allPrefs={aiEndpoint:'https://example.org/v1/chat/completions',aiModel:'m1',aiKey:'secret-key',deeplApiKey:'',translateTarget:'KO',translateFormality:'default',...prefs};
 const allSettings={aiLanguage:'English',aiSummaryOnOpen:false,readAloudSpeed:100,readAloudVoice:'',readAloudVoiceKo:'',readAloudHeadings:false,readAloudCredit:true,...settings};
 const remarks=new Map(),memoCalls=[],notes=[],readings=[];
 const Z={Items:{get:id=>id===11?attachment:id===10?parent:null},HTTP:http,DataDirectory:{dir:'/data'},logError:e=>{(Z.errors||(Z.errors=[])).push(e);},Reader:{_readers:[reader]},PDFWorker:{async getFullText(){return {text:'Abstract\n\nPlain text. Second sentence.'};}},isMac:true};
 const runtime={cache:runtimeState||{},dirty:false,rootURI:'file:///plugin/',io:fileIO,paths:{join:(...p)=>p.join('/')},i18n:{isKorean:()=>false},t:I18N.t,
  pref:(k,d)=>allPrefs[k]??d,getSetting:k=>allSettings[k],setSetting:async(k,v)=>{allSettings[k]=v;allPrefs[k]=v;},scheduleFlush(){},
  entry:item=>({remark:remarks.get(item.id)||''}),addReading:async(item,seconds,location,shown)=>{readings.push({item:item.id,seconds,location,shown});},
  libraryService:{async setRemark(id,text,{base}){memoCalls.push({id,text,base});if(runtime.staleMemo)return {stale:true};remarks.set(id,text);return {};},async createNoteHTML(id,html){notes.push({id,html});return '1';}}};
 runtime.assist=Assist.create({Zotero:Z,runtime});
 const service=ReaderAssist.create({Zotero:Z,runtime});
 runtime.readerAssist=service;
 const container=doc.createElement('span');doc.body.appendChild(container);
 const toolbar=service.mountToolbar({reader,doc,container});
 const press=(node)=>{node.dispatchEvent(new win.Event('click',{bubbles:true}));};
 const byText=(text,root=doc)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text||b.title===text);
 const panel=()=>doc.querySelector('[data-sc-ra]');
 const sync=async()=>{service.sync(win,[reader],'t1');await settle();};
 const sessionOf=()=>service.sessions()[0];
 return {win,doc,viewDoc,reader,synth,navs,fileIO,Z,runtime,service,toolbar,container,press,byText,panel,sync,requests,aiReplies,http,remarks,memoCalls,notes,readings,allSettings,allPrefs,sessionOf,folder,
  open:async()=>{await sync();press(container.querySelector('button[data-safe="view"]'));await settle();},
  stop(){service.stop();}};
}

test('the toolbar gets two buttons, one to open the panel and one to listen; opening moves the reader over and closing puts it back',async()=>{
 const f=fixture();await f.sync();
 const buttons=[...f.container.querySelectorAll('button')];
 assert.equal(buttons.length,2);
 assert.equal(buttons[0].getAttribute('data-safe'),'view');assert.equal(buttons[1].getAttribute('data-opens'),'audio','the ▶ button says it plays audio');
 assert.equal(f.panel().hidden,true);assert.equal(f.doc.querySelector('#split-view').style.getPropertyValue('inset-inline-end'),'');
 f.press(buttons[0]);await settle();
 assert.equal(f.panel().hidden,false);assert.equal(f.doc.querySelector('#split-view').style.getPropertyValue('inset-inline-end'),'372px');
 assert.equal(buttons[0].getAttribute('aria-pressed'),'true');
 f.press(f.byText('Close panel'));await settle();
 assert.equal(f.panel().hidden,true);assert.equal(f.doc.querySelector('#split-view').style.getPropertyValue('inset-inline-end'),'');
 f.toolbar.remove();assert.equal(f.container.querySelectorAll('button').length,0);
 f.stop();assert.equal(f.panel(),null);
});

test('the open state is remembered for the next reader, and the panel waits for a press by default',async()=>{
 const state={};
 const a=fixture({runtimeState:state});await a.open();assert.equal(state.readerAssist.open,true);a.stop();
 const b=fixture({runtimeState:state});await b.sync();await settle();assert.equal(b.panel().hidden,false,'it comes back open');b.stop();
 const c=fixture();await c.sync();await settle();assert.equal(c.panel().hidden,true,'closed until opened');c.stop();
});

test('every button in the panel says what it does, and nothing that plays, calls or writes is a view button',async()=>{
 const f=fixture();await f.open();
 for(const id of ['ask','translate','listen']){f.press(f.panel().querySelector(`[data-tab="${id}"]`));await settle();}
 assert.deepEqual(ReaderAssist.unmarkedButtons(f.panel()).map(b=>b.textContent||b.getAttribute('aria-label')),[]);
 const marks=Object.fromEntries([...f.panel().querySelectorAll('button')].map(b=>[(b.textContent.trim()||b.getAttribute('aria-label')||b.title),b.getAttribute('data-safe')?'safe':b.getAttribute('data-opens')?'opens:'+b.getAttribute('data-opens'):'writes:'+b.getAttribute('data-writes')]));
 assert.equal(marks['Make summary'],'opens:ai');assert.equal(marks['Send'],'opens:ai');assert.equal(marks['Translate all'],'opens:ai');assert.equal(marks['From this page'],'opens:ai');
 assert.equal(marks['Add to memo'],'writes:memo');assert.equal(marks['Save as note'],'writes:note');assert.equal(marks['Clear conversation'],'writes:cache');
 assert.equal(marks['Read body only'],'opens:audio');assert.equal(marks['Next sentence'],'opens:audio');assert.equal(marks['Refresh usage'],'opens:network');
 for(const b of f.panel().querySelectorAll('[data-safe="view"]'))assert.doesNotMatch(b.textContent+b.title,/Make summary|Send|Translate|Read aloud|memo|note/i,'a view button must not be one of the others');
 f.stop();
});

test('opening the panel, switching tabs and syncing for a while sends nothing and speaks nothing',async()=>{
 const f=fixture();await f.open();
 for(const id of ['translate','listen','ask']){f.press(f.panel().querySelector(`[data-tab="${id}"]`));await settle();}
 for(let i=0;i<5;i++)await f.sync();
 assert.deepEqual(f.requests.filter(r=>!r.url.endsWith('.css')),[],'no AI, no translator');
 assert.deepEqual(f.synth.log,[]);
 f.stop();
});

test('with the summary-on-open setting off, nothing is sent; with it on, one request per paper, however many times it syncs or reopens',async()=>{
 const off=fixture();await off.sync();await settle(20);assert.equal(off.requests.filter(r=>r.body).length,0);off.stop();
 const io=memoryIO();
 const on=fixture({settings:{aiSummaryOnOpen:true},io});on.aiReplies.push('## Summary\nA short summary (Results, p. 4).');
 await on.sync();await settle(20);await on.sync();await settle(20);
 assert.equal(on.requests.filter(r=>r.body).length,1);
 assert.match(on.panel().textContent,/A short summary/);
 on.stop();await settle();
 const again=fixture({settings:{aiSummaryOnOpen:true},io});await again.sync();await settle(40);
 assert.equal(again.requests.filter(r=>r.body).length,0,'the cached summary is shown, not asked for again');
 assert.match(again.panel().textContent,/A short summary/);again.stop();
});

test('the summary button sends the prepared text, shows the result with page links, and the card is cached per model and language',async()=>{
 const f=fixture();await f.open();
 assert.ok(f.byText('Make summary'),'a button, not a request');
 f.aiReplies.push('## Summary\nIt works.\n## Key findings\n- 80% activity (Results, p. 4)');
 f.press(f.byText('Make summary'));await settle(20);
 const call=f.requests.find(r=>r.body);
 assert.equal(call.url,'https://example.org/v1/chat/completions');assert.equal(call.options.headers.Authorization,'Bearer secret-key');
 assert.match(call.body.messages[0].content,/five sections|## Key findings/);assert.match(call.body.messages[0].content,/Write in English/);
 assert.match(call.body.messages[1].content,/\[Methods, p\. 3\] Libraries were screened/,'section markers use 1-based page numbers');
 assert.doesNotMatch(JSON.stringify(call.body),/secret-key/,'the key is a header, never in the body');
 const cite=f.panel().querySelector('.sc-ra-summary .sc-ra-cite');assert.ok(cite);assert.equal(cite.getAttribute('data-page'),'4');
 f.press(cite);await settle();assert.equal(f.navs.at(-1).pageIndex,3,'the link goes to page index 3 = page 4');
 f.runtime.cache.readerAssist.open=true;
 f.press(f.byText('Regenerate'));await settle(20);assert.equal(f.requests.filter(r=>r.body).length,2,'regenerate asks again');
 await new Promise(r=>setTimeout(r,900));
 const saved=JSON.parse(f.fileIO.files.get(f.folder+'1-ATT.state.json'));
 assert.equal(Object.keys(saved.summary).length,1);assert.match(Object.keys(saved.summary)[0],/^m1\|English\|[\w]+\|[\w]+$/,'model, language, server and prompt revision');
 f.stop();
});

test('a summary failure is a sentence, not a stack; the button comes back',async()=>{
 const f=fixture();await f.open();
 f.aiReplies.push(()=>({status:401,response:{}}));
 f.press(f.byText('Make summary'));await settle(20);
 assert.match(f.panel().querySelector('.sc-ra-summary .sc-ra-error').textContent,/401|AI/);
 assert.equal(f.byText('Make summary').hidden,false);
 f.stop();
});

test('without an AI server the card says how to set one up and presses nothing',async()=>{
 const f=fixture({prefs:{aiEndpoint:'',aiModel:''}});await f.open();
 assert.match(f.panel().textContent,/Enter an AI server address and model in the settings first\. To use the Claude or ChatGPT account on this Mac, install the AI bridge/);
 f.press(f.byText('Make summary'));await settle(20);
 assert.equal(f.requests.filter(r=>r.body).length,0);f.stop();
});

test('"메모에 넣기" appends the summary to the memo through the memo write path with its base, and says so when the memo changed meanwhile',async()=>{
 const f=fixture();await f.open();f.aiReplies.push('## Summary\nBody.');
 f.press(f.byText('Make summary'));await settle(20);
 f.remarks.set(10,'my earlier memo');
 f.press(f.panel().querySelector('.sc-ra-summary [data-writes="memo"]'));await settle(10);
 assert.equal(f.memoCalls.length,1);assert.equal(f.memoCalls[0].id,10);assert.equal(f.memoCalls[0].base,'my earlier memo');
 assert.match(f.memoCalls[0].text,/^my earlier memo\n\n--- AI summary · \d{4}-\d\d-\d\d ---\n## Summary\nBody\.\n$/);
 f.runtime.staleMemo=true;f.press(f.panel().querySelector('.sc-ra-summary [data-writes="memo"]'));await settle(10);
 assert.match(f.panel().querySelector('.sc-ra-status').textContent,/memo changed/);
 f.stop();
});

test('a question goes out with the excerpts, the page on screen and the summary; the streamed answer fills in and its page links work',async()=>{
 const f=fixture();await f.open();
 const input=f.panel().querySelector('.sc-ra-input');
 input.textContent='How were libraries screened?';
 f.aiReplies.push(options=>{
  const listeners={};const xhr={readyState:3,responseText:'',getResponseHeader:()=> 'text/event-stream',addEventListener:(n,fn)=>(listeners[n]||=[]).push(fn)};
  options.requestObserver(xhr);
  xhr.responseText='data: {"choices":[{"delta":{"content":"By self-replication "}}]}\n\n';for(const fn of listeners.progress)fn();
  xhr.responseText+='data: {"choices":[{"delta":{"content":"(Methods, p. 3)."}}]}\n\ndata: [DONE]\n\n';for(const fn of listeners.progress)fn();
  return {status:200,responseText:xhr.responseText,getResponseHeader:()=> 'text/event-stream'};
 });
 f.press(f.byText('Send'));await settle(25);
 const call=f.requests.find(r=>r.body);
 assert.equal(call.body.stream,true);
 assert.match(call.body.messages[0].content,/Answer only from the excerpts/);
 assert.match(call.body.messages[0].content,/\(Methods, p\. 3\) Libraries were screened/);
 assert.match(call.body.messages[0].content,/looking at page 3 \(Methods\)/,'the section on screen is named');
 assert.equal(call.body.messages.at(-1).content,'How were libraries screened?');
 assert.equal(input.textContent,'');
 const answer=f.panel().querySelector('.sc-ra-msg-assistant');
 assert.match(answer.textContent,/By self-replication \(Methods, p\. 3\)\./);
 const cite=answer.querySelector('.sc-ra-cite');assert.equal(cite.getAttribute('data-page'),'3');
 f.press(cite);await settle();assert.equal(f.navs.at(-1).pageIndex,2);
 f.stop();
});

test('the conversation is kept to the last 20 messages, saved per paper, restored in a new session, and can be cleared',async()=>{
 const io=memoryIO();
 const f=fixture({io});await f.open();
 for(let i=0;i<12;i++){f.aiReplies.push('Answer '+i);f.panel().querySelector('.sc-ra-input').textContent='Question '+i;f.press(f.byText('Send'));await settle(15);}
 const bubbles=f.panel().querySelectorAll('.sc-ra-msg');assert.equal(bubbles.length,20);
 assert.match(bubbles[0].textContent,/Question 2/);
 const last=f.requests.filter(r=>r.body).at(-1).body.messages;
 assert.equal(last.length,1+12+1,'system, six earlier turns, the new question');
 await new Promise(r=>setTimeout(r,900));
 f.stop();
 const g=fixture({io});await g.open();await settle(10);
 assert.equal(g.panel().querySelectorAll('.sc-ra-msg').length,20);
 g.press(g.byText('Clear conversation'));await settle();
 assert.equal(g.panel().querySelectorAll('.sc-ra-msg').length,0);g.stop();
});

test('a failed question puts the text back and leaves no half message',async()=>{
 const f=fixture();await f.open();
 f.aiReplies.push(()=>({status:500,response:{}}));
 f.panel().querySelector('.sc-ra-input').textContent='Will this fail?';f.press(f.byText('Send'));await settle(20);
 assert.equal(f.panel().querySelectorAll('.sc-ra-msg').length,0);
 assert.equal(f.panel().querySelector('.sc-ra-input').textContent,'Will this fail?');
 assert.match(f.panel().querySelector('.sc-ra-chat .sc-ra-note:last-child').textContent,/500|AI/);
 f.stop();
});

test('Enter sends, Shift+Enter does not, and the Enter that confirms a Korean composition does not',async()=>{
 const f=fixture();await f.open();
 const input=f.panel().querySelector('.sc-ra-input');
 const key=(props)=>{const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,props);input.dispatchEvent(e);return e;};
 input.textContent='한글 입력 중';key({key:'Enter',isComposing:true,keyCode:229});await settle(10);assert.equal(f.requests.filter(r=>r.body).length,0);
 key({key:'Enter',shiftKey:true});await settle(10);assert.equal(f.requests.filter(r=>r.body).length,0);
 key({key:'Enter'});await settle(20);assert.equal(f.requests.filter(r=>r.body).length,1);
 f.stop();
});

test('the five quick prompts exist; the one about my research sends the memo and tags, the others do not',async()=>{
 const f=fixture();await f.open();
 const chips=[...f.panel().querySelectorAll('.sc-ra-chip')].map(b=>b.textContent.trim());
 assert.deepEqual(chips,['Central claim','Methods summary','Limitations','Explain this figure','Related to my research?']);
 f.remarks.set(10,'I engineer thermostable enzymes.');
 f.press(f.byText('Central claim'));await settle(20);
 assert.doesNotMatch(f.requests.find(r=>r.body).body.messages[0].content,/OWN NOTES/);
 f.press(f.byText('Related to my research?'));await settle(20);
 const mine=f.requests.filter(r=>r.body).at(-1).body.messages[0].content;
 assert.match(mine,/OWN NOTES[\s\S]*#topic\/PCR[\s\S]*thermostable enzymes/);
 f.press(f.byText('Explain this figure'));await settle(20);
 assert.match(f.requests.filter(r=>r.body).at(-1).body.messages[0].content,/Figure 1\. Residual activity/,'the caption on the page on screen is sent');
 f.stop();
});

test('the translation tab shows the cost before anything is sent and sends nothing until a button is pressed',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 assert.match(f.panel().textContent,/Translator: DeepL Free/);
 assert.match(f.panel().textContent,/Characters in the whole paper: about [\d,]+/);
 assert.match(f.panel().textContent,/Used this month \(characters\): 0 \/ 500,000/);
 assert.equal(f.requests.filter(r=>/deepl/.test(r.url)).length,0);
 assert.equal(f.panel().querySelectorAll('.sc-ra-row-card').length,3,'one row per body paragraph');
 assert.equal([...f.panel().querySelectorAll('.sc-ra-row-card')].some(r=>/References/.test(r.textContent)),false);
 f.stop();
});

test('"전체 번역" translates the paragraphs in reading order, one request, free endpoint for a :fx key, cached for the next time',async()=>{
 const io=memoryIO();
 const f=fixture({prefs:{deeplApiKey:'abc:fx'},io});await f.open();
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(30);
 assert.equal(f.requests.filter(r=>/deepl/.test(r.url))[0].url,'https://api-free.deepl.com/v2/usage','DeepL\'s own count first (free)');
 const calls=f.requests.filter(r=>/deepl/.test(r.url)&&r.method==='POST');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api-free.deepl.com/v2/translate');
 assert.equal(calls[0].options.headers.Authorization,'DeepL-Auth-Key abc:fx');
 assert.equal(calls[0].body.target_lang,'KO');assert.equal(calls[0].body.text[0],'DNA polymerases drive PCR. Thermal stability limits cycling speed.');
 assert.doesNotMatch(calls[0].options.body,/abc:fx|secret-key/);
 assert.match(f.panel().querySelector('.sc-ra-row-card').textContent,/KO:DNA polymerases/);
 assert.match(f.panel().textContent,/Finished\. Paragraphs translated: 3/);
 await new Promise(r=>setTimeout(r,900));f.stop();
 const g=fixture({prefs:{deeplApiKey:'abc:fx'},io});await g.open();g.press(g.panel().querySelector('[data-tab="translate"]'));await settle(15);
 assert.match(g.panel().querySelector('.sc-ra-row-card').textContent,/KO:DNA polymerases/,'shown without asking');
 assert.equal(g.requests.filter(r=>/deepl/.test(r.url)).length,0);
 g.press(g.byText('Translate all'));await settle(20);assert.equal(g.requests.filter(r=>/deepl/.test(r.url)&&r.method==='POST').length,0,'all cached: nothing translated again');
 g.stop();
});

test('"현재 페이지부터" starts at the paragraph of the page on screen',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('From this page'));await settle(30);
 const call=f.requests.find(r=>/deepl/.test(r.url)&&r.method==='POST');
 assert.deepEqual(call.body.text.length,2,'the Methods and Results paragraphs, not the Introduction');
 assert.match(call.body.text[0],/Libraries were screened/);
 f.stop();
});

test('a spent free quota stops the run with a plain message, keeps what was translated, and offers the next translator',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});f.http.deepl=()=>({status:456,response:{message:'Quota exceeded'}});await f.open();
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(30);
 assert.match(f.panel().textContent,/free quota is used up/);
 assert.equal(f.byText('Continue with another translator').hidden,false);
 f.stop();
});

test('the usage button asks DeepL for its own count; it is marked as a network call',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 assert.equal(f.byText('Refresh usage').getAttribute('data-opens'),'network');
 f.press(f.byText('Refresh usage'));await settle(20);
 assert.match(f.panel().textContent,/DeepL usage \(characters\): 100 \/ 500,000/);
 f.stop();
});

test('without DeepL the AI endpoint translates in batches; without either, the tab says how to set one up',async()=>{
 const f=fixture();await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 assert.match(f.panel().textContent,/Translator: AI/);
 f.aiReplies.push(options=>{const user=JSON.parse(options.body).messages[1].content;return {status:200,response:{choices:[{message:{content:JSON.stringify(JSON.parse(user).map(p=>'AI:'+p.text))}}]}};});
 f.press(f.byText('Translate all'));await settle(30);
 assert.match(f.panel().querySelector('.sc-ra-row-card').textContent,/AI:DNA polymerases/);
 f.stop();
 const none=fixture({prefs:{aiEndpoint:'',aiModel:''}});await none.open();none.press(none.panel().querySelector('[data-tab="translate"]'));await settle(10);
 assert.match(none.panel().textContent,/No translator is set up/);assert.equal(none.byText('Translate all').disabled,true);none.stop();
});

test('"노트로 저장" writes the original and the translation as one child note, only what is translated',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 f.press(f.byText('Save as note'));await settle(10);assert.equal(f.notes.length,0,'nothing translated yet: nothing written');
 f.press(f.byText('Translate all'));await settle(30);
 f.press(f.byText('Save as note'));await settle(10);
 assert.equal(f.notes.length,1);assert.equal(f.notes[0].id,10);
 assert.match(f.notes[0].html,/<h2>Methods \(p\. 3\)<\/h2><p>Libraries were screened/);assert.match(f.notes[0].html,/<blockquote><p>KO:Libraries/);
 f.stop();
});

test('pressing a row goes to its page; "다시 번역" asks again for that paragraph only',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 f.press(f.byText('Translate all'));await settle(30);
 const rows=f.panel().querySelectorAll('.sc-ra-row-card');
 f.press(rows[1].querySelector('.sc-ra-row-meta'));await settle();
 assert.equal(f.navs.at(-1).pageIndex,2);assert.ok(f.navs.at(-1).position.rects[0].every(Number.isFinite),'the rectangle is converted to the reader\'s own coordinates');
 f.press(rows[1].querySelector('[data-opens="ai"]'));await settle(20);
 assert.equal(f.requests.filter(r=>/deepl/.test(r.url)&&r.method==='POST').length,2);
 f.stop();
});

test('listening: the toolbar ▶ speaks from the page on screen without opening the panel, follows along on the page and in the list, and credits the listening',async()=>{
 const f=fixture();await f.sync();
 f.press(f.container.querySelectorAll('button')[1]);await settle(20);
 assert.equal(f.panel().hidden,true,'listening does not need the panel: the toolbar ▶ is play/pause');
 assert.deepEqual(f.synth.log.filter(l=>l[0]==='speak').map(l=>l[1]),['Libraries were screened by compartmentalised self-replication.'],'from the page on screen (page 3), body only');
 f.synth.begin();await settle();
 assert.match(f.panel().querySelector('.sc-ra-progress').textContent,/^Sentence \d+\/\d+ · under a minute left · Methods$/,'where, how long is left, and the section last (the part a narrow panel may cut)');
 const marks=f.viewDoc.querySelectorAll('[data-sc-ra-hl]');assert.equal(marks.length,1);
 assert.match(marks[0].parentNode.getAttribute('data-page-number'),/^3$/);
 assert.match(marks[0].getAttribute('style'),/left:11\.7\d*%/,'72 of 612 units, as a percentage of the page');
 assert.equal(f.navs.length,0,'already on that page and in view: no scrolling');
 assert.equal(f.panel().querySelector('.sc-ra-sentence[aria-current="true"]').textContent,'Libraries were screened by compartmentalised self-replication.');
 f.sessionOf().lastActivity=0;f.synth.finish();f.synth.begin();await settle();
 assert.equal(f.readings.length,1);assert.deepEqual(f.readings[0].location,{attachmentID:11,pageIndex:2,totalPages:10});assert.equal(f.readings[0].item,10);
 f.sessionOf().lastActivity=Date.now();f.synth.finish();await settle();
 assert.equal(f.readings.length,1,'someone touching the reader is already counted by the reading clock');
 f.stop();assert.equal(f.viewDoc.querySelectorAll('[data-sc-ra-hl]').length,0,'the overlay goes with the panel');
});

test('a sentence off screen is scrolled into view directly, not through reader.navigate (no Back entry, no blink); the highlight is an overlay, never an annotation',async()=>{
 const f=fixture();await f.sync();
 const scrolled=[];f.viewDoc.defaultView.Element.prototype.scrollIntoView=function(o){scrolled.push([this.parentNode.getAttribute('data-page-number'),o&&o.block]);};
 const rect=f.viewDoc.defaultView.Element.prototype.getBoundingClientRect;
 f.viewDoc.defaultView.Element.prototype.getBoundingClientRect=function(){return this.parentNode&&this.parentNode.getAttribute&&this.parentNode.getAttribute('data-page-number')==='4'?{top:2000,bottom:2012,left:0,right:10,width:10,height:12}:rect.call(this);};
 f.press(f.container.querySelectorAll('button')[1]);await settle(20);
 f.synth.begin();f.synth.finish();f.synth.begin();f.synth.finish();f.synth.begin();await settle();     // Methods x2, then Results (page 4)
 assert.deepEqual(scrolled,[['4','nearest']]);
 assert.equal(f.navs.length,0,'navigate is kept for explicit jumps');
 assert.equal(f.Z.annotationWrites,undefined);
 f.stop();
});

test('the player bar: play/pause, skip sentence, skip section, rate, voice and the three range choices',async()=>{
 const f=fixture();await f.open();
 f.press(f.byText('Read body only'));await settle(20);f.synth.begin();await settle();
 f.press(f.byText('Next sentence'));await settle();
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)[1],'Kinetics were measured at 72 degrees Celsius.');
 f.press(f.byText('Next section'));await settle();
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)[1],'Variant M7 retained 80 percent activity after 30 minutes at 95 degrees Celsius.');
 f.press(f.byText('Previous section'));await settle();
 f.press(f.byText('Pause'));await settle();assert.ok(f.synth.log.some(l=>l[0]==='pause'));
 f.press(f.byText('Carry on reading'));await settle();assert.ok(f.synth.log.some(l=>l[0]==='resume'));
 const rate=f.panel().querySelector('input[type="range"]');rate.value='150';rate.dispatchEvent(new f.win.Event('change',{bubbles:true}));await settle();
 assert.equal(f.allSettings.readAloudSpeed,150,'the rate is remembered');
 assert.equal(f.sessionOf().player.state().rate,1.5);
 f.press(f.panel().querySelector('[data-filter="captions"]'));await settle();
 assert.ok(f.sessionOf().player.units().some(u=>u.kind==='caption'));
 f.press(f.panel().querySelector('[data-filter="references"]'));await settle();
 assert.ok(f.sessionOf().player.units().some(u=>u.kind==='reference'));
 f.press(f.panel().querySelector('[data-filter="body"]'));await settle();
 assert.ok(f.sessionOf().player.units().every(u=>u.kind==='body'));
 f.stop();
});

test('the voice menu lists voices for the paper language, remembers the choice, and uses it',async()=>{
 const f=fixture();await f.open();f.press(f.byText('Read body only'));await settle(20);
 const toggle=f.panel().querySelector('[aria-label="Choose a voice"]');f.press(toggle);await settle();
 const items=[...f.panel().querySelectorAll('.sc-ra-menu-item')];
 assert.ok(items.some(i=>/Samantha/.test(i.textContent)));assert.ok(!items.some(i=>/Yuna/.test(i.textContent)),'an English paper is offered English voices');
 f.press(items.find(i=>/Samantha/.test(i.textContent)));await settle();
 assert.equal(f.allSettings.readAloudVoice,'v-en');
 f.stop();
});

test('"왜 건너뛰었나" shows the extraction module\'s own account',async()=>{
 const f=fixture();await f.open();
 const details=f.panel().querySelector('.sc-ra-why');details.open=true;details.dispatchEvent(new f.win.Event('toggle'));await settle(10);
 assert.match(f.panel().querySelector('.sc-ra-pre').textContent,/pages|page/);
 f.stop();
});

test('the last position is remembered and offered as "이어서 듣기" in the next session; it plays from that sentence',async()=>{
 const io=memoryIO();
 const f=fixture({io});await f.open();f.press(f.byText('Read body only'));await settle(20);f.synth.begin();f.synth.finish();f.synth.begin();await settle();
 await new Promise(r=>setTimeout(r,900));f.stop();
 const g=fixture({io});await g.open();await settle(10);
 const resume=g.panel().querySelector('.sc-ra-more .sc-ra-link');assert.equal(resume.hidden,false);assert.match(resume.textContent,/Continue listening · p\. 3/);
 g.press(resume);await settle(20);
 assert.equal(g.synth.log.filter(l=>l[0]==='speak').at(-1)[1],'Kinetics were measured at 72 degrees Celsius.');
 g.stop();
});

test('Alt(Option)+double-click on the page starts reading at the sentence there, only while the panel is open; a plain double-click selects a word as usual',async()=>{
 const f=fixture();await f.sync();
 const page=f.viewDoc.querySelector('.page[data-page-number="3"]');
 page.getBoundingClientRect=()=>({left:0,top:0,width:612,height:792});
 const dbl=(y,altKey)=>{const e=new f.win.Event('dblclick',{bubbles:true});Object.assign(e,{clientX:100,clientY:y,target:page,altKey});page.dispatchEvent(e);};
 dbl(106,true);await settle(20);assert.deepEqual(f.synth.log.filter(l=>l[0]==='speak'),[],'panel closed: a double-click is only a double-click');
 await f.open();
 dbl(122,false);await settle(30);assert.deepEqual(f.synth.log.filter(l=>l[0]==='speak'),[],'a plain double-click is how a word is selected');
 assert.match(f.byText('Read body only').title,/Alt\(Option\)\+double-click/,'the gesture is in the tooltip');
 dbl(122,true);await settle(30);
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)[1],'Kinetics were measured at 72 degrees Celsius.');
 f.stop();
});

test('without any voice and without macOS say the player says why instead of staying silent',async()=>{
 const f=fixture({voices:[]});f.Z.isMac=false;await f.open();
 f.press(f.byText('Read body only'));await settle(30);
 assert.match(f.panel().querySelector('.sc-ra-status').textContent,/No voice is available/);
 f.stop();
});

test('without the extraction module the plain text index still reads, summarises and chats (no highlight)',async()=>{
 const saved=globalThis.StyleCustomPaperText;delete globalThis.StyleCustomPaperText;
 try{
  const f=fixture({structCache:false});await f.open();
  f.press(f.byText('Read body only'));await settle(30);
  assert.ok(f.synth.log.some(l=>l[0]==='speak'));
  f.synth.begin();await settle();assert.equal(f.viewDoc.querySelectorAll('[data-sc-ra-hl]').length,0,'no rectangles, no overlay');
  f.stop();
 }finally{globalThis.StyleCustomPaperText=saved;}
});

test('the extraction path reads pdf.js page by page through pageFromPdfjs and caches the structure by file size and time',async()=>{
 const f=fixture({structCache:false});
 const pdfPage=n=>({view:[0,0,612,792],rotate:0,getViewport:()=>({width:612,height:792,rotation:0,scale:1,transform:[1,0,0,-1,0,792]}),
  async getTextContent(){return {items:[{str:'Abstract',transform:[11,0,0,11,72,700],width:50,height:11,fontName:'f1'},{str:'We study polymerases. They are useful.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{f1:{fontFamily:'sans-serif'},f2:{fontFamily:'serif'}}};},
  async getOperatorList(){return {};},commonObjs:{get:()=>{throw new Error('not loaded');}}});
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:2,getPage:async n=>pdfPage(n)}};
 await f.open();f.press(f.byText('Read body only'));await settle(40);
 const cached=JSON.parse(f.fileIO.files.get(f.folder+'1-ATT.struct.json'));
 assert.equal(cached.sig,'1000:5');assert.equal(cached.structured.stats.pages,2);assert.equal(cached.sizes.length,2);assert.deepEqual(cached.sizes[0].transform,[1,0,0,-1,0,792]);
 f.stop();
});

test('the self-check probe measures the panel on an open reader and presses nothing, starts no audio and calls no server',async()=>{
 const f=fixture();await f.sync();
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>({view:[0,0,612,792],rotate:0,
  async getTextContent(){return {items:[{str:'We study polymerases. They are useful.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{f2:{fontFamily:'serif'}}};},
  async getOperatorList(){return {};},commonObjs:{has:()=>true,get:()=>({name:'Serif'})}})}};
 let clicks=0;for(const b of f.panel().querySelectorAll('button'))b.addEventListener('click',()=>clicks++);
 const out=await f.service.probe(f.reader);
 assert.deepEqual(out.problems,[]);assert.ok(out.checked>40);assert.equal(clicks,0);assert.equal(out.player,'idle');
 assert.deepEqual(f.synth.log,[]);assert.deepEqual(f.requests.filter(r=>r.body),[]);
 assert.equal(f.panel().hidden,true,'put back the way it was');
 // a button that forgot to say what it does is a problem
 const stray=f.doc.createElement('button');stray.textContent='Mystery';f.panel().appendChild(stray);
 const bad=await f.service.probe(f.reader);assert.match(bad.problems.join(' '),/Mystery/);
 // text under 11px, or low contrast, is reported
 Object.defineProperty(f.win,'getComputedStyle',{configurable:true,writable:true,value:()=>({fontSize:'10px',color:'rgb(200,200,200)',backgroundColor:'rgb(255,255,255)',display:'block',visibility:'visible',overflowX:'visible',colorScheme:''})});
 stray.remove();const small=await f.service.probe(f.reader);assert.match(small.problems.join(' '),/under 11px/);assert.match(small.problems.join(' '),/contrast/);
 f.stop();
});

test('even if the panel sat inside the workbench the sweep would press only its view buttons',async()=>{
 const f=fixture();await f.open();
 const wrap=f.doc.createElement('div');wrap.setAttribute('class','sc-body');wrap.appendChild(f.panel().cloneNode(true));f.doc.body.appendChild(wrap);
 const pressed=SelfCheck.safeButtons(wrap);
 assert.ok(pressed.length>0);
 assert.deepEqual(pressed.filter(b=>b.hasAttribute('data-opens')||b.hasAttribute('data-writes')),[]);
 f.stop();
});

test('the panel never builds markup from paper or model text, and never reads an address or a key',()=>{
 const source=fs.readFileSync(new URL('../src/reader-assist.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
 assert.doesNotMatch(source,/aiKey|deeplApiKey|userEmail|openalexApiKey|citationEmail/,'the panel does not touch credentials; assist.js and paper-translate.js do, and only to send them to their own server');
 const translate=fs.readFileSync(new URL('../src/paper-translate.js',import.meta.url),'utf8');
 assert.doesNotMatch(translate,/email|mailto|userEmail/i);
 const assist=fs.readFileSync(new URL('../src/assist.js',import.meta.url),'utf8');
 assert.doesNotMatch(assist,/userEmail|citationEmail/);
});

test('a real paper runs through the whole chain: sections, reading order, chunks, a budgeted summary input, paragraphs with 1-based pages',()=>{
 const pages=JSON.parse(fs.readFileSync(new URL('./fixtures/paper-text/nature.json',import.meta.url),'utf8')).pages;
 const structured=PT.structure({pages,meta:{}});
 assert.ok(structured.sections.length>=3);
 const units=RA.composeUnits(structured,{},PT);
 assert.ok(units.length>50);assert.ok(units.every(u=>u.kind==='body'&&Number.isInteger(u.page)));
 assert.ok(!units.some(u=>structured.sections[u.sectionIndex].kind==='back'),'back matter is not read by default');
 const withRefs=RA.composeUnits(structured,{captions:true,references:true},PT);
 assert.ok(withRefs.length>units.length);
 const chunks=PC.buildChunks(structured,{pageBase:1});
 assert.ok(chunks.length>10);assert.ok(chunks.every(c=>c.page===null||c.page>=1),'1-based for people');
 const input=PC.summaryInput(structured,{pageBase:1});
 assert.ok(input.chars<=PC.SUMMARY_BUDGET);assert.match(input.text,/\[[^\]]+, p\. \d+\]/);assert.ok(!/p\. 0\b/.test(input.text));
 const top=PC.rank(chunks,'which method was used',{k:6});assert.ok(top.length>=2&&top.length<=7);
 const paragraphs=TR.paragraphsOf(structured,{pageBase:1});
 assert.ok(paragraphs.length>10);assert.ok(paragraphs.every(p=>p.page===null||p.page>=1));
 assert.ok(!paragraphs.some(p=>/^References$/i.test(p.heading)));
 const first=units[0];assert.ok(first.rects.length&&first.rects[0].length===4);
});

/* ---- the runtime defects --------------------------------------------------- */
function secondReader(f){
 const {document:doc,window:win}=parseHTML('<html><head></head><body><div id="split-view"></div></body></html>');
 Object.defineProperty(win,'setTimeout',{value:(fn,ms)=>realSetTimeout(fn,ms),configurable:true,writable:true});
 Object.defineProperty(win,'clearTimeout',{value:id=>realClearTimeout(id),configurable:true,writable:true});
 const frame={document:doc,closed:false,setTimeout:win.setTimeout,speechSynthesis:f.reader._iframeWindow.speechSynthesis,SpeechSynthesisUtterance:f.reader._iframeWindow.SpeechSynthesisUtterance};
 const reader={type:'pdf',itemID:21,tabID:'t2',_window:f.win,_iframeWindow:frame,_internalReader:{_state:{primaryViewStats:{pageIndex:0,pagesCount:10}},_primaryView:{_iframeWindow:{document:parseHTML('<html><body></body></html>').document}}},navigate:async()=>{}};
 const orig=f.Z.Items.get;f.Z.Items.get=id=>id===21?{id:21,key:'ATT2',libraryID:1,parentID:10,getFilePathAsync:async()=>'/lib/ATT2.pdf'}:orig(id);
 f.fileIO.files.set(f.folder+'1-ATT2.struct.json',f.fileIO.files.get(f.folder+'1-ATT.struct.json'));
 return reader;
}

test('extraction never hands pdf.js a chrome object: the viewport is computed from page.view, and fonts are awaited in commonObjs',async()=>{
 const f=fixture({structCache:false});
 let ready=false;
 const pdfPage=()=>({view:[0,0,612,792],rotate:0,
  getViewport(){throw new Error('Permission denied to access property "scale"');},
  async getTextContent(o){if(o!==undefined)throw new Error('a chrome options object reached pdf.js');return {items:[{str:'Abstract',transform:[11,0,0,11,72,700],width:50,height:11,fontName:'f1'},{str:'We study polymerases. They are useful.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{f1:{fontFamily:'sans-serif'},f2:{fontFamily:'serif'}}};},
  async getOperatorList(){realSetTimeout(()=>{ready=true;},50);return {};},
  commonObjs:{has:()=>ready,get:id=>{if(!ready)throw new Error('not resolved');return {name:id==='f1'?'Helvetica-Bold':'Times',bold:id==='f1'};}}});
 const seen=[];const PTsaved=globalThis.StyleCustomPaperText;
 globalThis.StyleCustomPaperText={...PTsaved,pageFromPdfjs:(i,vp,content,opts)=>{seen.push({vp,fonts:opts.fonts});return PTsaved.pageFromPdfjs(i,vp,content,opts);}};
 try{
  f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>pdfPage()}};
  await f.open();f.press(f.byText('Read body only'));await settle(80);await new Promise(r=>setTimeout(r,200));
  const cached=JSON.parse(f.fileIO.files.get(f.folder+'1-ATT.struct.json'));
  assert.equal(cached.fallback,false,'pdf.js was read, not the plain-text index');
  assert.deepEqual(seen[0].vp.transform,[1,0,0,-1,0,792]);
  assert.equal(seen[0].fonts.f1.bold,true,'the font that arrived a moment later is used');
  assert.ok(f.synth.log.some(l=>l[0]==='speak'));
 }finally{globalThis.StyleCustomPaperText=PTsaved;f.stop();}
});

test('the viewport matrix is pdf.js\'s own for every rotation, and the overlay boxes follow a rotated, zoomed page',()=>{
 assert.deepEqual(ReaderAssist.viewportFor([0,0,612,792],0).transform,[1,0,0,-1,0,792]);
 const r90=ReaderAssist.viewportFor([0,0,612,792],90);assert.deepEqual([r90.width,r90.height],[792,612]);assert.deepEqual(r90.transform,[0,1,1,0,0,0]);
 const r180=ReaderAssist.viewportFor([0,0,612,792],180);assert.deepEqual(r180.transform,[-1,0,0,1,612,0]);
 const size={width:612,height:792,transform:[1,0,0,-1,0,792]};
 const flat=ReaderAssist.overlayBoxes([[72,100,300,12]],size,null)[0];
 assert.ok(Math.abs(flat.left-72/612*100)<1e-9&&Math.abs(flat.top-100/792*100)<1e-9);
 const live=ReaderAssist.viewportFor([0,0,612,792],90,{scale:2});
 const turned=ReaderAssist.overlayBoxes([[72,100,300,12]],size,live)[0];
 // rotated 90°: the line runs down the page; its box is tall and narrow
 assert.ok(turned.height>turned.width,'a horizontal line becomes vertical on a page turned 90 degrees');
 assert.ok(Math.abs(turned.top-72/612*100)<1e-6);
});

test('Zotero\'s own Read Aloud playing: ours offers to stop it instead of fighting it; an interruption becomes a pause with a reason',async()=>{
 const f=fixture();await f.open();
 const core=f.reader._internalReader;let stoppedIt=0;
 core._state.readAloudState={active:true,paused:false};core.toggleReadAloudPopup=open=>{if(open===false){stoppedIt++;core._state.readAloudState={active:false,paused:false};}};
 f.press(f.byText('Read body only'));await settle(20);
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').length,0,'nothing spoken over the other reader');
 const clash=f.panel().querySelector('.sc-ra-clash');assert.equal(clash.hidden,false);
 f.press(f.byText('Stop and start'));await settle(20);
 assert.equal(stoppedIt,1);assert.ok(f.synth.log.some(l=>l[0]==='speak'));
 f.synth.begin();await settle();
 f.synth.cur.onerror({error:'interrupted'});await settle();          // the other speaker cancelled us
 assert.equal(f.sessionOf().player.state().status,'paused');
 assert.match(f.panel().querySelector('.sc-ra-status').textContent,/another read-aloud started/i);
 f.stop();
});

test('only one of our players speaks at a time across readers',async()=>{
 const f=fixture();await f.sync();
 const other=secondReader(f);f.service.sync(f.win,[f.reader,other],'t1');await settle(10);
 const [a,b]=f.service.sessions();
 f.press(f.container.querySelectorAll('button')[1]);await settle(20);f.synth.begin();await settle();
 assert.equal(a.player.state().status,'playing');
 const otherToolbar=parseHTML('<html><body><span></span></body></html>').document;const span=otherToolbar.querySelector('span');
 f.service.mountToolbar({reader:other,doc:otherToolbar,container:span});
 span.querySelectorAll('button')[1].dispatchEvent(new otherToolbar.defaultView.Event('click'));await settle(20);
 b.player&&b.player.state().status==='playing'||f.synth.begin();await settle();
 assert.equal(a.player.state().status,'paused','starting the other reader paused this one');
 f.stop();
});

test('a reader closed while the text is still loading starts nothing when the text arrives',async()=>{
 const f=fixture();await f.sync();
 let release;const read=f.fileIO.readUTF8;f.fileIO.readUTF8=p=>/struct/.test(p)?new Promise(r=>{release=()=>r(read(p));}):read(p);
 f.press(f.container.querySelectorAll('button')[1]);await settle(10);
 f.service.sync(f.win,[],'t1');await settle(5);          // the reader tab closes
 release();await settle(30);
 assert.deepEqual(f.synth.log.filter(l=>l[0]==='speak'),[]);
 f.stop();
});

test('closing the reader cancels a translation in flight; Stop during the first request sends nothing more',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});let cancelled=0;const pending=[];
 f.http.deepl=req=>req.method==='POST'?new Promise(r=>{pending.push(r);req.options.cancellerReceiver(()=>{cancelled++;r({status:0,response:null});});}):null;
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(15);
 assert.equal(f.requests.filter(r=>r.method==='POST'&&/deepl/.test(r.url)).length,1);
 f.service.sync(f.win,[],'t1');await settle(15);
 assert.equal(cancelled,1,'the request was aborted with the reader');
 f.stop();
});

test('the language is fixed per run, and the note carries the translations of the language it names',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});
 f.http.deepl=req=>req.method==='POST'?{status:200,response:{translations:req.body.text.map(x=>({text:req.body.target_lang+':'+x}))}}:null;
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(30);
 f.allPrefs.translateTarget='JA';f.allSettings.translateTarget='JA';
 const s=f.sessionOf();await settle();
 f.press(f.byText('Save as note'));await settle(10);
 assert.equal(f.notes.length,0,'nothing is translated into Japanese yet: no note with Korean under a (JA) title');
 f.allPrefs.translateTarget='KO';
 f.press(f.byText('Save as note'));await settle(10);
 assert.match(f.notes[0].html,/\(KO\)<\/h1>/);assert.match(f.notes[0].html,/KO:DNA polymerases/);assert.doesNotMatch(f.notes[0].html,/JA:/);
 void s;f.stop();
});

test('Stop in the chat cancels that question only; a summary running beside it finishes',async()=>{
 const f=fixture();await f.open();
 const finish={};
 f.aiReplies.push(options=>new Promise(r=>{finish.summary=()=>r({status:200,response:{choices:[{message:{content:'## Summary\nDone.'}}]}});options.cancellerReceiver(()=>{finish.summaryCancelled=true;});}));
 f.aiReplies.push(options=>new Promise(r=>{options.cancellerReceiver(()=>{finish.chatCancelled=true;r({status:0,response:null});});}));
 f.press(f.byText('Make summary'));await settle(10);
 f.panel().querySelector('.sc-ra-input').textContent='Anything?';f.press(f.byText('Send'));await settle(10);
 f.press(f.byText('Stop'));await settle(10);
 assert.equal(finish.chatCancelled,true);assert.notEqual(finish.summaryCancelled,true,'the summary was not touched');
 finish.summary();await settle(20);
 assert.match(f.panel().querySelector('.sc-ra-summary').textContent,/Done\./);
 f.stop();
});

test('a replaced PDF starts summary, chat and translations over; the same file keeps them',async()=>{
 const io=memoryIO();
 const f=fixture({io});await f.open();f.aiReplies.push('## Summary\nOld file.');f.press(f.byText('Make summary'));await settle(20);
 await new Promise(r=>setTimeout(r,900));f.stop();
 const same=fixture({io});await same.open();await settle(10);assert.match(same.panel().textContent,/Old file\./);same.stop();
 const stat=io.stat;io.stat=async p=>p==='/lib/ATT.pdf'?{size:2222,lastModified:9}:stat(p);
 const g=fixture({io});await g.open();await settle(10);
 assert.doesNotMatch(g.panel().textContent,/Old file\./,'a summary of the old file is not shown for the new one');
 g.stop();
});

test('the selection popup offers "여기서부터 듣기", which starts at the selected sentence',async()=>{
 const f=fixture();await f.sync();
 let node=null;f.service.selectionPopup({reader:f.reader,doc:f.doc,params:{annotation:{position:{pageIndex:2,rects:[[80,792-128,200,792-116]]}}},append:n=>{node=n;}});
 assert.ok(node);assert.equal(node.textContent,'Listen from here');assert.equal(node.getAttribute('data-opens'),'audio');
 node.dispatchEvent(new f.win.Event('click'));await settle(30);
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)[1],'Kinetics were measured at 72 degrees Celsius.');
 f.stop();
});

test('the probe writes nothing: no structure file, no remembered tab, no translation prepared, no summary by itself',async()=>{
 const f=fixture({structCache:false,settings:{aiSummaryOnOpen:true},runtimeState:{readerAssist:{tab:'translate'}}});
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>({view:[0,0,612,792],rotate:0,
  async getTextContent(){return {items:[{str:'We study polymerases. They are useful.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{}};},async getOperatorList(){return {};},commonObjs:{has:()=>true,get:()=>null}})}};
 const writes=[];const w=f.fileIO.writeUTF8;f.fileIO.writeUTF8=async(p,text)=>{writes.push(p);return w(p,text);};
 const probing=f.service.probe(f.reader);
 for(let i=0;i<3;i++){f.service.sync(f.win,[f.reader],'t1');await settle(5);}
 const out=await probing;
 assert.equal(out.extraction.fallback,false);assert.ok(out.extraction.rects>0);
 assert.deepEqual(writes.filter(p=>/struct/.test(p)),[],'no .struct written');
 assert.equal(f.runtime.cache.readerAssist.tab,'translate','the remembered tab is unchanged');
 assert.deepEqual(f.requests.filter(r=>r.body),[],'no summary started during the probe');
 f.stop();
});

test('a 429 from DeepL says "in a moment", not a daily quota; the AI translator shows its token cost first',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});f.http.deepl=req=>req.method==='POST'?{status:429,response:{}}:null;
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 const s=f.sessionOf();s.tr.service.translateAll=async()=>({provider:'deepl',done:0,total:3,stopped:'rate',error:Object.assign(new Error('DeepL에 요청이 잠시 몰렸습니다. 잠시 후 다시 시도하세요.'),{code:'rate',status:429,own:true})});
 f.press(f.byText('Translate all'));await settle(20);
 assert.match(f.panel().querySelector('.sc-ra-tr [role="status"]').textContent,/in a moment/);
 assert.doesNotMatch(f.panel().textContent,/daily|midnight/i);
 f.stop();
 const g=fixture();await g.open();g.press(g.panel().querySelector('[data-tab="translate"]'));await settle(15);
 assert.match(g.panel().textContent,/Tokens to and from the AI server: about [\d,]+/);
 g.stop();
});

test('an unreadable text layer says so and reads, summarises and chats from Zotero\'s full-text index',async()=>{
 const f=fixture({structCache:false});
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>({view:[0,0,612,792],rotate:0,async getTextContent(){return {items:[],styles:{}};},async getOperatorList(){return {};},commonObjs:{has:()=>true,get:()=>null}})}};
 const PTsaved=globalThis.StyleCustomPaperText;globalThis.StyleCustomPaperText={...PTsaved,structure:a=>({...PTsaved.structure(a),sections:[],stats:{unreadable:true}})};
 try{
  await f.open();f.press(f.byText('Read body only'));await settle(60);
  assert.match(f.panel().textContent,/text layer is broken/);
  assert.ok(f.synth.log.some(l=>l[0]==='speak'&&/Plain text/.test(l[1])),'read from the full-text index');
 }finally{globalThis.StyleCustomPaperText=PTsaved;f.stop();}
});

test('the cache keeps extracted text for at most N papers, least recently used first, keeps each paper\'s saved work, and drops papers whose item is gone',async()=>{
 const f=fixture();await f.sync();
 const io=f.fileIO;io.getChildren=async()=>[...io.files.keys()];
 const times={};io.stat=async p=>({size:10,lastModified:times[p]||1});
 const add=(name,t)=>{for(const k of ['struct','state']){const p=f.folder+name+'.'+k+'.json';io.files.set(p,'{}');times[p]=t;}};
 add('1-AAAAAAAA',5);add('1-BBBBBBBB',9);add('1-GONEGONE',7);
 f.Z.Items.getByLibraryAndKey=(lib,key)=>key==='GONEGONE'?false:{id:1};
 await f.service.pruneCache({maxPapers:2});
 const left=[...io.files.keys()].map(p=>p.replace(f.folder,''));
 assert.ok(!left.some(p=>p.startsWith('1-GONEGONE')),'deleted item');
 assert.ok(left.some(p=>p.startsWith('1-ATT')),'the open paper stays');
 assert.ok(left.some(p=>p.startsWith('1-BBBBBBBB')));assert.ok(!left.includes('1-AAAAAAAA.struct.json'),'the least recently used extraction goes');
 assert.ok(left.includes('1-AAAAAAAA.state.json'),'its summary, conversation, translations and listening position stay');
 await f.service.pruneCache({maxPapers:2,maxStates:1});
 assert.ok(![...io.files.keys()].includes(f.folder+'1-AAAAAAAA.state.json'),'saved work has its own (much larger) bound, least recently used first');
 assert.ok([...io.files.keys()].includes(f.folder+'1-BBBBBBBB.state.json'));
 f.stop();
});

test('after the reader reloads its viewer document, the listeners follow the new one',async()=>{
 const f=fixture();await f.open();
 const fresh=parseHTML('<html><body><div class="page" data-page-number="3"></div></body></html>').document;
 f.reader._internalReader._primaryView._iframeWindow.document=fresh;
 await f.sync();
 const page=fresh.querySelector('.page');page.getBoundingClientRect=()=>({left:0,top:0,width:612,height:792});
 const e=new fresh.defaultView.Event('dblclick',{bubbles:true});Object.assign(e,{clientX:100,clientY:122,altKey:true});page.dispatchEvent(e);await settle(30);
 assert.ok(f.synth.log.some(l=>l[0]==='speak'));
 f.stop();
});

test('the panel takes its own column: the PDF view ends where it begins, folds to a rail, resizes within 280 px and half the reader, and closing restores the view',async()=>{
 const f=fixture();
 Object.defineProperty(f.doc.documentElement,'clientWidth',{value:1200,configurable:true});
 const split=f.doc.querySelector('#split-view');split.style.setProperty('inset-inline-end','0px');
 let resized=0;const view=f.reader._internalReader._primaryView._iframeWindow;view.Event=f.win.Event;view.dispatchEvent=e=>{if(e.type==='resize')resized++;};
 const pv={currentScaleValue:'page-width',sets:0};view.PDFViewerApplication={pdfViewer:new Proxy(pv,{set(o,k,v){if(k==='currentScaleValue')o.sets++;o[k]=v;return true;}})};
 await f.open();await new Promise(r=>setTimeout(r,10));
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'372px');
 assert.ok(resized>=1&&pv.sets>=1,'pdf.js is told to fit the page width again');
 f.press(f.byText('Fold the panel'));await settle();
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'52px');assert.equal(f.panel().getAttribute('data-collapsed'),'true');
 assert.equal(f.runtime.cache.readerAssist.collapsed,true,'remembered');
 f.press(f.byText('Expand the panel'));await settle();
 const handle=f.panel().querySelector('.sc-ra-resizer');
 const key=k=>{const e=new f.win.Event('keydown');e.key=k;handle.dispatchEvent(e);};
 for(let i=0;i<40;i++)key('ArrowLeft');
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'600px','at most half the reader');
 for(let i=0;i<60;i++)key('ArrowRight');
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'280px','at least 280 px');
 assert.equal(f.runtime.cache.readerAssist.width,280);
 f.press(f.byText('Close panel'));await settle();
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'0px','the original value comes back');
 f.stop();
});

test('the remembered tab is drawn as soon as the panel opens, even if the toolbar button died', async()=>{
 const f=fixture({runtimeState:{readerAssist:{tab:'listen'}}});await f.sync();
 f.sessionOf().toolbarState={panel:{setAttribute(){throw new Error("can't access dead object");}}};
 f.press(f.container.querySelector('button[data-safe="view"]'));await settle();
 assert.equal(f.panel().querySelector('[data-tab="listen"]').getAttribute('aria-selected'),'true');
 assert.equal(f.panel().querySelector('[data-pane="listen"]').hidden,false);
 f.stop();
});

test('a re-render (zoom, rotation) that empties the page gets the highlight back, sized from the live viewport',async()=>{
 const f=fixture();
 const handlers={};const bus={on:(n,fn)=>{(handlers[n]||=[]).push(fn);},off:(n,fn)=>{handlers[n]=(handlers[n]||[]).filter(x=>x!==fn);}};
 let viewport={width:1224,height:1584,transform:[2,0,0,-2,0,1584]};
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={eventBus:bus,pdfViewer:{getPageView:()=>({viewport})}};
 await f.sync();
 f.press(f.container.querySelectorAll('button')[1]);await settle(20);f.synth.begin();await settle();
 const page=f.viewDoc.querySelector('.page[data-page-number="3"]');
 assert.equal(page.querySelectorAll('[data-sc-ra-hl]').length,1);
 for(const m of [...page.querySelectorAll('[data-sc-ra-hl]')])m.remove();          // PDFPageView.reset
 viewport={width:1584,height:1224,transform:[0,2,2,0,0,0]};                          // turned 90 degrees
 for(const fn of handlers.pagerendered||[])fn({pageNumber:3});
 const mark=page.querySelector('[data-sc-ra-hl]');assert.ok(mark,'the mark is back');
 const h=Number(/height:([\d.]+)%/.exec(mark.getAttribute('style'))[1]),w=Number(/width:([\d.]+)%/.exec(mark.getAttribute('style'))[1]);
 assert.ok(h>w,'a line on a turned page is tall and narrow');
 assert.equal(f.navs.length,0);
 f.stop();assert.equal((handlers.pagerendered||[]).length,0,'the listener goes with the panel');
});

/* ---- 0.59.24 runtime fixes ------------------------------------------------- */
/* Zotero 9.0.6 reader.js, copied: utilities isTextBox(), and the parts of FocusManager._handleKeyDown and
   KeyboardManager._handleKeyDown that act on a plain key. Both are window listeners in the CAPTURE phase,
   registered when the reader starts, so they run before any listener of ours on the panel. */
const isTextBox=node=>['INPUT'].includes(node.nodeName)&&node.type==='text'||node.getAttribute('contenteditable')==='true';
function nativeKeydown(event,{readAloudActive=false}={}){
 const did=[];const key=event.key===' '?'Space':event.key;const target=event.target;
 if(event.key==='Tab'){did.push('tabToGroup');event.preventDefault();}
 if(!((target.closest('.outline-view')||target.closest('input[type="range"]'))&&['ArrowLeft','ArrowRight'].includes(event.key))){
  if(['ArrowRight','ArrowDown'].includes(event.key)&&!target.closest('[contenteditable], input[type="text"], .preview-popup')){did.push('tabToItem');event.preventDefault();}
  else if(['ArrowLeft','ArrowUp'].includes(event.key)&&!target.closest('[contenteditable], input[type="text"], .preview-popup')){did.push('tabToItem(back)');event.preventDefault();}
 }
 if(!isTextBox(target)){
  if(key==='r'||key==='l'){did.push('startReadAloudAtPosition');event.preventDefault();}
  else if(readAloudActive&&!target.matches('button, select')){if(key==='Space'||key.startsWith('Arrow')){did.push('readAloud '+key);event.preventDefault();}}
 }
 return did;
}
/* Window capture first, then the event at its target (where the panel's own keydown listener sits). */
function typeKey(f,node,key,props={}){
 const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key,...props});
 Object.defineProperty(e,'target',{value:node,configurable:true});
 const native=nativeKeydown(e,props);
 node.dispatchEvent(e);
 return {native,prevented:e.defaultPrevented};
}
const inputOf=f=>f.panel().querySelector('.sc-ra-input');
const typeText=(f,text)=>{inputOf(f).textContent=text;};

test('typing in the chat box is typing: r, l, arrows and Space never reach Zotero\'s shortcuts (its real isTextBox and capture order)',async()=>{
 const f=fixture();await f.open();
 const input=inputOf(f);
 assert.equal(input.getAttribute('contenteditable'),'true');assert.ok(isTextBox(input),'Zotero counts it as a text box');
 for(const node of f.panel().querySelectorAll('textarea,input:not([type]),input[type="text"],input[type="search"],[contenteditable]'))assert.ok(isTextBox(node),node.outerHTML.slice(0,60));
 for(const key of ['r','l','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ']){
  const out=typeKey(f,input,key,{readAloudActive:true});
  assert.deepEqual(out.native,[],`"${key}" is left to the text box`);assert.equal(out.prevented,false);
 }
 typeText(f,'Why 95 C?');
 typeKey(f,input,'Enter');await settle(20);
 assert.equal(f.requests.filter(r=>r.body).length,1,'Enter still sends');
 assert.equal(input.textContent,'','and empties the box');
 f.stop();
});
test('pasting into the chat box inserts plain text only',async()=>{
 const f=fixture();await f.open();
 const input=inputOf(f);let inserted=null;f.doc.execCommand=(cmd,ui,value)=>{if(cmd==='insertText'){inserted=value;input.textContent+=value;return true;}return false;};
 const e=new f.win.Event('paste',{bubbles:true,cancelable:true});e.clipboardData={getData:type=>type==='text/plain'?'plain words':'<b>bold</b>'};
 input.dispatchEvent(e);
 assert.equal(e.defaultPrevented,true);assert.equal(inserted,'plain words');assert.equal(input.querySelector('b'),null);
 f.stop();
});
test('Tab moves through the panel with Zotero\'s FocusManager: visible groups carry data-tabstop, their items tabindex=-1',async()=>{
 const f=fixture();await f.open();
 const visible=n=>!n.closest('[hidden]');
 const check=(least=4)=>{
  const groups=[...f.panel().querySelectorAll('[data-tabstop]')];
  assert.ok(groups.length>=least,'several groups: '+groups.length);
  for(const g of groups){assert.ok(visible(g),'a hidden group is not a tab stop: '+g.className);
   assert.ok(g.hasAttribute('tabindex')||[...g.querySelectorAll('[tabindex="-1"]')].some(visible),'the group has something to focus: '+g.className);}
  for(const n of f.panel().querySelectorAll('[tabindex="-1"]'))assert.ok(visible(n),'no hidden item is reachable: '+n.className);
  return groups;
 };
 const ask=check();assert.ok(ask.some(g=>g.querySelector('.sc-ra-input')),'the composer is a group');
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 const tr=check();assert.ok(!tr.some(g=>g.querySelector('.sc-ra-input')),'the ask tab\'s groups leave with it');
 f.press(f.byText('Fold the panel'));await settle();
 const rail=check(1);assert.ok(rail.every(g=>g.closest('.sc-ra-rail')),'folded: only the rail');
 let node=null;f.service.selectionPopup({reader:f.reader,doc:f.doc,params:{annotation:{position:{pageIndex:2,rects:[[80,664,200,676]]}}},append:n=>{node=n;}});
 assert.equal(node.getAttribute('data-tabstop'),'1','the popup button is its own tab stop, like "Add to note"');
 f.stop();
});

test('Stop during the chat\'s text extraction: no AI request is sent afterwards',async()=>{
 const f=fixture();await f.sync();
 let release;const read=f.fileIO.readUTF8;f.fileIO.readUTF8=p=>/struct/.test(p)?new Promise(r=>{release=()=>r(read(p));}):read(p);
 f.press(f.container.querySelector('button[data-safe="view"]'));await settle(10);
 typeText(f,'Anything?');f.press(f.byText('Send'));await settle(5);
 assert.equal(f.byText('Stop').hidden,false,'Stop shows at once');
 f.press(f.byText('Stop'));await settle(5);
 release&&release();await settle(30);
 assert.deepEqual(f.requests.filter(r=>r.body),[],'nothing sent after Stop');
 assert.equal(inputOf(f).textContent,'Anything?','the question is put back');
 f.stop();
});
test('Stop during DeepL\'s usage lookup: the answer arrives, and no translation is sent',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});let answer;
 f.http.deepl=req=>req.method==='GET'?new Promise(r=>{answer=()=>r({status:200,response:{character_count:5,character_limit:500000}});}):null;
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(10);
 const trStop=()=>f.byText('Stop',f.panel().querySelector('.sc-ra-tr'));
 assert.equal(trStop().hidden,false,'Stop shows while the usage is asked');
 f.press(trStop());await settle(5);
 answer();await settle(30);
 assert.equal(f.requests.filter(r=>r.method==='POST'&&/deepl/.test(r.url)).length,0,'no POST after Stop');
 assert.equal(f.byText('Translate all').disabled,false,'the buttons come back');
 f.stop();
});
test('"다시 번역" is a job like the others: Stop shows while it runs and ends it',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('Translate all'));await settle(30);
 let cancelled=0;f.http.deepl=req=>req.method==='POST'?new Promise(r=>{req.options.cancellerReceiver(()=>{cancelled++;r({status:0,response:null});});}):null;
 const row=f.panel().querySelectorAll('.sc-ra-row-card')[1];
 f.press(row.querySelector('[data-opens="ai"]'));await settle(10);
 const trStop=()=>f.byText('Stop',f.panel().querySelector('.sc-ra-tr'));
 assert.equal(trStop().hidden,false);assert.equal(f.byText('Translate all').disabled,true,'one job at a time');
 f.press(trStop());await settle(15);
 assert.equal(cancelled,1);assert.equal(trStop().hidden,true);
 assert.match(f.panel().querySelectorAll('.sc-ra-row-card')[1].textContent,/KO:Libraries/,'the earlier translation stays');
 f.stop();
});

test('"다른 번역기로 이어서" sends only the unfinished paragraphs of this language, and every paragraph names its translator',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 f.press(f.byText('From this page'));await settle(30);           // Methods and Results by DeepL
 f.http.deepl=req=>req.method==='POST'?{status:456,response:{}}:null;
 f.press(f.byText('Translate all'));await settle(30);
 assert.equal(f.byText('Continue with another translator').hidden,false);
 f.aiReplies.push(options=>{const user=JSON.parse(options.body).messages[1].content;const content=user.trim().startsWith('[')?JSON.stringify(JSON.parse(user).map(p=>'AI:'+p.text)):'AI:'+user;return {status:200,response:{choices:[{message:{content}}]}};});
 f.press(f.byText('Continue with another translator'));await settle(30);
 const ai=f.requests.filter(r=>r.body&&r.body.messages);
 assert.equal(ai.length,1);
 const body=ai[0].body.messages[1].content;
 const sent=body.trim().startsWith('[')?JSON.parse(body).map(p=>p.text):[body];
 assert.deepEqual(sent,['DNA polymerases drive PCR. Thermal stability limits cycling speed.'],'only the paragraph DeepL had not done');
 const rows=[...f.panel().querySelectorAll('.sc-ra-row-card')];
 assert.deepEqual(rows.map(r=>r.getAttribute('data-provider')),['ai','deepl','deepl']);
 assert.match(f.panel().querySelector('.sc-ra-tr').textContent,/AI · paragraphs 1, DeepL Free · paragraphs 2–3/);
 f.press(f.byText('Save as note'));await settle(10);
 assert.match(f.notes[0].html,/AI · paragraphs 1, DeepL Free · paragraphs 2–3/);assert.match(f.notes[0].html,/<em>DeepL Free<\/em>/);
 f.stop();
});

test('a summary is filed under the model, server, language and prompt it was asked with, even if the model changes before it returns',async()=>{
 const f=fixture();await f.open();let finish;
 f.aiReplies.push(()=>new Promise(r=>{finish=()=>r({status:200,response:{choices:[{message:{content:'## Summary\nMade by m1.'}}]}});}));
 f.press(f.byText('Make summary'));await settle(10);
 f.allPrefs.aiModel='m2';
 finish();await settle(20);
 const entries=Object.entries(f.sessionOf().data.summary);
 assert.equal(entries.length,1);
 const [key,entry]=entries[0];
 assert.match(key,/^m1\|English\|/,'the key is m1, frozen at the start: '+key);assert.equal(entry.model,'m1');
 assert.ok(entry.endpoint&&entry.rev,'endpoint and prompt revision are in the record');
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(5);f.press(f.panel().querySelector('[data-tab="ask"]'));await settle(5);
 assert.doesNotMatch(f.panel().querySelector('.sc-ra-summary').textContent,/Made by m1/,'under m2 there is no current summary');
 f.allPrefs.aiModel='m1';f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(5);f.press(f.panel().querySelector('[data-tab="ask"]'));await settle(5);
 assert.match(f.panel().querySelector('.sc-ra-summary').textContent,/Made by m1/);
 f.stop();
});
test('a chat answer is written to the conversation it was asked in, with the model it was asked of',async()=>{
 const f=fixture();await f.open();let finish;
 f.aiReplies.push(()=>new Promise(r=>{finish=()=>r({status:200,response:{choices:[{message:{content:'Late answer.'}}]}});}));
 typeText(f,'Question?');f.press(f.byText('Send'));await settle(10);
 f.allPrefs.aiModel='m2';f.press(f.byText('Clear conversation'));await settle(5);
 finish();await settle(20);
 assert.equal(f.sessionOf().data.chat.length,0,'the cleared conversation does not get the old answer');
 typeText(f,'Again?');f.aiReplies.push('Fresh.');f.press(f.byText('Send'));await settle(20);
 const last=f.sessionOf().data.chat.at(-1);assert.equal(last.model,'m2');
 f.stop();
});
test('after a model change, an AI translation made with the old model is not shown as current',async()=>{
 const f=fixture();await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 f.aiReplies.push(options=>{const user=JSON.parse(options.body).messages[1].content;return {status:200,response:{choices:[{message:{content:JSON.stringify(JSON.parse(user).map(p=>'AI:'+p.text))}}]}};});
 f.press(f.byText('Translate all'));await settle(30);
 assert.equal(f.panel().querySelectorAll('.sc-ra-row-card[data-state="done"]').length,3);
 f.allPrefs.aiModel='m2';
 f.press(f.panel().querySelector('[data-tab="ask"]'));await settle(5);f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(10);
 assert.equal(f.panel().querySelectorAll('.sc-ra-row-card[data-state="done"]').length,0,'none is current under m2');
 assert.doesNotMatch(f.panel().querySelector('.sc-ra-rows').textContent,/AI:DNA/);
 f.stop();
});

test('a narrow reader with the sidebar open keeps 360 px for the PDF: the panel narrows, folds to the rail, and comes back when there is room',async()=>{
 const f=fixture();const html=f.doc.documentElement,split=f.doc.querySelector('#split-view');
 let width=900;Object.defineProperty(html,'clientWidth',{get:()=>width,configurable:true});
 split.getBoundingClientRect=()=>({left:240,right:width,top:41,bottom:800,width:width-240,height:759});
 await f.open();
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'300px','900 - 240 sidebar - 360 for the PDF');
 width=500;await f.sync();
 assert.equal(f.panel().getAttribute('data-collapsed'),'true','no room: the rail');assert.equal(split.style.getPropertyValue('inset-inline-end'),'52px');
 assert.notEqual(f.runtime.cache.readerAssist.collapsed,true,'not remembered as the user\'s choice');
 width=1400;await f.sync();
 assert.equal(f.panel().getAttribute('data-collapsed'),'false','room again: open as before');assert.equal(split.style.getPropertyValue('inset-inline-end'),'372px');
 f.stop();
});

test('Zotero\'s Read Aloud playing in another reader: the clash names it and stops that reader, not this one',async()=>{
 const f=fixture();await f.sync();
 const other=secondReader(f);f.Z.Reader._readers.push(other);f.service.sync(f.win,[f.reader,other],'t1');await settle(10);
 let stoppedA=0,stoppedB=0;
 f.reader._internalReader.toggleReadAloudPopup=open=>{if(open===false)stoppedA++;};
 other._internalReader._state.readAloudState={active:true,paused:false};
 other._internalReader.toggleReadAloudPopup=open=>{if(open===false){stoppedB++;other._internalReader._state.readAloudState={active:false,paused:false};}};
 await f.open();
 f.press(f.byText('Read body only'));await settle(20);
 const clash=f.panel().querySelector('.sc-ra-clash');assert.equal(clash.hidden,false);
 assert.match(clash.textContent,/Another read-aloud is playing\. Stop it and start\?/);
 f.press(f.byText('Stop and start'));await settle(20);
 assert.equal(stoppedB,1,'the reader that was playing');assert.equal(stoppedA,0,'not ours');
 assert.ok(f.synth.log.some(l=>l[0]==='speak'));
 f.stop();
});

test('Alt+double-click on a page the reader has turned 90° reads the sentence under the pointer; the split view\'s second pane works too',async()=>{
 const f=fixture();
 const live=ReaderAssist.viewportFor([0,0,612,792],90,{scale:1});
 const primary=f.reader._internalReader._primaryView._iframeWindow;
 primary.PDFViewerApplication={pdfViewer:{getPageView:()=>({viewport:live})}};
 await f.open();
 const page=f.viewDoc.querySelector('.page[data-page-number="3"]');
 page.getBoundingClientRect=()=>({left:0,top:0,width:live.width,height:live.height});
 // 'Kinetics were measured at 72 C.' is at [72,116,300,12] in the extraction's (unturned) page space.
 const [a,b,c,d,e,g]=live.transform,ux=100,uy=792-122;
 const at={x:a*ux+c*uy+e,y:b*ux+d*uy+g};
 const dbl=(doc,node,x,y)=>{const ev=new doc.defaultView.Event('dblclick',{bubbles:true});Object.assign(ev,{clientX:x,clientY:y,altKey:true});Object.defineProperty(ev,'target',{value:node});node.dispatchEvent(ev);};
 dbl(f.viewDoc,page,at.x,at.y);await settle(30);
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)?.[1],'Kinetics were measured at 72 degrees Celsius.');
 // the second pane of a split view
 const second=parseHTML('<html><body><div class="page" data-page-number="4"></div></body></html>');
 f.reader._internalReader._secondaryView={_iframeWindow:{document:second.document,PDFViewerApplication:{pdfViewer:{getPageView:()=>({viewport:ReaderAssist.viewportFor([0,0,612,792],0)})}}}};
 await f.sync();
 const p4=second.document.querySelector('.page');p4.getBoundingClientRect=()=>({left:0,top:0,width:612,height:792});
 f.synth.log.length=0;
 dbl(second.document,p4,100,106);await settle(30);
 assert.equal(f.synth.log.filter(l=>l[0]==='speak').at(-1)?.[1],'Variant M7 retained 80 percent activity after 30 minutes at 95 degrees Celsius.');
 f.stop();
});

test('stop() cancels the cache clean-up timer, and a timer that fires anyway does nothing',async()=>{
 const f=fixture();const timers=[];const cleared=[];
 const setT=f.win.setTimeout;f.win.setTimeout=(fn,ms)=>{if(ms===60000){timers.push(fn);return 'prune';}return setT(fn,ms);};
 const clearT=f.win.clearTimeout;f.win.clearTimeout=id=>{cleared.push(id);return clearT(id);};
 let listed=0;f.fileIO.getChildren=async()=>{listed++;return [];};
 await f.sync();assert.equal(timers.length,1);
 f.stop();
 assert.ok(cleared.includes('prune'),'the timer is cleared');
 timers[0]();await settle();assert.equal(listed,0,'and its callback does nothing after stop');
});
test('a drag on the panel edge ends when the pointer capture is lost or the window blurs',async()=>{
 const f=fixture();Object.defineProperty(f.doc.documentElement,'clientWidth',{value:1200,configurable:true});
 await f.open();
 const handle=f.panel().querySelector('.sc-ra-resizer'),split=f.doc.querySelector('#split-view');
 const fire=(node,type,props={})=>{const e=new f.win.Event(type,{bubbles:true});Object.assign(e,props);node.dispatchEvent(e);};
 fire(handle,'pointerdown',{button:0,clientX:800,pointerId:1});fire(handle,'pointermove',{clientX:780});
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'392px');
 fire(handle,'lostpointercapture',{pointerId:1});fire(handle,'pointermove',{clientX:700});
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'392px','no drag after the capture is gone');
 fire(handle,'pointerdown',{button:0,clientX:800,pointerId:2});fire(f.win,'blur');fire(handle,'pointermove',{clientX:700});
 assert.equal(split.style.getPropertyValue('inset-inline-end'),'392px','no drag after a blur');
 f.stop();
});

test('the probe and the live check never touch a cache file\'s time, and audio that was already playing is not blamed on the probe',async()=>{
 const f=fixture();const touched=[];f.fileIO.setModificationTime=async p=>{touched.push(p);};
 f.fileIO.files.set(f.folder+'1-ATT.state.json',JSON.stringify({v:1,summary:{},chat:[],tr:{}}));
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>({view:[0,0,612,792],rotate:0,
  async getTextContent(){return {items:[{str:'We study polymerases.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{}};},async getOperatorList(){return {};},commonObjs:{has:()=>true,get:()=>null}})}};
 const out=await f.service.probe(f.reader);await settle(10);
 assert.deepEqual(touched,[],'probe on a reader without a panel');
 f.stop();
 const g=fixture();const t2=[];g.fileIO.setModificationTime=async p=>{t2.push(p);};
 const handle=g.service.diagnose(g.reader,{fresh:false});await handle.ready();await settle(10);
 assert.deepEqual(t2,[],'the live check on the user\'s reader');handle.release();g.stop();
 // already playing before the probe
 const h=fixture();await h.sync();h.press(h.container.querySelectorAll('button')[1]);await settle(20);h.synth.begin();await settle();
 assert.equal(h.sessionOf().player.state().status,'playing');
 const again=await h.service.probe(h.reader);
 assert.doesNotMatch(again.problems.join(' '),/probe started audio/);
 h.stop();void out;
});

test('wording: skipped content, the figure chip, and the plain-text banner',async()=>{
 const f=fixture();await f.open();
 assert.match(f.panel().querySelector('.sc-ra-why summary').textContent,/^Skipped content$/);
 assert.ok([...f.panel().querySelectorAll('.sc-ra-chip')].some(b=>b.textContent.trim()==='Explain this figure'));
 assert.match(f.panel().querySelector('.sc-ra-banner').textContent,/Using the plain text Zotero extracted/);
 assert.doesNotMatch(fs.readFileSync(new URL('../src/reader-assist.js',import.meta.url),'utf8'),/이라 무료|무료\)|\(free\)|so free/,'a model on this Mac is not called free');
 f.stop();
});

/* ---- 0.59.24 live check: Xray wrappers and listener options ------------------------------------
   In Zotero, reader._internalReader is a waived content object, so the viewer document reached through it is
   content: a chrome options dictionary handed to its addEventListener cannot be read there (capture comes out
   false), while what a chrome await gets back from a content promise is an Xray that hides pdf.js's methods. */
function xray(real){return {wrappedJSObject:real};}         // methods and fields visible only once waived
function contentTarget(doc){
 // a content document: an options object from chrome reads as opaque, so only a boolean capture is honoured
 const reg=new Set();const key=(t,fn,c)=>t+'|'+c+'|'+(fn.__id||(fn.__id=Math.random()));
 const add=doc.addEventListener.bind(doc),remove=doc.removeEventListener.bind(doc);
 doc.addEventListener=(t,fn,o)=>{const c=o===true;reg.add(key(t,fn,c));add(t,fn,c);};
 doc.removeEventListener=(t,fn,o)=>{const c=o===true;reg.delete(key(t,fn,c));remove(t,fn,c);};
 return reg;
}
test('pdf.js reached through Xray wrappers: pages, text and fonts are read once waived, and copied into plain objects',async()=>{
 const f=fixture({structCache:false});
 const realPage={view:[0,0,612,792],rotate:0,
  getTextContent:async()=>xray({items:[{str:'We study polymerases. They are useful.',transform:[10,0,0,10,72,680],width:200,height:10,fontName:'f2'}],styles:{f2:{fontFamily:'serif'}}}),
  getOperatorList:async()=>({}),commonObjs:xray({has:()=>true,get:()=>xray({name:'Serif-Bold',bold:true})})};
 const page={wrappedJSObject:realPage};                       // no getTextContent until waived
 f.reader._internalReader._primaryView._iframeWindow.PDFViewerApplication={pdfDocument:{numPages:1,getPage:async()=>page}};
 const handle=f.service.diagnose(f.reader,{fresh:true});
 const got=await handle.readPages([1]);
 assert.equal(got.pages.length,1);assert.equal(got.fonts.named,1,'the font was named through commonObjs');
 const out=await f.service.probe(f.reader);
 assert.equal(out.extraction.fallback,false,out.extraction.error);assert.ok(out.extraction.sentences>0);
 handle.release();f.stop();
});
test('every listener on the reader and viewer documents is removed on destroy, also where a content document ignores a chrome options object',async()=>{
 const f=fixture();
 const view=contentTarget(f.viewDoc),readerDoc=contentTarget(f.doc);
 const second=parseHTML('<html><body></body></html>').document;const sreg=contentTarget(second);
 f.reader._internalReader._secondaryView={_iframeWindow:{document:second}};
 await f.open();
 assert.ok(view.size>=5&&readerDoc.size>=6&&sreg.size>=5,`${view.size}/${readerDoc.size}/${sreg.size} registered`);
 f.stop();
 assert.deepEqual([...view],[],'viewer document');assert.deepEqual([...readerDoc],[],'reader document');assert.deepEqual([...sreg],[],'second pane');
});

/* ---- round 1 (2026-10-06): everyday convenience ------------------------------------------------- */
const keyDown=(f,target,code,props={})=>{
 const win=target.ownerDocument&&target.ownerDocument.defaultView||f.win;
 const e=new (win.Event||f.win.Event)('keydown',{bubbles:true,cancelable:true});
 Object.assign(e,{code,key:props.key||'˚',altKey:true,shiftKey:true,ctrlKey:false,metaKey:false,repeat:false,isComposing:false,...props});
 target.dispatchEvent(e);return e;
};
const spoken=f=>f.synth.log.filter(l=>l[0]==='speak').map(l=>l[1]);

test('keys: Option+Shift+K plays and pauses from the PDF with the panel closed, J and L step a sentence once playing; nothing in a text box, and no key Zotero uses',async()=>{
 const f=fixture();await f.sync();
 const page=f.viewDoc.querySelector('.page[data-page-number="3"]');
 let e=keyDown(f,page,'KeyL');await settle(10);
 assert.deepEqual(spoken(f),[],'the sentence keys wait for the player');assert.equal(e.defaultPrevented,false);
 e=keyDown(f,page,'KeyK');await settle(20);
 assert.equal(e.defaultPrevented,true,'taken, so nothing else acts on it');
 assert.deepEqual(spoken(f),['Libraries were screened by compartmentalised self-replication.'],'from the page on screen, like the toolbar ▶');
 assert.equal(f.panel().hidden,true,'the panel stays closed');
 f.synth.begin();await settle();
 keyDown(f,page,'KeyL');await settle(10);assert.equal(spoken(f).at(-1),'Kinetics were measured at 72 degrees Celsius.');
 keyDown(f,page,'KeyJ');await settle(10);assert.equal(spoken(f).at(-1),'Libraries were screened by compartmentalised self-replication.');
 f.synth.begin();await settle();
 keyDown(f,f.doc.body,'KeyK');await settle(10);
 assert.equal(f.sessionOf().player.state().status,'paused','heard on the reader document too');
 // The question box is typing, whatever the modifiers.
 await f.open();const input=f.panel().querySelector('.sc-ra-input');
 e=keyDown(f,input,'KeyK');await settle(10);assert.equal(e.defaultPrevented,false);assert.equal(f.sessionOf().player.state().status,'paused');
 // Zotero's keys stay Zotero's: R/L, H, S, digits, Space and Alt+arrows, Cmd/Ctrl chords.
 const target={nodeName:'DIV',getAttribute:()=>null};
 const of=props=>ReaderAssist.shortcutOf({target,altKey:false,shiftKey:false,ctrlKey:false,metaKey:false,...props});
 for(const props of [{code:'KeyR',key:'r'},{code:'KeyL',key:'l'},{code:'Space',key:' '},{code:'KeyK',altKey:true},{code:'KeyK',shiftKey:true},{code:'ArrowLeft',altKey:true},{code:'ArrowRight',altKey:true,shiftKey:true},{code:'KeyK',altKey:true,shiftKey:true,metaKey:true},{code:'KeyK',altKey:true,shiftKey:true,ctrlKey:true},{code:'KeyK',altKey:true,shiftKey:true,isComposing:true},{code:'KeyK',altKey:true,shiftKey:true,repeat:true}])assert.equal(of(props),null,JSON.stringify(props));
 assert.equal(of({code:'KeyK',altKey:true,shiftKey:true}),'toggle');assert.equal(of({code:'KeyJ',altKey:true,shiftKey:true}),'prev');assert.equal(of({code:'KeyL',altKey:true,shiftKey:true}),'next');
 assert.equal(ReaderAssist.shortcutOf({code:'KeyK',altKey:true,shiftKey:true,target:{nodeName:'INPUT',getAttribute:()=>null}}),null);
 // Said where people look: the buttons' tooltips and the sentence list.
 assert.match(f.byText('Next sentence').title,/\(⌥⇧L\)$/);assert.equal(f.byText('Next sentence').getAttribute('aria-keyshortcuts'),'Alt+Shift+L','the ARIA form of the same key');
 f.press(f.panel().querySelector('[data-tab="listen"]'));await settle();
 assert.match(f.panel().querySelector('.sc-ra-listen .sc-ra-note').textContent,/Keys: ⌥⇧K play or pause, ⌥⇧J back a sentence, ⌥⇧L forward a sentence\./);
 f.stop();
 assert.equal(keyDown(f,page,'KeyK').defaultPrevented,false,'gone with the panel');
});

test('which account answered: the bridge\'s Claude or, when Claude could not, ChatGPT is named on the summary and on the answer',async()=>{
 const f=fixture();
 const real=f.runtime.assist;let provider='claude';
 f.runtime.assist={...real,available:()=>true,status:()=>({available:true,source:'bridge',provider,label:'x'})};
 await f.open();
 assert.match(f.panel().querySelector('.sc-ra-summary .sc-ra-note').textContent,/^Nothing is sent until you press it · Claude account \(this Mac\)\./);
 provider='codex';f.aiReplies.push('## Summary\nShort.');
 f.press(f.byText('Make summary'));await settle(20);
 const note=f.panel().querySelector('.sc-ra-summary .sc-ra-note').textContent;
 assert.match(note,/^ChatGPT account \(this Mac\) · /);assert.match(note,/Claude could not answer, so the ChatGPT account answered instead/);
 f.aiReplies.push('By ChatGPT.');f.panel().querySelector('.sc-ra-input').textContent='Who?';f.press(f.byText('Send'));await settle(20);
 assert.match(f.panel().querySelector('.sc-ra-msg-assistant .sc-ra-msg-by').textContent,/ChatGPT account answered instead/);
 provider='claude';f.aiReplies.push('By Claude.');f.panel().querySelector('.sc-ra-input').textContent='And now?';f.press(f.byText('Send'));await settle(20);
 const answers=f.panel().querySelectorAll('.sc-ra-msg-assistant');
 assert.equal(answers[1].querySelector('.sc-ra-msg-by'),null,'Claude answering is the ordinary case: nothing extra');
 assert.equal(f.sessionOf().data.chat[1].by,'codex','kept with the answer');
 f.stop();
});

test('long answers: an older one folds with "Show more", the newest stays open; an answer or the summary goes into a child note, escaped',async()=>{
 const f=fixture();await f.open();
 const long=n=>'## Point '+n+'\n- **'+n+'** <b>not markup</b>\n'+('word '.repeat(220));
 for(const n of [1,2]){f.aiReplies.push(long(n));f.panel().querySelector('.sc-ra-input').textContent='Question '+n;f.press(f.byText('Send'));await settle(20);}
 let answers=f.panel().querySelectorAll('.sc-ra-msg-assistant');
 assert.equal(answers[0].getAttribute('data-folded'),'true');assert.equal(answers[1].getAttribute('data-folded'),'false');
 const more=[...answers[0].querySelectorAll('button')].find(b=>b.textContent==='Show more');assert.ok(more);assert.equal(more.getAttribute('data-safe'),'view');
 f.press(more);await settle();
 assert.equal(answers[0].getAttribute('data-folded'),'false');assert.equal(more.textContent,'Show less');
 f.aiReplies.push('Short.');f.panel().querySelector('.sc-ra-input').textContent='Question 3';f.press(f.byText('Send'));await settle(20);
 answers=f.panel().querySelectorAll('.sc-ra-msg-assistant');
 assert.equal(answers[0].getAttribute('data-folded'),'false','unfolded by hand stays unfolded');assert.equal(answers[1].getAttribute('data-folded'),'true','the one that is no longer newest folds');
 assert.equal(answers[2].hasAttribute('data-folded'),false,'a short answer has nothing to fold');
 const save=answers[1].querySelector('[data-writes="note"]');assert.ok(save);assert.equal(save.getAttribute('aria-label'),'Save as a child note');
 f.press(save);await settle(10);
 assert.equal(f.notes.length,1);assert.equal(f.notes[0].id,10,'a child of the paper');
 const html=f.notes[0].html;
 assert.match(html,/^<div><h1>AI answer — Thermostable polymerase evolution<\/h1><p><strong>Q\.<\/strong> Question 2<\/p><h2>Point 2<\/h2><ul><li><strong>2<\/strong> &lt;b&gt;not markup&lt;\/b&gt;<\/li><\/ul>/);
 assert.match(html,/<p><em>m1 · \d{4}-\d\d-\d\d<\/em><\/p><\/div>$/,'the model it was asked of, and the date');
 f.aiReplies.push('## Summary\nIt works.');f.press(f.byText('Make summary'));await settle(20);
 f.press(f.panel().querySelector('.sc-ra-summary [data-writes="note"]'));await settle(10);
 assert.match(f.notes[1].html,/^<div><h1>AI summary — Thermostable polymerase evolution<\/h1><h2>Summary<\/h2><p>It works\.<\/p>/);
 assert.match(f.panel().querySelector('.sc-ra-status').textContent,/Saved as a child note/);
 f.stop();
});

test('the conversation keeps the reader\'s place: a new question comes to the top, a streaming answer does not drag the list to its end',async()=>{
 const f=fixture();await f.open();
 const list=f.panel().querySelector('.sc-ra-messages');
 Object.defineProperty(list,'scrollHeight',{get:()=>5000,configurable:true});
 Object.defineProperty(f.win.HTMLElement.prototype,'offsetTop',{get(){return Number(this.getAttribute&&this.getAttribute('data-index'))*100||0;},configurable:true});
 for(const n of [1,2]){f.aiReplies.push('Answer '+n);f.panel().querySelector('.sc-ra-input').textContent='Question '+n;f.press(f.byText('Send'));await settle(20);}
 let deltas=null;
 f.aiReplies.push(options=>new Promise(resolve=>{
  const listeners={};const xhr={readyState:3,responseText:'',getResponseHeader:()=> 'text/event-stream',addEventListener:(n,fn)=>(listeners[n]||=[]).push(fn)};
  options.requestObserver(xhr);
  deltas={push(text){xhr.responseText+='data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';for(const fn of listeners.progress||[])fn();},
   end(){xhr.responseText+='data: [DONE]\n\n';resolve({status:200,responseText:xhr.responseText,getResponseHeader:()=> 'text/event-stream'});}};
 }));
 f.panel().querySelector('.sc-ra-input').textContent='Question 3';f.press(f.byText('Send'));await settle(10);
 assert.equal(list.scrollTop,400,'the question just sent (message 5) is at the top');
 list.scrollTop=420;                       // reading the start of the answer
 deltas.push('The first part. ');await new Promise(r=>setTimeout(r,120));
 deltas.push('More and more. ');await new Promise(r=>setTimeout(r,120));
 deltas.end();await settle(20);
 assert.match(f.panel().querySelectorAll('.sc-ra-msg-assistant')[2].textContent,/The first part\. More and more\./);
 assert.equal(list.scrollTop,420,'left where the reader is');
 f.stop();
 delete f.win.HTMLElement.prototype.offsetTop;
});

test('Enter while an answer is still coming keeps the next question in the box',async()=>{
 const f=fixture();await f.open();
 let release;f.aiReplies.push(()=>new Promise(r=>{release=()=>r({status:200,response:{choices:[{message:{content:'First answer.'}}]}});}));
 const input=f.panel().querySelector('.sc-ra-input');
 input.textContent='First?';f.press(f.byText('Send'));await settle(10);
 input.textContent='A follow-up I typed meanwhile';
 const e=new f.win.Event('keydown',{bubbles:true,cancelable:true});Object.assign(e,{key:'Enter'});input.dispatchEvent(e);await settle(10);
 assert.equal(input.textContent,'A follow-up I typed meanwhile','not emptied and dropped');
 assert.match(f.panel().querySelector('.sc-ra-status').textContent,/once the answer has finished/);
 release();await settle(20);
 assert.equal(f.requests.filter(r=>r.body).length,1);
 f.stop();
});

test('"현재 페이지부터" on a page after the last body paragraph sends nothing and says why (it translated the whole paper)',async()=>{
 const f=fixture({prefs:{deeplApiKey:'abc:fx'}});await f.open();
 f.reader._internalReader._state.primaryViewStats.pageIndex=9;
 f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 assert.match(f.panel().querySelector('.sc-ra-tr').textContent,/Characters from this page: about 0 ·/);
 f.press(f.byText('From this page'));await settle(30);
 assert.equal(f.requests.filter(r=>/deepl/.test(r.url)&&r.method==='POST').length,0);
 assert.match(f.sessionOf().ui.trProgress.textContent,/no body text from this page on/i);
 f.stop();
});

test('the first ▶ says what it is doing: reading the text page by page, then getting ready; a second press meanwhile is the same press',async()=>{
 const f=fixture();await f.open();
 const s=f.sessionOf(),progress=f.panel().querySelector('.sc-ra-progress');
 s.extracting={i:3,n:12};s.onProgress();
 assert.equal(progress.textContent,'Reading the text… page 3/12');
 s.extracting=null;
 const listen=f.container.querySelectorAll('button')[1];
 f.press(listen);f.press(listen);await settle(20);
 assert.deepEqual(spoken(f),['Libraries were screened by compartmentalised self-replication.'],'one start');
 f.synth.begin();await settle();
 const meter=f.panel().querySelector('.sc-ra-meter');
 assert.equal(meter.hidden,false);assert.equal(meter.getAttribute('role'),'progressbar');assert.match(meter.getAttribute('aria-valuenow'),/^\d+$/);
 assert.equal(meter.querySelector('.sc-ra-meter-fill').style.width,meter.getAttribute('aria-valuenow')+'%');
 assert.equal(RA.remainingSeconds([{text:'one two three'},{text:'four five'}],0,1),Math.round(5/200*60));
 assert.equal(RA.remainingSeconds([{text:'one two three'},{text:'four five'}],1,2),Math.round(2/400*60));
 f.stop();
});

test('scrolling the sentence list stops it following for a while; pressing a sentence follows again',async()=>{
 const f=fixture();await f.open();
 const followed=[];f.win.HTMLElement.prototype.scrollIntoView=function(){if(this.classList&&this.classList.contains('sc-ra-sentence'))followed.push(this.textContent);};
 f.press(f.panel().querySelector('[data-tab="listen"]'));await settle();
 f.press(f.byText('Read body only'));await settle(20);f.synth.begin();await settle();
 assert.ok(followed.length>=1,'it follows');
 f.synth.finish();f.synth.begin();await settle();
 assert.equal(followed.at(-1),'Kinetics were measured at 72 C.');
 const before=followed.length;
 f.panel().querySelector('.sc-ra-body').dispatchEvent(new f.win.Event('wheel',{bubbles:true}));
 f.synth.finish();f.synth.begin();await settle();
 assert.equal(followed.length,before,'the reader is looking elsewhere in the list');
 f.press(f.panel().querySelectorAll('.sc-ra-sentence')[0]);await settle(20);f.synth.begin();await settle();
 assert.ok(followed.length>before,'a press on a sentence follows again');
 f.stop();delete f.win.HTMLElement.prototype.scrollIntoView;
});

test('"이어서 듣기" brings back the range that was being heard, so a caption position resumes at that caption',async()=>{
 const io=memoryIO();
 const f=fixture({io});await f.open();
 f.press(f.panel().querySelector('[data-filter="captions"]'));await settle();
 f.press(f.panel().querySelector('.sc-ra-play'));await settle(20);f.synth.begin();await settle();
 const units=f.sessionOf().player.units(),at=units.findIndex(u=>u.kind==='caption');assert.ok(at>0);const caption=units[at].text;
 f.press(f.panel().querySelector(`.sc-ra-sentence[data-index="${at}"]`));await settle(20);f.synth.begin();await settle();
 await new Promise(r=>setTimeout(r,900));f.stop();
 const g=fixture({io});await g.open();await settle(10);
 g.press(g.panel().querySelector('.sc-ra-more .sc-ra-link'));await settle(20);
 assert.equal(spoken(g).at(-1),caption);assert.equal(g.sessionOf().player.units()[g.sessionOf().player.state().index].kind,'caption');
 assert.equal(g.panel().querySelector('[data-filter="captions"]').getAttribute('aria-pressed'),'true');
 g.stop();
});

test('translating through the local bridge counts against the Mac\'s Claude/ChatGPT allowance, not a model bill',async()=>{
 const f=fixture();
 f.runtime.assist={...f.runtime.assist,available:()=>true,status:()=>({available:true,source:'bridge',provider:'claude',label:'x'})};
 f.allPrefs.aiEndpoint='';
 await f.open();f.press(f.panel().querySelector('[data-tab="translate"]'));await settle(15);
 const text=f.panel().querySelector('.sc-ra-tr').textContent;
 assert.doesNotMatch(text,/fees|charges|billed/i);
 assert.match(text,/Tokens through the AI bridge: about \d+ · from the allowance of Claude account \(this Mac\)/);
 f.stop();
});

/* ---- what the listener hears (round 3) ---- */
test('with headings on (the default), each section begins with its heading, said once as its own utterance',async()=>{
 const f=fixture({settings:{readAloudHeadings:true}});await f.sync();
 f.press(f.container.querySelectorAll('button')[1]);await settle(20);
 assert.deepEqual(f.synth.log.filter(l=>l[0]==='speak').map(l=>l[1]),['Methods.','Libraries were screened by compartmentalised self-replication.'],'the heading, then the sentence');
 f.synth.begin();await settle();
 assert.equal(f.sessionOf().player.state().index,f.sessionOf().player.units().findIndex(u=>/^Libraries/.test(u.text)),'the heading highlights its first sentence');
 f.stop();
});
const koreanPaper=()=>({title:'유전자 발현 연구',abstract:'We measured gene expression.',
 sections:[{heading:'Abstract',level:1,page:0,kind:'abstract',paragraphs:[para(0,'We measured gene expression in bacteria.','The abstract is in English.')]},
  {heading:'서론',level:1,page:1,kind:'body',paragraphs:[para(1,'본 연구에서는 유전자 발현과 단백질 수준을 측정하였다.','세포를 37 °C에서 배양하였다.','결과는 유의하였다.','다음 실험을 진행하였다.')]},
  {heading:'결과',level:1,page:2,kind:'body',paragraphs:[para(2,'단백질 수준이 두 배 증가하였다.','전사량도 함께 늘었다.','이 효과는 반복 실험에서도 같았다.')]}],
 captions:[],references:[],footnotes:[],skipped:{headers:[],footers:[],pageNumbers:[]},stats:{bodyChars:400,totalChars:500,pages:3,columns:1}});
test('a Korean paper with an English abstract is read with a Korean voice, which is remembered apart from the English one',async()=>{
 const f=fixture({structured:koreanPaper(),settings:{readAloudVoice:'v-en'}});await f.open();f.press(f.byText('Read body only'));await settle(20);
 const p=f.sessionOf().player;
 assert.equal(p.state().voiceURI,'v-ko','the body decides, not the opening English abstract');
 assert.match(f.synth.log.filter(l=>l[0]==='speak').map(l=>l[1]).join(' '),/[가-힣]/);
 const toggle=f.panel().querySelector('[aria-label="Choose a voice"]');f.press(toggle);await settle();
 const items=[...f.panel().querySelectorAll('.sc-ra-menu-item')];
 assert.ok(items.some(i=>/Yuna/.test(i.textContent))&&!items.some(i=>/Samantha/.test(i.textContent)),'Korean voices are offered');
 f.press(items.find(i=>/Yuna/.test(i.textContent)));await settle();
 assert.equal(f.allSettings.readAloudVoiceKo,'v-ko','saved for Korean papers');
 assert.equal(f.allSettings.readAloudVoice,'v-en','the English papers\' voice is left alone');
 f.stop();
});
test('choosing 자동 (Automatic) gives the player the ranked voice, not the system default',async()=>{
 const voices=[{voiceURI:'v-fred',name:'Fred',lang:'en-US',localService:true,default:true},{voiceURI:'v-aman',name:'Aman',lang:'en-IN',localService:true},{voiceURI:'v-sam',name:'Samantha',lang:'en-US',localService:true}];
 const f=fixture({voices});await f.open();f.press(f.byText('Read body only'));await settle(20);
 const p=f.sessionOf().player;assert.equal(p.state().voiceURI,'v-sam','the first ▶ picks Samantha');
 const toggle=()=>f.panel().querySelector('[aria-label="Choose a voice"]');
 f.press(toggle());await settle();f.press([...f.panel().querySelectorAll('.sc-ra-menu-item')].find(i=>/Aman/.test(i.textContent)));await settle();
 assert.equal(p.state().voiceURI,'v-aman');
 f.press(toggle());await settle();f.press([...f.panel().querySelectorAll('.sc-ra-menu-item')].find(i=>/Automatic/.test(i.textContent)));await settle();
 assert.equal(p.state().voiceURI,'v-sam','Automatic is the same choice as the first ▶');assert.equal(f.allSettings.readAloudVoice,'');
 f.stop();
});
