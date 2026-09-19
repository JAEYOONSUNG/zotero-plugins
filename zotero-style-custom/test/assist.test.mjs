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
