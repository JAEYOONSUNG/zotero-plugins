import test from 'node:test';import assert from 'node:assert/strict';import A from '../src/assist.js';
function harness(values={}){const prefs={aiEndpoint:'https://example.org/v1/chat/completions',aiModel:'configured-model',aiKey:'secret',...values};const requests=[];let response={status:200,response:{choices:[{message:{content:'Result'}}]}};const api=A.create({runtime:{pref:k=>prefs[k]},Zotero:{HTTP:{request:async(method,url,options)=>{requests.push({method,url,options});return typeof response==='function'?response(options):response;}}}});return{api,requests,prefs,respond:value=>response=value};}
test('assistance requires explicit endpoint/model, sends selected text only and avoids model-specific unsupported fields',async()=>{const h=harness();assert.equal(await h.api.run('summary',{title:'Title',abstract:'Evidence'}),'Result');const r=h.requests[0];assert.equal(r.method,'POST');assert.equal(r.options.headers.Authorization,'Bearer secret');const body=JSON.parse(r.options.body);assert.equal(body.model,'configured-model');assert.equal(body.store,false);assert.equal(body.messages[1].content,'{"title":"Title","abstract":"Evidence"}');assert.equal(body.temperature,undefined);assert.equal(r.options.successCodes,false);assert.equal(h.requests.length,1);await assert.rejects(h.api.run('summary',{title:'Title'}),/초록/);});
test('unconfigured/unsafe endpoints produce no requests, localhost services are supported',async()=>{for(const endpoint of ['', 'http://remote.test/api','https://user:pass@remote.test/api','javascript:alert(1)']){const h=harness({aiEndpoint:endpoint});await assert.rejects(h.api.run('translate',{title:'A title'}));assert.equal(h.requests.length,0);}assert.equal(A.endpoint('http://127.0.0.1:1234/v1/chat/completions'),'http://127.0.0.1:1234/v1/chat/completions');});
test('tag responses must be bounded plain strings, malformed model data cannot become mutations',async()=>{const h=harness();h.respond({status:200,response:{choices:[{message:{content:'["CRISPR","CRISPR","Thermophiles"]'}}]}});assert.deepEqual(await h.api.run('tags',{title:'T',abstract:'A'}),['CRISPR','Thermophiles']);h.respond({status:200,response:{choices:[{message:{content:'[{"code":"bad"}]'}}]}});await assert.rejects(h.api.run('tags',{title:'T',abstract:'A'}),/태그/);});
test('cancellation discards late output and stop prevents future calls',async()=>{const h=harness();let finish,cancelled=0;h.respond(options=>new Promise(resolve=>{finish=resolve;options.cancellerReceiver(()=>cancelled++);}));const promise=h.api.run('translate',{title:'T'});h.api.cancel();finish({status:200,response:{choices:[{message:{content:'Late'}}]}});await assert.rejects(promise,/중지/);assert.equal(cancelled,1);h.api.stop();await assert.rejects(h.api.run('translate',{title:'T'}),/꺼져 있습니다/);});
test('HTTP failures and exceptions never echo credentials',async()=>{const h=harness();h.respond(()=>{throw Error('secret Authorization Bearer');});await assert.rejects(h.api.run('translate',{title:'T'}),e=>!e.message.includes('secret'));h.respond({status:401,response:{}});await assert.rejects(h.api.run('translate',{title:'T'}),/HTTP 401/);});
test('cancel settles immediately even when the HTTP transport never settles and canceller arrives late',async()=>{
 const h=harness();let deliver,cancelled=0;
 h.respond(options=>{deliver=()=>options.cancellerReceiver(()=>cancelled++);return new Promise(()=>{});});
 const running=h.api.run('translate',{title:'Pending'});h.api.cancel();
 const winner=await Promise.race([running.then(()=> 'resolved',e=>e.message),new Promise(resolve=>setTimeout(()=>resolve('timeout'),30))]);
 assert.notEqual(winner,'timeout');assert.match(winner,/중지/);deliver();assert.equal(cancelled,1);
 h.respond({status:200,response:{choices:[{message:{content:'Next'}}]}});assert.equal(await h.api.run('translate',{title:'Next'}),'Next');h.api.stop();
});

test('reading papers together sends two to six abstracts with their notes, and refuses less or more',async()=>{
 const h=harness();
 const paper=(n,over={})=>({id:String(n),title:'Paper '+n,year:'202'+n,venue:'J',abstract:'Abstract '+n,...over});
 await assert.rejects(h.api.run('compare',[paper(1)]),/둘 이상/);
 await assert.rejects(h.api.run('compare',Array.from({length:7},(_,i)=>paper(i))),/여섯/);
 await assert.rejects(h.api.run('compare',[paper(1),paper(2,{abstract:''})]),/초록이 없는/);
 assert.equal(await h.api.run('compare',[paper(1,{remark:'my note'}),paper(2)],{language:'English'}),'Result');
 const body=JSON.parse(h.requests[0].options.body);
 assert.match(body.messages[0].content,/Points of contention|contention/);
 assert.match(body.messages[0].content,/write in English/);
 const sent=JSON.parse(body.messages[1].content);
 assert.deepEqual(sent.map(p=>[p.n,p.title,p.abstract,p.notes]),[[1,'Paper 1','Abstract 1','my note'],[2,'Paper 2','Abstract 2',undefined]]);
 h.api.stop();
});

test('the reader can replace the outline for reading together; the language and the no-invention rule stay',async()=>{
 const h=harness({aiComparePrompt:'Compare methods only.'});
 const paper=(n)=>({id:String(n),title:'Paper '+n,abstract:'Abstract '+n});
 await h.api.run('compare',[paper(1),paper(2)],{language:'Korean'});
 const system=JSON.parse(h.requests[0].options.body).messages[0].content;
 assert.match(system,/^Compare methods only\./);
 assert.match(system,/Write in Korean/);assert.match(system,/do not invent/);
 h.api.stop();
});

test('an empty or overlong answer from the AI server is reported as such, not as a connection problem',async()=>{
 const h=harness();
 h.respond({status:200,response:{choices:[{message:{content:''}}]}});
 await assert.rejects(h.api.run('translate',{title:'T'}),/모델 이름/);
 h.respond({status:200,response:{choices:[{message:{content:'x'.repeat(100001)}}]}});
 await assert.rejects(h.api.run('translate',{title:'T'}),/너무 깁니다/);
});

/* ---- paper tasks: summary, chat (streamed or not), paragraph translation ---- */
import PC from '../src/paper-chat.js';
const summaryInput={title:'T',abstract:'Abstract text',text:'TITLE: T\nABSTRACT: Abstract text\nSECTIONS: A\n\nEXCERPTS:\n[A, p. 1] body'};
test('paperSummary sends the prepared text with the five-part prompt in the output language, to the configured endpoint only',async()=>{
 const h=harness();
 assert.equal(await h.api.run('paperSummary',summaryInput,{language:'English'}),'Result');
 const r=h.requests[0],body=JSON.parse(r.options.body);
 assert.equal(r.url,'https://example.org/v1/chat/completions');assert.equal(r.options.headers.Authorization,'Bearer secret');
 assert.match(body.messages[0].content,/Write in English/);assert.match(body.messages[0].content,/## Key findings/);
 assert.equal(body.messages[1].content,summaryInput.text);assert.equal(body.store,false);assert.equal(body.stream,undefined);
 await assert.rejects(h.api.run('paperSummary',{text:'x'}),/초록/);
 const off=harness({aiEndpoint:''});await assert.rejects(off.api.paperSummary(summaryInput),/서버 주소/);assert.equal(off.requests.length,0);
 const bad=harness({aiEndpoint:'http://remote.test/x'});await assert.rejects(bad.api.paperSummary(summaryInput));assert.equal(bad.requests.length,0);
});
test('chat asks for a stream, reads server-sent events as they arrive and returns the whole answer',async()=>{
 const h=harness();const seen=[];
 h.respond(options=>{
  const listeners={};const xhr={readyState:0,responseText:'',getResponseHeader:()=> 'text/event-stream',addEventListener:(n,f)=>(listeners[n]||=[]).push(f)};
  options.requestObserver(xhr);
  const feed=text=>{xhr.readyState=3;xhr.responseText+=text;for(const f of listeners.progress||[])f();};
  feed('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"con');
  feed('tent":"lo (Results, p. 4)"}}]}\n\ndata: [DONE]\n\n');
  return {status:200,responseText:xhr.responseText,getResponseHeader:()=> 'text/event-stream'};
 });
 const text=await h.api.chat([{role:'system',content:'S'},{role:'user',content:'Q'}],{onDelta:(piece,all)=>seen.push(all)});
 assert.equal(text,'Hello (Results, p. 4)');assert.deepEqual(seen,['Hel','Hello (Results, p. 4)']);
 assert.equal(JSON.parse(h.requests[0].options.body).stream,true);
});
test('a summary with onDelta streams: the first lines arrive before the whole, and the library block rides along',async()=>{
 const h=harness();const seen=[];
 h.respond(options=>{
  const listeners={};const xhr={readyState:0,responseText:'',getResponseHeader:()=> 'text/event-stream',addEventListener:(n,f)=>(listeners[n]||=[]).push(f)};
  options.requestObserver(xhr);
  const feed=text=>{xhr.readyState=3;xhr.responseText+=text;for(const f of listeners.progress||[])f();};
  feed('data: {"choices":[{"delta":{"content":"## Summary\\n"}}]}\n\n');
  feed('data: {"choices":[{"delta":{"content":"It works."}}]}\n\ndata: [DONE]\n\n');
  return {status:200,responseText:xhr.responseText,getResponseHeader:()=> 'text/event-stream'};
 });
 const text=await h.api.paperSummary({...summaryInput,library:'MY LIBRARY (x):\nTags on this paper: #rm'},{language:'English',onDelta:(piece,all)=>seen.push(all)});
 assert.equal(text,'## Summary\nIt works.');assert.deepEqual(seen,['## Summary\n','## Summary\nIt works.']);
 const body=JSON.parse(h.requests[0].options.body);assert.equal(body.stream,true);
 assert.match(body.messages[1].content,/\[A, p\. 1\] body\n\nMY LIBRARY \(x\):\nTags on this paper: #rm$/);
});
test('chat falls back to one JSON answer when the server does not stream',async()=>{
 const h=harness();const seen=[];
 h.respond(options=>{options.requestObserver({readyState:2,getResponseHeader:()=> 'application/json',addEventListener(){}});return {status:200,response:null,responseText:'{"choices":[{"message":{"content":"Whole"}}]}',getResponseHeader:()=> 'application/json'};});
 assert.equal(await h.api.chat([{role:'user',content:'Q'}],{onDelta:(p,a)=>seen.push(a)}),'Whole');assert.deepEqual(seen,['Whole']);
 assert.equal(h.requests[0].options.responseType,undefined,'streaming requests read text, not json');
});
test('chat can be cancelled mid-stream and never echoes the key on failure',async()=>{
 const h=harness();let cancelled=0;h.respond(options=>new Promise(()=>{options.cancellerReceiver(()=>cancelled++);}));
 const running=h.api.chat([{role:'user',content:'Q'}]);h.api.cancel();await assert.rejects(running,/중지/);assert.equal(cancelled,1);
 h.respond(()=>{throw Error('Bearer secret');});await assert.rejects(h.api.chat([{role:'user',content:'Q'}]),e=>!e.message.includes('secret'));
 await assert.rejects(h.api.chat([]),/질문/);
});
test('chat messages from paper-chat reach the endpoint unchanged and never carry the email or key',async()=>{
 const h=harness();const {messages}=PC.chatMessages({question:'Q?',chunks:[],language:'English'});
 await h.api.chat(messages,{stream:false});
 const sent=JSON.parse(h.requests[0].options.body);assert.deepEqual(sent.messages,messages);assert.doesNotMatch(h.requests[0].options.body,/secret/);
});
test('translateParagraphs sends a JSON batch and reads it back; a batch that does not parse is redone one paragraph at a time',async()=>{
 const h=harness();
 h.respond(options=>{const body=JSON.parse(options.body);const user=body.messages[1].content;return {status:200,response:{choices:[{message:{content:/^\[/.test(user)?JSON.stringify(JSON.parse(user).map(p=>'KO '+p.text)):'x'}}]}};});
 assert.deepEqual(await h.api.translateParagraphs(['One.','Two.'],{language:'Korean'}),['KO One.','KO Two.']);
 assert.match(JSON.parse(h.requests[0].options.body).messages[0].content,/JSON array of 2 strings/);
 const g=harness();let n=0;
 g.respond(options=>{n++;const user=JSON.parse(options.body).messages[1].content;return {status:200,response:{choices:[{message:{content:/^\[/.test(user)?'not json':'Single '+n}}]}};});
 assert.deepEqual(await g.api.translateParagraphs(['A.','B.']),['Single 2','Single 3']);
 assert.deepEqual(await g.api.translateParagraphs([]),[]);
});
test('R19 translateParagraphs names the reader\'s protected terms in both the batch and the single prompt',async()=>{
 const h=harness();
 h.respond(options=>{const user=JSON.parse(options.body).messages[1].content;return {status:200,response:{choices:[{message:{content:/^\[/.test(user)?JSON.stringify(JSON.parse(user).map(p=>'KO '+p.text)):'KO'}}]}};});
 await h.api.translateParagraphs(['Notch one.','Two.'],{language:'Korean',protect:['Notch','sonic hedgehog']});
 await h.api.translateParagraphs(['Only one.'],{language:'Korean',protect:['Notch']});
 assert.match(JSON.parse(h.requests[0].options.body).messages[0].content,/"Notch", "sonic hedgehog"/);
 assert.match(JSON.parse(h.requests[1].options.body).messages[0].content,/untranslated: "Notch"/);
});
test('available() says whether an endpoint and model are set, without calling anything',()=>{
 assert.equal(harness().api.available(),true);assert.equal(harness({aiModel:''}).api.available(),false);
});

test('a chat\'s own cancel token stops that request only; a summary beside it is untouched',async()=>{
 const h=harness();const cancelled=[];
 h.respond(options=>new Promise(resolve=>{const me=JSON.parse(options.body).messages[0].content.slice(0,10);options.cancellerReceiver(()=>{cancelled.push(me);});setTimeout(()=>resolve({status:200,response:{choices:[{message:{content:'ok'}}]},responseText:'{"choices":[{"message":{"content":"ok"}}]}',getResponseHeader:()=>'application/json'}),30);}));
 const T=(await import('../src/paper-translate.js')).default;
 const chatToken=T.token();
 const chat=h.api.chat([{role:'system',content:'chat-sys'},{role:'user',content:'q'}],{signal:chatToken});
 const summary=h.api.paperSummary({title:'T',abstract:'A',text:'body'});
 chatToken.cancel();
 await assert.rejects(chat,/중지/);
 assert.equal(await summary,'ok','the summary finishes');
 assert.equal(cancelled.length,1);
});

test('the limit is inactivity, not the total: a slow stream that keeps sending is not cut off, a silent server is',async()=>{
 const timers=[];const fake={set:(fn,ms)=>{const t={fn,ms,live:true};timers.push(t);return t;},clear:t=>{if(t)t.live=false;}};
 const prefs={aiEndpoint:'http://localhost:1234/v1/chat/completions',aiModel:'m'};
 let xhr;const api=A.create({timers:fake,runtime:{pref:k=>prefs[k]},Zotero:{HTTP:{request:async(m,u,options)=>{
  assert.equal(options.timeout,0,'no total timeout on the XHR');
  const ls={};xhr={readyState:3,responseText:'',getResponseHeader:()=>'text/event-stream',addEventListener:(n,f)=>(ls[n]||=[]).push(f)};options.requestObserver(xhr);
  for(let i=0;i<5;i++){xhr.responseText+=`data: {"choices":[{"delta":{"content":"w${i} "}}]}\n\n`;for(const f of ls.progress)f();}
  return new Promise(()=>{});}}}});
 const p=api.chat([{role:'user',content:'q'}]);
 await new Promise(r=>setImmediate(r));
 const live=timers.filter(t=>t.live);
 assert.equal(live.length,1,'one quiet timer, re-armed by every chunk');assert.ok(timers.length>=6);
 live[0].fn();
 await assert.rejects(p,/아무것도 보내지 않아/);
});

import fs from 'node:fs';
/* ---- the local AI bridge: found by itself when no address is set; an address in settings wins ---- */
const BRIDGE_TOKEN='T0ken_for_the_local_bridge_0123456789abcdef';
function bridgeHarness(values={},{file=JSON.stringify({port:47823,token:BRIDGE_TOKEN,version:'1.0.0',providers:['claude','codex']}),provider='claude'}={}){
 const prefs={aiEndpoint:'',aiModel:'',aiKey:'settings-key',...values};const requests=[];const logged=[];const reads=[];
 const home='/Users/tester';
 const paths={homeDir:home,join:(...parts)=>parts.join('/')};
 const io={exists:async p=>(reads.push(p),file!==null&&p===home+'/Library/Application Support/StyleCustomBridge/bridge.json'),readUTF8:async()=>file};
 let response=()=>({status:200,response:{choices:[{message:{content:'Bridge answer'}}]},getResponseHeader:name=>/x-bridge-provider/i.test(name)?provider:null});
 const Zotero={debug:(...a)=>logged.push(a.join(' ')),logError:e=>logged.push(String(e&&e.stack||e)),HTTP:{request:async(method,url,options)=>{requests.push({method,url,options});return response(options);}}};
 const api=A.create({Zotero,runtime:{pref:k=>prefs[k]},io,paths});
 return {api,requests,logged,reads,prefs,setProvider:p=>provider=p,respond:fn=>response=fn,setFile:f=>file=f};
}
test('with no address in settings, the bridge is found in Application Support and used with its own token, never the settings key',async()=>{
 const h=bridgeHarness();
 assert.equal(await h.api.run('summary',{title:'T',abstract:'A'}),'Bridge answer');
 const r=h.requests[0];
 assert.equal(r.url,'http://127.0.0.1:47823/v1/chat/completions');
 assert.equal(r.options.headers.Authorization,'Bearer '+BRIDGE_TOKEN);
 assert.doesNotMatch(JSON.stringify(r.options),/settings-key/);
 assert.equal(JSON.parse(r.options.body).model,'claude','no model in settings: the bridge default, Claude');
 assert.ok(h.reads.includes('/Users/tester/Library/Application Support/StyleCustomBridge/bridge.json'));
 assert.equal(h.api.available(),true);
 assert.deepEqual(h.api.status(),{available:true,source:'bridge',provider:'claude',label:'Claude 계정 (이 Mac)'});
 h.api.stop();
});
test('a model name meant for another server is not passed to the bridge; its own names are',async()=>{
 const h=bridgeHarness({aiModel:'gpt-4o-mini'});await h.api.run('translate',{title:'T'});
 assert.equal(JSON.parse(h.requests[0].options.body).model,'claude','gpt-4o-mini would have sent the paper to ChatGPT first');
 const g=bridgeHarness({aiModel:'ChatGPT'});await g.api.run('translate',{title:'T'});
 assert.equal(JSON.parse(g.requests[0].options.body).model,'chatgpt');
});
test('an address in settings always wins over an installed bridge',async()=>{
 const h=bridgeHarness({aiEndpoint:'https://example.org/v1/chat/completions',aiModel:'m'});
 await h.api.run('translate',{title:'T'});
 assert.equal(h.requests[0].url,'https://example.org/v1/chat/completions');
 assert.equal(h.requests[0].options.headers.Authorization,'Bearer settings-key');
 assert.doesNotMatch(JSON.stringify(h.requests[0].options),new RegExp(BRIDGE_TOKEN));
 assert.equal(h.api.status().source,'endpoint');assert.equal(h.api.status().label,'example.org');
});
test('no bridge.json, or a broken one, means no request and the usual setup message',async()=>{
 for(const file of [null,'not json','{"port":80,"token":"short"}',JSON.stringify({port:47823,token:'bad token with spaces and more than thirty two chars'})]){
  const h=bridgeHarness({},{file});
  await assert.rejects(h.api.run('translate',{title:'T'}),/서버 주소/);
  await assert.rejects(h.api.chat([{role:'user',content:'Q'}]),/bridge\/install\.sh/);
  assert.equal(h.requests.length,0);assert.equal(h.api.available(),false);assert.equal(h.api.status().source,'none');
 }
 assert.equal(A.bridgeConfig(JSON.stringify({port:47823,token:BRIDGE_TOKEN})).url,'http://127.0.0.1:47823/v1/chat/completions');
});
test('the provider label follows the x-bridge-provider header: ChatGPT when the bridge fell back, Claude again after',async()=>{
 const h=bridgeHarness({},{provider:'codex'});
 await h.api.run('translate',{title:'T'});
 assert.equal(h.api.status().label,'ChatGPT 계정 (이 Mac)');assert.equal(h.api.status().provider,'codex');
 h.setProvider('claude');await h.api.paperSummary({title:'T',abstract:'A',text:'body'});
 assert.equal(h.api.status().label,'Claude 계정 (이 Mac)');
 // A streamed answer: the header is read as soon as it arrives.
 h.respond(options=>{
  const ls={};const xhr={readyState:2,responseText:'',getResponseHeader:n=>/content-type/i.test(n)?'text/event-stream':/x-bridge-provider/i.test(n)?'codex':null,addEventListener:(n,f)=>(ls[n]||=[]).push(f)};
  options.requestObserver(xhr);for(const f of ls.readystatechange||[])f();
  assert.equal(h.api.status().label,'ChatGPT 계정 (이 Mac)','known before the answer ends');
  xhr.readyState=3;xhr.responseText='data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';for(const f of ls.progress||[])f();
  return {status:200,responseText:xhr.responseText,getResponseHeader:xhr.getResponseHeader};
 });
 h.setProvider('claude');
 assert.equal(await h.api.chat([{role:'user',content:'Q'}]),'Hi');
 h.api.stop();
});
test('bridge failures read as what to do on this Mac, and the token is never logged or echoed',async()=>{
 const h=bridgeHarness();
 h.respond(()=>({status:429,response:{error:{message:'Usage limit'}},getResponseHeader:()=>null}));
 await assert.rejects(h.api.run('translate',{title:'T'}),/사용 한도/);
 h.respond(()=>({status:502,response:{},getResponseHeader:()=>null}));
 await assert.rejects(h.api.chat([{role:'user',content:'Q'}],{stream:false}),/로그인/);
 h.respond(()=>({status:401,response:{},getResponseHeader:()=>null}));
 await assert.rejects(h.api.run('translate',{title:'T'}),/install\.sh/);
 h.respond(()=>{throw new Error('connect ECONNREFUSED Authorization: Bearer '+BRIDGE_TOKEN);});
 const errors=[];
 for(const call of [()=>h.api.run('translate',{title:'T'}),()=>h.api.chat([{role:'user',content:'Q'}]),()=>h.api.paperSummary({title:'T',abstract:'A',text:'b'})]){
  try{await call();assert.fail('should reject');}catch(e){errors.push(e.message);}
 }
 assert.ok(errors.every(m=>/응답하지 않습니다/.test(m)),errors.join(' | '));
 const seen=[...errors,...h.logged,JSON.stringify(h.api.status())].join('\n');
 assert.doesNotMatch(seen,new RegExp(BRIDGE_TOKEN));
 h.api.stop();
});
test('nothing in assist.js that logs touches the token',()=>{
 const src=fs.readFileSync(new URL('../src/assist.js',import.meta.url),'utf8');
 assert.doesNotMatch(src,/(?:debug|log|logError|console\.\w+)\([^)]*token/i,'nothing that logs touches the token');
});
