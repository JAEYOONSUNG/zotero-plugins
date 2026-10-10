/* Natural read-aloud voices for the Style Custom bridge: several text-to-speech models, all running on this
   Mac, behind one list. Nothing here touches the network at speaking time: text in, WAV out.

   Each model is a module with `installed(dir)` and `create(dir)`; what create() returns answers
   `voices()` and `say({text, lang, voice, rate}) -> {samples: Float32Array|number[], sampleRate}`.
   bridge/install.sh copies these files, the models and their packages into
   ~/Library/Application Support/StyleCustomBridge/tts/. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = ['supertonic.mjs', 'kokoro.mjs'];

/* 16-bit mono PCM. */
export function wav(samples, sampleRate) {
  const data = samples.length * 2, out = Buffer.alloc(44 + data);
  out.write('RIFF', 0); out.writeUInt32LE(36 + data, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}

/* The models this install has, in the order they are offered. */
export async function models(dir = HERE) {
  const out = [];
  for (const file of MODULES) {
    let mod;
    try { mod = await import(path.join(dir, file)); } catch (_) { continue; }
    if (typeof mod.installed !== 'function' || !mod.installed(dir)) continue;
    out.push(mod);
  }
  return out;
}

export async function installed(dir = HERE) {
  return (await models(dir)).length > 0;
}

/* One engine per model, made when first asked for and then kept. Calls to one model are serialised: an ONNX
   session is not meant to run two inferences at once. */
export function create(dir = HERE) {
  const made = new Map();
  let listing = null;
  async function engineFor(id) {
    if (made.has(id)) return made.get(id);
    const mod = (await models(dir)).find(m => m.ID === id) || (await models(dir))[0];
    if (!mod) return null;
    if (!made.has(mod.ID)) made.set(mod.ID, mod.create(dir));
    return made.get(mod.ID);
  }
  return {
    /* [{id, label, langs, default, voices: [{id, style, lang?}]}] */
    async list() {
      if (listing) return listing;
      const out = [];
      for (const mod of await models(dir)) {
        const engine = await engineFor(mod.ID);
        if (!engine) continue;
        let voices = [];
        try { voices = await engine.voices(); } catch (_) { continue; }
        out.push({id: mod.ID, label: mod.LABEL, langs: mod.LANGS, default: mod.DEFAULT_VOICE, voices});
      }
      listing = out;
      return out;
    },
    /* Load every model now, so the first sentence a reader asks for does not also wait for the weights. */
    async warm() { for (const mod of await models(dir)) { const e = await engineFor(mod.ID); if (e && e.load) await e.load(); } },
    async say({model, text, lang = 'en', voice = '', rate = 1}) {
      const engine = await engineFor(model);
      if (!engine) throw new Error('no speech model is installed');
      const {samples, sampleRate} = await engine.say({text, lang, voice, rate});
      return {audio: wav(samples, sampleRate), seconds: samples.length / sampleRate};
    }
  };
}
