/* Read the paper aloud: free, local, no network.

   Two engines sit behind one small contract, and one player drives either:

     engine.speak({text, lang, voiceURI, rate, onstart, onend, onerror, oninterrupt})
     engine.cancel()          drop everything queued or speaking
     engine.pause()/resume()  only when engine.supportsPause
     engine.voices()          [{voiceURI, name, lang, localService, default}]

   - speechSynthesis of the reader's own window. Gecko on macOS speaks with the
     system voices (free). Utterances are queued by the engine itself, so the
     player can hand it the next sentence before the current one ends and there
     is no gap.
     It is shared with everything else in the window, Zotero's own Read Aloud
     included: anyone's cancel() drops everyone's queue. An utterance stopped by
     a cancel this engine did not make is reported as oninterrupt(), so the
     player can say "paused" instead of playing on in silence.
   - macOS `say`, when speechSynthesis has no voices. `say` cannot be paused, so
     the player pauses by killing the process and resumes by speaking again from
     the START OF THE CURRENT SENTENCE (never from the middle of a word). That is
     the whole reason the player works one sentence at a time.

   The player is a plain state machine over a list of sentence units:
   {text, page, rects, sectionIndex, sentenceIndex, kind, sectionLabel}. It
   never touches the DOM, the network or a library item: the caller supplies the
   engine, the clock, and what to do when a sentence has been spoken. */
(function(root){
 'use strict';
 const RATE_MIN=0.8,RATE_MAX=1.8,CHUNK_MAX=400,CREDIT_MAX_SECONDS=120;
 const clamp=(value,low,high,fallback)=>{const n=Number(value);return Number.isFinite(n)?Math.min(high,Math.max(low,n)):fallback;};
 const clean=text=>String(text==null?'':text).replace(/\s+/g,' ').trim();

 /* ---- sentences -------------------------------------------------------- */
 const ABBREVIATION=/(?:^|[\s(])(?:e\.g|i\.e|et al|fig|figs|eq|eqs|ref|refs|vs|cf|approx|dr|prof|no|vol|sec|tab|resp|ca|mr|ms|mrs|st|inc|ltd|co|al|sp|spp|var|subsp)\.$/i;
 function splitSentences(text){
  const source=clean(text);if(!source)return [];
  const out=[];let start=0;const boundary=/[.!?。？！…]+["'”’)\]]*(?=\s)/g;let m;
  while((m=boundary.exec(source))){
   const end=m.index+m[0].length,head=source.slice(start,end),tail=source.slice(end).trimStart();
   if(!tail)break;
   if(ABBREVIATION.test(head))continue;
   if(/(?:^|\s)[A-Z]\.$/.test(head))continue;               // an initial: "J. Smith"
   if(/^[a-z(\[]/.test(tail)&&/[.]$/.test(m[0]))continue;     // "...fig. shows" keeps going; "다." and "?" do not
   out.push(head.trim());start=end;
  }
  const rest=source.slice(start).trim();if(rest)out.push(rest);
  return out;
 }
 /* The engine gets pieces of at most CHUNK_MAX characters. Every piece is said with its own intonation (the voice
    falls at its end as at a full stop), so a sentence is cut only when it is very long, and then where a reader would
    breathe: at a semicolon or colon, else a comma, else before "and", "which", "while" ..., outside brackets, nearest the
    middle, never leaving a scrap of a few words and never between a number and its unit. The caller still highlights
    the whole sentence. */
 const CUT_TIERS=[/[;:；：]\s/g,/[,，、]\s/g,/\s(?=(?:and|but|while|whereas|which|although|because|whereby|resulting|suggesting|indicating|including)\s)/g,/\s/g];
 function splitForEngine(text,max=CHUNK_MAX){
  const source=clean(text);if(!source)return [];if(source.length<=max)return [source];
  const depth=[];let d=0;for(const ch of source){if(ch==='('||ch==='[')d++;depth.push(d);if((ch===')'||ch===']')&&d>0)d--;}
  const mid=source.length/2,least=Math.min(60,Math.floor(source.length/4));
  let cut=-1;
  for(let tier=0;tier<CUT_TIERS.length&&cut<0;tier++){
   for(const outside of [true,false]){
    const re=CUT_TIERS[tier];re.lastIndex=0;let m,best=-1,bd=Infinity;
    while((m=re.exec(source))){
     const at=/^\s/.test(m[0])?m.index:m.index+1;
     if(at<least||source.length-at<least)continue;
     if(outside&&depth[at]>0)continue;
     if(tier===3&&/\d$/.test(source.slice(0,at))&&/^\s?\p{L}/u.test(source.slice(at)))continue;   // "50 | micrograms"
     const dd=Math.abs(at-mid);if(dd<bd){bd=dd;best=at;}
    }
    if(best>=0){cut=best;break;}
   }
  }
  if(cut<0)cut=Math.min(max,source.length-1);
  return [...splitForEngine(source.slice(0,cut),max),...splitForEngine(source.slice(cut),max)];
 }
 function detectLanguage(text){
  const sample=String(text||'').slice(0,4000),letters=sample.match(/\p{L}/gu)||[];if(!letters.length)return 'en';
  const count=re=>(sample.match(re)||[]).length;
  const hangul=count(/[가-힣]/g),kana=count(/[぀-ヿ]/g),han=count(/[一-鿿]/g);
  if(hangul/letters.length>0.15)return 'ko';if(kana/letters.length>0.1)return 'ja';if(han/letters.length>0.2)return 'zh';return 'en';
 }
 /* The saved voice when it still exists; otherwise the best installed voice for the language. Quality comes first
    (a premium or enhanced download over the compact voice), then the natural voices people pick for listening
    (Samantha, Alex; Yuna for Korean), then the home region, then the system default. Eloquence voices (Eddy, Flo,
    Grandma, ...) and the novelty voices (Albert, Fred, Bad News, Wobble, ...) come last: in Gecko's alphabetical
    list they come first, so "the first local voice" was an Indian-English voice for English and Eddy for Korean. */
 const NOVELTY=/\b(?:albert|bad ?news|bahh|bells|boing|bubbles|cellos|deranged|wobble|fred|good ?news|hysterical|jester|junior|kathy|organ|princess|superstar|ralph|trinoids|whisper|zarvox)\b/i;
 const ELOQUENCE=/eloquence|^(?:eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
 const FAVOURITES={en:[/^samantha\b|^alex\b/i,/^(?:ava|allison|susan|tom|zoe|evan|nathan|joelle|noelle|serena|daniel|kate|oliver)\b/i],ko:[/^yuna\b|유나/i,/^(?:sora|suhyun|minsu|jian|narae)\b/i]};
 const HOME={en:'us',ko:'kr',ja:'jp',zh:'cn',de:'de',fr:'fr',es:'es',it:'it'};
 function voiceScore(v,code){
  const name=String(v.name||''),id=String(v.voiceURI||''),both=name+' '+id;
  if(NOVELTY.test(name)||NOVELTY.test(id.replace(/^.*voice\./,'')))return -100;
  const tier=/premium/i.test(both)?3:/enhanced|neural|siri/i.test(both)?2:ELOQUENCE.test(name)||/eloquence/i.test(id)?-2:1;
  const fav=FAVOURITES[code]||[];const pref=fav[0]&&fav[0].test(name)?3:fav[1]&&fav[1].test(name)?2:0;
  const region=String(v.lang||'').toLowerCase().replace('_','-').split('-')[1]||'';
  return tier*10+pref+(region===HOME[code]?2:code==='en'&&region==='gb'?1:0)+(v.default?1:0)+(v.localService?0.5:0);
 }
 function pickVoice(voices,lang,savedURI){
  const list=Array.isArray(voices)?voices:[];
  if(savedURI){const keep=list.find(v=>v.voiceURI===savedURI);if(keep)return keep;}
  const code=String(lang||'en').toLowerCase().split(/[-_]/)[0];
  const same=list.filter(v=>String(v.lang||'').toLowerCase().replace('_','-').split('-')[0]===code);
  if(!same.length)return null;
  return same.map((v,i)=>({v,i,s:voiceScore(v,code)})).sort((a,b)=>b.s-a.s||a.i-b.i)[0].v;
 }
 /* The paper's language from its body: a sample spread over all of it, so an English abstract or title page before a
    Korean body does not decide. */
 function paperLanguage(units){
  const body=(Array.isArray(units)?units:[]).filter(u=>u&&u.kind!=='reference'&&u.kind!=='caption');
  if(!body.length)return 'en';
  const step=Math.max(1,Math.floor(body.length/80));const parts=[];
  for(let i=0;i<body.length&&parts.length<80;i+=step)parts.push(clean(body[i].text).slice(0,50));
  return detectLanguage(parts.join(' '));
 }

 /* ---- what the voice is given ------------------------------------------
    The system voices read a paper's glyphs badly or not at all: "µM" as "mu M", "10⁻³" as "ten three", "5′" as
    "five", "±" and "∼" as nothing, a URL letter by letter. speechText turns a sentence into words a listener can
    follow, in the voice's language: English words for an English voice, Korean words for a Korean one. Other
    languages only lose links, superscript citation numbers and stray glyphs. The written sentence is unchanged;
    this is only what is said. */
 const SUP_DIGITS={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
 const supToDigits=s=>s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>SUP_DIGITS[c]);
 const GREEK_EN={α:'alpha',β:'beta',γ:'gamma',δ:'delta',ε:'epsilon',ζ:'zeta',η:'eta',θ:'theta',ι:'iota',κ:'kappa',λ:'lambda',μ:'mu',µ:'mu',ν:'nu',ξ:'xi',π:'pi',ρ:'rho',σ:'sigma',ς:'sigma',τ:'tau',υ:'upsilon',φ:'phi',ϕ:'phi',χ:'chi',ψ:'psi',ω:'omega',Γ:'gamma',Δ:'delta','∆':'delta',Θ:'theta',Λ:'lambda',Ξ:'xi',Π:'pi',Σ:'sigma',Φ:'phi',Ψ:'psi',Ω:'omega'};
 const GREEK_KO={alpha:'알파',beta:'베타',gamma:'감마',delta:'델타',epsilon:'엡실론',zeta:'제타',eta:'에타',theta:'세타',iota:'요타',kappa:'카파',lambda:'람다',mu:'뮤',nu:'뉴',xi:'크사이',pi:'파이',rho:'로',sigma:'시그마',tau:'타우',upsilon:'입실론',phi:'파이',chi:'카이',psi:'프사이',omega:'오메가'};
 /* [singular, plural, Korean]; a molar concentration has no plural. */
 const U=(en,ko,plural=en+'s')=>[en,plural,ko];
 const UNIT_WORDS={
  fM:U('femtomolar','펨토몰','femtomolar'),pM:U('picomolar','피코몰','picomolar'),nM:U('nanomolar','나노몰','nanomolar'),µM:U('micromolar','마이크로몰','micromolar'),μM:U('micromolar','마이크로몰','micromolar'),uM:U('micromolar','마이크로몰','micromolar'),mM:U('millimolar','밀리몰','millimolar'),M:U('molar','몰','molar'),
  nl:U('nanoliter','나노리터'),nL:U('nanoliter','나노리터'),µl:U('microliter','마이크로리터'),μl:U('microliter','마이크로리터'),µL:U('microliter','마이크로리터'),μL:U('microliter','마이크로리터'),ul:U('microliter','마이크로리터'),uL:U('microliter','마이크로리터'),ml:U('milliliter','밀리리터'),mL:U('milliliter','밀리리터'),l:U('liter','리터'),L:U('liter','리터'),
  pg:U('picogram','피코그램'),ng:U('nanogram','나노그램'),µg:U('microgram','마이크로그램'),μg:U('microgram','마이크로그램'),ug:U('microgram','마이크로그램'),mg:U('milligram','밀리그램'),kg:U('kilogram','킬로그램'),
  nm:U('nanometer','나노미터'),µm:U('micrometer','마이크로미터'),μm:U('micrometer','마이크로미터'),um:U('micrometer','마이크로미터'),mm:U('millimeter','밀리미터'),cm:U('centimeter','센티미터'),km:U('kilometer','킬로미터'),m:U('meter','미터'),
  fs:U('femtosecond','펨토초'),ps:U('picosecond','피코초'),ns:U('nanosecond','나노초'),µs:U('microsecond','마이크로초'),μs:U('microsecond','마이크로초'),ms:U('millisecond','밀리초'),s:U('second','초'),sec:U('second','초'),min:U('minute','분'),h:U('hour','시간'),hr:U('hour','시간'),hrs:U('hour','시간'),d:U('day','일'),
  'Å':U('angstrom','옹스트롬'),kDa:U('kilodalton','킬로달톤'),MDa:U('megadalton','메가달톤'),Da:U('dalton','달톤'),bp:U('base pair','염기쌍'),kbp:U('kilobase pair','킬로베이스쌍'),kb:U('kilobase','킬로베이스'),Mb:U('megabase','메가베이스'),nt:U('nucleotide','뉴클레오타이드'),
  kcal:U('kilocalorie','킬로칼로리'),kJ:U('kilojoule','킬로줄'),mol:U('mole','몰'),mmol:U('millimole','밀리몰'),µmol:U('micromole','마이크로몰'),μmol:U('micromole','마이크로몰'),nmol:U('nanomole','나노몰'),pmol:U('picomole','피코몰'),
  U:U('unit','유닛'),Hz:U('hertz','헤르츠','hertz'),kHz:U('kilohertz','킬로헤르츠','kilohertz'),MHz:U('megahertz','메가헤르츠','megahertz'),mV:U('millivolt','밀리볼트'),kV:U('kilovolt','킬로볼트')
 };
 // A bare letter is a unit only after a spaced number ("5 s", "2 L"), or with an exponent ("m²"); "5s", "2d" and "4L" are names.
 const GLUE_NEVER=new Set(['s','d','l','L','U','m']);
 // A bare "l" is too often a microlitre whose µ the PDF's font lost ("20 l"): it is left as written.
 const BARE_NEVER=new Set(['l']);
 const UNIT_ATOM=Object.keys(UNIT_WORDS).sort((a,b)=>b.length-a.length).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
 const EXP='(?:⁻?[¹²³])?';
 const UNIT_RUN=new RegExp(String.raw`(^|[^\p{L}\p{N}.,])(\d[\d,]*(?:\.\d+)?)(\s?)((?:${UNIT_ATOM})${EXP})((?:\s?[/·](?:${UNIT_ATOM})${EXP}|\s(?:${UNIT_ATOM})⁻[¹²³])*)(?![\p{L}\p{N}\-′'’])`,'gu');
 const UNIT_DENOMINATOR=new RegExp(String.raw`(\p{L})/((?:${UNIT_ATOM}))(?![\p{L}\p{N}])`,'gu');
 const EN={degreesC:' degrees Celsius',degreesF:' degrees Fahrenheit',degrees:' degrees',prime:' prime',plus:'plus',minus:'minus',plusMinus:' plus or minus ',times:' times ',timesX:' X',to:' to ',about:'about ',approx:'approximately',per:'per',square:'square ',cubic:'cubic ',link:'a web link',doi:'a DOI',email:'an email address',
  power:(sign,n)=>' to the '+(sign?'minus ':'')+n};
 const KO={degreesC:'도',degreesF:'화씨 도',degrees:'도',prime:' 프라임',plus:'플러스',minus:'마이너스',plusMinus:' 플러스 마이너스 ',times:' 곱하기 ',timesX:'배',to:'에서 ',about:'약 ',approx:'약',per:'퍼',square:'제곱 ',cubic:'세제곱 ',link:'웹 링크',doi:'DOI',email:'이메일 주소',
  power:(sign,n)=>'의 '+(sign?'마이너스 ':'')+n+'승'};
 function unitWords(atom,count,ko){
  const m=/^(.*?)(⁻)?([¹²³])?$/.exec(atom);const w=UNIT_WORDS[m[1]];if(!w)return atom;
  const n=m[3]?SUP_DIGITS[m[3]]:'';const word=ko?w[2]:count==='1'||count===''?w[0]:w[1];
  const power=n==='2'?(ko?KO.square:EN.square):n==='3'?(ko?KO.cubic:EN.cubic):'';
  return {per:!!m[2],text:power+word};
 }
 function speakUnits(s,ko){
  const T=ko?KO:EN;
  s=s.replace(UNIT_RUN,(all,lead,num,space,first,rest,at,whole)=>{
   const base=first.replace(/⁻?[¹²³]$/,'');
   if(!space&&GLUE_NEVER.has(base)||first===base&&BARE_NEVER.has(base))return all;
   if(base==='m'&&first===base)return all;       // "2 m" is too often something else
   // "a 5 ml column": a unit used as an adjective stays singular
   const head=unitWords(first,/\b(?:a|an|one)\s$/i.test(whole.slice(0,at+lead.length))?'1':num,ko);
   const parts=[head.per?T.per+' '+head.text:head.text];
   const re=new RegExp(String.raw`\s?([/·]|\s)((?:${UNIT_ATOM})${EXP})`,'gu');let m;
   while((m=re.exec(rest))){const u=unitWords(m[2],'1',ko);parts.push(m[1]==='/'||u.per?T.per+' '+u.text:u.text);}
   return lead+num+' '+parts.join(' ');
  });
  // "CFU/ml", "U/mg" after a word
  s=s.replace(UNIT_DENOMINATOR,(all,letter,atom)=>{const u=unitWords(atom,'1',ko);return typeof u==='string'?all:letter+' '+T.per+' '+u.text;});
  return s;
 }
 const ROMAN={i:'1',ii:'2',iii:'3',iv:'4',v:'5',vi:'6',vii:'7',viii:'8',ix:'9',x:'10'};
 const NO_OPERAND=/(?:^|[(\[,;:]|\b(?:of|with|at|to|from|in|for|and|or|was|were|is|are|by|only|all|any|when|if|had|have|has|having|showing|show|shows))$/i;
 function speechText(text,lang='en'){
  let s=clean(text);if(!s)return s;
  const code=String(lang||'en').toLowerCase().split(/[-_]/)[0];
  const ko=code==='ko',full=ko||code==='en';const T=ko?KO:EN;
  // addresses are said as what they are, never spelled out
  s=s.replace(/\b(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+?(?=[.,;:)\]]*(?:\s|$))/gi,T.doi);
  s=s.replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)\S+?(?=[.,;:)\]]*(?:\s|$))/gi,T.link);
  s=s.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,T.email);
  // primes, also as the glyphs some publishers' fonts turn them into: "5’-", "5⁰-", "2=-deoxy"
  s=s.replace(/([\p{L}\p{N}])′/gu,'$1'+T.prime).replace(/\s*′\s*/g,' ');
  s=s.replace(/(^|[^\p{L}\p{N}.])([35])[’'⁰](?=\s?-|\s(?:end|UTR|untranslated|terminal|terminus|overhang|to|of)\b|ovh|-?OH\b)/gu,'$1$2'+T.prime);
  s=s.replace(/-([35])[’'⁰](?=[\s.,;:)]|$)/g,' $1'+T.prime);
  s=s.replace(/(\d)=(?=-\p{L}|,\d+=)/gu,'$1'+T.prime);
  s=s.replace(/(\d (?:prime|프라임))(?:\s*-\s*|(?=ovh))(?=[\p{L}\p{N}])/gu,'$1 ').replace(/(\d (?:prime|프라임)),(?=\d)/gu,'$1, ');
  // a substitution arrow set in a font without the glyph ("A ¡ G"), and real arrows
  s=s.replace(/\b([A-Z]) ¡ ([A-Z])\b/g,ko?'$1에서 $2':'$1 to $2').replace(/\s*[→⟶]\s*/g,ko?'에서 ':' to ');
  if(full){
   // powers of ten before anything reads their digits
   const pow=(sign,digits)=>T.power(!!sign,digits);
   s=s.replace(/(\d(?:\.\d+)?)\s?[x×]\s?10\s?([⁻]?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g,(a,n,sign,d)=>n+T.times+'10'+pow(sign,supToDigits(d)));
   s=s.replace(/(\d(?:\.\d+)?)\s?[x×]\s?10\^([−-]?)(\d+)/g,(a,n,sign,d)=>n+T.times+'10'+pow(sign,d));
   s=s.replace(/\b10\^([−-]?)(\d+)/g,(a,sign,d)=>'10'+pow(sign,d));
   s=s.replace(/(^|[^\d.,])10\s?([⁻]?)([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/g,(a,lead,sign,d)=>lead+'10'+pow(sign,supToDigits(d)));
   // temperatures
   s=s.replace(/(\d)\s*[°◦˚º]\s*C(?![A-Za-z])/g,'$1'+T.degreesC).replace(/(\d)\s*[°◦˚º]\s*F(?![A-Za-z])/g,'$1'+T.degreesF).replace(/(\d)\s*[°˚º]/g,'$1'+T.degrees);
   s=s.replace(/\b(at|to|of|from|and|between)\s([−-]?\d+(?:\.\d+)?)\sC(?![\p{L}\p{N}\-])/gu,'$1 $2'+T.degreesC);
   // signs before a number: "−20", "(+5,", "+1/−1"
   s=s.replace(/(^|[\s(\[/,;:=])(?<!\d\s)[−–-](?=\d)/g,'$1'+T.minus+' ').replace(/(^|[\s(\[/,;:])\+(?=\d)/g,'$1'+T.plus+' ');
   s=s.replace(/\s*±\s*/g,T.plusMinus);
   s=speakUnits(s,ko);
   // charges and exponents left after the units: "NAD⁺", "Mg²⁺", "Cl⁻", "x⁻²"
   s=s.replace(/([\p{L}\p{N})\]])([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])(?![⁰¹²³⁴⁵⁶⁷⁸⁹])/gu,(a,b,d,sign)=>b+' '+(d?supToDigits(d)+' ':'')+(sign==='⁺'?T.plus:T.minus));
   s=s.replace(/(\p{L})⁻([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gu,(a,b,d)=>b+pow('-',supToDigits(d)));
   // times: "11,000 × g", "1× PBS", "3 × 5000"
   s=s.replace(/(\d)\s?×\s?(?=g\b)/g,'$1'+T.times).replace(/(\d)×(?=\s\p{L})/gu,'$1'+T.timesX).replace(/\s*×\s*/g,T.times);
   // ranges and approximations
   s=s.replace(/(\d)\s?[–~∼]\s?(?=[−-]?\d)/g,'$1'+T.to);
   s=s.replace(/(^|[\s(\[,;:=<>≤≥])[~∼≈]\s?(?=[−-]?\d|\.\d|minus )/g,'$1'+T.about).replace(/\s*≈\s*/g,' '+T.approx+' ');
   // a bracketed name, "(<3′-end mRNA>/<5′-end mRNA>)", is not a comparison
   s=s.replace(/(^|[(\/\s])<([^<>]{1,40}?)>(?=[\/)\s,.;]|$)/g,'$1$2');
   // comparisons; "* = p < 0.05" is a legend key, not something to read
   s=s.replace(/\*+\s?=\s?/g,'').replace(/\*/g,'');
   const ops=ko?{'≥':'이상','≤':'이하','>':'초과','<':'미만','≠':'과 다름'}:null;
   if(ko){
    s=s.replace(/\s*(>=|<=|≥|≤|≧|≦|≠|>|<)\s*([−-]?\d[\d,]*(?:\.\d+)?)/g,(a,op,n)=>' '+n+' '+ops[op==='>='||op==='≧'?'≥':op==='<='||op==='≦'?'≤':op]);
   }else{
    const WITH={'≥':'greater than or equal to','≤':'less than or equal to','>':'greater than','<':'less than','≠':'not equal to','≫':'much greater than','≪':'much less than'};
    const WITHOUT={'≥':'at least','≤':'at most','>':'more than','<':'less than','≠':'not equal to','≫':'far more than','≪':'far less than'};
    // "<" and ">" only before a number: elsewhere they are brackets ("<3′-end>")
    s=s.replace(/\s?(>=|<=|≥|≤|≧|≦|≠|≫|≪|>|<)\s?/g,(a,op,at,whole)=>{
     const key=op==='>='||op==='≧'?'≥':op==='<='||op==='≦'?'≤':op;
     if((key==='<'||key==='>')&&!/^(?:[−-]?\d|\.\d|about |approximately |minus |plus )/.test(whole.slice(at+a.length)))return a;
     const before=whole.slice(0,at).trimEnd();
     return ' '+(NO_OPERAND.test(before)?WITHOUT[key]:WITH[key])+' ';
    });
   }
   // dashes: a minus sign between letters is a hyphen; an en dash joins names; an em dash is a pause
   s=s.replace(/(\p{L})−(?=\p{L})/gu,'$1-');
   s=s.replace(/([\p{L}\p{N}])\s?–\s?(?=[\p{L}\p{N}])/gu,'$1-').replace(/\s+[–—―]\s+|\s*[—―]\s*/g,', ');
   // abbreviations the voices read letter by letter or as the end of a sentence
   if(ko){
    s=s.replace(/\be\.\s?g\.,?/gi,'예를 들어').replace(/\bi\.\s?e\.,?/gi,'즉').replace(/\bet al\./g,'등').replace(/\bvs\.?(?=\s)/g,'대').replace(/\bFigs?\.\s?(?=\d|S\d)/g,'그림 ').replace(/\bEqs?\.\s?(?=\(?\d)/g,'식 ');
   }else{
    s=s.replace(/\be\.\s?g\.(?=,?)/gi,'for example').replace(/\bi\.\s?e\.(?=,?)/gi,'that is').replace(/\bet al\./g,'et al').replace(/\bvs\.?(?=\s)/g,'versus').replace(/\bcf\.(?=\s)/g,'compare')
     .replace(/\bca\.\s(?=\d)/g,'about ').replace(/\bapprox\.(?=\s)/g,'approximately').replace(/\bresp\.(?=[\s)])/g,'respectively')
     .replace(/\bFigs\.\s?(?=\d|S\d)/g,'Figures ').replace(/\bFig\.\s?(?=\d|S\d)/g,'Figure ').replace(/\bEqs\.\s?(?=\(?\d)/g,'Equations ').replace(/\bEqn?\.\s?(?=\(?\d)/g,'Equation ')
     .replace(/\bRefs\.\s?(?=\d)/g,'References ').replace(/\bRef\.\s?(?=\d)/g,'Reference ').replace(/\bSuppl\.\s?/g,'Supplementary ').replace(/\bTab\.\s?(?=\d|S\d)/g,'Table ').replace(/\bSect\.\s?(?=\d)/g,'Section ').replace(/\bNo\.\s?(?=\d)/g,'number ')
     .replace(/\b(sub)?spp?\.(?=\s)/g,(a,sub)=>sub?'subspecies':'species');
   }
   s=s.replace(/\bpH(?=\d)/g,'pH ');
   s=s.replace(/\((i{1,3}|iv|vi{0,3}|ix|x)\)/g,(a,r)=>'('+ROMAN[r]+')');
   // Greek letters by name, apart from the word they are glued to: "ΔpyrF", "DH5α", "α6"
   const G=Object.keys(GREEK_EN).join('');
   s=s.replace(new RegExp('['+G+']','gu'),(c,at,whole)=>{const name=ko?GREEK_KO[GREEK_EN[c]]:GREEK_EN[c];const l=/[\p{L}\p{N}]/u.test(whole[at-1]||'')?' ':'',r=/[\p{L}\p{N}]/u.test(whole[at+1]||'')?' ':'';return l+name+r;});
   s=s.replace(/(\p{L})·(?=\p{L})/gu,'$1 ').replace(/·/g,' ');
  }
  // superscript numbers still here are citation marks ("WARP v1.09⁵¹", "restriction ³")
  s=s.replace(/\s?[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:[,–-][⁰¹²³⁴⁵⁶⁷⁸⁹]+)*/g,'');
  s=s.replace(/[◦•■□▪▫†‡§¶®™©-]/g,'');
  return s.replace(/\s+([.,;:!?)\]])/g,'$1').replace(/,\./g,'.').replace(/([(\[])\s+/g,'$1').replace(/,\s*,/g,',').replace(/\s{2,}/g,' ').trim()||clean(text);
 }

 /* ---- engines ---------------------------------------------------------- */
 /* Which of our engines last called speak(): the one whose utterance the queue holds. Zotero's own controller
    keeps the same kind of record (lastSpeaker in reader/browser/controller.ts) for the same reason: the queue is
    global, and a cancel() from anyone who does not own it stops someone else's speech. */
 let lastSpeaker=null;
 function speechEngine(win){
  const synth=win&&win.speechSynthesis,Utterance=win&&win.SpeechSynthesisUtterance;const live=new Set();
  // Every cancel() this engine makes, and every queue it finds lost, starts a new epoch; events from an older epoch are not ours to act on.
  let epoch=0;
  const voices=()=>{try{return Array.from(synth.getVoices()||[]);}catch(_){return [];}};
  // Whether the queue is doing anything at all; only a synth that reports both flags can say it is idle.
  const idle=()=>{try{return typeof synth.speaking==='boolean'&&typeof synth.pending==='boolean'&&!synth.speaking&&!synth.pending;}catch(_){return false;}};
  const detach=u=>{u.onstart=null;u.onend=null;u.onerror=null;};
  const engine={name:'speechSynthesis',supportsPause:true,
   available(){return !!synth&&typeof Utterance==='function'&&voices().length>0;},
   voices(){return voices().map(v=>({voiceURI:v.voiceURI,name:v.name,lang:v.lang,localService:!!v.localService,default:!!v.default}));},
   speak({text,lang,voiceURI,rate,onstart,onend,onerror,oninterrupt}){
    const u=new Utterance(text);u.lang=lang||'';u.rate=rate||1;const mine=epoch;
    if(voiceURI){const voice=voices().find(v=>v.voiceURI===voiceURI);if(voice)u.voice=voice;}
    // Gecko drops an utterance nobody holds a reference to, and its end event with it.
    live.add(u);const done=()=>live.delete(u);
    // The queue was emptied under us: drop what is left of ours and report it once, as an interruption.
    const lost=reason=>{epoch++;for(const x of live)detach(x);live.clear();if(lastSpeaker===engine)lastSpeaker=null;if(oninterrupt)oninterrupt(reason);};
    u.onstart=()=>{onstart&&onstart();};
    u.onend=()=>{
     done();
     // Gecko's cancel() ends the utterance being spoken with `end`, not an error. A natural end leaves our next
     // utterance pending; an end after which the queue is idle while we still had sentences waiting is a cancel
     // somebody else made, and the next sentence must not be treated as due.
     if(mine===epoch&&live.size>0&&idle()){lost('interrupted');return;}
     onend&&onend();
    };
    u.onerror=event=>{
     done();
     if(event&&(event.error==='canceled'||event.error==='interrupted')){if(mine===epoch)lost(event.error);return;}
     onerror&&onerror(event&&event.error||'error');
    };
    lastSpeaker=engine;
    synth.speak(u);
   },
   /* Drop what this engine queued. As Zotero's controller does: the handlers come off first, so the `end` the
      cancel fires is not taken for a finished sentence, and the global cancel() is made only while this engine
      owns the queue (it has an utterance there and was the last of ours to speak). */
   cancel(){
    epoch++;
    const owned=live.size>0&&lastSpeaker===engine;
    for(const u of live)detach(u);live.clear();
    if(owned){lastSpeaker=null;try{synth.cancel();}catch(_){}}
   },
   owns(){return live.size>0&&lastSpeaker===engine;},
   /* Whether the window's speech queue is doing anything at all: false while this player thinks it is playing means someone else cancelled it. */
   busy(){try{return !!(synth.speaking||synth.pending);}catch(_){return true;}},
   pause(){try{synth.pause();}catch(_){}},resume(){try{synth.resume();}catch(_){}}};
  return engine;
 }
 /* macOS `say`. `spawn(args, onexit)` starts /usr/bin/say with an argument
    array (no shell, so nothing in the paper text can become a command) and
    returns {kill()}; onexit receives the exit status. Plain Zotero.Utilities
    .Internal.exec cannot be stopped, which is why the runtime supplies a spawn
    built on nsIProcess. */
 const SAY_WPM=200;
 const SAY_VOICES={ko:'Yuna',en:'Samantha',ja:'Kyoko',zh:'Tingting',de:'Anna',fr:'Thomas',es:'Monica',it:'Alice'};
 function sayEngine({spawn,voiceNames=SAY_VOICES}){
  const queue=[];let current=null,generation=0;const broken=new Set();
  function run(){
   if(current||!queue.length)return;
   const utt=queue.shift(),mine=++generation;current={utt,mine};
   const short=String(utt.lang||'').split(/[-_]/)[0],fallbackName=voiceNames[short];
   const name=utt.voiceURI&&!broken.has(utt.voiceURI)?utt.voiceURI:(fallbackName&&!broken.has(fallbackName)?fallbackName:'');
   // 200 words a minute is what the system voices speak at rate 1, so the same slider position sounds the same with either engine.
   const args=[];if(name)args.push('-v',name);args.push('-r',String(Math.round(SAY_WPM*(utt.rate||1))),'--',utt.text);
   // Started after the caller has finished queueing: a synchronous start let the player queue the next sentence between the pieces of this one.
   const start=utt.onstart;if(start)Promise.resolve().then(()=>{if(current&&current.mine===mine)start();});
   let proc;
   try{proc=spawn(args,status=>{
    if(!current||current.mine!==mine)return;       // killed on purpose
    current=null;
    if(status!==0&&name){broken.add(name);queue.unshift({...utt,onstart:null});run();return;}   // that voice is not installed: once more with the system voice
    if(status!==0){utt.onerror&&utt.onerror('say-failed');return;}
    utt.onend&&utt.onend();run();
   });}catch(error){current=null;utt.onerror&&utt.onerror(String(error&&error.message||error));return;}
   current.proc=proc;
  }
  return {name:'say',supportsPause:false,available(){return typeof spawn==='function';},
   voices(){return Object.entries(voiceNames).map(([lang,name])=>({voiceURI:name,name,lang,localService:true,default:false}));},
   speak(utt){queue.push(utt);run();},
   cancel(){queue.length=0;if(current){const proc=current.proc;current=null;generation++;try{proc&&proc.kill();}catch(_){}}},
   pause(){this.cancel();},resume(){}};
 }

 /* Natural voices made on this Mac by the local bridge (Supertonic 3, bridge/tts). Every piece is sent for
    synthesis the moment it is queued, so while one plays the next is being made (the player queues a sentence when
    the one before it starts), and the pieces are played in order with an audio element, which can pause anywhere.
      synth({text,lang,voiceURI,rate}) -> {promise: Promise<{url, release(), playbackRate?}>, abort()}
      makeAudio(url) -> an HTMLAudioElement-like object (play() -> Promise, pause(), events playing/ended/error)
    A voice whose server cannot take a speed (Zotero's) is played faster instead: playbackRate keeps the pitch. */
 function audioEngine({synth,makeAudio,voices:list=[]}){
  let queue=[],current=null,epoch=0,paused=false;
  const drop=item=>{try{item.job&&item.job.abort();}catch(_){}try{item.result&&item.result.release();}catch(_){}};
  function pump(){
   if(current||paused||!queue.length)return;
   const item=queue[0];
   if(!item.result)return;          // still being made; its promise calls pump() again
   queue.shift();
   const audio=makeAudio(item.result.url),mine=epoch;current={item,audio};
   if(item.result.playbackRate&&item.result.playbackRate!==1)try{audio.playbackRate=item.result.playbackRate;}catch(_){}
   let started=false;
   const finish=()=>{if(!current||current.audio!==audio)return;current=null;try{item.result.release();}catch(_){}};
   audio.addEventListener('playing',()=>{if(mine!==epoch||started)return;started=true;item.utt.onstart&&item.utt.onstart();});
   audio.addEventListener('ended',()=>{if(mine!==epoch)return;finish();item.utt.onend&&item.utt.onend();pump();});
   audio.addEventListener('error',()=>{if(mine!==epoch)return;finish();item.utt.onerror&&item.utt.onerror('audio-failed');});
   try{const p=audio.play();if(p&&typeof p.catch==='function')p.catch(error=>{if(mine!==epoch||paused)return;finish();item.utt.onerror&&item.utt.onerror(String(error&&error.name||'audio-failed'));});}
   catch(error){finish();item.utt.onerror&&item.utt.onerror(String(error&&error.message||error));}
  }
  return {name:'natural',supportsPause:true,
   available(){return typeof synth==='function'&&typeof makeAudio==='function'&&list.length>0;},
   voices(){return list.slice();},
   speak(utt){
    const item={utt,job:null,result:null},mine=epoch;queue.push(item);
    try{item.job=synth({text:utt.text,lang:utt.lang,voiceURI:utt.voiceURI||'',rate:utt.rate||1});}
    catch(error){queue=queue.filter(x=>x!==item);utt.onerror&&utt.onerror(String(error&&error.message||error));return;}
    item.job.promise.then(result=>{
     if(mine!==epoch||!queue.includes(item)){try{result.release();}catch(_){}return;}
     item.result=result;pump();
    },error=>{
     if(mine!==epoch||!queue.includes(item))return;
     epoch++;queue.forEach(x=>x!==item&&drop(x));queue=[];
     utt.onerror&&utt.onerror(String(error&&error.message||error||'speech-failed'));
    });
   },
   cancel(){
    epoch++;paused=false;const old=queue;queue=[];old.forEach(drop);
    if(current){const {audio,item}=current;current=null;try{audio.pause();}catch(_){}try{audio.removeAttribute&&audio.removeAttribute('src');audio.load&&audio.load();}catch(_){}try{item.result.release();}catch(_){}}
   },
   owns(){return !!current||queue.length>0;},
   busy(){return !!current||queue.length>0;},
   pause(){paused=true;if(current)try{current.audio.pause();}catch(_){}},
   resume(){paused=false;if(current){try{const p=current.audio.play();if(p&&p.catch)p.catch(()=>{});}catch(_){}}else pump();}};
 }

 /* Several engines behind one, so a voice from any of them can be chosen without starting over: the voice's
    name says who speaks it ("supertonic:en:F3", "system:<uri>"). Only one speaks at a time, and a cancel
    reaches them all, so changing voice mid-paragraph stops the engine that was speaking.
    The system voices keep their own names, so a voice chosen before any model was installed still works: the
    part marked `fallback` speaks any name that no other part claims.
      parts: [{kinds:['supertonic','kokoro'], engine, fallback}] */
 function multiEngine(parts){
  const list=(Array.isArray(parts)?parts:[]).filter(p=>p&&p.engine&&(typeof p.engine.available!=='function'||p.engine.available()));
  const partFor=uri=>{const kind=String(uri||'').split(':')[0];return list.find(p=>p.kinds.includes(kind))||list.find(p=>p.fallback)||list[0]||null;};
  let active=null;
  const tagged=(part,v)=>({...v,engine:part.kinds[0]});
  return {
   get name(){return (active||list[0]||{engine:{}}).engine.name||'voices';},
   get supportsPause(){return active?active.engine.supportsPause!==false:true;},
   available(){return list.length>0;},
   voices(){const out=[];for(const part of list)for(const v of part.engine.voices()||[])out.push(tagged(part,v));return out;},
   speak(utt){
    const part=partFor(utt.voiceURI);if(!part){utt.onerror&&utt.onerror('no-engine');return;}
    if(active&&active!==part)try{active.engine.cancel();}catch(_){}
    active=part;
    part.engine.speak(utt);
   },
   cancel(){for(const part of list)try{part.engine.cancel();}catch(_){}},
   owns(){return !!active&&(typeof active.engine.owns!=='function'||active.engine.owns());},
   busy(){return !!active&&(typeof active.engine.busy!=='function'||active.engine.busy());},
   pause(){if(active&&active.engine.pause)active.engine.pause();},
   resume(){if(active&&active.engine.resume)active.engine.resume();}
  };
 }

 /* ---- composing what is read -------------------------------------------- */
 const sentencesOf=entry=>{
  if(!entry)return [];
  if(Array.isArray(entry.sentences))return entry.sentences.filter(s=>s&&clean(s.text)).map(s=>({text:clean(s.text),spoken:typeof s.spoken==='string'?clean(s.spoken):undefined,page:s.page??entry.page,rects:s.rects||entry.rects||[]}));
  const text=clean(entry.text||entry.caption||entry);
  return typeof entry==='string'||text?[{text:clean(typeof entry==='string'?entry:text),page:entry.page,rects:entry.rects||[]}]:[];
 };
 /* What to say for a sentence: the extraction module's citation-free `spoken` text when it has one,
    looked up in the paragraph when the reading order did not carry it. */
 function spokenOf(u,sections){
  if(typeof u.spoken==='string')return clean(u.spoken);
  const paragraph=sections[u.sectionIndex]&&Number.isInteger(u.paragraphIndex)&&(sections[u.sectionIndex].paragraphs||[])[u.paragraphIndex];
  const s=paragraph&&(paragraph.sentences||[]).find(x=>x&&x.text===u.text);
  return s&&typeof s.spoken==='string'?clean(s.spoken):undefined;
 }
 const sayable=u=>{const spoken=u&&typeof u.spoken==='string'?clean(u.spoken):'';return spoken&&/[\p{L}\p{N}]/u.test(spoken)?spoken:clean(u&&u.text);};
 const isBack=section=>!!section&&(section.kind==='back'||section.kind==='references'||section.back===true);
 /* The body in reading order, with the captions and the reference list added
    only when asked. Captions go after the last sentence on their page. */
 function composeUnits(structured,{captions=false,references=false}={},paperText=root.StyleCustomPaperText){
  if(!structured||!paperText)return [];
  const sections=Array.isArray(structured.sections)?structured.sections:[];
  const ordered=(paperText.readingOrder?paperText.readingOrder(structured):[])||[];
  let body=ordered.map((u,i)=>({...u,spoken:spokenOf(u,sections),kind:isBack(sections[u.sectionIndex])?'back':'body',order:i,sectionLabel:clean(sections[u.sectionIndex]&&sections[u.sectionIndex].heading)}));
  // The first sentence of a section carries its heading, to be said before it: "Results. Data-driven culturomics".
  // A heading with nothing under it (a parent such as "Results") is said with the next one that has text.
  const firstAt=new Map();body.forEach((u,i)=>{if(!firstAt.has(u.sectionIndex))firstAt.set(u.sectionIndex,i);});
  let parents=[];
  sections.forEach((section,si)=>{
   const heading=clean(String(section&&(section.spoken||section.heading)||'').replace(/[|•▪■◦]/g,' ')).replace(/^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+/,'').replace(/[.:;,]+$/,'');
   const said=heading&&heading.length<=90?heading:'';
   if(!firstAt.has(si)){if(said)parents.push(said);return;}
   const first=body[firstAt.get(si)];
   const own=said&&!clean(first.text).toLowerCase().startsWith(said.toLowerCase())?said:'';
   const lead=[...parents,own].filter(Boolean).join('. ');parents=[];
   if(lead)first.lead=lead;
  });
  if(!references)body=body.filter(u=>u.kind!=='back');
  const extra=[];
  if(captions)(structured.captions||[]).forEach((c,ci)=>{for(const s of sentencesOf(c).flatMap(x=>splitSentences(x.text).map(text=>({...x,text}))))extra.push({text:s.text,page:s.page,rects:s.rects,sectionIndex:-1,sentenceIndex:0,paragraphIndex:ci,kind:'caption',sectionLabel:'caption'});});
  const out=[];const pageOf=u=>Number.isFinite(Number(u.page))?Number(u.page):-1;
  const pending=extra.slice().sort((a,b)=>pageOf(a)-pageOf(b));
  for(let i=0;i<body.length;i++){
   out.push(body[i]);
   const last=i===body.length-1||pageOf(body[i+1])!==pageOf(body[i]);
   if(last)while(pending.length&&pageOf(pending[0])<=pageOf(body[i]))out.push(pending.shift());
  }
  out.push(...pending);
  if(references)(structured.references||[]).forEach((r,ri)=>{for(const s of sentencesOf(r))out.push({text:s.text,page:s.page,rects:s.rects,sectionIndex:-2,sentenceIndex:0,paragraphIndex:ri,kind:'reference',sectionLabel:'references'});});
  return out.map((u,i)=>({...u,order:i}));
 }
 const sectionKey=u=>u?u.kind+':'+u.sectionIndex:'';
 const signature=u=>u?clean(u.text).slice(0,48)+'|'+(u.page??''):'';

 /* ---- plain text fallback (no extraction module) ------------------------
   Pages are 0-based indexes here, as in the extraction module's output. */
 const HEADING=/^(?:(?:\d+(?:\.\d+){0,3}|[IVX]+)[.)]?\s+)?(abstract|introduction|background|related work|methods?|materials and methods|experimental(?: procedures)?|results?(?: and discussion)?|discussion|conclusions?|acknowledge?ments?|limitations?|references|bibliography|supplementary(?: information)?|초록|서론|방법|결과|논의|결론|참고문헌)(?![\p{L}\p{N}])[\s:.]*$/iu;
 const REFERENCES=/^(?:\d+[.)]?\s+)?(references|bibliography|literature cited|참고문헌)[\s:.]*$/iu;
 function plainTextStructure(text,{title=''}={}){
  const raw=String(text||'').replace(/\r/g,'');
  const pageTexts=raw.includes('\f')?raw.split('\f'):[raw];
  const sections=[{heading:'',level:1,page:0,paragraphs:[]}],references=[];let inRefs=false;
  pageTexts.forEach((pageText,pageIndex)=>{
   const paragraphs=pageText.split(/\n\s*\n/);
   for(const block of paragraphs){
    const lines=block.split('\n').map(l=>l.trim()).filter(Boolean);if(!lines.length)continue;
    if(lines.length===1&&lines[0].length<80&&HEADING.test(lines[0])){
     if(REFERENCES.test(lines[0])){inRefs=true;continue;}
     inRefs=false;sections.push({heading:lines[0].replace(/^\d+(?:\.\d+)*[.)]?\s+/,''),level:1,page:pageIndex,paragraphs:[]});continue;
    }
    const joined=lines.join(' ').replace(/(\w)- (\w)/g,'$1$2').replace(/\s+/g,' ').trim();if(!joined||joined.length<3)continue;
    const sentences=splitSentences(joined).map(s=>({text:s,page:pageIndex,rects:[]}));
    if(inRefs){for(const s of sentences)references.push({text:s.text,page:s.page});continue;}
    sections[sections.length-1].paragraphs.push({sentences});
   }
  });
  const kept=sections.filter((s,i)=>i>0||s.paragraphs.length);
  const abstractSection=kept.find(s=>/^(abstract|초록)$/i.test(s.heading));
  return {title:title||'',abstract:abstractSection?abstractSection.paragraphs.map(p=>p.sentences.map(s=>s.text).join(' ')).join('\n'):'',sections:kept,captions:[],references,footnotes:[],skipped:[],stats:{fallback:true,pages:pageTexts.length}};
 }
 /* The four functions of the extraction module, built from plain text. Used
    only when StyleCustomPaperText is not loaded. */
 const fallbackPaperText=Object.freeze({
  structure:({text,meta}={})=>plainTextStructure(text,{title:meta&&meta.title}),
  readingOrder(structured){const out=[];(structured.sections||[]).forEach((section,sectionIndex)=>{let n=0;for(const p of section.paragraphs||[])for(const s of p.sentences||[])out.push({text:s.text,page:s.page,rects:s.rects||[],sectionIndex,sentenceIndex:n++});});return out;},
  pageFromPdfjs:()=>null,
  debug:structured=>'plain text fallback: no extraction module, '+((structured&&structured.sections)||[]).length+' sections'
 });

 /* ---- the player -------------------------------------------------------- */
 function create({engine,now=()=>Date.now(),timers=null,onChange=()=>{},onCredit=()=>{},lang='en',voiceURI='',rate=1,filters={},watchdogMs=6000,pauses={},headings=true}={}){
  if(!engine)throw new Error('A speech engine is required');
  const timer=timers||{set:(fn,ms)=>setTimeout(fn,ms),clear:id=>clearTimeout(id)};
  let all=[],list=[],index=0,status='idle',gen=0,queuedTo=-1,entered=-1,queueLive=false,dead=false,watch=null,error='',heard=false,queueing=false,deferred=null,enginePaused=false,gap=null;
  let speakRate=clamp(rate,RATE_MIN,RATE_MAX,1),speakVoice=voiceURI||'',speakLang=lang||'en';
  const filter={captions:filters.captions===true,references:filters.references===true};
  const clock={since:null,accum:0};
  const emit=type=>{if(dead)return;try{onChange({type,state:snapshot()});}catch(_){}};
  const snapshot=()=>({status,index,total:list.length,unit:list[index]||null,rate:speakRate,voiceURI:speakVoice,lang:speakLang,filters:{...filter},error,engine:engine.name,supportsPause:engine.supportsPause!==false});
  const clearWatch=()=>{if(watch!==null){timer.clear(watch);watch=null;}};
  /* A breath before a new paragraph or section (ms at rate 1; off unless the caller asks), and the section's heading
     said before its first sentence. Between two sentences of one paragraph there is no gap: the next is queued early. */
  const pauseMs={paragraph:Math.max(0,Number(pauses.paragraph)||0),section:Math.max(0,Number(pauses.section)||0)};
  const gapBefore=i=>{
   const a=list[i-1],b=list[i];if(!a||!b)return 0;
   const ms=sectionKey(a)!==sectionKey(b)?pauseMs.section:(a.paragraphIndex!==undefined&&b.paragraphIndex!==undefined&&a.paragraphIndex!==b.paragraphIndex)?pauseMs.paragraph:0;
   return ms?Math.round(ms/speakRate):0;
  };
  const leadOf=i=>{const b=list[i];return headings&&b&&b.lead&&(i===0||sectionKey(list[i-1])!==sectionKey(b))?clean(b.lead):'';};
  const clearGap=()=>{if(gap){timer.clear(gap.id);gap=null;}};
  /* The watchdog: no sound at all after starting is an error ("no-audio"); a queue that went quiet after it had
     been speaking means someone else cancelled it (the reader's own Read Aloud shares the speech queue), which is a pause. */
  const armWatch=g=>{clearWatch();if(!watchdogMs)return;watch=timer.set(()=>{
   watch=null;if(g!==gen||status!=='playing'||dead)return;
   if(!heard){fail(g,'no-audio');return;}
   if(gap){armWatch(g);return;}
   if(typeof engine.busy==='function'&&!engine.busy()){interrupt(g,'interrupted');return;}
   armWatch(g);
  },watchdogMs);};
  function fail(g,reason){if(g!==gen)return;gen++;clearWatch();clearGap();try{engine.cancel();}catch(_){}queueLive=false;status='error';error=String(reason||'error');emit('error');}
  /* Stopped by a cancel this player did not make: become paused where we are, and do not cancel back (that would stop the other speaker). */
  function interrupt(g,reason){
   if(g!==gen||dead||status!=='playing')return;
   gen++;clearWatch();clearGap();queueLive=false;entered=-1;queuedTo=-1;
   if(clock.since!==null){clock.accum+=now()-clock.since;clock.since=null;}
   status='paused';error=String(reason||'interrupted');emit('interrupted');
  }
  function enqueue(u,g){
   const unit=list[u];if(!unit)return;
   const text=speechText(sayable(unit),speakLang);
   const chunks=splitForEngine(text);if(!chunks.length)chunks.push(text||'.');
   const lead=leadOf(u);if(lead)chunks.unshift(speechText(/[.!?]$/.test(lead)?lead:lead+'.',speakLang));
   queuedTo=u;
   // Every piece of this sentence is queued before anything else can be: an engine that starts synchronously must not slip the next sentence in between.
   queueing=true;
   try{
    chunks.forEach((chunk,k)=>engine.speak({text:chunk,lang:speakLang,voiceURI:speakVoice,rate:speakRate,
     onstart:()=>onStart(g,u,k),onend:()=>onEnd(g,u,k===chunks.length-1),onerror:reason=>fail(g,reason),oninterrupt:reason=>interrupt(g,reason)}));
   }finally{queueing=false;}
   if(deferred){const next=deferred;deferred=null;if(next.g===gen&&queuedTo<next.u)enqueue(next.u,next.g);}
  }
  function enter(u,g){
   if(entered===u)return;
   entered=u;index=u;clock.accum=0;clock.since=now();status='playing';error='';
   if(u+1<list.length&&queuedTo<u+1&&!gapBefore(u+1)){if(queueing)deferred={u:u+1,g};else enqueue(u+1,g);}
   emit('sentence');
  }
  function onStart(g,u,k){if(g!==gen||dead)return;heard=true;clearWatch();if(k===0)enter(u,g);if(watchdogMs&&typeof engine.busy==='function')armWatch(g);}
  function onEnd(g,u,last){
   if(g!==gen||dead)return;
   if(watchdogMs)armWatch(g);
   if(!last)return;
   const spent=(clock.accum+(clock.since!==null?now()-clock.since:0))/1000;clock.since=null;
   if(entered===u){try{onCredit(list[u],Math.min(CREDIT_MAX_SECONDS,Math.max(0,spent)));}catch(_){}}
   if(u+1>=list.length){clearWatch();queueLive=false;status='done';emit('done');return;}
   const wait=queuedTo<u+1?gapBefore(u+1):0;
   if(wait){clearGap();const id=timer.set(()=>{if(!gap||gap.id!==id)return;gap=null;if(g!==gen||dead||status!=='playing')return;enqueue(u+1,g);},wait);gap={id,next:u+1};return;}
   enter(u+1,g);
  }
  function startAt(i){
   if(dead)return;
   gen++;const g=gen;clearWatch();clearGap();try{engine.cancel();}catch(_){}
   // speechSynthesis stays paused through a cancel(): a queue left paused would hold the new sentence in silence
   if(enginePaused){enginePaused=false;try{engine.resume();}catch(_){}}
   index=Math.max(0,Math.min(list.length-1,i));entered=-1;queuedTo=index-1;queueLive=true;status='playing';error='';clock.accum=0;clock.since=null;heard=false;deferred=null;
   emit('status');armWatch(g);enqueue(index,g);
  }
  function rebuild(keep){
   const before=keep&&list[index];
   list=all.filter(u=>(u.kind!=='caption'||filter.captions)&&(u.kind!=='reference'&&u.kind!=='back'||filter.references));
   if(before){const at=list.findIndex(u=>u.order===before.order);index=at>=0?at:Math.min(list.length?list.length-1:0,Math.max(0,list.findIndex(u=>u.order>before.order)));if(index<0)index=0;}
   else index=Math.min(index,Math.max(0,list.length-1));
  }
  const api={
   load(units,{resume=null}={}){
    api.stop(true);all=(Array.isArray(units)?units:[]).map((u,i)=>({...u,order:u.order??i}));rebuild(false);index=0;
    if(resume){const at=typeof resume==='number'?resume:list.findIndex(u=>signature(u)===resume.sig);if(Number.isInteger(at)&&at>=0&&at<list.length)index=at;else if(resume.index>=0&&resume.index<list.length)index=resume.index;}
    entered=-1;status='idle';emit('status');return snapshot();
   },
   state:snapshot,units:()=>list,
   /* What to store to come back to this sentence: its text, its page, its index. */
   position:()=>({index,sig:signature(list[index]),page:list[index]&&list[index].page,total:list.length}),
   play(from){if(dead||!list.length)return snapshot();startAt(from===undefined?(status==='done'?0:index):from);return snapshot();},
   pause(){
    if(status!=='playing')return snapshot();
    clearWatch();
    if(gap){const next=gap.next;clearGap();gen++;index=next;entered=-1;queueLive=false;status='paused';emit('status');return snapshot();}
    if(clock.since!==null){clock.accum+=now()-clock.since;clock.since=null;}
    if(engine.supportsPause===false){gen++;try{engine.cancel();}catch(_){}queueLive=false;entered=-1;}else{engine.pause();enginePaused=true;}
    status='paused';emit('status');return snapshot();
   },
   resume(){
    if(dead||status!=='paused')return snapshot();
    if(engine.supportsPause===false||!queueLive){startAt(index);return snapshot();}
    status='playing';clock.since=now();enginePaused=false;engine.resume();emit('status');return snapshot();
   },
   toggle(){return status==='playing'?api.pause():status==='paused'?api.resume():api.play();},
   stop(silent){gen++;clearWatch();clearGap();try{engine.cancel();}catch(_){}queueLive=false;entered=-1;queuedTo=-1;clock.since=null;clock.accum=0;if(status!=='idle'){status='idle';if(!silent)emit('status');}return snapshot();},
   seek(i){
    if(dead||!list.length)return snapshot();
    const target=Math.max(0,Math.min(list.length-1,Math.round(Number(i)||0)));
    if(status==='playing'){startAt(target);return snapshot();}
    gen++;clearWatch();clearGap();try{engine.cancel();}catch(_){}queueLive=false;entered=-1;index=target;
    if(status!=='paused')status='paused';
    emit('sentence');return snapshot();
   },
   next(){return api.seek(Math.min(list.length-1,index+1));},
   prev(){return api.seek(Math.max(0,index-1));},
   nextSection(){const key=sectionKey(list[index]);let i=index+1;while(i<list.length&&sectionKey(list[i])===key)i++;return api.seek(Math.min(i,list.length-1));},
   prevSection(){
    const key=sectionKey(list[index]);let start=index;while(start>0&&sectionKey(list[start-1])===key)start--;
    if(index>start)return api.seek(start);
    if(start===0)return api.seek(0);
    const before=sectionKey(list[start-1]);let i=start-1;while(i>0&&sectionKey(list[i-1])===before)i--;return api.seek(i);
   },
   setRate(value){speakRate=clamp(value,RATE_MIN,RATE_MAX,speakRate);if(status==='playing')startAt(index);else{queueLive=false;emit('settings');}return speakRate;},
   setVoice(uri,language){speakVoice=uri||'';if(language)speakLang=language;if(status==='playing')startAt(index);else{queueLive=false;emit('settings');}return speakVoice;},
   setLanguage(language){speakLang=language||speakLang;},
   setFilters(next={}){
    if('captions' in next)filter.captions=next.captions===true;if('references' in next)filter.references=next.references===true;
    const was=status;rebuild(true);if(was==='playing')startAt(index);else{queueLive=false;entered=-1;emit('settings');}return snapshot();
   },
   /* A position on the page (found by the caller) becomes the sentence to start from. */
   /* Rectangles are [x, y, w, h] in the page's top-left coordinates, as the extraction module gives them. */
   indexNear(page,x,y){
    let best=-1,bestScore=Infinity;
    list.forEach((u,i)=>{
     if(Number(u.page)!==Number(page))return;
     for(const r of u.rects||[]){
      if(!Array.isArray(r)||r.length<4)continue;
      const x1=r[0],y1=r[1],x2=r[0]+r[2],y2=r[1]+r[3],dx=x<x1?x1-x:x>x2?x-x2:0,dy=y<y1?y1-y:y>y2?y-y2:0,d=Math.hypot(dx,dy);
      if(d<bestScore){bestScore=d;best=i;}
     }
    });
    if(best<0)return list.findIndex(u=>Number(u.page)===Number(page));
    return best;
   },
   destroy(){if(dead)return;api.stop(true);dead=true;},
   get destroyed(){return dead;}
  };
  return api;
 }
 /* About how long the rest takes from sentence `from` on, at `rate`: words over the voices' 200 a minute at rate 1
    (SAY_WPM). A Korean word (eojeol) is longer than an English one and is spoken at about the same pace. */
 function remainingSeconds(units,from=0,rate=1){
  const list=Array.isArray(units)?units:[];let words=0;
  for(let i=Math.max(0,from);i<list.length;i++){const m=sayable(list[i]).match(/\S+/g);words+=m?m.length:0;}
  return Math.round(words/(SAY_WPM*clamp(rate,RATE_MIN,RATE_MAX,1))*60);
 }
 const api={create,speechEngine,audioEngine,multiEngine,speechText,remainingSeconds,sayEngine,splitSentences,splitForEngine,detectLanguage,paperLanguage,pickVoice,composeUnits,plainTextStructure,fallbackPaperText,signature,sayable,RATE_MIN,RATE_MAX,CHUNK_MAX,SAY_WPM};
 root.CustomStyleReadAloud=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
