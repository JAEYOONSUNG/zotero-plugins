/* The player, with a fake voice: what it says, in what order, and what it does when the phone
   interrupts it. No DOM, no phone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayer, pickVoice, paperLanguage, speechEngine, spokenSeconds, sectionsOf, WATCH_EVERY,
        voiceTier, voiceMenu, langName, sampleFor, RATES, bakedVoice, splitForVoice, VOICE_MAX, GIVE_UP} from '../play.js';

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

test('how loud is asked for with the words, and changing it says the sentence again', () => {
  const engine = fakeEngine();
  const player = makePlayer({engine, volume: 0.6});
  player.load(units('One.', 'Two.'));
  player.play();
  const first = engine.start();
  assert.equal(first.volume, 0.6, 'the loudness travels with the sentence');
  assert.equal(player.state().volume, 0.6);
  player.setVolume(1);
  const again = engine.start();
  assert.equal(again.volume, 1, 'and the sentence is said again at the new one');
  assert.equal(player.setVolume(4), 1, 'louder than the phone can go is the phone');
  assert.equal(player.setVolume(-1), 0);
  assert.equal(player.setVolume('loud'), 0, 'nonsense leaves it alone');
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
  assert.equal(paperLanguage(units('本研究では酵素がプラスチックを分解することを示す。')), 'ja');
  assert.equal(paperLanguage(units('本文研究了酶对塑料的降解作用。')), 'zh');
  // A Korean paper quotes English and borrows Chinese characters; neither takes it away from Korean.
  assert.equal(paperLanguage(units('이 논문은 PET depolymerase (分解酵素) 의 활성을 보인다.')), 'ko');
});

/* iOS ships one tinny voice per language and downloads the good ones on demand, so the only way to
   tell a 1990s voice from a Siri one is the name it arrives under. */
test('a voice is sorted by how good it sounds, and a toy voice is never offered as the best', () => {
  assert.equal(voiceTier({name: 'Siri Voice 4', lang: 'en-US'}), 'siri');
  assert.equal(voiceTier({name: 'Yuna (Premium)', lang: 'ko-KR'}), 'premium');
  assert.equal(voiceTier({name: 'Samantha (Enhanced)', lang: 'en-US'}), 'enhanced');
  assert.equal(voiceTier({name: 'Samantha', lang: 'en-US'}), 'plain');
  assert.equal(voiceTier({name: 'Zarvox', lang: 'en-US'}), 'novelty');
  assert.equal(voiceTier({name: '', voiceURI: 'com.apple.voice.premium.ko-KR.Yuna'}), 'premium');
});

test('a language is named in the reader\'s own words, and an unknown one is still named', () => {
  assert.equal(langName('ko-KR'), '한국어');
  assert.equal(langName('en-US'), '영어');
  assert.equal(langName('en-GB'), '영어 (영국)');
  assert.equal(langName('pt-BR'), '포르투갈어 (브라질)');
  assert.equal(langName('fa-IR'), 'FA');
  assert.equal(langName(''), '');
  assert.match(sampleFor('ko'), /목소리/);
  assert.match(sampleFor('de'), /Hello/, 'a language with no line of its own is heard in English');
});

test('the voices on this phone become a menu: the paper\'s language whole, the others in short', () => {
  const voices = [
    {voiceURI: 'u-fred', name: 'Fred', lang: 'en-US'},
    {voiceURI: 'u-sam', name: 'Samantha', lang: 'en-US', localService: true},
    {voiceURI: 'u-siri', name: 'Siri Voice 4', lang: 'en-US'},
    {voiceURI: 'u-ava', name: 'Ava (Premium)', lang: 'en-US'},
    {voiceURI: 'u-yuna', name: 'Yuna', lang: 'ko-KR'},
    {voiceURI: 'u-sora', name: 'Sora (Enhanced)', lang: 'ko-KR'},
    {voiceURI: 'u-kyoko', name: 'Kyoko', lang: 'ja-JP'}
  ];
  const menu = voiceMenu(voices, 'ko');
  assert.equal(menu[0].lang, 'ko', "the paper's own language comes first");
  assert.equal(menu[0].name, '한국어');
  assert.deepEqual(menu[0].voices.map(v => v.voiceURI), ['u-sora', 'u-yuna'], 'the better one first');
  assert.deepEqual(menu.map(g => g.lang), ['ko', 'en', 'ja'], 'then the languages with the most voices');
  assert.equal(menu[1].voices[0].voiceURI, 'u-siri', 'each language leads with its best');
  assert.equal(menu[1].voices[menu[1].voices.length - 1].voiceURI, 'u-fred', 'and the toy voice is last');

  // A phone with thirty languages on it is still a menu a thumb can get to the bottom of.
  const many = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 9; j++) many.push({voiceURI: `v${i}-${j}`, name: `V${j}`, lang: `l${i}-X`});
  const big = voiceMenu(many, 'l0');
  assert.equal(big.length, 7, 'the paper\'s language and six others');
  assert.equal(big[0].voices.length, 9, 'the paper\'s own language is offered whole');
  assert.ok(big.slice(1).every(g => g.voices.length <= 6), 'the others are cut to the best few');
  assert.deepEqual(voiceMenu([], 'ko'), [], 'a phone with no voices offers no menu');
});

test('the speeds go up to what the engine can actually do', () => {
  assert.equal(RATES[RATES.length - 1], 2);
  assert.ok(RATES.every(r => r >= 0.5 && r <= 2), 'nothing offered that the player would clamp');
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
  clock.pass(15000);
  assert.deepEqual(engine.spoken, ['A very long sentence indeed.'], 'it was left to finish');
  assert.equal(player.state().revivals, 0, 'and nothing was started again');
  player.stop();
});

/* Coming back from another app is the case the reader actually hits: the voice stopped the
   moment the app went away and iOS said nothing about it, and the queue it abandoned still
   claims to be speaking. A watchdog that believed that waited for ever. */
test('a queue that claims to be speaking but has said nothing for minutes is started again', () => {
  const engine = fakeEngine();
  engine.speaking = () => true;           // what iOS says about a queue it has already dropped
  const clock = handClock();
  const player = createPlayer({engine, ...clock});
  player.load(units('One sentence here.', 'Two.'));
  player.play();
  engine.start();
  clock.pass(120000);                     // two minutes in another app
  engine.start();
  assert.deepEqual(engine.spoken, ['One sentence here.', 'One sentence here.'], 'the sentence is read again');
  assert.equal(player.state().revivals, 1);
  player.stop();
});

test('a file that is still playing is never interrupted, however long the sentence', () => {
  const engine = fakeEngine();
  engine.speaking = () => true;
  engine.baked = true;                    // an audio element: if it says it is playing, it is
  const clock = handClock();
  const player = createPlayer({engine, ...clock});
  player.load(units('One sentence here.', 'Two.'));
  player.play();
  engine.start();
  clock.pass(600000);
  assert.deepEqual(engine.spoken, ['One sentence here.'], 'ten minutes of chapter, uninterrupted');
  assert.equal(player.state().revivals, 0);
  player.stop();
});

test('back from another app: a voice that went quiet starts again, one that is still reading is left alone', () => {
  const quiet = fakeEngine();
  quiet.speaking = () => false;
  const clock = handClock();
  const player = createPlayer({engine: quiet, ...clock});
  player.load(units('One sentence here.', 'Two.'));
  player.play();
  quiet.start();
  player.wake();
  quiet.start();
  assert.deepEqual(quiet.spoken, ['One sentence here.', 'One sentence here.'], 'picked up where it stopped');
  player.stop();

  const sounding = fakeEngine();
  sounding.speaking = () => true;
  const second = createPlayer({engine: sounding, ...handClock()});
  second.load(units('One sentence here.', 'Two.'));
  second.play();
  sounding.start();
  second.wake();
  assert.deepEqual(sounding.spoken, ['One sentence here.'], 'nothing was disturbed');
  assert.equal(second.state().status, 'playing');
  second.stop();
});

test('a paused paper is not woken by coming back to the app', () => {
  const engine = fakeEngine();
  engine.speaking = () => false;
  const player = createPlayer({engine, ...handClock()});
  player.load(units('One.', 'Two.'));
  player.play();
  engine.start();
  player.pause();
  player.wake();
  assert.deepEqual(engine.spoken, ['One.']);
  assert.equal(player.state().status, 'paused');
  player.stop();
});

/* ---- the sentence that was read over and over ----
   iOS stops part way through a long utterance and fires neither end nor error. The sentence
   never finishes, the watchdog starts it again, it stops in the same place: the reader hears one
   sentence for ever. Two things are done about it — nothing long is handed over whole, and a
   sentence that has failed twice is left behind rather than tried a third time. */
const LONG_ONE = 'The enzyme, which was purified from a thermophilic strain isolated in 2019, degrades the polymer at fifty degrees; the reaction was followed by chromatography, and the products were identified by mass spectrometry, which showed that the ester bonds are cleaved in a processive manner, whereas the amide bonds, as reported before, remain intact throughout the whole experiment.';

test('a long sentence is given to the voice in pieces, at the pauses, with nothing lost', () => {
  const pieces = splitForVoice(LONG_ONE);
  assert.ok(pieces.length > 1, 'it was cut');
  assert.ok(pieces.every(piece => piece.length <= VOICE_MAX), 'no piece is longer than a voice will take');
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), LONG_ONE.replace(/\s+/g, ' '), 'and every word is still there');
  assert.ok(pieces.every(piece => /[;,.]$|\b(and|but|which|that|whereas)$/.test(piece.trim()) || piece === pieces.at(-1)),
    'the cuts fall where a reader would pause');
  assert.deepEqual(splitForVoice('A short one.'), ['A short one.'], 'a short sentence is left alone');
  assert.deepEqual(splitForVoice(''), []);
});

test('the pieces are still one sentence: one place in the paper, and the next sentence follows the last piece', () => {
  const engine = fakeEngine();
  const seen = [];
  const player = createPlayer({engine, ...handClock(), onChange: event => seen.push(event.type)});
  player.load([{text: LONG_ONE, spoken: LONG_ONE, index: 0, page: 1}, {text: 'The next one.', spoken: 'The next one.', index: 1, page: 1}]);
  player.play();
  const parts = splitForVoice(LONG_ONE).length;
  assert.ok(parts > 1);
  engine.start();
  assert.equal(player.state().index, 0, 'the first piece is the sentence starting');
  assert.equal(seen.filter(type => type === 'sentence').length, 1, 'one sentence, not one per piece');
  for (let i = 0; i < parts - 1; i++) { engine.finish(); engine.start(); }
  assert.equal(player.state().index, 0, 'still the same sentence while its pieces are read');
  engine.finish();                                  // the last piece ends
  engine.start();
  assert.equal(player.state().index, 1, 'and the paper moves on');
  assert.equal(engine.spoken.at(-1), 'The next one.');
  player.stop();
});

test('a sentence the voice will not say is left behind, not read for ever', () => {
  // A voice that takes the words, begins, and then dies without a word about it: the iOS failure.
  const engine = fakeEngine();
  engine.speaking = () => false;
  const clock = handClock();
  const seen = [];
  const player = createPlayer({engine, ...clock, onChange: event => seen.push(event.type)});
  player.load(units('The sentence it chokes on.', 'The one after it.'));
  player.play();
  for (let i = 0; i <= GIVE_UP; i++) { engine.start(); clock.pass(30000); }
  assert.equal(engine.spoken.filter(text => text === 'The sentence it chokes on.').length, GIVE_UP + 1,
    'it was tried, and tried again, and then let go');
  assert.equal(player.state().index, 1, 'the paper went on');
  assert.ok(seen.includes('skipped'), 'and said so');
  engine.start();
  assert.equal(engine.spoken.at(-1), 'The one after it.');
  player.stop();
});

test('a sentence that comes good after one stall is not held against it', () => {
  const engine = fakeEngine();
  engine.speaking = () => false;
  const clock = handClock();
  const player = createPlayer({engine, ...clock});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();
  clock.pass(30000);                      // the first try is dropped
  engine.start(); engine.finish();        // the second is heard
  engine.start();                         // "Two." begins
  clock.pass(30000);                      // and it stalls once too
  engine.start(); engine.finish();
  engine.start();                         // "Three." begins
  assert.equal(player.state().index, 2, 'every sentence was read, none skipped');
  assert.equal(player.state().status, 'playing');
  player.stop();
});

test('a file is never cut into pieces: its sentences are places in a recording', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: [{at: 0, seconds: 40}, {at: 40, seconds: 5}]});
  const asked = [];
  const spy = {...voice, baked: true, speak(item) { asked.push(item); voice.speak(item); }};
  const player = createPlayer({engine: spy, ...handClock()});
  player.load([{text: LONG_ONE, spoken: LONG_ONE, index: 0, page: 0}, {text: 'Next.', spoken: 'Next.', index: 1, page: 0}]);
  player.play();
  assert.ok(splitForVoice(LONG_ONE).length > 1, 'the phone would have cut this one up');
  assert.deepEqual(asked.map(item => item.at), [0, 1], 'the file was asked for two sentences, not six pieces');
  assert.ok(asked.every(item => item.parts === 1));
  player.stop();
});

test('a baked file says whether a sound is actually coming out of it', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: [{at: 0, seconds: 3}, {at: 3, seconds: 3}]});
  assert.equal(voice.speaking(), false, 'nothing has been asked of it yet');
  voice.speak({at: 0});
  assert.equal(voice.speaking(), true);
  audio.pause();
  assert.equal(voice.speaking(), false, 'iOS paused it while the app was away');
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

/* ---- the voice the Mac made earlier ---- */
function fakeAudio() {
  const handlers = {};
  return {
    currentTime: 0, playbackRate: 1, volume: 1, paused: true, played: 0,
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    play() { this.paused = false; this.played++; return Promise.resolve(); },
    pause() { this.paused = true; },
    fire(name) { for (const fn of handlers[name] || []) fn(); },
    /* The element reaching a moment, the way a real one does: time moves, then it says so. */
    to(seconds) { this.currentTime = seconds; this.fire('timeupdate'); }
  };
}
const MARKS = [{at: 0, seconds: 2}, {at: 2.2, seconds: 3}, {at: 5.5, seconds: 1}];

test('a baked file is a voice: it starts where the sentence starts and ends where the next one does', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  assert.equal(voice.available(), true);
  assert.equal(voice.supportsPause, true);
  assert.deepEqual(voice.voices(), [], 'the voice in a file is already chosen');

  const said = [];
  voice.speak({at: 1, rate: 1.2, volume: 0.5, onstart: () => said.push('start'), onend: () => said.push('end')});
  assert.equal(audio.currentTime, 2.2, 'it moved to where that sentence begins');
  assert.equal(audio.playbackRate, 1.2);
  assert.equal(audio.volume, 0.5);
  assert.equal(audio.paused, false);
  assert.deepEqual(said, ['start']);

  audio.to(4);
  assert.deepEqual(said, ['start'], 'still inside the sentence');
  audio.to(5.5);
  assert.deepEqual(said, ['start', 'end'], 'the next sentence begins, so this one is over');
  audio.to(6);
  assert.deepEqual(said, ['start', 'end'], 'and it is only over once');
});

test('the last sentence ends at its own end, and a file that stops ends it too', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 2, onend: () => said.push('end')});
  audio.to(6.2);
  assert.deepEqual(said, []);
  audio.to(6.5);
  assert.deepEqual(said, ['end'], 'at + seconds, because there is nothing after it');

  const other = fakeAudio(), second = bakedVoice({audio: other, marks: MARKS});
  const over = [];
  second.speak({at: 0, onend: () => over.push('end')});
  other.fire('ended');
  assert.deepEqual(over, ['end']);
});

test('a cancelled sentence is silent afterwards, whatever the element says next', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 0, onend: () => said.push('end'), onerror: () => said.push('error')});
  voice.cancel();
  assert.equal(audio.paused, true);
  audio.to(2.2);
  audio.fire('ended');
  audio.fire('error');
  assert.deepEqual(said, [], 'nothing from the sentence that was dropped');
  // And it can speak again after a cancel.
  voice.speak({at: 0, onstart: () => said.push('start')});
  assert.deepEqual(said, ['start']);
});

test('a sentence the file has no time for is an error, not silence', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  let why = '';
  voice.speak({at: 9, onerror: reason => { why = reason; }});
  assert.equal(why, 'no-such-sentence');
  assert.equal(audio.played, 0);
});

test('playing a whole paper from a baked file runs through the player unchanged', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  const player = makePlayer({engine: voice, rate: 1});
  player.load(units('One.', 'Two.', 'Three.'));
  player.play();
  assert.equal(player.state().status, 'playing');
  assert.equal(player.state().index, 0);
  audio.to(2.2);
  assert.equal(player.state().index, 1, 'the player moved on by itself');
  audio.to(5.5);
  assert.equal(player.state().index, 2);
  // Next and previous are seeks, and they land on the sentence asked for.
  player.prev();
  assert.equal(audio.currentTime, 2.2);
  assert.equal(player.state().index, 1);
  player.pause();
  assert.equal(audio.paused, true);
});

/* ---------- a file that does not arrive the instant it is asked to ----------
   On the phone the paper is streamed from Dropbox: setting currentTime starts a range request, and
   until it lands the element keeps reporting where it was. Reported as "처음에 블록 넘어갈 때 로딩
   래그 때문인지 두 번 읽는 경우가 종종 있어" and "전 블럭으로 한 번 넘어가면 중간에 끊기고 다음
   블럭으로 계속 넘어간다". */
function slowAudio({lag = 0} = {}) {
  const handlers = {};
  return {
    currentTime: 0, playbackRate: 1, volume: 1, paused: true, played: 0, seeking: false, want: null,
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    play() { this.paused = false; this.played++; return Promise.resolve(); },
    pause() { this.paused = true; },
    fire(name) { for (const fn of handlers[name] || []) fn(); },
    // Where the element is sent: with lag it does not move yet, as a streamed file does not.
    set time(seconds) { if (lag) { this.seeking = true; this.want = seconds; } else { this.currentTime = seconds; } },
    to(seconds) { this.currentTime = seconds; this.fire('timeupdate'); },
    tick() { this.fire('timeupdate'); },                       // the clock reports, unmoved
    land() { this.seeking = false; if (this.want !== null) this.currentTime = this.want; this.want = null; this.fire('seeked'); }
  };
}
/* currentTime is a plain property on the fake, so a seek by the voice is caught by defining it. */
function laggy() {
  const audio = slowAudio({lag: 1});
  let held = 0;
  Object.defineProperty(audio, 'currentTime', {
    get() { return held; },
    set(seconds) { audio.seeking = true; audio.want = seconds; },
    configurable: true
  });
  audio.land = () => { audio.seeking = false; if (audio.want !== null) held = audio.want; audio.want = null; audio.fire('seeked'); };
  audio.to = seconds => { held = seconds; audio.fire('timeupdate'); };
  audio.tick = () => audio.fire('timeupdate');
  return audio;
}

test('a boundary noticed late does not send the file back: the words are not said twice', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 0, onstart: () => said.push('start 0'), onend: () => said.push('end 0')});
  assert.equal(audio.currentTime, 0);
  // The player queues the next sentence as this one starts, as it does with every engine.
  voice.speak({at: 1, continues: true, onstart: () => said.push('start 1'), onend: () => said.push('end 1')});
  /* The file stalls and the clock only reports again well inside sentence 1 — the end of 0 and the
     start of 1 arrive at once. Sentence 1 must carry on from here, not jump back to 2.2. */
  audio.to(3.1);
  assert.deepEqual(said, ['start 0', 'end 0', 'start 1']);
  assert.equal(audio.currentTime, 3.1, 'the file was left where it is: no word is said twice');
  audio.to(5.6);
  assert.deepEqual(said, ['start 0', 'end 0', 'start 1', 'end 1']);
});

test('a sentence asked for by hand always goes to its mark, even one already playing', () => {
  const audio = fakeAudio();
  const voice = bakedVoice({audio, marks: MARKS});
  voice.speak({at: 1, onstart() {}, onend() {}});
  audio.to(3.4);
  voice.cancel();
  voice.speak({at: 1, onstart() {}, onend() {}});     // a tap on the sentence being read: from its start
  assert.equal(audio.currentTime, 2.2);
});

test('going back a sentence does not run away forward while the file is still seeking', () => {
  const audio = laggy();
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 2, onstart: () => said.push('start 2'), onend: () => said.push('end 2')});
  audio.land();                                   // it arrives at 5.5 and plays
  audio.to(5.8);
  assert.deepEqual(said, ['start 2']);

  // 이전: the player cancels and asks for sentence 1, whose seek has not landed yet.
  voice.cancel();
  voice.speak({at: 1, onstart: () => said.push('start 1'), onend: () => said.push('end 1')});
  assert.deepEqual(said, ['start 2', 'start 1']);
  // The clock still says 5.8 — past the end of sentence 1. Nothing may be concluded from that.
  audio.tick(); audio.tick(); audio.tick();
  assert.deepEqual(said, ['start 2', 'start 1'], 'no end, so no running away through the paper');
  // It lands, and the sentence is read from its own beginning.
  audio.land();
  audio.to(3.0);
  assert.deepEqual(said, ['start 2', 'start 1']);
  audio.to(5.6);
  assert.deepEqual(said, ['start 2', 'start 1', 'end 1']);
});

test('a seek that never lands is reported rather than leaving the paper silent', () => {
  const audio = laggy();
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 1, onstart: () => said.push('start'), onend: () => said.push('end'), onerror: why => said.push('error:' + why)});
  audio.paused = false;
  for (let i = 0; i < 20 + 1; i++) audio.tick();      // five seconds of the clock saying 0
  assert.equal(audio.want, 2.2, 'it is asked for once more');
  for (let i = 0; i < 20 + 1; i++) audio.tick();
  assert.deepEqual(said, ['start', 'error:seek-failed'], 'and then the player is told, so it can try again');
});

test('a file asked for a sentence before it knows its own length is asked again when it does', () => {
  /* A streamed element with no metadata yet ignores currentTime, and the paper would start from its
     first words instead of the sentence the reader came back to. */
  const audio = fakeAudio();
  audio.readyState = 0;
  let held = 0;
  Object.defineProperty(audio, 'currentTime', {
    get() { return held; },
    set(seconds) { if (audio.readyState) held = seconds; },      // ignored until the metadata is in
    configurable: true
  });
  const voice = bakedVoice({audio, marks: MARKS});
  const said = [];
  voice.speak({at: 2, onstart: () => said.push('start'), onend: () => said.push('end')});
  assert.equal(audio.currentTime, 0, 'the element ignored it, as a real one does');
  audio.readyState = 1;
  audio.fire('loadedmetadata');
  assert.equal(audio.currentTime, 5.5, 'and it is sent there again the moment it can go');
  audio.to(5.9);
  assert.deepEqual(said, ['start'], 'reading the sentence that was asked for, not the first one');
});
