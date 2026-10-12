/* The player, with a fake voice: what it says, in what order, and what it does when the phone
   interrupts it. No DOM, no phone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayer, pickVoice, paperLanguage, speechEngine} from '../play.js';

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

test('playing reads the sentences in order and queues the next one as each starts', () => {
  const engine = fakeEngine();
  const seen = [];
  const player = createPlayer({engine, onChange: event => seen.push(event.type)});
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
  const player = createPlayer({engine});
  player.load([{text: 'We did it.', spoken: 'We did it.', lead: 'Results'}, {text: 'And more.', spoken: 'And more.'}]);
  player.play();
  engine.step(); engine.step();
  assert.deepEqual(engine.spoken, ['Results. We did it.', 'And more.']);
});

test('pause stops where it is and resume carries on without repeating', () => {
  const engine = fakeEngine();
  const player = createPlayer({engine});
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
  const player = createPlayer({engine});
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
  const player = createPlayer({engine});
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
  const player = createPlayer({engine});
  player.load(units('One.', 'Two.', 'Three.'));
  player.next();
  assert.equal(player.state().index, 1);
  assert.deepEqual(engine.spoken, []);
  player.prev(); player.prev();
  assert.equal(player.state().index, 0, 'it stops at the first sentence');
});

test('a sentence the phone drops without starting does not stall the rest', () => {
  const engine = fakeEngine();
  const player = createPlayer({engine});
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
  const player = createPlayer({engine, onChange: event => seen.push(event.type)});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.fail('synthesis-failed');
  assert.equal(player.state().status, 'error');
  assert.equal(player.state().error, 'synthesis-failed');
  assert.equal(seen.filter(t => t === 'error').length, 1);
});

test('changing speed while playing keeps the place and speaks it at the new rate', () => {
  const engine = fakeEngine();
  const player = createPlayer({engine});
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
  const player = createPlayer({engine: fakeEngine()});
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
