import test from 'node:test';
import assert from 'node:assert/strict';
import RA from '../src/read-aloud.js';

/* An engine that does what speechSynthesis does: utterances wait in a queue and
   the test says when each starts and ends, so the order of events is exact. */
function fakeEngine({pause=true}={}){
 const queue=[],log=[];let current=null;
 const e={name:'fake',supportsPause:pause,log,queue,
  speak(u){queue.push(u);log.push(['speak',u.text,u.rate,u.voiceURI]);},
  cancel(){queue.length=0;current=null;log.push(['cancel']);},
  pause(){log.push(['pause']);},resume(){log.push(['resume']);},
  voices:()=>[],
  begin(){current=queue.shift();if(current)current.onstart();return current;},
  finish(){const u=current;current=null;if(u)u.onend();return u;},
  step(){e.begin();return e.finish();}};
 return e;
}
const unit=(text,page,sectionIndex,extra={})=>({text,page,rects:[[10,10,100,20]],sectionIndex,sentenceIndex:0,kind:'body',sectionLabel:'S'+sectionIndex,...extra});
const body=()=>[unit('One.',1,0),unit('Two.',1,0),unit('Three.',2,1),unit('Four.',2,1),unit('Five.',3,2)];
function player(opts={}){
 const engine=opts.engine||fakeEngine(),events=[],credits=[];let clock=0;
 const p=RA.create({engine,now:()=>clock,onChange:e=>events.push(e.type+':'+e.state.index),onCredit:(u,s)=>credits.push([u.text,s]),watchdogMs:0,...opts.create});
 p.load(opts.units||body(),opts.load);
 return {p,engine,events,credits,tick:ms=>{clock+=ms;}};
}

test('sentences split at ends, not at abbreviations, initials or decimals; Korean sentences too',()=>{
 assert.deepEqual(RA.splitSentences('We grew E. coli in LB, e.g. at 37 degrees. Fig. 2 shows 3.5-fold growth. J. Smith agreed. 결과는 유의했다. 다음 실험을 했다!'),
  ['We grew E. coli in LB, e.g. at 37 degrees.','Fig. 2 shows 3.5-fold growth.','J. Smith agreed.','결과는 유의했다.','다음 실험을 했다!']);
});

test('a sentence over the engine limit is cut at clause commas for the engine and never mid-word',()=>{
 const long='alpha beta gamma delta, '.repeat(24)+'omega.';
 const chunks=RA.splitForEngine(long);
 assert.ok(chunks.length>=2);assert.ok(chunks.every(c=>c.length<=RA.CHUNK_MAX));
 assert.equal(chunks.join(' ').replace(/\s+/g,' '),long.replace(/\s+/g,' ').trim());
 const noCommas='word '.repeat(120).trim();
 assert.ok(RA.splitForEngine(noCommas).every(c=>c.length<=RA.CHUNK_MAX&&!/^\S*$/.test(c)||c.length<=RA.CHUNK_MAX));
 assert.deepEqual(RA.splitForEngine('Short one.'),['Short one.']);
});

test('the language of the text and the voice that fits it',()=>{
 assert.equal(RA.detectLanguage('이 논문은 합성생물학의 방법을 다룬다.'),'ko');
 assert.equal(RA.detectLanguage('We report a thermostable polymerase.'),'en');
 const voices=[{voiceURI:'a',name:'Albert',lang:'en-US',localService:true},{voiceURI:'b',name:'Samantha',lang:'en-US',localService:true,default:true},{voiceURI:'c',name:'Yuna',lang:'ko-KR',localService:true}];
 assert.equal(RA.pickVoice(voices,'en').voiceURI,'b','novelty voices lose');
 assert.equal(RA.pickVoice(voices,'ko').voiceURI,'c');
 assert.equal(RA.pickVoice(voices,'en','a').voiceURI,'a','a saved voice that still exists wins');
 assert.equal(RA.pickVoice(voices,'en','gone').voiceURI,'b');
 assert.equal(RA.pickVoice(voices,'fr'),null);
});

test('play speaks one sentence, queues the next as soon as it starts, and reports each sentence as it begins',()=>{
 const {p,engine,events}=player();
 p.play();
 assert.deepEqual(engine.log.filter(l=>l[0]==='speak').map(l=>l[1]),['One.']);
 engine.begin();
 assert.deepEqual(engine.log.filter(l=>l[0]==='speak').map(l=>l[1]),['One.','Two.'],'the next sentence is queued before the current ends: no gap');
 assert.equal(p.state().index,0);
 engine.finish();engine.begin();
 assert.equal(p.state().index,1);
 assert.ok(events.includes('sentence:1'));
});

test('reaching the end says done and a later play starts again from the top',()=>{
 const {p,engine}=player({units:[unit('A.',1,0),unit('B.',1,0)]});
 p.play();engine.step();engine.step();
 assert.equal(p.state().status,'done');
 p.play();assert.equal(p.state().index,0);assert.equal(p.state().status,'playing');
});

test('pause and resume use the engine when it can pause, and the same sentence goes on',()=>{
 const {p,engine}=player();
 p.play();engine.begin();p.pause();
 assert.equal(p.state().status,'paused');assert.ok(engine.log.some(l=>l[0]==='pause'));
 p.resume();assert.equal(p.state().status,'playing');assert.ok(engine.log.some(l=>l[0]==='resume'));
 assert.equal(p.state().index,0);
});

test('an engine that cannot pause is stopped on pause and speaks the current sentence again on resume',()=>{
 const engine=fakeEngine({pause:false});const {p}=player({engine});
 p.play();engine.step();engine.begin();       // now on sentence 1 ("Two.")
 assert.equal(p.state().index,1);
 p.pause();
 assert.ok(engine.log.at(-1)[0]==='cancel');assert.equal(p.state().status,'paused');
 p.resume();
 const spoken=engine.log.filter(l=>l[0]==='speak').at(-1);
 assert.equal(spoken[1],'Two.','resumes from the start of the current sentence, not the next one');
 assert.equal(p.state().status,'playing');
});

test('next, previous and the section jumps move instantly and keep playing',()=>{
 const {p,engine}=player();
 p.play();engine.begin();
 p.next();assert.equal(p.state().index,1);
 assert.equal(engine.log.filter(l=>l[0]==='speak').at(-1)[1],'Two.');
 p.nextSection();assert.equal(p.state().index,2,'first sentence of the next section');
 p.next();p.nextSection();assert.equal(p.state().index,4);
 p.nextSection();assert.equal(p.state().index,4,'the last section stays put');
 p.prevSection();assert.equal(p.state().index,2,'already at the section start: goes to the previous one');
});

test('previous section goes to the start of the current section first, then the one before',()=>{
 const {p}=player();
 p.seek(3);assert.equal(p.state().index,3);
 p.prevSection();assert.equal(p.state().index,2);
 p.prevSection();assert.equal(p.state().index,0);
 p.prevSection();assert.equal(p.state().index,0);
 p.prev();assert.equal(p.state().index,0);
});

test('seeking while paused moves the position and resume speaks from there',()=>{
 const {p,engine}=player();
 p.play();engine.begin();p.pause();
 p.seek(3);assert.equal(p.state().index,3);assert.equal(p.state().status,'paused');
 p.resume();assert.equal(engine.log.filter(l=>l[0]==='speak').at(-1)[1],'Four.');
});

test('changing the rate restarts the current sentence at the new rate, within 0.8 to 1.8',()=>{
 const {p,engine}=player();
 p.play();engine.begin();
 assert.equal(p.setRate(1.5),1.5);
 const last=engine.log.filter(l=>l[0]==='speak').at(-1);
 assert.deepEqual([last[1],last[2]],['One.',1.5]);
 assert.equal(p.setRate(5),1.8);assert.equal(p.setRate(0.1),0.8);
});

test('a different voice applies from the current sentence',()=>{
 const {p,engine}=player();
 p.play();engine.begin();p.setVoice('Yuna','ko-KR');
 assert.equal(engine.log.filter(l=>l[0]==='speak').at(-1)[3],'Yuna');
});

test('captions and references are left out unless switched on, and the position is kept across the switch',()=>{
 const PT={readingOrder:s=>s.order,};
 const structured={sections:[{heading:'Intro'},{heading:'Methods'},{heading:'References',kind:'back'}],
  order:[unit('Body one.',1,0),unit('Body two.',2,1),unit('Ref text.',3,2)],
  captions:[{text:'Figure 1. A plot.',page:1,rects:[[1,1,2,2]]}],references:[{text:'Smith J. 2020. A paper.',page:3,rects:[]}]};
 let units=RA.composeUnits(structured,{},PT);
 assert.deepEqual(units.map(u=>u.text),['Body one.','Body two.'],'back matter is dropped from the body');
 units=RA.composeUnits(structured,{captions:true},PT);
 assert.deepEqual(units.map(u=>u.text),['Body one.','Figure 1.','A plot.','Body two.'],'a caption follows the last sentence on its page, read sentence by sentence');
 units=RA.composeUnits(structured,{captions:true,references:true},PT);
 assert.equal(units.at(-1).kind,'reference');
 assert.ok(units.some(u=>u.kind==='caption'));
 const {p}=player({units:RA.composeUnits(structured,{captions:true},PT)});
 p.seek(3);assert.equal(p.state().unit.text,'Body two.');
 p.setFilters({captions:false});assert.equal(p.state().unit.text,'Body two.','still on the same sentence after the captions went away');
 assert.equal(p.state().total,2);
 p.setFilters({captions:true});assert.equal(p.state().unit.text,'Body two.');assert.equal(p.state().total,4);
});

test('the last position is remembered by the sentence and offered again, even if the list changed a little',()=>{
 const first=player();first.p.seek(3);
 const saved=first.p.position();
 assert.equal(saved.index,3);
 const second=player({load:{resume:saved}});
 assert.equal(second.p.state().index,3);
 const shifted=[unit('New opening.',1,0),...body()];
 const third=player({units:shifted,load:{resume:saved}});
 assert.equal(third.p.state().unit.text,'Four.','found by its text and page, not by a stale number');
 const outOfRange=player({load:{resume:{index:99,sig:'nothing'}}});
 assert.equal(outOfRange.p.state().index,0);
});

test('listening counts as reading: each finished sentence credits its spoken seconds, pauses excluded, capped',()=>{
 const t=player();
 t.p.play();t.engine.begin();t.tick(2000);
 t.p.pause();t.tick(50000);t.p.resume();t.tick(1000);
 t.engine.finish();
 assert.deepEqual(t.credits,[['One.',3]],'3 seconds spoken, the 50 second pause is not counted');
 t.engine.begin();t.tick(500000);t.engine.finish();
 assert.equal(t.credits[1][1],120,'a suspended machine cannot credit hours');
});

test('a sentence skipped over is not credited',()=>{
 const t=player();t.p.play();t.engine.begin();t.tick(4000);t.p.next();
 assert.deepEqual(t.credits,[]);
});

test('late events from a cancelled sentence cannot move the position',()=>{
 const {p,engine}=player();
 p.play();const stale=engine.begin();p.seek(3);
 stale.onend();stale.onstart();
 assert.equal(p.state().index,3);
});

test('an engine error stops with the reason; a silent engine trips the watchdog',()=>{
 const engine=fakeEngine();const a=player({engine});
 a.p.play();engine.queue[0].onerror('synthesis-failed');
 assert.equal(a.p.state().status,'error');assert.equal(a.p.state().error,'synthesis-failed');
 const timers=[];const silent=fakeEngine();
 const b=player({engine:silent,create:{watchdogMs:5000,timers:{set:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clear:()=>{}}}});
 b.p.play();assert.equal(timers.at(-1).ms,5000);timers.at(-1).fn();
 assert.equal(b.p.state().status,'error');assert.equal(b.p.state().error,'no-audio');
});

test('a position on the page finds the nearest sentence on that page',()=>{
 const units=[unit('Top.',1,0,{rects:[[50,700,250,20]]}),unit('Middle.',1,0,{rects:[[50,400,250,20]]}),unit('Next page.',2,1,{rects:[[50,400,250,20]]})];
 const {p}=player({units});
 assert.equal(p.indexNear(1,100,405),1);assert.equal(p.indexNear(1,100,690),0);assert.equal(p.indexNear(2,0,0),2);
 assert.equal(p.indexNear(9,0,0),-1);
});

test('the say engine passes the text as one argument after --, kills on cancel, retries without a voice that is not installed',()=>{
 const spawned=[];
 const spawn=(args,onexit)=>{const proc={args,onexit,killed:false,kill(){proc.killed=true;}};spawned.push(proc);return proc;};
 const engine=RA.sayEngine({spawn});
 const events=[];
 engine.speak({text:'-rf; $(touch x) hello',lang:'ko-KR',voiceURI:'',rate:1,onstart:()=>events.push('start'),onend:()=>events.push('end'),onerror:e=>events.push('err:'+e)});
 assert.deepEqual(spawned[0].args,['-v','Yuna','-r','200','--','-rf; $(touch x) hello'],'one argv entry, no shell');
 spawned[0].onexit(1);                                  // Yuna is not installed
 assert.deepEqual(spawned[1].args.slice(0,3),['-r','200','--'],'second attempt uses the system voice');
 spawned[1].onexit(0);assert.deepEqual(events.filter(e=>e==='end'),['end']);
 engine.speak({text:'next',lang:'en',rate:1.2,onend:()=>events.push('end2')});
 engine.cancel();assert.equal(spawned.at(-1).killed,true);
 spawned.at(-1).onexit(0);assert.ok(!events.includes('end2'),'a killed sentence never reports that it finished');
 assert.equal(engine.supportsPause,false);
});

test('the plain-text fallback gives sections, sentences, a references list and 0-based page numbers when the pages are marked',()=>{
 const text='Title line\n\nAbstract\n\nWe study X. It works well.\f1. Introduction\n\nBackground text spans\nlines here. Second sentence.\n\nReferences\n\n1. Smith J. A paper. 2020.';
 const s=RA.fallbackPaperText.structure({text,meta:{title:'T'}});
 assert.ok(s.sections.some(x=>/Introduction/.test(x.heading)));
 assert.equal(s.references.length>0,true);
 const order=RA.fallbackPaperText.readingOrder(s);
 assert.ok(order.every(u=>u.text&&Number.isFinite(u.sectionIndex)));
 assert.ok(order.some(u=>u.page===1),'the second page is index 1, as in the extraction module');assert.equal(order[0].page,0);
 assert.match(s.abstract,/We study X/);
});

test('the player refuses to run without an engine and does nothing after destroy',()=>{
 assert.throws(()=>RA.create({}),/engine/);
 const {p,engine,events}=player();p.play();p.destroy();engine.begin();
 assert.equal(events.filter(e=>e.startsWith('sentence')).length,0);
});

/* ---- sharing the speech queue with Zotero's own Read Aloud ---------------- */
function fakeSynth(){
 const s={queue:[],speaking:false,pending:false,voices:[{voiceURI:'v',name:'V',lang:'en-US'}],
  getVoices(){return s.voices;},speak(u){s.queue.push(u);s.pending=true;},
  // what Gecko does on cancel(): every queued utterance gets an error event
  cancel(){const q=s.queue.splice(0);s.speaking=s.pending=false;for(const u of q)u.onerror&&u.onerror({error:'interrupted'});},
  pause(){},resume(){}};
 return s;
}
test('a cancel this engine did not make is reported as an interruption; its own cancel is not',()=>{
 const synth=fakeSynth();class Utt{constructor(t){this.text=t;}}
 const engine=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const seen=[];
 engine.speak({text:'A.',oninterrupt:r=>seen.push('foreign:'+r),onerror:e=>seen.push('error:'+e)});
 engine.cancel();
 assert.deepEqual(seen,[],'our own cancel is silent');
 engine.speak({text:'B.',oninterrupt:r=>seen.push('foreign:'+r),onerror:e=>seen.push('error:'+e)});
 synth.cancel();                                          // Zotero's Read Aloud starting
 assert.deepEqual(seen,['foreign:interrupted']);
});

test('the player becomes paused, not silently "playing", when another speaker cancels it, and resume speaks the sentence again',()=>{
 const synth=fakeSynth();class Utt{constructor(t){this.text=t;}}
 const engine=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const events=[];const p=RA.create({engine,watchdogMs:0,onChange:e=>events.push(e.type)});p.load(body());
 p.play();synth.queue[0].onstart();
 assert.equal(p.state().status,'playing');
 synth.cancel();
 assert.equal(p.state().status,'paused');assert.equal(p.state().error,'interrupted');assert.ok(events.includes('interrupted'));
 p.resume();assert.equal(p.state().status,'playing');assert.equal(synth.queue[0].text,'One.','the interrupted sentence again, from its start');
});

test('a queue that went quiet after speaking (someone cancelled without events) is a pause; no sound at all is still no-audio',()=>{
 const timers=[];const engine=fakeEngine();let busy=true;engine.busy=()=>busy;
 const {p}=player({engine,create:{watchdogMs:4000,timers:{set:(fn,ms)=>{timers.push(fn);return timers.length;},clear:()=>{}}}});
 p.play();engine.begin();
 busy=false;timers.at(-1)();
 assert.equal(p.state().status,'paused');assert.equal(p.state().error,'interrupted');
});

test('say: a long sentence is queued whole before the next one, and the start is reported after queueing',async()=>{
 const spawned=[];const spawn=(args,onexit)=>{const proc={args,onexit,kill(){}};spawned.push(proc);return proc;};
 const engine=RA.sayEngine({spawn});
 const long='alpha beta gamma delta, '.repeat(14)+'omega.';
 const {p}=player({engine,units:[unit(long,1,0),unit('Next.',1,0)]});
 p.play();await new Promise(r=>setImmediate(r));
 const texts=[spawned[0].args.at(-1)];
 for(let i=0;i<20&&spawned.length;i++){const last=spawned.at(-1);last.onexit(0);await new Promise(r=>setImmediate(r));if(spawned.at(-1)===last)break;texts.push(spawned.at(-1).args.at(-1));}
 const pieces=RA.splitForEngine(long);
 assert.deepEqual(texts.slice(0,pieces.length),pieces,'every piece of the long sentence, in order');
 assert.equal(texts[pieces.length],'Next.','then the next sentence');
});

test('the citation-free spoken text is what is said; the shown text keeps the citations',()=>{
 const engine=fakeEngine();
 const {p}=player({engine,units:[unit('Growth doubled [12, 13].',1,0,{spoken:'Growth doubled.'}),unit('Plain.',1,0)]});
 p.play();
 assert.equal(engine.log.find(l=>l[0]==='speak')[1],'Growth doubled.');
 assert.equal(p.state().unit.text,'Growth doubled [12, 13].');
 const structured={sections:[{heading:'R',paragraphs:[{sentences:[{text:'Seen [3].',spoken:'Seen.',page:0,rects:[]}]}]}]};
 const pt={readingOrder:s=>[{text:'Seen [3].',page:0,rects:[],sectionIndex:0,sentenceIndex:0,paragraphIndex:0}]};
 assert.equal(RA.composeUnits(structured,{},pt)[0].spoken,'Seen.','looked up in the paragraph when the reading order dropped it');
 assert.equal(RA.sayable({text:'Only [4].',spoken:'  '}),'Only [4].','an empty spoken text falls back to the text');
});

test('after destroy, play, seek and resume are refused and nothing is spoken',()=>{
 const {p,engine}=player();p.destroy();
 p.play(2);p.seek(1);p.resume();
 assert.equal(engine.log.filter(l=>l[0]==='speak').length,0);
 assert.equal(p.destroyed,true);
});

/* ---- 0.59.24: who owns the speech queue ----------------------------------- */
/* Gecko's cancel() ends the utterance being spoken with an `end` event (Zotero's own controller detaches onend
   before it cancels for that reason), and drops the rest of the queue. */
function geckoSynth(){
 const s={queue:[],cur:null,cancels:0,voices:[{voiceURI:'v',name:'V',lang:'en-US'}],
  get speaking(){return !!s.cur;},get pending(){return s.queue.length>0;},
  getVoices(){return s.voices;},speak(u){s.queue.push(u);},
  begin(){s.cur=s.queue.shift();s.cur&&s.cur.onstart&&s.cur.onstart();return s.cur;},
  finish(){const u=s.cur;s.cur=null;u&&u.onend&&u.onend();},
  cancel(){s.cancels++;const u=s.cur;s.cur=null;s.queue.length=0;u&&u.onend&&u.onend();},
  pause(){},resume(){}};
 return s;
}
test('an external cancel that arrives as `end` is a lost queue: the player pauses and queues nothing more',()=>{
 const synth=geckoSynth();class Utt{constructor(t){this.text=t;}}
 const engine=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const events=[];const p=RA.create({engine,watchdogMs:0,onChange:e=>events.push(e.type)});p.load(body());
 p.play();synth.begin();
 assert.equal(p.state().index,0);assert.equal(synth.queue.length,1,'the next sentence is queued ahead');
 synth.cancel();                                          // Zotero's Read Aloud starting: our sentence ends with `end`
 assert.equal(p.state().status,'paused','not played on as if the sentence had ended');
 assert.equal(p.state().index,0,'still on the sentence that was cut off');
 assert.equal(synth.queue.length,0,'nothing queued after the loss');
 assert.ok(events.includes('interrupted'));
});
test('a natural end with the next sentence waiting is still a normal advance',()=>{
 const synth=geckoSynth();class Utt{constructor(t){this.text=t;}}
 const engine=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const p=RA.create({engine,watchdogMs:0});p.load(body());
 p.play();synth.begin();synth.finish();
 assert.equal(p.state().status,'playing');assert.equal(p.state().index,1);
});
test('destroy cancels the queue only while this engine owns the utterance, and detaches its end handler first',()=>{
 const synth=geckoSynth();class Utt{constructor(t){this.text=t;}}
 const a=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const p=RA.create({engine:a,watchdogMs:0});p.load(body());
 p.play();synth.begin();synth.finish();synth.begin();
 const mine=synth.cur;
 p.destroy();
 assert.equal(synth.cancels,1,'our own utterance is cancelled');assert.equal(mine.onend,null,'its end handler was removed before the cancel');
 // Someone else speaks now; a second engine that owns nothing must not cancel it.
 const other={text:'Zotero reads.'};synth.speak(other);synth.begin();
 const b=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 const q=RA.create({engine:b,watchdogMs:0});q.load(body());q.destroy();
 assert.equal(synth.cancels,1,'no cancel from an engine that owns nothing');assert.equal(synth.cur,other);
 // A later speaker in another of our engines owns the queue: the earlier one does not cancel it.
 const c=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt}),d=RA.speechEngine({speechSynthesis:synth,SpeechSynthesisUtterance:Utt});
 c.speak({text:'C.'});d.speak({text:'D.'});
 c.cancel();assert.equal(synth.cancels,1,'d spoke last: c leaves the queue alone');
 d.cancel();assert.equal(synth.cancels,2);
});
test('the plain-text headings recognise Korean section names',()=>{
 const s=RA.plainTextStructure('서론\n\n첫 문단입니다. 둘째 문장입니다.\n\n방법\n\n방법 문단입니다.\n\n결과\n\n결과 문단입니다.');
 assert.deepEqual(s.sections.map(x=>x.heading),['서론','방법','결과']);
});

/* ---- what the listener hears (round 3) ------------------------------------------------------------------
   Every case below is a sentence taken from the 17 real-paper fixtures (or the exact form it has there). */
test('symbols, units and signs are spoken as words, not read as glyphs or dropped',()=>{
 const S=t=>RA.speechText(t,'en');
 assert.equal(S('stored at 4°C until use, then 72 ◦C, 4ºC and −20 °C.'),'stored at 4 degrees Celsius until use, then 72 degrees Celsius, 4 degrees Celsius and minus 20 degrees Celsius.');
 assert.equal(S('collecting additional data at a −30° tilt.'),'collecting additional data at a minus 30 degrees tilt.');
 assert.equal(S('Kinetic parameters for riboflavin (0–250 μM) and NADH (10 µM).'),'Kinetic parameters for riboflavin (0 to 250 micromolar) and NADH (10 micromolar).');
 assert.equal(S('with 1 mM IPTG and 200 μg/mL X-gal; 190 μl were dispensed; 1 μg/ml lysozyme.'),'with 1 millimolar IPTG and 200 micrograms per milliliter X-gal; 190 microliters were dispensed; 1 microgram per milliliter lysozyme.');
 assert.equal(S('selection for the helper plasmid (+5, 5 μg ml⁻¹ tetracycline)'),'selection for the helper plasmid (plus 5, 5 micrograms per milliliter tetracycline)');
 assert.equal(S('restrained (20 kcal·mol⁻¹·Å⁻²) at 2.8 Å over ~4000 Å².'),'restrained (20 kilocalories per mole per square angstrom) at 2.8 angstroms over about 4000 square angstroms.');
 assert.equal(S('were 68 ± 3.3 and 44.3 ± 2.2 U/mg'),'were 68 plus or minus 3.3 and 44.3 plus or minus 2.2 units per milligram');
 assert.equal(S('centrifuged at 11,000 × g for 1h, then 48 h and 10 min, vortexed for 5 s.'),'centrifuged at 11,000 times g for 1 hour, then 48 hours and 10 minutes, vortexed for 5 seconds.');
 assert.equal(S('approximately 1x10⁸ CFU/ml; adjusted P value <1 × 10⁻⁵; more than 10⁴ SNPs; 2 × 10^5 cells'),'approximately 1 times 10 to the 8 CFU per milliliter; adjusted P value less than 1 times 10 to the minus 5; more than 10 to the 4 SNPs; 2 times 10 to the 5 cells');
 assert.equal(S('* = p < 0.05; q value < 0.05; P = 0.002; a defense score of >0.3 and size >=10 and score ≥ 0.4, q ≤ 0.05'),'p less than 0.05; q value less than 0.05; P = 0.002; a defense score of more than 0.3 and size greater than or equal to 10 and score greater than or equal to 0.4, q less than or equal to 0.05');
 assert.equal(S('(monomer Mr ~27 kDa) for ∼4 h at an OD600 of ∼0.3, detected by 10∼15 probes (≈ 27 kDa)'),'(monomer Mr about 27 kilodaltons) for about 4 hours at an OD600 of about 0.3, detected by 10 to 15 probes (about 27 kilodaltons)');
 assert.equal(S('the CTD exhibits a β-α-β-β-β topology; helix α6; strain DH5α; ΔpyrF and λ-red; a ∆G of 2 kcal'),'the CTD exhibits a beta-alpha-beta-beta-beta topology; helix alpha 6; strain DH5 alpha; delta pyrF and lambda-red; a delta G of 2 kilocalories');
});
test('ions, primes, citations set as superscripts and the glyph quirks of real PDFs',()=>{
 const S=t=>RA.speechText(t,'en');
 assert.equal(S('depletes cellular NAD⁺ and Mg²⁺ but not Cl⁻.'),'depletes cellular NAD plus and Mg 2 plus but not Cl minus.');
 assert.equal(S('the 5′-UTR, the 3′ -end mRNA and Arg200′ of the other subunit'),'the 5 prime UTR, the 3 prime end mRNA and Arg200 prime of the other subunit');
 assert.equal(S('both of which have 5’-GAGCC-3’ sites; 25 bp 3’ to the site; the 5⁰-AGACT-3⁰ was modified'),'both of which have 5 prime GAGCC 3 prime sites; 25 base pairs 3 prime to the site; the 5 prime AGACT 3 prime was modified');
 assert.equal(S('misincorporation of 8-hydroxy-2=-deoxyguanosine and 2=,7=-dichlorodihydrofluorescein; n=3'),'misincorporation of 8-hydroxy-2 prime deoxyguanosine and 2 prime, 7 prime dichlorodihydrofluorescein; n=3');
 assert.equal(S('transitions (i.e., A ¡ G and C ¡ T)'),'transitions (that is, A to G and C to T)');
 assert.equal(S('performed using WARP v1.09⁵¹, then cryoSPARC v3.2⁵² and Sniffles2⁵⁰; T3 is susceptible to restriction ³.'),'performed using WARP v1.09, then cryoSPARC v3.2 and Sniffles2; T3 is susceptible to restriction.');
 assert.equal(S('labeled with ′ Alexa ′ Fluor 514'),'labeled with Alexa Fluor 514');
 assert.equal(S('using dual-indexing sequencing primers, a prime-boost and primed cells.'),'using dual-indexing sequencing primers, a prime-boost and primed cells.','the word prime is left alone');
 assert.equal(S('EM·DNT and msf·GFP; Sigma−Aldrich and qRT−PCR'),'EM DNT and msf GFP; Sigma-Aldrich and qRT-PCR');
});
test('ranges, dashes, abbreviations, figure references and links',()=>{
 const S=t=>RA.speechText(t,'en');
 assert.equal(S('residues 88–123 and cycles 2–4; RMF–HPF–100S dimers; SDS– PAGE; host and—at least in some cases—DNA damage'),'residues 88 to 123 and cycles 2 to 4; RMF-HPF-100S dimers; SDS-PAGE; host and, at least in some cases, DNA damage');
 assert.equal(S('Some systems (e.g. type III), as shown (Fig. 2A; Figs. 3–5; Eq. 3) by Mural et al. vs. wild type, cf. Ref. 4'),'Some systems (for example type III), as shown (Figure 2A; Figures 3 to 5; Equation 3) by Mural et al versus wild type, compare Reference 4');
 assert.equal(S('We sequenced ca. 100 clones from Burkholderia sp. R34 at pH8.0 (Supplementary Table S3).'),'We sequenced about 100 clones from Burkholderia species R34 at pH 8.0 (Supplementary Table S3).');
 assert.equal(S('designed (GC%: 50, https://faculty.ucr.edu/~mmaduro/ random.htm), see doi:10.1038/s41586-020-1234-5 or www.example.org.'),'designed (GC%: 50, a web link random.htm), see a DOI or a web link.');
 assert.equal(S('taking into consideration that (i) degradation results in ROS and (ii) damage, and (iii) more'),'taking into consideration that (1) degradation results in ROS and (2) damage, and (3) more');
 assert.equal(S('A plain sentence stays exactly as it is.'),'A plain sentence stays exactly as it is.');
 // pnas: an en dash set as a minus; nar2025: "<∼10"; crampton: "20 l" whose µ the font lost is not "20 liters"
 assert.equal(S('defocus: –0.8 to –2.2 μm, ranges 10 – 20 and 10–20'),'defocus: minus 0.8 to minus 2.2 micrometers, ranges 10 to 20 and 10 to 20');
 assert.equal(S('the average pause lifetime was <∼10 s.'),'the average pause lifetime was less than about 10 seconds.');
 assert.equal(S('in a final volume of 20 l, or 2 L.'),'in a final volume of 20 l, or 2 liters.');
});
test('a Korean voice hears Korean words for the same symbols',()=>{
 const K=t=>RA.speechText(t,'ko');
 assert.equal(K('37 °C에서 50 μM, 68 ± 3.3, 10–20 분, ~5 h, p < 0.05, α-나선'),'37도에서 50 마이크로몰, 68 플러스 마이너스 3.3, 10에서 20 분, 약 5 시간, p 0.05 미만, 알파-나선');
 assert.equal(K('100 μg/mL 암피실린, NAD⁺, 10⁻³, 예: Fig. 2'),'100 마이크로그램 퍼 밀리리터 암피실린, NAD 플러스, 10의 마이너스 3승, 예: 그림 2');
});
test('a unit used as an adjective stays singular; a bracketed name is not a comparison',()=>{
 const S=t=>RA.speechText(t,'en');
 assert.equal(S('loaded onto a 5 ml Ni-NTA cartridge in 5 ml buffer'),'loaded onto a 5 milliliter Ni-NTA cartridge in 5 milliliters buffer');
 assert.equal(S('the ratio (<3′ -end mRNA>/<5′ -end mRNA>) at P<0.05 and q>0.1'),'the ratio (3 prime end mRNA/5 prime end mRNA) at P less than 0.05 and q greater than 0.1');
 assert.equal(S('targeting substrates with a 5’ovh, as in Blow et al.,.'),'targeting substrates with a 5 prime ovh, as in Blow et al.');
});
test('pause, then next, then resume: the paused speech queue is resumed, so the new sentence is heard',()=>{
 const {p,engine}=player();
 p.play();engine.begin();p.pause();
 p.next();p.resume();
 const log=engine.log.map(l=>l[0]+(l[1]?':'+l[1]:''));
 const lastSpeak=log.lastIndexOf('speak:Two.');
 assert.ok(lastSpeak>0);
 assert.ok(log.slice(log.lastIndexOf('pause')).includes('resume'),'the engine left paused by pause() is resumed: '+log.join(' '));
 assert.ok(log.lastIndexOf('resume')<lastSpeak,'before the new sentence is queued');
 assert.equal(p.state().status,'playing');
 // a plain play after a seek while nothing was paused does not resume anything
 const b=player();b.p.seek(2);b.p.play();assert.ok(!b.engine.log.some(l=>l[0]==='resume'));
});
test('each section is announced by its heading once, empty parent headings included; units carry their paragraph',async()=>{
 const PT=(await import('../src/paper-text.js')).default;
 const s=(text,page=0)=>({text,spoken:text,page,rects:[]});
 const structured={sections:[
  {heading:'RESULTS',spoken:'Results',level:1,kind:'body',page:0,paragraphs:[]},
  {heading:'2.1. Data-driven culturomics',spoken:'2.1. Data-driven culturomics',level:2,kind:'body',page:0,paragraphs:[{sentences:[s('One.'),s('Two.')]},{sentences:[s('Three.')]}]},
  {heading:'Discussion',spoken:'Discussion',level:1,kind:'body',page:1,paragraphs:[{sentences:[s('Discussion of it follows.',1)]}]},
  {heading:'',level:1,kind:'body',page:1,paragraphs:[{sentences:[s('Unheaded.',1)]}]}]};
 const units=RA.composeUnits(structured,{},PT);
 assert.deepEqual(units.map(u=>u.lead||null),['Results. Data-driven culturomics',null,null,null,null]);
 assert.deepEqual(units.map(u=>u.paragraphIndex),[0,0,1,0,0]);
 assert.equal(units[3].lead,undefined,'a heading the first sentence already says is not said twice');
 const wiley=RA.composeUnits({sections:[{heading:'| Materials and methods',kind:'body',paragraphs:[{sentences:[s('Cells grew.')]}]}]},{},PT);
 assert.equal(wiley[0].lead,'Materials and methods','a layout bar before the heading (Wiley) is not said');
});
test('the player says the heading before a section, and pauses at paragraph and section ends',()=>{
 const timers=new Map();let id=0;
 const engine=fakeEngine();
 const u=(text,si,pi,extra={})=>({...unit(text,1,si,extra),paragraphIndex:pi});
 const units=[u('One.',1,0,{lead:'Results'}),u('Two.',1,0),u('Three.',1,1),u('Four.',2,0,{lead:'Discussion'})];
 const p=RA.create({engine,watchdogMs:0,pauses:{paragraph:500,section:900},timers:{set:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clear:k=>timers.delete(k)}});
 p.load(units);p.play();
 const said=()=>engine.log.filter(l=>l[0]==='speak').map(l=>l[1]);
 assert.deepEqual(said(),['Results.','One.'],'the heading goes first, as its own utterance');
 engine.step();assert.equal(p.state().index,0,'the heading belongs to the first sentence');
 engine.step();assert.deepEqual(said(),['Results.','One.','Two.'],'same paragraph: queued at once, no gap');
 engine.step();assert.deepEqual(said(),['Results.','One.','Two.'],'a new paragraph waits');
 const [k,t]=[...timers][0];assert.equal(t.ms,500);timers.delete(k);t.fn();
 assert.deepEqual(said().slice(-1),['Three.']);
 engine.step();const [k2,t2]=[...timers][0];assert.equal(t2.ms,900,'a longer pause before a new section');
 p.pause();assert.equal(timers.size,0,'pausing in the gap cancels it');assert.equal(p.state().index,3,'and moves on to the sentence that was due');
 p.resume();assert.deepEqual(said().slice(-2),['Discussion.','Four.']);
 p.setRate(1.5);engine.begin();engine.finish();engine.step();assert.equal(p.state().status,'done');
});
/* The voices this Mac's Gecko lists, in its order (NSSpeechSynthesizer.availableVoices, alphabetical), system default Korean. */
const MAC_VOICES=[['Albert','com.apple.speech.synthesis.voice.Albert','en-US'],['Aman','com.apple.voice.Aman','en-IN'],['Bad News','com.apple.speech.synthesis.voice.BadNews','en-US'],
 ['Daniel','com.apple.voice.compact.en-GB.Daniel','en-GB'],['Eddy (영어(미국))','com.apple.eloquence.en-US.Eddy','en-US'],['Eddy (한국어(한국))','com.apple.eloquence.ko-KR.Eddy','ko-KR'],
 ['Flo (한국어(한국))','com.apple.eloquence.ko-KR.Flo','ko-KR'],['Fred','com.apple.speech.synthesis.voice.Fred','en-US'],['Grandma (영어(미국))','com.apple.eloquence.en-US.Grandma','en-US'],
 ['Karen','com.apple.voice.compact.en-AU.Karen','en-AU'],['Rocko (한국어(한국))','com.apple.eloquence.ko-KR.Rocko','ko-KR'],['Samantha (영어(미국))','com.apple.voice.compact.en-US.Samantha','en-US'],
 ['Superstar','com.apple.speech.synthesis.voice.Princess','en-US'],['Wobble','com.apple.speech.synthesis.voice.Deranged','en-US'],['Yuna (한국어(한국))','com.apple.voice.compact.ko-KR.Yuna','ko-KR',true]]
 .map(([name,id,lang,def])=>({name,voiceURI:'urn:moz-tts:osx:'+id,lang,localService:true,default:!!def}));
test('automatic voice: a natural voice for the language, never an Indian-English, Eloquence or novelty voice that sorts first',()=>{
 assert.match(RA.pickVoice(MAC_VOICES,'en').name,/^Samantha/,'not Aman, the first English voice in the list');
 assert.match(RA.pickVoice(MAC_VOICES,'ko').name,/^Yuna/,'not Eddy, the first Korean voice in the list');
 const v=(name,id,lang='en-US',extra={})=>({name,voiceURI:id,lang,localService:true,...extra});
 assert.equal(RA.pickVoice([v('Fred','fred',undefined,{default:true}),v('Samantha','sam'),v('Alex','alex')],'en').voiceURI,'sam','a default novelty voice still loses');
 assert.equal(RA.pickVoice([v('Daniel (Enhanced)','com.apple.voice.enhanced.en-GB.Daniel','en-GB'),v('Samantha (Premium)','com.apple.voice.premium.en-US.Samantha')],'en').name,'Samantha (Premium)');
 assert.equal(RA.pickVoice([v('Samantha','com.apple.voice.compact.en-US.Samantha'),v('Ava (Premium)','com.apple.voice.premium.en-US.Ava')],'en').name,'Ava (Premium)','a premium voice beats a compact one');
 assert.equal(RA.pickVoice([v('Samantha','com.apple.voice.compact.en-US.Samantha'),v('Samantha (Enhanced)','com.apple.voice.enhanced.en-US.Samantha')],'en').name,'Samantha (Enhanced)');
});
test('the paper\'s language is judged across its body, not from an English abstract at the start',()=>{
 const en=Array.from({length:70},(_,i)=>({kind:'body',text:'We measured gene expression in sample '+i+'.'}));
 const ko=Array.from({length:200},(_,i)=>({kind:'body',text:'본 연구에서는 유전자 발현과 단백질 수준을 측정하였다 '+i+'.'}));
 assert.equal(RA.paperLanguage([...en,...ko]),'ko');
 assert.equal(RA.paperLanguage(en),'en');
 assert.equal(RA.paperLanguage([...ko.slice(0,5),...en,...en,...en]),'en');
 assert.equal(RA.paperLanguage([]),'en');
});
test('long sentences: most are one utterance; a cut falls at a clause near the middle, never leaving a two-word scrap or splitting a name',()=>{
 // akkaya p1, 291 characters: was cut into "To this end, | ...isolate | Burkholderia species R34)."
 const s1='To this end, the genetically tractable strain Pseudomonas putida EM173 was implanted with the whole genetic complement necessary for the complete biodegradation of 2,4-DNT (recruited from the environmental isolate Burkholderia species R34).';
 assert.deepEqual(RA.splitForEngine(s1),[s1],'under the limit: one utterance, one intonation');
 const s2='We compared the abundance of each amplicon sequence variant in the bulk feces with the number of isolates recovered from it, which appeared to be positively correlated across donors, timepoints and culture media; still, we identified a set of abundant yet difficult-to-culture bacteria, including Faecalibacterium, Prevotella, Oscillibacter and Clostridium species that were missed by colony picking at random and only recovered by morphology-guided picking.';
 const c=RA.splitForEngine(s2);
 assert.equal(c.length,2);assert.match(c[0],/culture media;$/,'cut at the semicolon, the clause boundary nearest the middle');
 assert.ok(c.every(x=>x.length<=RA.CHUNK_MAX&&x.split(' ').length>=8));
 const s3='The cells were grown in 50 micrograms per milliliter kanamycin '+'and further selective media containing several antibiotics '.repeat(7)+'until saturation.';
 for(const x of RA.splitForEngine(s3))assert.ok(!/^(?:micrograms|per|milliliter)\b/.test(x),'a quantity stays whole: '+x.slice(0,30));
});
