import test from 'node:test';
import assert from 'node:assert/strict';
import T from '../src/paper-translate.js';

const para=(id,text,extra={})=>({id,text,heading:'Methods',page:3,sectionIndex:0,rects:[],...extra});
function harness({prefs={deeplApiKey:'abc:fx',translateTarget:'KO'},replies=null,pdf=null,ai=null,usage=null}={}){
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
 const service=T.create({http,sleep:async ms=>sleeps.push(ms),now:()=>clock.d,pref:k=>prefs[k],cache,usageStore:{get:()=>usageValue,set:v=>{usageValue=v;}},pdfTranslate:()=>pdf,ai,uiKorean:true});
 return {service,calls,sleeps,store,prefs,clock,get usage(){return usageValue;},get saves(){return saves;}};
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
