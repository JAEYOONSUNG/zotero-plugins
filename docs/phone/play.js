/* Reading the paper out loud on the phone.

   The player is a small state machine over the sentences read.js prepared. It never touches the
   DOM or the network: it is given an engine and tells the caller what changed, so the whole of
   it is tested without a phone.

     engine.speak({text, unit, at, lang, voiceURI, rate, onstart, onend, onerror})
     engine.cancel()            drop everything queued or speaking
     engine.pause() / resume()  when engine.supportsPause

   iOS Safari's speechSynthesis is the engine in the app (speechEngine below). Two things about
   it shape this file:
   - The first speak() must happen inside the tap that asked for it, so play() speaks at once
     rather than after an await.
   - The queue is global and an utterance nobody holds a reference to can be collected before it
     ends, so the engine keeps its own set of live utterances.

   One sentence is queued while the one before it is still speaking, so there is no gap between
   them; a pause or a jump cancels the queue and starts again from where the reader is. */

const RATE_MIN = 0.5, RATE_MAX = 2;
const clamp = (value, low, high, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

/* ---- the engine on this phone ---- */
export function speechEngine(win = globalThis) {
  const synth = win.speechSynthesis, Utterance = win.SpeechSynthesisUtterance;
  const live = new Set();
  let epoch = 0;
  const voices = () => { try { return Array.from(synth.getVoices() || []); } catch (_) { return []; } };
  return {
    name: 'speechSynthesis',
    supportsPause: true,
    available() { return !!synth && typeof Utterance === 'function'; },
    voices() { return voices().map(v => ({voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: !!v.localService, default: !!v.default})); },
    speak({text, lang, voiceURI, rate, volume, onstart, onend, onerror}) {
      const utterance = new Utterance(text);
      utterance.lang = lang || '';
      utterance.rate = rate || 1;
      /* The loudest the web can ask for is 1, which is the phone's own volume: a voice cannot be
         pushed past it from here. It is set anyway so that a quieter one can be asked for. */
      if (volume !== undefined) utterance.volume = Math.min(1, Math.max(0, Number(volume) || 0));
      if (voiceURI) { const voice = voices().find(v => v.voiceURI === voiceURI); if (voice) utterance.voice = voice; }
      const mine = epoch;
      live.add(utterance);
      utterance.onstart = () => { if (mine === epoch && onstart) onstart(); };
      utterance.onend = () => { live.delete(utterance); if (mine === epoch && onend) onend(); };
      utterance.onerror = event => {
        live.delete(utterance);
        if (mine !== epoch) return;
        const reason = String(event && event.error || 'error');
        if (reason === 'canceled' || reason === 'interrupted') return;
        if (onerror) onerror(reason);
      };
      synth.speak(utterance);
    },
    cancel() { epoch++; live.clear(); try { synth.cancel(); } catch (_) {} },
    speaking() { try { return !!(synth.speaking || synth.pending); } catch (_) { return false; } },
    pause() { try { synth.pause(); } catch (_) {} },
    resume() { try { synth.resume(); } catch (_) {} }
  };
}

/* The voice to read a paper with: one that speaks the paper's language, the better-sounding ones
   first. iOS names its best ones "Siri" or marks them enhanced/premium; the novelty voices are
   the ones that made the desktop read-aloud sound like a toy. */
const NOVELTY = /\b(?:albert|bad ?news|bahh|bells|boing|bubbles|cellos|deranged|wobble|fred|good ?news|hysterical|jester|junior|organ|princess|superstar|ralph|trinoids|whisper|zarvox)\b/i;
const FAVOURITE = {en: /^(?:samantha|alex|ava|zoe|siri)\b/i, ko: /^(?:yuna|sora|siri)\b|유나/i};

/* How good a voice sounds, which is the one thing a listener is choosing between. iOS ships a
   compact voice for every language and downloads the better ones on demand, so the same list can
   hold a tinny 1990s voice and a Siri one, and the names are the only way to tell them apart. */
export const TIERS = [['siri', 'Siri'], ['premium', '프리미엄'], ['enhanced', '고품질'], ['plain', '기본'], ['novelty', '장난감']];
export function voiceTier(voice) {
  const name = String(voice && voice.name || '');
  const both = `${name} ${voice && voice.voiceURI || ''}`;
  if (NOVELTY.test(name)) return 'novelty';
  if (/siri/i.test(both)) return 'siri';
  if (/premium/i.test(both)) return 'premium';
  if (/enhanced|neural/i.test(both)) return 'enhanced';
  return 'plain';
}
const TIER_RANK = {siri: 4, premium: 3, enhanced: 2, plain: 1, novelty: -100};

export function pickVoice(list, lang = 'en', savedURI = '') {
  const voices = Array.isArray(list) ? list : [];
  if (savedURI) { const kept = voices.find(v => v.voiceURI === savedURI); if (kept) return kept; }
  const code = baseLang(lang);
  const same = voices.filter(v => baseLang(v.lang) === code);
  if (!same.length) return null;
  return same.map((v, i) => ({v, i, s: voiceScore(v, code)})).sort((a, b) => b.s - a.s || a.i - b.i)[0].v;
}
function voiceScore(v, code) {
  const tier = TIER_RANK[voiceTier(v)] || 1;
  if (tier < 0) return -100;
  return tier * 10 + (FAVOURITE[code] && FAVOURITE[code].test(v.name || '') ? 3 : 0) + (v.default ? 1 : 0) + (v.localService ? 0.5 : 0);
}
export const baseLang = lang => String(lang || '').toLowerCase().replace('_', '-').split('-')[0];

/* The languages this app has anything to say about, in the reader's own words. Anything else is
   shown by its code rather than left blank: a voice nobody can name is still a voice. */
const LANGS = {ko: '한국어', en: '영어', ja: '일본어', zh: '중국어', de: '독일어', fr: '프랑스어',
               es: '스페인어', it: '이탈리아어', pt: '포르투갈어', ru: '러시아어', nl: '네덜란드어',
               sv: '스웨덴어', da: '덴마크어', no: '노르웨이어', fi: '핀란드어', pl: '폴란드어',
               tr: '터키어', ar: '아랍어', hi: '힌디어', th: '태국어', vi: '베트남어', id: '인도네시아어',
               he: '히브리어', cs: '체코어', el: '그리스어', hu: '헝가리어', ro: '루마니아어', uk: '우크라이나어'};
const REGIONS = {'en-gb': '영국', 'en-au': '호주', 'en-in': '인도', 'en-ie': '아일랜드', 'en-za': '남아공',
                 'zh-tw': '대만', 'zh-hk': '홍콩', 'pt-br': '브라질', 'fr-ca': '캐나다', 'es-mx': '멕시코'};
export function langName(code) {
  const full = String(code || '').toLowerCase().replace('_', '-');
  const base = baseLang(full);
  if (!base) return '';
  const name = LANGS[base] || base.toUpperCase();
  const region = REGIONS[full];
  return region ? `${name} (${region})` : name;
}

/* The voices this phone has, as a menu: the paper's own language first and whole, then every other
   language it can speak, each one headed by its name and cut to the few best in it. The point of
   showing the others at all is that papers quote, and that a reader may simply prefer a voice. */
export function voiceMenu(list, lang = 'en', {others = 6, each = 6} = {}) {
  const voices = (Array.isArray(list) ? list : []).filter(v => v && v.voiceURI);
  const code = baseLang(lang);
  const by = new Map();
  for (const voice of voices) {
    const key = baseLang(voice.lang) || '?';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(voice);
  }
  const order = (group, who) => group
    .map((v, i) => ({v, i, s: voiceScore(v, who)}))
    .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.v);
  const groups = [];
  if (by.has(code)) groups.push({lang: code, name: langName(code), voices: order(by.get(code), code)});
  const rest = [...by.keys()].filter(key => key !== code)
    .sort((a, b) => by.get(b).length - by.get(a).length || a.localeCompare(b))
    .slice(0, Math.max(0, others));
  for (const key of rest) groups.push({lang: key, name: langName(key), voices: order(by.get(key), key).slice(0, Math.max(1, each))});
  return groups;
}

/* A line to hear a voice say before it is chosen, in the language it speaks. */
const SAMPLES = {
  ko: '안녕하세요. 이 목소리로 논문을 읽어 드립니다.',
  en: 'Hello. This is the voice that will read your paper.',
  ja: 'こんにちは。この声で論文を読み上げます。',
  zh: '你好，我将用这个声音为你朗读论文。'
};
export const sampleFor = lang => SAMPLES[baseLang(lang)] || SAMPLES.en;

/* The language a paper is in, from the sentences themselves. Hangul first: a Korean paper quotes
   enough English, and borrows enough Chinese characters, to be mistaken for either. */
export function paperLanguage(units) {
  const sample = (Array.isArray(units) ? units : []).slice(0, 400).map(u => u.spoken || u.text || '').join(' ');
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const hangul = (sample.match(/[가-힣]/g) || []).length;
  if (hangul > latin * 0.2) return 'ko';
  const kana = (sample.match(/[\u3040-\u30ff]/g) || []).length;
  if (kana > latin * 0.2) return 'ja';
  const han = (sample.match(/[\u4e00-\u9fff]/g) || []).length;
  if (han > latin * 0.2) return 'zh';
  return 'en';
}

/* ---- the player ---- */
/* How long a sentence should take, so a voice that has gone quiet can be told from a slow one. */
export function spokenSeconds(text, rate = 1) {
  const body = String(text || '');
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const hangul = (body.match(/[가-힣]/g) || []).length;
  return Math.max(1.2, (words / 2.7) + (hangul / 5.5)) / Math.max(0.5, rate);
}

/* ---- how much a voice is given at once ----
   iOS stops speaking part way through a long utterance, fires neither `end` nor `error`, and
   leaves `speaking` saying whatever it likes. The sentence then never finishes, the watchdog
   starts it again, it stops in the same place, and the reader hears the same sentence for ever.
   About one sentence in eighty in these papers is long enough for that (1.2% are over 400
   characters, a few per paper), which is exactly how often the reader met it.

   So nothing longer than VOICE_MAX is ever handed over whole. The sentence is unchanged on
   screen and is still one sentence to the player — only what the voice is given is cut, at the
   pause nearest the middle that a reader would take, outside any bracket. The desktop plugin
   has done this since it was written (CHUNK_MAX there); the phone never did. */
export const VOICE_MAX = 300, LEAST_PIECE = 60;
const CUTS = [/[.;:?!]\s/g, /,\s/g, /\s(?:and|but|or|which|that|while|whereas|because|although|however|therefore|thus)\s/gi, /\s/g];
export function splitForVoice(text, max = VOICE_MAX) {
  const body = String(text || '').trim();
  if (!body) return [];
  if (!max || body.length <= max) return [body];
  // Where the brackets are, so a list of genes is not cut in half.
  const depth = [];
  let open = 0;
  for (const ch of body) { if (ch === '(' || ch === '[') open++; depth.push(open); if ((ch === ')' || ch === ']') && open > 0) open--; }
  const middle = body.length / 2, least = Math.min(LEAST_PIECE, Math.floor(body.length / 4));
  let cut = -1;
  for (const rule of CUTS) {
    for (const outside of [true, false]) {
      rule.lastIndex = 0;
      let found, best = -1, nearest = Infinity;
      while ((found = rule.exec(body))) {
        const at = found.index + found[0].length;
        if (at < least || body.length - at < least) continue;
        if (outside && depth[found.index] > 0) continue;
        const off = Math.abs(at - middle);
        if (off < nearest) { nearest = off; best = at; }
      }
      if (best > 0) { cut = best; break; }
    }
    if (cut > 0) break;
  }
  if (cut < 0) cut = max;
  return [...splitForVoice(body.slice(0, cut), max), ...splitForVoice(body.slice(cut), max)];
}

export const WATCH_EVERY = 2500;
/* How many sentences' worth of silence a queue that claims to be speaking is given, and how
   many times one sentence may be started again before the paper goes on without it. */
export const STUCK = 3, GIVE_UP = 2;

export function createPlayer({
  engine, onChange = () => {}, rate = 1, lang = 'en', voiceURI = '', volume = 1,
  now = () => Date.now(),
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = id => clearInterval(id)
} = {}) {
  if (!engine) throw new Error('an engine is required');
  let list = [], index = 0, status = 'idle', generation = 0, queuedTo = -1, entered = -1, error = '';
  let heard = 0, watch = null, revivals = 0, stuckAt = -1, tries = 0;
  let speakRate = clamp(rate, RATE_MIN, RATE_MAX, 1), speakLang = lang || 'en', speakVoice = voiceURI || '';
  let speakVolume = clamp(volume, 0, 1, 1);
  const state = () => ({status, index, total: list.length, unit: list[index] || null,
                       rate: speakRate, lang: speakLang, voiceURI: speakVoice, volume: speakVolume,
                       error, revivals});
  const emit = type => { try { onChange({type, state: state()}); } catch (_) {} };
  const alive = () => { heard = now(); };
  const sayable = unit => {
    const spoken = String(unit && unit.spoken || unit && unit.text || '').trim();
    const lead = unit && unit.lead ? String(unit.lead).replace(/[.。]?\s*$/, '. ') : '';
    return (lead + spoken).trim();
  };

  /* iOS drops the speech queue now and then — the screen dims, a notification arrives, the app
     goes to the background — and says nothing about it, leaving the reader looking at a sentence
     that never finishes. So while it is meant to be playing, a sentence that has had long enough
     to be spoken and has made no sound is started again.

     `speaking()` is not proof of life: the queue iOS abandoned when the app went away still says
     it is speaking when the app comes back, and a watchdog that believed it would wait for ever.
     So it buys time (STUCK sentences' worth) and no more. A file is the exception — an audio
     element that says it is playing is playing, and interrupting it would be the only thing in
     this function a listener could hear. */
  function watchdog() {
    if (status !== 'playing') return;
    const due = spokenSeconds(sayable(list[index]), speakRate) * 1000 + 6000;
    const quiet = now() - heard;
    if (quiet < due) return;
    if (engine.speaking && engine.speaking() && (engine.baked || quiet < due * STUCK)) return;
    revive();
  }

  /* A sentence the voice will not say is left behind rather than read for ever. Starting it
     again is right the first time — the queue was dropped and the words were never heard — but
     a sentence that has now failed GIVE_UP times will fail the next time too, and a reader
     listening to the same words for the fourth time has lost the paper, not one sentence. */
  function revive() {
    if (stuckAt !== index) { stuckAt = index; tries = 0; }
    tries++;
    revivals++;
    emit('stalled');
    if (tries <= GIVE_UP) { startAt(index); return; }
    stuckAt = -1; tries = 0;
    if (index + 1 >= list.length) { status = 'done'; watching(false); emit('done'); return; }
    emit('skipped');
    startAt(index + 1);
  }
  function watching(on) {
    if (on && !watch) watch = every(watchdog, WATCH_EVERY);
    if (!on && watch) { stopEvery(watch); watch = null; }
  }

  function enqueue(at, mine) {
    const unit = list[at];
    if (!unit) return;
    queuedTo = at;
    /* A file is not cut up: there, `at` is a place in the recording, and asking for it twice
       would play the same seconds twice. Only a voice synthesising the words is given pieces. */
    const pieces = engine.baked ? [sayable(unit)] : splitForVoice(sayable(unit));
    const last = pieces.length - 1;
    pieces.forEach((text, part) => {
      engine.speak({
        text, unit, at, part, parts: pieces.length,
        lang: speakLang, voiceURI: speakVoice, rate: speakRate, volume: speakVolume,
        // Every piece spoken is a sign of life, so a long sentence is never mistaken for a dead one.
        onstart: () => { alive(); if (part === 0) onStart(mine, at); },
        onend: () => { alive(); if (part === last) onEnd(mine, at); },
        onerror: reason => fail(mine, reason)
      });
    });
  }
  function onStart(mine, at) {
    // A start for a sentence already passed is iOS repeating itself, not the reader going back.
    if (mine !== generation || at <= entered) return;
    alive();
    entered = at; index = at; status = 'playing'; error = '';
    // The next sentence is queued as this one starts, so the engine runs them together.
    if (at + 1 < list.length && queuedTo < at + 1) enqueue(at + 1, mine);
    emit('sentence');
  }
  function onEnd(mine, at) {
    if (mine !== generation) return;
    alive();
    if (at === stuckAt) { stuckAt = -1; tries = 0; }      // it was said in the end
    if (at + 1 >= list.length) { status = 'done'; watching(false); emit('done'); return; }
    // A sentence that ended without ever starting (iOS drops one now and then): move on.
    if (entered < at + 1 && queuedTo < at + 1) enqueue(at + 1, mine);
  }
  function fail(mine, reason) {
    if (mine !== generation) return;
    generation++; try { engine.cancel(); } catch (_) {}
    watching(false);
    status = 'error'; error = String(reason || 'error'); emit('error');
  }
  function startAt(at) {
    generation++;
    const mine = generation;
    try { engine.cancel(); } catch (_) {}
    if (engine.supportsPause !== false) try { engine.resume(); } catch (_) {}
    index = Math.max(0, Math.min(list.length - 1, at));
    entered = -1; queuedTo = index - 1; status = 'playing'; error = '';
    alive();
    watching(true);
    emit('status');
    enqueue(index, mine);
  }

  const api = {
    load(units, {at = 0} = {}) {
      api.stop();
      list = Array.isArray(units) ? units : [];
      index = Math.max(0, Math.min(list.length ? list.length - 1 : 0, Number(at) || 0));
      status = 'idle'; entered = -1; queuedTo = -1;
      emit('status');
      return state();
    },
    state, units: () => list,
    play(from) { if (!list.length) return state(); startAt(from === undefined ? (status === 'done' ? 0 : index) : from); return state(); },
    pause() {
      if (status !== 'playing') return state();
      if (engine.supportsPause === false) { generation++; try { engine.cancel(); } catch (_) {} queuedTo = index - 1; entered = -1; }
      else try { engine.pause(); } catch (_) {}
      watching(false);
      status = 'paused'; emit('status');
      return state();
    },
    resume() {
      if (status !== 'paused') return state();
      // Safari forgets a paused queue when the screen locks; starting the sentence again is the one reliable way back.
      if (engine.supportsPause === false || entered < 0) { startAt(index); return state(); }
      status = 'playing'; try { engine.resume(); } catch (_) {}
      emit('status');
      return state();
    },
    toggle() { return status === 'playing' ? api.pause() : status === 'paused' ? api.resume() : api.play(); },
    stop() {
      generation++; try { engine.cancel(); } catch (_) {}
      watching(false);
      queuedTo = -1; entered = -1;
      if (status !== 'idle') { status = 'idle'; emit('status'); }
      return state();
    },
    seek(to) {
      if (!list.length) return state();
      const target = Math.max(0, Math.min(list.length - 1, Math.round(Number(to) || 0)));
      if (status === 'playing') { startAt(target); return state(); }
      generation++; try { engine.cancel(); } catch (_) {}
      index = target; entered = -1; queuedTo = -1;
      emit('sentence');
      return state();
    },
    /* Back from somewhere else — another app, a locked screen, a phone call. iOS stops a page's
       own voice when the page goes away and tells it nothing when it returns, so the sentence
       that was being read is started again rather than left hanging. Something that is still
       making a sound is left alone: a baked file plays through all of this, which is what it is
       for. */
    wake() {
      if (status !== 'playing') return state();
      if (engine.speaking && engine.speaking()) { alive(); return state(); }
      revivals++;
      emit('stalled');
      startAt(index);
      return state();
    },
    next() { return api.seek(index + 1); },
    prev() { return api.seek(index - 1); },
    setRate(value) {
      speakRate = clamp(value, RATE_MIN, RATE_MAX, speakRate);
      if (status === 'playing') startAt(index); else emit('settings');
      return speakRate;
    },
    /* Changed while a sentence is being spoken, the sentence starts again: the engine fixed the
       loudness when it took the words, and there is no way to turn one that is already speaking. */
    setVolume(value) {
      const was = speakVolume;
      speakVolume = clamp(value, 0, 1, speakVolume);
      if (speakVolume !== was && status === 'playing') startAt(index); else emit('settings');
      return speakVolume;
    },
    setVoice(uri, language) {
      speakVoice = uri || '';
      if (language) speakLang = language;
      if (status === 'playing') startAt(index); else emit('settings');
      return speakVoice;
    }
  };
  return api;
}

/* The speeds offered. 2× is the top because that is where the engine stops; it is there for a
   second listen and for the parts of a paper nobody needs every word of. */
export const RATES = [0.8, 1, 1.2, 1.5, 1.8, 2];

/* The sections of a paper and where each one starts, for jumping about in a long one. */
export function sectionsOf(units) {
  const out = [];
  (units || []).forEach((unit, index) => {
    const name = unit && unit.section;
    if (name && (!out.length || out[out.length - 1].name !== name)) out.push({name, index});
  });
  return out;
}

/* ---------- a voice that was made earlier ----------
   The Mac reads a paper with Supertonic ahead of time and leaves one audiobook file. That file is
   the same engine contract as speechSynthesis — speak a sentence, say when it starts and when it
   ends — except that nothing is synthesised: the element is moved to where the sentence begins and
   played until it ends. The player above cannot tell the difference, so everything built on it
   (next, previous, the transcript, sleep, carrying on to the next paper) works unchanged.

   iOS keeps an audio element playing with the screen off, which is the whole reason for this.

   `audio` is an HTMLAudioElement (or anything with currentTime, play, pause and timeupdate), and
   `marks` is [{at, seconds}] in the order the units are in. */
export function bakedVoice({audio, marks = [], name = 'baked'} = {}) {
  const list = Array.isArray(marks) ? marks : [];
  /* The queue is what makes this a voice rather than a seek: speechSynthesis takes a sentence and
     says it when the one before it is done, and the player above queues the next sentence the
     moment the current one starts. Without a queue here, each of those would move the element and
     the file would jump to the end. */
  let queue = [], playing = null, epoch = 0, watching = false;

  const endOf = i => {
    const mark = list[i];
    if (!mark) return Infinity;
    const next = list[i + 1];
    // Up to the next sentence, so the pause after this one belongs to it and nothing is clipped.
    return Number.isFinite(Number(next && next.at)) ? Number(next.at) : Number(mark.at) + Number(mark.seconds || 0);
  };
  function finish(how, reason) {
    const done = playing;
    playing = null;
    if (!done) return;
    if (how === 'end') done.onend && done.onend();
    else done.onerror && done.onerror(reason || 'audio-failed');
    pump();
  }
  function pump() {
    if (playing || !queue.length) return;
    const item = queue.shift();
    const mark = list[item.at];
    if (!mark) { item.onerror && item.onerror('no-such-sentence'); pump(); return; }
    playing = {...item, until: endOf(item.at)};
    try {
      audio.playbackRate = item.rate || 1;
      audio.volume = Math.min(1, Math.max(0, Number(item.volume) || 0));
      // A seek of less than a frame is no seek: it would restart the sentence being played.
      if (Math.abs(audio.currentTime - Number(mark.at)) > 0.08) audio.currentTime = Number(mark.at) || 0;
    } catch (_) {}
    const mine = epoch;
    const started = audio.play();
    if (started && typeof started.then === 'function') started.catch(error => { if (mine === epoch) finish('error', String(error && error.name || 'audio-failed')); });
    item.onstart && item.onstart();
  }
  function watch() {
    if (watching) return;
    watching = true;
    audio.addEventListener('timeupdate', () => {
      if (!playing || audio.paused) return;
      if (audio.currentTime >= playing.until - 0.02) finish('end');
    });
    audio.addEventListener('ended', () => finish('end'));
    audio.addEventListener('error', () => finish('error'));
  }

  return {
    name,
    supportsPause: true,
    baked: true,
    available() { return !!audio; },
    voices() { return []; },          // there is one voice in this file and it is already chosen
    speak({at = 0, rate = 1, volume = 1, onstart, onend, onerror}) {
      watch();
      queue.push({at, rate, volume, onstart, onend, onerror});
      pump();
    },
    /* Whether a sound is actually coming out, which is what the player's watchdog is really
       asking. An element that iOS paused while the app was away says so here, and the sentence
       is started again from its mark. */
    speaking() { try { return !!playing && !audio.paused && !audio.ended; } catch (_) { return false; } },
    cancel() { epoch++; queue = []; playing = null; try { audio.pause(); } catch (_) {} },
    pause() { try { audio.pause(); } catch (_) {} },
    resume() { try { const p = audio.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  };
}
