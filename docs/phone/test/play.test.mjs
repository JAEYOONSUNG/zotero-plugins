/* The player, with a fake voice: what it says, in what order, and what it does when the phone
   interrupts it. No DOM, no phone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayer, pickVoice, paperLanguage, speechEngine, spokenSeconds, sectionsOf, WATCH_EVERY} from '../play.js';

/* A voice that speaks when told to: queue(), then finish() ends the oldest utterance. */
function fakeEngine({supportsPause = true} = {}) {
  const spoken = [], queue = [];
  let cancels = 0, paused = false;
  return {
    name: 'fake', supportsPause,
    spoken, get cancels() { return cancels; }, get paused() { return paused; }, get pending() { return queue.length; },
    available: () => true,
    voices: () => [],
    speak(utterance) { queue.push(utterance); },
    cancel() { cancels++; queue.length = 0; },
    pause() { paused = true; },
    resume() { paused = false; },
    /* The phone starts the oldest queued utterance and then finishes it. */
    start() { const u = queue[0]; if (u) { spoken.push(u.text); u.onstart && u.onstart(); } return u; },
    finish() { const u = queue.shift(); if (u) u.onend && u.onend(); return u; },
    step() { this.start(); return this.finish(); },
    fail(reason) { const u = queue.shift(); if (u) u.onerror && u.onerror(reason); }
  };
}

const units = (...texts) => texts.map((text, index) => ({text, spoken: text, index, page: 1}));

/* A clock the test turns by hand, so the watchdog can be made to fire without waiting for it and
   no test leaves a timer running behind it. */
function handClock() {
  let at = 0;
  const ticks = [];
  return {
    now: () => at,
    every: (fn, ms) => { ticks.push({fn, ms}); return ticks.length; },
    stopEvery: id => { if (ticks[id - 1]) ticks[id - 1].fn = null; },
    pass(ms) { at += ms; for (const tick of ticks) if (tick.fn) tick.fn(); },
    get running() { return ticks.filter(t => t.fn).length; }
  };
}
/* Every player here runs on a hand clock, so none of them leaves a timer behind. */
const makePlayer = options => {
  const clock = handClock();
  return createPlayer({now: clock.now, every: clock.every, stopEvery: clock.stopEvery, ...options});
};

test('playing reads the sentences in order and queues the next one as each starts', () => {
  const engine = fakeEngine();
  const seen = [];
  const player = makePlayer({engine, onChange: event => seen.push(event.type)});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();

  engine.start();
  assert.equal(engine.pending, 2, 'the second sentence is queued while the first speaks');
  engine.finish();
  engine.start();
  engine.finish();
  engine.start();
  engine.finish();

  assert.deepEqual(engine.spoken, ['One.', 'Two.', 'Three.']);
  assert.equal(player.state().status, 'done');
  assert.ok(seen.includes('done'));
});

test('the section name is said once, before the first sentence under it', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load([{text: 'We did it.', spoken: 'We did it.', lead: 'Results'}, {text: 'And more.', spoken: 'And more.'}]);
  player.play();
  engine.step(); engine.step();
  assert.deepEqual(engine.spoken, ['Results. We did it.', 'And more.']);
});

test('pause stops where it is and resume carries on without repeating', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.start();
  player.pause();
  assert.equal(player.state().status, 'paused');
  assert.equal(engine.paused, true);
  player.resume();
  assert.equal(player.state().status, 'playing');
  assert.equal(engine.paused, false);
  assert.deepEqual(engine.spoken, ['One.'], 'resuming does not say the sentence again');
});

test('a voice that cannot pause is stopped and starts the same sentence again', () => {
  const engine = fakeEngine({supportsPause: false});
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.start();
  player.pause();
  assert.equal(engine.cancels > 0, true);
  player.resume();
  engine.start();
  assert.deepEqual(engine.spoken, ['One.', 'One.']);
});

test('jumping while playing starts there and drops what was queued', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();
  engine.start();
  player.seek(2);
  engine.start();
  assert.deepEqual(engine.spoken, ['One.', 'Three.']);
  assert.equal(player.state().index, 2);
});

test('jumping while paused moves the place without speaking', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.', 'Three.'));
  player.next();
  assert.equal(player.state().index, 1);
  assert.deepEqual(engine.spoken, []);
  player.prev(); player.prev();
  assert.equal(player.state().index, 0, 'it stops at the first sentence');
});

test('a sentence the phone drops without starting does not stall the rest', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();
  engine.start();            // One. speaks, Two. is queued
  engine.finish();           // One. ends
  engine.finish();           // Two. ends without ever starting
  engine.start();
  assert.deepEqual(engine.spoken, ['One.', 'Three.']);
});

test('a real failure stops and is reported once', () => {
  const engine = fakeEngine();
  const seen = [];
  const player = makePlayer({engine, onChange: event => seen.push(event.type)});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.fail('synthesis-failed');
  assert.equal(player.state().status, 'error');
  assert.equal(player.state().error, 'synthesis-failed');
  assert.equal(seen.filter(t => t === 'error').length, 1);
});

test('changing speed while playing keeps the place and speaks it at the new rate', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();
  engine.start(); engine.finish();
  engine.start();                       // on Two.
  player.setRate(1.5);
  const next = engine.start();
  assert.equal(player.state().index, 1);
  assert.equal(next.rate, 1.5);
  assert.equal(player.state().rate, 1.5);
});

test('the rate stays within what a voice can do', () => {
  const player = makePlayer({engine: fakeEngine()});
  assert.equal(player.setRate(9), 2);
  assert.equal(player.setRate(0.1), 0.5);
  assert.equal(player.setRate('fast'), 0.5, 'nonsense leaves the rate alone');
});

test('the voice is chosen for the language, the better ones first, and a saved one wins', () => {
  const voices = [
    {voiceURI: 'u-fred', name: 'Fred', lang: 'en-US'},
    {voiceURI: 'u-sam', name: 'Samantha', lang: 'en-US', localService: true},
    {voiceURI: 'u-siri', name: 'Siri Voice 4', lang: 'en-US'},
    {voiceURI: 'u-yuna', name: 'Yuna', lang: 'ko-KR'}
  ];
  assert.equal(pickVoice(voices, 'en').voiceURI, 'u-siri');
  assert.equal(pickVoice(voices, 'ko').voiceURI, 'u-yuna');
  assert.equal(pickVoice(voices, 'en', 'u-sam').voiceURI, 'u-sam');
  assert.equal(pickVoice(voices, 'fr'), null);
});

test('the paper language comes from the body, not from one English line', () => {
  assert.equal(paperLanguage(units('We show that the enzyme degrades PET.')), 'en');
  assert.equal(paperLanguage(units('Abstract', '이 논문은 효소가 플라스틱을 분해함을 보인다.', '방법은 다음과 같다.')), 'ko');
});

test('the phone engine reports itself unavailable when the phone has no speech', () => {
  assert.equal(speechEngine({}).available(), false);
});

/* iOS stops speaking now and then and reports nothing: the reader is left looking at a sentence
   that never finishes. The watchdog is what notices. */
test('a voice that goes quiet without a word is started again where it stopped', () => {
  const engine = fakeEngine();
  engine.speaking = () => false;
  const clock = handClock();
  const seen = [];
  const player = createPlayer({engine, ...clock, onChange: event => seen.push(event.type)});
  player.load(units('One sentence here.', 'Two.', 'Three.'));
  player.play();
  engine.start();
  assert.deepEqual(engine.spoken, ['One sentence here.']);

  clock.pass(3000);                       // still well within the time this sentence should take
  assert.equal(engine.spoken.length, 1, 'a sentence being read is left alone');

  clock.pass(20000);                      // long past it, and the engine says it is not speaking
  assert.equal(engine.spoken.length, 1, 'the sentence is queued again, not spoken twice over');
  engine.start();
  assert.deepEqual(engine.spoken, ['One sentence here.', 'One sentence here.'], 'the same sentence, again');
  assert.ok(seen.includes('stalled'), 'and it is reported');
  assert.equal(player.state().revivals, 1);
  player.stop();
  assert.equal(clock.running, 0, 'nothing is left ticking');
});

test('a voice that is simply slow is not interrupted', () => {
  const engine = fakeEngine();
  engine.speaking = () => true;           // still talking, just taking its time
  const clock = handClock();
  const player = createPlayer({engine, ...clock});
  player.load(units('A very long sentence indeed.', 'Two.'));
  player.play();
  engine.start();
  clock.pass(60000);
  assert.deepEqual(engine.spoken, ['A very long sentence indeed.'], 'it was left to finish');
  player.stop();
});

test('nothing is watched while it is paused, stopped or finished', () => {
  const engine = fakeEngine();
  engine.speaking = () => false;
  const clock = handClock();
  const player = createPlayer({engine, ...clock});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.start();
  player.pause();
  clock.pass(60000);
  assert.deepEqual(engine.spoken, ['One.'], 'a paused paper is not revived');
  player.stop();
  assert.equal(clock.running, 0);
  assert.ok(WATCH_EVERY > 0);
});

test('how long a sentence should take is guessed from its words, and its Hangul', () => {
  assert.ok(spokenSeconds('one two three four five six', 1) > 1.5);
  assert.ok(spokenSeconds('one two three four five six', 2) < spokenSeconds('one two three four five six', 1));
  assert.ok(spokenSeconds('이 효소는 플라스틱을 분해한다', 1) > 1.2);
  assert.equal(spokenSeconds('', 1), 1.2, 'nothing still takes a moment');
});

test('the sections of a paper are listed with where each one starts', () => {
  const list = [
    {text: 'a', section: 'Introduction'}, {text: 'b', section: 'Introduction'},
    {text: 'c', section: 'Results'}, {text: 'd'}, {text: 'e', section: 'Discussion'}
  ];
  assert.deepEqual(sectionsOf(list), [
    {name: 'Introduction', index: 0}, {name: 'Results', index: 2}, {name: 'Discussion', index: 4}
  ]);
  assert.deepEqual(sectionsOf([]), []);
  assert.deepEqual(sectionsOf(null), []);
});
