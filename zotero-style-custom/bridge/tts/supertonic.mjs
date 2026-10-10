/* Supertonic 3 (Supertone) for the Style Custom bridge, run locally with
   ONNX Runtime. 31 languages, ten voices, 44.1 kHz; about six times faster than real time on an Apple
   Silicon CPU, so the next sentence is ready before the current one ends.

   This file and supertonic-helper.mjs are copied by bridge/install.sh into
   ~/Library/Application Support/StyleCustomBridge/tts/, next to the onnxruntime-node package and the
   model (assets/onnx, assets/voice_styles). Nothing here touches the network: text in, WAV out. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ID = 'supertonic';
export const LABEL = 'Supertonic 3';
export const VOICES = {
  F1: 'calm, low', F2: 'bright', F3: 'clear narrator', F4: 'crisp', F5: 'soft',
  M1: 'upbeat', M2: 'deep, steady', M3: 'authoritative', M4: 'friendly', M5: 'warm narrator'
};
export const DEFAULT_VOICE = 'F3';
export const LANGS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi'];
const STEPS = 10;            // denoising steps: 8 is the example's default, more is cleaner and slower
const SPEED = 1.05;          // the model's own "normal"

export function installed(dir = HERE) {
  const need = ['assets/onnx/tts.json', 'assets/onnx/vector_estimator.onnx', 'assets/onnx/vocoder.onnx', 'assets/voice_styles/F3.json', 'node_modules/onnxruntime-node'];
  return need.every(rel => fs.existsSync(path.join(dir, rel)));
}

export function clampSpeed(rate) {
  const n = Number(rate);
  return Math.min(2, Math.max(0.7, (Number.isFinite(n) && n > 0 ? n : 1) * SPEED));
}

/* load() once (about a second: four ONNX sessions), then say() one piece at a time; calls are serialised
   because one ONNX session is not meant to run two inferences at once. */
export function create(dir = HERE) {
  let engine = null, loading = null, chain = Promise.resolve();
  const styles = new Map();
  async function load() {
    if (engine) return engine;
    if (!loading) loading = (async () => {
      const helper = await import(path.join(dir, 'supertonic-helper.mjs'));
      const tts = await helper.loadTextToSpeech(path.join(dir, 'assets', 'onnx'), false);
      engine = {helper, tts};
      return engine;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  function style(helper, voice) {
    const id = Object.hasOwn(VOICES, voice) ? voice : DEFAULT_VOICE;
    if (!styles.has(id)) styles.set(id, helper.loadVoiceStyle([path.join(dir, 'assets', 'voice_styles', id + '.json')]));
    return styles.get(id);
  }
  async function synth({text, lang = 'en', voice, rate = 1}) {
    const {helper, tts} = await load();
    const code = LANGS.includes(lang) ? lang : 'na';
    const {wav: samples, duration} = await tts.call(String(text), code, style(helper, voice), STEPS, clampSpeed(rate));
    const length = Math.min(samples.length, Math.floor(tts.sampleRate * duration[0]));
    return {samples: samples.slice(0, length), sampleRate: tts.sampleRate};
  }
  return {
    id: ID, label: LABEL, langs: LANGS, defaultVoice: DEFAULT_VOICE,
    load,
    async voices() { return Object.entries(VOICES).map(([id, style]) => ({id, style})); },
    say(request) { const run = chain.then(() => synth(request)); chain = run.catch(() => {}); return run; },
    get ready() { return !!engine; }
  };
}
