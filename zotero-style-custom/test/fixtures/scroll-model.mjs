/* A small layout model for linkedom, enough to see a scroll position jump.

   linkedom has no layout: scrollTop is not a property and getBoundingClientRect
   is all zeros. Here every element is a block: one 20px line of its own, then
   its element children stacked under it. A hidden element (the hidden
   attribute, or display:none set inline) takes no room. An element that
   scrolls -- the panel's .sc-body, and any element named in `scrollers` --
   shows `clientHeight` px of its content and scrolls the rest.

   scrollTop is writable and recorded, and it is clamped the way a browser
   clamps it at layout: when content shrinks below the position, the position
   falls. Layout runs whenever geometry is read (scrollTop, scrollHeight,
   clientHeight, getBoundingClientRect) and on a timer while `frames()` is
   running, which stands in for the frames a browser paints between tasks.
   So a redraw that empties the scroll area and refills it after an await
   loses its place here exactly as it does in Zotero.

   A float with an inline height takes no room in the flow but makes the box
   that holds it at least that tall, as a block formatting context does. Padding
   does not hold a flex item's scroll height (see scrollHeight). */
const LINE=20;
export function installScrollModel(win,{scrollers=[],bodyHeight=300,innerHeight=100}={}){
 const doc=win.document;
 const proto=win.HTMLElement.prototype;
 const stored=new WeakMap();// element -> {top,left}
 const isScroller=el=>el.nodeType===1&&(el.classList?.contains('sc-body')||scrollers.some(sel=>el.matches?.(sel)));
 const hidden=el=>el.hasAttribute?.('hidden')||/display\s*:\s*none/.test(el.getAttribute?.('style')||'');
 const kids=el=>[...(el.children||[])];
 const view=el=>el.classList?.contains('sc-body')?bodyHeight:innerHeight;
 // Height of everything inside el (not el's own line).
 // A float (style float:left|right with an inline height) takes no room in the flow; the box that holds it is at least as tall.
 const floatHeight=el=>{const style=el.getAttribute?.('style')||'';if(!/float\s*:\s*(left|right)/.test(style))return null;const m=/(?:^|;)\s*height\s*:\s*([\d.]+)px/.exec(style);return m?Number(m[1]):0;};
 function contentHeight(el){let h=0,floats=0;for(const c of kids(el)){const f=floatHeight(c);if(f!==null){if(!hidden(c))floats=Math.max(floats,h+f);continue;}h+=outerHeight(c);}return Math.max(h,floats);}
 function outerHeight(el){if(hidden(el))return 0;const f=floatHeight(el);if(f!==null)return f;if(isScroller(el))return LINE+view(el);return LINE+contentHeight(el);}
 // Padding does not count: .sc-body is a flex item, and a flex item cannot shrink below its padding, so a
 // padded scroll area grows instead of scrolling (seen in Chrome). A hold has to be content.
 function scrollHeight(el){return LINE+contentHeight(el);}
 function maxTop(el){return Math.max(0,scrollHeight(el)-LINE-view(el));}
 function clampAll(){
  for(const el of doc.querySelectorAll('*')){
   const s=stored.get(el);if(!s)continue;
   if(!el.isConnected){continue;}
   const m=maxTop(el);if(s.top>m)s.top=m;if(s.top<0)s.top=0;
  }
 }
 // Document position of el's top edge, scrolled.
 function top(el){
  let y=0,cur=el;
  while(cur&&cur.parentElement){
   const parent=cur.parentElement;
   if(hidden(cur))return y;
   y+=LINE;
   for(const sib of kids(parent)){if(sib===cur)break;y+=outerHeight(sib);}
   if(isScroller(parent))y-=(stored.get(parent)?.top||0);
   cur=parent;
  }
  return y-LINE;
 }
 const layout=()=>clampAll();
 Object.defineProperty(proto,'scrollTop',{configurable:true,
  get(){if(!isScroller(this))return 0;layout();return stored.get(this)?.top||0;},
  set(v){if(!isScroller(this))return;const s=stored.get(this)||{top:0,left:0};s.top=Math.max(0,Math.min(maxTop(this),Math.round(Number(v)||0)));stored.set(this,s);record.push([this,s.top]);}});
 Object.defineProperty(proto,'scrollLeft',{configurable:true,get(){return stored.get(this)?.left||0;},set(v){const s=stored.get(this)||{top:0,left:0};s.left=Number(v)||0;stored.set(this,s);}});
 Object.defineProperty(proto,'scrollHeight',{configurable:true,get(){layout();return isScroller(this)?scrollHeight(this):outerHeight(this);}});
 Object.defineProperty(proto,'clientHeight',{configurable:true,get(){layout();return isScroller(this)?view(this):(hidden(this)?0:outerHeight(this));}});
 Object.defineProperty(proto,'clientWidth',{configurable:true,get(){layout();return hidden(this)?0:800;}});
 proto.getBoundingClientRect=function(){layout();if(!this.isConnected||hidden(this))return {top:0,bottom:0,left:0,right:0,width:0,height:0,x:0,y:0};const t=top(this),h=outerHeight(this);return {top:t,bottom:t+h,left:0,right:800,width:800,height:h,x:0,y:t};};
 proto.getClientRects=function(){const r=this.getBoundingClientRect();return r.height?[r]:[];};
 proto.scrollIntoView=function(opts){
  let scroller=this.parentElement;while(scroller&&!isScroller(scroller))scroller=scroller.parentElement;if(!scroller)return;
  const a=this.getBoundingClientRect(),b=scroller.getBoundingClientRect(),viewTop=b.top+LINE,viewBottom=viewTop+view(scroller);
  const block=typeof opts==='object'?opts.block:(opts===false?'end':'start');
  if(block==='nearest'){if(a.top<viewTop)scroller.scrollTop+=a.top-viewTop;else if(a.bottom>viewBottom)scroller.scrollTop+=Math.min(a.top-viewTop,a.bottom-viewBottom);}
  else if(block==='center')scroller.scrollTop+=(a.top+a.bottom)/2-(viewTop+viewBottom)/2;
  else scroller.scrollTop+=a.top-viewTop;
 };
 // Focus: an element taken out of the document is no longer focused; focus falls to the document body (Gecko and Chrome).
 Object.defineProperty(doc,'activeElement',{configurable:true,get(){const f=this._focusedElement;return f&&f.isConnected?f:this.body;}});
 proto.focus=function(opts){this.ownerDocument._focusedElement=this;focusLog.push([this,opts]);if(!opts?.preventScroll)this.scrollIntoView?.({block:'nearest'});};
 const record=[],focusLog=[];
 let timer=null;
 return {
  layout,record,focusLog,LINE,bodyHeight,
  // Paint frames between tasks, as a browser does, until stopped.
  frames(){if(!timer)timer=setInterval(layout,0);return()=>{clearInterval(timer);timer=null;};},
  stop(){if(timer){clearInterval(timer);timer=null;}},
  max:el=>maxTop(el),
 };
}
