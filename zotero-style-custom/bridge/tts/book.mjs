/* A whole paper, baked into one audiobook file on this Mac.

   The read-aloud voices (bridge/tts/speech.mjs) make one sentence at a time, which is what a reader
   needs. A drive needs the opposite: the whole paper, finished, in a file the phone can play with the
   screen off. iOS stops a web page's voice when the screen locks; it does not stop an audio file. So
   the Mac synthesises the paper ahead of time at six times real speed, and what lands in the sync
   folder is an ordinary m4b audiobook -- lock screen, car buttons, AirPods, remembered position.

   Baking an hour of speech takes about ten minutes and 300 MB of scratch WAV, so a bake is a job:
   POST starts it, GET follows it, and the samples go to disk as they are made, never all into memory.

   The pure parts (splitting, timeline, names, mp4 tags) are exported for the tests; createBaker() is
   the part that touches the disk and the model. Nothing here touches the network. */
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* One request to the speech model. Supertonic's own cap is higher, but a piece this size keeps each
   inference short enough that a cancel is felt at once, and intonation is decided per piece. */
export const MAX_PIECE = 700;
export const GAP_SENTENCE = 0.18;     // seconds of silence between sentences
export const GAP_CHAPTER = 0.9;       // and between sections, so a heading lands
export const BITRATE = 64000;         // AAC-LC mono: a paper hour is about 29 MB

/* ---------- text ---------- */

/* Sentence ends, with the usual academic traps left alone: "et al.", "Fig. 3", "e.g.", initials,
   decimals and a citation's closing bracket after the stop. */
const ABBREV = /\b(?:et al|e\.g|i\.e|cf|vs|approx|ca|Fig|Figs|Eq|Eqs|Tab|Ref|Refs|No|vol|pp|ed|eds|Dr|Prof|Mr|Mrs|Ms|St|Inc|Ltd|Co|Jr|Sr|[A-Z])\.$/;

export function splitSentences(text) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out = [];
  let from = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '。' && ch !== '！' && ch !== '？') continue;
    let end = i + 1;
    while (end < clean.length && /[)\]'"’”]/.test(clean[end])) end++;
    if (end < clean.length && clean[end] !== ' ') continue;          // 3.14, www.x.org
    const head = clean.slice(from, end);
    if (ABBREV.test(head)) continue;                                  // et al. -- the sentence goes on
    const piece = head.trim();
    if (piece) out.push(piece);
    from = end;
  }
  const tail = clean.slice(from).trim();
  if (tail) out.push(tail);
  return out;
}

/* A sentence longer than the model's piece size is cut at a comma, a semicolon or a space -- never
   mid-word, and never into a scrap too short to carry intonation. */
export function breakLong(text, limit = MAX_PIECE) {
  const whole = String(text == null ? '' : text).trim();
  if (whole.length <= limit) return whole ? [whole] : [];
  const out = [];
  let rest = whole;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let at = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '));
    if (at < limit * 0.4) at = window.lastIndexOf(' ');
    if (at < limit * 0.4) at = limit - 1;                             // one unbroken run: cut it at the limit
    out.push(rest.slice(0, at + 1).trim());
    rest = rest.slice(at + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/* chapters: [{title, text}] -> the pieces to synthesise, in order, each knowing its chapter and
   whether a sentence ended with it (so the gaps go in the right places). A chapter's title is spoken
   first, as its own piece, which is also what the chapter mark points at. */
export function plan(chapters, limit = MAX_PIECE) {
  const out = [];
  (Array.isArray(chapters) ? chapters : []).forEach((chapter, index) => {
    const title = String(chapter && chapter.title || '').replace(/\s+/g, ' ').trim();
    const sentences = splitSentences(chapter && chapter.text);
    if (!title && !sentences.length) return;
    const opens = out.length;
    if (title) out.push({chapter: index, text: title, heading: true, ends: true, head: true});
    for (const sentence of sentences) {
      const parts = breakLong(sentence, limit);
      parts.forEach((text, i) => out.push({chapter: index, text, ends: i === parts.length - 1, head: !title && out.length === opens}));
    }
  });
  return out;
}

/* Where each piece and each chapter begins, given how long each piece turned out. The gap that
   follows a piece belongs to the piece, so a chapter starts the moment its heading does. */
export function timeline(pieces, seconds, {sentence = GAP_SENTENCE, chapter = GAP_CHAPTER} = {}) {
  const marks = [], chapters = [];
  let at = 0;
  pieces.forEach((piece, i) => {
    const length = Number(seconds[i]) || 0;
    if (piece.head) chapters.push({chapter: piece.chapter, at: Number(at.toFixed(3)), title: piece.heading ? piece.text : ''});
    marks.push({at: Number(at.toFixed(3)), seconds: Number(length.toFixed(3)), chapter: piece.chapter, text: piece.text});
    const next = pieces[i + 1];
    at += length + (!next ? 0 : next.chapter !== piece.chapter ? chapter : piece.ends ? sentence : 0);
  });
  return {total: Number(at.toFixed(3)), marks, chapters};
}

/* ---------- the file on disk ---------- */

/* A title that survives a sync folder: no slashes or colons, no leading dot, not endless. */
export function safeName(title, limit = 90) {
  const one = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  const safe = one.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');
  if (!safe) return '논문';
  return safe.length <= limit ? safe : safe.slice(0, limit).replace(/\s+\S*$/, '') || safe.slice(0, limit);
}

/* A name no file in `taken` already has. */
export function freeName(base, extension, taken = () => false) {
  for (let n = 0; n < 500; n++) {
    const name = (n ? `${base} (${n + 1})` : base) + extension;
    if (!taken(name)) return name;
  }
  return `${base} ${Date.now()}${extension}`;
}

/* ---------- WAV ---------- */

export function wavHeader(bytes, sampleRate, channels = 1) {
  const out = Buffer.alloc(44);
  out.write('RIFF', 0); out.writeUInt32LE(36 + bytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2 * channels, 28);
  out.writeUInt16LE(2 * channels, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(bytes, 40);
  return out;
}

/* The samples out of a WAV the voices made, as 16-bit little-endian PCM, whatever order its chunks
   came in. */
export function pcmOf(wav) {
  const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a WAV');
  let at = 12, rate = 0, bits = 16, data = null;
  while (at + 8 <= buf.length) {
    const type = buf.toString('latin1', at, at + 4), size = buf.readUInt32LE(at + 4), body = at + 8;
    if (type === 'fmt ' && body + 16 <= buf.length) { rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
    if (type === 'data') data = buf.subarray(body, Math.min(buf.length, body + size));
    at = body + size + (size % 2);
  }
  if (!data || !data.length || !rate) throw new Error('WAV has no samples');
  if (bits !== 16) throw new Error(`WAV is ${bits}-bit`);
  return {pcm: data, sampleRate: rate};
}

/* ---- level and edges ----
   Two things make a baked paper hard to listen to in a car. The model leaves a little silence at the
   head and tail of every piece, which stacks up into a gap after every sentence; and it speaks each
   piece at whatever level that sentence came out at, so one paper is loud and the next is faint. A
   phone cannot play louder than its own volume, so the only way to be heard over an engine is for the
   file itself to be as loud as it can be without clipping. */

export const QUIET = 0.012;            // below this a sample is silence (−38 dBFS)
export const EDGE_KEEP = 0.04;         // seconds of the quiet left at each end, so nothing is clipped off
export const PEAK = 0.89;              // where the loudest sample of the paper is allowed to land
export const LOUDEST_LIFT = 12;        // never lift a paper by more than this, or a breath becomes a roar
/* What a paper should sound like, rather than what its single loudest sample is. Speech sits far
   below its peaks: a paper measured at -23 dBFS RMS could only be lifted 1.22x by the peak rule,
   which is not enough to hear over an engine. The level is taken from the whole paper's RMS instead,
   aimed at about -18 dBFS, and the few samples that would go over the top are rounded off by the
   knee below rather than being allowed to limit the whole file. */
export const TARGET_RMS = 0.126;       // -18 dBFS
export const KNEE = 0.80;              // below this nothing is touched at all

/* Where the speech in this piece starts and ends, in samples. */
export function speechEdges(pcm, {quiet = QUIET} = {}) {
  const count = Math.floor(pcm.length / 2), cut = Math.round(quiet * 32767);
  let from = 0, to = count;
  while (from < count && Math.abs(pcm.readInt16LE(from * 2)) <= cut) from++;
  while (to > from && Math.abs(pcm.readInt16LE((to - 1) * 2)) <= cut) to--;
  return {from, to};
}

/* The piece with its silent head and tail taken off, bar a little, so sentences follow each other at
   the distance the timeline says and not at twice it. A piece that is silence all through is dropped. */
export function trimEdges(pcm, sampleRate, {quiet = QUIET, keep = EDGE_KEEP} = {}) {
  const {from, to} = speechEdges(pcm, {quiet});
  if (from >= to) return pcm.subarray(0, 0);
  const pad = Math.round(keep * sampleRate);
  const start = Math.max(0, from - pad), end = Math.min(Math.floor(pcm.length / 2), to + pad);
  return pcm.subarray(start * 2, end * 2);
}

/* The loudest sample in a piece, 0..1. */
export function peakOf(pcm) {
  let top = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) { const v = Math.abs(pcm.readInt16LE(i)); if (v > top) top = v; }
  return top / 32767;
}

/* The peak rule: what every sample is multiplied by so the loudest moment lands at PEAK. */
export function gainFor(peak, {target = PEAK, limit = LOUDEST_LIFT} = {}) {
  if (!(peak > 0)) return 1;
  return Math.min(limit, target / peak);
}

/* One number for the whole paper, from how loud it actually sounds. The peak rule is kept as a
   floor -- a paper whose peaks are already low is lifted at least that far -- and the louder of the
   two is taken, because the knee can carry what goes over. The quiet sentences stay quieter than
   the loud ones either way: this is one multiplication for the whole file, never per sentence. */
export function loudnessGain({rms = 0, peak = 0} = {}, {target = TARGET_RMS, limit = LOUDEST_LIFT} = {}) {
  const byPeak = gainFor(peak, {limit});
  if (!(rms > 0)) return byPeak;
  return Math.min(limit, Math.max(byPeak, target / rms));
}

/* Above the knee a sample is rounded off towards the ceiling instead of being cut square at it:
   a hard edge is heard as a click, a curve is not heard at all. Below the knee nothing changes. */
export function soften(x, knee = KNEE) {
  const sign = x < 0 ? -1 : 1, a = Math.abs(x);
  if (a <= knee) return x;
  const over = (a - knee) / (1 - knee);
  return sign * (knee + (1 - knee) * Math.tanh(over));
}

/* In place: every sample scaled, rounded off at the top, and held inside the range whatever
   arithmetic says, so nothing can wrap to the opposite sign. */
export function applyGain(pcm, gain, {knee = KNEE} = {}) {
  if (gain === 1) return pcm;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const scaled = (pcm.readInt16LE(i) / 32768) * gain;
    const v = Math.round(soften(scaled, knee) * 32767);
    pcm.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
  return pcm;
}

export function silence(seconds, sampleRate) {
  const samples = Math.max(0, Math.round((Number(seconds) || 0) * sampleRate));
  return Buffer.alloc(samples * 2);
}

/* ---------- mp4 tags ---------- */
/* afconvert writes the audio but no names, so the file would show up in Books as "out". These are the
   iTunes metadata atoms, written by hand: moov/udta/meta/ilst. Inserting bytes into moov moves
   everything after it, so every chunk offset that pointed past moov is corrected -- without that the
   file plays silence. */

const TEXT_TAGS = [['title', '\xa9nam'], ['artist', '\xa9ART'], ['album', '\xa9alb'], ['albumArtist', 'aART'],
  ['genre', '\xa9gen'], ['year', '\xa9day'], ['comment', '\xa9cmt'], ['description', 'desc'], ['grouping', '\xa9grp']];

function atom(type, ...bodies) {
  const body = Buffer.concat(bodies.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function dataAtom(flag, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(flag, 0);      // version 0 + flags: 1 = UTF-8, 21 = integer
  return atom('data', head, payload);
}

/* {title, artist, album, genre, year, comment, description, audiobook, track:[n,of]} -> the ilst atom */
export function ilst(tags = {}) {
  const items = [];
  for (const [key, type] of TEXT_TAGS) {
    const value = tags[key];
    if (value === undefined || value === null || value === '') continue;
    items.push(atom(type, dataAtom(1, Buffer.from(String(value), 'utf8'))));
  }
  if (tags.audiobook) items.push(atom('stik', dataAtom(21, Buffer.from([2]))));   // 2 = audiobook
  if (Array.isArray(tags.track) && tags.track[0]) {
    const body = Buffer.alloc(8);
    body.writeUInt16BE(Number(tags.track[0]) || 0, 2);
    body.writeUInt16BE(Number(tags.track[1]) || 0, 4);
    items.push(atom('trkn', dataAtom(0, body)));
  }
  return atom('ilst', ...items);
}

/* Nero-style chapter list (moov/udta/chpl): one entry per section, so the car's skip button and Books'
   chapter list move by section instead of by whole paper. Times are in 100-nanosecond units.
   This is the list every player that reads chapters at all reads; a QuickTime chapter *track* would
   need its own trak, and nothing on a phone asks for one. */
export function chpl(chapters = []) {
  const rows = (Array.isArray(chapters) ? chapters : [])
    .filter(c => c && Number.isFinite(Number(c.at)) && Number(c.at) >= 0)
    .slice(0, 255);
  const head = Buffer.alloc(9);
  head.writeUInt32BE(0x01000000, 0);          // version 1, flags 0
  head.writeUInt32BE(0, 4);                   // reserved
  head.writeUInt8(rows.length, 8);
  const body = rows.map((c, i) => {
    const name = Buffer.from(String(c.title || `${i + 1}`).slice(0, 80), 'utf8').subarray(0, 255);
    const row = Buffer.alloc(9 + name.length);
    row.writeBigUInt64BE(BigInt(Math.round(Number(c.at) * 1e7)), 0);
    row.writeUInt8(name.length, 8);
    name.copy(row, 9);
    return row;
  });
  return atom('chpl', head, ...body);
}

function metaAtom(tags) {
  const hdlr = atom('hdlr', Buffer.alloc(8), Buffer.from('mdirappl', 'latin1'), Buffer.alloc(9));
  return atom('meta', Buffer.alloc(4), hdlr, ilst(tags));
}

/* The atoms directly inside [from, to) of buf. */
function children(buf, from, to) {
  const out = [];
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let body = at + 8;
    if (size === 1) { if (at + 16 > to) break; size = Number(buf.readBigUInt64BE(at + 8)); body = at + 16; }
    else if (size === 0) size = to - at;
    if (size < 8 || at + size > to) break;
    out.push({type, start: at, end: at + size, body, bodyEnd: at + size});
    at += size;
  }
  return out;
}

const find = (list, type) => list.find(a => a.type === type) || null;

/* Every chunk offset in this moov that points at or past `moved`, shifted by `delta`. */
function shiftOffsets(moov, moved, delta) {
  if (!delta) return;
  const walk = (from, to, depth) => {
    for (const a of children(moov, from, to)) {
      if (a.type === 'stco' || a.type === 'co64') {
        const count = moov.readUInt32BE(a.body + 4), wide = a.type === 'co64';
        for (let i = 0; i < count; i++) {
          const at = a.body + 8 + i * (wide ? 8 : 4);
          if (at + (wide ? 8 : 4) > a.bodyEnd) break;
          if (wide) { const v = moov.readBigUInt64BE(at); if (v >= BigInt(moved)) moov.writeBigUInt64BE(v + BigInt(delta), at); }
          else { const v = moov.readUInt32BE(at); if (v >= moved) moov.writeUInt32BE(v + delta, at); }
        }
      } else if (depth < 6 && ['trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'].includes(a.type)) walk(a.body, a.bodyEnd, depth + 1);
    }
  };
  walk(8, moov.length, 0);
}

/* The same m4a with iTunes names on it. Anything unexpected throws, and the caller keeps the plain
   file: a paper that plays under a dull name beats no paper. */
export function withTags(m4a, tags = {}, chapters = null) {
  const buf = Buffer.isBuffer(m4a) ? m4a : Buffer.from(m4a);
  const top = children(buf, 0, buf.length);
  const moov = find(top, 'moov');
  if (!moov) throw new Error('no moov');
  const inside = children(buf, moov.body, moov.bodyEnd);
  const udta = find(inside, 'udta');
  const meta = metaAtom(tags);
  const marks = chapters && chapters.length ? chpl(chapters) : null;
  const added = marks ? Buffer.concat([meta, marks]) : meta;

  let body;                                                    // the new moov body
  if (!udta) body = Buffer.concat([buf.subarray(moov.body, moov.bodyEnd), atom('udta', added)]);
  else {
    const inUdta = children(buf, udta.body, udta.bodyEnd);
    /* Whatever was there before is replaced, never stacked: tagging twice leaves one meta and one chpl. */
    const drop = [find(inUdta, 'meta'), find(inUdta, 'chpl')].filter(Boolean).sort((a, b) => a.start - b.start);
    const parts = [];
    let at = udta.body;
    for (const gone of drop) { parts.push(buf.subarray(at, gone.start)); at = gone.end; }
    parts.push(buf.subarray(at, udta.bodyEnd), added);
    body = Buffer.concat([buf.subarray(moov.body, udta.start), atom('udta', Buffer.concat(parts)), buf.subarray(udta.end, moov.bodyEnd)]);
  }

  const built = atom('moov', body);
  const delta = built.length - (moov.end - moov.start);
  shiftOffsets(built, moov.end, delta);                        // data that sat after moov has moved
  return Buffer.concat([buf.subarray(0, moov.start), built, buf.subarray(moov.end)]);
}

/* ---------- the bake ---------- */

export const STATES = ['waiting', 'speaking', 'encoding', 'done', 'failed', 'cancelled'];

/* afconvert is part of macOS, so a bake needs nothing installed. Mono AAC-LC at 64 kbps. */
export function encodeArgs(wav, out, {bitrate = BITRATE} = {}) {
  return ['-f', 'm4af', '-d', 'aac', '-b', String(bitrate), '-q', '127', '-s', '2', wav, out];
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, {stdio: ['ignore', 'ignore', 'pipe']}); }
    catch (error) { return reject(error); }
    let noise = '';
    child.stderr.on('data', piece => { noise = (noise + piece).slice(-400); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}${noise ? ': ' + noise.trim() : ''}`)));
  });
}

/* One bake at a time (the model is one ONNX session), a short queue behind it, and a job record the
   plugin can poll. `speech` is bridge/tts/speech.mjs's engine: say() -> {audio: WAV, seconds}. */
export function createBaker({speech, outDir, tmpDir, afconvert = '/usr/bin/afconvert', keep = 40, maxQueue = 8, now = Date.now, log = () => {}}) {
  const jobs = new Map();
  let running = null;
  const order = [];
  /* Nothing in the scratch folder can belong to this process yet, so whatever a killed bake left is swept. */
  try { for (const name of fs.readdirSync(tmpDir)) if (/^bake-[0-9a-f]+\.(wav|m4a)$/.test(name)) fs.unlinkSync(path.join(tmpDir, name)); } catch (_) {}

  const view = job => ({
    id: job.id, state: job.state, title: job.title, done: job.done, total: job.total,
    ahead: job.state === 'waiting' ? order.map(id => jobs.get(id)).filter(other => other && other.state === 'waiting' && order.indexOf(other.id) < order.indexOf(job.id)).length + (running ? 1 : 0) : 0,
    seconds: Number(job.seconds.toFixed(1)), file: job.file, bytes: job.bytes, gain: job.gain, rms: job.rms, error: job.error,
    started: job.started, finished: job.finished
  });

  function forget() {
    while (order.length > keep) {
      const id = order.shift();
      const job = jobs.get(id);
      if (job && (job.state === 'speaking' || job.state === 'encoding' || job.state === 'waiting')) { order.push(id); return; }
      jobs.delete(id);
    }
  }

  async function bake(job) {
    const stem = path.join(tmpDir, `bake-${job.id}`);
    const wavPath = `${stem}.wav`;
    const m4aPath = `${stem}.m4a`;
    let bytes = 0, rate = 0, loudest = 0, energy = 0, counted = 0;
    const out = fs.createWriteStream(wavPath);
    const write = piece => new Promise((resolve, reject) => out.write(piece, error => error ? reject(error) : resolve()));
    try {
      fs.mkdirSync(tmpDir, {recursive: true, mode: 0o700});
      await write(Buffer.alloc(44));                                     // the header, filled in at the end
      const lengths = [];
      for (let i = 0; i < job.pieces.length; i++) {
        if (job.cancelled) throw Object.assign(new Error('cancelled'), {cancelled: true});
        const piece = job.pieces[i];
        const said = await speech.say({model: job.model, text: piece.text, lang: job.lang, voice: job.voice, rate: job.rate});
        const said2 = pcmOf(said.audio), sampleRate = said2.sampleRate;
        if (!rate) rate = sampleRate;
        else if (sampleRate !== rate) throw new Error('the voice changed its sample rate mid-paper');
        const pcm = job.trim === false ? said2.pcm : trimEdges(said2.pcm, rate);
        if (!pcm.length) { lengths.push(0); job.done = i + 1; continue; }   // the model said nothing
        const peak = peakOf(pcm);
        if (peak > loudest) loudest = peak;
        for (let b = 0; b + 1 < pcm.length; b += 2) { const v = pcm.readInt16LE(b) / 32768; energy += v * v; }
        counted += pcm.length / 2;
        await write(pcm);
        bytes += pcm.length;
        lengths.push(pcm.length / 2 / rate);
        const next = job.pieces[i + 1];
        const gap = !next ? 0 : next.chapter !== piece.chapter ? GAP_CHAPTER : piece.ends ? GAP_SENTENCE : 0;
        if (gap) { const quiet = silence(gap, rate); await write(quiet); bytes += quiet.length; }
        job.done = i + 1;
        job.seconds = lengths.reduce((a, b) => a + b, 0);
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
      if (!rate) throw new Error('nothing to say');

      const handle = await fs.promises.open(wavPath, 'r+');
      try {
        await handle.write(wavHeader(bytes, rate), 0, 44, 0);
        /* One pass to bring the paper up to a level a car can be heard over. The gain comes from the
           paper's own loudest moment, so the quiet sentences stay quieter than the loud ones. */
        const rms = counted ? Math.sqrt(energy / counted) : 0;
        const gain = job.level === false ? 1 : loudnessGain({rms, peak: loudest});
        job.rms = Number(rms.toFixed(4));
        job.gain = Number(gain.toFixed(3));
        if (gain !== 1) {
          const slab = Buffer.alloc(1 << 20);
          for (let at = 44; at < 44 + bytes;) {
            const want = Math.min(slab.length, 44 + bytes - at);
            const {bytesRead} = await handle.read(slab, 0, want - (want % 2), at);
            if (!bytesRead) break;
            const part = slab.subarray(0, bytesRead);
            applyGain(part, gain);
            await handle.write(part, 0, bytesRead, at);
            at += bytesRead;
          }
        }
      } finally { await handle.close(); }

      job.state = 'encoding';
      if (job.cancelled) throw Object.assign(new Error('cancelled'), {cancelled: true});
      await run(afconvert, encodeArgs(wavPath, m4aPath, {bitrate: job.bitrate}));

      const timed = timeline(job.pieces, lengths);
      job.seconds = timed.total;
      let audio = await fs.promises.readFile(m4aPath);
      try { audio = withTags(audio, {...job.tags, comment: job.tags.comment || `Supertonic ${job.voice || ''}`.trim(), audiobook: true}, timed.chapters); }
      catch (error) { log({bake: job.id, tags: String(error && error.message || error).slice(0, 80)}); }

      fs.mkdirSync(outDir, {recursive: true});
      const name = freeName(safeName(job.title), '.m4b', file => fs.existsSync(path.join(outDir, file)));
      const final = path.join(outDir, name);
      await fs.promises.writeFile(final, audio);
      await fs.promises.writeFile(final.replace(/\.m4b$/, '.json'), JSON.stringify({
        title: job.title, voice: job.voice, model: job.model, lang: job.lang, rate: job.rate,
        seconds: timed.total, made: new Date(now()).toISOString(), audio: name,
        chapters: timed.chapters, marks: job.marks ? timed.marks : undefined
      }, null, 1) + '\n');
      job.file = final;
      job.bytes = audio.length;
      job.state = 'done';
    } catch (error) {
      try { out.destroy(); } catch (_) {}
      job.state = error && error.cancelled ? 'cancelled' : 'failed';
      if (job.state === 'failed') job.error = String(error && error.message || error).slice(0, 200);
    } finally {
      job.finished = now();
      for (const file of [wavPath, m4aPath]) fs.promises.unlink(file).catch(() => {});
      log({bake: job.id, state: job.state, pieces: job.pieces.length, done: job.done, seconds: Math.round(job.seconds), ms: job.finished - job.started});
      running = null;
      pump();
    }
  }

  function pump() {
    if (running) return;
    const next = order.map(id => jobs.get(id)).find(job => job && job.state === 'waiting' && !job.cancelled);
    if (!next) return;
    running = next;
    next.started = now();
    next.state = 'speaking';
    bake(next);
  }

  /* What is already in the folder for this title: the first file of its name, with when it was made. */
  function made(title) {
    const base = safeName(title);
    let names = [];
    try { names = fs.readdirSync(outDir); } catch (_) { return null; }
    const mine = names.filter(n => n === base + '.m4b' || n.startsWith(base + ' (') && n.endsWith(').m4b')).sort();
    if (!mine.length) return null;
    const out = [];
    for (const name of mine) {
      try { const st = fs.statSync(path.join(outDir, name)); out.push({file: path.join(outDir, name), name, bytes: st.size, at: st.mtimeMs}); } catch (_) {}
    }
    if (!out.length) return null;
    out.sort((a, b) => b.at - a.at);
    return {...out[0], copies: out.length};
  }

  return {
    made,
    /* {title, chapters:[{title,text}], lang, voice, model, rate, tags, marks} -> the job, already queued */
    start(request = {}) {
      const waiting = order.map(id => jobs.get(id)).filter(job => job && job.state === 'waiting').length;
      if (waiting >= maxQueue) throw Object.assign(new Error('too many papers are already waiting'), {status: 429});
      const pieces = plan(request.chapters, MAX_PIECE);
      if (!pieces.length) throw Object.assign(new Error('nothing to say'), {status: 400});
      const title = String(request.title || '').trim() || '논문';
      const job = {
        id: crypto.randomBytes(8).toString('hex'), state: 'waiting', title, pieces,
        lang: String(request.lang || 'en').toLowerCase().split(/[-_]/)[0],
        voice: String(request.voice || ''), model: String(request.model || ''),
        rate: Number(request.rate) > 0 ? Number(request.rate) : 1,
        bitrate: Number(request.bitrate) > 0 ? Number(request.bitrate) : BITRATE,
        marks: request.marks !== false, trim: request.trim !== false, level: request.level !== false, gain: 1, rms: 0,
        tags: {title, ...(request.tags || {})},
        done: 0, total: pieces.length, seconds: 0, file: null, bytes: 0, error: null,
        started: 0, finished: 0, cancelled: false
      };
      jobs.set(job.id, job);
      order.push(job.id);
      forget();
      pump();
      return view(job);
    },
    get(id) { const job = jobs.get(String(id)); return job ? view(job) : null; },
    list() { return order.map(id => jobs.get(id)).filter(Boolean).map(view).reverse(); },
    cancel(id) {
      const job = jobs.get(String(id));
      if (!job) return null;
      if (job.state === 'waiting') { job.state = 'cancelled'; job.finished = now(); }
      job.cancelled = true;
      return view(job);
    },
    get busy() { return !!running; },
    get out() { return outDir; }
  };
}
