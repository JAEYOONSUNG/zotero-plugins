/* Verified journal-level JIF data. This module never infers JIF from citations. */
(function(root) {
  'use strict';
  /* Where a figure is allowed to have come from. openalex.org is here because
     the openly licensed catalogue is built from it; what it publishes is a
     two-year mean citedness and not a JIF, so a record sourced there carries
     metric:"openalex-2yr-mean-citedness" and the display layer keeps the two
     apart. This list is also what parsePage is allowed to re-read, and the
     plugin already talks to api.openalex.org in src/journal-metrics.js. */
  const hosts = /(^|\.)(nature\.com|springer\.com|springernature\.com|academic\.oup\.com|science\.org|pnas\.org|asm\.org|cell\.com|sciencedirect\.com|elsevier\.com|wiley\.com|acs\.org|frontiersin\.org|plos\.org|microbiologyresearch\.org|mdpi\.com|annualreviews\.org|royalsocietypublishing\.org|jmb\.or\.kr|biomedcentral\.com|embopress\.org|clarivate\.com|openalex\.org)$/i;
  // A leading article is not part of a journal's name ("The ISME Journal" is
  // "ISME Journal" in the JCR); the JCR spells out what Zotero abbreviates; and a
  // journal that was renamed is listed only under its current title, so the old
  // title on an old paper is sent to the new one (Biotechnology for Biofuels is
  // now "... and Bioproducts", Journal of General Microbiology is Microbiology).
  const SPELLED={'biotechnology for biofuels':'biotechnology for biofuels and bioproducts','bmc evolutionary biology':'bmc ecology and evolution','molecular and general genetics mgg':'molecular genetics and genomics','molecular and general genetics':'molecular genetics and genomics','journal of general microbiology':'microbiology sgm','european journal of biochemistry':'febs journal','journal of applied bacteriology':'journal of applied microbiology','genome announcements':'microbiology resource announcements','agricultural and biological chemistry':'bioscience biotechnology and biochemistry','biotechnology techniques':'biotechnology letters','standards in genomic sciences':'environmental microbiome','current protocols in molecular biology':'current protocols','bioelectrochemistry and bioenergetics':'bioelectrochemistry','angewandte chemie':'angewandte chemie international edition','acta crystallographica section f structural biology and crystallization communications':'acta crystallographica section f structural biology communications','acta crystallographica section f':'acta crystallographica section f structural biology communications','frontiers in bioscience':'frontiers in bioscience landmark','proceedings of the national academy of sciences':'proceedings of the national academy of sciences of the united states of america','pnas':'proceedings of the national academy of sciences of the united states of america'};
  function name(value) { const key=String(value || '').normalize('NFKC').toLowerCase().replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ').replace(/^the /,''); return SPELLED[key]||key; }
  function issn(value) {
    const s=String(value||'').toUpperCase().replace(/[^0-9X]/g,'');
    if(!/^\d{7}[\dX]$/.test(s))return null;
    const sum=[...s.slice(0,7)].reduce((n,c,i)=>n+Number(c)*(8-i),0)+(s[7]==='X'?10:Number(s[7]));
    return sum%11===0?s:null;
  }
  function valid(record) {
    const url=/^https:\/\/([a-z0-9.-]+)(?:\/[^\s]*)?$/i.exec(String(record.sourceURL||''));
    if(!url)return false;
    return typeof record.title==='string' && !!name(record.title) && Array.isArray(record.aliases) && record.aliases.every(a=>typeof a==='string')
      && Array.isArray(record.issns) && record.issns.every(i=>!!issn(i))
      && typeof record.impactFactor==='number' && Number.isFinite(record.impactFactor) && record.impactFactor>=0 && record.impactFactor<1000
      && (record.year===null || Number.isInteger(record.year) && record.year>=2000 && record.year<=new Date().getFullYear())
      && hosts.test(url[1])
      && /^\d{4}-\d{2}-\d{2}$/.test(record.checkedAt) && Number.isFinite(Date.parse(record.checkedAt));
  }
  function create(records=[]) {
    const titles=new Map(), ids=new Map(), all=[];
    const put=(map,key,r)=>{if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(r);};
    for(const original of records) {
      if(!valid(original))throw new Error('Invalid verified IF catalog entry: '+original?.title);
      const r={...original,aliases:[...original.aliases],issns:[...original.issns]};all.push(r);
      for(const title of [r.title,...r.aliases])put(titles,name(title),r);
      for(const id of r.issns)put(ids,issn(id),r);
    }
    function choose(matches) {
      let unique=[...new Set(matches)];if(!unique.length)return null;
      // The JCR export is the authority: when it names the journal, a number read
      // off a publisher page months earlier is not allowed to contradict it.
      const jcr=unique.filter(r=>r.authority==='jcr');if(jcr.length)unique=jcr;
      if(new Set(unique.map(r=>name(r.title))).size>1)return null;
      const newest=Math.max(...unique.map(r=>r.year||0));const candidates=unique.filter(r=>(r.year||0)===newest);
      if(new Set(candidates.map(r=>r.impactFactor)).size>1)return null;
      return candidates.sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt))[0];
    }
    function lookup(item) {
      const field=k=>{try{return item.getField(k)||'';}catch(_){return '';}};
      const names=[field('publicationTitle'),field('journalAbbreviation')].filter(Boolean);
      const identifiers=(String(field('ISSN')).match(/\d{4}-?\d{3}[\dXx]/g)||[]).map(issn).filter(Boolean);
      const idMatches=identifiers.flatMap(id=>ids.get(id)||[]);
      if(idMatches.length)return choose(idMatches);
      return choose(names.flatMap(title=>titles.get(name(title))||[]));
    }
    return {lookup,records:all};
  }
  function parsePage(html, record, DOMParser) {
    if(!valid(record))return null;
    if (/\.csv(?:[?#]|$)/i.test(record.sourceURL)) {
      const rows=[];let row=[],field='',quoted=false;
      const text=String(html).replace(/^\uFEFF/,'');
      for(let i=0;i<text.length;i++) {
        const c=text[i];
        if(c==='"'){if(quoted && text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
        else if(c===',' && !quoted){row.push(field);field='';}
        else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);rows.push(row);row=[];field='';}
        else field+=c;
      }
      if(quoted)return null;
      if(field||row.length){row.push(field);rows.push(row);}
      const headers=rows.shift()||[], title=headers.indexOf('journal_title'), metric=headers.indexOf('impact_factor'), yearColumn=headers.indexOf('if_year');
      if(Math.min(title,metric,yearColumn)<0)return null;
      const matches=rows.filter(r=>[record.title,...record.aliases].some(t=>name(r[title])===name(t)));
      if(matches.length!==1)return null;
      const r=matches[0],year=Number(r[yearColumn]),value=r[metric];
      return /^\d+(\.\d+)?$/.test(value||'') && Number.isInteger(year) && year>=Math.max(2000,record.year||0) && year<=new Date().getFullYear()
        ? {impactFactor:Number(value),year}:null;
    }
    if(typeof DOMParser!=='function')return null;
    const doc=new DOMParser().parseFromString(html,'text/html');
    for(const node of doc.querySelectorAll('script,style,nav,footer'))node.remove();
    const clean=value=>String(value||'').replace(/\s+/g,' ').trim();
    // Portfolio metrics tables: select the exact journal row and the two-year JIF column.
    for(const table of doc.querySelectorAll('table')) {
      const rows=[...table.querySelectorAll('tr')];
      const headers=rows[0]?[...rows[0].querySelectorAll('th,td')].map(n=>clean(n.textContent)):[];
      const index=headers.findIndex(h=>/^(journal )?impact factor$/i.test(h));
      if(index<1)continue;
      const row=rows.slice(1).find(row=>[record.title,...record.aliases].some(t=>name(row.querySelector('th,td')?.textContent)===name(t)));
      if(!row)continue;
      let section=table,heading='';
      for(let depth=0;section && depth<5;depth++,section=section.parentElement) {
        let sibling=section.previousElementSibling;
        while(sibling){if(/^H[1-6]$/.test(sibling.tagName)){heading=clean(sibling.textContent);break;}sibling=sibling.previousElementSibling;}
        if(/20\d{2}.*(?:Journal|Citation) Metrics/i.test(heading))break;
      }
      const year=Number(heading.match(/20\d{2}/)?.[0]);
      const value=clean(row.querySelectorAll('th,td')[index]?.textContent);
      if(/^\d+(\.\d+)?$/.test(value) && year>=record.year && year<=new Date().getFullYear())return {impactFactor:Number(value),year};
    }
    // Single-journal pages must identify the journal before reading a labeled JIF.
    const headings=[clean(doc.querySelector('h1')?.textContent),...clean(doc.querySelector('title')?.textContent).split('|')];
    if(![record.title,...record.aliases].some(t=>headings.some(h=>name(h)===name(t))))return null;
    const text=clean(doc.body?.textContent || [...doc.childNodes].map(n=>n.textContent||'').join(' '));
    const patterns=[/(?:^|[^\w-])Journal Impact Factor\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\((20\d{2})\)/gi,
      /(?:^|[^\w-])(20\d{2})\s+(?:Journal )?Impact Factor\s*[:\-]?\s*(\d+(?:\.\d+)?)/gi];
    const found=[];
    patterns.forEach((pattern,index)=>{
      for(const m of text.matchAll(pattern)) {
        if(/5[ -]?(?:year|yr)\s*$/i.test(text.slice(Math.max(0,m.index-15),m.index)))continue;
        const year=Number(m[index?1:2]),impactFactor=Number(m[index?2:1]);
        if(year>=record.year && year<=new Date().getFullYear() && impactFactor<1000)found.push({year,impactFactor});
      }
    });
    const newest=Math.max(...found.map(r=>r.year));const values=found.filter(r=>r.year===newest);
    return values.length && new Set(values.map(v=>v.impactFactor)).size===1?values[0]:null;
  }
  const api={name,issn,valid,create,parsePage};root.CustomStyleJournals=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
