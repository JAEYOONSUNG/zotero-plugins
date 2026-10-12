/* Reading the paper out loud on the phone.

   The player is a small state machine over the sentences read.js prepared. It never touches the
   DOM or the network: it is given an engine and tells the caller what changed, so the whole of
   it is tested without a phone.

     engine.speak({text, lang, voiceURI, rate, onstart, onend, onerror})
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
    speak({text, lang, voiceURI, rate, onstart, onend, onerror}) {
      const utterance = new Utterance(text);
      utterance.lang = lang || '';
      utterance.rate = rate || 1;
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
export function pickVoice(list, lang = 'en', savedURI = '') {
  const voices = Array.isArray(list) ? list : [];
  if (savedURI) { const kept = voices.find(v => v.voiceURI === savedURI); if (kept) return kept; }
  const code = String(lang).toLowerCase().split(/[-_]/)[0];
  const same = voices.filter(v => String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0] === code);
  if (!same.length) return null;
  const score = v => {
    const both = `${v.name || ''} ${v.voiceURI || ''}`;
    if (NOVELTY.test(v.name || '')) return -100;
    const tier = /premium|siri/i.test(both) ? 3 : /enhanced|neural/i.test(both) ? 2 : 1;
    return tier * 10 + (FAVOURITE[code] && FAVOURITE[code].test(v.name || '') ? 3 : 0) + (v.default ? 1 : 0) + (v.localService ? 0.5 : 0);
  };
  return same.map((v, i) => ({v, i, s: score(v)})).sort((a, b) => b.s - a.s || a.i - b.i)[0].v;
}

/* The language a paper is in, from the sentences themselves. */
export function paperLanguage(units) {
  const sample = (Array.isArray(units) ? units : []).slice(0, 400).map(u => u.spoken || u.text || '').join(' ');
  const hangul = (sample.match(/[가-힣]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return hangul > latin * 0.2 ? 'ko' : 'en';
}

/* ---- the player ---- */
/* How long a sentence should take, so a voice that has gone quiet can be told from a slow one. */
export function spokenSeconds(text, rate = 1) {
  const body = String(text || '');
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const hangul = (body.match(/[가-힣]/g) || []).length;
  return Math.max(1.2, (words / 2.7) + (hangul / 5.5)) / Math.max(0.5, rate);
}

export const WATCH_EVERY = 2500;

export function createPlayer({
  engine, onChange = () => {}, rate = 1, lang = 'en', voiceURI = '',
  now = () => Date.now(),
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = id => clearInterval(id)
} = {}) {
  if (!engine) throw new Error('an engine is required');
  let list = [], index = 0, status = 'idle', generation = 0, queuedTo = -1, entered = -1, error = '';
  let heard = 0, watch = null, revivals = 0;
  let speakRate = clamp(rate, RATE_MIN, RATE_MAX, 1), speakLang = lang || 'en', speakVoice = voiceURI || '';
  const state = () => ({status, index, total: list.length, unit: list[index] || null,
                       rate: speakRate, lang: speakLang, voiceURI: speakVoice, error, revivals});
  const emit = type => { try { onChange({type, state: state()}); } catch (_) {} };
  const alive = () => { heard = now(); };
  const sayable = unit => {
    const spoken = String(unit && unit.spoken || unit && unit.text || '').trim();
    const lead = unit && unit.lead ? String(unit.lead).replace(/[.。]?\s*$/, '. ') : '';
    return (lead + spoken).trim();
  };

  /* iOS drops the speech queue now and then — the screen dims, a notification arrives, or the
     engine simply stops — and says nothing about it, leaving the reader looking at a sentence
     that never finishes. So while it is meant to be playing, a sentence that has had long enough
     to be spoken and has made no sound is started again. */
  function watchdog() {
    if (status !== 'playing') return;
    const due = spokenSeconds(sayable(list[index]), speakRate) * 1000 + 6000;
    if (now() - heard < due) return;
    if (engine.speaking && engine.speaking()) { alive(); return; }
    revivals++;
    emit('stalled');
    startAt(index);
  }
  function watching(on) {
    if (on && !watch) watch = every(watchdog, WATCH_EVERY);
    if (!on && watch) { stopEvery(watch); watch = null; }
  }

  function enqueue(at, mine) {
    const unit = list[at];
    if (!unit) return;
    queuedTo = at;
    engine.speak({
      text: sayable(unit), lang: speakLang, voiceURI: speakVoice, rate: speakRate,
      onstart: () => onStart(mine, at),
      onend: () => onEnd(mine, at),
      onerror: reason => fail(mine, reason)
    });
  }
  function onStart(mine, at) {
    if (mine !== generation || entered === at) return;
    alive();
    entered = at; index = at; status = 'playing'; error = '';
    // The next sentence is queued as this one starts, so the engine runs them together.
    if (at + 1 < list.length && queuedTo < at + 1) enqueue(at + 1, mine);
    emit('sentence');
  }
  function onEnd(mine, at) {
    if (mine !== generation) return;
    alive();
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
    next() { return api.seek(index + 1); },
    prev() { return api.seek(index - 1); },
    setRate(value) {
      speakRate = clamp(value, RATE_MIN, RATE_MAX, speakRate);
      if (status === 'playing') startAt(index); else emit('settings');
      return speakRate;
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

export const RATES = [0.8, 1, 1.2, 1.5, 1.8];

/* The sections of a paper and where each one starts, for jumping about in a long one. */
export function sectionsOf(units) {
  const out = [];
  (units || []).forEach((unit, index) => {
    const name = unit && unit.section;
    if (name && (!out.length || out[out.length - 1].name !== name)) out.push({name, index});
  });
  return out;
}
