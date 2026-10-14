import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from '../bridge/tts/book.mjs';

/* A voice that costs nothing: every piece becomes a WAV of a length that follows from its text, so a
   test can say exactly where each sentence should land on the timeline. */
function fakeVoice({rate = 1000, perChar = 0.01, fail = null} = {}) {
  const said = [];
  return {
    said,
    async say({text, lang, voice, rate: speed}) {
      said.push({text, lang, voice, speed});
      if (fail && fail(text)) throw new Error('the voice gave up');
      const samples = Math.max(1, Math.round(text.length * perChar * rate));
      const pcm = Buffer.alloc(samples * 2, 7);
      return {audio: Buffer.concat([B.wavHeader(pcm.length, rate), pcm]), seconds: samples / rate};
    }
  };
}

/* Stands in for afconvert: whatever it is handed becomes the output, so the bake runs end to end
   without an encoder. `kind` picks what comes out. */
function fakeEncoder(dir, {kind = 'copy', code = 0} = {}) {
  const bin = path.join(dir, 'fake-afconvert');
  const body = kind === 'copy'
    ? 'cp "${@: -2:1}" "${@: -1}"'
    : kind === 'm4a' ? `cp ${JSON.stringify(path.join(dir, 'fixture.m4a'))} "\${@: -1}"` : 'echo "no" >&2';
  fs.writeFileSync(bin, `#!/bin/bash\n${body}\nexit ${code}\n`, {mode: 0o755});
  return bin;
}

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bake-test-'));

async function settle(baker, id, limit = 4000) {
  const until = Date.now() + limit;
  for (;;) {
    const job = baker.get(id);
    if (['done', 'failed', 'cancelled'].includes(job.state)) return job;
    if (Date.now() > until) throw new Error(`bake stuck in ${job.state}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

/* ---------- splitting ---------- */

test('sentences end where a reader would stop, not at every full stop', () => {
  assert.deepEqual(B.splitSentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  // The traps a paper is full of: an author list, a figure, a decimal, a URL, a citation bracket.
  assert.deepEqual(B.splitSentences('As Kim et al. showed, it holds.'), ['As Kim et al. showed, it holds.']);
  assert.deepEqual(B.splitSentences('See Fig. 3 for the fit.'), ['See Fig. 3 for the fit.']);
  assert.deepEqual(B.splitSentences('The yield was 3.14 g.'), ['The yield was 3.14 g.']);
  assert.deepEqual(B.splitSentences('Hosted at www.example.org today.'), ['Hosted at www.example.org today.']);
  assert.deepEqual(B.splitSentences('It holds (Kim, 2020.) Next one.'), ['It holds (Kim, 2020.)', 'Next one.']);
  assert.deepEqual(B.splitSentences('그렇다. 다음 문장이다.'), ['그렇다.', '다음 문장이다.']);
  assert.deepEqual(B.splitSentences('   '), []);
});

test('a sentence too long for the model is cut at punctuation, never mid-word', () => {
  const long = 'alpha, ' + 'beta '.repeat(60) + 'omega.';
  const parts = B.breakLong(long, 100);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 100, `${part.length} > 100`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
  for (const part of parts) assert.ok(!/\bbet$|\bbe$/.test(part), `cut mid-word: ${part}`);
  // One unbroken run still has to come out in pieces the model will take.
  const run = 'x'.repeat(250);
  assert.deepEqual(B.breakLong(run, 100).map(p => p.length), [100, 100, 50]);
  assert.deepEqual(B.breakLong('short', 100), ['short']);
});

test('a plan speaks each heading first and knows which pieces end a sentence', () => {
  const pieces = B.plan([
    {title: 'Abstract', text: 'One. Two.'},
    {title: '', text: 'Three.'},
    {title: 'Empty', text: ''},
    {title: '', text: ''}
  ]);
  assert.deepEqual(pieces.map(p => p.text), ['Abstract', 'One.', 'Two.', 'Three.', 'Empty']);
  assert.deepEqual(pieces.map(p => p.chapter), [0, 0, 0, 1, 2]);
  assert.deepEqual(pieces.filter(p => p.head).map(p => p.text), ['Abstract', 'Three.', 'Empty']);
  assert.equal(pieces[0].heading, true);
  // A chapter with no heading still starts a chapter, at its first sentence.
  assert.equal(pieces[3].heading, undefined);
  assert.deepEqual(B.plan([]), []);
});

test('the timeline puts a gap between sentences, a longer one between sections', () => {
  const pieces = B.plan([{title: 'A', text: 'One. Two.'}, {title: 'B', text: 'Three.'}]);
  const {total, marks, chapters} = B.timeline(pieces, [1, 2, 3, 1, 4], {sentence: 0.2, chapter: 1});
  // A(1s) .2 One.(2s) .2 Two.(3s) 1s B(1s) .2 Three.(4s)
  assert.deepEqual(marks.map(m => m.at), [0, 1.2, 3.4, 7.4, 8.6]);
  assert.deepEqual(chapters, [{chapter: 0, at: 0, title: 'A'}, {chapter: 1, at: 7.4, title: 'B'}]);
  assert.equal(total, 12.6);                                          // no gap is added after the last piece
  assert.deepEqual(marks.map(m => m.seconds), [1, 2, 3, 1, 4]);
});

/* ---------- names ---------- */

test('a paper title becomes a filename a sync folder can hold', () => {
  assert.equal(B.safeName('Hydrolases: a review / part 2'), 'Hydrolases- a review - part 2');
  assert.equal(B.safeName('  ..hidden  '), 'hidden');
  assert.equal(B.safeName(''), '논문');
  assert.equal(B.safeName(null), '논문');
  assert.equal(B.safeName('형광펜이 글자에 앉는다'), '형광펜이 글자에 앉는다');
  const long = B.safeName('word '.repeat(40));
  assert.ok(long.length <= 90 && !long.endsWith(' '));
  assert.ok(!/\s\S*$/.test(long.slice(-1)));
});

test('a second bake of the same paper does not overwrite the first', () => {
  const have = new Set(['Paper.m4b', 'Paper (2).m4b']);
  assert.equal(B.freeName('Paper', '.m4b', n => have.has(n)), 'Paper (3).m4b');
  assert.equal(B.freeName('Other', '.m4b', n => have.has(n)), 'Other.m4b');
});

/* ---------- WAV ---------- */

test('the samples come back out of a WAV whatever order its chunks came in', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const plain = Buffer.concat([B.wavHeader(pcm.length, 22050), pcm]);
  const read = B.pcmOf(plain);
  assert.equal(read.sampleRate, 22050);
  assert.deepEqual([...read.pcm], [...pcm]);

  // A LIST chunk before the data, which some writers add.
  const list = Buffer.alloc(8 + 4); list.write('LIST', 0); list.writeUInt32LE(4, 4);
  const fmt = plain.subarray(12, 36), data = plain.subarray(36);
  const mixed = Buffer.concat([plain.subarray(0, 12), fmt, list, data]);
  mixed.writeUInt32LE(mixed.length - 8, 4);
  assert.deepEqual([...B.pcmOf(mixed).pcm], [...pcm]);

  assert.throws(() => B.pcmOf(Buffer.alloc(4)), /not a WAV/);
  assert.throws(() => B.pcmOf(Buffer.concat([B.wavHeader(0, 8000)])), /no samples/);
});

test('silence is exactly as long as it is asked to be', () => {
  assert.equal(B.silence(0.5, 1000).length, 1000);          // 500 samples, two bytes each
  assert.equal(B.silence(0, 1000).length, 0);
  assert.equal(B.silence(-1, 1000).length, 0);
  assert.ok(B.silence(0.1, 44100).every(byte => byte === 0));
});

/* ---------- mp4 tags ---------- */

/* The smallest file that has the shape withTags() works on: ftyp, moov (with a chunk offset table
   pointing into mdat) and mdat after it. */
function tinyMp4() {
  const atom = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0); head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const ftyp = atom('ftyp', Buffer.from('M4A isom', 'latin1'));
  const stco = offsets => atom('stco', Buffer.concat([
    Buffer.alloc(4),
    (() => { const n = Buffer.alloc(4); n.writeUInt32BE(offsets.length); return n; })(),
    ...offsets.map(o => { const b = Buffer.alloc(4); b.writeUInt32BE(o); return b; })
  ]));
  const build = offsets => atom('moov', Buffer.concat([
    atom('mvhd', Buffer.alloc(100)),
    atom('trak', atom('mdia', atom('minf', atom('stbl', stco(offsets)))))
  ]));
  const head = ftyp.length;
  const moovLength = build([0, 0]).length;
  const mdatAt = head + moovLength + 8;                    // the payload starts after mdat's own header
  const moov = build([mdatAt, mdatAt + 4]);
  const mdat = atom('mdat', Buffer.from('audiodata'));
  return {file: Buffer.concat([ftyp, moov, mdat]), mdatAt, moovAt: head, moovLength};
}

test('iTunes names are written where Apple looks for them', () => {
  const list = B.ilst({title: '제목', artist: 'Kim', album: 'A', audiobook: true, track: [2, 7], comment: ''});
  const text = list.toString('latin1');
  assert.equal(list.toString('latin1', 4, 8), 'ilst');
  for (const type of ['\xa9nam', '\xa9ART', '\xa9alb', 'stik', 'trkn']) assert.ok(text.includes(type), `missing ${type}`);
  assert.ok(list.includes(Buffer.from('제목', 'utf8')), 'the title is not UTF-8 in the atom');
  assert.ok(!text.includes('\xa9cmt'), 'an empty tag should be left out');
  // stik 2 is what makes Books treat it as an audiobook and remember the position.
  assert.equal(list[list.indexOf(Buffer.from('stik', 'latin1')) + 20], 2);
});

test('tagging a file moves the audio and corrects every offset that pointed past it', () => {
  const {file, mdatAt, moovAt, moovLength} = tinyMp4();
  const before = B.pcmOf;                                   // (unused; keeps the import honest)
  assert.ok(before);
  const out = B.withTags(file, {title: 'Paper', artist: 'Kim'});
  const delta = out.length - file.length;
  assert.ok(delta > 0);

  // The new moov carries the tags...
  assert.equal(out.toString('latin1', moovAt + 4, moovAt + 8), 'moov');
  assert.ok(out.includes(Buffer.from('ilst', 'latin1')));
  // ...and the offset table now points at where the audio actually sits.
  const mdatNow = out.indexOf(Buffer.from('mdat', 'latin1')) + 4;
  assert.equal(mdatNow, mdatAt + delta);
  const stco = out.indexOf(Buffer.from('stco', 'latin1'));
  assert.equal(out.readUInt32BE(stco + 12), mdatAt + delta);
  assert.equal(out.readUInt32BE(stco + 16), mdatAt + delta + 4);
  assert.equal(out.toString('latin1', out.length - 9), 'audiodata');
  assert.equal(out.readUInt32BE(moovAt), moovLength + delta);
  // Tagging twice replaces the names rather than stacking a second copy.
  const again = B.withTags(out, {title: 'Other'});
  assert.equal([...again.toString('latin1').matchAll(/ilst/g)].length, 1);
  assert.ok(again.includes(Buffer.from('Other', 'utf8')) && !again.includes(Buffer.from('Paper', 'utf8')));
});

test('a file with no moov is refused rather than quietly broken', () => {
  assert.throws(() => B.withTags(Buffer.from('not an mp4 at all'), {title: 'x'}), /no moov/);
});

test('the encoder is asked for mono AAC at the bitrate it was given', () => {
  const args = B.encodeArgs('/tmp/a.wav', '/tmp/a.m4a', {bitrate: 48000});
  assert.deepEqual(args.slice(0, 6), ['-f', 'm4af', '-d', 'aac', '-b', '48000']);
  assert.deepEqual(args.slice(-2), ['/tmp/a.wav', '/tmp/a.m4a']);
  assert.ok(B.encodeArgs('a', 'b').includes(String(B.BITRATE)));
});

/* ---------- the bake ---------- */

test('a paper becomes one file, a sidecar of chapter times, and no leftover scratch', async () => {
  const dir = scratch(), out = path.join(dir, 'out'), tmp = path.join(dir, 'tmp');
  const voice = fakeVoice();
  const baker = B.createBaker({speech: voice, outDir: out, tmpDir: tmp, afconvert: fakeEncoder(dir), now: () => 1000});
  const started = baker.start({
    title: 'A paper: part 1', lang: 'en-GB', voice: 'F3', rate: 1.2,
    tags: {artist: 'Kim', album: 'Zotero'},
    chapters: [{title: 'Abstract', text: 'One. Two.'}, {title: 'Results', text: 'Three.'}]
  });
  assert.equal(started.state, 'speaking');   // its turn came the moment it was asked for
  assert.equal(started.total, 5);

  const job = await settle(baker, started.id);
  assert.equal(job.state, 'done', job.error || '');
  assert.equal(job.done, 5);
  assert.ok(job.seconds > 0);
  // What the sync folder has to carry, so the panel can say it before the file is opened.
  assert.equal(job.bytes, fs.statSync(job.file).size);

  assert.deepEqual(fs.readdirSync(out).sort(), ['A paper- part 1.json', 'A paper- part 1.m4b']);
  assert.equal(job.file, path.join(out, 'A paper- part 1.m4b'));
  const side = JSON.parse(fs.readFileSync(path.join(out, 'A paper- part 1.json'), 'utf8'));
  assert.equal(side.title, 'A paper: part 1');
  assert.equal(side.audio, 'A paper- part 1.m4b');
  assert.equal(side.lang, 'en');                              // the region is dropped for the model
  assert.equal(side.made, new Date(1000).toISOString());
  assert.deepEqual(side.chapters.map(c => c.title), ['Abstract', 'Results']);
  assert.ok(side.chapters[1].at > side.chapters[0].at);
  assert.deepEqual(side.marks.map(m => m.text), ['Abstract', 'One.', 'Two.', 'Results', 'Three.']);
  assert.equal(side.seconds, side.marks.at(-1).at + side.marks.at(-1).seconds);

  // The voice was asked in order, with the paper's language and the chosen voice and speed.
  assert.deepEqual(voice.said.map(s => s.text), ['Abstract', 'One.', 'Two.', 'Results', 'Three.']);
  assert.deepEqual([...new Set(voice.said.map(s => `${s.lang}/${s.voice}/${s.speed}`))], ['en/F3/1.2']);
  // 300 MB of scratch WAV does not stay behind.
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('the WAV handed to the encoder is a real one: header, gaps and all the speech', async () => {
  const dir = scratch(), out = path.join(dir, 'out'), tmp = path.join(dir, 'tmp');
  // The encoder copies the WAV, so the .m4b is the WAV and can be read back.
  const baker = B.createBaker({speech: fakeVoice({rate: 1000, perChar: 0.01}), outDir: out, tmpDir: tmp, afconvert: fakeEncoder(dir)});
  const job = await settle(baker, baker.start({title: 'W', chapters: [{title: '', text: 'abcd. efgh.'}]}).id);
  assert.equal(job.state, 'done', job.error || '');
  const {pcm, sampleRate} = B.pcmOf(fs.readFileSync(job.file));
  assert.equal(sampleRate, 1000);
  // 'abcd.' and 'efgh.' are 5 characters each -> 50 samples each, with one sentence gap between them.
  assert.equal(pcm.length / 2, 50 + Math.round(B.GAP_SENTENCE * 1000) + 50);
  assert.ok(Math.abs(pcm.readInt16LE(0)) > 1000, 'speech, not silence');
  assert.equal(pcm.readInt16LE(100), 0);                      // the gap
  assert.ok(Math.abs(pcm.readInt16LE(pcm.length - 2)) > 1000);
});

test('a bake whose voice fails is reported as failed, with no half file left in the folder', async () => {
  const dir = scratch(), out = path.join(dir, 'out'), tmp = path.join(dir, 'tmp');
  const baker = B.createBaker({speech: fakeVoice({fail: t => t === 'Two.'}), outDir: out, tmpDir: tmp, afconvert: fakeEncoder(dir)});
  const job = await settle(baker, baker.start({title: 'Bad', chapters: [{title: '', text: 'One. Two. Three.'}]}).id);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /gave up/);
  assert.equal(job.file, null);
  assert.ok(!fs.existsSync(out) || !fs.readdirSync(out).length);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('an encoder that will not run is reported, not swallowed', async () => {
  const dir = scratch();
  const baker = B.createBaker({speech: fakeVoice(), outDir: path.join(dir, 'out'), tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir, {kind: 'no', code: 2})});
  const job = await settle(baker, baker.start({title: 'E', chapters: [{title: '', text: 'One.'}]}).id);
  assert.equal(job.state, 'failed');
  assert.match(job.error, /exited 2/);
});

test('papers are baked one at a time, in the order they were asked for', async () => {
  const dir = scratch(), out = path.join(dir, 'out');
  const voice = fakeVoice();
  const baker = B.createBaker({speech: voice, outDir: out, tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  const first = baker.start({title: 'First', chapters: [{title: '', text: 'One.'}]});
  const second = baker.start({title: 'Second', chapters: [{title: '', text: 'Two.'}]});
  assert.equal(baker.get(second.id).state, 'waiting');
  await settle(baker, second.id);
  assert.equal(baker.get(first.id).state, 'done');
  assert.deepEqual(voice.said.map(s => s.text), ['One.', 'Two.']);
  // Newest first, so a panel shows what is happening now at the top.
  assert.deepEqual(baker.list().map(j => j.title), ['Second', 'First']);
});

test('a paper still waiting can be dropped, and one being spoken stops at the next sentence', async () => {
  const dir = scratch(), out = path.join(dir, 'out');
  const long = {title: '', text: Array.from({length: 40}, (_, i) => `Sentence number ${i}.`).join(' ')};
  const baker = B.createBaker({speech: fakeVoice(), outDir: out, tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  const running = baker.start({title: 'Running', chapters: [long]});
  const queued = baker.start({title: 'Queued', chapters: [long]});

  assert.equal(baker.cancel(queued.id).state, 'cancelled');
  const stopped = await settle(baker, running.id);
  assert.equal(stopped.state, 'done');                       // it was quick; cancelling the queue did not touch it

  const again = baker.start({title: 'Again', chapters: [long]});
  baker.cancel(again.id);
  const dropped = await settle(baker, again.id);
  assert.ok(['cancelled', 'done'].includes(dropped.state));
  assert.equal(baker.cancel('nosuchjob'), null);
  assert.equal(baker.get('nosuchjob'), null);
  assert.ok(!fs.readdirSync(out).includes('Queued.m4b'));
});

test('a bake with nothing in it, or more than the queue holds, is refused at the door', () => {
  const dir = scratch();
  const baker = B.createBaker({speech: fakeVoice(), outDir: path.join(dir, 'out'), tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir), maxQueue: 2});
  assert.throws(() => baker.start({title: 'Nothing', chapters: []}), /nothing to say/);
  assert.throws(() => baker.start({title: 'Nothing', chapters: [{title: '', text: '   '}]}), /nothing to say/);
  const long = {title: '', text: Array.from({length: 200}, (_, i) => `Sentence ${i}.`).join(' ')};
  baker.start({title: 'A', chapters: [long]});               // this one runs
  baker.start({title: 'B', chapters: [long]});               // these two wait
  baker.start({title: 'C', chapters: [long]});
  assert.throws(() => baker.start({title: 'D', chapters: [long]}), /already waiting/);
});

/* The one test that uses the real encoder, because a file Apple's own parser will not open is worth
   nothing. macOS always has afconvert; anywhere else this is skipped. */
test('afconvert and the hand-written tags make a file macOS reads as an audiobook', async t => {
  if (!fs.existsSync('/usr/bin/afconvert') || !fs.existsSync('/usr/bin/afinfo')) return t.skip('no afconvert on this machine');
  const dir = scratch(), out = path.join(dir, 'out');
  const baker = B.createBaker({
    speech: fakeVoice({rate: 44100, perChar: 0.02}), outDir: out, tmpDir: path.join(dir, 'tmp'),
    afconvert: '/usr/bin/afconvert'
  });
  const job = await settle(baker, baker.start({
    title: '형광펜 논문', lang: 'ko', chapters: [{title: '초록', text: '한 문장이다. 두 문장이다.'}],
    tags: {artist: 'Sung', album: 'Zotero · 논문 음성', year: '2026'}
  }).id, 20000);
  assert.equal(job.state, 'done', job.error || '');

  const {execFileSync} = await import('node:child_process');
  const info = execFileSync('/usr/bin/afinfo', [job.file], {encoding: 'utf8'});
  assert.match(info, /m4af/);
  assert.match(info, /media kind\s+:\s+"Audiobook"/);          // the stik atom read back by Apple's parser
  const seconds = Number(/estimated duration: ([\d.]+)/.exec(info)[1]);
  assert.ok(Math.abs(seconds - job.seconds) < 0.5, `${seconds} vs ${job.seconds}`);
  const tagged = fs.readFileSync(job.file);
  assert.ok(tagged.includes(Buffer.from('형광펜 논문', 'utf8')));
  assert.ok(tagged.includes(Buffer.from('Zotero · 논문 음성', 'utf8')));
  // The chapter list rides in the same file, so the car's skip button moves by section.
  const chplAt = tagged.indexOf(Buffer.from('chpl', 'latin1'));
  assert.ok(chplAt > 0, 'no chapter list in the finished file');
  assert.equal(tagged.readUInt8(chplAt + 12), 1, 'one section, so one chapter');
  assert.ok(tagged.includes(Buffer.from('초록', 'utf8')));
  assert.equal(job.bytes, fs.statSync(job.file).size);
});

/* ---------- level, edges, chapters, housekeeping ---------- */

/* A voice whose pieces have real silence at each end and a level the test chooses, so trimming and
   levelling can be measured rather than guessed at. */
function voiceWith({rate = 1000, lead = 0.1, tail = 0.1, body = 0.3, peak = 0.1} = {}) {
  return {
    async say({text}) {
      const n = s => Math.round(s * rate);
      const samples = n(lead) + n(body) + n(tail);
      const pcm = Buffer.alloc(samples * 2);
      const top = Math.round(peak * 32767);
      for (let i = n(lead); i < n(lead) + n(body); i++) pcm.writeInt16LE(i % 2 ? top : -top, i * 2);
      return {audio: Buffer.concat([B.wavHeader(pcm.length, rate), pcm]), seconds: samples / rate, said: text};
    }
  };
}

test('the silence a voice leaves at each end of a piece is cut back, so a gap is the gap that was asked for', () => {
  const rate = 1000, pcm = Buffer.alloc(1000 * 2);
  for (let i = 300; i < 700; i++) pcm.writeInt16LE(8000, i * 2);     // speech from 0.3 s to 0.7 s
  assert.deepEqual(B.speechEdges(pcm), {from: 300, to: 700});
  const trimmed = B.trimEdges(pcm, rate, {keep: 0.04});
  assert.equal(trimmed.length / 2, 400 + 80);                        // 40 ms left at each end
  assert.notEqual(trimmed.readInt16LE(80 * 2), 0);                   // the speech is all still there
  assert.equal(trimmed.readInt16LE(0), 0);
  // A piece that never rises above the noise floor is nothing at all.
  assert.equal(B.trimEdges(Buffer.alloc(2000), rate).length, 0);
  // Quiet is a floor, not zero: a faint hiss is still silence.
  const hiss = Buffer.alloc(200); for (let i = 0; i < 100; i++) hiss.writeInt16LE(i % 2 ? 90 : -90, i * 2);
  assert.equal(B.trimEdges(hiss, rate).length, 0);
});

test('a paper is brought up to a level a car can be heard over, from its own loudest moment', () => {
  const quiet = Buffer.alloc(100); for (let i = 0; i < 50; i++) quiet.writeInt16LE(i % 2 ? 3277 : -3277, i * 2);
  assert.ok(Math.abs(B.peakOf(quiet) - 0.1) < 0.001);
  // 0.1 peak -> 8.9x, inside the limit; a silent piece is left alone; a loud one is barely touched.
  assert.ok(Math.abs(B.gainFor(0.1) - 8.9) < 0.001);
  assert.equal(B.gainFor(0), 1);
  assert.ok(Math.abs(B.gainFor(0.89) - 1) < 0.001);
  // Nothing is lifted past LOUDEST_LIFT, or a breath between sentences becomes a roar.
  assert.equal(B.gainFor(0.0001), B.LOUDEST_LIFT);
  // And nothing is pushed over the top: what would go over is rounded off, sign and all.
  const hot = Buffer.alloc(4); hot.writeInt16LE(30000, 0); hot.writeInt16LE(-30000, 2);
  B.applyGain(hot, 4);
  assert.ok(hot.readInt16LE(0) > 30000 && hot.readInt16LE(0) <= 32767, hot.readInt16LE(0));
  assert.equal(hot.readInt16LE(2), -hot.readInt16LE(0), 'the same curve either side of zero');
});

test('how loud a paper sounds decides the level, not its one loudest sample', () => {
  // A real paper measured off a finished file: peaks at 0.73, but it sounds like -23 dBFS. The peak
  // rule could only lift it 1.22x, which is not enough to hear over an engine.
  assert.ok(Math.abs(B.gainFor(0.729) - 1.221) < 0.002);
  assert.ok(Math.abs(B.loudnessGain({rms: 0.0701, peak: 0.729}) - 1.797) < 0.002);
  // A paper that is already loud enough is left where it is, and a silent one is not divided by zero.
  assert.ok(Math.abs(B.loudnessGain({rms: B.TARGET_RMS, peak: 0.5}) - B.gainFor(0.5)) < 0.001, 'the peak rule is still the floor');
  assert.equal(B.loudnessGain({rms: 0, peak: 0}), 1);
  assert.equal(B.loudnessGain({rms: 0.0001, peak: 0.0001}), B.LOUDEST_LIFT, 'never more than the limit');

  // The knee: nothing below it moves, nothing above it ever reaches the ceiling, and it is smooth.
  assert.equal(B.soften(0.5), 0.5);
  assert.equal(B.soften(-0.5), -0.5);
  assert.equal(B.soften(B.KNEE), B.KNEE);
  for (const x of [0.85, 0.9, 1, 1.4, 4]) {
    assert.ok(B.soften(x) > B.KNEE && B.soften(x) < 1, `${x} -> ${B.soften(x)}`);
    assert.equal(B.soften(-x), -B.soften(x));
  }
  let last = 0;
  for (let x = 0; x <= 2; x += 0.01) { const y = B.soften(x); assert.ok(y >= last, `not rising at ${x}`); last = y; }
});

test('a quiet paper is lifted past what its peaks alone would allow, and still never clips', async () => {
  const dir = scratch(), out = path.join(dir, 'out');
  // Mostly quiet speech with one loud moment in it: the peak rule would be held back by that moment.
  const voice = {
    async say({text}) {
      const rate = 1000, n = 400, pcm = Buffer.alloc(n * 2);
      const quiet = Math.round(0.08 * 32767), loud = Math.round(0.7 * 32767);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(i % 2 ? quiet : -quiet, i * 2);
      if (text.includes('Loud')) { pcm.writeInt16LE(loud, 0); pcm.writeInt16LE(-loud, 2); }
      return {audio: Buffer.concat([B.wavHeader(pcm.length, rate), pcm]), seconds: n / rate};
    }
  };
  const baker = B.createBaker({speech: voice, outDir: out, tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  const job = await settle(baker, baker.start({title: 'Quiet with one shout', chapters: [{title: '', text: 'Loud here. Quiet after.'}]}).id);
  assert.equal(job.state, 'done', job.error || '');
  assert.ok(job.rms > 0, 'the paper was measured');
  const byPeak = B.gainFor(0.7);
  assert.ok(job.gain > byPeak * 1.1, `${job.gain} should be well past the peak rule's ${byPeak.toFixed(2)}`);
  const {pcm} = B.pcmOf(fs.readFileSync(job.file));
  assert.ok(B.peakOf(pcm) <= 1, 'and it still never clips');
  assert.ok(B.peakOf(pcm) > 0.7);
});

test('a quiet paper comes out of the bake loud, and the file says by how much', async () => {
  const dir = scratch(), out = path.join(dir, 'out');
  const baker = B.createBaker({speech: voiceWith({peak: 0.1, lead: 0.2, tail: 0.2, body: 0.4}), outDir: out, tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  const job = await settle(baker, baker.start({title: 'Quiet', chapters: [{title: '', text: 'One. Two.'}]}).id);
  assert.equal(job.state, 'done', job.error || '');
  assert.ok(Math.abs(job.gain - 8.9) < 0.01, `gain ${job.gain}`);
  const {pcm} = B.pcmOf(fs.readFileSync(job.file));
  assert.ok(Math.abs(B.peakOf(pcm) - B.PEAK) < 0.01, 'the loudest moment lands just under the ceiling');
  // Each piece was 0.8 s with 0.4 s of speech; trimmed to 0.4 s + 40 ms at each end, plus one gap.
  assert.equal(pcm.length / 2, 2 * (400 + 80) + Math.round(B.GAP_SENTENCE * 1000));

  // Levelling can be turned off, and then nothing is touched.
  const plain = B.createBaker({speech: voiceWith({peak: 0.1}), outDir: path.join(dir, 'out2'), tmpDir: path.join(dir, 'tmp2'), afconvert: fakeEncoder(dir)});
  const flat = await settle(plain, plain.start({title: 'Quiet2', level: false, trim: false, chapters: [{title: '', text: 'One.'}]}).id);
  assert.equal(flat.gain, 1);
  assert.ok(Math.abs(B.peakOf(B.pcmOf(fs.readFileSync(flat.file)).pcm) - 0.1) < 0.01);
});

test('the chapter list is written where a car and Books look for it', () => {
  const marks = B.chpl([{at: 0, title: 'Abstract'}, {at: 12.5, title: '결과'}]);
  assert.equal(marks.toString('latin1', 4, 8), 'chpl');
  assert.equal(marks.readUInt32BE(8), 0x01000000);                   // version 1
  assert.equal(marks.readUInt8(16), 2);                              // two chapters
  // The second entry starts at 12.5 s, in 100-nanosecond units, and keeps its Korean name.
  const first = Buffer.from('Abstract', 'utf8');
  const at = 17 + 8 + 1 + first.length;
  assert.equal(marks.readBigUInt64BE(17), 0n);
  assert.equal(marks.readBigUInt64BE(at), 125000000n);
  assert.ok(marks.includes(Buffer.from('결과', 'utf8')));
  // A chapter with no heading is still a chapter you can skip to.
  assert.ok(B.chpl([{at: 0, title: ''}]).includes(Buffer.from('1', 'latin1')));
  assert.equal(B.chpl([]).length, 8 + 9);
  assert.equal(B.chpl([{at: -1, title: 'x'}, {at: NaN, title: 'y'}]).readUInt8(16), 0);
});

test('tagging a file twice leaves one set of names and one chapter list, not two', () => {
  const {file} = tinyMp4();
  const once = B.withTags(file, {title: 'A'}, [{at: 0, title: 'One'}, {at: 5, title: 'Two'}]);
  assert.equal([...once.toString('latin1').matchAll(/chpl/g)].length, 1);
  const twice = B.withTags(once, {title: 'B'}, [{at: 0, title: 'Only'}]);
  assert.equal([...twice.toString('latin1').matchAll(/chpl/g)].length, 1);
  assert.equal([...twice.toString('latin1').matchAll(/ilst/g)].length, 1);
  assert.ok(twice.includes(Buffer.from('Only', 'utf8')) && !twice.includes(Buffer.from('Two', 'utf8')));
  // And the audio still ends up where the offset table says it does.
  const stco = twice.indexOf(Buffer.from('stco', 'latin1'));
  assert.equal(twice.readUInt32BE(stco + 12), twice.indexOf(Buffer.from('mdat', 'latin1')) + 4);
});

test('a paper already in the folder is found, newest first, and counted', async () => {
  const dir = scratch(), out = path.join(dir, 'out');
  const baker = B.createBaker({speech: fakeVoice(), outDir: out, tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  assert.equal(baker.made('Nothing here'), null);
  const first = await settle(baker, baker.start({title: 'Twice baked', chapters: [{title: '', text: 'One.'}]}).id);
  assert.equal(first.state, 'done');
  const have = baker.made('Twice baked');
  assert.equal(have.name, 'Twice baked.m4b');
  assert.equal(have.copies, 1);
  assert.equal(have.bytes, fs.statSync(first.file).size);
  assert.ok(have.at > 0);
  const second = await settle(baker, baker.start({title: 'Twice baked', chapters: [{title: '', text: 'Two.'}]}).id);
  assert.equal(path.basename(second.file), 'Twice baked (2).m4b');
  assert.equal(baker.made('Twice baked').copies, 2);
  // The newest copy is the one reported, and the title is matched the way the file was named
  // (through safeName) rather than character for character.
  assert.equal(baker.made('Twice baked').name, 'Twice baked (2).m4b');
  assert.equal(baker.made('Twice baked?').copies, 2);
});

test('a paper waiting its turn knows how many are in front of it', async () => {
  const dir = scratch();
  const long = {title: '', text: Array.from({length: 60}, (_, i) => `Sentence ${i}.`).join(' ')};
  const baker = B.createBaker({speech: fakeVoice(), outDir: path.join(dir, 'out'), tmpDir: path.join(dir, 'tmp'), afconvert: fakeEncoder(dir)});
  const running = baker.start({title: 'A', chapters: [long]});
  const next = baker.start({title: 'B', chapters: [long]});
  const last = baker.start({title: 'C', chapters: [long]});
  assert.equal(running.ahead, 0, 'the one being made is not waiting');
  assert.equal(baker.get(next.id).ahead, 1);
  assert.equal(baker.get(last.id).ahead, 2);
  await settle(baker, last.id, 8000);
  assert.equal(baker.get(last.id).ahead, 0);
});

test('a bake killed halfway leaves no 300 MB scratch file for the next one to trip over', async () => {
  const dir = scratch(), tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  fs.writeFileSync(path.join(tmp, 'bake-deadbeef12345678.wav'), 'what a killed bake left');
  fs.writeFileSync(path.join(tmp, 'bake-deadbeef12345678.m4a'), 'and its half-encoded file');
  fs.writeFileSync(path.join(tmp, 'keep-me.txt'), 'not ours');
  B.createBaker({speech: fakeVoice(), outDir: path.join(dir, 'out'), tmpDir: tmp, afconvert: fakeEncoder(dir)});
  assert.deepEqual(fs.readdirSync(tmp), ['keep-me.txt'], 'only this bakery’s own leftovers are swept');
});
