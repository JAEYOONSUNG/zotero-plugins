import fs from 'node:fs';
import Journals from '../src/journals.js';
const files=process.argv.slice(2);
if(!files.length)throw new Error('Pass catalog file paths');
let count=0;
for(const file of files){const records=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(records)||!records.length)throw new Error('Empty catalog '+file);for(const row of records){if(!Journals.valid(row)||typeof row.evidence!=='string'||!row.evidence.trim())throw new Error('Invalid evidence '+file+' '+row.title);count++;}Journals.create(records);}
console.log('Catalog verified: '+count+' records');
