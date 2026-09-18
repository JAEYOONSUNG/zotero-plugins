import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DOMParser} from 'linkedom';
import J from '../src/journals.js';
const row=(title,extra={})=>({title,aliases:[],issns:[],impactFactor:5.5,year:2025,sourceURL:'https://www.nature.com/test/journal-impact',checkedAt:'2026-09-13',evidence:'Official labeled JIF.',...extra});
const item=(title,ISSN='',journalAbbreviation='')=>({getField:k=>({publicationTitle:title,ISSN,journalAbbreviation}[k]||'')});
test('normalization handles capitalization, ampersands and explicit abbreviations, never fuzzy titles',()=>{
 const resolver=J.create([row('PLOS ONE'),row('Molecular Cell'),row('Cell Host & Microbe',{aliases:['Cell Host Microbe']})]);
 assert.equal(resolver.lookup(item('PLoS ONE')).title,'PLOS ONE');
 assert.equal(resolver.lookup(item('Cell Host and Microbe')).title,'Cell Host & Microbe');
 assert.equal(resolver.lookup(item('Different', '', 'Cell Host Microbe')).title,'Cell Host & Microbe');
 assert.equal(resolver.lookup(item('Cell')),null);
 assert.equal(resolver.lookup(item('Molecular Cell Reports')),null);
});
test('valid ISSN matches missing names and conflicting multiple identities fail closed',()=>{
 const r=J.create([row('Nature',{issns:['0028-0836']}),row('Science',{issns:['0036-8075']})]);
 assert.equal(J.issn('0028-0837'),null);
 assert.equal(r.lookup(item('','00280836')).title,'Nature');
 assert.equal(r.lookup(item('Nature','0028-0836,0036-8075')),null);
});
test('newest documented year wins, ambiguous same-year values and aliases are not guessed',()=>{
 assert.equal(J.create([row('Nature',{year:2024,impactFactor:4}),row('Nature')]).lookup(item('Nature')).impactFactor,5.5);
 assert.equal(J.create([row('Nature'),row('Nature',{impactFactor:6})]).lookup(item('Nature')),null);
 assert.equal(J.create([row('Nature',{aliases:['Ambiguous']}),row('Science',{aliases:['Ambiguous']})]).lookup(item('Ambiguous')),null);
 assert.equal(J.create([row('Nature',{year:null})]).lookup(item('Nature')).year,null);
});
test('catalog validation rejects unverified origins, invalid ISSNs and future years',()=>{
 for(const patch of [{sourceURL:'https://nature.com.evil.test/foo'},{sourceURL:'https://user@nature.com/foo'},{impactFactor:-1},{issns:['0028-0837']},{year:2200}])assert.equal(J.valid(row('Nature',patch)),false);
});
test('portfolio table selects the exact journal and JIF column, excluding five-year values',()=>{
 const html='<h2>2025 Journal Metrics</h2><table><tr><th>Journal</th><th>Journal Impact Factor</th><th>5-year Journal Impact Factor</th></tr><tr><td>Nature Cancer</td><td>30</td><td>40</td></tr><tr><td>Nature</td><td>56.1</td><td>60</td></tr></table>';
 assert.deepEqual(J.parsePage(html,row('Nature'),DOMParser),{impactFactor:56.1,year:2025});
 assert.equal(J.parsePage(html,row('Science'),DOMParser),null);
});
test('single-journal refresh requires matching identity and dated two-year metric',()=>{
 assert.deepEqual(J.parsePage('<title>Journal Metrics | Nature</title><p>Journal Impact Factor: 56.1 (2025)</p><p>5-year Journal Impact Factor: 99 (2025)</p>',row('Nature'),DOMParser),{impactFactor:56.1,year:2025});
 for(const html of ['<title>Nature Cancer</title><p>Journal Impact Factor: 30 (2025)</p>','<title>Nature</title><p>5-year Journal Impact Factor: 99 (2025)</p>','<title>Nature</title><p>CiteScore: 100 (2025)</p>','<title>Nature</title><p>Journal Impact Factor: 50 (2024)</p>'])assert.equal(J.parsePage(html,row('Nature'),DOMParser),null);
});

test('official CSV uses impact_factor and if_year rather than adjacent five-year or CiteScore values',()=>{
 const record=row('Cell',{year:2024,sourceURL:'https://www.cell.com/metrics.csv'});
 const csv='journal_title,impact_factor,5_year_impact_factor,citescore,if_year\r\n"Cell",42.5,50,70,2024\r\nMolecular Cell,16.6,22,33,2024';
 assert.deepEqual(J.parsePage(csv,record,DOMParser),{impactFactor:42.5,year:2024});
 assert.equal(J.parsePage(csv.replace('impact_factor,','other,'),record,DOMParser),null);
 assert.equal(J.parsePage(csv+'\nCell,45,50,70,2025',record,DOMParser),null);
});

test("a renamed journal is found under the title the JCR lists now", () => {
  const j = J.create(JSON.parse(fs.readFileSync(new URL("../data/if-jcr-2025.json", import.meta.url), "utf8")));
  const item = f => ({getField: k => f[k] || ""});
  assert.equal(j.lookup(item({publicationTitle: "Biotechnology for Biofuels"})).title, "Biotechnology for Biofuels and Bioproducts");
  assert.equal(j.lookup(item({publicationTitle: "European Journal of Biochemistry"})).title, "FEBS Journal");
  assert.equal(j.lookup(item({publicationTitle: "Angewandte Chemie"})).impactFactor, 17.6);
  assert.equal(j.lookup(item({publicationTitle: "Science of The Total Environment"})), null, "not in the 2026 release, so no figure");
});
