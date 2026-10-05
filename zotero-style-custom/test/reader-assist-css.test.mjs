import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseHTML} from 'linkedom';

/* The real cascade of content/reader-assist.css after Zotero 9.0.6's reader.css button reset, evaluated for the
   buttons that sit on a dark pill, in the reader's light and dark themes (values copied from reader.css 9.0.6). */
const THEMES={
 light:{'--fill-primary':'rgba(0,0,0,0.8509803922)','--color-background':'#fff','--color-sidepane':'#f2f2f2','--color-border':'rgba(0,0,0,0.1490196078)','--fill-quinary':'rgba(0,0,0,0.0509803922)','--fill-quarternary':'rgba(0,0,0,0.1019607843)','--accent-blue':'#4072e5','--accent-red':'#db2c3a'},
 dark:{'--fill-primary':'rgba(255,255,255,0.8980392157)','--color-background':'#1e1e1e','--color-sidepane':'#303030','--color-border':'rgba(255,255,255,0.1803921569)','--fill-quinary':'rgba(255,255,255,0.0588235294)','--fill-quarternary':'rgba(255,255,255,0.1215686275)','--accent-blue':'#4072e5','--accent-red':'rgba(219,44,58,0.8980392157)'}
};
// Zotero's reader.css: button{all:unset;...;color:inherit}
const READER_RESET='button{color:inherit;background:none}';
function rules(css){
 const out=[];let order=0;
 const body=css.replace(/\/\*[\s\S]*?\*\//g,'');
 for(const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
  const decls={};for(const d of m[2].split(';')){const i=d.indexOf(':');if(i>0)decls[d.slice(0,i).trim()]=d.slice(i+1).trim();}
  for(const sel of m[1].split(',').map(x=>x.trim()).filter(Boolean))out.push({sel,decls,order:order++});
 }
 return out;
}
function specificity(sel){
 let s=sel.replace(/:where\([^)]*\)/g,'');
 const not=[...s.matchAll(/:not\(([^)]*)\)/g)].map(m=>m[1]);s=s.replace(/:not\([^)]*\)/g,'');
 const ids=(s.match(/#[\w-]+/g)||[]).length,cls=(s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)||[]).length,types=(s.replace(/\[[^\]]*\]/g,'').match(/(^|[\s>+~])[a-z][\w-]*/gi)||[]).length;
 const extra=not.map(specificity).reduce((a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],[0,0,0]);
 return [ids+extra[0],cls+extra[1],types+extra[2]];
}
const cmp=(a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2];
function winner(el,prop,all){
 let best=null;
 for(const r of all){if(!(prop in r.decls))continue;let ok=false;try{ok=el.matches(r.sel);}catch(_){ok=false;}if(!ok)continue;
  const sp=specificity(r.sel);if(!best||cmp(sp,best.sp)>0||cmp(sp,best.sp)===0&&r.order>best.order)best={sp,order:r.order,value:r.decls[prop],sel:r.sel};}
 return best;
}
const parseColor=v=>{v=v.trim();if(v==='transparent')return [0,0,0,0];let m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);if(m){let h=m[1];if(h.length===3)h=[...h].map(c=>c+c).join('');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).concat(1);}
 m=/^rgba?\(([^)]*)\)$/.exec(v);if(m){const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return [p[0],p[1],p[2],p[3]??1];}return null;};
function resolve(value,vars,root){
 let v=value;
 for(let i=0;i<10&&/var\(/.test(v);i++)v=v.replace(/var\((--[\w-]+)(?:,([^()]*(?:\([^()]*\))?[^()]*))?\)/,(m,name,fb)=>vars[name]??root[name]??(fb||'').trim());
 return v;
}
const lum=([r,g,b])=>{const c=[r,g,b].map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];};
const over=(top,under)=>[0,1,2].map(i=>top[i]*top[3]+under[i]*(1-top[3])).concat(1);
const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);};

const css=fs.readFileSync(new URL('../content/reader-assist.css',import.meta.url),'utf8');
const all=rules(READER_RESET+'\n'+css);
const panelVars=Object.fromEntries(Object.entries(rules(css).find(r=>r.sel==='.sc-ra').decls).filter(([k])=>k.startsWith('--')));
const {document}=parseHTML(`<aside class="sc-ra"><div class="sc-ra-main"><section class="sc-ra-card">
 <button class="sc-ra-btn sc-ra-play" id="play">x</button><button class="sc-ra-btn sc-ra-primary" id="primary">x</button>
 <button class="sc-ra-btn sc-ra-send" id="send">x</button><button class="sc-ra-btn sc-ra-icon" id="icon">x</button>
 <div class="sc-ra-seg"><button class="sc-ra-seg-btn" aria-pressed="true" id="seg">x</button></div>
 <nav class="sc-ra-tabs"><button class="sc-ra-tab" role="tab" aria-selected="true" id="tab">x</button></nav></section></div>
 <nav class="sc-ra-rail"><button class="sc-ra-btn sc-ra-icon sc-ra-rail-play" id="rail">x</button></nav></aside>`);

for(const [scheme,root] of Object.entries(THEMES)){
 test(`${scheme}: text and icons on the dark pills keep 4.5:1 through the real cascade`,()=>{
  const vars={};for(const [k,v] of Object.entries(panelVars))vars[k]=resolve(v,vars,root);
  const card=parseColor(resolve('var(--sc-card)',vars,root));
  for(const id of ['play','primary','send','seg','tab','rail']){
   const el=document.getElementById(id);
   const color=winner(el,'color',all),bg=winner(el,'background',all);
   assert.ok(color,`${id} has a colour`);assert.ok(bg,`${id} has a background`);
   assert.doesNotMatch(color.sel,/^\.sc-ra button$/,`${id}: the reset must not win`);
   const fg=parseColor(resolve(color.value,vars,root)),back=over(parseColor(resolve(bg.value,vars,root)),card);
   const r=ratio(over(fg,back),back);
   assert.ok(r>=4.5,`${scheme} ${id}: ${r.toFixed(2)}:1 (${color.sel} → ${color.value} on ${bg.value})`);
  }
 });
}
test('the button reset has no class weight',()=>{
 assert.match(css,/:where\(\.sc-ra\) button\{/);
 assert.doesNotMatch(css,/(^|\})\s*\.sc-ra button\{/);
});
