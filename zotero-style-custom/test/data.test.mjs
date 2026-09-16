import test from 'node:test';
import assert from 'node:assert/strict';
import data from '../src/data.js';
const item = (extra = '', tags = []) => ({getField: key => key === 'extra' ? extra : key === 'publicationTitle' ? 'Nature' : '', getTags: () => tags});
test('done survives accumulated reading and conflicting legacy tags', () => {
  assert.equal(data.readState(['/unread', '/done', '/reading'], '', 50).status, 'done');
  assert.equal(data.readState(['/unread'], '', 1).status, 'reading');
  assert.equal(data.readState([], '', 0).status, 'unread');
  assert.equal(data.readState(['/reading'], '', 0).status, 'reading');
});
test('star tags and legacy rating are bounded', () => {
  assert.equal(data.readState([{tag:'⭐⭐⭐'}], 'Rating: 5', 0).rating, 3);
  assert.equal(data.readState([], 'Rating: ★★★★', 0).rating, 4);
  for (const bad of ['-1', '6', 'Infinity', '3junk', '']) assert.equal(data.readState([], 'Rating: ' + bad).rating, 0);
});
test('updates preserve unrelated tag objects, data, status, and input', () => {
  const tags = [{tag:'/done',type:0}, {tag:'science',type:1, color:'red'}, {tag:'★★',type:0}];
  const before = JSON.stringify(tags);
  const changed = data.updateTags(tags, {rating:4});
  assert.deepEqual(changed, [tags[0], tags[1], {tag:'style-custom:rating:4',type:0}, {tag:'★★★★',type:0}]);
  assert.equal(JSON.stringify(tags), before);
  assert.deepEqual(data.updateTags(['/reading', 'topic'], {status:'done'}), ['topic','/done']);
  assert.deepEqual(data.updateTags(tags, {rating:0}), [...tags.slice(0,2),{tag:'style-custom:rating:0',type:0}]);
  assert.throws(() => data.updateTags(tags, {status:'garbage'}), RangeError);
});
test('unknown metadata stays unknown and cache failures are isolated', () => {
  const result = data.readMetrics(item(), {storage:{get(){throw Error('not loaded');}}});
  assert.deepEqual(result, {seconds:0,citations:null,citationSource:null,impactFactor:null,impactSource:null,rating:0});
});
test('Extra values have provenance and valid zero is retained', () => {
  const result = data.readMetrics(item('Citations: 2,112\nImpact Factor: 47.3\nRating: 4'));
  assert.equal(result.citations, 2112); assert.equal(result.impactFactor, 47.3);
  assert.match(result.citationSource, /^Extra:/); assert.match(result.impactSource, /^Extra:/);
  const zero = data.readMetrics(item('Citations: 0\nIF: 0'));
  assert.equal(zero.citations, 0); assert.equal(zero.impactFactor, 0);
});
test('malformed numbers, absent IF and other journal metrics are never guessed', () => {
  const result = data.readMetrics(item('Citations: 2.5\nIF: N/A'), {rankStorage:{get:()=>({sciif5:99,citescore:75})}});
  assert.equal(result.citations, null); assert.equal(result.impactFactor, null);
});
test('legacy per-page seconds and rank cache read without mutation', () => {
  const record = {page:3,data:{0:12,1:'8.5',2:-1,bad:'unknown',nil:null}};
  const before = JSON.stringify(record);
  const result = data.readMetrics(item(), {storage:{get:(i,key)=>{assert.equal(key,'readingTime');return record;}},rankStorage:{get:(i,key)=>{assert.equal(i.key,'Nature');assert.equal(key,'rank');return {sciif:'47.3'};}}});
  assert.equal(result.seconds,20.5); assert.equal(result.impactFactor,47.3);
  assert.equal(result.impactSource,'Style journal cache: sciif'); assert.equal(JSON.stringify(record),before);
});
test('malformed and asynchronous caches do not leak into metrics', async () => {
  for (const value of [null, '', {data:[]}, {data:{bad:Infinity}}, Promise.resolve({data:{0:55}})]) {
    assert.equal(data.readMetrics(item(), {storage:{get:()=>value}}).seconds,0);
  }
});

test('explicit clearing overrides legacy Extra without modifying Extra', () => {
  const tags = data.updateTags([{tag:'★★★',type:0}], {rating:0});
  assert.equal(data.readState(tags, 'Rating: 5').rating, 0);
  assert.equal(data.readState(data.updateTags(tags,{rating:2}), 'Rating: 5').rating, 2);
});

test('annotated numeric Extra preserves attribution without accepting arbitrary suffix', () => {
  const result = data.readMetrics(item('Citations: 2446 (OpenAlex, 2026-09-11)'));
  assert.equal(result.citations,2446);
  assert.equal(result.citationSource,'Extra: citations (OpenAlex, 2026-09-11)');
  for (const value of ['2446 OpenAlex', '2446 (OpenAlex) junk', '2446 (()', '-1 (OpenAlex)', '2.5 (OpenAlex)']) {
    assert.equal(data.readMetrics(item('Citations: '+value)).citations,null);
  }
});


test('legacy Total(DOI) recovers actual stored integer and string variants', () => {
  for (const [value, expected] of [[2112,2112],['105',105],['1753',1753],['2,825',2825],[' 391 ',391],[0,0],['0',0]]) {
    assert.deepEqual(data.readLegacyCitations({'Total(DOI)':value}), {citations:expected,citationSource:'Style cache: Total(DOI)'});
  }
});
test('legacy citation subsets and unfamiliar sources are never summed or selected', () => {
  const record = {'Total(DOI)':'105','Highly Influential':6,Background:23,Methods:4,Results:1,OpenAlex:200,provider:'invented',date:'2026-09-13'};
  const before = JSON.stringify(record);
  assert.deepEqual(data.readLegacyCitations(record),{citations:105,citationSource:'Style cache: Total(DOI)'});
  assert.equal(JSON.stringify(record),before);
  for (const value of [{'Highly Influential':6,Background:23,Methods:4,Results:1},{OpenAlex:200},{total:25}]) {
    assert.deepEqual(data.readLegacyCitations(value),{citations:null,citationSource:null});
  }
});
test('legacy missing and malformed counts stay unknown including unsafe integers', () => {
  for (const value of ['',null,undefined,0,'105',[],{'Total(DOI)':''},{'Total(DOI)':null},{'Total(DOI)':false},{'Total(DOI)':'2.5'},{'Total(DOI)':-1},{'Total(DOI)':'1,23'},{'Total(DOI)':'12 citations'},{'Total(DOI)':'1e3'},{'Total(DOI)':Infinity},{'Total(DOI)':'9007199254740993'},Object.create({'Total(DOI)':12})]) {
    assert.deepEqual(data.readLegacyCitations(value),{citations:null,citationSource:null});
  }
});
