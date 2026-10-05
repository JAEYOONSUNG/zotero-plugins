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

/* The rename table lives in src/journals.js, so this needs a catalog carrying
   the current titles and nothing more. It used to read the Journal Citation
   Reports export, which is licensed to whoever subscribes to it and is no
   longer in this repository. Every value below is invented; only the titles,
   which are the module's own table, and the shape are real. */
test("a renamed journal is found under the title the catalog lists now", () => {
  const record = (title, impactFactor) => ({title, aliases: [], issns: [], impactFactor, year: 2025,
    sourceURL: "https://www.nature.com/invented-for-this-test", checkedAt: "2026-01-02",
    evidence: "Invented figure for the rename test."});
  const j = J.create([
    record("Biotechnology for Biofuels and Bioproducts", 4.2),
    record("FEBS Journal", 3.3),
    record("Angewandte Chemie International Edition", 17.6),
    record("Microbiology Sgm", 1.1)
  ]);
  const item = f => ({getField: k => f[k] || ""});
  assert.equal(j.lookup(item({publicationTitle: "Biotechnology for Biofuels"})).title, "Biotechnology for Biofuels and Bioproducts");
  assert.equal(j.lookup(item({publicationTitle: "European Journal of Biochemistry"})).title, "FEBS Journal");
  assert.equal(j.lookup(item({publicationTitle: "Journal of General Microbiology"})).title, "Microbiology Sgm");
  assert.equal(j.lookup(item({publicationTitle: "Angewandte Chemie"})).impactFactor, 17.6);
  assert.equal(j.lookup(item({publicationTitle: "Science of The Total Environment"})), null, "not in this catalog, so no figure");
});

// Fact-check 2026-10-05: a 1976 Journal of General Microbiology paper showed Microbiology's 4.3, Genome
// Announcements 2018 showed MRA's 0.6, Current Protocols in Molecular Biology showed "Current Protocols".
const dated=(title,date,ISSN='')=>({getField:k=>({publicationTitle:title,date,ISSN}[k]||'')});
test('a successor journal is named, and an IF is left blank for a paper older than the rename',()=>{
 const r=J.create([row('Microbiology-SGM',{issns:['1350-0872']}),row('Microbiology Resource Announcements',{impactFactor:0.6}),row('Current Protocols'),row('FEBS Journal')]);
 // Before the rename: no figure at all, and the reason is available.
 const old=r.lookupDetail(dated('Journal of General Microbiology','1976-05-01'));
 assert.equal(old.record,null);assert.equal(old.predates,true);assert.equal(old.successor.to,'Microbiology-SGM');
 assert.equal(r.lookup(dated('Journal of General Microbiology','1976')),null);
 // After it: the figure stays, marked as the successor's.
 const recent=r.lookupDetail(dated('Journal of General Microbiology','1998'));
 assert.equal(recent.record.title,'Microbiology-SGM');assert.equal(recent.successor.to,'Microbiology-SGM');assert.equal(recent.predates,false);
 // Genome Announcements became Microbiology Resource Announcements in 2018: a 2017 paper predates it, a 2018 one does not.
 assert.equal(r.lookupDetail(dated('Genome Announcements','2017-03-01')).record,null);
 assert.equal(r.lookupDetail(dated('Genome Announcements','2018-09-01')).record.title,'Microbiology Resource Announcements');
 assert.equal(r.lookupDetail(dated('Current Protocols in Molecular Biology','2015')).predates,true);
 assert.equal(r.lookupDetail(dated('European Journal of Biochemistry','2010')).record.title,'FEBS Journal');
 // Unknown paper year: the figure is shown, still marked, never blanked on a guess.
 const undated=r.lookupDetail(dated('Genome Announcements',''));
 assert.equal(undated.record.title,'Microbiology Resource Announcements');assert.equal(undated.successor.to,'Microbiology Resource Announcements');
 // The same journal under its own name carries no mark.
 const same=r.lookupDetail(dated('Microbiology-SGM','1976'));
 assert.equal(same.successor,null);assert.equal(same.record.title,'Microbiology-SGM');
 assert.equal(r.lookupDetail(dated('The FEBS Journal','2020')).successor,null);
});
test('an ISSN match under a different name with nothing in common is flagged as a successor; an abbreviation is not',()=>{
 const r=J.create([row('Microbiology',{issns:['0022-1287']}),row('Nature Communications',{issns:['2041-1723']})]);
 const odd=r.lookupDetail(dated('Journal of Something Else Entirely','2001','0022-1287'));
 assert.equal(odd.record.title,'Microbiology');assert.equal(odd.successor.to,'Microbiology');
 const abbr=r.lookupDetail(dated('Nat Commun','2020','2041-1723'));
 assert.equal(abbr.record.title,'Nature Communications');assert.equal(abbr.successor,null);
});
