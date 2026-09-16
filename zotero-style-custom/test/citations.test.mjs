import test from 'node:test';
import assert from 'node:assert/strict';
import citations from '../src/citations.js';
const { lookupMany, identity, normalizeDOI } = citations;
function fixture(handler, extras = {}) {
  let time = Date.UTC(2026, 8, 13), pending = 0, maxPending = 0;
  const calls = [], sleeps = [], progress = [], persisted = [];
  const ctx = { now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; },
    onResult: async result => persisted.push(result), onProgress: value => progress.push(value), ...extras };
  const http = { getJSON: async (url, headers) => {
    pending++; maxPending = Math.max(maxPending, pending); calls.push({ url, headers, time });
    try { return await handler(url, headers, calls.length); } finally { pending--; }
  } };
  return { http, ctx, calls, sleeps, progress, persisted, maxPending: () => maxPending };
}
const failure = status => Object.assign(new Error('DO NOT LEAK https://secret.example/?api_key=private'), { status });
const oa = (doi, count, more = {}) => ({ doi: 'https://doi.org/' + doi, cited_by_count: count, ...more });
const cr = (doi, count, more = {}) => ({ DOI: doi, 'is-referenced-by-count': count, ...more });
const rec = (key, doi = `10.1234/${key}`) => ({ key, doi });
const titleRec = key => ({ key, title: 'A reliable assay for bacterial growth', year: 2024, firstAuthor: 'Smith' });
const titleWork = (doi, count, more = {}) => cr(doi, count, {
  title: ['A reliable assay for bacterial growth'], author: [{ family: 'Smith', given: 'Jane' }], issued: { 'date-parts': [[2024]] }, ...more });

test('DOI normalization is exact, URL encoding safe, and identity ignores input key but tracks metadata', () => {
  assert.equal(normalizeDOI(' HTTPS://doi.org/10.1234%2FAb.C '), '10.1234/ab.c');
  assert.equal(normalizeDOI('doi:10.1234/Ab.C'), '10.1234/ab.c');
  assert.equal(normalizeDOI('doi:10.1234/Ab.C.'), '10.1234/ab.c.');
  for (const input of ['no DOI', '', '10.123/no', '10.1234/a b', 'https://doi.org/10.1234/%ZZ', null]) assert.equal(normalizeDOI(input), null);
  assert.equal(identity(rec('one','doi:10.1234/A')), identity(rec('two','https://doi.org/10.1234/a')));
  assert.notEqual(identity(titleRec(1)), identity({...titleRec(1), year:2023}));
  assert.notEqual(identity(rec(1)), identity({...rec(1),pmid:'12'}));
});
test('batched DOI lookups deduplicate requests, preserve zero and original order, persist progressively', async () => {
  const events = [];
  const f = fixture(async () => { events.push('network'); return {results:[oa('10.1234/a',0),oa('10.1234/b',19)]}; },
    {onResult: async r => {events.push('save:'+r.key); await Promise.resolve();}});
  const results = await lookupMany([rec('a'),rec('b'),rec('other','DOI:10.1234/A')],f.http,f.ctx);
  assert.deepEqual(results.map(r=>[r.key,r.status,r.count,r.source]),[['a','ok',0,'OpenAlex'],['b','ok',19,'OpenAlex'],['other','ok',0,'OpenAlex']]);
  assert.equal(f.calls.length,1);
  const url=new URL(f.calls[0].url);
  assert.equal(url.searchParams.get('filter'),'doi:https://doi.org/10.1234/a|https://doi.org/10.1234/b');
  assert.equal(url.searchParams.get('per_page'),'100');
  assert.deepEqual(events,['network','save:a','save:other','save:b']);
  assert.equal(f.progress.at(-1).completed,3);
  assert.equal(results[0].checkedAt,'2026-09-13T00:00:00.000Z');
});
test('large batches remain at most100 identifiers and6KB filters with results before next request',async()=>{
  const events=[];
  const f=fixture(url=>{
    events.push('fetch');const ids=new URL(url).searchParams.get('filter').slice(4).split('|');
    assert.ok(ids.length<=100);assert.ok(url.length<6200);
    return {results:ids.map(id=>({doi:id,cited_by_count:1}))};
  },{onResult:r=>events.push(r.key)});
  const input=Array.from({length:205},(_,i)=>rec(String(i)));
  const out=await lookupMany(input,f.http,f.ctx);
  assert.equal(out.length,205);assert.ok(f.calls.length>=3);
  assert.ok(events.indexOf('0')<events.indexOf('fetch',1));
});
test('optional OpenAlex key goes only in Authorization; email goes to Crossref query',async()=>{
  const f=fixture((url,headers)=>{
    assert.ok(!url.includes('private-key'));
    if(url.includes('openalex')) {assert.deepEqual(headers,{Authorization:'Bearer private-key'});return {results:[]};}
    assert.equal(headers,undefined);assert.equal(new URL(url).searchParams.get('mailto'),'a+b@example.org');
    return {message:cr('10.1234/a',6)};
  },{openalexApiKey:'private-key',email:'a+b@example.org'});
  assert.equal((await lookupMany([rec('a')],f.http,f.ctx))[0].count,6);
});
test('OpenAlex mismatches cannot contaminate rows; Crossref exact DOI fallback shared by duplicate DOI',async()=>{
  const f=fixture(url=>url.includes('openalex')?{results:[oa('10.1234/wrong',999)]}:{message:cr('10.1234/a',3)});
  const out=await lookupMany([rec('a'),rec('another','10.1234/a')],f.http,f.ctx);
  assert.deepEqual(out.map(r=>r.count),[3,3]);assert.equal(f.calls.length,2);
});
test('Crossref returned DOI must match and explicit DOI never triggers title search',async()=>{
  const f=fixture(url=>url.includes('openalex')?{results:[]}:{message:cr('10.1234/wrong',200)});
  const [out]=await lookupMany([{...titleRec('a'),doi:'10.1234/a'}],f.http,f.ctx);
  assert.equal(out.status,'error');assert.match(out.reason,/identifier-mismatch/);
  assert.equal(out.count,undefined);assert.ok(!f.calls.some(c=>c.url.includes('query.bibliographic')));
});
test('unknown, malformed, negative and string counts are never manufactured as zero',async()=>{
  for(const count of [undefined,null,-1,1.5,'0',Infinity,Number.MAX_SAFE_INTEGER+1]){
    const f=fixture(url=>url.includes('openalex')?{results:[oa('10.1234/a',count)]}:{message:cr('10.1234/a',count)});
    const [out]=await lookupMany([rec('a')],f.http,f.ctx);
    assert.equal(out.status,'error');assert.equal(out.count,undefined);
  }
});
test('not-found requires primary absence and Crossref404; primary errors remain errors',async()=>{
  for(const primary of [null,401,503]){
    const f=fixture(url=>{if(url.includes('openalex')){if(primary)throw failure(primary);return {results:[]};}throw failure(404);});
    const [out]=await lookupMany([rec('a')],f.http,f.ctx);
    assert.equal(out.status,primary?'error':'not-found');assert.equal(out.count,undefined);
    assert.ok(!JSON.stringify(out).includes('private'));
  }
});
test('primary record with missing metric plus fallback404 is an error, not absence',async()=>{
  const f=fixture(url=>{if(url.includes('openalex'))return {results:[oa('10.1234/a',null)]};throw failure(404);});
  assert.equal((await lookupMany([rec('a')],f.http,f.ctx))[0].status,'error');
});
test('transient retry bounded at3 attempts, Retry-After capped, public singletons spaced and sequential',async()=>{
  let crossAttempts=0;
  const f=fixture(async url=>{
    await Promise.resolve();if(url.includes('openalex'))return {results:[]};
    if(++crossAttempts<=3)throw Object.assign(failure(429),{retryAfter:100000});
    return {message:cr(decodeURIComponent(new URL(url).pathname.slice(7)),2)};
  });
  const out=await lookupMany([rec('a'),rec('b')],f.http,f.ctx);
  assert.equal(out[0].status,'error');assert.equal(out[1].count,2);
  assert.equal(crossAttempts,4);assert.equal(f.maxPending(),1);assert.ok(f.sleeps.every(ms=>ms<=5000));
  const calls=f.calls.filter(c=>c.url.includes('crossref'));for(let i=1;i<calls.length;i++)assert.ok(calls[i].time-calls[i-1].time>=250);
});
test('auth rejection is not retried and disables further OpenAlex batches for that run',async()=>{
  const f=fixture(url=>{throw failure(url.includes('openalex')?403:404);});
  const input=Array.from({length:101},(_,i)=>rec(String(i)));
  const out=await lookupMany(input,f.http,f.ctx);
  assert.equal(f.calls.filter(c=>c.url.includes('openalex')).length,1);
  assert.ok(out.every(r=>r.status==='error'));
});
test('filter-syntax punctuation DOIs route safely to exact Crossref endpoint',async()=>{
  const doi='10.1234/a+b,c|d';
  const f=fixture(url=>{assert.ok(url.includes('crossref'));assert.equal(decodeURIComponent(new URL(url).pathname.slice(7)),doi);return {message:cr(doi,4)};});
  assert.equal((await lookupMany([rec('a',doi)],f.http,f.ctx))[0].count,4);
});
test('conflicting PMID cannot use DOI fallback to silently merge different records',async()=>{
  const f=fixture(url=>url.includes('openalex')?{results:[oa('10.1234/a',8,{ids:{pmid:'https://pubmed.ncbi.nlm.nih.gov/222/'}})]}:{message:cr('10.1234/a',4)});
  const [out]=await lookupMany([{...rec('a'),pmid:'111'}],f.http,f.ctx);
  assert.equal(out.status,'error');assert.match(out.reason,/conflicting-PMID/);
});
test('PMID-only matches verified response ID and does not fall through to title',async()=>{
  const f=fixture(url=>{assert.equal(new URL(url).searchParams.get('filter'),'pmid:123');return {results:[{ids:{pmid:'https://pubmed.ncbi.nlm.nih.gov/123/'},cited_by_count:0}]};});
  const [out]=await lookupMany([{key:'p',pmid:'PMID:123'}],f.http,f.ctx);
  assert.equal(out.status,'ok');assert.equal(out.count,0);
});
test('title fallback needs exact normalized title, year and first author and rejects ambiguous work IDs',async()=>{
  const cases=[
    [[titleWork('10.1234/a',7)],'ok'],
    [[titleWork('10.1234/a',7,{title:['A reliable assay for viral growth']})],'not-found'],
    [[titleWork('10.1234/a',7,{issued:{'date-parts':[[2023]]}})],'not-found'],
    [[titleWork('10.1234/a',7,{author:[{family:'Jones'}]})],'not-found'],
    [[titleWork('10.1234/a',7),titleWork('10.1234/b',8)],'not-found'],
    [[titleWork('10.1234/a',null)],'error']
  ];
  for(const [items,status]of cases){const f=fixture(()=>({message:{items}}));const[out]=await lookupMany([titleRec('t')],f.http,f.ctx);assert.equal(out.status,status);if(status==='ok')assert.equal(out.count,7);}
});
test('title queries respect stricter public and polite list rate limits',async()=>{
  for(const email of [undefined,'reader@example.org']){
    const f=fixture(()=>({message:{items:[]}}),{email});
    await lookupMany([titleRec('a'),titleRec('b'),titleRec('c')],f.http,f.ctx);
    for(let i=1;i<f.calls.length;i++)assert.ok(f.calls[i].time-f.calls[i-1].time>=(email?350:1100));
  }
});
test('insufficient metadata, malformed DOI and arXiv-only records explicitly unsupported without networking',async()=>{
  const f=fixture(()=>assert.fail('network forbidden'));
  const input=[{key:'empty'},{...titleRec('bad'),doi:'not a DOI'},{...titleRec('preprint'),arxiv:'2301.12345'}, {...titleRec('year'),year:null}, {...titleRec('author'),firstAuthor:''}];
  assert.ok((await lookupMany(input,f.http,f.ctx)).every(r=>r.status==='unsupported'));
});
test('abort before request, during request, and between progressive callbacks prevents further work',async()=>{
  for(const stage of ['before','network','callback']){
    const controller=new AbortController();
    const f=fixture(()=>{if(stage==='network')controller.abort();return {results:[oa('10.1234/a',1),oa('10.1234/b',2)]};},
      {signal:controller.signal,onResult:()=>{if(stage==='callback')controller.abort();}});
    if(stage==='before')controller.abort();
    await assert.rejects(lookupMany([rec('a'),rec('b')],f.http,f.ctx),{name:'AbortError'});
    assert.equal(f.calls.length,stage==='before'?0:1);
  }
});
test('abort during retry backoff exits immediately and callback persistence failure is propagated',async()=>{
  const controller=new AbortController();
  const f=fixture(()=>{throw failure(503);},{signal:controller.signal,sleep:async()=>controller.abort()});
  await assert.rejects(lookupMany([rec('a')],f.http,f.ctx),{name:'AbortError'});assert.equal(f.calls.length,1);
  const g=fixture(()=>({results:[oa('10.1234/a',3)]}),{onResult:()=>{throw new Error('disk full');}});
  await assert.rejects(lookupMany([rec('a')],g.http,g.ctx),/disk full/);
});
test('empty input is a no-op and modules expose only the specified stable surface',async()=>{
  const f=fixture(()=>assert.fail('no network'));assert.deepEqual(await lookupMany([],f.http,f.ctx),[]);
  assert.deepEqual(Object.keys(citations).sort(),['identity','lookupMany','normalizeDOI']);
});
test('resolver query and fragment are stripped before decoding; literal DOI punctuation is preserved',()=>{
 assert.equal(normalizeDOI('https://doi.org/10.1234/ABC?utm_source=test#section'),'10.1234/abc');
 assert.equal(normalizeDOI('https://dx.doi.org/10.1234/ABC#page=2'),'10.1234/abc');
 assert.equal(normalizeDOI('https://doi.org/10.1234/ABC%3Fpart%23suffix?tracking=true#page'),'10.1234/abc?part#suffix');
 assert.equal(normalizeDOI('10.1234/ABC?part#suffix'),'10.1234/abc?part#suffix');
 assert.equal(normalizeDOI('doi:10.1234/ABC?part#suffix'),'10.1234/abc?part#suffix');
});
test('malformed OpenAlex and Crossref response envelopes remain errors',async()=>{
 const f=fixture(url=>url.includes('openalex')?{message:'not a result list'}:{message:'not a work'});
 const[out]=await lookupMany([rec('a')],f.http,f.ctx);assert.equal(out.status,'error');assert.equal(out.count,undefined);
 const g=fixture(()=>({message:{items:null}}));assert.equal((await lookupMany([titleRec('a')],g.http,g.ctx))[0].status,'error');
});
test('conflicting nested DOI and ambiguous OpenAlex rows are not accepted as citation evidence',async()=>{
 for(const results of [[oa('10.1234/a',900,{ids:{doi:'10.1234/b'}})],[oa('10.1234/a',900),oa('10.1234/a',100)]]){
   const f=fixture(url=>url.includes('openalex')?{results}:{message:cr('10.1234/a',7)});
   const[out]=await lookupMany([rec('a')],f.http,f.ctx);assert.equal(out.source,'Crossref');assert.equal(out.count,7);
 }
});
