/* Original, library-scoped workbench data services. UI consumers must use textContent. */
(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safe = (fn, fallback='') => { try { return fn() ?? fallback; } catch (_) { return fallback; } };
  const plain = html => String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<\/(?:p|div|li|h[1-6])>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g,(_,c)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",'#39':"'",nbsp:' '}[c])).trim();
  const remarkRevisions=new WeakMap();
  function create({Zotero:Z,runtime}) {
    let scope = Z.Libraries.userLibraryID;
    const valid = item => item && !item.deleted && !item.isFeedItem;
    const get = async id => {
      const n=Number(id); if (!Number.isSafeInteger(n)||n<=0) throw new Error('Invalid item ID');
      const item=await Z.Items.getAsync(n); if(!valid(item)) throw new Error('Item is unavailable'); return item;
    };
    const field = (item,key) => String(safe(()=>item.getField(key)));
    const pause = () => Z.Promise?.delay ? Z.Promise.delay(0) : Promise.resolve();
    const library = id => { const value=Z.Libraries.get(Number(id)); if(!value||value.libraryType==='feed') throw new Error('Library is unavailable');return value; };
    async function all(id=scope) {library(id);return (await Z.Items.getAll(Number(id),false,false)).filter(valid);}
    async function selected(ids) {
      if(ids===undefined||ids===null)return all();
      if(!Array.isArray(ids))throw new TypeError('Item IDs must be an array');
      return Promise.all([...new Set(ids.map(String))].map(get));
    }
    async function children(ids,kind) {
      const input=await selected(ids), output=new Map();
      const add=item=>{if(valid(item))output.set(item.id,item);};
      for(let i=0;i<input.length;i++) {
        const item=input[i];
        if(kind==='notes') {
          if(item.isNote?.())add(item);
          else if(item.isRegularItem?.())for(const id of item.getNotes())add(await get(id));
        } else {
          const attachments=item.isAttachment?.()?[item]:item.isRegularItem?.()?await Promise.all(item.getAttachments().map(get)):[];
          if(kind==='annotations'&&item.isAnnotation?.())add(item);
          for(const attachment of attachments) {
            if(kind==='attachments')add(attachment);
            else if(attachment.isFileAttachment?.())for(const annotation of attachment.getAnnotations())add(annotation);
          }
        }
        if(i%100===99)await pause();
      }
      return [...output.values()];
    }
    function guard(items) {
      for(const item of items) {
        if(!valid(item)||!item.isEditable?.()||!library(item.libraryID).editable)throw new Error('Item is read-only');
        if(item.hasChanged?.())throw new Error('Item has unsaved changes; save it before editing');
      }
    }
    async function mutate(items,operation,fields=[]) {
      guard(items);
      const touched=new Map();
      const capture=item=>Object.fromEntries(fields.map(field=>[field,field==='tags'?item.getTags().map(t=>({...t})):JSON.parse(JSON.stringify(item.getRelations()))]));
      const write=async(item,change)=>{
        guard([item]);
        // Capture our normalized result before save() yields to other editors.
        try{change();}finally{touched.set(item,capture(item));}
        return item.save();
      };
      try {return await Z.DB.executeTransaction(async()=>{guard(items);return operation(write);});}
      catch(error) {
        for(const [item,written] of touched) {
          try {
            const latest=capture(item),changes={};
            for(const field of fields) {
              const pairs=value=>field==='tags'?value.map(t=>[t.tag,t]):Object.entries(value).flatMap(([predicate,objects])=>(Array.isArray(objects)?objects:[objects]).map(object=>[JSON.stringify([predicate,object]),{predicate,object}]));
              const before=new Map(pairs(written[field])),after=new Map(pairs(latest[field]));
              changes[field]={removed:new Set([...before.keys()].filter(k=>!after.has(k))),added:[...after].filter(([k,v])=>!before.has(k)||JSON.stringify(before.get(k))!==JSON.stringify(v)).map(([,v])=>v)};
              item._clearChanged(field);
            }
            await item.reload(fields,true);
            // Reapply only differences made after our write. Leave them pending;
            // no edit belonging to another editor is saved by this rollback.
            for(const field of fields) {
              const {removed,added}=changes[field];if(!removed.size&&!added.length)continue;
              if(field==='tags') {
                const replacements=new Set(added.map(t=>t.tag));
                item.setTags([...item.getTags().filter(t=>!removed.has(t.tag)&&!replacements.has(t.tag)),...added]);
              } else {
                const relations={};
                for(const [predicate,objects] of Object.entries(item.getRelations())) {
                  const values=(Array.isArray(objects)?objects:[objects]).filter(object=>!removed.has(JSON.stringify([predicate,object])));
                  if(values.length)relations[predicate]=values;
                }
                for(const {predicate,object} of added){relations[predicate]||=[];if(!relations[predicate].includes(object))relations[predicate].push(object);}
                item.setRelations(relations);
              }
            }
          }catch(reloadError){Z.logError?.(reloadError);}
        }
        throw error;
      }
    }
    async function snapshot(libraryID=scope) {
      library(libraryID);scope=Number(libraryID);
      const items=(await all(scope)).filter(i=>i.isRegularItem?.()), output=[];
      const byKey=new Map(items.map(i=>[i.key,String(i.id)]));
      for(let n=0;n<items.length;n++) {
        const item=items[n],creators=safe(()=>item.getCreators(),[]);
        output.push({id:String(item.id),key:item.key,libraryID:item.libraryID,title:field(item,'title'),year:field(item,'date').match(/\b\d{4}\b/)?.[0]||'',authors:creators.map(c=>[c.firstName,c.lastName||c.name].filter(Boolean).join(' ')).join('; '),venue:field(item,'publicationTitle'),doi:field(item,'DOI'),issn:field(item,'ISSN'),url:field(item,'url'),tags:safe(()=>item.getTags(),[]).map(t=>t.tag),related:safe(()=>item.relatedItems,[]).map(k=>byKey.get(k)).filter(Boolean),itemType:safe(()=>Z.ItemTypes.getName(item.itemTypeID)),abstract:field(item,'abstractNote')});
        if(n%100===99)await pause();
      }
      return output;
    }
    function graph(items,{mode='related',query=''}={}) {
      if(!['related','tags','authors'].includes(mode))throw new Error('Unknown graph mode');
      const q=String(query).toLocaleLowerCase();
      const filtered=items.filter(i=>!q||[i.title,i.authors,i.venue,...(i.tags||[])].join(' ').toLocaleLowerCase().includes(q));
      const rows=filtered.slice(0,500),nodes=rows.map(i=>({id:String(i.id),label:i.title||'(Untitled)',itemID:String(i.id),kind:'item'}));
      const ids=new Set(nodes.map(n=>n.id)),edges=[],seen=new Set();let truncated=filtered.length>rows.length;
      function edge(a,b) {a=String(a);b=String(b);if(a===b||!ids.has(a)||!ids.has(b))return;const pair=[a,b].sort(),key=pair.join('\0');if(seen.has(key))return;if(edges.length>=2000){truncated=true;return;}seen.add(key);edges.push({source:pair[0],target:pair[1],kind:mode});}
      if(mode==='related')for(const row of rows)for(const id of row.related||[])edge(row.id,id);
      else {
        const groups=new Map();
        for(const row of rows)for(const token of mode==='tags'?row.tags||[]:String(row.authors||'').split(';')) {
          const key=String(token).trim().toLocaleLowerCase();if(!key)continue;
          if(!groups.has(key))groups.set(key,[]);groups.get(key).push(String(row.id));
        }
        // A spanning star per shared value keeps dense topic graphs navigable.
        for(const members of groups.values())for(let i=1;i<members.length;i++)edge(members[0],members[i]);
      }
      return {nodes,edges,truncated};
    }
    function tagTree(items) {
      const roots=new Map();
      for(const item of items) {
        const visited=new Set();
        for(const raw of item.tags||[]) {
          const tag=String(raw);if(!tag||/^style-custom:/.test(tag))continue;
          const parts=tag.startsWith('/')?[tag]:tag.split('/').filter(Boolean);let tree=roots,path='';
          for(const part of parts) {
            path=path?path+'/'+part:part;
            if(!tree.has(part))tree.set(part,{name:part,path,count:0,children:new Map()});
            const node=tree.get(part);if(!visited.has(path)){node.count++;visited.add(path);}tree=node.children;
          }
        }
      }
      const convert=tree=>[...tree.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(n=>({...n,children:convert(n.children)}));return convert(roots);
    }
    // Another plugin stored reading time as notes: 228 of the 233 in this
    // library. They are machine bookkeeping, not writing, so the notes view
    // shows what a person actually wrote.
    const bookkeeping = html => {
      try { return !!runtime?.legacyReading?.isBookkeeping(html); } catch (_) { return false; }
    };
    async function notes(ids) {return (await children(ids,'notes')).map(i=>{const html=safe(()=>i.getNote());return {id:String(i.id),parentID:i.parentID?String(i.parentID):null,title:safe(()=>i.getNoteTitle())||plain(html).split('\n')[0]||'(Untitled)',text:plain(html),html,modified:field(i,'dateModified')};}).filter(note=>!bookkeeping(note.html));}
    async function annotations(ids) {
      const out=[];
      for(const i of await children(ids,'annotations')) {
        const attachment=await get(i.parentID),position=safe(()=>JSON.parse(i.annotationPosition),{});
        out.push({id:String(i.id),key:i.key,parentID:attachment.parentID?String(attachment.parentID):null,attachmentID:String(attachment.id),text:i.annotationText||'',comment:i.annotationComment||'',color:i.annotationColor||'',type:i.annotationType||'',pageLabel:i.annotationPageLabel||'',pageIndex:Number.isInteger(position.pageIndex)&&position.pageIndex>=0?position.pageIndex:null});
      }
      return out;
    }
    async function attachments(ids) {const out=[];for(const i of await children(ids,'attachments'))out.push({id:String(i.id),parentID:i.parentID?String(i.parentID):null,title:field(i,'title'),contentType:i.attachmentContentType||'',path:i.isFileAttachment?.()?await i.getFilePathAsync():null,url:field(i,'url')});return out;}
    function annotationNoteMatch(html,target,attachment,route) {
      const decode=value=>{
        let result=String(value||'');
        for(let n=0;n<2;n++){
          const next=result.replace(/&(?:quot|apos|amp|lt|gt|#(?:x[0-9a-f]+|[0-9]+));/gi,entity=>{
            const named={'&quot;':'"','&apos;':"'",'&amp;':'&','&lt;':'<','&gt;':'>'};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
            const numeric=entity.slice(2,-1),code=numeric[0].toLowerCase()==='x'?parseInt(numeric.slice(1),16):Number(numeric);return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;
          });
          result=safe(()=>decodeURIComponent(next),next);if(result===next&&next===value)break;
        }
        return result;
      };
      const attachmentURI=Z.URI.getItemURI(attachment);
      // Inspect attributes rather than arbitrary key-like text in the note body.
      const attributes=Array.from(String(html||'').matchAll(/<[a-z][^>]*>/gi)).flatMap(tag=>Array.from(tag[0].matchAll(/\b(href|data-annotation)\s*=\s*("[^"]*"|'[^']*')/gi)));
      for(const attribute of attributes){
        const value=decode(attribute[2].slice(1,-1));
        if(attribute[1].toLowerCase()==='data-annotation'){
          const data=safe(()=>JSON.parse(value),null);
          if(data&&data.annotationKey===target.key&&data.attachmentURI===attachmentURI)return true;
        }else{
          const link=/^zotero:\/\/(select|open-pdf)\/(library|groups\/\d+)\/items\/([A-Z0-9]+)\/?(?:\?([^#]*))?(?:#.*)?$/.exec(value);
          if(!link||link[2]!==route)continue;
          if(link[1]==='select'&&link[3]===target.key)return true;
          if(link[3]!==attachment.key)continue;
          const parameters=String(link[4]||'').split('&').filter(p=>p.split('=')[0]==='annotation').map(p=>p.slice(p.indexOf('=')+1));
          if(parameters.length===1&&parameters[0]===target.key)return true;
        }
      }
      return false;
    }
    async function backlinks(itemID) {
      if(runtime?.featureEnabled?.('backlinks')===false)throw new Error('역링크 기능이 꺼져 있습니다. 설정 → Style Custom → 보기에서 켜세요.');
      const target=await get(itemID),items=await all(target.libraryID),out=[];
      const keys=new Set([target.key]);if(target.isRegularItem?.())for(const id of target.getAttachments())keys.add((await get(id)).key);
      const route=target.libraryID===Z.Libraries.userLibraryID?'library':'groups/'+safe(()=>Z.Groups.getGroupIDFromLibraryID(target.libraryID),'unavailable');
      const annotationAttachment=target.isAnnotation?.()?await get(target.parentID):null;
      if(annotationAttachment&&annotationAttachment.libraryID!==target.libraryID)throw new Error('Annotation attachment belongs to another library');
      const uris=[target,...items.filter(i=>keys.has(i.key))].map(i=>safe(()=>Z.URI.getItemURI(i))).filter(Boolean);
      for(let n=0;n<items.length;n++) {
        const item=items[n];if(item.id===target.id)continue;
        if(!annotationAttachment&&safe(()=>item.relatedItems,[]).includes(target.key))out.push({id:String(item.id),title:field(item,'title'),kind:'related'});
        if(item.isNote?.()) {
          const html=safe(()=>item.getNote());
          if(annotationAttachment){if(annotationNoteMatch(html,target,annotationAttachment,route))out.push({id:String(item.id),title:safe(()=>item.getNoteTitle()),kind:'note'});if(n%100===99)await pause();continue;}
          const decoded=safe(()=>decodeURIComponent(html),html);
          const links=Array.from(decoded.matchAll(/zotero:\/\/(?:select|open-pdf)\/(library|groups\/\d+)\/items\/([A-Z0-9]+)(?=[/?#"'&\s<]|$)/g)).filter(m=>m[1]===route).map(m=>m[2]);
          if(links.some(k=>keys.has(k))||uris.some(uri=>decoded.includes(uri+'"')||decoded.includes(uri+'&quot;')))out.push({id:String(item.id),title:safe(()=>item.getNoteTitle()),kind:'note'});
        }
        if(n%100===99)await pause();
      }
      return out;
    }
    async function createNote(parentID,text) {
      const parent=await get(parentID);if(!parent.isRegularItem?.())throw new Error('A regular parent item is required');guard([parent]);
      const note=new Z.Item('note');note.libraryID=parent.libraryID;note.parentID=parent.id;
      note.setNote('<div>'+String(text??'').split(/\r?\n/).map(line=>'<p>'+escape(line)+'</p>').join('')+'</div>');
      await mutate([parent],()=>note.save());return String(note.id);
    }
    async function noteFromAnnotations(ids) {
      if(!Array.isArray(ids))throw new Error('Select annotations explicitly');
      const input=await selected(ids);if(!input.length||input.some(i=>!i.isAnnotation?.()))throw new Error('Select annotations to extract');guard(input);
      const atts=await Promise.all(input.map(i=>get(i.parentID))),parents=[...new Set(atts.map(i=>i.parentID))];
      if(parents.length!==1||!parents[0])throw new Error('Annotations must share a regular parent item');
      const parent=await get(parents[0]);guard([parent,...atts]);
      const note=await Z.EditorInstance.createNoteFromAnnotations(input,{parentID:parent.id,noSave:true});note.libraryID=parent.libraryID;note.parentID=parent.id;
      await mutate([parent,...atts,...input],()=>note.save());return String(note.id);
    }
    /* A note on one annotation, written where Zotero already keeps one.

       The comment field on an annotation is the memo: it travels with the
       highlight, it shows in the reader, and it syncs. Writing these into a
       separate store would have made a second place to look. */
    const commentRevisions=new Map();
    async function setAnnotationComment(annotationID,text) {
      const annotation=await get(annotationID);
      if(!annotation?.isAnnotation?.())throw new Error('주석이 아닌 항목입니다. 주석을 고른 뒤 다시 실행하세요.');
      guard([annotation]);
      const value=String(text??'');
      const prior=annotation.annotationComment||'';
      if(prior===value)return value;
      const revision=(commentRevisions.get(String(annotationID))||0)+1;
      commentRevisions.set(String(annotationID),revision);
      annotation.annotationComment=value;
      try{await annotation.saveTx({skipSelect:true});}
      catch(error){
        // A failed save must not leave the reader showing text that was never
        // written, and must not undo a later edit that did land.
        if(commentRevisions.get(String(annotationID))===revision){
          annotation.annotationComment=prior;
        }
        throw error;
      }
      return value;
    }

    async function setRemark(itemID,text) {
      const item=await get(itemID);guard([item]);if(!runtime?.entry||!runtime.flush)throw new Error('Remark storage is unavailable');
      const entry=runtime.entry(item),prior=entry.remark,value=String(text??'');
      const revision=(remarkRevisions.get(entry)||0)+1;remarkRevisions.set(entry,revision);entry.remark=value;runtime.dirty=true;
      try{await runtime.flush();}catch(error){
        // An earlier failed save must not undo a later edit from this or another window.
        if(remarkRevisions.get(entry)===revision){if(prior===undefined)delete entry.remark;else entry.remark=prior;runtime.dirty=true;}
        throw error;
      }return value;
    }
    async function setTags(ids,tags) {
      if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'||!t.trim()))throw new TypeError('Tags must be nonempty strings');
      const input=await selected(ids);if(ids==null)throw new Error('Select items explicitly');
      const names=[...new Set(tags.map(t=>t.trim()))];
      return mutate(input,async write=>{for(const item of input)await write(item,()=>{const old=new Map(item.getTags().map(t=>[t.tag,t]));item.setTags(names.map(tag=>old.get(tag)||{tag,type:0}));});return input.length;},['tags']);
    }
    async function addTags(ids,tags) {
      if(!Array.isArray(ids))throw new Error('Select items explicitly');
      if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'||!t.trim()))throw new TypeError('Tags must be nonempty strings');
      const input=await selected(ids),names=[...new Set(tags.map(t=>t.trim()))];
      return mutate(input,async write=>{for(const item of input)await write(item,()=>{const old=item.getTags(),existing=new Set(old.map(t=>t.tag));item.setTags([...old,...names.filter(t=>!existing.has(t)).map(tag=>({tag,type:0}))]);});return input.length;},['tags']);
    }
    async function removeTags(ids,tags) {
      if(!Array.isArray(ids))throw new Error('Select items explicitly');
      if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'||!t.trim()))throw new TypeError('Tags must be nonempty strings');
      const input=await selected(ids),names=new Set(tags.map(t=>t.trim()));
      return mutate(input,async write=>{for(const item of input)await write(item,()=>{item.setTags(item.getTags().filter(tag=>!names.has(tag.tag)));});return input.length;},['tags']);
    }
    async function renameTagBranch(ids,from,to,{subtree=true}={}) {
      if(!Array.isArray(ids)||!ids.length)throw new Error('Select items explicitly');
      const name=value=>{
        if(typeof value!=='string'||!value.trim()||value.trim().length>255||/[\r\n]/.test(value))throw new Error('Enter a valid tag name');
        value=value.trim();
        if(value.startsWith('/')||value.startsWith('style-custom:')||/^[★⭐\uFE0F]+$/.test(value))throw new Error('Reading status and rating tags cannot be renamed');
        if(value.split('/').some(part=>!part))throw new Error('Tag branches cannot contain empty path segments');
        return value;
      };
      from=name(from);to=name(to);const input=await selected(ids);
      if(new Set(input.map(item=>item.libraryID)).size!==1)throw new Error('Select items in the same library');
      const result={updatedItems:0,renamedTags:0,mergedTags:0};
      return mutate(input,async write=>{
        for(const item of input){
          guard([item]);if(from===to)continue;
          const tags=item.getTags(),moves=new Map();
          for(const tag of tags)if(tag.tag===from||(subtree&&tag.tag.startsWith(from+'/'))){const target=to+tag.tag.slice(from.length);if(target.length>255)throw new Error('Renamed tag is too long');moves.set(tag.tag,target);}
          if(!moves.size)continue;
          // Unchanged destination tags retain their metadata/type during a merge.
          const next=new Map(tags.filter(tag=>!moves.has(tag.tag)).map(tag=>[tag.tag,{...tag}]));let merged=0;
          for(const tag of tags)if(moves.has(tag.tag)){const target=moves.get(tag.tag);if(next.has(target))merged++;else next.set(target,{...tag,tag:target});}
          await write(item,()=>item.setTags([...next.values()]));result.updatedItems++;result.renamedTags+=moves.size;result.mergedTags+=merged;
        }
        return result;
      },['tags']);
    }
    async function recolorAnnotations(ids,color) {
      if(runtime?.featureEnabled?.('annotationColors')===false)throw new Error('주석 색상 기능이 꺼져 있습니다. 설정 → Style Custom → 리더에서 켜세요.');
      if(!Array.isArray(ids)||!ids.length)throw new Error('Select annotations explicitly');
      if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw new Error('Use a six-digit annotation color');color=color.toLowerCase();
      const annotations=await selected(ids);
      if(annotations.some(item=>!item.isAnnotation?.())||new Set(annotations.map(item=>item.libraryID)).size!==1)throw new Error('Select annotations in the same library');
      const ancestors=new Map();
      for(const annotation of annotations){
        const attachment=await get(annotation.parentID);
        if(!attachment.isFileAttachment?.()||attachment.libraryID!==annotation.libraryID)throw new Error('Annotation attachment is unavailable in this library');ancestors.set(attachment.id,attachment);
        if(attachment.parentID){const parent=await get(attachment.parentID);if(!parent.isRegularItem?.()||parent.libraryID!==annotation.libraryID)throw new Error('Annotation parent is unavailable in this library');ancestors.set(parent.id,parent);}
        await annotation.loadDataType?.('annotationDeferred');
      }
      const parents=[...ancestors.values()];guard([...annotations,...parents]);
      const fields=['Type','Text','Comment','Color','PageLabel','SortIndex','Position','AuthorName','IsExternal'].map(name=>'annotation'+name);
      const capture=item=>Object.fromEntries(fields.map(field=>[field,item[field]]));const touched=new Map();let updated=0;
      try{return await Z.DB.executeTransaction(async()=>{
        guard([...annotations,...parents]);
        for(const item of annotations){guard([item,...parents]);if(item.annotationColor===color)continue;item.annotationColor=color;touched.set(item,capture(item));await item.save();updated++;}
        return updated;
      });}catch(error){
        for(const [item,written]of touched){try{
          const latest=capture(item),external=fields.filter(field=>latest[field]!==written[field]);
          // Annotation fields share native loaders: snapshot concurrent changes before reload.
          for(const field of fields)item._clearChanged(field);
          await item.reload(['annotation','annotationDeferred'],true);
          for(const field of external)if(latest[field]!==undefined)item[field]=latest[field];
        }catch(reloadError){Z.logError?.(reloadError);}}
        throw error;
      }
    }
    async function mergeAnnotations(ids,{isCurrent}={}) {
      if(runtime?.featureEnabled?.('reader.mergeAnnotations')===false)throw new Error('주석 병합 기능이 꺼져 있습니다. 설정 → Style Custom → 리더에서 켜세요.');
      if(!Array.isArray(ids)||ids.length<2)throw new Error('Select at least two annotations');
      if(isCurrent!==undefined&&typeof isCurrent!=='function')throw new TypeError('Invalid reader guard');
      const current=()=>{if(isCurrent&&!isCurrent())throw new Error('The active reader or selection changed');};current();
      const input=await selected(ids);current();
      if(input.length<2||input.length>50||input.some(item=>!item.isAnnotation?.()))throw new Error('Select 2 to 50 annotations');
      if(new Set(input.map(item=>item.libraryID)).size!==1||new Set(input.map(item=>item.parentID)).size!==1)throw new Error('Annotations must share the same PDF and library');
      const attachment=await get(input[0].parentID);current();
      if(!attachment.isFileAttachment?.()||attachment.attachmentContentType!=='application/pdf'||attachment.libraryID!==input[0].libraryID)throw new Error('Annotations must belong to the same PDF');
      const parents=[attachment];if(attachment.parentID){const parent=await get(attachment.parentID);current();if(!parent.isRegularItem?.()||parent.libraryID!==attachment.libraryID)throw new Error('Annotation parent is unavailable');parents.push(parent);}
      for(const item of input){await item.loadDataType?.('annotationDeferred');current();}
      const fields=['Type','Text','Comment','Color','PageLabel','SortIndex','Position','AuthorName','IsExternal'].map(name=>'annotation'+name);
      const capture=item=>Object.fromEntries([...fields.map(field=>[field,item[field]]),['tags',item.getTags().map(tag=>({...tag}))]]);
      let survivor=null,written=null;const deleted=[];
      try{return await Z.DB.executeTransaction(async()=>{
        current();guard([...input,...parents]);
        if(input.some(item=>item.annotationIsExternal))throw new Error('External annotations cannot be merged');
        const type=input[0].annotationType,color=input[0].annotationColor;
        if(!['highlight','underline'].includes(type)||input.some(item=>item.annotationType!==type))throw new Error('Merge requires the same highlight or underline type');
        if(!/^#[0-9a-f]{6}$/i.test(color)||input.some(item=>String(item.annotationColor).toLowerCase()!==color.toLowerCase()))throw new Error('Merge requires the same annotation color');
        const positions=new Map(),pages=new Map();let rectangleCount=0;
        const addRects=(page,rects)=>{
          if(!Array.isArray(rects)||!rects.length||rects.some(rect=>!Array.isArray(rect)||rect.length!==4||rect.some(n=>typeof n!=='number'||!Number.isFinite(n))||rect[0]>=rect[2]||rect[1]>=rect[3]))throw new Error('Unsupported annotation rectangle geometry');
          rectangleCount+=rects.length;if(rectangleCount>10000)throw new Error('Too many annotation rectangles to merge');
          if(!pages.has(page))pages.set(page,[]);pages.get(page).push(...rects.map(rect=>[...rect]));
        };
        for(const item of input){
          let position;try{position=JSON.parse(item.annotationPosition);}catch(_){throw new Error('Invalid annotation geometry');}
          if(!position||!Number.isSafeInteger(position.pageIndex)||position.pageIndex<0||Object.keys(position).some(key=>!['pageIndex','rects','nextPageRects'].includes(key)))throw new Error('Unsupported annotation geometry');
          positions.set(item,position);
        }
        const ordered=[...input].sort((a,b)=>positions.get(a).pageIndex-positions.get(b).pageIndex||String(a.annotationSortIndex||'').localeCompare(String(b.annotationSortIndex||''))||a.id-b.id);
        for(const item of ordered){const position=positions.get(item);addRects(position.pageIndex,position.rects);if(position.nextPageRects!==undefined)addRects(position.pageIndex+1,position.nextPageRects);}
        const pageIndexes=[...pages.keys()].sort((a,b)=>a-b),firstPage=pageIndexes[0];
        if(pageIndexes.length>2||pageIndexes.at(-1)-firstPage>1)throw new Error('Merge supports one page or two adjacent pages');
        survivor=ordered[0];const position={pageIndex:firstPage,rects:pages.get(firstPage)};if(pages.has(firstPage+1))position.nextPageRects=pages.get(firstPage+1);
        const tags=new Map();for(const item of ordered)for(const tag of item.getTags())if(!tags.has(tag.tag))tags.set(tag.tag,{...tag});
        const text=ordered.map(item=>item.annotationText||'').filter(Boolean).join('\n\n'),comment=ordered.map(item=>item.annotationComment||'').filter(Boolean).join('\n\n');
        if(text.length>1000000||comment.length>1000000)throw new Error('Merged annotation text is too long');
        try{survivor.annotationText=text;survivor.annotationComment=comment;survivor.annotationPosition=JSON.stringify(position);survivor.setTags([...tags.values()]);}finally{written=capture(survivor);}
        await survivor.save();current();
        for(const item of ordered.slice(1)){
          guard([item,...parents]);current();deleted.push(item);item.deleted=true;await item.save();current();
        }
        return String(survivor.id);
      });}catch(error){
        if(survivor&&written){try{
          const latest=capture(survivor),external=fields.filter(field=>latest[field]!==written[field]);
          const before=new Map(written.tags.map(tag=>[tag.tag,tag])),after=new Map(latest.tags.map(tag=>[tag.tag,tag]));
          const removed=new Set([...before.keys()].filter(key=>!after.has(key))),added=[...after].filter(([key,tag])=>!before.has(key)||JSON.stringify(before.get(key))!==JSON.stringify(tag)).map(([,tag])=>tag);
          for(const field of fields)survivor._clearChanged(field);survivor._clearChanged('tags');
          await survivor.reload(['annotation','annotationDeferred','tags'],true);
          for(const field of external)if(latest[field]!==undefined)survivor[field]=latest[field];
          if(removed.size||added.length){const replaced=new Set(added.map(tag=>tag.tag));survivor.setTags([...survivor.getTags().filter(tag=>!removed.has(tag.tag)&&!replaced.has(tag.tag)),...added]);}
        }catch(reloadError){Z.logError?.(reloadError);}}
        for(const item of deleted){try{item._clearChanged('deleted');item._clearChanged('synced');await item.reload(['primaryData'],true);}catch(reloadError){Z.logError?.(reloadError);}}
        if(survivor)try{await attachment.reload?.(['childItems'],true);}catch(reloadError){Z.logError?.(reloadError);}
        throw error;
      }
    }
    async function relate(ids) {
      if(!Array.isArray(ids)||ids.length<2)throw new Error('Select at least two items');const input=await selected(ids);
      if(input.length<2||input.some(i=>!i.isRegularItem?.())||new Set(input.map(i=>i.libraryID)).size!==1)throw new Error('Select regular items in the same library');
      if(input.length>100)throw new Error('Select at most 100 items to relate');
      return mutate(input,async write=>{for(const item of input)await write(item,()=>{for(const other of input)if(item!==other)item.addRelatedItem(other);});return input.length;},['relations']);
    }
    async function unrelate(ids) {
      if(!Array.isArray(ids)||ids.length<2)throw new Error('Select at least two items');const input=await selected(ids);
      if(input.length<2||input.some(item=>!item.isRegularItem?.())||new Set(input.map(item=>item.libraryID)).size!==1)throw new Error('Select regular items in the same library');
      if(input.length>100)throw new Error('Select at most 100 items to unlink');
      const predicate=Z.Relations.relatedItemPredicate,targets=new Set(input.map(item=>Z.URI.getItemURI(item)));let updated=0;
      return mutate(input,async write=>{
        for(const item of input){guard([item]);const relations=item.getRelations(),value=relations[predicate],objects=Array.isArray(value)?value:value?[value]:[];
          const kept=objects.filter(uri=>!targets.has(uri));if(kept.length===objects.length)continue;
          const next={...relations};if(kept.length)next[predicate]=kept;else delete next[predicate];
          await write(item,()=>item.setRelations(next));updated++;
        }
        return updated;
      },['relations']);
    }
    async function openItem(id,options={}) {
      let item=await get(id);const pane=Z.getMainWindow?.()?.ZoteroPane;if(!pane)throw new Error('No Zotero window is available');
      const location={};if(Number.isInteger(options.pageIndex)&&options.pageIndex>=0)location.pageIndex=options.pageIndex;if(options.annotationKey)location.annotationKey=String(options.annotationKey);
      if(item.isNote?.())return pane.openNoteWindow(item.id);
      if(item.isAnnotation?.()){location.annotationKey=item.key;item=await get(item.parentID);}
      if(item.isAttachment?.()&&['application/pdf','application/epub','text/html'].includes(item.attachmentContentType)&&item.isFileAttachment?.())return Z.Reader.open(item.id,location);
      return pane.viewItems([item],undefined,{location});
    }
    async function collectionItems(collectionID,{libraryID,recursive=false}={}) {
      const chosen=Number(libraryID),id=Number(collectionID);
      if(!Number.isSafeInteger(chosen)||chosen<=0)throw new Error('Choose the collection library explicitly');library(chosen);
      if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid collection ID');
      if(typeof recursive!=='boolean')throw new TypeError('Recursive collection scope must be boolean');
      const pending=[id],visited=new Set(),items=new Set();
      for(let offset=0;offset<pending.length;offset++){
        const currentID=pending[offset];if(visited.has(currentID))continue;visited.add(currentID);
        const collection=await Z.Collections.getAsync(currentID);
        if(!collection||collection.deleted)throw new Error('Collection is unavailable');
        if(collection.libraryID!==chosen)throw new Error('Collection does not belong to the chosen library');
        await collection.loadDataType?.('childItems');
        for(const item of collection.getChildItems(false,false)||[]){
          if(!valid(item)||!item.isRegularItem?.())continue;
          if(item.libraryID!==chosen)throw new Error('Collection item belongs to another library');items.add(String(item.id));
        }
        if(recursive){
          await collection.loadDataType?.('childCollections');
          for(const child of collection.getChildCollections(false,false)||[])if(!child.deleted)pending.push(child.id);
        }
        if(visited.size%50===0)await pause();
      }
      return [...items];
    }
    async function collections(libraryID=scope) {
      library(libraryID);const output=[];
      for(const collection of Z.Collections.getByLibrary(Number(libraryID),true,false)) {
        const children=collection.getChildItems(false,false)||[];
        output.push({id:String(collection.id),name:collection.name,count:children.filter(i=>valid(i)&&i.isRegularItem?.()).length,parentID:collection.parentID?String(collection.parentID):null});
        if(output.length%100===0)await pause();
      }
      return output;
    }
    /* Into the trash, never erased: Zotero's own trash keeps it, and the
       reader restores it there. One save per item, outside any transaction. */
    async function trashItems(ids) {
      let moved=0;
      for(const id of ids){const item=await get(id);if(!item||item.deleted)continue;item.deleted=true;await item.saveTx();moved++;}
      return moved;
    }
    return {trashItems,snapshot,graph,tagTree,notes,annotations,attachments,backlinks,createNote,noteFromAnnotations,setRemark,setTags,addTags,removeTags,renameTagBranch,recolorAnnotations,mergeAnnotations,setAnnotationComment,relate,unrelate,openItem,collectionItems,collections};
  }
  const api={create};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.CustomStyleLibrary=api;
})(typeof globalThis!=='undefined'?globalThis:this);
