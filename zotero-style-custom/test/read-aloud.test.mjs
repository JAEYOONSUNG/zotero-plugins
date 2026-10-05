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

test('a sentence over 200 characters is cut at clause commas for the engine and never mid-word',()=>{
 const long='alpha beta gamma delta, '.repeat(14)+'omega.';
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
