import test from 'node:test';
import assert from 'node:assert/strict';
import T from '../src/paper-translate.js';

const para=(id,text,extra={})=>({id,text,heading:'Methods',page:3,sectionIndex:0,rects:[],...extra});
function harness({prefs={deeplApiKey:'abc:fx',translateTarget:'KO'},replies=null,pdf=null,ai=null,usage=null,t4z={},uiKorean=true}={}){
 let pdftUsage=null;
 const calls=[],sleeps=[];let usageValue=usage;
 const http=async(method,url,options)=>{
  calls.push({method,url,options,body:options.body?JSON.parse(options.body):null});
  if(replies){const r=typeof replies==='function'?replies(calls.at(-1),calls.length):replies.shift();if(r)return r;}
  if(method==='GET')return {status:200,json:{character_count:1234,character_limit:500000}};
  return {status:200,json:{translations:calls.at(-1).body.text.map(t=>({text:'KO:'+t}))}};
 };
 const store=new Map();let saves=0;
 const cache={get:k=>store.get(k),set:(k,v)=>store.set(k,v),save:async()=>{saves++;}};
 const clock={d:new Date('2026-10-15T00:00:00Z')};
 const service=T.create({http,sleep:async ms=>sleeps.push(ms),now:()=>clock.d,pref:k=>prefs[k],cache,usageStore:{get:()=>usageValue,set:v=>{usageValue=v;}},pdfTranslate:()=>pdf,pdfTranslatePref:k=>t4z[k],pdftUsageStore:{get:()=>pdftUsage,set:v=>{pdftUsage=v;}},ai,uiKorean});
 return {service,calls,sleeps,store,prefs,clock,t4z,get pdftUsage(){return pdftUsage;},get usage(){return usageValue;},get saves(){return saves;}};
}

test('nothing is sent when the translator is only created',()=>{
 const h=harness();assert.equal(h.calls.length,0);assert.equal(h.service.busy,false);
});

test('a key ending in :fx goes to the free endpoint, any other key to the paid one',()=>{
 assert.equal(T.deeplEndpoint('abc-123:fx'),'https://api-free.deepl.com/v2/translate');
 assert.equal(T.deeplEndpoint('abc-123'),'https://api.deepl.com/v2/translate');
 assert.equal(T.usageEndpoint('k:fx'),'https://api-free.deepl.com/v2/usage');
 assert.equal(T.isFreeKey(' k:fx '),true);assert.equal(T.isFreeKey('k'),false);
});

test('the request is JSON with the key only in the Authorization header and the documented options',()=>{
 const r=T.buildRequest('abc:fx',['One.','Two.'],{target:T.TARGETS[0]});
 assert.equal(r.url,'https://api-free.deepl.com/v2/translate');
 assert.equal(r.headers.Authorization,'DeepL-Auth-Key abc:fx');
 const body=JSON.parse(r.body);
 assert.deepEqual(body,{text:['One.','Two.'],target_lang:'KO',split_sentences:'nonewlines',preserve_formatting:true});
 assert.doesNotMatch(r.body,/abc/,'the key is not in the body');
 assert.equal(JSON.parse(T.buildRequest('k',['x'],{target:T.TARGETS[4],formality:'prefer_less'}).body).formality,'prefer_less');
 assert.equal(JSON.parse(T.buildRequest('k',['x'],{target:T.TARGETS[0],formality:'prefer_less'}).body).formality,undefined,'Korean has no formal register in DeepL: not sent');
 assert.equal(JSON.parse(T.buildRequest('k',['x'],{target:T.TARGETS[1],source:'DE'}).body).source_lang,'DE');
});

test('the target follows the setting, or the panel language when it says auto',()=>{
 assert.equal(T.targetOf('auto',true).code,'KO');assert.equal(T.targetOf('auto',false).code,'EN-US');
 assert.equal(T.targetOf('ja',true).code,'JA');assert.equal(T.targetOf('nonsense',false).code,'EN-US');
});

test('a paragraph over 3,000 characters is cut at sentence ends, and every piece is within the limit',()=>{
 const long=Array.from({length:120},(_,i)=>`Sentence ${i} is here to fill space nicely.`).join(' ');
 const parts=T.splitParagraph(long);
 assert.ok(parts.length>=2);assert.ok(parts.every(p=>p.length<=3000));assert.equal(parts.join(' '),long);
 assert.deepEqual(T.splitParagraph('Short.'),['Short.']);
});

test('batches hold at most 50 texts and 100 KB, in order, and nothing is lost',()=>{
 const parts=Array.from({length:120},(_,i)=>({text:'p'+i}));
 const batches=T.planBatches(parts);
 assert.deepEqual(batches.map(b=>b.length),[50,50,20]);assert.deepEqual(batches.flat().map(p=>p.text),parts.map(p=>p.text));
 const heavy=Array.from({length:10},(_,i)=>({text:'가'.repeat(12000)+i}));   // 36 KB each in UTF-8
 const sized=T.planBatches(heavy);
 assert.ok(sized.every(b=>b.reduce((n,p)=>n+T.bytes(p.text),0)<=T.MAX_BATCH_BYTES));assert.equal(sized.flat().length,10);
 assert.equal(sized.length,5,'two of 36 KB per request');
});

test('paragraphs come from the body sections in reading order with their section and page, not from the references',()=>{
 const structured={sections:[{heading:'Intro',page:1,paragraphs:[{sentences:[{text:'A.',page:1,rects:[[1,2,3,4]]},{text:'B.',page:1,rects:[[1,5,3,6]]}]}]},{heading:'References',kind:'back',page:9,paragraphs:[{sentences:[{text:'Smith.',page:9}]}]},{heading:'Results',page:4,paragraphs:[{sentences:[{text:'C.',page:4}]},{sentences:[]}]}]};
 const list=T.paragraphsOf(structured);
 assert.deepEqual(list.map(p=>[p.id,p.heading,p.page,p.text]),[['0.0','Intro',1,'A. B.'],['2.0','Results',4,'C.']]);
 assert.deepEqual(list[0].rects.length,2);
});

test('translateAll batches, caches each paragraph by provider, target and source text, and reports progress',async()=>{
 const h=harness();const seen=[],progress=[];
 const list=[para('a','First.'),para('b','Second.'),para('c','Third.')];
 const summary=await h.service.translateAll(list,{onParagraph:(p,t,info)=>seen.push([p.id,t,info.cached]),onProgress:p=>progress.push(p.done)});
 assert.equal(h.calls.length,1,'three paragraphs, one request');
 assert.deepEqual(h.calls[0].body.text,['First.','Second.','Third.']);
 assert.deepEqual(seen.map(s=>s.slice(0,2)),[['a','KO:First.'],['b','KO:Second.'],['c','KO:Third.']]);
 assert.equal(summary.done,3);assert.equal(summary.stopped,'');assert.ok(h.saves>=1,'the cache is saved after a batch');
 // the second run costs nothing
 const again=await h.service.translateAll(list);
 assert.equal(h.calls.length,1);assert.equal(again.cached,3);
 // a changed paragraph is translated again, the others are not
 await h.service.translateAll([para('a','First.'),para('b','Second, edited.')]);
 assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].body.text,['Second, edited.']);
});

test('the cache is per target language: another language asks again',async()=>{
 const h=harness();await h.service.translateAll([para('a','Hello.')]);
 h.prefs.translateTarget='JA';await h.service.translateAll([para('a','Hello.')]);
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.target_lang,'JA');
});

test('"다시 번역" bypasses the cache for one paragraph',async()=>{
 const h=harness();await h.service.translateOne(para('a','Hello.'));
 const hit=await h.service.translateOne(para('a','Hello.'));assert.equal(hit.cached,true);assert.equal(h.calls.length,1);
 const fresh=await h.service.translateOne(para('a','Hello.'),{force:true});assert.equal(fresh.cached,false);assert.equal(h.calls.length,2);
});

test('starting at a page: only paragraphs from the start index on are translated, and a limit stops early',async()=>{
 const h=harness();const list=Array.from({length:6},(_,i)=>para('p'+i,'Text '+i+'.'));
 await h.service.translateAll(list,{start:3});assert.deepEqual(h.calls[0].body.text,['Text 3.','Text 4.','Text 5.']);
 const h2=harness();await h2.service.translateAll(list,{start:0,limit:2});assert.equal(h2.calls[0].body.text.length,2);
});

test('a long paragraph is sent in pieces and put back together as one translation',async()=>{
 const h=harness();const long=Array.from({length:120},(_,i)=>`Sentence ${i} is here to fill space nicely.`).join(' ');
 const out=[];await h.service.translateAll([para('long',long)],{onParagraph:(p,t)=>out.push(t)});
 assert.equal(h.calls.flatMap(c=>c.body.text).length>=2,true);
 assert.equal(out.length,1);assert.ok(out[0].startsWith('KO:Sentence 0'));assert.ok(out[0].includes(' KO:'));
});

test('456 stops the run with "quota", keeps what was already translated, and says so in plain words',async()=>{
 const rows=Array.from({length:120},(_,i)=>para('p'+i,'Text '+i+'.'));
 const h=harness({replies:(call,n)=>n===1?null:{status:456,json:{message:'Quota exceeded'}}});
 const done=[];const summary=await h.service.translateAll(rows,{onParagraph:p=>done.push(p.id)});
 assert.equal(summary.stopped,'quota');assert.equal(done.length,50,'the first batch was kept');
 assert.match(summary.error.message,/한도/);assert.equal(h.calls.length,2,'no third attempt after the quota is gone');
 const second=await h.service.translateAll(rows);   // resume: the first 50 come from the cache
 assert.equal(second.cached,50);
});

test('429 waits and tries again, then succeeds; it does not give up at the first answer',async()=>{
 let n=0;const h=harness({replies:()=>{n++;return n<3?{status:429,json:{},retryAfter:0}:null;}});
 const summary=await h.service.translateAll([para('a','Hello.')]);
 assert.equal(summary.done,1);assert.equal(h.calls.length,3);assert.deepEqual(h.sleeps,[1000,2000],'backs off 1 s, then 2 s');
});

test('429 forever stops after the retries with "rate"',async()=>{
 const h=harness({replies:()=>({status:429,json:{}})});
 const summary=await h.service.translateAll([para('a','Hello.')]);
 assert.equal(summary.stopped,'rate');assert.equal(h.calls.length,4);
});

test('403 says the key is wrong and does not retry; a server error retries',async()=>{
 const h=harness({replies:()=>({status:403,json:{}})});
 const s=await h.service.translateAll([para('a','Hello.')]);
 assert.equal(s.stopped,'key');assert.match(s.error.message,/키/);assert.equal(h.calls.length,1);
 let n=0;const h2=harness({replies:()=>{n++;return n<2?{status:503,json:{}}:null;}});
 assert.equal((await h2.service.translateAll([para('a','Hello.')])).done,1);
});

test('a reply with the wrong number of translations is rejected, not stored',async()=>{
 const h=harness({replies:()=>({status:200,json:{translations:[]}})});
 const s=await h.service.translateAll([para('a','Hello.')]);
 assert.equal(s.stopped,'shape');assert.equal(h.store.size,0);
});

test('Cancel stops between batches',async()=>{
 const rows=Array.from({length:120},(_,i)=>para('p'+i,'Text '+i+'.'));
 const h=harness();let first=true;
 const summary=await h.service.translateAll(rows,{onProgress:()=>{if(first){first=false;return;}h.service.cancel();}});
 assert.equal(summary.stopped,'cancelled');assert.ok(h.calls.length<3);
 assert.equal(h.service.busy,false);
});

test('a second run while one is going is refused',async()=>{
 let release;const h=harness({replies:()=>new Promise(r=>{release=()=>r({status:200,json:{translations:[{text:'x'}]}});})});
 const first=h.service.translateAll([para('a','Hello.')]);
 await assert.rejects(h.service.translateAll([para('b','Other.')]),/이미/);
 await new Promise(r=>setImmediate(r));release();await first;
});

test('the free quota is counted per month: characters of fresh text only, cached paragraphs are free, a new month starts at zero',async()=>{
 const h=harness();
 await h.service.translateAll([para('a','x'.repeat(100)),para('b','y'.repeat(50))]);
 assert.equal(h.usage.chars,150);assert.equal(h.service.usage().remaining,500000-150);
 await h.service.translateAll([para('a','x'.repeat(100))]);assert.equal(h.usage.chars,150,'cache hit costs nothing');
 h.clock.d=new Date('2026-11-02T00:00:00Z');assert.equal(h.service.usage().chars,0);assert.equal(h.service.usage().month,'2026-11');
});

test('the estimate before starting counts only what is not cached and says whether it fits',async()=>{
 const h=harness();await h.service.translateAll([para('a','x'.repeat(100))]);
 const rows=[para('a','x'.repeat(100)),para('b','y'.repeat(2000))];
 const e=h.service.estimate(rows);
 assert.deepEqual([e.fresh,e.cached,e.chars,e.limit,e.fits],[1,1,2000,500000,true]);
 const tight=harness({usage:{month:'2026-10',chars:499000,limit:500000}});
 assert.equal(tight.service.estimate([para('z','z'.repeat(2000))]).fits,false);
});

test('"사용량 새로고침" reads DeepL\'s own count and limit',async()=>{
 const h=harness();const u=await h.service.refreshUsage();
 assert.equal(h.calls[0].method,'GET');assert.equal(h.calls[0].url,'https://api-free.deepl.com/v2/usage');
 assert.equal(h.calls[0].options.headers.Authorization,'DeepL-Auth-Key abc:fx');
 assert.deepEqual([u.chars,u.limit,u.fromServer],[1234,500000,true]);
 const none=harness({prefs:{}});await assert.rejects(none.service.refreshUsage(),/키/);
});

test('providers: DeepL when there is a key, then Translate for Zotero, then the AI endpoint; the next one is offered after a stop',()=>{
 const ai={available:()=>true,translate:async t=>t},pdf={translate:async t=>t};
 const all=harness({ai,pdf}).service;
 assert.deepEqual(all.providers(),['deepl','pdftranslate','ai']);
 assert.equal(all.pickProvider(),'deepl');assert.equal(all.nextProvider('deepl'),'pdftranslate');assert.equal(all.nextProvider('pdftranslate'),'ai');assert.equal(all.nextProvider('ai'),null);
 const noKey=harness({prefs:{},ai,pdf}).service;
 assert.deepEqual(noKey.providers(),['pdftranslate','ai']);assert.equal(noKey.pickProvider(),'pdftranslate');assert.equal(noKey.pickProvider('ai'),'ai');
 assert.equal(harness({prefs:{}}).service.pickProvider(),null);
});

test('without any provider a run says how to set one up and sends nothing',async()=>{
 const h=harness({prefs:{}});
 await assert.rejects(h.service.translateAll([para('a','Hi.')]),e=>e.code==='none'&&/DeepL/.test(e.message));
 assert.equal(h.calls.length,0);
});

test('the AI provider translates in batches through the plugin\'s assistant, and Translate for Zotero one text at a time; neither touches DeepL',async()=>{
 const asked=[];const ai={available:()=>true,translate:async(texts,o)=>{asked.push(['ai',texts.length,o.language]);return texts.map(t=>'AI:'+t);}};
 const h=harness({prefs:{translateTarget:'KO'},ai});
 const out=[];await h.service.translateAll([para('a','One.'),para('b','Two.')],{onParagraph:(p,t)=>out.push(t)});
 assert.deepEqual(asked,[['ai',2,'Korean']]);assert.deepEqual(out,['AI:One.','AI:Two.']);assert.equal(h.calls.length,0);assert.equal(h.usage,null,'no DeepL usage is counted');
 const pdfCalls=[];const pdf={translate:async(t,o)=>{pdfCalls.push([t,o.langto]);return {result:'PDF:'+t};}};
 const g=harness({prefs:{translateTarget:'JA'},pdf});
 await g.service.translateAll([para('a','One.'),para('b','Two.')]);
 assert.deepEqual(pdfCalls,[['One.','ja-JP'],['Two.','ja-JP']]);
});

test('the bilingual note pairs each original with its translation under its section heading, escaped, and counts them',()=>{
 const rows=[para('0.0','A <b>& B.',{heading:'Intro',page:1}),para('0.1','C.',{heading:'Intro',page:1}),para('1.0','D.',{heading:'Results',page:4}),para('1.1','Untranslated.',{heading:'Results',page:4})];
 const translations=new Map([['0.0','가 <b>& 나.'],['0.1','다.'],['1.0','라.']]);
 const {html,count}=T.noteHTML({title:'Paper <1>',target:'KO',provider:'DeepL Free',date:'2026-10-05',paragraphs:rows,translations});
 assert.equal(count,3);
 assert.match(html,/<h1>Paper &lt;1&gt; \(KO\)<\/h1>/);
 assert.equal((html.match(/<h2>/g)||[]).length,2);assert.match(html,/<h2>Intro \(p\. 1\)<\/h2>/);
 assert.match(html,/<p>A &lt;b&gt;&amp; B\.<\/p><blockquote><p>가 &lt;b&gt;&amp; 나\.<\/p><\/blockquote>/);
 assert.doesNotMatch(html,/Untranslated/);assert.doesNotMatch(html,/<b>/);
});

test('hash and cache keys differ by provider, target and text, and ignore whitespace noise',()=>{
 assert.notEqual(T.cacheKey('deepl','KO','a'),T.cacheKey('ai','KO','a'));
 assert.notEqual(T.cacheKey('deepl','KO','a'),T.cacheKey('deepl','JA','a'));
 assert.equal(T.cacheKey('deepl','KO','a  b\n'),T.cacheKey('deepl','KO','a b'));
 assert.notEqual(T.hash('abc'),T.hash('abd'));
});

test('DeepL error codes map to plain Korean messages',()=>{
 assert.equal(T.deeplError(456).code,'quota');assert.match(T.deeplError(456).message,/무료 한도/);
 assert.equal(T.deeplError(429).retry,true);assert.equal(T.deeplError(403).code,'key');assert.equal(T.deeplError(500).retry,true);
 assert.equal(T.deeplError(400,{message:'bad'}).code,'bad');
});

/* ---- cancelling, frozen settings, revisions, usage ------------------------- */
const tick=()=>new Promise(r=>setImmediate(r));
test('Stop during the first Translate for Zotero request ends the run there: no further paragraph is sent',async()=>{
 let release;const sent=[];
 const pdf={translate:(t)=>{sent.push(t);return new Promise(r=>{release=()=>r({result:'PDF:'+t});});}};
 const h=harness({prefs:{translateTarget:'KO'},pdf});
 const rows=Array.from({length:50},(_,i)=>para('p'+i,'Text '+i+'.'));
 const run=h.service.translateAll(rows);await tick();
 h.service.cancel();release();
 const summary=await run;
 assert.equal(summary.stopped,'cancelled');assert.equal(sent.length,1,'one request, not fifty');assert.equal(h.service.busy,false);
});

test('Stop at DeepL\'s first 429 ends the back-off sleep and makes no second POST',async()=>{
 const sleeps=[];let wake;
 const h=harness({replies:()=>({status:429,json:{}})});
 const service=T.create({http:async(m,u,o)=>{h.calls.push({method:m,url:u,options:o});return {status:429,json:{}};},sleep:ms=>{sleeps.push(ms);return new Promise(r=>{wake=r;});},now:()=>new Date('2026-10-15'),pref:k=>({deeplApiKey:'abc:fx',translateTarget:'KO'})[k],uiKorean:true});
 const run=service.translateAll([para('a','Hello.')]);await tick();await tick();
 assert.equal(h.calls.length,1);assert.equal(sleeps.length,1,'waiting before the retry');
 service.cancel();
 const summary=await run;
 assert.equal(summary.stopped,'cancelled');assert.equal(h.calls.length,1,'no retry after Stop');
 wake&&wake();
});

test('the cancel token reaches the request and the AI sub-calls',async()=>{
 const seen=[];let gotSignal=null;
 const service=T.create({http:async(m,u,o)=>{seen.push(o.signal);return new Promise(()=>{});},pref:k=>({deeplApiKey:'abc:fx'})[k],uiKorean:true});
 const run=service.translateAll([para('a','Hello.')]);await tick();
 assert.ok(seen[0]&&typeof seen[0].onCancel==='function','the HTTP call is handed the token');
 let cancelled=0;seen[0].onCancel(()=>cancelled++);service.cancel();assert.equal(cancelled,1,'which the transport turns into an abort');
 void run;
 const ai={available:()=>true,translate:async(texts,o)=>{gotSignal=o.signal;return new Promise(()=>{});}};
 const g=harness({prefs:{},ai});g.service.translateAll([para('a','Hello.')]);await tick();
 assert.ok(gotSignal&&typeof gotSignal.onCancel==='function');g.service.cancel();assert.equal(gotSignal.cancelled,true);
});

test('the target is fixed when a run starts: switching the language mid-run files nothing under the new one',async()=>{
 let release;const h=harness({replies:call=>new Promise(r=>{release=()=>r({status:200,json:{translations:call.body.text.map(t=>({text:call.body.target_lang+':'+t}))}});})});
 const run=h.service.translateAll([para('a','Hello.')]);await tick();
 h.prefs.translateTarget='JA';release();
 const summary=await run;
 assert.equal(summary.target,'KO');
 assert.equal(h.service.cached('deepl','Hello.','KO'),'KO:Hello.');
 assert.equal(h.service.cached('deepl','Hello.','JA'),undefined,'the Japanese cache is untouched');
 assert.equal(h.service.cached('deepl','Hello.'),undefined,'the current target (JA) has nothing yet');
});

test('a change of formality, or of the AI model or endpoint, is a new translation; the key never carries a secret',async()=>{
 const h=harness({prefs:{deeplApiKey:'abc:fx',translateTarget:'DE',translateFormality:'default'}});
 await h.service.translateAll([para('a','Hello.')]);
 h.prefs.translateFormality='prefer_more';await h.service.translateAll([para('a','Hello.')]);
 assert.equal(h.calls.length,2,'formal German is asked for again');
 assert.equal(h.calls[1].body.formality,'prefer_more');
 for(const key of h.store.keys())assert.doesNotMatch(key,/abc:fx/);
 const asked=[];const ai={available:()=>true,translate:async t=>{asked.push(t.length);return t.map(x=>'AI:'+x);}};
 const g=harness({prefs:{translateTarget:'KO',aiModel:'m1',aiEndpoint:'http://localhost:1/v1',aiKey:'sk-secret'},ai});
 await g.service.translateAll([para('a','Hello.')]);await g.service.translateAll([para('a','Hello.')]);
 assert.equal(asked.length,1,'same model: cached');
 g.prefs.aiModel='m2';await g.service.translateAll([para('a','Hello.')]);
 assert.equal(asked.length,2,'another model: asked again');
 for(const key of g.store.keys())assert.doesNotMatch(key,/sk-secret|localhost/);
 assert.notEqual(T.settingsRevision({provider:'deepl',target:'KO'}),T.settingsRevision({provider:'ai',target:'KO',model:'m'}));
});

test('a paid key\'s limit is not assumed to be 500,000: unknown until DeepL\'s own usage says',async()=>{
 const h=harness({prefs:{deeplApiKey:'pro-key',translateTarget:'KO'},replies:call=>call.method==='GET'?{status:200,json:{character_count:10,character_limit:2000000}}:null});
 assert.equal(h.service.usage().limit,null);assert.equal(h.service.estimate([para('a','x'.repeat(900000))]).fits,true,'unknown is not "does not fit"');
 const u=await h.service.refreshUsage();
 assert.equal(u.limit,2000000);assert.equal(u.remaining,2000000-10);
});

test('the AI estimate gives the tokens it will be billed for',()=>{
 const ai={available:()=>true,translate:async t=>t};
 const h=harness({prefs:{},ai});
 const e=h.service.estimate([para('a','x'.repeat(4000))],'ai');
 assert.equal(e.chars,4000);assert.equal(e.tokens,1000+1500);
});

test('DeepL 429 is "a moment", not a daily quota',()=>{
 const e=T.deeplError(429);
 assert.equal(e.code,'rate');assert.match(e.message,/잠시 후 다시/);assert.doesNotMatch(e.message,/하루|자정|일일/);
});

/* ---- 0.59.24: one job from the click, and the provider of every paragraph ---------- */
test('a job token cancelled before the run starts sends nothing; cancelled mid-run, it stops the run like Stop',async()=>{
 const h=harness();const job=T.token();job.cancel();
 const summary=await h.service.translateAll([para('a','Hello.')],{signal:job});
 assert.equal(summary.stopped,'cancelled');assert.equal(h.calls.length,0,'no POST after Stop');
 const job2=T.token();let release;
 const g=harness({replies:()=>new Promise(r=>{release=()=>r({status:200,json:{translations:[{text:'KO:x'}]}});})});
 const run=g.service.translateAll(Array.from({length:60},(_,i)=>para('p'+i,'Text '+i+'.')),{signal:job2});await tick();
 job2.cancel();release();
 assert.equal((await run).stopped,'cancelled');assert.equal(g.calls.length,1);
});
test('one paragraph again takes the job token too: Stop ends it and stores nothing',async()=>{
 let release;const h=harness({replies:()=>new Promise(r=>{release=()=>r({status:200,json:{translations:[{text:'KO:late'}]}});})});
 const job=T.token();
 const run=h.service.translateOne(para('a','Hello.'),{force:true,signal:job});await tick();
 job.cancel();release();
 await assert.rejects(run,e=>e.code==='cancelled');
 assert.equal(h.store.size,0,'a reply after Stop is not kept');
});
test('Translate for Zotero has no abort: Stop ends the wait at once, and the late reply is dropped',async()=>{
 const pdf={translate:()=>new Promise(()=>{})};          // never answers
 const h=harness({prefs:{translateTarget:'KO'},pdf});const job=T.token();
 const run=h.service.translateAll([para('a','One.'),para('b','Two.')],{signal:job});await tick();
 job.cancel();
 const summary=await Promise.race([run,new Promise(r=>setTimeout(()=>r('hung'),200))]);
 assert.notEqual(summary,'hung','the UI does not wait for the plugin');assert.equal(summary.stopped,'cancelled');
});
test('every finished paragraph is found with the provider that made it, and the ranges read "DeepL Free · 1–2, Translate for Zotero · 3"',async()=>{
 const pdf={translate:t=>Promise.resolve({result:'PDF:'+t})};
 const h=harness({pdf});
 const rows=[para('a','One.'),para('b','Two.'),para('c','Three.'),para('d','Four.')];
 await h.service.translateAll(rows.slice(0,2),{provider:'deepl'});
 await h.service.translateAll(rows.slice(2,3),{provider:'pdftranslate'});
 const found=h.service.resolved(rows);
 assert.deepEqual([...found].map(([id,v])=>[id,v.provider]),[['a','deepl'],['b','deepl'],['c','pdftranslate']]);
 assert.equal(found.get('c').text,'PDF:Three.');
 assert.deepEqual(T.providerSpans(rows,found),[{provider:'deepl',ranges:[[1,2]]},{provider:'pdftranslate',ranges:[[3,3]]}]);
 assert.deepEqual(T.unfinished(rows,found).map(p=>p.id),['d']);
});
test('a result made under other settings (another model) is not shown as current',async()=>{
 const prefs={translateTarget:'KO',aiModel:'m1',aiEndpoint:'https://x/v1'};
 const ai={available:()=>true,translate:async texts=>texts.map(t=>'AI:'+t)};
 const h=harness({prefs,ai});
 await h.service.translateAll([para('a','One.')]);
 assert.equal(h.service.resolved([para('a','One.')]).get('a').text,'AI:One.');
 prefs.aiModel='m2';
 assert.equal(h.service.resolved([para('a','One.')]).size,0,'the m1 translation is not the current one');
});
test('the note names the provider of each run of paragraphs',()=>{
 const rows=[para('a','One.'),para('b','Two.')];
 const translations=new Map([['a','KO:One.'],['b','KO:Two.']]);
 const made=T.noteHTML({title:'T',target:'KO',provider:'DeepL Free · 1, Translate for Zotero · 2',date:'2026-10-05',paragraphs:rows,translations,sources:new Map([['a','DeepL Free'],['b','Translate for Zotero']])});
 assert.match(made.html,/DeepL Free · 1, Translate for Zotero · 2/);
 assert.match(made.html,/KO:Two\.<\/p><p><em>Translate for Zotero<\/em><\/p>/);
});

/* ---- Translate for Zotero 2.4.8: api.translate(raw,{pluginID,langto,service}) resolves with its task object ---- */
// The shape read from the 2.4.8 XPI (src/api.ts): the task, with status 'success' or 'fail' and the error text in result.
const t4zTask=(raw,{status='success',result='',service='deeplfree',langto='ko-KR'}={})=>({id:'x',type:'custom',raw,result,audio:[],service,candidateServices:[],itemId:-1,status,extraTasks:[],silent:true,langto,callerID:'style-custom@sungjaeyoon.dev',processed:true});
test('Translate for Zotero: a task that failed is an error, never a translation, and nothing is cached',async()=>{
 const pdf={translate:async raw=>t4zTask(raw,{status:'fail',result:'번역 오류: DeepL Free\n\nRequest error: 403'})};
 const h=harness({prefs:{translateTarget:'KO'},pdf});
 const summary=await h.service.translateAll([para('a','One.')]);
 assert.equal(summary.done,0);assert.equal(summary.stopped,'pdft');assert.match(summary.error.detail,/403/);
 assert.equal(h.store.size,0,'the error text is not filed as the translation');
 await assert.rejects(h.service.translateOne(para('a','One.')),e=>e.code==='pdft');
});
test('Translate for Zotero: a successful task gives its result; a thrown string (an old version wanting pluginID) is a plain error',async()=>{
 const seen=[];
 const pdf={translate:async(raw,o)=>{seen.push(o);return t4zTask(raw,{result:'번역:'+raw});}};
 const h=harness({prefs:{translateTarget:'KO'},pdf,t4z:{translateSource:'deeplfree',targetLanguage:'ko-KR'}});
 const out=[];await h.service.translateAll([para('a','One.')],{onParagraph:(p,t)=>out.push(t)});
 assert.deepEqual(out,['번역:One.']);
 assert.deepEqual(seen[0],{langto:'ko-KR',pluginID:'style-custom@sungjaeyoon.dev',service:'deeplfree'},'its own configured service, fixed for the run');
 const bad=harness({prefs:{translateTarget:'KO'},pdf:{translate:async()=>{throw '[Translate for Zotero:api.translate] pluginID is required';}}});
 const s=await bad.service.translateAll([para('a','One.')]);assert.equal(s.stopped,'pdft');assert.equal(bad.store.size,0);
});
test('Translate for Zotero: its configured service names the translator and keys the cache',async()=>{
 const pdf={translate:async raw=>t4zTask(raw,{result:'K:'+raw})};
 const h=harness({prefs:{translateTarget:'KO'},pdf,t4z:{translateSource:'deeplfree'}});
 assert.equal(h.service.providerLabel('pdftranslate'),'Translate for Zotero (DeepL Free)');
 await h.service.translateAll([para('a','One.')]);
 assert.equal(h.service.resolved([para('a','One.')]).size,1);
 h.t4z.translateSource='googleapi';
 assert.equal(h.service.providerLabel('pdftranslate'),'Translate for Zotero (googleapi)');
 assert.equal(h.service.resolved([para('a','One.')]).size,0,'a Google translation is not the DeepL one');
});
test('auto target follows Translate for Zotero\'s target when it is installed, else the panel language',()=>{
 const pdf={translate:async raw=>t4zTask(raw)};
 assert.equal(harness({prefs:{translateTarget:'auto'},pdf,t4z:{targetLanguage:'ja-JP'}}).service.target().code,'JA');
 assert.equal(harness({prefs:{translateTarget:'auto'},pdf,t4z:{targetLanguage:'ko-KR'},uiKorean:false}).service.target().code,'KO','an English panel with a Korean Translate for Zotero target: Korean');
 assert.equal(harness({prefs:{translateTarget:'auto'},pdf,t4z:{targetLanguage:'zh-TW'}}).service.target().code,'KO','traditional Chinese is not offered: the panel language');
 assert.equal(harness({prefs:{translateTarget:'auto'},pdf:null,t4z:{targetLanguage:'ja-JP'}}).service.target().code,'KO','not installed: its leftover pref is ignored');
 assert.equal(harness({prefs:{translateTarget:'DE'},pdf,t4z:{targetLanguage:'ja-JP'}}).service.target().code,'DE','an explicit choice wins');
 assert.equal(harness({prefs:{translateTarget:'auto'},pdf,t4z:{targetLanguage:'ja-JP'}}).service.targetOrigin(),'pdftranslate');
 assert.equal(T.targetOf('auto',true,'en-GB').code,'EN-US');assert.equal(T.targetOf('auto',false,'').code,'EN-US');
});
test('Translate for Zotero: characters sent are counted per month, and its DeepL Free limit is named',async()=>{
 const pdf={translate:async raw=>t4zTask(raw,{result:'K'})};
 const h=harness({prefs:{translateTarget:'KO'},pdf,t4z:{translateSource:'deeplfree'}});
 await h.service.translateAll([para('a','Hello there.'),para('b','Again.')]);
 const u=h.service.pdftUsage();assert.equal(u.chars,'Hello there.'.length+'Again.'.length);assert.equal(u.limit,500000);assert.equal(u.month,'2026-10');
 h.clock.d=new Date('2026-11-02T00:00:00Z');assert.equal(h.service.pdftUsage().chars,0,'a new month starts at zero');
 h.t4z.translateSource='googleapi';assert.equal(h.service.pdftUsage().limit,null,'no known limit for another service');
});

/* ---- protected terms ---- */
test('protect masks genes, proteins, species and units, longest first, and restore puts them back',()=>{
 const text='TP53 and IL-6 in Escherichia coli and S. cerevisiae at 5 µM and 10 mg/mL; p53 binds NF-κB and mTORC1.';
 const m=T.protect(text);
 for(const term of ['TP53','IL-6','Escherichia coli','S. cerevisiae','5 µM','10 mg/mL','p53','NF-κB','mTORC1'])assert.ok(m.terms.includes(term),term);
 for(const term of m.terms)assert.ok(!m.text.includes(term),'masked: '+term);
 assert.doesNotMatch(m.text,/\bcoli\b/);
 const back=T.restore(m.text.replace(/ and /g,' 그리고 '),m.terms);
 assert.deepEqual(back.missing,[]);assert.match(back.text,/TP53 그리고 IL-6 in Escherichia coli/);
 assert.equal(T.protect('The results in Table 2 were clear. A. The cells').terms.length,0,'ordinary words, a list letter and a bare number are left alone');
 assert.deepEqual(T.protect('sonic hedgehog signalling',['sonic hedgehog']).terms,['sonic hedgehog'],'the reader\'s own terms');
 assert.deepEqual(T.protect('ERK1/2 phosphorylation in HeLa cells').terms,['ERK1/2','HeLa']);
});
test('a placeholder the translator dropped is reported missing, and lower-cased placeholders still come back',()=>{
 const m=T.protect('BRCA1 and BRCA2 differ.');
 const [a,b]=m.text.match(/ZQX\d+/g);
 assert.deepEqual(T.restore(a.toLowerCase()+' 다름',m.terms),{text:'BRCA1 다름',missing:['BRCA2']});
});
test('DeepL and Translate for Zotero get masked text and the terms come back; a paragraph that lost a term is sent again unmasked',async()=>{
 const sent=[];
 const pdf={translate:async raw=>{sent.push(raw);const dropped=/BRCA2/.test(raw)?'':raw;return t4zTask(raw,{result:/ZQX/.test(raw)&&/differ/.test(raw)?'다름':'번역 '+(dropped||raw)});}};
 const h=harness({prefs:{translateTarget:'KO'},pdf});
 const out=new Map();await h.service.translateAll([para('a','TP53 is mutated.'),para('b','BRCA1 and BRCA2 differ.')],{onParagraph:(p,t)=>out.set(p.id,t)});
 assert.match(sent[0],/^ZQX0 is mutated\.$/);assert.equal(out.get('a'),'번역 TP53 is mutated.');
 assert.equal(sent.length,3,'the paragraph that lost its terms went again, unmasked');assert.equal(sent[2],'BRCA1 and BRCA2 differ.');
 assert.equal(out.get('b'),'번역 BRCA1 and BRCA2 differ.');
 const d=harness();await d.service.translateAll([para('a','TP53 is mutated.')]);
 assert.equal(d.calls[0].body.text[0],'ZQX0 is mutated.');assert.equal(d.store.size,1);assert.equal([...d.store.values()][0],'KO:TP53 is mutated.');
});
test('the AI is not given placeholders (its prompt keeps the names); the reader\'s own term list is a new translation',async()=>{
 const asked=[];const ai={available:()=>true,translate:async texts=>{asked.push(...texts);return texts.map(t=>'AI:'+t);}};
 const prefs={translateTarget:'KO'};const h=harness({prefs,ai});
 await h.service.translateAll([para('a','TP53 is mutated.')]);assert.deepEqual(asked,['TP53 is mutated.']);
 const d=harness({prefs:{deeplApiKey:'abc:fx',translateTarget:'KO'}});await d.service.translateAll([para('a','Hedgehog binds.')]);
 assert.equal(d.service.resolved([para('a','Hedgehog binds.')]).size,1);
 d.prefs.translateProtect='Hedgehog';
 assert.equal(d.service.resolved([para('a','Hedgehog binds.')]).size,0,'another term list, another translation');
 await d.service.translateAll([para('a','Hedgehog binds.')]);assert.equal(d.calls.at(-1).body.text[0],'ZQX0 binds.');
});

/* ---- captions ---- */
test('captions are left out unless asked for; then each comes after the body paragraphs of its page, labelled',()=>{
 const structured={captions:[{kind:'figure',label:'Figure 1',text:'Figure 1. Cells.',page:1},{kind:'table',label:'Table 1',text:'Table 1. Data.',page:4}],sections:[{heading:'Intro',page:1,paragraphs:[{sentences:[{text:'A.',page:1}]}]},{heading:'Results',page:4,paragraphs:[{sentences:[{text:'C.',page:4}]},{sentences:[{text:'D.',page:5}]}]}]};
 assert.equal(T.paragraphsOf(structured).length,3);
 const list=T.paragraphsOf(structured,{captions:true});
 assert.deepEqual(list.map(p=>[p.id,p.page,p.text,!!p.caption]),[['0.0',1,'A.',false],['c0',1,'Figure 1. Cells.',true],['1.0',4,'C.',false],['c1',4,'Table 1. Data.',true],['1.1',5,'D.',false]]);
 assert.equal(list[1].heading,'Figure 1');
});

/* ---- Astra round 7 ---- */
test('Translate for Zotero: each paragraph is kept as soon as it is done, so Stop during the fourth keeps the first three',async()=>{
 let n=0;let release;
 const pdf={translate:raw=>{n++;if(n===4)return new Promise(r=>{release=r;});return Promise.resolve(t4zTask(raw,{result:'K:'+raw}));}};
 const h=harness({prefs:{translateTarget:'KO'},pdf});const job=T.token();const shown=[];
 const run=h.service.translateAll(['One.','Two.','Three.','Four.','Five.'].map((t,i)=>para(String(i),t)),{signal:job,onParagraph:p=>shown.push(p.id)});
 for(let i=0;i<20&&n<4;i++)await tick();
 assert.deepEqual(shown,['0','1','2'],'shown one by one');
 job.cancel();const summary=await run;
 assert.equal(summary.stopped,'cancelled');assert.equal(summary.done,3);assert.equal(h.store.size,3);
});
test('a paragraph that runs over a page break is found from either page; its anchor rectangles are those of its first page',()=>{
 const structured={sections:[{heading:'Intro',page:1,paragraphs:[{sentences:[{text:'A.',page:1,rects:[[1,700,3,10]]},{text:'B.',page:2,rects:[[1,70,3,10]]}]}]},{heading:'Next',page:2,paragraphs:[{sentences:[{text:'C.',page:2,rects:[[1,300,3,10]]}]}]}]};
 const [first,second]=T.paragraphsOf(structured);
 assert.deepEqual(first.pages,[1,2]);assert.deepEqual(first.rects,[[1,700,3,10]],'only page 1 rectangles: the jump lands where the paragraph starts');
 assert.deepEqual(second.pages,[2,2]);
 assert.equal(T.firstOnOrAfter([first,second],2),0,'on page 2 the paragraph that carries over is first');
 assert.deepEqual(T.onPage([first,second],2).map(p=>p.text),['A. B.','C.']);
 assert.deepEqual(T.onPage([first,second],1).map(p=>p.text),['A. B.']);
 assert.equal(T.firstOnOrAfter([first,second],3),-1);
});

/* Round 19. */
test('R19 AI translation: batches small enough that the AI client never splits them again, so a failure keeps the finished paragraphs',async()=>{
 const sent=[];let n=0;
 const ai={available:()=>true,translate:async(texts)=>{n++;if(n===3)throw Object.assign(new Error('down'),{code:'server'});sent.push(texts.reduce((a,t)=>a+t.length,0));return texts.map(t=>'AI:'+t);}};
 const h=harness({prefs:{translateTarget:'KO'},ai});
 const paras=Array.from({length:16},(_,i)=>({id:'p'+i,text:('Sentence number '+i+' about polymerase kinetics. ').repeat(40)}));
 const summary=await h.service.translateAll(paras,{provider:'ai'});
 assert.ok(sent.every(size=>size<=6000),'each request fits one AI call: '+sent.join(','));
 assert.equal(summary.stopped,'server');
 assert.ok(summary.done>0,'what came back before the failure is kept');
 assert.equal([...h.store.keys()].length,summary.done,'and cached');
});
test('R19 AI translation gets the user\'s protected terms, and a new list is a new translation',async()=>{
 const seen=[];
 const ai={available:()=>true,translate:async(texts,options)=>{seen.push(options.protect);return texts.map(t=>'AI:'+t);}};
 const h=harness({prefs:{translateTarget:'KO',translateProtect:'Notch, sonic hedgehog'},ai});
 await h.service.translateAll([{id:'a',text:'Notch signalling needs sonic hedgehog.'}],{provider:'ai'});
 assert.deepEqual(seen[0],['Notch','sonic hedgehog']);
 const before=[...h.store.keys()][0];
 h.prefs.translateProtect='Notch';
 await h.service.translateAll([{id:'a',text:'Notch signalling needs sonic hedgehog.'}],{provider:'ai'});
 assert.equal(seen.length,2,'not served from the old cache');
 assert.notEqual([...h.store.keys()][1],before);
});
test('R19 the automatic target follows the panel language as it is now, not as it was when the reader opened',()=>{
 let korean=true;
 const h=harness({prefs:{translateTarget:'auto'},uiKorean:()=>korean});
 assert.equal(h.service.target().code,'KO');
 korean=false;
 assert.notEqual(h.service.target().code,'KO','switching the panel to English switches the automatic target');
});
