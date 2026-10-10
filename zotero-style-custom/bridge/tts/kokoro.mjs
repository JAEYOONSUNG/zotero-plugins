/* Kokoro 82M (hexgrad) for the Style Custom bridge, run locally through kokoro-js and ONNX Runtime.
   English only, 28 voices, 24 kHz; about two and a half times faster than real time on an Apple Silicon CPU.
   Apache 2.0, model and code. The weights live in this folder's model cache, put there by bridge/install.sh. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ID = 'kokoro';
export const LABEL = 'Kokoro 82M';
export const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const LANGS = ['en'];
export const DEFAULT_VOICE = 'af_heart';
const DTYPE = 'q8';

const cacheDir = (dir = HERE) => path.join(dir, 'models');

export function installed(dir = HERE) {
  try {
    if (!fs.existsSync(path.join(dir, 'node_modules', 'kokoro-js'))) return false;
    const root = path.join(cacheDir(dir), MODEL.replace('/', path.sep));
    return fs.existsSync(root) && fs.readdirSync(path.join(root, 'onnx')).some(name => name.endsWith('.onnx'));
  } catch (_) { return false; }
}

/* kokoro-js takes the speed as a multiplier and returns {audio: Float32Array, sampling_rate}. */
export function create(dir = HERE) {
  let tts = null, loading = null, chain = Promise.resolve();
  async function load() {
    if (tts) return tts;
    if (!loading) loading = (async () => {
      const {env} = await import(path.join(dir, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.mjs'))
        .catch(() => import('@huggingface/transformers'));
      env.cacheDir = cacheDir(dir);
      env.allowRemoteModels = true;
      const {KokoroTTS} = await import(path.join(dir, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js'))
        .catch(() => import('kokoro-js'));
      tts = await KokoroTTS.from_pretrained(MODEL, {dtype: DTYPE, device: 'cpu'});
      return tts;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  async function synth({text, voice, rate = 1}) {
    const engine = await load();
    const id = Object.hasOwn(engine.voices, voice) ? voice : DEFAULT_VOICE;
    const out = await engine.generate(String(text), {voice: id, speed: Math.min(2, Math.max(0.7, Number(rate) || 1))});
    return {samples: out.audio, sampleRate: out.sampling_rate};
  }
  return {
    id: ID, label: LABEL, langs: LANGS, defaultVoice: DEFAULT_VOICE,
    load,
    async voices() {
      const engine = await load();
      return Object.entries(engine.voices).map(([id, v]) => ({id, style: [v.name, v.gender, v.traits].filter(Boolean).join(' · ') || id, lang: 'en'}));
    },
    say(request) { const run = chain.then(() => synth(request)); chain = run.catch(() => {}); return run; }
  };
}
