import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../content/importer.js',import.meta.url),'utf8');
function importer(types){const context=vm.createContext({Zotero:{ItemTypes:{getID:type=>types.includes(type)?1:false}}});vm.runInContext(script,context);return context.ZotPoPImporter;}
test('native non-paper types never silently fall back to journal articles',()=>{
 const old=importer(['journalArticle','document']);
 assert.equal(old.manualItemType({engine:'pop',itemType:'dataset'}),'document');
 assert.equal(old.manualItemType({popOriginal:{type:'grant'},itemType:'unsupported'}),'document');
 assert.equal(old.manualItemType({itemType:'unsupported'}),'journalArticle','direct legacy behavior remains');
 const modern=importer(['journalArticle','document','dataset']);
 assert.equal(modern.manualItemType({engine:'pop',itemType:'dataset'}),'dataset');
 assert.equal(modern.manualItemType({engine:'pop',itemType:'journalArticle'}),'journalArticle');
});
