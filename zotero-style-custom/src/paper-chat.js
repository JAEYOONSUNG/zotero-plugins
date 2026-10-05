/* What the AI is shown of a paper, and how an answer is read back.

   Pure: no DOM, no network, no Zotero. Everything here takes the structured
   paper ({title, abstract, sections:[{heading, page, paragraphs:[{sentences}]}],
   captions, references}) and returns text, a ranking or segments.

   Efficient context, no embeddings: the paper is cut once into section-level
   chunks; a question picks the few chunks that share its words (BM25 over
   lightly stemmed tokens, character bigrams for Korean), plus the abstract and
   the section on screen. A summary reads the abstract, the first paragraph of
   every section and more of the conclusion and discussion, inside a budget. */
(function(root){
 'use strict';
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();
 const SUMMARY_BUDGET=24000;            // characters, about 6,000 tokens
 const CHUNK_TARGET=900,CHUNK_MIN=220,TOP_CHUNKS=6,HISTORY_TURNS=6,EXCERPT_CHARS=1400,FIGURE_BUDGET=7000;
 // Headings end with (?![\p{L}\p{N}]), the end of a word in any script: an ASCII \b after Hangul never matches,
 // so "방법" was read as body text.

 /* ---- tokens ----------------------------------------------------------- */
 const STOP=new Set('a an and are as at be been but by can could did do does for from had has have how if in into is it its may might more most no not of on or our so such than that the their then there these they this those to was we were what when where which while who why will with would you your also both each other some any all via per et al fig figure table'.split(' '));
 function stem(word){
  let w=word;
  if(w.length>5&&/ies$/.test(w))return w.slice(0,-3)+'y';
  /* One root for a word's forms: "lifetimes" and "lifetime", "measured" and "measurements" met as "lifetim" and
     "measur" (a final e is dropped after the suffix, "es" is a suffix only after s, x, z, ch, sh). */
  const fin=r=>r.length>4&&r.endsWith('e')?r.slice(0,-1):r;
  for(const suffix of ['ations','ation','ments','ment','ingly','ings','ing','edly','ed','ly','es','s']){
   if(!(w.length>suffix.length+3&&w.endsWith(suffix)))continue;
   if(suffix==='es'&&!/(?:[sxz]|ch|sh)es$/.test(w))continue;
   return fin(w.slice(0,-suffix.length));
  }
  return fin(w);
 }
 function tokenize(text){
  const out=[];
  for(const m of String(text||'').toLowerCase().matchAll(/[가-힣]+|[\p{L}\p{N}][\p{L}\p{N}-]*/gu)){
   const raw=m[0];
   if(/^[가-힣]+$/.test(raw)){if(raw.length===1)out.push(raw);for(let i=0;i<raw.length-1;i++)out.push(raw.slice(i,i+2));continue;}
   if(raw.length<2||STOP.has(raw))continue;
   out.push(stem(raw));
  }
  return out;
 }

 /* ---- bilingual research terms ------------------------------------------
    A Korean question about an English paper shares no words with it. The common
    research terms are added in English, so "방법" finds Methods and "한계" finds
    the limitation in the Discussion. */
 const TERMS=[
  [/방법|방식|절차|프로토콜/,'method methods materials procedure protocol approach'],[/실험/,'experiment experimental assay'],
  [/결과|성과/,'result results finding findings'],[/한계|제한|약점/,'limitation limitations limit caveat weakness'],
  [/결론/,'conclusion conclusions'],[/논의|고찰|토의/,'discussion'],[/서론|도입|배경/,'introduction background'],
  [/그림|도표|도식/,'figure fig'],[/(?<!\p{L})표(?!\p{L})|테이블/u,'table'],[/데이터|자료/,'data dataset'],[/통계|유의/,'statistical statistics significance'],
  [/샘플|표본|시료/,'sample samples'],[/대조군|대조/,'control controls'],[/가설/,'hypothesis'],[/모델|모형/,'model'],
  [/성능|정확도/,'performance accuracy'],[/오차|오류/,'error'],[/재현/,'reproducibility replicate'],[/기여|의의|시사/,'contribution implication significance'],
  [/향후|후속|미래/,'future'],[/주장|핵심/,'claim main conclusion'],[/분석/,'analysis'],[/측정/,'measurement measured'],[/균주|세포주/,'strain strains cell line'],
  [/서열|시퀀싱/,'sequencing sequence'],[/요약|초록/,'abstract summary'],
  // The quantities and objects a question about a paper names most often.
  [/해상도/,'resolution'],[/속도|빠르기/,'speed rate velocity'],[/농도/,'concentration'],[/온도/,'temperature'],[/크기|길이/,'size length'],
  [/효율/,'efficiency'],[/구조/,'structure structural'],[/활성/,'activity active'],[/결합/,'binding bind affinity'],[/발현/,'expression expressed'],
  [/돌연변이|변이/,'mutant mutation variant'],[/유전자/,'gene genes'],[/단백질/,'protein proteins'],[/효소/,'enzyme'],[/세포/,'cell cells'],
  [/감염/,'infection infected'],[/파지/,'phage phages'],[/세균|박테리아/,'bacteria bacterial'],[/억제|저해/,'inhibition inhibit inhibitor'],
  [/기전|메커니즘|작용/,'mechanism'],[/비교/,'compared comparison'],[/차이/,'difference'],[/증가/,'increase increased'],[/감소/,'decrease reduced'],
  [/시간/,'time'],[/비율|퍼센트|백분율/,'fraction percentage ratio'],[/몇|개수|수는/,'number'],[/분리/,'isolation isolate'],[/배양/,'culture cultured'],
  [/정제/,'purification purified'],[/시뮬레이션/,'simulation'],[/환자/,'patients'],[/생존/,'survival'],[/독성/,'toxicity'],[/복합체/,'complex'],
  [/수율/,'yield'],[/만들|구축|제작|제조|클로닝/,'construct construction constructed generated cloning plasmid'],[/민감도|특이도/,'sensitivity specificity'],[/검증/,'validation validated'],[/저항|내성/,'resistance resistant'],[/방어/,'defense defence immunity']
 ];
 const expandQuery=text=>{const s=String(text||'');const extra=TERMS.filter(([re])=>re.test(s)).map(([,en])=>en);return extra.length?s+' '+extra.join(' '):s;};

 /* ---- the part of the paper a section belongs to ----------------------- */
 const PART_HEAD=[
  ['methods',/^(?:(?:materials?|patients?|subjects?)\s+and\s+methods?|methods?(?:\s+(?:summary|details))?|online methods|experimental(?:\s+(?:procedures?|section|methods?|design))?|methodology|star\s*methods|방법|재료 및 방법|실험 방법|연구 방법)(?![\p{L}\p{N}])/iu],
  ['results',/^(?:results?(?:\s+and\s+discussion)?|findings|결과)(?![\p{L}\p{N}])/iu],
  ['discussion',/^(?:discussion|conclusions?|concluding remarks|summary and (?:outlook|conclusions?)|outlook|limitations?|perspectives?|논의|고찰|결론|토의)(?![\p{L}\p{N}])/iu],
  ['intro',/^(?:introduction|background|서론|배경|도입)(?![\p{L}\p{N}])/iu]
 ];
 /* Everything after these is the journal's own back matter (Nature's reporting summary, licences). */
 const BACK_HEAD=/^(?:acknowledge?ments?|references|bibliography|literature cited|funding|author contributions?|author information|competing interests?|conflicts? of interest|declarations?|data availability|code availability|data and code availability|online content|reporting summary|peer review(?: information)?|additional information|open access|ethics(?: declarations?)?|supplementary information|extended data|change history|rights and permissions|publisher.?s note|참고문헌|감사의 글|사사)(?![\p{L}\p{N}])/iu;
 const isBackSection=s=>!!s&&(s.kind==='back'||s.kind==='references'||s.level==='back'||s.back===true||s.part==='back');
 function partsOf(structured){
  const sections=(structured&&structured.sections)||[];const out=[];let current=null,afterReporting=false;
  sections.forEach((s,i)=>{
   const heading=clean(s.heading).replace(/^(?:\d+(?:\.\d+)*|[IVX]+|[가-힣])[.)]?\s+/u,'');
   if(/^reporting summary\b/i.test(heading))afterReporting=true;
   if(afterReporting||isBackSection(s)||BACK_HEAD.test(heading)){out.push('back');if(!afterReporting&&current&&current.level!==undefined)current=null;return;}
   // The extraction module's own part, where it is specific ("methods", "back"); "main" says only that it is body text.
   if(s.part==='methods'||s.part==='back'){out.push(s.part);current={part:s.part,level:Number(s.level)||1};return;}
   if(s.kind==='abstract'){out.push('abstract');current=null;return;}
   const hit=PART_HEAD.find(([,re])=>re.test(heading));
   const level=Number(s.level)||1;
   if(hit){out.push(hit[0]);current={part:hit[0],level,empty:!(s.paragraphs||[]).length};return;}
   // A subsection inherits its parent's part: deeper level, or the same level under an empty "Methods" header (Nature's layout).
   if(current&&(level>current.level||current.empty&&level===current.level)){out.push(current.part);return;}
   current=null;out.push('body');
  });
  return out;
 }

 /* ---- chunks ----------------------------------------------------------- */
 const textOf=p=>clean((p&&p.sentences||[]).map(s=>s.text).join(' '));
 const pageOf=p=>{const s=(p&&p.sentences||[]).find(x=>Number.isFinite(Number(x.page)));return s?Number(s.page):null;};
 /* A paragraph as runs of sentences on one page: a paragraph that turns the page is cited on the page each part is on. */
 function runsOf(p){
  const out=[];
  for(const s of (p&&p.sentences)||[]){
   const page=Number.isFinite(Number(s.page))?Number(s.page):null,last=out[out.length-1];
   if(last&&(page===null||last.page===null||page===last.page)){last.parts.push(s.text);if(last.page===null)last.page=page;}
   else out.push({page,parts:[s.text]});
  }
  return out.map(r=>({page:r.page,text:clean(r.parts.join(' '))})).filter(r=>r.text);
 }
 function splitLong(text,max){
  if(text.length<=max)return [text];
  const sentences=text.split(/(?<=[.!?。])\s+/),out=[];let current='';
  for(const s of sentences){if(current&&(current+' '+s).length>max){out.push(current);current=s;}else current=current?current+' '+s:s;}
  if(current)out.push(current);
  return out.flatMap(piece=>{if(piece.length<=max*1.5)return [piece];const parts=[];for(let i=0;i<piece.length;i+=max)parts.push(piece.slice(i,i+max));return parts;});
 }
 /* A figure caption as pieces the AI can be given whole: the label and title, then one piece per panel ("(A) …",
    "a, …", "B. …" after a sentence end), each cut at sentence ends when it is still long. A 4,000-character
    Nature caption was one chunk cut at 1,400 characters, so the later panels never reached the model. */
 const PANEL=/(?<=[.;:]\s)(?=\([A-Za-z](?:\s*[–-]\s*[A-Za-z])?\)\s|[a-z](?:[–-][a-z])?,\s|[A-L](?:[–-][A-L])?[.,]\s+[A-Z])/u;
 const CAPTION_LABEL=/^((?:extended data |supplementary )?(?:fig(?:ure)?s?\.?|table)\s*s?\d+[a-z]?)/i;
 function captionPieces(text,{max=CHUNK_TARGET}={}){
  const source=clean(text);if(!source)return [];
  const out=[];
  for(const piece of source.split(PANEL)){
   const m=/^\(?([A-Za-z])(?:\s*[–-]\s*([A-Za-z]))?\)?[,.]?\s/.exec(piece);
   const panel=out.length&&m?(m[1]+(m[2]?'–'+m[2]:'')):'';
   for(const part of splitLong(piece,max))out.push({panel,text:part});
  }
  return out;
 }
 /* One chunk is a paragraph or a few short ones from the same section. */
 function buildChunks(structured,{target=CHUNK_TARGET,pageBase=0}={}){
  const chunks=[];if(!structured)return chunks;
  const parts=partsOf(structured);
  const add=(section,sectionIndex,page,text,kind='body',part='body',extra=null)=>{
   const body=clean(text);if(!body)return;
   const tokens=tokenize(section+' '+body),tf=new Map();for(const t of tokens)tf.set(t,(tf.get(t)||0)+1);
   chunks.push({id:chunks.length,section:clean(section),sectionIndex,page:Number.isFinite(Number(page))?Number(page)+pageBase:null,text:body,tf,length:tokens.length||1,kind,part,...(extra||{})});
  };
  // The abstract's own page where the extraction knows it (a Cell paper's is on p. 2), else the first.
  const abstractSection=(structured.sections||[]).find(s=>s&&s.kind==='abstract'&&Number.isFinite(Number(s.page)));
  if(clean(structured.abstract))add('Abstract',-1,abstractSection?Number(abstractSection.page):1-pageBase,structured.abstract,'abstract','abstract');
  (structured.sections||[]).forEach((section,sectionIndex)=>{
   const part=parts[sectionIndex]||'body';
   if(part==='abstract'&&clean(structured.abstract))return;      // already in, once
   let buffer='',bufferPage=null;
   const flush=()=>{if(buffer){add(section.heading||'',sectionIndex,bufferPage??section.page,buffer,part==='abstract'?'abstract':'body',part);}buffer='';bufferPage=null;};
   for(const paragraph of section.paragraphs||[]){
    for(const run of runsOf(paragraph)){
     // A chunk stays on one page, so its marker is the page of everything in it.
     if(buffer&&run.page!==null&&bufferPage!==null&&run.page!==bufferPage)flush();
     for(const piece of splitLong(run.text,target)){
      if(!buffer)bufferPage=run.page;
      if(buffer&&(buffer+' '+piece).length>target){flush();bufferPage=run.page;}
      buffer=buffer?buffer+' '+piece:piece;
      if(buffer.length>=CHUNK_MIN)flush();
     }
    }
   }
   flush();
  });
  (structured.captions||[]).forEach((c,ci)=>{
   const text=clean(c&&c.text||(c&&c.sentences?textOf(c):c));if(!text)return;
   const table=c&&c.kind==='table',m=CAPTION_LABEL.exec(text);
   const label=clean(c&&c.label||(m&&m[1])||(table?'Table':'Caption')).replace(/\.$/,'');
   for(const piece of captionPieces(text))add(piece.panel?label+', panel '+piece.panel:label,-3,c&&c.page,piece.text,table?'table':'caption','caption',{figure:ci,panel:piece.panel});
  });
  const tables=Array.isArray(structured.tables)?structured.tables:(structured.skipped&&Array.isArray(structured.skipped.tables)?structured.skipped.tables:[]);
  tables.forEach(tb=>{const text=clean(tb&&(tb.text||tb.caption)||'');if(text)add('Table',-4,tb&&tb.page,text.slice(0,2000),'table','caption');});
  return chunks;
 }
 /* The section a page belongs to: the last one that starts on or before it. */
 function sectionAtPage(structured,page,{pageBase=0}={}){
  const sections=(structured&&structured.sections)||[];let found=-1;
  sections.forEach((s,i)=>{if(Number.isFinite(Number(s.page))&&Number(s.page)+pageBase<=page&&(s.paragraphs||[]).length)found=i;});
  return found;
 }

 /* ---- retrieval -------------------------------------------------------- */
 /* `context` is what the question leans on, at a lower weight: the previous question for a follow-up ("그 속도는?"
    shares no word with the passage the first question found), or a passage the reader selected. */
 /* "Figure 3", "Fig. 2B", "Extended Data Fig. 4", "Table 1", "그림 3", "표 2": the figures and tables a question names.
    Their number would be lost as a token ("3" is too short, "figure" a stop word). */
 function figureRefs(text){
  const out=[];const seen=new Set();
  for(const m of String(text||'').matchAll(/(extended data |supplementary )?(fig(?:ure)?s?\.?|table|그림|도표|표)\s*(S?\d{1,2})([A-Za-z](?![A-Za-z]))?/giu)){
   const kind=/^(table|표|도표)/i.test(m[2])?'table':'figure',prefix=m[1]?m[1].trim().toLowerCase():'',n=m[3].toUpperCase(),key=kind+prefix+n;
   if(!seen.has(key)){seen.add(key);out.push({kind,prefix,n,panel:m[4]?m[4].toUpperCase():''});}
  }
  return out;
 }
 const labelRef=label=>{const m=/^(extended data |supplementary )?(fig(?:ure)?s?\.?|table)\s*(s?\d+)/i.exec(String(label||''));return m?{kind:/^table/i.test(m[2])?'table':'figure',prefix:m[1]?m[1].trim().toLowerCase():'',n:m[3].toUpperCase()}:null;};
 function rank(chunks,query,{k=TOP_CHUNKS,page=null,sectionIndex=-1,forcePage=false,intent=null,context='',contextWeight=0.5,carry=[]}={}){
  if(!chunks.length)return [];
  const own=tokenize(expandQuery(query)),q=own.map(t=>[t,1]);
  if(clean(context)){const seen=new Set(own);for(const t of tokenize(expandQuery(context)))q.push([t,seen.has(t)?contextWeight/2:contextWeight]);}
  const N=chunks.length,avg=chunks.reduce((n,c)=>n+c.length,0)/N||1;
  const df=new Map();for(const [t] of q)if(!df.has(t))df.set(t,chunks.filter(c=>c.tf.has(t)).length);
  const K1=1.5,B=0.75;
  const scored=chunks.map(c=>{
   let score=0;
   for(const [t,w] of q){const f=c.tf.get(t);if(!f)continue;const n=df.get(t),idf=Math.log(1+(N-n+0.5)/(n+0.5));score+=w*idf*f*(K1+1)/(f+K1*(1-B+B*c.length/avg));}
   if(score>0&&sectionIndex>=0&&c.sectionIndex===sectionIndex)score*=1.25;
   if(score>0&&page&&c.page===page)score*=1.15;
   return {chunk:c,score};
  });
  const picked=new Map();
  const take=c=>{if(c&&!picked.has(c.id))picked.set(c.id,c);};
  const byScore=list=>list.slice().sort((a,b)=>b.score-a.score||a.chunk.id-b.chunk.id);
  take(chunks.find(c=>c.kind==='abstract'));
  // A figure or table named in the question: its caption (every panel, within the figure budget), then the two
  // body passages that cite it most.
  for(const ref of figureRefs(query)){
   let used=0;
   for(const c of chunks.filter(c=>(c.kind==='caption'||c.kind==='table')&&(r=>r&&r.kind===ref.kind&&r.n===ref.n&&r.prefix===ref.prefix)(labelRef(c.section)))){if(used&&used+c.text.length>FIGURE_BUDGET)break;take(c);used+=c.text.length;}
   const cite=new RegExp((ref.kind==='table'?'\\bTables?\\.?':'\\bFig(?:ure)?s?\\.?')+'\\s*(?:\\d+[A-Za-z]?\\s*(?:,|and|–|-)\\s*)*'+ref.n.replace(/^S/,'S?')+'(?![0-9])','i');
   const cited=chunks.filter(c=>c.kind==='body'&&cite.test(c.text)&&(!ref.prefix||new RegExp(ref.prefix,'i').test(c.text)));
   for(const c of cited.slice(0,2))take(c);
  }
  // "This figure": every panel of the figures and tables on the page on screen first (within their own budget,
  // so a long caption is not cut off after its first panels), then the body there.
  if(forcePage&&page){
   let used=0;
   for(const c of chunks.filter(c=>c.page===page&&(c.kind==='caption'||c.kind==='table'))){if(used&&used+c.text.length>FIGURE_BUDGET)break;take(c);used+=c.text.length;}
   for(const c of chunks.filter(c=>c.page===page&&c.kind==='body').slice(0,2))take(c);
  }
  // A follow-up keeps the passages the previous answer stood on (up to three, the most relevant now first), so the
  // model can stand by what it said instead of "correcting" it for want of the excerpt.
  if(Array.isArray(carry)&&carry.length){const ids=new Set(carry);for(const s of byScore(scored.filter(s=>ids.has(s.chunk.id)&&s.chunk.kind!=='abstract')).slice(0,3))take(s.chunk);}
  if(sectionIndex>=0){
   const here=byScore(scored.filter(s=>s.chunk.sectionIndex===sectionIndex))[0];
   if(here)take(here.chunk);
  }
  // A quick prompt says which part of the paper it is about: the best chunks of that part, whatever language the question is in.
  const wanted=intent&&Array.isArray(intent.parts)?intent.parts:[];
  if(wanted.length){
   const room=Math.max(2,k-picked.size);let n=0;
   const near=c=>!(forcePage&&page)||c.page!==null&&Math.abs(c.page-page)<=1;   // "this figure" means a figure on or beside this page
   for(const s of byScore(scored.filter(s=>wanted.includes(s.chunk.part)&&near(s.chunk)))){if(n>=room)break;if(!picked.has(s.chunk.id)){take(s.chunk);n++;}}
  }
  const any=scored.some(s=>s.score>0);
  for(const s of byScore(scored)){
   if(picked.size>=k)break;if(s.score<=0)break;take(s.chunk);
  }
  // Nothing matched: the section on screen, the abstract (above) and the discussion, rather than two chunks.
  if(!any||picked.size<Math.min(3,chunks.length)){
   for(const c of chunks.filter(c=>sectionIndex>=0&&c.sectionIndex===sectionIndex).slice(0,2))if(picked.size<k)take(c);
   for(const part of ['discussion','results','intro'])if(picked.size<k)take(chunks.find(c=>c.part===part));
  }
  // Captions first when the page was asked about; otherwise document order.
  const out=[...picked.values()];
  return forcePage&&page?out:out.sort((a,b)=>a.id-b.id);
 }
 const where=c=>(c.section||'')+(c.page?(c.section?', ':'')+'p. '+c.page:'');
 const excerpt=(c,i)=>`[E${i+1}] (${where(c)}) ${c.text.slice(0,EXCERPT_CHARS)}`;

 /* ---- summary input ---------------------------------------------------- */
 const WIDE=/^(conclusions?|discussion|conclusions? and (?:outlook|future)|summary|results? and discussion|outlook|limitations?|결론|논의|고찰)(?![\p{L}\p{N}])/iu;
 const SKIP=/^(acknowledge?ments?|references|bibliography|funding|author contributions?|competing interests?|conflicts? of interest|참고문헌|감사)/i;
 /* How much a paragraph says in numbers: values with units, percentages, folds, p-values, n = …, resolutions.
    The summary is asked for key findings with their numbers, so the spare budget goes to these paragraphs. */
 const QUANT=/\d+(?:[.,·]\d+)?\s*(?:%|-?fold|×|x\b|nm|µm|μm|mm|cm|µM|μM|nM|mM|M\b|Å|kDa|bp|kb|Mb|nt|aa|h\b|min\b|s\b|ms\b|°C|K\b)|[pP]\s*[<=≤]\s*0?[.·]\d+|\bn\s*=\s*\d+|\bR2?\s*=\s*0?\.\d+/gu;
 const quantScore=text=>{const t=String(text||'');return (t.match(QUANT)||[]).length+Math.min(3,(t.match(/\d+(?:\.\d+)?/g)||[]).length/6);};
 const PARA_CAP=900;
 /* The budget goes to what a reader decides with: title, abstract and the list of sections always fit; back
    matter (availability statements, reporting summaries, licences) is left out; the methods get at most 15%.
    First the opening paragraph of every section (three of the discussion); then what is left goes to further
    paragraphs of the results and the body, those with numbers first, spread over the sections. Every paragraph
    carries its own page: a finding on p. 8 of a Results section that starts on p. 3 is cited as p. 8. */
 function summaryInput(structured,{budget=SUMMARY_BUDGET,meta={},pageBase=0}={}){
  const title=clean(structured&&structured.title||meta.title).slice(0,400);
  const parts=partsOf(structured);
  const sections=((structured&&structured.sections)||[]).map((s,i)=>({...s,i,part:parts[i]})).filter(s=>(s.paragraphs||[]).length&&s.part!=='back'&&s.part!=='abstract'&&!SKIP.test(clean(s.heading)));
  const headings=sections.map(s=>({heading:clean(s.heading)||'(untitled)',page:Number.isFinite(Number(s.page))?Number(s.page)+pageBase:null}));
  let abstract=clean(structured&&structured.abstract||meta.abstract);
  if(abstract.length>budget*0.25)abstract=abstract.slice(0,Math.floor(budget*0.25))+'…';
  let list=headings.map(h=>h.heading.slice(0,90)+(h.page?' (p. '+h.page+')':''));
  const listRoom=Math.floor(budget*0.15);
  while(list.length>1&&list.join(' | ').length>listRoom)list=list.slice(0,-1);
  const listText=list.join(' | ')+(list.length<headings.length?' | …':'');
  const head=['TITLE: '+title,'ABSTRACT: '+(abstract||'(none)'),'SECTIONS: '+listText].join('\n');
  const pageAt=(s,p)=>{const raw=pageOf(p)??s.page;return Number.isFinite(Number(raw))?Number(raw)+pageBase:null;};
  const labelOf=(s,page)=>`[${clean(s.heading)||'Text'}${page?', p. '+page:''}]`;
  // A paragraph that turns the page is marked with both pages ("pp. 3–4"); the text is cut at PARA_CAP.
  const piece=(s,j)=>{
   const p=s.paragraphs[j],text=textOf(p).slice(0,PARA_CAP),runs=runsOf(p);let used=0;const pages=[];
   for(const r of runs){if(used>=text.length)break;if(r.page!==null&&!pages.includes(r.page))pages.push(r.page);used+=r.text.length+1;}
   const label=pages.length>1?`[${clean(s.heading)||'Text'}, pp. ${pages[0]+pageBase}–${pages[pages.length-1]+pageBase}]`:labelOf(s,pages.length?pages[0]+pageBase:pageAt(s,p));
   return {si:s.i,j,label,text,wide:false,part:s.part};
  };
  let pieces=[],extra=[];
  for(const s of sections){
   const wide=WIDE.test(clean(s.heading))||s.part==='discussion';
   const first=wide?Math.min(3,s.paragraphs.length):1;
   for(let j=0;j<first;j++){const p=piece(s,j);p.wide=wide;if(p.text)pieces.push(p);}
   // Further paragraphs: the results and the body, and a "Results and discussion"; not the methods, and a
   // discussion past its first three only when it also holds the results.
   if(s.part==='methods'||wide&&!/result/i.test(clean(s.heading)))continue;
   for(let j=first;j<s.paragraphs.length;j++){const p=piece(s,j);if(p.text.length>=40)extra.push({...p,score:quantScore(p.text)+(s.part==='results'?1:0)-0.05*j});}
  }
  const lead='\n\nEXCERPTS (first paragraph of each section, more of the results and the discussion; each starts with [Section, p. N]):\n';
  let room=Math.max(0,budget-head.length-lead.length),truncated=false;
  const size=list=>list.reduce((n,p)=>n+p.label.length+1+p.text.length+1,0);
  // The methods share at most 15% of the budget, cut evenly.
  const methods=pieces.filter(p=>p.part==='methods'),methodsRoom=Math.floor(budget*0.15);
  if(size(methods)>methodsRoom){const per=Math.max(60,Math.floor(methodsRoom/Math.max(1,methods.length))-20);let used=0;
   pieces=pieces.filter(p=>{if(p.part!=='methods')return true;if(used>=methodsRoom)return false;p.text=p.text.slice(0,Math.max(0,Math.min(per,methodsRoom-used-p.label.length-2)));used+=p.label.length+2+p.text.length;return p.text.length>0;});}
  if(size(pieces)>room){
   truncated=true;const scale=Math.max(0.2,room/size(pieces));
   pieces=pieces.map(p=>({...p,text:p.text.slice(0,Math.max(120,Math.floor(p.text.length*scale)))}));
   while(pieces.length&&size(pieces)>room){const last=pieces[pieces.length-1];if(last.text.length>160)last.text=last.text.slice(0,last.text.length-Math.max(40,size(pieces)-room));else pieces.pop();}
  }
  const pool=extra.reduce((n,p)=>n+p.text.length,0);let read=0;
  if(!truncated&&extra.length){
   // Spread over the sections: each paragraph taken lowers the next one's turn from the same section.
   let left=room-size(pieces);const taken=new Map();
   while(extra.length){
    extra.sort((a,b)=>(b.score-0.6*(taken.get(b.si)||0))-(a.score-0.6*(taken.get(a.si)||0))||a.si-b.si||a.j-b.j);
    const next=extra.shift(),cost=next.label.length+2+next.text.length;
    if(cost<=left){pieces.push(next);left-=cost;read+=next.text.length;taken.set(next.si,(taken.get(next.si)||0)+1);}
    else{if(left>320){next.text=next.text.slice(0,left-next.label.length-4);pieces.push(next);read+=next.text.length;left=0;}if(left<200)break;}
   }
  }
  // How much of the results and body past each section's opening was read; under 40% the panel says it read a part.
  const coverage=pool?Math.min(1,read/pool):1;
  if(coverage<0.4)truncated=true;
  pieces.sort((a,b)=>a.si-b.si||a.j-b.j);
  // Paragraphs side by side under the same label are one line.
  const lines=[];for(const p of pieces){const prev=lines[lines.length-1];if(prev&&prev.label===p.label&&prev.si===p.si)prev.text+=' '+p.text;else lines.push({...p});}
  const body=lines.map(p=>p.label+' '+p.text).join('\n');
  const text=(head+lead+body).slice(0,budget);
  return {text,title,abstract,headings,chars:text.length,truncated,coverage:Math.round(coverage*100)/100,sectionCount:new Set(pieces.map(p=>p.si)).size,parts:lines.map(p=>({label:p.label,part:p.part,text:p.text}))};
 }
 /* What the reader already has: their tags and memo on this paper, and papers of the same collections. Sent with a
    summary or a "relates to my research" question, so the model can say how this paper fits; titles only. */
 function libraryBlock({memo='',tags=[],collections=[],neighbours=[]}={},{max=2400}={}){
  const lines=[];
  const tagList=(tags||[]).map(clean).filter(Boolean).slice(0,30);
  if(tagList.length)lines.push('Tags on this paper: '+tagList.join(', '));
  if((collections||[]).length)lines.push('In collections: '+collections.map(clean).filter(Boolean).slice(0,8).join(', '));
  if(clean(memo))lines.push('Memo: '+clean(memo).slice(0,1200));
  const papers=(neighbours||[]).filter(n=>n&&clean(n.title)).slice(0,15);
  if(papers.length)lines.push('Other papers in the same collections:\n'+papers.map((n,i)=>`L${i+1}. ${clean(n.title).slice(0,160)}${n.year?' ('+n.year+')':''}`).join('\n'));
  if(!lines.length)return '';
  return ('MY LIBRARY (the researcher\'s own notes and papers, not part of this paper):\n'+lines.join('\n')).slice(0,max);
 }
 const LANG_HEADINGS={Korean:['요약','핵심 결과','방법','한계','내 연구와의 관계','다음에 읽을 것'],English:['Summary','Key findings','Methods','Limitations','Relation to my library','What to read next']};
 /* Korean prose with the research vocabulary as the paper writes it: "CRISPR 간섭", not a coined translation. */
 const termsRule=language=>/^english$/i.test(String(language))?'':` Keep technical terms, gene, protein, species, strain and chemical names, method names, units and abbreviations in English as the paper writes them; write the rest in ${language}.`;
 function summaryPrompt(language='Korean'){
  const h=LANG_HEADINGS[language]||LANG_HEADINGS.English;
  return `You are helping a researcher decide how to read one paper. Use ONLY the supplied title, abstract, section headings and excerpts (each excerpt starts with [Section, p. N]) and, where given, the MY LIBRARY block. Write in ${language}.${termsRule(language)} Output Markdown with these sections, headings exactly as written, in this order:
## ${h[0]}
3 to 5 sentences: the question, the approach, the main result, and what is new compared with earlier work as the authors put it.
## ${h[1]}
3 to 6 bullets, the most important first, each with its numbers (effect sizes, percentages, n, p-values, resolutions) exactly as in the excerpts. Each bullet ends with (Section, p. N) copied from the marker of the excerpt it comes from.
## ${h[2]}
Two lines: the system, organism or data used, and how the claim was tested (with (Section, p. N)).
## ${h[3]}
Bullets: what the authors state, then what the excerpts suggest is not shown, marked "(inferred)"; end with one or two things to check in the full text (controls, sample size, statistics, scope of the claim).
## ${h[4]}
Only when a MY LIBRARY block is supplied: one to three bullets on how this paper bears on those tags, memo or papers (name them as given, e.g. L2). Leave this section out entirely when there is no MY LIBRARY block.
## ${h[5]}
Two or three bullets: which figure or section of this paper to read first and why, with (Section, p. N); and, if MY LIBRARY lists papers, the one to read alongside.
Do not invent numbers, results or citations; every page you cite must be one of the excerpt markers. If the excerpts do not say something, write that they do not. Keep gene, species and chemical names and numbers exactly as given. Be concise: about 250 to 400 words in all.`;
 }
 /* ---- chat ------------------------------------------------------------- */
 const FOLLOW_UPS='FOLLOW-UPS:';
 function chatSystemPrompt(language='Korean'){
  return `You answer questions about ONE paper for the researcher reading it. Answer only from the excerpts supplied below (each starts with [E#] (Section, p. N)) and the summary. After each claim cite where it comes from as (Section, p. N), copying the section and page from the excerpt. If the excerpts do not answer the question, say plainly that the paper, as far as supplied, does not say, and suggest where to look; never fill the gap from general knowledge without labelling it "(general knowledge, not from this paper)". Quote numbers exactly. Answer in ${language}; keep it short unless asked for detail.${termsRule(language)} End with one last line "${FOLLOW_UPS} first question | second question": two short follow-up questions, in ${language}, that this paper can answer and that the researcher would plausibly ask next.`;
 }
 /* The answer and its suggested follow-ups, apart. While the answer streams, a last line that is only the start
    of the marker ("FOLLOW-") is held back, so the marker never flickers into view. */
 function splitFollowUps(text){
  const source=String(text==null?'':text);
  const at=source.search(/(?:^|\n)[ \t>*_]*FOLLOW-UPS\s*:/i);
  if(at<0){
   const lastBreak=source.lastIndexOf('\n'),tail=source.slice(lastBreak+1).replace(/^[\s>*_]+/,'');
   const partial=tail.length>=3&&FOLLOW_UPS.startsWith(tail.toUpperCase());
   return {body:(partial?source.slice(0,Math.max(0,lastBreak)):source).trimEnd(),followUps:[]};
  }
  const rest=source.slice(at).replace(/^\s*[>*_ \t]*FOLLOW-UPS\s*:\s*/i,'');
  // A list marker ("- ", "1. ") is not part of the question; a number that starts one ("250 bp …") is.
  const followUps=rest.split(/\s*\|\s*|\n+/).map(q=>clean(clean(q).replace(/^[*_]+\s*/,'').replace(/^(?:[-*•]|\d{1,2}[.)])\s+/,'').replace(/[*_]+$/,''))).filter(q=>q.length>=4&&q.length<=200).slice(0,3);
  return {body:source.slice(0,at).trimEnd(),followUps};
 }
 /* The Korean text is the dictionary key (see i18n.js); `translate` turns it
    into the panel's language, so a button and the question it sends agree. */
 /* Each quick prompt carries the part of the paper it is about (its retrieval intent). */
 const QUICK={
  claim:{label:'핵심 주장',question:'이 논문의 핵심 주장은 무엇이고, 어떤 증거로 뒷받침하나요?',intent:{parts:['results','discussion']}},
  methods:{label:'방법 요약',question:'이 논문의 방법을 단계별로 요약해 주세요.',intent:{parts:['methods']}},
  limits:{label:'한계',question:'이 논문의 한계와 결과를 그대로 믿기 전에 확인할 점은 무엇인가요?',intent:{parts:['discussion','methods']}},
  figure:{label:'현재 그림 설명',question:'지금 보고 있는 쪽의 그림이나 표를 설명해 주세요. 무엇을 보여주고 어떻게 읽어야 하나요?',forcePage:true,intent:{parts:['caption']}},
  mine:{label:'내 연구와 관련?',question:'제 메모와 태그를 보면 이 논문이 제 연구와 어떻게 관련되나요?',mine:true,intent:null}
 };
 // Not a chip: the reader's selection popup asks it, with the selected text.
 const PASSAGE={label:'AI에게 묻기',question:'선택한 부분을 쉽게 풀어 설명하고, 논문의 주장에서 어떤 역할을 하는지 알려 주세요.',intent:null};
 function quickPrompt(id,translate=x=>x){
  const q=id==='passage'?PASSAGE:QUICK[id];if(!q)return null;
  return {id,question:translate(q.question),forcePage:!!q.forcePage,mine:!!q.mine,intent:q.intent||null};
 }
 /* The messages for one question: system rules with the excerpts, the last few
    turns, and the question. The user's own notes go in only when asked for. */
 /* `passage` is text the reader selected in the PDF ({text, page}): it is quoted to the model and steers retrieval.
    Earlier turns are kept newest first inside HISTORY_CHARS, so a long conversation does not grow every request. */
 const HISTORY_CHARS=9000,PASSAGE_CHARS=2500;
 function chatMessages({question,history=[],chunks=[],summary='',language='Korean',viewing={},mine=null,forcePage=false,intent=null,turns=HISTORY_TURNS,k=TOP_CHUNKS,passage=null,library=''}){
  const kept=[];let used=0;
  for(const m of history.filter(m=>m&&(m.role==='user'||m.role==='assistant')&&clean(m.content)&&!m.error).slice(-turns*2).reverse()){
   const content=(m.role==='assistant'?splitFollowUps(m.content).body:String(m.content)).slice(0,kept.length<2?4000:1800);
   if(kept.length&&used+content.length>HISTORY_CHARS)break;
   kept.unshift({role:m.role,content});used+=content.length;
  }
  if(kept.length&&kept[0].role==='assistant')kept.shift();
  const quoted=passage&&clean(passage.text)?clean(passage.text).slice(0,PASSAGE_CHARS):'';
  const lastAsked=[...history].reverse().find(m=>m&&m.role==='user'&&clean(m.content)&&!m.error);
  // A quick prompt says what it is about; a typed question may lean on the one before it.
  const context=[quoted,!intent&&!forcePage&&lastAsked?String(lastAsked.content):''].filter(Boolean).join(' ');
  const lastAnswer=!intent&&!forcePage?[...history].reverse().find(m=>m&&m.role==='assistant'&&!m.error&&Array.isArray(m.picked)):null;
  const page=quoted&&Number.isFinite(Number(passage.page))?Number(passage.page):(viewing.page||null);
  const picked=rank(chunks,question+(mine?' '+(mine.tags||[]).join(' '):''),{k,page,sectionIndex:Number.isInteger(viewing.sectionIndex)?viewing.sectionIndex:-1,forcePage,intent,context,contextWeight:quoted?0.8:0.5,carry:lastAnswer?lastAnswer.picked:[]});
  const parts=[chatSystemPrompt(language)];
  if(viewing.page)parts.push(`The reader is looking at page ${viewing.page}${viewing.section?' ('+viewing.section+')':''}.`);
  if(quoted)parts.push(`SELECTED PASSAGE (the reader selected this on p. ${page||'?'} and asks about it):\n"${quoted}"`);
  if(clean(summary))parts.push('SUMMARY OF THE PAPER (generated earlier):\n'+splitFollowUps(summary).body.slice(0,3000));
  parts.push('EXCERPTS:\n'+(picked.length?picked.map(excerpt).join('\n\n'):'(none matched)'));
  if(mine&&(clean(mine.memo)||(mine.tags||[]).length))parts.push('THE USER\'S OWN NOTES ON THIS PAPER (not part of the paper):\nTags: '+(mine.tags||[]).join(', ')+'\nMemo: '+clean(mine.memo).slice(0,2000));
  if(mine&&clean(library))parts.push(String(library));
  return {messages:[{role:'system',content:parts.join('\n\n')},...kept,{role:'user',content:String(question)}],picked:picked.map(c=>({id:c.id,section:c.section,page:c.page}))};
 }

 /* ---- page links in an answer ------------------------------------------ */
 /* "(Methods, p. 4; Results, pp. 6-7)" becomes text and cite segments; only
    a number inside parentheses counts, and only a real page of this paper. */
 function linkCitations(text,{pages=0}={}){
  const source=String(text==null?'':text),segments=[];let last=0;
  const group=/\([^()\n]{0,160}\)/g,ref=/\bpp?\.\s*(\d{1,4})(?:\s*[–-]\s*\d{1,4})?|(\d{1,4})\s*쪽(?:\s*[–-]\s*\d{1,4}\s*쪽)?/g;
  const push=(type,value,page)=>{if(!value)return;const prev=segments[segments.length-1];if(type==='text'&&prev&&prev.type==='text')prev.text+=value;else segments.push(type==='cite'?{type,text:value,page}:{type,text:value});};
  for(const g of source.matchAll(group)){
   if(!/\bpp?\.\s*\d|\d\s*쪽/.test(g[0]))continue;
   push('text',source.slice(last,g.index));
   let inner=0;const body=g[0];
   for(const r of body.matchAll(ref)){
    const page=Number(r[1]||r[2]);
    push('text',body.slice(inner,r.index));
    if(page>=1&&(!pages||page<=pages))push('cite',r[0],page);else push('text',r[0]);
    inner=r.index+r[0].length;
   }
   push('text',body.slice(inner));last=g.index+g[0].length;
  }
  push('text',source.slice(last));
  return segments;
 }

 /* ---- streaming -------------------------------------------------------- */
 /* Server-sent events from a Chat Completions server: lines "data: {json}"
    carrying choices[0].delta.content, ended by "data: [DONE]". update() takes
    the whole text received so far, as an XHR gives it, and reports only what is
    new. A plain JSON answer (a server that ignored stream:true) is read too. */
 /* finish: the server's finish_reason ("stop", "length"); error: an error event in the stream (the local bridge sends
    one when an account stops mid-answer). An answer cut short is still shown, marked as incomplete. */
 function streamReader(onDelta){
  let seen=0,buffer='',text='',done=false,plain='',finish=null,error=null;
  const line=raw=>{
   const s=raw.trim();if(!s||s.startsWith(':')||s.startsWith('event:'))return;
   const data=s.startsWith('data:')?s.slice(5).trim():s;
   if(data==='[DONE]'){done=true;return;}
   let json;try{json=JSON.parse(data);}catch(_){return;}
   if(json&&json.error){error=String(json.error.message||json.error.type||json.error)||'error';return;}
   const reason=json&&json.choices&&json.choices[0]&&json.choices[0].finish_reason;if(reason)finish=String(reason);
   const piece=json&&json.choices&&json.choices[0]&&(json.choices[0].delta&&json.choices[0].delta.content||json.choices[0].message&&json.choices[0].message.content)||json&&json.message&&json.message.content||'';
   if(typeof piece==='string'&&piece){text+=piece;onDelta&&onDelta(piece,text);}
  };
  return {
   update(full){
    const all=String(full||'');if(all.length<seen)return text;
    plain=all;buffer+=all.slice(seen);seen=all.length;
    const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const l of lines)line(l);
    return text;
   },
   /* The stream is over: the last line may have had no newline; a body that was
      one JSON document (not events) is parsed whole. */
   end(){
    if(buffer){line(buffer);buffer='';}
    if(!text&&plain.trim().startsWith('{')){try{const json=JSON.parse(plain);const piece=json.choices&&json.choices[0]&&json.choices[0].message&&json.choices[0].message.content;if(json.choices&&json.choices[0]&&json.choices[0].finish_reason)finish=String(json.choices[0].finish_reason);done=true;if(typeof piece==='string'){text=piece;onDelta&&onDelta(piece,text);}}catch(_){}}
    return text;
   },
   /* Why the answer is not whole, or null: an error event, a length limit, or a stream that ended without saying so. */
   get incomplete(){return error?'error':finish==='length'?'length':(!done&&!finish&&text)?'cut':null;},
   get text(){return text;},get done(){return done;},get finish(){return finish;},get error(){return error;}
  };
 }
 const isEventStream=contentType=>/text\/event-stream/i.test(String(contentType||''));
 /* The prompts' own revision: a summary or an answer made under other instructions is a different result, so it
    is part of the summary cache key and of each answer's record. Changes whenever a prompt's text changes. */
 const PROMPT_REVISION=(()=>{const text=summaryPrompt('X')+'\u0001'+chatSystemPrompt('X')+'\u0001'+summaryPrompt('Korean');let h=0x811c9dc5;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h.toString(36);})();

 /* A summary or an answer as a child note: the same short Markdown the panel draws (headings, bullets, **bold**),
    every piece of text escaped, and a line naming the paper's question, the account or model and the date. */
 const escHTML=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 function noteHTML({heading='',title='',question='',text='',source='',date=''}={}){
  const inline=line=>String(line).split(/(\*\*[^*]+\*\*)/).map(part=>{const m=/^\*\*([^*]+)\*\*$/.exec(part);return m?'<strong>'+escHTML(m[1])+'</strong>':escHTML(part);}).join('');
  const out=['<h1>'+escHTML(heading)+(title?' — '+escHTML(title):'')+'</h1>'];
  if(clean(question))out.push('<p><strong>Q.</strong> '+escHTML(clean(question))+'</p>');
  let list=false;const close=()=>{if(list){out.push('</ul>');list=false;}};
  for(const raw of String(text==null?'':text).split(/\r?\n/)){
   const line=raw.trimEnd();if(!line.trim()){close();continue;}
   let m;
   if((m=/^\s{0,3}#{1,4}\s+(.*)$/.exec(line))){close();out.push('<h2>'+escHTML(m[1].replace(/\*+/g,''))+'</h2>');}
   else if((m=/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line))){if(!list){out.push('<ul>');list=true;}out.push('<li>'+inline(m[1])+'</li>');}
   else{close();out.push('<p>'+inline(line.trim())+'</p>');}
  }
  close();
  if(source||date)out.push('<p><em>'+escHTML([source,date].filter(Boolean).join(' · '))+'</em></p>');
  return '<div>'+out.join('')+'</div>';
 }
 const api={figureRefs,runsOf,PASSAGE,PROMPT_REVISION,libraryBlock,splitFollowUps,quantScore,HISTORY_CHARS,LANG_HEADINGS,noteHTML,tokenize,stem,expandQuery,partsOf,buildChunks,captionPieces,sectionAtPage,rank,summaryInput,summaryPrompt,chatSystemPrompt,quickPrompt,chatMessages,linkCitations,streamReader,isEventStream,QUICK,SUMMARY_BUDGET,TOP_CHUNKS,HISTORY_TURNS,excerpt};
 root.CustomStylePaperChat=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
