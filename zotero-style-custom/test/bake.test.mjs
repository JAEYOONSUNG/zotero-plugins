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
  assert.equal(pcm.readInt16LE(0), 0x0707);                   // speech, not silence
  assert.equal(pcm.readInt16LE(100), 0);                      // the gap
  assert.equal(pcm.readInt16LE(pcm.length - 2), 0x0707);
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
});
