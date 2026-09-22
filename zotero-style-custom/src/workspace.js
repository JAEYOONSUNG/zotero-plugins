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
 const tokenize=query=>[...norm(query).matchAll(/"([^"]+)"|(\S+)/g)].map(m=>m[1]||m[2]);
 /* A lone letter is an initial, not a substring: "J. Y. Sung" is looking for
    Jae Yoon Sung, not for every title with a j in it. */
 const INITIAL=/^\p{L}\.?$/u;
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
  const q=norm(query).trim();if(!q)return 0;
  const title=norm(item&&item.title);
  return title===q?0:title.startsWith(q)?1:title.includes(q)?2:3;
 }
 function rankByQuery(items,query){
  if(!norm(query).trim())return [...items];
  return items.map((item,index)=>({item,index,tier:relevance(item,query)}))
   .sort((a,b)=>a.tier-b.tier||a.index-b.index).map(entry=>entry.item);
 }
 function filter(items,options={}) {
  const tokens=tokenize(options.query),initials=tokens.some(t=>INITIAL.test(t));
  return items.filter(item=>{
   const hay=norm([item.title,item.authors,item.venue,item.doi,item.abstract,item.year,item.itemType,item.issn,...(item.tags||[])].join(' '));
   const starts=initials?wordsOf(hay):null;
   return tokens.every(t=>hit(hay,t,starts)) && (!options.type||item.itemType===options.type)
    && (!options.tag||(item.tags||[]).some(t=>t===options.tag||t.startsWith(options.tag+'/')))
    && (!options.status||item.status===options.status)
    && (!options.ratingMin||Number(item.rating)>=Number(options.ratingMin))
    && (!options.yearFrom||Number(item.year)>=Number(options.yearFrom)) && (!options.yearTo||Number(item.year)<=Number(options.yearTo));
  });
 }
 function sortItems(items,order='library'){
  const result=[...items];
  const field=({'year-desc':'year','citations-desc':'citations','rating-desc':'rating','time-desc':'seconds'})[order];
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
  const visited=Object.keys(pages).filter(k=>/^\d+$/.test(k)&&Number(k)<total&&Number(pages[k])>0).length;
  return {total,visited,percent:total?Math.round(visited/total*100):null,pages};
 }
 function id(cache,prefix){cache.workspaceSequence=(Number(cache.workspaceSequence)||0)+1;return prefix+'-'+cache.workspaceSequence+'-'+Date.now().toString(36);}
 function createBoard(cache,name){if(!text(name).trim())throw new Error('보드 이름을 입력하세요.');cache.boards||=[];if(cache.boards.length>=100)throw new Error('보드는 100개까지 만들 수 있습니다. 쓰지 않는 보드를 지우세요.');const b={id:id(cache,'board'),name:text(name).trim().slice(0,200),nodes:[],edges:[]};cache.boards.push(b);return b;}
 function addToBoard(cache,board,items){if(board.nodes.length+items.length>500)throw new Error('보드 하나에 항목은 500개까지입니다. 몇 개를 빼고 다시 넣으세요.');for(const item of items){if(board.nodes.some(n=>n.itemID===String(item.id)))continue;const i=board.nodes.length;board.nodes.push({id:id(cache,'card'),itemID:String(item.id),label:text(item.title),note:'',color:'#ffffff',x:25+(i%3)*220,y:25+Math.floor(i/3)*130});}return board;}
 function addBoardNote(cache,board,value){if(board.nodes.length>=500)throw new Error('보드 하나에 항목은 500개까지입니다. 몇 개를 빼고 다시 넣으세요.');const n={id:id(cache,'note'),itemID:null,label:'메모',note:text(value).slice(0,50000),color:'#f3f4f6',x:40,y:40};board.nodes.push(n);return n;}
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
 const api={filter,sortItems,norm,matches,relevance,rankByQuery,csv,matrix,layout,progress,createBoard,addToBoard,addBoardNote,moveCard,linkCards,removeCard,renameBoard,updateCard,unlinkCards,deleteBoard,restoreBoard};
 root.CustomStyleWorkspace=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(globalThis);
