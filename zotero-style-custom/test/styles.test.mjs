import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import CSSOM from 'cssom';
const css=fs.readFileSync(fileURLToPath(new URL('../content/workbench.css',import.meta.url)),'utf8');
// CSSOM 0.5 predates container queries. Validate the narrow grouping grammar
// independently, then parse identical nested CSS under supported media groups.
// This verifies syntax/isolation, not computed layout or native rendering.
function parse(source){
 let nativeContainerSyntax=true;
 try{CSSOM.parse('@container sc-workbench (max-width: 720px) {.sc-body {padding:8px}}');}catch(_){nativeContainerSyntax=false;}
 const headers=[...source.matchAll(/@container\s+([^{}]+)\{/g)].map(m=>m[1].trim());
 for(const header of headers)assert.match(header,/^sc-workbench \(max-(?:width|height): \d+px\)$/,'validated container condition');
 const supported=nativeContainerSyntax?source:source.replace(/@container\s+sc-workbench\s+(\([^{}]+\))\s*\{/g,'@media $1 {');
 return {sheet:CSSOM.parse(supported),nativeContainerSyntax,headers};
}
const parsed=parse(css);
function flattened(rules){return [...rules].flatMap(rule=>[rule,...(rule.cssRules?flattened(rule.cssRules):[])]);}
const rules=flattened(parsed.sheet.cssRules);
function rule(selector){const found=rules.find(r=>r.selectorText?.split(',').map(x=>x.trim()).includes(selector));assert.ok(found,'rule '+selector);return found.style;}
function luminance(hex){const channels=hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;}
function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function tokens(style){return Object.fromEntries([...Array(style.length)].map((_,i)=>style[i]).filter(k=>k.startsWith('--sc-')).map(k=>[k,style.getPropertyValue(k).trim()]));}
const light=tokens(parsed.sheet.cssRules.find(r=>r.selectorText==='#style-custom-workbench').style);
const darkGroup=[...parsed.sheet.cssRules].find(r=>r.media?.mediaText.includes('prefers-color-scheme: dark'));
const dark={...light,...tokens([...darkGroup.cssRules].find(r=>r.selectorText==='#style-custom-workbench').style)};

test('all stylesheet groups parse with explicit container-parser compatibility and component isolation',t=>{
 assert.ok(parsed.headers.length>=3);if(!parsed.nativeContainerSyntax)t.diagnostic('CSSOM lacks @container: condition grammar checked directly; identical inner CSS parsed through @media compatibility wrapper. No native rendering claim.');
 const selectors=rules.filter(r=>r.selectorText);assert.ok(selectors.length>100);
 for(const r of selectors)for(const selector of r.selectorText.split(','))assert.match(selector.trim(),/^#style-custom-workbench(?:\b|\[|\s|:)/,'unscoped selector '+selector);
 assert.doesNotMatch(css,/@import|url\s*\(|@font-face/i);
 assert.throws(()=>parse('@container anything (unknown: 4) {.sc-body{padding:0}}'));
});
test('light and dark semantic text, muted metadata and selected navigation meet normal-text contrast',()=>{
 for(const [name,palette]of [['light',light],['dark',dark]]){
  for(const foreground of ['--sc-text','--sc-muted'])for(const background of ['--sc-bg','--sc-surface','--sc-surface-alt'])assert.ok(contrast(palette[foreground],palette[background])>=4.5,`${name} ${foreground}/${background}`);
  assert.ok(contrast(palette['--sc-accent'],palette['--sc-accent-soft'])>=4.5,`${name} selected nav`);
  assert.ok(contrast(palette['--sc-error'],palette['--sc-error-bg'])>=4.5,`${name} error`);
  assert.ok(contrast(palette['--sc-accent'],palette['--sc-surface'])>=3,`${name} focus indicator`);
 }
});
test('density changes spacing and control height without hiding functionality',()=>{
 const compact=rule('#style-custom-workbench[data-density=compact]');
 assert.ok(parseInt(compact.getPropertyValue('--sc-card-padding'))<parseInt(light['--sc-card-padding']));
 assert.ok(parseInt(compact.getPropertyValue('--sc-control-height'))>=28);
 assert.equal(compact.getPropertyValue('display'),'');
 for(const r of rules.filter(r=>r.selectorText?.includes('[data-density=compact]')))assert.notEqual(r.style.getPropertyValue('display'),'none');
});
test('resizable panel has container-based width/height adaptation and small-viewport scroll escape',()=>{
 const root=rule('#style-custom-workbench');assert.equal(root.getPropertyValue('container-type'),'size');assert.equal(root.getPropertyValue('container-name'),'sc-workbench');assert.match(root.getPropertyValue('min-width'),/100vw/);
 assert.ok(parsed.headers.includes('sc-workbench (max-width: 720px)'));assert.ok(parsed.headers.includes('sc-workbench (max-width: 440px)'));assert.ok(parsed.headers.includes('sc-workbench (max-height: 460px)'));
 const short=[...parsed.sheet.cssRules].find(r=>r.media?.mediaText==='(max-height: 480px)');assert.ok(short);const panel=[...short.cssRules].find(r=>r.selectorText==='#style-custom-workbench');assert.equal(panel.style.getPropertyValue('overflow'),'auto');assert.equal(panel.style.getPropertyValue('min-height'),'0');
});
test('all existing data-view families and new interaction hooks retain explicit styling',()=>{
 for(const selector of ['.sc-native-preview','.sc-graph','.sc-canvas','.sc-canvas-lines','.sc-canvas-card','.sc-matrix','.sc-page-strip','.sc-ai-output','.sc-command-palette','.sc-command-results','.sc-filter-chips','.sc-filter-fields','.sc-paper-title','.sc-paper-actions','.sc-selection-bar','.sc-content'])assert.ok(rules.some(r=>r.selectorText?.includes(selector)),selector);
 assert.equal(rule('#style-custom-workbench .sc-content').getPropertyValue('min-height'),'0');assert.equal(rule('#style-custom-workbench .sc-body').getPropertyValue('overflow'),'auto');
 assert.equal(rule('#style-custom-workbench .sc-command-results').getPropertyValue('overflow'),'auto');assert.equal(rule('#style-custom-workbench .sc-command-option[aria-selected=true]').getPropertyValue('color'),'var(--sc-accent)');
});
test('canvas labels and controls stay legible over arbitrary saved card colors in either theme',()=>{
 const label=rule('#style-custom-workbench .sc-canvas-card h3');const control=rule('#style-custom-workbench .sc-canvas-card textarea');
 // h3's first rule provides drag behavior; choose the later neutral surface rule.
 const neutral=rules.find(r=>r.selectorText?.includes('.sc-canvas-card h3')&&r.style.getPropertyValue('background')==='#ffffff').style;
 assert.ok(contrast(neutral.getPropertyValue('color'),neutral.getPropertyValue('background'))>=7);
 assert.ok(contrast(control.getPropertyValue('color'),control.getPropertyValue('background'))>=7);
 assert.equal(control.getPropertyPriority('color'),'important');assert.equal(control.getPropertyPriority('background'),'important');assert.equal(label.getPropertyValue('cursor'),'grab');
});
test('hidden dialogs, keyboard focus, reading status and motion/forced-color accommodations are retained',()=>{
 assert.equal(rule('#style-custom-workbench [hidden]').getPropertyValue('display'),'none');assert.equal(rule('#style-custom-workbench [hidden]').getPropertyPriority('display'),'important');
 assert.match(rule('#style-custom-workbench :focus-visible').getPropertyValue('outline'),/2px/);
 // Reading state is a dot at the start of the row now, not a rail down its edge,
 // but each state must still be told apart without reading the text.
 const dot=state=>rule(`#style-custom-workbench .sc-paper-card[data-status=${state}]::before`).getPropertyValue('background');
 const states=['reading','done'].map(dot);
 for(const [i,value] of states.entries())assert.ok(value,['reading','done'][i]);
 assert.notEqual(states[0],states[1]);
 assert.ok(rule('#style-custom-workbench .sc-paper-card[data-status]::before').getPropertyValue('background'),'unread needs a mark too');
 assert.ok([...parsed.sheet.cssRules].some(r=>r.media?.mediaText.includes('prefers-reduced-motion')));assert.ok([...parsed.sheet.cssRules].some(r=>r.media?.mediaText.includes('forced-colors')));
});
test('selected papers preserve status rails and busy controls use visible non-animated feedback',()=>{
 const selected=rule('#style-custom-workbench .sc-paper-card[data-selected=true]');assert.equal(selected.getPropertyValue('background'),'var(--sc-accent-soft)');assert.ok(selected.getPropertyValue('outline'));assert.equal(selected.getPropertyValue('box-shadow'),'');assert.equal(selected.getPropertyValue('border-inline-start-color'),'');
 // Actions are held at zero opacity until wanted, so they must come back for
 // keyboard users who can reach them without a pointer.
 assert.equal(rule('#style-custom-workbench .sc-paper-actions').getPropertyValue('opacity'),'0');
 const revealed=rules.filter(r=>r.selectorText?.includes('.sc-paper-actions')&&/:focus-within|:hover/.test(r.selectorText));
 assert.ok(revealed.some(r=>r.selectorText.includes(':focus-within')),'focus must reveal the actions');
 assert.ok(revealed.some(r=>r.selectorText.includes(':hover')));
 assert.equal(rule('#style-custom-workbench .sc-paper-identity').getPropertyValue('min-width'),'0');
 const busy=rule('#style-custom-workbench button[aria-busy=true]');assert.equal(busy.getPropertyValue('cursor'),'progress');assert.equal(busy.getPropertyValue('opacity'),'1');assert.equal(busy.getPropertyValue('animation'),'');
});
test('actual JavaScript-generated heatmap colors retain readable labels over the CSS backing surface',()=>{
 const source=fs.readFileSync(fileURLToPath(new URL('../src/workbench.js',import.meta.url)),'utf8');
 const match=source.match(/rgba\(36,92,120,\$\{Math\.min\((\.\d+)/);assert.ok(match,'locate actual heatmap opacity cap');const cap=Number(match[1]);assert.ok(cap>0&&cap<=.60);
 assert.equal(rule('#style-custom-workbench .sc-page-strip').getPropertyValue('background'),'#ffffff');
 const ink=rule('#style-custom-workbench .sc-page-strip button').getPropertyValue('color');
 for(const alpha of [0,.15,cap]){const backdrop='#'+[36,92,120].map(c=>Math.round(c*alpha+255*(1-alpha)).toString(16).padStart(2,'0')).join('');assert.ok(contrast(ink,backdrop)>=4.5,`heatmap alpha ${alpha}`);}
});

test('every badge colour lands on the same contrast, so no one of them shouts', async () => {
  const fs = await import('node:fs');
  const { createRequire } = await import('node:module');
  const Runtime = createRequire(import.meta.url)('../src/runtime.js');
  const luminance = hex => {
    const n = parseInt(hex.slice(1), 16);
    const channel = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(n >> 16 & 255) + 0.7152 * channel(n >> 8 & 255) + 0.0722 * channel(n & 255);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const named = ['blue', 'green', 'orange', 'red', 'purple', 'teal', 'gold'];
  const get = dark => Runtime.prototype.palette.call({},
    {defaultView: {matchMedia: () => ({matches: dark})}});

  for (const [dark, behind, floor] of [[false, '#FFFFFF', 3.4], [true, '#1C1C1F', 5.6]]) {
    const P = get(dark);
    const ratios = named.map(name => ratio(P[name], behind));
    // In the old set gold sat at 2.1 against white and blue at 4.7: one badge
    // shouted and another was hard to read, which is what made a row look loud.
    const spread = Math.max(...ratios) - Math.min(...ratios);
    assert.ok(spread < 0.5, `${dark ? 'dark' : 'light'} spread is ${spread.toFixed(2)}: ${ratios.map(r => r.toFixed(2))}`);
    assert.ok(Math.min(...ratios) > floor, `${dark ? 'dark' : 'light'} floor ${Math.min(...ratios).toFixed(2)}`);
  }

  // Pastel is the saturation, not a wash: the fills carry it and the ink stays
  // readable, so the tint is raised rather than the colours being lightened.
  assert.ok(get(false).tint >= 0.18);
  assert.ok(get(true).tint >= 0.24);

  // Nothing loud left anywhere in the stylesheets.
  for (const file of ['content/workbench.css', 'content/citation.css']) {
    const css = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const hex of css.match(/#[0-9a-fA-F]{6}\b/g) || []) {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => v / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const light = (max + min) / 2;
      const saturation = max === min ? 0 : light > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
      assert.ok(saturation <= 0.55, `${file} still has ${hex} at saturation ${saturation.toFixed(2)}`);
    }
  }
});
