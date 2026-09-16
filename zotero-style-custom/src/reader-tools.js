/* Original reader and workspace features. Native APIs verified against Zotero 9
 * omni.ja reader/reader.js, tabs.js, and components/virtualized-table.js. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.CustomStyleReaderTools=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const CUSTOM_ID='style-custom-palette';
  const COLORS={'#ffd400':'Yellow','#ff6666':'Red','#5fb236':'Green','#2ea8e5':'Blue','#a28ae5':'Purple','#e56eee':'Magenta','#f19837':'Orange','#aaaaaa':'Gray'};
  const copy=value=>JSON.parse(JSON.stringify(value));
  const color=value=>typeof value==='string'&&/^#[\da-f]{6}$/i.test(value)?value.toLowerCase():null;
  function create({Zotero:Z,runtime}){
    const windows=new Map(),detached=new WeakSet();let stopped=false,sequence=0;
    const toolbarOwner=(runtime.id||'style-custom')+'/reader-tools-'+Math.random().toString(36).slice(2);
    let toolbarRegistered=false,backlinkRevision=0,backlinkObserver=null;
    const backlinkCache=new Map();let backlinkQueue=Promise.resolve();
    const alive=()=>{if(stopped)throw new Error('Reader tools have stopped');};
    const settings=()=>runtime.cache.readerSettings||{};
    const list=key=>Array.isArray(runtime.cache[key])?runtime.cache[key]:[];
    const persist=async()=>{runtime.dirty=true;await runtime.flush();};
    const nameOf=name=>{if(typeof name!=='string'||!name.trim())throw new Error('A group name is required');return name.trim().slice(0,120);};
    const idOf=()=>`group-${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2,8)}`;
    const report=error=>Z.logError?.(error);
    const enabled=id=>typeof runtime.featureEnabled!=='function'||runtime.featureEnabled(id)!==false;
    const requireFeature=id=>{alive();if(!enabled(id))throw new Error('Reader feature is disabled: '+id);};
    function preference(key,fallback){
      try{const value=typeof runtime.getSetting==='function'?runtime.getSetting(key):runtime.pref?.(key,undefined);return value===undefined?fallback:value;}catch(_){return fallback;}
    }
    function syncPreference(key,value){
      if(typeof runtime.getSetting==='function'&&typeof Z.Prefs?.set==='function'&&preference(key,undefined)!==value)Z.Prefs.set('extensions.style-custom.'+key,value,true);
    }
    function preferredState(state){
      const theme=preference('readerTheme',settings().theme);
      state.theme=enabled('PDFStyles')?(theme==='original'?undefined:theme==='custom'?{background:preference('readerCustomBackground',settings().theme?.background||'#ffffff'),foreground:preference('readerCustomForeground',settings().theme?.foreground||'#252a31')}:theme):undefined;
      state.margins=enabled('marginAnnotation')&&!!preference('marginEnabled',settings().marginAnnotations===true);
      state.sidebarVisible=enabled('toogleSidebar')?preference('readerSidebar',settings().sidebarVisible):undefined;
      state.verticalTabs=enabled('verticalTabManager')&&!!preference('verticalTabs',settings().verticalTabs===true);
    }
    async function applyPreferences(win){
      alive();attach(win);const state=windows.get(win),prior=JSON.stringify(state.theme);preferredState(state);
      if(prior!==JSON.stringify(state.theme)||!enabled('PDFStyles')){for(const[r,o]of state.themes)restoreTheme(r,o);state.themes.clear();}
      for(const[r,o]of state.sidebars){try{if(r._internalReader?._state?.sidebarOpen===o.applied)r._internalReader.toggleSidebar(o.original);}catch(e){report(e);}}state.sidebars.clear();
      if(!enabled('backlinks')){for(const header of state.backlinkHeaders)header.remove();state.backlinkHeaders.clear();}
      const next={...settings(),marginOptions:{...(settings().marginOptions||{}),...marginOptions()}};if(enabled('marginAnnotation'))next.marginAnnotations=state.margins;if(enabled('verticalTabManager'))next.verticalTabs=state.verticalTabs;if(enabled('PDFStyles')){if(state.theme===undefined)delete next.theme;else next.theme=state.theme;}if(enabled('toogleSidebar')){if(state.sidebarVisible===undefined)delete next.sidebarVisible;else next.sidebarVisible=state.sidebarVisible;}if(JSON.stringify(next)!==JSON.stringify(settings())){runtime.cache.readerSettings=next;runtime.dirty=true;}
      refresh(win,state);redrawToolbars();
    }
    function cloneFor(value,reader){
      const clone=globalThis.Cu?.cloneInto||globalThis.Components?.utils?.cloneInto;
      return clone?clone(value,reader._iframeWindow):copy(value);
    }
    function palette(theme){
      if(['light','dark','sepia'].includes(theme))return theme;
      if(theme&&typeof theme==='object'&&color(theme.background)&&color(theme.foreground)){
        if(color(theme.background)===color(theme.foreground))throw new Error('Background and text colors must differ');
        return {background:color(theme.background),foreground:color(theme.foreground)};
      }
      throw new Error('Choose light, dark, sepia, or a palette with six-digit background and foreground colors');
    }
    function readers(win){return (Z.Reader?._readers||[]).filter(r=>r._window===win&&r._internalReader&&r._iframeWindow&&!r._iframeWindow.closed);}
    function themeReader(reader,state,theme){
      const core=reader._internalReader;
      if(!['setColorScheme','setLightTheme','setDarkTheme','setCustomThemes'].every(key=>typeof core[key]==='function'))throw new Error('Reader theme API unavailable');
      let original=state.themes.get(reader);
      if(!original){original={scheme:core._state?.colorScheme??null,light:core._state?.lightTheme?.id??null,dark:core._state?.darkTheme?.id??null,owned:{},custom:(core._state?.customThemes||[]).find(t=>t.id===CUSTOM_ID)};state.themes.set(reader,original);}
      const dark=theme==='dark';
      const themeID=typeof theme==='object'?CUSTOM_ID:theme==='light'?null:theme;
      const custom=(core._state?.customThemes||[]).filter(t=>t.id!==CUSTOM_ID);
      if(typeof theme==='object')custom.push({id:CUSTOM_ID,label:'Style Custom',...theme});
      core.setCustomThemes(cloneFor(custom,reader));
      core.setColorScheme(dark?'dark':'light');
      if(dark)core.setDarkTheme(themeID);else core.setLightTheme(themeID);
      original.applied={scheme:dark?'dark':'light',id:themeID};original.owned[dark?'dark':'light']=themeID;
    }
    function restoreTheme(reader,original){
      const core=reader._internalReader;if(!core)return;
      try{
        const state=core._state||{},applied=original.applied;
        for(const field of Object.keys(original.owned))if((state[field+'Theme']?.id??null)===original.owned[field])core[field==='dark'?'setDarkTheme':'setLightTheme'](original[field]);
        const custom=(state.customThemes||[]).filter(t=>t.id!==CUSTOM_ID);if(original.custom)custom.push(original.custom);
        core.setCustomThemes(cloneFor(custom,reader));
        if(state.colorScheme===applied?.scheme)core.setColorScheme(original.scheme);
      }catch(error){report(error);}
    }
    function removeCard(node){node._restorePageOverflow?.();node.remove();}
    function removeCards(state){for(const node of state.cards.values())removeCard(node);state.cards.clear();state.cardSignature='';}
    function paintCards(win,state){
      const present=new Set();
      if(!state.margins||!enabled('marginAnnotation')){removeCards(state);return;}
      for(const reader of readers(win)){
        if(reader.type!=='pdf')continue;
        const annotations=reader._internalReader._state?.annotations||[];
        for(const view of [reader._internalReader._primaryView,reader._internalReader._secondaryView]){
        const doc=view?._iframeWindow?.document;
        if(!doc)continue;
        const pages=[...doc.querySelectorAll('.page[data-page-number]')];
        for(const page of pages){
          const pageIndex=Number(page.getAttribute('data-page-number'))-1;
          if(!Number.isInteger(pageIndex)||pageIndex<0)continue;
          const display=marginDisplay();const matching=annotations.filter(a=>!a._hidden&&a.position?.pageIndex===pageIndex&&a.id&&display.types[a.type||'highlight']!==false);
          if(!matching.length)continue;
          present.add(page);
          const options=marginOptions();const signature=JSON.stringify([matching,settings().colorLabels,options,display,enabled('showAnnotationColorName')]);
          let aside=state.cards.get(page);
          if(aside?.dataset.signature===signature)continue;
          if(aside)removeCard(aside);aside=doc.createElement('aside');
          // Native PDF pages are overflow:hidden; cards in the page margin
          // require a reversible override. CanvasWrapper retains PDF clipping.
          const overflow=page.style.getPropertyValue('overflow'),priority=page.style.getPropertyPriority('overflow');
          page.style.setProperty('overflow','visible','important');
          aside._restorePageOverflow=()=>{if(page.style.getPropertyValue('overflow')==='visible'){if(overflow)page.style.setProperty('overflow',overflow,priority);else page.style.removeProperty('overflow');}};
          aside.className='style-custom-margin';aside.dataset.signature=signature;
          aside.setAttribute('aria-label','Page '+(pageIndex+1)+' annotations');
          aside.style.cssText='position:absolute;'+(options.side==='left'?'right':'left')+':calc(100% + 10px);top:8px;width:'+options.width+'px;max-height:calc(100% - 16px);overflow:auto;z-index:5;display:flex;flex-direction:column;gap:6px;font:'+display.fontSize+'px system-ui;text-align:start;';
          for(const annotation of matching.slice(0,200)){
            const button=doc.createElement('button'),hex=color(annotation.color)||'#aaaaaa';
            const label=settings().colorLabels?.[hex]||COLORS[hex]||hex;
            button.type='button';button.style.cssText='font:inherit;display:block;text-align:start;padding:8px;border:1px solid #888;border-inline-start:5px solid '+hex+';border-radius:2px;background:Canvas;color:CanvasText;white-space:pre-wrap;overflow-wrap:anywhere;cursor:pointer;';
            const parts=[];if(display.showQuote&&annotation.text)parts.push(String(annotation.text));if(display.showComment&&annotation.comment)parts.push(String(annotation.comment));
            const text=parts.join('\n');button.textContent=(enabled('showAnnotationColorName')?label+' · ':'')+(annotation.pageLabel||pageIndex+1)+(text?'\n'+text.slice(0,options.textLimit):'');
            button.addEventListener('click',event=>{event.stopPropagation();Promise.resolve(reader.navigate({annotationID:annotation.id})).catch(report);});
            aside.appendChild(button);
          }
          if(matching.length>200){const note=doc.createElement('span');note.textContent=`Showing 200 of ${matching.length} annotations on this page`;aside.appendChild(note);}
          page.appendChild(aside);state.cards.set(page,aside);
        }
        }
      }
      for(const [page,node]of state.cards)if(!present.has(page)||!page.isConnected){removeCard(node);state.cards.delete(page);}
    }
    function refresh(win,state){
      if(stopped||win.closed)return;
      const available=new Set(readers(win));
      for(const [reader,original]of state.themes)if(!available.has(reader)){restoreTheme(reader,original);state.themes.delete(reader);}
      for(const[reader,original]of state.sidebars)if(!available.has(reader)){
        try{if(reader._internalReader?._state?.sidebarOpen===original.applied)reader._internalReader.toggleSidebar(original.original);}catch(e){report(e);}
        state.sidebars.delete(reader);
      }
      if(state.theme!==undefined)for(const reader of available)if(!state.themes.has(reader)){
        try{themeReader(reader,state,state.theme);}catch(error){report(error);}
      }
      for(const reader of available)if(state.sidebarVisible!==undefined&&!state.sidebars.has(reader)){
        const core=reader._internalReader;if(typeof core.toggleSidebar==='function'){state.sidebars.set(reader,{original:!!core._state?.sidebarOpen,applied:state.sidebarVisible});core.toggleSidebar(state.sidebarVisible);}
      }
      try{paintCards(win,state);paintRail(win,state);}catch(error){report(error);}
      for(const[reader,control]of state.toolbars)if(!available.has(reader)){control.remove();state.toolbars.delete(reader);}
      for(const header of state.backlinkHeaders)if(!available.has(header.reader)||!header.node.isConnected){header.remove();state.backlinkHeaders.delete(header);}
      if(state.backlinkRevision!==backlinkRevision){state.backlinkRevision=backlinkRevision;for(const header of state.backlinkHeaders)header.reload();}
    }
    function attach(win){
      alive();detached.delete(win);if(windows.has(win))return windows.get(win).cleanup;
      const state={themes:new Map(),cards:new Map(),toolbars:new Map(),backlinkHeaders:new Set(),backlinkRevision,sidebars:new Map(),theme:settings().theme,margins:settings().marginAnnotations===true,sidebarVisible:typeof settings().sidebarVisible==='boolean'?settings().sidebarVisible:undefined,verticalTabs:settings().verticalTabs===true};
      const cleanup=()=>{if(!windows.has(win))return;detached.add(win);windows.delete(win);win.clearInterval(state.timer);win.removeEventListener('unload',cleanup);removeCards(state);state.rail?.remove();for(const c of state.toolbars.values())c.remove();state.toolbars.clear();for(const h of state.backlinkHeaders)h.remove();state.backlinkHeaders.clear();for(const[r,s]of state.sidebars)try{if(r._internalReader?._state?.sidebarOpen===s.applied)r._internalReader.toggleSidebar(s.original);}catch(e){report(e);}state.sidebars.clear();for(const [r,o]of state.themes)restoreTheme(r,o);state.themes.clear();};
      preferredState(state);state.cleanup=cleanup;windows.set(win,state);
      state.timer=win.setInterval(()=>refresh(win,state),1000);win.addEventListener('unload',cleanup);refresh(win,state);for(const r of readers(win))r._internalReader._updateState?.({});return cleanup;
    }
    async function applyTheme(win,theme){
      alive();if(theme==='original'){syncPreference('readerTheme','original');attach(win);const state=windows.get(win);state.theme=undefined;for(const[r,o]of state.themes)restoreTheme(r,o);state.themes.clear();const next={...settings()};delete next.theme;runtime.cache.readerSettings=next;await persist();return 'original';}requireFeature('PDFStyles');theme=palette(theme);attach(win);const state=windows.get(win);
      state.theme=theme;for(const reader of readers(win))themeReader(reader,state,theme);
      runtime.cache.readerSettings={...settings(),theme};if(typeof theme==='object'){syncPreference('readerCustomBackground',theme.background);syncPreference('readerCustomForeground',theme.foreground);syncPreference('readerTheme','custom');}else syncPreference('readerTheme',theme);await persist();return copy(theme);
    }
    async function setMarginAnnotations(win,enabled){
      requireFeature('marginAnnotation');attach(win);const state=windows.get(win);state.margins=!!enabled;
      runtime.cache.readerSettings={...settings(),marginAnnotations:!!enabled};syncPreference('marginEnabled',!!enabled);refresh(win,state);await persist();return !!enabled;
    }
    async function setColorLabel(hex,label){
      alive();hex=color(hex);if(!hex)throw new Error('Invalid annotation color');
      const labels={...(settings().colorLabels||{})};
      if(typeof label==='string'&&label.trim())labels[hex]=label.trim().slice(0,80);else delete labels[hex];
      runtime.cache.readerSettings={...settings(),colorLabels:labels};for(const[win,state]of windows)refresh(win,state);await persist();
    }
    function marginOptions(){
      const cached=settings().marginOptions||{},value={width:preference('marginWidth',cached.width),side:preference('marginSide',cached.side),textLimit:preference('marginTextLimit',cached.textLimit)};return {
        width:Number.isInteger(value.width)&&value.width>=160&&value.width<=480?value.width:210,
        side:['left','right'].includes(value.side)?value.side:'right',
        textLimit:Number.isInteger(value.textLimit)&&value.textLimit>=100&&value.textLimit<=5000?value.textLimit:1500
      };
    }
    function marginDisplay(){
      const font=Number(preference('marginFontSize',13));const types={};for(const type of ['highlight','underline','note','image','text','ink'])types[type]=preference('marginShow'+type[0].toUpperCase()+type.slice(1),true)!==false;
      return {fontSize:Number.isFinite(font)?Math.max(10,Math.min(24,font)):13,showQuote:preference('marginShowQuote',true)!==false,showComment:preference('marginShowComment',true)!==false,types};
    }
    async function setMarginOptions(win,patch){
      alive();if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['width','side','textLimit'].includes(k)))throw new Error('Invalid margin options');
      const value={...marginOptions(),...patch};
      if(!Number.isInteger(value.width)||value.width<160||value.width>480||!['left','right'].includes(value.side)||!Number.isInteger(value.textLimit)||value.textLimit<100||value.textLimit>5000)throw new Error('Margin width must be 160–480, text limit 100–5000, and side left or right');
      if(win.closed)throw new Error('Reader window is closed');attach(win);runtime.cache.readerSettings={...settings(),marginOptions:{...(settings().marginOptions||{}),...value}};for(const[k,v]of Object.entries(value))syncPreference({width:'marginWidth',side:'marginSide',textLimit:'marginTextLimit'}[k],v);
      for(const[w,state]of windows)refresh(w,state);await persist();return copy(value);
    }
    async function resetAppearance(win){
      alive();if(win.closed)throw new Error('Reader window is closed');attach(win);const state=windows.get(win),sidebarOriginal=state.sidebars.values().next().value?.original;
      state.theme=undefined;state.sidebarVisible=undefined;state.margins=false;state.verticalTabs=false;
      for(const[r,original]of state.themes)restoreTheme(r,original);state.themes.clear();
      for(const[r,original]of state.sidebars)try{if(r._internalReader?._state?.sidebarOpen===original.applied)r._internalReader.toggleSidebar(original.original);}catch(e){report(e);}state.sidebars.clear();
      removeCards(state);paintRail(win,state);
      const next={...settings(),marginAnnotations:false,verticalTabs:false};delete next.theme;delete next.sidebarVisible;runtime.cache.readerSettings=next;syncPreference('readerTheme','original');syncPreference('marginEnabled',false);syncPreference('verticalTabs',false);if(typeof sidebarOriginal==='boolean')syncPreference('readerSidebar',sidebarOriginal);
      await persist();redrawToolbars();
    }
    function annotationPalettes(){return copy(Array.isArray(settings().annotationPalettes)?settings().annotationPalettes:[]);}
    function paletteEntries(entries){
      if(!Array.isArray(entries)||!entries.length||entries.length>16)throw new Error('A palette needs 1–16 colors');
      const seen=new Set();return entries.map(entry=>{
        const hex=color(entry?.color),label=typeof entry?.label==='string'?entry.label.trim():'';
        if(!hex||!label||label.length>80||seen.has(hex))throw new Error('Palette colors must be unique six-digit colors with short labels');
        seen.add(hex);return {color:hex,label};
      });
    }
    function redrawToolbars(){for(const win of windows.keys())for(const r of readers(win))r._internalReader._updateState?.({});}
    async function saveAnnotationPalette(name,entries){
      requireFeature('annotationColors');name=nameOf(name);entries=paletteEntries(entries);const all=annotationPalettes();if(all.length>=50)throw new Error('At most 50 annotation palettes can be saved');
      const record={id:idOf(),name,entries};runtime.cache.readerSettings={...settings(),annotationPalettes:[...all,record]};await persist();redrawToolbars();return copy(record);
    }
    function activeReader(win){
      const reader=win.Zotero_Tabs?Z.Reader.getByTabID?.(win.Zotero_Tabs.selectedID):readers(win)[0];
      return reader?._window===win?reader:null;
    }
    function setAnnotationColor(win,hex){
      requireFeature('annotationColors');hex=color(hex);if(!hex)throw new Error('Invalid annotation color');
      const reader=activeReader(win),core=reader?._internalReader;
      if(!core||typeof core.setTool!=='function')throw new Error('Select an open document reader first');
      if(core._state?.readOnly)throw new Error('This document is read-only');
      const current=core._state?.tool?.type;
      const type=['highlight','underline','note','image','text','ink'].includes(current)?current:'highlight';
      core.setTool(cloneFor({type,color:hex},reader));return hex;
    }
    async function applyAnnotationPalette(win,id){
      requireFeature('annotationColors');const record=id?annotationPalettes().find(p=>p.id===id):{id:null,entries:Object.entries(COLORS).map(([color,label])=>({color,label:settings().colorLabels?.[color]||label}))};if(!record)throw new Error('Annotation palette not found');
      const entries=paletteEntries(record.entries),reader=activeReader(win);let applied=0;
      if(reader){setAnnotationColor(win,entries[0].color);applied=1;}
      const colorLabels={...(settings().colorLabels||{})};for(const entry of entries)colorLabels[entry.color]=entry.label;
      runtime.cache.readerSettings={...settings(),colorLabels};if(id)runtime.cache.readerSettings.annotationPaletteID=id;else delete runtime.cache.readerSettings.annotationPaletteID;
      for(const[w,state]of windows)refresh(w,state);await persist();redrawToolbars();return {id,applied};
    }
    async function deleteAnnotationPalette(id){
      requireFeature('annotationColors');const next={...settings(),annotationPalettes:annotationPalettes().filter(p=>p.id!==id)};
      if(next.annotationPaletteID===id)delete next.annotationPaletteID;
      runtime.cache.readerSettings=next;await persist();redrawToolbars();
    }
    async function setSidebar(win,visible){
      requireFeature('toogleSidebar');attach(win);visible=!!visible;const state=windows.get(win);state.sidebarVisible=visible;
      for(const reader of readers(win)){
        const core=reader._internalReader;if(typeof core.toggleSidebar!=='function')continue;
        const original=state.sidebars.get(reader)?.original??!!core._state?.sidebarOpen;
        state.sidebars.set(reader,{original,applied:visible});core.toggleSidebar(visible);
      }
      runtime.cache.readerSettings={...settings(),sidebarVisible:visible};syncPreference('readerSidebar',visible);await persist();return visible;
    }
    async function setVerticalTabs(win,visible){
      requireFeature('verticalTabManager');attach(win);visible=!!visible;const state=windows.get(win);state.verticalTabs=visible;
      runtime.cache.readerSettings={...settings(),verticalTabs:visible};syncPreference('verticalTabs',visible);paintRail(win,state);await persist();return visible;
    }
    function paintRail(win,state){
      if(!state.verticalTabs||!enabled('verticalTabManager')){state.rail?.remove();state.rail=null;state.railSignature='';return;}
      const data=tabs(win),signature=JSON.stringify(data);if(state.rail&&state.railSignature===signature)return;
      state.rail?.remove();const doc=win.document;if(!doc?.documentElement)return;
      const rail=doc.createElementNS('http://www.w3.org/1999/xhtml','aside');rail.className='style-custom-vertical-tabs';rail.setAttribute('aria-label','Document tabs');
      rail.style.cssText='position:fixed;left:8px;top:82px;bottom:26px;width:172px;z-index:9000;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:2px;padding:7px;overflow:auto;font:12px system-ui;';
      const make=(tag,text,parent)=>{const n=doc.createElementNS('http://www.w3.org/1999/xhtml',tag);n.textContent=text;parent.appendChild(n);return n;};
      make('strong','Document tabs',rail);const hide=make('button','×',rail);hide.setAttribute('aria-label','Hide vertical tabs');hide.addEventListener('click',()=>setVerticalTabs(win,false).catch(report));
      for(const tab of data){
        const row=make('div','',rail);row.style.cssText='display:flex;gap:3px;margin-top:5px;';
        const select=make('button',tab.title,row);select.setAttribute('aria-current',tab.selected?'page':'false');select.title=tab.title;
        select.style.cssText='flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:start;padding:6px;';
        select.addEventListener('click',()=>{try{selectTab(win,tab.id);state.railSignature='';paintRail(win,state);}catch(e){report(e);}});
        if(tab.itemID){const close=make('button','×',row);close.setAttribute('aria-label','Close '+tab.title);close.addEventListener('click',()=>{try{closeTab(win,tab.id);state.railSignature='';paintRail(win,state);}catch(e){report(e);}});}
      }
      const selected=data.find(t=>t.selected&&t.itemID);
      if(selected){const actions=make('div','',rail);for(const[label,fn]of [['↑',()=>moveTab(win,selected.id,Math.max(1,data.findIndex(t=>t.id===selected.id)-1))],['↓',()=>moveTab(win,selected.id,Math.min(data.length-1,data.findIndex(t=>t.id===selected.id)+1))],['Close other tabs',()=>closeOtherTabs(win,selected.id)]]){const b=make('button',label,actions);b.setAttribute('aria-label',label==='↑'?'Move selected tab up':label==='↓'?'Move selected tab down':label);b.addEventListener('click',()=>{try{fn();}catch(e){report(e);}});}}
      if(!data.length)make('p','No main-window document tabs',rail);
      doc.documentElement.appendChild(rail);state.rail=rail;state.railSignature=signature;
    }
    function readerContext(win){
      alive();const reader=activeReader(win),attachment=reader&&Z.Items.get(reader.itemID);
      if(win.closed||!reader||!attachment||attachment.deleted)throw new Error('Select an open document reader first');
      const attachmentID=attachment.id,libraryID=attachment.libraryID,parentID=attachment.parentID;
      const parent=parentID?Z.Items.get(parentID):null;
      const current=()=>!stopped&&!win.closed&&!detached.has(win)&&activeReader(win)===reader&&!attachment.deleted
        &&reader.itemID===attachmentID&&Z.Items.get(attachmentID)===attachment&&attachment.libraryID===libraryID&&attachment.parentID===parentID
        &&(!parentID||!!parent&&!parent.deleted&&parent.libraryID===libraryID&&Z.Items.get(parentID)===parent);
      const check=()=>{if(!current())throw new Error('The active reader changed or closed');};
      return {reader,attachment,current,check};
    }
    async function mergeSelectedAnnotations(win,keys){
      requireFeature('reader.mergeAnnotations');const context=readerContext(win),{reader,attachment}=context;
      const selected=keys===undefined?reader._internalReader?._state?.selectedAnnotationIDs:keys;
      if(!Array.isArray(selected)||selected.length<2||selected.length>50||selected.some(key=>typeof key!=='string'||!key)||new Set(selected).size!==selected.length)throw new Error('Select 2–50 distinct annotations');
      if(reader._internalReader?._state?.readOnly)throw new Error('This document is read-only');
      const ids=[];
      for(const key of [...selected]){
        const annotation=await(Z.Items.getByLibraryAndKeyAsync?.(attachment.libraryID,key)??Z.Items.getByLibraryAndKey?.(attachment.libraryID,key));context.check();
        if(!annotation||annotation.deleted||!annotation.isAnnotation?.()||annotation.parentID!==attachment.id||annotation.libraryID!==attachment.libraryID)throw new Error('Selected annotation belongs to another PDF');
        ids.push(annotation.id);
      }
      const service=runtime.libraryService;if(typeof service?.mergeAnnotations!=='function')throw new Error('Annotation merge is unavailable');context.check();
      return service.mergeAnnotations(ids,{isCurrent:context.current});
    }
    function mergeMenuHook({reader,params,append}){
      if(stopped||!enabled('reader.mergeAnnotations')||!reader?._window||typeof append!=='function')return;
      const keys=Array.isArray(params?.ids)?[...params.ids]:[];
      append({label:'Merge selected annotations · Custom',disabled:keys.length<2||keys.length>50||!!reader._internalReader?._state?.readOnly,
        onCommand(){if(stopped||activeReader(reader._window)!==reader)return;return mergeSelectedAnnotations(reader._window,keys).catch(report);}});
    }
    async function attachmentVersions(win){
      requireFeature('reader.attachmentVersionSwitch');const context=readerContext(win),{attachment}=context,parent=attachment.parentID&&Z.Items.get(attachment.parentID);if(!parent||parent.deleted)return [];
      const ids=parent.getAttachments?.(false)||[],result=[];
      for(const id of ids){
        const item=await(Z.Items.getAsync?.(id)??Z.Items.get(id));context.check();
        if(!item||item.deleted||item.parentID!==parent.id||item.libraryID!==attachment.libraryID||!item.isPDFAttachment?.())continue;
        let exists=false;try{exists=await item.fileExists();}catch(_){}context.check();if(!exists||item.deleted||item.parentID!==parent.id||item.libraryID!==attachment.libraryID)continue;
        result.push({id:item.id,parentID:parent.id,title:String(item.getDisplayTitle?.()||item.getField?.('title')||'PDF'),selected:item.id===attachment.id});
      }
      return result;
    }
    async function switchAttachmentVersion(win,id){
      const context=readerContext(win);id=Number(id);if(!Number.isSafeInteger(id)||id<1)throw new Error('Invalid attachment ID');
      const versions=await attachmentVersions(win);context.check();const target=Z.Items.get(id);if(!versions.some(v=>v.id===id)||!target||target.deleted||target.parentID!==context.attachment.parentID||target.libraryID!==context.attachment.libraryID)throw new Error('Choose an available PDF attached to this same paper');
      if(id!==context.attachment.id)await Z.Reader.open(id,undefined,{openInWindow:!win.Zotero_Tabs});return id;
    }
    function backlinkLookup(annotationID,service){
      const key=String(annotationID),cached=backlinkCache.get(key);if(cached)return cached.promise;
      const revision=backlinkRevision,entry={settled:false};
      const hasConsumer=()=>[...windows.values()].some(state=>[...state.backlinkHeaders].some(h=>String(h.annotationID)===key&&h.current()));
      entry.promise=backlinkQueue.then(async()=>{
        if(stopped||revision!==backlinkRevision||!hasConsumer()){if(backlinkCache.get(key)===entry)backlinkCache.delete(key);return null;}
        return service.backlinks(annotationID);
      }).catch(error=>{if(backlinkCache.get(key)===entry)backlinkCache.delete(key);throw error;}).finally(()=>{
        entry.settled=true;
        // Bound retained results; never evict an in-flight request and duplicate it.
        for(const[k,value]of backlinkCache){if(backlinkCache.size<=128)break;if(value.settled)backlinkCache.delete(k);}
      });
      backlinkQueue=entry.promise.catch(()=>{});backlinkCache.set(key,entry);return entry.promise;
    }
    function backlinkHook({reader,doc,params,append}){
      const win=reader?._window,key=params?.annotation?.id;
      if(stopped||!enabled('backlinks')||!win||win.closed||detached.has(win)||typeof key!=='string'||!key||!doc||typeof append!=='function')return;
      if(!windows.has(win))attach(win);const state=windows.get(win);
      for(const old of state.backlinkHeaders)if(old.reader===reader&&old.key===key){old.remove();state.backlinkHeaders.delete(old);}
      const node=doc.createElement('span'),button=doc.createElement('button'),menu=doc.createElement('div');
      button.type='button';button.textContent='Notes';button.disabled=true;button.title='Finding linked notes';button.setAttribute('aria-label','Notes referencing this annotation');node.appendChild(button);
      menu.hidden=true;menu.style.cssText='position:fixed;right:10px;top:80px;z-index:10000;max-width:320px;max-height:50vh;overflow:auto;background:Canvas;color:CanvasText;border:1px solid GrayText;padding:8px;';menu.setAttribute('aria-label','Annotation backlinks');(doc.body||doc.documentElement).appendChild(menu);
      let active=true;const current=()=>active&&!stopped&&!win.closed&&windows.get(win)===state&&node.isConnected&&readers(win).includes(reader);
      const keydown=e=>{if(e.key==='Escape')menu.hidden=true;};doc.addEventListener('keydown',keydown);
      let loadEpoch=0;const record={reader,key,node,current,annotationID:null,remove(){active=false;doc.removeEventListener('keydown',keydown);node.remove();menu.remove();}};state.backlinkHeaders.add(record);append(node);
      button.addEventListener('click',()=>{if(current())menu.hidden=!menu.hidden;});
      function reload(){
      const epoch=++loadEpoch,revision=backlinkRevision,isCurrent=()=>current()&&epoch===loadEpoch&&revision===backlinkRevision;
      button.textContent='Notes';button.disabled=true;menu.hidden=true;menu.replaceChildren();
      Promise.resolve().then(async()=>{
        const attachment=Z.Items.get(reader.itemID);if(!attachment||attachment.deleted)throw new Error('PDF attachment is unavailable');
        const annotation=await(Z.Items.getByLibraryAndKeyAsync?.(attachment.libraryID,key)??Z.Items.getByLibraryAndKey?.(attachment.libraryID,key));
        if(!isCurrent())return;
        if(!annotation||annotation.deleted||!annotation.isAnnotation?.()||annotation.parentID!==reader.itemID||annotation.libraryID!==attachment.libraryID)throw new Error('Annotation identity no longer matches this PDF');
        const service=runtime.libraryService;if(typeof service?.backlinks!=='function')throw new Error('Annotation backlinks are unavailable');
        record.annotationID=annotation.id;const links=await backlinkLookup(annotation.id,service);if(!isCurrent())return;
        if(links===null)return;const notes=links.filter(link=>link.kind==='note');button.textContent=notes.length+' notes';button.title=notes.length+' notes reference this annotation';button.disabled=!notes.length;
        for(const note of notes){const action=doc.createElement('button');action.type='button';action.textContent=String(note.title||'Untitled note');action.style.cssText='display:block;text-align:start;width:100%;margin:3px 0;';action.addEventListener('click',()=>{if(current())Promise.resolve().then(()=>{if(current())return service.openItem(note.id);}).catch(report);});menu.appendChild(action);}
      }).catch(error=>{if(isCurrent()){button.textContent='Notes unavailable';button.title=error.message;report(error);}});
      }
      record.reload=reload;reload();
    }
    function toolbarHook({reader,doc,append}){
      if(stopped||!reader?._window||!doc||typeof append!=='function')return;
      const win=reader._window;if(win.closed||detached.has(win))return;if(!windows.has(win))attach(win);const state=windows.get(win);
      state.toolbars.get(reader)?.remove();
      const container=doc.createElement('span'),button=doc.createElement('button'),menu=doc.createElement('div');
      button.type='button';button.textContent='Style';button.className='toolbar-button';button.title='Style Custom reader tools';button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','Style Custom reader tools');container.appendChild(button);
      menu.hidden=true;menu.setAttribute('aria-label','Reader appearance and workspace');
      menu.style.cssText='position:fixed;right:8px;top:42px;z-index:10000;padding:10px;width:235px;max-height:calc(100vh - 58px);overflow:auto;border:1px solid GrayText;border-radius:2px;background:Canvas;color:CanvasText;font:12px system-ui;';
      const action=(label,fn)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;b.style.cssText='display:block;width:100%;text-align:start;margin:3px 0;padding:5px;';b.addEventListener('click',()=>Promise.resolve().then(fn).catch(report));menu.appendChild(b);return b;};
      if(enabled('PDFStyles')){for(const theme of ['original','light','dark','sepia'])action(theme==='original'?'Original PDF':theme==='light'?'Light PDF':theme==='dark'?'Dark PDF':'Sepia PDF',()=>applyTheme(win,theme));
      const bg=doc.createElement('input'),fg=doc.createElement('input');bg.type=fg.type='color';bg.value='#ffffff';fg.value='#202d46';bg.setAttribute('aria-label','Custom background');fg.setAttribute('aria-label','Custom text');menu.appendChild(bg);menu.appendChild(fg);
      action('Apply custom palette',()=>applyTheme(win,{background:bg.value,foreground:fg.value}));}
      if(enabled('annotationColors')){const paletteSelect=doc.createElement('select');paletteSelect.setAttribute('aria-label','Saved annotation palette');
      const option=(label,value)=>{const o=doc.createElement('option');o.textContent=label;o.value=value;paletteSelect.appendChild(o);};
      option('Default annotation colors','');for(const p of annotationPalettes())option(p.name,p.id);paletteSelect.value=settings().annotationPaletteID||'';menu.appendChild(paletteSelect);
      action('Apply selected palette',()=>applyAnnotationPalette(win,paletteSelect.value||null));
      const chosen=annotationPalettes().find(p=>p.id===settings().annotationPaletteID);
      const entries=chosen?paletteEntries(chosen.entries):Object.entries(COLORS).map(([hex,label])=>({color:hex,label:settings().colorLabels?.[hex]||label}));
      const colors=doc.createElement('div');colors.setAttribute('aria-label','Annotation colors');colors.style.cssText='display:flex;gap:4px;flex-wrap:wrap;margin:6px 0;';menu.appendChild(colors);
      for(const entry of entries){const b=doc.createElement('button');b.type='button';b.textContent=entry.label;b.title=entry.label+' '+entry.color;b.setAttribute('aria-label','Use '+entry.label+' annotation color');b.style.cssText='border:2px solid '+entry.color+';padding:5px;background:Canvas;color:CanvasText;';b.addEventListener('click',()=>{try{setAnnotationColor(win,entry.color);}catch(e){report(e);}});colors.appendChild(b);}
      const editor=doc.createElement('details'),summary=doc.createElement('summary');summary.textContent='Save a color palette';editor.appendChild(summary);menu.appendChild(editor);
      const paletteName=doc.createElement('input');paletteName.placeholder='Palette name';paletteName.setAttribute('aria-label','New annotation palette name');editor.appendChild(paletteName);
      const paletteText=doc.createElement('textarea');paletteText.setAttribute('aria-label','Palette colors: one hex color and label per line');paletteText.value=entries.map(e=>e.color+' '+e.label).join('\n');editor.appendChild(paletteText);
      const save=doc.createElement('button');save.type='button';save.textContent='Save palette';save.addEventListener('click',()=>Promise.resolve().then(()=>{
        const values=paletteText.value.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const m=line.trim().match(/^(#[a-f\d]{6})\s+(.+)$/i);if(!m)throw new Error('Each line needs #RRGGBB and a label');return {color:m[1],label:m[2]};});
        return saveAnnotationPalette(paletteName.value,values);
      }).catch(report));editor.appendChild(save);
      action('Delete selected palette',()=>{if(!paletteSelect.value)throw new Error('Choose a saved palette');return deleteAnnotationPalette(paletteSelect.value);});}
      action('Restore original reader appearance',()=>resetAppearance(win));
      if(enabled('marginAnnotation')){const margin=doc.createElement('details'),marginTitle=doc.createElement('summary');marginTitle.textContent='Margin display';margin.appendChild(marginTitle);menu.appendChild(margin);
      const options=marginOptions(),width=doc.createElement('input'),side=doc.createElement('select'),limit=doc.createElement('input');
      width.type=limit.type='number';width.min='160';width.max='480';width.value=String(options.width);limit.min='100';limit.max='5000';limit.value=String(options.textLimit);width.setAttribute('aria-label','Margin width');limit.setAttribute('aria-label','Annotation text limit');side.setAttribute('aria-label','Margin side');
      for(const value of ['left','right']){const o=doc.createElement('option');o.value=value;o.textContent=value;side.appendChild(o);}side.value=options.side;margin.appendChild(width);margin.appendChild(side);margin.appendChild(limit);
      const saveMargin=doc.createElement('button');saveMargin.type='button';saveMargin.textContent='Apply margin display';saveMargin.addEventListener('click',()=>setMarginOptions(win,{width:Number(width.value),side:side.value,textLimit:Number(limit.value)}).catch(report));margin.appendChild(saveMargin);
      action('Toggle margin annotations',()=>setMarginAnnotations(win,!state.margins));}
      if(enabled('toogleSidebar'))action('Toggle reader sidebar',()=>setSidebar(win,!reader._internalReader?._state?.sidebarOpen));
      if(enabled('verticalTabManager'))action('Toggle vertical tabs',()=>setVerticalTabs(win,!state.verticalTabs));
      if(enabled('reader.mergeAnnotations'))action('Merge selected annotations',()=>{if(activeReader(win)!==reader)throw new Error('The active reader changed');return mergeSelectedAnnotations(win);});
      if(enabled('reader.attachmentVersionSwitch')){const versions=doc.createElement('div');versions.setAttribute('aria-label','Attachment versions');menu.appendChild(versions);
      action('Show attachment versions',async()=>{
        const data=await attachmentVersions(win);if(stopped||win.closed||!menu.isConnected||activeReader(win)!==reader)return;versions.replaceChildren();
        for(const item of data){const b=doc.createElement('button');b.type='button';b.textContent=(item.selected?'✓ ':'')+item.title;b.addEventListener('click',()=>{if(!stopped&&menu.isConnected&&activeReader(win)===reader)switchAttachmentVersion(win,item.id).catch(report);});versions.appendChild(b);}
        if(!data.length){const text=doc.createElement('span');text.textContent='No locally available PDF versions';versions.appendChild(text);}
      });
      }
      action('Open research workspace',()=>{if(typeof runtime.openWorkbench!=='function')throw new Error('Research workspace is unavailable');return runtime.openWorkbench(win);});
      const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');};
      button.addEventListener('click',()=>{menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));});
      const key=event=>{if(event.key==='Escape')close();};doc.addEventListener('keydown',key);
      (doc.body||doc.documentElement).appendChild(menu);append(container);
      state.toolbars.set(reader,{remove(){doc.removeEventListener('keydown',key);container.remove();menu.remove();}});
    }
    function tabHost(win){return win.Zotero_Tabs?win:Z.getMainWindow?.()||win;}
    function tabs(win){win=tabHost(win);return(win.Zotero_Tabs?._tabs||[]).map(tab=>({id:tab.id,title:String(tab.title||'Library'),itemID:tab.data?.itemID??null,selected:tab.id===win.Zotero_Tabs.selectedID}));}
    function selectTab(win,id){alive();win=tabHost(win);if(!tabs(win).some(t=>t.id===id))throw new Error('Tab no longer exists');return win.Zotero_Tabs.select(id);}
    function closeTab(win,id){alive();win=tabHost(win);const tab=(win.Zotero_Tabs?._tabs||[]).find(t=>t.id===id);if(!tab)throw new Error('Tab no longer exists');if(!tab.type?.startsWith('reader'))throw new Error('The library tab cannot be closed');return win.Zotero_Tabs.close(id);}
    function moveTab(win,id,targetIndex){
      alive();win=tabHost(win);if(win.closed)throw new Error('Tab window is closed');
      const current=win.Zotero_Tabs?._tabs||[],index=current.findIndex(t=>t.id===id);
      if(index<0)throw new Error('Tab no longer exists');
      if(index===0||!current[index].type?.startsWith('reader'))throw new Error('Only document tabs can be moved');
      if(!Number.isInteger(targetIndex)||targetIndex<1||targetIndex>=current.length)throw new Error('Target index must be a document tab position');
      if(typeof win.Zotero_Tabs.move!=='function')throw new Error('Native tab ordering is unavailable');
      // Native move expects an insertion boundary; our API takes final position.
      if(index!==targetIndex)win.Zotero_Tabs.move(id,targetIndex>index?targetIndex+1:targetIndex);
      for(const[w,state]of windows)paintRail(w,state);return tabs(win);
    }
    function closeOtherTabs(win,keepID){
      alive();win=tabHost(win);if(win.closed)throw new Error('Tab window is closed');
      const current=win.Zotero_Tabs?._tabs||[];
      if(!current.some(t=>t.id===keepID))throw new Error('Tab no longer exists');
      const ids=current.filter((t,i)=>i>0&&t.id!==keepID&&t.type?.startsWith('reader')).map(t=>t.id);
      if(ids.length)win.Zotero_Tabs.close(ids);
      for(const[w,state]of windows)paintRail(w,state);return {closed:ids.length};
    }
    function tabGroups(){return copy(list('tabGroups'));}
    function captureTabs(win){
      win=tabHost(win);if(win.closed)throw new Error('Tab window is closed');const saved=[];
      for(const tab of tabs(win)){
        const native=win.Zotero_Tabs._tabs.find(t=>t.id===tab.id);
        const item=tab.itemID&&Z.Items.get(tab.itemID);if(!native?.type?.startsWith('reader')||!item||item.deleted||!item.isAttachment?.())continue;
        const reader=Z.Reader.getByTabID?.(tab.id),page=reader?._internalReader?._state?.primaryViewStats?.pageIndex;
        saved.push({libraryID:item.libraryID,key:item.key,title:tab.title,selected:tab.selected,...(Number.isInteger(page)&&page>=0?{pageIndex:page}:{})});
      }
      if(!saved.length)throw new Error('Open at least one document tab to save a group');return saved;
    }
    async function saveTabGroup(win,name){
      alive();name=nameOf(name);const group={id:idOf(),name,tabs:captureTabs(win)};
      runtime.cache.tabGroups=[...list('tabGroups'),group];await persist();return copy(group);
    }
    async function renameTabGroup(id,name){
      alive();name=nameOf(name);const group=list('tabGroups').find(g=>g.id===id);if(!group)throw new Error('Tab group not found');
      const updated={...group,name};runtime.cache.tabGroups=list('tabGroups').map(g=>g.id===id?updated:g);await persist();return copy(updated);
    }
    async function updateTabGroup(win,id){
      alive();const group=list('tabGroups').find(g=>g.id===id);if(!group)throw new Error('Tab group not found');
      const updated={...group,tabs:captureTabs(win)};runtime.cache.tabGroups=list('tabGroups').map(g=>g.id===id?updated:g);await persist();return copy(updated);
    }
    async function restoreTabGroup(win,id){
      alive();const origin=win;win=tabHost(win);
      const checkWindow=()=>{alive();if(origin.closed||win.closed)throw new Error('The tab group window was closed');};
      checkWindow();const group=list('tabGroups').find(g=>g.id===id);if(!group)throw new Error('Tab group not found');
      if(!Array.isArray(group.tabs)||group.tabs.some(r=>!r||!Number.isInteger(r.libraryID)||r.libraryID<1||typeof r.key!=='string'||!r.key||r.key.length>64||r.pageIndex!==undefined&&(!Number.isInteger(r.pageIndex)||r.pageIndex<0)))throw new Error('Invalid saved tab group');
      const summary={opened:0,missing:0};let selected;
      for(const reference of group.tabs||[]){
        checkWindow();const item=await(Z.Items.getByLibraryAndKeyAsync?.(reference.libraryID,reference.key)??Z.Items.getByLibraryAndKey?.(reference.libraryID,reference.key));
        checkWindow();if(!item||item.deleted||!item.isAttachment?.()){summary.missing++;continue;}
        const existing=win.Zotero_Tabs?.getTabIDByItemID(item.id);
        const location=Number.isInteger(reference.pageIndex)&&reference.pageIndex>=0?{pageIndex:reference.pageIndex}:undefined;
        if(!existing)await Z.Reader.open(item.id,location,{openInBackground:true});
        else {
          const reader=Z.Reader.getByTabID?.(existing);
          if(reader){if(location)await reader.navigate(location);}
          else win.Zotero_Tabs.select(existing,false,{location});
        }
        checkWindow();
        if(reference.selected)selected=item.id;summary.opened++;
      }
      const selectedID=selected&&win.Zotero_Tabs?.getTabIDByItemID(selected);if(selectedID)selectTab(win,selectedID);return summary;
    }
    async function deleteTabGroup(id){alive();runtime.cache.tabGroups=list('tabGroups').filter(g=>g.id!==id);await persist();}
    function viewGroups(){return copy(list('viewGroups'));}
    function columns(win){const api=win.ZoteroPane?.itemsView?.tree?._columns;if(!Array.isArray(api?._columns))throw new Error('Open a library item table first');return api;}
    function layout(win){return columns(win)._columns.map((c,i)=>({dataKey:c.dataKey,ordinal:i,hidden:!!c.hidden,width:Math.max(24,Math.min(2000,Number(c.width)||100)),sortDirection:[-1,1].includes(c.sortDirection)?c.sortDirection:0}));}
    async function saveView(win,name){alive();const group={id:idOf(),name:nameOf(name),columns:layout(win)};runtime.cache.viewGroups=[...list('viewGroups'),group];await persist();return copy(group);}
    async function renameView(id,name){
      alive();name=nameOf(name);const group=list('viewGroups').find(g=>g.id===id);if(!group)throw new Error('View group not found');
      const updated={...group,name};runtime.cache.viewGroups=list('viewGroups').map(g=>g.id===id?updated:g);await persist();return copy(updated);
    }
    async function updateView(win,id){
      alive();if(win.closed)throw new Error('View window is closed');const group=list('viewGroups').find(g=>g.id===id);if(!group)throw new Error('View group not found');
      const updated={...group,columns:layout(win)};runtime.cache.viewGroups=list('viewGroups').map(g=>g.id===id?updated:g);await persist();return copy(updated);
    }
    async function applyView(win,id){
      alive();const group=list('viewGroups').find(g=>g.id===id);if(!group)throw new Error('View group not found');
      const api=columns(win);
      if(!['setOrder','toggleHidden','onResize','toggleSort'].every(key=>typeof api[key]==='function'))throw new Error('Column layout API unavailable');
      const seen=new Set(),saved=[];
      for(const c of group.columns||[]){
        if(!c||typeof c.dataKey!=='string'||seen.has(c.dataKey)||!Number.isInteger(c.ordinal)||c.ordinal<0||typeof c.hidden!=='boolean'||!Number.isFinite(c.width)||c.width<24||c.width>2000||![0,1,-1].includes(c.sortDirection))throw new Error('Invalid saved column layout');
        seen.add(c.dataKey);saved.push(c);
      }
      if(saved.filter(c=>c.sortDirection).length>1)throw new Error('Invalid saved column sorting');
      saved.sort((a,b)=>a.ordinal-b.ordinal);
      let target=0;for(const c of saved){const index=api._columns.findIndex(x=>x.dataKey===c.dataKey);if(index<0)continue;if(index!==target)api.setOrder(index,target);target++;}
      const widths={};for(const c of saved){const index=api._columns.findIndex(x=>x.dataKey===c.dataKey);if(index<0)continue;const native=api._columns[index],hidden=c.dataKey==='title'?false:c.hidden;if(!!native.hidden!==hidden)api.toggleHidden(index);if(!native.fixedWidth)widths[c.dataKey]=Math.max(Number(native.minWidth)||24,c.width);}
      api.onResize(widths,true);
      const sort=saved.find(c=>c.sortDirection&&api._columns.some(x=>x.dataKey===c.dataKey));
      if(sort){const index=api._columns.findIndex(c=>c.dataKey===sort.dataKey);if(api._columns[index].sortDirection!==sort.sortDirection){api.toggleSort(index);if(api._columns[index].sortDirection!==sort.sortDirection)api.toggleSort(index);}}
      await win.ZoteroPane.itemsView.refreshAndMaintainSelection();return layout(win);
    }
    async function deleteView(id){alive();runtime.cache.viewGroups=list('viewGroups').filter(g=>g.id!==id);await persist();}
    function stop(){if(stopped)return;stopped=true;backlinkRevision++;backlinkCache.clear();if(backlinkObserver!==null){Z.Notifier.unregisterObserver(backlinkObserver);backlinkObserver=null;}
      if(toolbarRegistered){
        if(typeof Z.Reader._unregisterEventListenerByPluginID==='function')Z.Reader._unregisterEventListenerByPluginID(toolbarOwner);
        else if(Array.isArray(Z.Reader._registeredListeners))Z.Reader._registeredListeners=Z.Reader._registeredListeners.filter(l=>!hookEntries.some(([,handler])=>l.handler===handler));
        else for(const[type,handler]of hookEntries)Z.Reader.unregisterEventListener?.(type,handler);
        toolbarRegistered=false;
      }
      for(const state of [...windows.values()])state.cleanup();
    }
    if(typeof Z.Notifier?.registerObserver==='function')backlinkObserver=Z.Notifier.registerObserver({notify(event,type,ids){
      if(stopped||type!=='item'||!['add','modify','delete','trash'].includes(event))return;
      if(['delete','trash'].includes(event)||(Array.isArray(ids)?ids:[ids]).some(id=>{const item=Z.Items.get(id);return !item||item.isNote?.()||item.isAnnotation?.();})){backlinkRevision++;backlinkCache.clear();}
    }},['item'],toolbarOwner+'-backlinks');
    const hookEntries=[['renderToolbar',toolbarHook],['renderSidebarAnnotationHeader',backlinkHook],['createAnnotationContextMenu',mergeMenuHook]];
    if(typeof Z.Reader?.registerEventListener==='function'){for(const[type,handler]of hookEntries)Z.Reader.registerEventListener(type,handler,toolbarOwner);toolbarRegistered=true;}
    return Object.freeze({attach,applyPreferences,applyTheme,resetAppearance,marginOptions,setMarginOptions,setMarginAnnotations,setColorLabel,setSidebar,setVerticalTabs,mergeSelectedAnnotations,attachmentVersions,switchAttachmentVersion,annotationPalettes,saveAnnotationPalette,applyAnnotationPalette,deleteAnnotationPalette,setAnnotationColor,tabs,selectTab,closeTab,moveTab,closeOtherTabs,tabGroups,saveTabGroup,renameTabGroup,updateTabGroup,restoreTabGroup,deleteTabGroup,viewGroups,saveView,renameView,updateView,applyView,deleteView,stop});
  }
  return Object.freeze({create});
});
