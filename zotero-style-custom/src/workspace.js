/* Pure workspace operations shared by the panel and background regressions. */
(function(root){
 'use strict';
 const text=value=>String(value??'');
 /* One normaliser for every box in the panel.

    "Muller" has to find Hans Müller, "protein-protein" has to find
    protein–protein, and Ｃａｓ９ typed fullwidth has to find cas9. So the
    haystack and the query both go through the same fold: decompose, drop the
    combining marks the decomposition exposed, recompose, lowercase, and pull
    every dash-like character onto the plain hyphen. Hangul survives the round
    trip because its jamo are letters, not marks, and NFC puts them back. */
 const DASHES=/[‐-―−]/g;
 const norm=value=>text(value).normalize('NFKD').replace(/\p{M}+/gu,'').normalize('NFC').toLowerCase().replace(DASHES,'-');
 /* Typographic quotes count as quotes: the hint itself shows “phrase”, and a
    Mac turns a typed " into one when smart quotes are on. */
 const QUOTES=/[“”„‟«»＂]/g;
 const straight=value=>text(value).replace(QUOTES,'"');
 const tokenize=query=>[...norm(straight(query)).matchAll(/"([^"]+)"|(\S+)/g)].map(m=>m[1]||m[2]);
 /* A lone letter is an initial, not a substring: "J. Y. Sung" is looking for
    Jae Yoon Sung, not for every title with a j in it. Only an alphabet's
    letter: one Hangul syllable or Han character is a word (암 is in 유방암),
    never an initial. */
 const INITIAL=/^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]\.?$/u;
 const wordsOf=hay=>hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
 function hit(hay,token,starts){
  if(!INITIAL.test(token))return hay.includes(token);
  const letter=token.replace(/\.$/,'');
  return (starts||wordsOf(hay)).some(word=>word.startsWith(letter));
 }
 /* The same test, for the boxes that search notes, attachments, annotations,
    collections and watched authors: every token has to be in the haystack. */
 function matches(value,query){
  const tokens=tokenize(query);if(!tokens.length)return true;
  const hay=norm(value),starts=tokens.some(t=>INITIAL.test(t))?wordsOf(hay):null;
  return tokens.every(t=>hit(hay,t,starts));
 }
 /* Typing a whole title should put that title first, not bury it in library
    order behind everything else the words happen to appear in. */
 function relevance(item,query){
  const q=plainQuery(query).trim();if(!q)return 0;
  const title=norm(item&&item.title);
  return title===q?0:title.startsWith(q)?1:title.includes(q)?2:3;
 }
 function rankByQuery(items,query){
  if(!plainQuery(query).trim())return [...items];
  return items.map((item,index)=>({item,index,tier:relevance(item,query)}))
   .sort((a,b)=>a.tier-b.tier||a.index-b.index).map(entry=>entry.item);
 }
 /* ---- 검색창 빠른 문법 ----
    -word  "a phrase"  title:x  -author:kim  year:2018-2022  tag:"deep learning"
    A field name is only a field when it is one we know (English or Korean);
    anything else -- a URL, "http://x" -- is plain text, so nothing a person
    could type before is lost. */
 const FIELD_ALIASES={title:'title','제목':'title',author:'author',authors:'author','저자':'author',tag:'tag','태그':'tag',journal:'journal',venue:'journal','저널':'journal',year:'year','연도':'year',collection:'collection','컬렉션':'collection',abstract:'abstract','초록':'abstract',note:'note','메모':'note','노트':'note',annotation:'annotation',annotations:'annotation','주석':'annotation'};
 /* The box's text as tokens: terms (with -, field: and "phrase"), parentheses,
    and the operator OR (or |). OR is only an operator in capitals and on its
    own, so "or" and "ORCID" stay words. Parentheses are always grouping. */
 function lexQuery(query){
  const out=[];
  for(const m of straight(query).matchAll(/(-?)\(|\)|(?<![^\s(])(?:OR|\|\|?)(?![^\s()])|(-?)(?:([\p{L}]+):)?(?:"([^"]*)"|([^\s()]+))/gu)){
   if(m[0]==='('||m[0]==='-('){out.push({t:'open',neg:m[1]==='-'});continue;}
   if(m[0]===')'){out.push({t:'close'});continue;}
   if(m[3]===undefined&&m[4]===undefined&&m[5]===undefined&&/^(OR|\|\|?)$/.test(m[0])){out.push({t:'or'});continue;}
   const neg=m[2]==='-',field=m[3]?FIELD_ALIASES[m[3].toLowerCase()]:'',quoted=m[4]!==undefined;
   let raw=quoted?m[4]:m[5];
   if(m[3]&&!field)raw=m[3]+':'+raw;
   const value=norm(raw).trim();if(!value)continue;
   out.push({t:'term',neg,field:field||'',value,phrase:quoted});
  }
  return out;
 }
 const isBoolean=query=>lexQuery(query).some(tk=>tk.t==='or'||tk.t==='open');
 function parseQuery(query){
  return lexQuery(query).filter(tk=>tk.t==='term').map(({neg,field,value,phrase})=>({neg,field,value,phrase}));
 }
 /* a b OR c d  ->  (a AND b) OR (c AND d); ( ) group; -( ) negates a group.
    Stray ")" are dropped and an unclosed "(" is closed at the end, so no
    typing state is an error. */
 function parseTree(query){
  const raw=lexQuery(query),tokens=[];let depth=0;
  for(const tk of raw){if(tk.t==='open')depth++;if(tk.t==='close'){if(!depth)continue;depth--;}tokens.push(tk);}
  let at=0;
  const empty=n=>!n||(n.op==='and'&&!n.of.length);
  function orExpr(){const alts=[andExpr()];while(tokens[at]?.t==='or'){at++;alts.push(andExpr());}const live=alts.filter(n=>!empty(n));return live.length>1?{op:'or',of:live}:live[0]||{op:'and',of:[]};}
  function andExpr(){const of=[];while(at<tokens.length&&tokens[at].t!=='or'&&tokens[at].t!=='close'){const tk=tokens[at++];
   if(tk.t==='open'){const inner=orExpr();if(tokens[at]?.t==='close')at++;if(!empty(inner))of.push(tk.neg?{op:'not',of:inner}:inner);}
   else if(tk.t==='term')of.push({op:'term',term:{neg:tk.neg,field:tk.field,value:tk.value,phrase:tk.phrase}});}
   return of.length===1?of[0]:{op:'and',of};}
  return orExpr();
 }
 function evalTree(node,item,hay,starts,extra){
  switch(node.op){
   case 'term':return termHit(item,hay,node.term,starts,extra)!==node.term.neg;
   case 'not':return !evalTree(node.of,item,hay,starts,extra);
   case 'or':return node.of.some(n=>evalTree(n,item,hay,starts,extra));
   default:return node.of.every(n=>evalTree(n,item,hay,starts,extra));
  }
 }
 /* The words that stay in the box once the syntax is taken out: what the
    relevance ranking should look at. */
 const plainQuery=query=>isBoolean(query)?'':parseQuery(query).filter(t=>!t.neg&&!t.field).map(t=>t.value).join(' ');
 /* The other half of the box: only the -word and field:value terms, as a query, for code that widens the plain words itself. */
 const syntaxQuery=query=>isBoolean(query)?'':parseQuery(query).filter(t=>t.neg||t.field).map(t=>(t.neg?'-':'')+(t.field?t.field+':':'')+(t.phrase||/\s/.test(t.value)?'"'+t.value+'"':t.value)).join(' ');
 const fieldText=(item,field)=>field==='annotation'?'':field==='title'?item.title:field==='author'?item.authors:field==='journal'?item.venue:field==='abstract'?item.abstract:field==='year'?item.year:field==='note'?[item.remark,...(item.noteTitles||[])].join(' '):field==='collection'?(item.collectionNames||[]).join(' / '):'';
 function yearTerm(value,year){
  const y=Number(year);if(!Number.isFinite(y)||!year)return false;
  const range=value.match(/^(\d{4})\s*-\s*(\d{4})$/);if(range)return y>=Number(range[1])&&y<=Number(range[2]);
  const open=value.match(/^(>=|<=|>|<)\s*(\d{4})$/);if(open){const n=Number(open[2]);return open[1]==='>='?y>=n:open[1]==='<='?y<=n:open[1]==='>'?y>n:y<n;}
  return String(year).startsWith(value);
 }
 /* extra: the paper's note and annotation text, already folded by norm() when
    the panel indexed them. They are part of the paper's one document: the
    plain words see them in hay, note: sees the note text and annotation: the
    annotation text, so -x, OR and field prefixes all see the same thing. */
 function termHit(item,hay,term,starts,extra){
  const f=term.field;
  // "a" in quotes is the text a, not an initial.
  if(!f)return term.phrase?hay.includes(term.value):hit(hay,term.value,starts);
  if(f==='year')return yearTerm(term.value,item.year);
  if(f==='tag')return (item.tags||[]).some(t=>norm(t).includes(term.value));
  if(f==='collection')return (item.collectionNames||[]).some(n=>norm(n).includes(term.value));
  if(f==='journal')return journalScore(journalKeysOf(item),term.value)!==null;
  const h=f==='annotation'?(extra&&extra.annotation)||'':f==='note'&&extra&&extra.note?norm(fieldText(item,f))+' '+extra.note:norm(fieldText(item,f));
  return term.phrase?h.includes(term.value):hit(h,term.value,INITIAL.test(term.value)?wordsOf(h):null);
 }
 /* The notes and annotations boxes: the library box's own syntax (OR, -word,
    ( ), "phrase", field:) over one text. note: and annotation: are that text;
    title:, author:, journal:, year:, tag: ask the paper it belongs to, when
    one is given. Plain words stay in the text alone, as before. */
 function matchesQuery(value,query,paper){
  if(!text(query).trim())return true;
  const tree=parseTree(query),hay=norm(value);
  const starts=parseQuery(query).some(t=>INITIAL.test(t.value))?wordsOf(hay):null;
  return evalTree(tree,paper||{},hay,starts,{annotation:hay,note:hay});
 }
 /* ---- 저널 이름 · ISO 4 약어 · 약칭 ----
    "Nat Methods", "Proc Natl Acad Sci", "PNAS", "NAR" and "JACS" all name a
    journal. Each journal is known by its full title, every abbreviation the
    library or the plugin's journal table gives it, and the acronym of its
    significant words, all folded to lower-case words with no punctuation.
    A query scores 0 for an exact name, abbreviation or acronym, 1 for a
    prefix, 2 for a substring or words that each begin a word, and null for
    no match. */
 const jfold=value=>text(value).normalize('NFKD').replace(/\p{M}+/gu,'').normalize('NFC').toLowerCase().replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
 const J_STOP=new Set(['of','the','and','in','for','on','a','an','at','to','de','der','des','du','la','le','et','und','di','del','della']);
 function journalKeys(venue,abbreviations=[]){
  const names=[...new Set([venue,...abbreviations].map(jfold).filter(Boolean))],acr=new Set();
  for(const name of names){
   const words=name.split(' ').filter(word=>word&&!J_STOP.has(word));
   if(words.length>=2)acr.add(words.map(word=>word[0]).join(''));
   // "...of Sciences of the United States of America" is PNAS, not PNASUSA.
   const bare=words.filter(word=>!['united','states','america','usa'].includes(word));
   if(bare.length>=2&&bare.length<words.length)acr.add(bare.map(word=>word[0]).join(''));
  }
  return {names,acr:[...acr],compact:names.map(name=>name.replace(/ /g,''))};
 }
 function journalScore(keys,query){
  const q=jfold(query);if(!q)return 3;
  const qc=q.replace(/ /g,'');
  if(keys.names.includes(q)||keys.compact.includes(qc)||keys.acr.includes(qc))return 0;
  if(keys.names.some(name=>name.startsWith(q))||(qc.length>=2&&keys.acr.some(a=>a.startsWith(qc))))return 1;
  const parts=q.split(' ');
  if(keys.names.some(name=>name.includes(q)||parts.every(part=>name.split(' ').some(word=>word.startsWith(part)))))return 2;
  return null;
 }
 const JOURNAL_KEYS=new Map();
 function journalKeysOf(item){
  const abbreviations=[...(item.venueAbbrs||[]),item.journalAbbr].filter(Boolean),id=text(item.venue)+'\u0001'+abbreviations.join('\u0001');
  let keys=JOURNAL_KEYS.get(id);
  if(!keys){if(JOURNAL_KEYS.size>3000)JOURNAL_KEYS.clear();keys=journalKeys(item.venue,abbreviations);JOURNAL_KEYS.set(id,keys);}
  return keys;
 }
 /* Journals in `items`, best match first for `query`: one row per venue with its
    count and a short name to show beside it. */
 function journalChoices(items,query=''){
  const byVenue=new Map();
  for(const item of items){
   const venue=text(item.venue).trim();if(!venue)continue;
   let row=byVenue.get(venue);if(!row){row={venue,count:0,abbreviations:new Set(),keys:null};byVenue.set(venue,row);}
   row.count++;for(const a of [...(item.venueAbbrs||[]),item.journalAbbr])if(a)row.abbreviations.add(text(a));
  }
  const out=[];
  for(const row of byVenue.values()){
   row.keys=journalKeys(row.venue,[...row.abbreviations]);
   const score=journalScore(row.keys,query);if(score===null)continue;
   const shown=[...row.abbreviations].find(a=>jfold(a)&&jfold(a)!==jfold(row.venue))||'';
   out.push({venue:row.venue,count:row.count,score,abbreviation:shown});
  }
  return out.sort((a,b)=>a.score-b.score||b.count-a.count||a.venue.localeCompare(b.venue));
 }
 /* Saved single-value filters from before the rule builder, as rules. */
 function legacyRules(old){
  const rules=[];if(!old||typeof old!=='object')return rules;
  if(old.type)rules.push({id:'legacy-type',kind:'type',mode:'in',values:[old.type]});
  if(old.status)rules.push({id:'legacy-status',kind:'status',mode:'in',values:[old.status]});
  if(old.tag)rules.push({id:'legacy-tag',kind:'tag',mode:'in',values:[old.tag],children:true});
  if(num(old.ratingMin)!==null)rules.push({id:'legacy-rating',kind:'rating',mode:'in',min:num(old.ratingMin),max:''});
  if(num(old.yearFrom)!==null||num(old.yearTo)!==null)rules.push({id:'legacy-year',kind:'year',mode:'in',min:num(old.yearFrom)??'',max:num(old.yearTo)??''});
  return cleanRules(rules);
 }
 /* ---- 규칙 (포함 / 제외) ----
    A rule is {id, kind, mode:'in'|'ex', ...parameters}. Rules AND together;
    a rule asks "does the paper have this?" and 제외 flips the answer, so a
    paper with no value at all (no year, no impact factor) is never "inside"
    a range and always survives an excluded one. Several values inside one
    rule are any-of, or all-of where the rule says all. */
 const RULE_KINDS=['word','type','tag','status','rating','year','collection','journal','impact','citations','pdf','annotation','note','preprint'];
 const RULE_FIELDS=['all','title','author','tag','abstract','note'];
 const LIST_KINDS=new Set(['type','tag','status','collection','journal']);
 const RANGE_KINDS=new Set(['rating','year','impact','citations']);
 const num=v=>v===''||v===null||v===undefined||!Number.isFinite(Number(v))?null:Number(v);
 function ruleActive(rule){
  if(!rule||!RULE_KINDS.includes(rule.kind))return false;
  if(rule.kind==='word')return !!norm(rule.text).trim();
  if(LIST_KINDS.has(rule.kind))return Array.isArray(rule.values)&&rule.values.some(v=>text(v).trim());
  if(RANGE_KINDS.has(rule.kind))return num(rule.min)!==null||num(rule.max)!==null;
  if(rule.kind==='preprint')return rule.value==='preprint'||rule.value==='published';
  return true;
 }
 /* What is read back from saved settings is not trusted: unknown kinds,
    wrong types and runaway lists are dropped, and the result is the shape the
    matcher expects. */
 function cleanRules(list){
  const out=[],seen=new Set();
  for(const raw of Array.isArray(list)?list.slice(0,40):[]){
   if(!raw||typeof raw!=='object'||!RULE_KINDS.includes(raw.kind))continue;
   const rule={id:text(raw.id).slice(0,40)||'r'+(out.length+1),kind:raw.kind,mode:raw.mode==='ex'?'ex':'in'};
   if(seen.has(rule.id))rule.id+='-'+out.length;seen.add(rule.id);
   if(rule.kind==='word'){rule.text=text(raw.text).slice(0,200);rule.field=RULE_FIELDS.includes(raw.field)?raw.field:'all';rule.phrase=raw.phrase!==false;}
   else if(LIST_KINDS.has(rule.kind)){rule.values=(Array.isArray(raw.values)?raw.values:[]).map(v=>text(v).trim().slice(0,300)).filter(Boolean).slice(0,200);
    if(rule.kind==='tag'){rule.all=!!raw.all;rule.children=raw.children!==false;}
    if(rule.kind==='collection')rule.sub=raw.sub!==false;}
   else if(RANGE_KINDS.has(rule.kind)){rule.min=num(raw.min)===null?'':num(raw.min);rule.max=num(raw.max)===null?'':num(raw.max);}
   else if(rule.kind==='preprint')rule.value=raw.value==='published'?'published':'preprint';
   if(ruleActive(rule))out.push(rule);
  }
  return out;
 }
 function cleanRulesByTab(map){
  const out={};
  if(map&&typeof map==='object'&&!Array.isArray(map))for(const tab of Object.keys(map).slice(0,40)){const rules=cleanRules(map[tab]);if(rules.length)out[tab]=rules;}
  return out;
 }
 const hasTag=(item,tag,children)=>(item.tags||[]).some(t=>t===tag||(children&&t.startsWith(tag+'/')));
 function ruleHas(item,rule,ctx={}){
  switch(rule.kind){
   case 'word':{
    const q=norm(rule.text).trim();if(!q)return true;
    const allText=[item.title,item.authors,item.venue,item.doi,item.abstract,item.year,item.itemType,item.issn,item.remark,...(item.noteTitles||[]),...(item.tags||[])].join(' ');
    const h=norm(!rule.field||rule.field==='all'?allText:rule.field==='tag'?(item.tags||[]).join(' · '):fieldText(item,rule.field));
    if(rule.phrase!==false)return h.includes(q);
    const starts=wordsOf(h);return q.split(/\s+/).every(w=>hit(h,w,starts));}
   case 'type':return rule.values.includes(item.itemType);
   case 'tag':{const test=t=>hasTag(item,t,rule.children!==false);return rule.all?rule.values.every(test):rule.values.some(test);}
   case 'status':return rule.values.includes(item.status||'unread');
   case 'collection':{
    const mine=new Set((item.collectionIDs||[]).map(String));
    const test=id=>{if(rule.sub!==false&&ctx.descendants?.get(String(id)))for(const d of ctx.descendants.get(String(id)))if(mine.has(d))return true;return mine.has(String(id));};
    return rule.values.some(test);}
   case 'journal':{const v=norm(item.venue).trim();return !!v&&rule.values.some(x=>norm(x).trim()===v);}
   case 'rating':return inRange(Number(item.rating)||0,rule);
   case 'year':return item.year!==''&&item.year!=null&&inRange(Number(item.year),rule);
   case 'impact':return num(item.impactFactor)!==null&&inRange(Number(item.impactFactor),rule);
   case 'citations':return num(item.citations)!==null&&inRange(Number(item.citations),rule);
   case 'pdf':return Number(item.pdfCount)>0;
   case 'annotation':return Number(item.annotations)>0;
   case 'note':return Number(item.noteCount)>0;
   case 'preprint':return rule.value==='preprint'?item.itemType==='preprint':item.itemType!=='preprint';
  }
  return true;
 }
 function inRange(value,rule){
  if(!Number.isFinite(value))return false;
  const lo=num(rule.min),hi=num(rule.max);
  return (lo===null||value>=lo)&&(hi===null||value<=hi);
 }
 const ruleKeeps=(item,rule,ctx)=>ruleHas(item,rule,ctx)!==(rule.mode==='ex');
 function applyRules(items,rules,ctx={},skipID=null){
  const live=(rules||[]).filter(r=>ruleActive(r)&&r.id!==skipID);
  return live.length?items.filter(item=>live.every(rule=>ruleKeeps(item,rule,ctx))):items;
 }
 /* How many papers each value of a list rule would find, given every other
    rule (and the box's own filters, which the caller has already applied to
    `items`). Counted from the library data already in memory. */
 function countOptions(items,kind,{rules=[],ctx={},skipID=null,children=true}={}){
  const pool=applyRules(items,rules,ctx,skipID),counts=new Map(),add=(key,item,seen)=>{if(!key||seen.has(key))return;seen.add(key);counts.set(key,(counts.get(key)||0)+1);};
  const allTags=kind==='tag'?new Set(items.flatMap(i=>i.tags||[])):null;
  for(const item of pool){
   const seen=new Set();
   if(kind==='type')add(item.itemType,item,seen);
   else if(kind==='status')add(item.status||'unread',item,seen);
   else if(kind==='journal')add(text(item.venue).trim(),item,seen);
   else if(kind==='tag')for(const t of item.tags||[]){add(t,item,seen);if(children)for(let i=t.lastIndexOf('/');i>0;i=t.lastIndexOf('/',i-1)){const parent=t.slice(0,i);if(allTags.has(parent))add(parent,item,seen);}}
   else if(kind==='collection'){
    for(const id of item.collectionIDs||[]){add(String(id),item,seen);if(children&&ctx.ancestors)for(const a of ctx.ancestors.get(String(id))||[])add(a,item,seen);}
   }
  }
  return counts;
 }
 /* descendants: id -> Set(id and everything under it); ancestors: id -> [parents]. */
 function collectionContext(collections){
  const byID=new Map((collections||[]).map(c=>[String(c.id),c])),descendants=new Map(),ancestors=new Map();
  for(const c of byID.values()){
   const chain=[];let at=c.parentID!=null?byID.get(String(c.parentID)):null,guard=0;
   while(at&&guard++<50){chain.push(String(at.id));at=at.parentID!=null?byID.get(String(at.parentID)):null;}
   ancestors.set(String(c.id),chain);
   for(const parent of [String(c.id),...chain]){if(!descendants.has(parent))descendants.set(parent,new Set());descendants.get(parent).add(String(c.id));}
  }
  return {descendants,ancestors,names:new Map([...byID].map(([id,c])=>[id,c.name]))};
 }
 const KIND_LABELS={word:'단어',type:'유형',tag:'태그',status:'읽기 상태',rating:'별점',year:'연도',collection:'컬렉션',journal:'저널',impact:'IF',citations:'인용 수',pdf:'첨부 PDF',annotation:'주석',note:'노트',preprint:'Preprint/출판본'};
 const STATUS_LABELS={unread:'안 읽음',reading:'읽는 중',done:'완료'};
 const FIELD_LABELS={all:'전체',title:'제목',author:'저자',tag:'태그',abstract:'초록',note:'메모·노트'};
 /* The chip's words, without the 제외 prefix: "태그: a, b 외 2", "연도: 2018–2022".
    `t` puts the fixed words through the panel's translator. */
 function describeRule(rule,{kindLabel=x=>x,collectionName=x=>x,t=x=>x}={}){
  const list=(values,map=x=>x)=>{const shown=values.slice(0,2).map(map).join(', ');return values.length>2?`${shown} ${t('외 {0}').replace('{0}',values.length-2)}`:shown;};
  const range=(unit='')=>{const lo=num(rule.min),hi=num(rule.max);return lo!==null&&hi!==null?(lo===hi?`${lo}${unit}`:`${lo}–${hi}${unit}`):lo!==null?`${lo}${unit} ${t('이상')}`:`${hi}${unit} ${t('이하')}`;};
  const label=t(KIND_LABELS[rule.kind]||'');
  switch(rule.kind){
   case 'word':return `${rule.field&&rule.field!=='all'?t(FIELD_LABELS[rule.field]):label}: ${rule.phrase===false?rule.text:'“'+rule.text+'”'}`;
   case 'type':return `${label}: ${list(rule.values,kindLabel)}`;
   case 'tag':return `${label}${rule.all&&rule.values.length>1?' ('+t('모두')+')':''}: ${list(rule.values)}`;
   case 'status':return `${label}: ${list(rule.values,v=>t(STATUS_LABELS[v]||v))}`;
   case 'collection':return `${label}: ${list(rule.values,collectionName)}${rule.sub!==false?' +'+t('하위'):''}`;
   case 'journal':return `${label}: ${list(rule.values)}`;
   case 'rating':return `${label}: ${range(t('점'))}`;
   case 'year':case 'impact':case 'citations':return `${label}: ${range()}`;
   case 'pdf':case 'annotation':case 'note':return `${label} ${t('있음')}`;
   case 'preprint':return t(rule.value==='published'?'출판본':'Preprint');
  }
  return label;
 }
 function filter(items,options={}) {
  const terms=parseQuery(options.query),initials=terms.some(t=>!t.field&&INITIAL.test(t.value)),rules=(options.rules||[]).filter(ruleActive);
  const tree=isBoolean(options.query)?parseTree(options.query):null,records=options.records||null;
  return items.filter(item=>{
   // The reader's own memo counts: a paper is found by what was written about it.
   const extra=records?(records.get?records.get(String(item.id)):records(String(item.id))):null;
   const hay=norm([item.title,item.authors,item.venue,item.doi,item.abstract,item.year,item.itemType,item.issn,item.remark,...(item.tags||[])].join(' '))
    +(extra?' '+(extra.note||'')+' '+(extra.annotation||''):'');
   const starts=initials?wordsOf(hay):null;
   return (tree?evalTree(tree,item,hay,starts,extra):terms.every(t=>termHit(item,hay,t,starts,extra)!==t.neg)) && (!options.type||item.itemType===options.type)
    && (!options.tag||(item.tags||[]).some(t=>t===options.tag||t.startsWith(options.tag+'/')))
    && (!options.status||item.status===options.status)
    && (!options.ratingMin||Number(item.rating)>=Number(options.ratingMin))
    && (!options.yearFrom||Number(item.year)>=Number(options.yearFrom)) && (!options.yearTo||Number(item.year)<=Number(options.yearTo))
    && (!rules.length||rules.every(rule=>ruleKeeps(item,rule,options.context)));
  });
 }
 function sortItems(items,order='library'){
  const result=[...items];
  const field=({'year-desc':'year','citations-desc':'citations','rating-desc':'rating','time-desc':'seconds','if-desc':'impactFactor'})[order];
  if(order==='title')result.sort((a,b)=>text(a.title).localeCompare(text(b.title))||text(a.id).localeCompare(text(b.id)));
  else if(field)result.sort((a,b)=>{const value=item=>item[field]!==null&&item[field]!==undefined&&item[field]!==''&&Number.isFinite(Number(item[field]))?Number(item[field]):-Infinity;return (value(b)-value(a)||0)||text(a.title).localeCompare(text(b.title))||text(a.id).localeCompare(text(b.id));});
  return result;
 }
 function csv(rows){return rows.map(row=>row.map(value=>{let s=text(value);if(typeof value!=='number'&&/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(',')).join('\r\n');}
 function matrix(items,fields=['title','authors','year','venue','doi','citations','impactFactor'],transpose=false){
  const rows=[fields,...items.map(item=>fields.map(field=>item[field]??''))];
  return transpose?rows[0].map((_,i)=>rows.map(row=>row[i])):rows;
 }
 function layout(graph,width=760,height=480){
  const nodes=graph.nodes.slice(0,180).map((n,i)=>({...n,id:String(n.id),x:width/2+Math.cos(i*2.399963)*Math.sqrt(i+1)*21,y:height/2+Math.sin(i*2.399963)*Math.sqrt(i+1)*17}));
  const byID=new Map(nodes.map(n=>[n.id,n]));const edges=graph.edges.filter(e=>byID.has(String(e.source))&&byID.has(String(e.target)));
  for(let step=0;step<45;step++){
   const forces=new Map(nodes.map(n=>[n.id,{x:0,y:0}]));
   for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i],b=nodes[j],dx=a.x-b.x,dy=a.y-b.y,d2=Math.max(25,dx*dx+dy*dy),power=400/d2;
    forces.get(a.id).x+=dx*power;forces.get(a.id).y+=dy*power;forces.get(b.id).x-=dx*power;forces.get(b.id).y-=dy*power;
   }
   for(const edge of edges){const a=byID.get(String(edge.source)),b=byID.get(String(edge.target)),dx=b.x-a.x,dy=b.y-a.y;forces.get(a.id).x+=dx*.018;forces.get(a.id).y+=dy*.018;forces.get(b.id).x-=dx*.018;forces.get(b.id).y-=dy*.018;}
   for(const n of nodes){const f=forces.get(n.id);n.x=Math.max(25,Math.min(width-25,n.x+Math.max(-8,Math.min(8,f.x+(width/2-n.x)*.005))));n.y=Math.max(25,Math.min(height-25,n.y+Math.max(-8,Math.min(8,f.y+(height/2-n.y)*.005))));}
  }
  return {nodes,edges,truncated:graph.nodes.length>nodes.length||!!graph.truncated};
 }
 function progress(entry={}){
  const pages=entry.pageTimes&&typeof entry.pageTimes==='object'?entry.pageTimes:{};
  const total=Number.isInteger(entry.totalPages)&&entry.totalPages>0?entry.totalPages:0;
  // A page counts as read after five seconds on it, the same line the page strip draws between a glance and reading; scrolling from the first page to the references in ten seconds used to "read" ten pages.
  const visited=Object.keys(pages).filter(k=>/^\d+$/.test(k)&&Number(k)<total&&Number(pages[k])>=5).length;
  return {total,visited,percent:total?Math.round(visited/total*100):null,pages};
 }
 function id(cache,prefix){cache.workspaceSequence=(Number(cache.workspaceSequence)||0)+1;return prefix+'-'+cache.workspaceSequence+'-'+Date.now().toString(36);}
 function createBoard(cache,name){if(!text(name).trim())throw new Error('보드 이름을 입력하세요.');cache.boards||=[];if(cache.boards.length>=100)throw new Error('보드는 100개까지 만들 수 있습니다. 쓰지 않는 보드를 지우세요.');const b={id:id(cache,'board'),name:text(name).trim().slice(0,200),nodes:[],edges:[]};cache.boards.push(b);return b;}
 function addToBoard(cache,board,items){if(board.nodes.length+items.length>500)throw new Error('보드 하나에 항목은 500개까지입니다. 몇 개를 빼고 다시 넣으세요.');for(const item of items){if(board.nodes.some(n=>n.itemID===String(item.id)))continue;const i=board.nodes.length;board.nodes.push({id:id(cache,'card'),itemID:String(item.id),label:text(item.title),note:'',color:'#ffffff',x:25+(i%3)*220,y:25+Math.floor(i/3)*220});}return board;}
 function addBoardNote(cache,board,value){if(board.nodes.length>=500)throw new Error('보드 하나에 항목은 500개까지입니다. 몇 개를 빼고 다시 넣으세요.');const i=board.nodes.length;const n={id:id(cache,'note'),itemID:null,label:'메모',note:text(value).slice(0,50000),color:'#f3f4f6',x:25+(i%3)*220,y:25+Math.floor(i/3)*220};board.nodes.push(n);return n;}
 function moveCard(board,id,x,y){const n=board.nodes.find(n=>n.id===id);if(!n||![x,y].every(Number.isFinite))return false;n.x=Math.max(0,Math.min(10000,x));n.y=Math.max(0,Math.min(10000,y));return true;}
 function linkCards(board,from,to){if(from===to||![from,to].every(id=>board.nodes.some(n=>n.id===id)))throw new Error('서로 다른 두 카드를 선택하세요.');if(!board.edges.some(e=>(e.source===from&&e.target===to)||(e.source===to&&e.target===from)))board.edges.push({source:from,target:to});}
 function removeCard(board,id){board.nodes=board.nodes.filter(n=>n.id!==id);board.edges=board.edges.filter(e=>e.source!==id&&e.target!==id);}
 function renameBoard(board,name){name=text(name).trim();if(!name)throw new Error('보드 이름을 입력하세요.');board.name=name.slice(0,200);return board;}
 function updateCard(board,id,changes){
  const card=board.nodes.find(n=>n.id===id);if(!card)throw new Error('카드를 찾지 못했습니다. 보드를 새로 고친 뒤 다시 시도하세요.');
  const next={};
  if('label' in changes){next.label=text(changes.label).trim().slice(0,500);if(!next.label)throw new Error('카드 제목을 입력하세요.');}
  if('color' in changes){if(!/^#[a-f\d]{6}$/i.test(changes.color))throw new Error('카드 색상은 #RRGGBB 형식으로 적으세요.');next.color=changes.color.toLowerCase();}
  if('note' in changes)next.note=text(changes.note).slice(0,50000);
  Object.assign(card,next);return card;
 }
 function unlinkCards(board,from,to){const before=board.edges.length;board.edges=board.edges.filter(e=>!((e.source===from&&e.target===to)||(e.source===to&&e.target===from)));return before-board.edges.length;}
 function deleteBoard(cache,id){const board=(cache.boards||[]).find(b=>b.id===id);if(!board)return null;cache.boards=cache.boards.filter(b=>b.id!==id);cache.boardTrash=[...(cache.boardTrash||[]),board].slice(-20);return board;}
 function restoreBoard(cache){const board=cache.boardTrash?.at(-1);if(!board)return null;if((cache.boards||[]).some(b=>b.id===board.id))throw new Error('같은 이름의 보드가 이미 있습니다. 다른 이름을 쓰세요.');cache.boardTrash.pop();cache.boards=[...(cache.boards||[]),board];return board;}
 /* 주석 바구니: annotations gathered across filters, papers and searches,
    kept per library in the cache ({[libraryID]: {items, note}}), in the
    order the reader put them. Each entry keeps enough to be shown and cited
    when its paper is outside the current scope. */
 const BASKET_LIMIT=500;
 function basketStore(cache,libraryID,create){
  const all=cache.annotationBasket&&typeof cache.annotationBasket==='object'&&!Array.isArray(cache.annotationBasket)?cache.annotationBasket:(create?(cache.annotationBasket={}):{});
  const key=String(libraryID??'');
  let store=all[key];
  if(!store||typeof store!=='object'||!Array.isArray(store.items)){if(!create)return {items:[]};store=all[key]={items:[]};}
  return store;
 }
 function basketEntry(a){
  const paper=a?.paper&&typeof a.paper==='object'?a.paper:null;
  const cut=(value,n)=>text(value).slice(0,n);
  return {id:text(a?.id),key:text(a?.key),paper:text(paper?.id??(typeof a?.paper==='string'?a.paper:a?.parentID??'')),attachment:text(a?.attachment??a?.attachmentID??''),
   text:cut(a?.text,1200),comment:cut(a?.comment,600),color:text(a?.color).toLowerCase(),page:text(a?.page??a?.pageLabel??(Number.isInteger(a?.pageIndex)?a.pageIndex+1:'')),
   pageIndex:Number.isInteger(a?.pageIndex)?a.pageIndex:null,type:text(a?.type),
   paperTitle:cut(paper?.title??a?.paperTitle,300),authors:cut(paper?.authors??a?.authors,300),year:text(paper?.year??a?.year).slice(0,4),venue:cut(paper?.venue??a?.venue,200),doi:text(paper?.doi??a?.doi).slice(0,200)};
 }
 function basketItems(cache,libraryID){return basketStore(cache||{},libraryID,false).items.filter(e=>e&&e.id);}
 function basketAdd(cache,libraryID,marks){
  const store=basketStore(cache,libraryID,true),have=new Set(store.items.map(e=>e.id));
  for(const mark of marks||[]){const entry=basketEntry(mark);if(!entry.id||have.has(entry.id)||store.items.length>=BASKET_LIMIT)continue;have.add(entry.id);store.items.push(entry);}
  return store.items;
 }
 function basketRemove(cache,libraryID,ids){const out=new Set((ids||[]).map(String)),store=basketStore(cache,libraryID,true);store.items=store.items.filter(e=>!out.has(e.id));return store.items;}
 // To an index, or by a step with {relative:true}; clamped at both ends.
 function basketMove(cache,libraryID,id,to,{relative=false}={}){
  const store=basketStore(cache,libraryID,true),from=store.items.findIndex(e=>e.id===String(id));
  if(from<0)return false;
  const target=Math.max(0,Math.min(store.items.length-1,relative?from+Number(to):Number(to)));
  if(target===from||!Number.isFinite(target))return false;
  const [entry]=store.items.splice(from,1);store.items.splice(target,0,entry);return true;
 }
 function basketClear(cache,libraryID){const store=basketStore(cache,libraryID,true),removed=store.items;store.items=[];return removed;}
 function basketRestore(cache,libraryID,removed){const store=basketStore(cache,libraryID,true),have=new Set(store.items.map(e=>e.id));store.items=[...(removed||[]).filter(e=>e&&!have.has(e.id)),...store.items].slice(0,BASKET_LIMIT);return store.items;}
 // What one note is made of: the ids in order.
 function basketSignature(list){return (list||[]).map(e=>e.id).join(',');}
 // Consecutive entries of one paper, so a synthesis note keeps the basket's order with a heading per run.
 function basketRuns(list){const runs=[];for(const e of list||[]){const last=runs[runs.length-1];if(last&&last.paper===e.paper)last.ids.push(e.id);else runs.push({paper:e.paper,ids:[e.id]});}return runs;}
 const familyOf=name=>{name=text(name).trim();if(!name)return '';if(name.includes(','))return name.split(',')[0].trim();const parts=name.split(/\s+/);return parts[parts.length-1];};
 const authorList=value=>text(value).split(/\s*;\s*|\s+and\s+/).map(s=>s.trim()).filter(Boolean);
 function basketCitation(e){const people=authorList(e.authors),first=familyOf(people[0])||text(e.paperTitle).split(/\s+/).slice(0,3).join(' ')||'?';return `(${first}${people.length>1?' et al.':''}${e.year?' '+e.year:''}${e.page?', p. '+e.page:''})`;}
 function basketReference(e){
  const people=authorList(e.authors).map(name=>{if(name.includes(','))return name;const parts=name.split(/\s+/),family=parts.pop();return family+(parts.length?', '+parts.map(p=>p[0]+'.').join(' '):'');});
  const who=people.length>3?people.slice(0,3).join(', ')+', et al.':people.join(', ');
  return `- ${who?who+' ':''}${e.year?'('+e.year+'). ':''}${text(e.paperTitle)||'?'}.${e.venue?' *'+e.venue+'*.':''}${e.doi?' https://doi.org/'+e.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i,''):''}`;
 }
 /* Markdown for pasting into a draft: each annotation a quote, its memo
    under it, a citation with the page and a link back to the place; one
    reference per paper at the end. attachmentKey(id) gives the PDF's key for
    the link (none: no link). */
 function basketMarkdown(list,{title='',attachmentKey=()=> '',route='library',labels={}}={}){
  const L={references:'References',open:'open',image:'[image annotation]',ink:'[ink annotation]',...labels};
  const lines=[`# ${text(title)||'Annotations'}`,''];
  const seen=new Map();
  for(const e of list||[]){
   const body=text(e.text).trim()||(e.type==='image'?L.image:e.type==='ink'?L.ink:'');
   if(body)lines.push(...body.split(/\r?\n/).map(line=>'> '+line));
   const key=text(attachmentKey(e.attachment));
   const link=key&&e.key?` · [${L.open}](zotero://open-pdf/${route}/items/${key}?${e.pageIndex!=null?'page='+(e.pageIndex+1)+'&':e.page&&/^\d+$/.test(e.page)?'page='+e.page+'&':''}annotation=${e.key})`:'';
   lines.push((body?'>\n> — ':'— ')+basketCitation(e)+link);
   if(text(e.comment).trim())lines.push('',text(e.comment).trim());
   lines.push('');
   if(e.paper&&!seen.has(e.paper))seen.set(e.paper,e);
  }
  if(seen.size){lines.push(`## ${L.references}`,'');for(const e of seen.values())lines.push(basketReference(e));lines.push('');}
  return lines.join('\n');
 }
 const api={matchesQuery,journalKeys,journalScore,journalChoices,legacyRules,parseQuery,parseTree,isBoolean,plainQuery,syntaxQuery,RULE_KINDS,RULE_FIELDS,RULE_LABELS:KIND_LABELS,FIELD_LABELS,STATUS_LABELS,ruleActive,cleanRules,cleanRulesByTab,ruleHas,applyRules,countOptions,collectionContext,describeRule,filter,sortItems,norm,matches,relevance,rankByQuery,csv,matrix,layout,progress,createBoard,addToBoard,addBoardNote,moveCard,linkCards,removeCard,renameBoard,updateCard,unlinkCards,deleteBoard,restoreBoard,BASKET_LIMIT,basketEntry,basketItems,basketAdd,basketRemove,basketMove,basketClear,basketRestore,basketSignature,basketRuns,basketCitation,basketMarkdown,basketStore};
 root.CustomStyleWorkspace=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
