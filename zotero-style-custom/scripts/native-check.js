await until(() => Zotero.getMainWindow()?.ZoteroPane?.itemsView, 'Main window not ready');
check(Zotero.DataDirectory.dir === input.data, 'Isolation failed');
Zotero.Prefs.set('extensions.style-custom.autoCitations',false,true);
Zotero.Prefs.set('extensions.style-custom.metadataCitations',false,true);
const first = new Zotero.Item('journalArticle');
first.setField('title', 'Synthetic hover verification: <i>Formatted title</i> ' + 'a long readable title with styled content '.repeat(14));
first.setField('publicationTitle', 'Science');
first.setField('extra', 'Citations: 2446 (OpenAlex, 2026-09-11)');
first.setField('DOI','10.1234/native-citation');
first.addTag('/unread');await first.saveTx();
const done = new Zotero.Item('journalArticle');done.setField('title','Synthetic completed paper');done.setField('publicationTitle','NATURE');done.addTag('/done');await done.saveTx();
await Zotero.File.putContentsAsync(input.data + '/zoterostyle.json', JSON.stringify({
  [first.key]: { readingTime:{data:{0:1260}},citedCount:{'Total(DOI)':2112} },
  Science:{rank:{sciif:'47.3'}}
}));
const file=Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);file.initWithPath(input.xpi);
const addon=await AddonManager.installTemporaryAddon(file);
await until(()=>Zotero.StyleCustom && Zotero.ItemTreeManager.getCustomColumns().filter(c=>c.pluginID===input.id).length===19,'Plugin columns missing');
const runtime=Zotero.StyleCustom, win=Zotero.getMainWindow();
await until(()=>win.document.getElementById('style-custom-itemmenu'),'Native menu missing');
const metrics=runtime.state(first);
check(runtime.metrics(done).impactFactor===56.1 && runtime.metrics(done).impactYear===2025, 'Verified catalog or case-insensitive journal matching failed');
check(metrics.seconds===1260 && metrics.status==='reading' && metrics.impactFactor===47.3 && metrics.citations===2446,'Imported metadata/status mismatch: '+JSON.stringify(metrics));
await runtime.addReading(first,5);
check(runtime.metrics(first).seconds===1265,'New reading time not accumulated');
await runtime.addReading(done,5);check(runtime.state(done).status==='done','Done status regressed');
await runtime.edit([first],{rating:4});check(runtime.state(first).rating===4,'Rating did not persist');
await first.reload(['primaryData','tags'],true);check(first.getTags().some(t=>t.tag==='style-custom:rating:4'),'Rating tag not in database');
win.resizeTo(1100,800);await win.ZoteroPane.selectItem(first.id);await wait(350);
await runtime.useColumns(win);
await until(()=>win.document.querySelector('#zotero-items-tree .row .cell.title .cell-text'),'Native title missing');
const texts=[...win.document.querySelectorAll('#zotero-items-tree .row .cell.title .cell-text')];
const text=texts.find(n=>n.textContent.startsWith('Synthetic hover verification:'));
check(text && text.scrollWidth>text.clientWidth,'Title is not overflowing');
const cell=text.closest('.cell.title'), markup=text.innerHTML;
cell.dispatchEvent(new win.MouseEvent('mouseover',{bubbles:true}));cell.dispatchEvent(new win.MouseEvent('mousemove',{bubbles:true}));
await wait(850);const moved=Math.abs(text.scrollLeft);check(moved>10,'Native hover did not move');
check(text.innerHTML===markup,'Title markup changed');
cell.dispatchEvent(new win.MouseEvent('mouseout',{bubbles:true,relatedTarget:win.document.documentElement}));await wait(80);check(text.scrollLeft===0,'Hover did not reset');
const row=text.closest('.row');
check(row.textContent.includes('reading') && row.textContent.includes('47.3') && row.textContent.includes('2446'),'Actual native custom columns missing: '+row.textContent);
const originalHTTP=Zotero.HTTP.request;
try {
  Zotero.HTTP.request=function(method,url,options) {
    if(url.startsWith('https://api.openalex.org/'))return Promise.resolve({response:{results:[{doi:'https://doi.org/10.1234/native-citation',cited_by_count:0}]}});
    return originalHTTP.call(this,method,url,options);
  };
  const refreshed=await runtime.refreshCitations([first],{force:true});
  check(refreshed.ok===1 && runtime.metrics(first).citations===0 && runtime.metrics(first).citationSource==='OpenAlex','Verified zero did not replace stale Extra');
  check(!runtime.citationDue(first),'Fresh citation cache was scheduled again');
  const noDoi=new Zotero.Item('journalArticle');
  noDoi.setField('title','A precisely identified citation fallback fixture');noDoi.setField('date','2025');
  noDoi.setCreators([{firstName:'Test',lastName:'Author',creatorTypeID:Zotero.CreatorTypes.getID('author')}]);await noDoi.saveTx();
  check(runtime.citationRecord(noDoi).firstAuthor==='Author','Native author type was not resolved');
  Zotero.HTTP.request=function(method,url,options){
    if(url.startsWith('https://api.crossref.org/works?'))return Promise.resolve({status:200,response:{message:{items:[{DOI:'10.1234/native-title-fixture',title:[noDoi.getField('title')],issued:{'date-parts':[[2025]]},author:[{family:'Author',given:'Test'}],'is-referenced-by-count':7}]}}});
    return originalHTTP.call(this,method,url,options);
  };
  check((await runtime.refreshCitations([noDoi],{force:true})).ok===1 && runtime.metrics(noDoi).citations===7,'Native no-DOI title fallback failed');
  let autoRequests=0;
  Zotero.HTTP.request=function(method,url,options){
    if(url.startsWith('https://api.openalex.org/works?')) {
      autoRequests++;
      const filter=decodeURIComponent(url.match(/filter=([^&]+)/)[1]);
      const dois=filter.slice(4).split('|');
      return Promise.resolve({status:200,response:{results:dois.map(doi=>({doi,cited_by_count:doi.endsWith('native-auto-first')?0:12}))}});
    }
    return originalHTTP.call(this,method,url,options);
  };
  Zotero.Prefs.set('extensions.style-custom.metadataCitations',true,true);
  const autoItem=new Zotero.Item('journalArticle');autoItem.setField('title','Automatic metadata citation fixture');
  autoItem.setField('DOI','10.1234/native-auto-first');autoItem.setField('extra','Notes: preserve this note');await autoItem.saveTx();
  await until(()=>autoItem.getField('extra').includes('Citations: 0 (OpenAlex,'),'New item event did not query and store citations automatically');
  check(autoItem.getField('extra').startsWith('Notes: preserve this note\n'),'Automatic citation write removed other Extra metadata');
  await wait(1600);check(autoRequests===1,'Own Extra write caused a repeated network query');
  autoItem.setField('DOI','10.1234/native-auto-second');await autoItem.saveTx();
  await until(()=>autoItem.getField('extra').includes('Citations: 12 (OpenAlex,'),'Metadata modification did not refresh citations');
  check((autoItem.getField('extra').match(/^Citations:/gm)||[]).length===1,'Automatic update duplicated citation lines');
  await wait(1600);check(autoRequests===2,'Metadata write created an observer loop');
  const bulk=await runtime.syncLibraryCitations(Zotero.Libraries.userLibraryID);
  check(bulk.saved>=2 && bulk.errors===0 && !bulk.running,'Bulk metadata save failed');
  check(first.getField('extra').includes('Citations: 0 (OpenAlex,') && noDoi.getField('extra').includes('Citations: 7 (Crossref,'),'Existing verified citations were not saved in metadata');
} finally {Zotero.HTTP.request=originalHTTP;}
await addon.disable();
await until(()=>!Zotero.StyleCustom && !win.document.getElementById('style-custom-itemmenu') &&
  !Zotero.ItemTreeManager.getCustomColumns().some(c=>c.pluginID===input.id),'Disable cleanup failed');
await addon.enable();await until(()=>Zotero.StyleCustom,'Reenable failed');
await until(()=>Zotero.StyleCustom.cache.citationMetadataMigrated===true,'One-time cached citation metadata migration failed');
check(Zotero.StyleCustom.metrics(first).seconds===1265,'Time did not survive disable/reload');
check(Zotero.StyleCustom.metrics(first).citations===0 && Zotero.StyleCustom.metrics(first).citationCheckedAt,'Verified citation cache did not survive reload');
check(win.document.querySelectorAll('#style-custom-itemmenu').length===1,'Duplicate menu');
return {actualXpi:true,columns:19,legacySeconds:1260,newSeconds:1265,status:'reading',donePreserved:true,impactFactor:47.3,verifiedNatureIF:56.1,verifiedNatureYear:2025,verifiedZeroCitations:true,citationCachePersisted:true,staleExtraCannotOverride:true,nativeAuthorResolved:true,noDOITitleFallback:true,automaticNewItemCitations:true,automaticMetadataUpdate:true,bulkExtraSave:true,oneTimeMetadataMigration:true,extraMetadataPreserved:true,noNotifierLoop:true,hoverMovedPixels:moved,hoverReset:true,richMarkupPreserved:true,nativeColumns:true,ratingPersisted:true,reenabled:true,independentStoredTime:true};
