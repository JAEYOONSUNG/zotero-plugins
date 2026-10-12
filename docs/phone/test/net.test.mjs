/* Waiting out a busy server, and keeping a change until there is signal for it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {withRetry, waitFor, isOffline, mergeQueue, RETRYABLE} from '../net.js';

const answer = (status, headers = {}) => new Response('', {status, headers});
const noSleep = () => Promise.resolve();
const steady = {jitter: () => 0};

test('a busy server is waited out and the answer that arrives is the one returned', async () => {
  let n = 0;
  const waits = [];
  const response = await withRetry(() => { n++; return Promise.resolve(answer(n < 3 ? 429 : 200)); },
    {sleep: noSleep, onWait: ms => waits.push(ms), ...steady});
  assert.equal(response.status, 200);
  assert.equal(n, 3);
  assert.deepEqual(waits, [700, 1400], 'each wait is twice the last');
});

test('Zotero saying how long to wait is believed over any guess', () => {
  assert.equal(waitFor(answer(429, {'Retry-After': '9'}), 0, steady), 9000);
  assert.equal(waitFor(answer(503, {Backoff: '4'}), 5, steady), 4000);
  assert.equal(waitFor(answer(429), 9, steady), 20000, 'and the wait has a ceiling');
  assert.equal(waitFor(answer(429, {'Retry-After': '0'}), 3, steady), 0, 'come back now means now');
  assert.ok(waitFor(answer(429, {'Retry-After': 'soon'}), 0, steady) > 0, 'nonsense falls back to the doubling');
});

test('an answer that is not going to get better is handed back at once', async () => {
  let n = 0;
  const response = await withRetry(() => { n++; return Promise.resolve(answer(404)); }, {sleep: noSleep});
  assert.equal(response.status, 404);
  assert.equal(n, 1, 'a missing paper is not asked for again');
  assert.deepEqual([...RETRYABLE].sort(), [429, 500, 502, 503, 504]);
});

test('giving up returns the last thing the server said rather than hanging on', async () => {
  let n = 0;
  const response = await withRetry(() => { n++; return Promise.resolve(answer(503)); }, {tries: 3, sleep: noSleep, ...steady});
  assert.equal(n, 3);
  assert.equal(response.status, 503);
});

test('a request that died on the way out is tried again, and then given up on', async () => {
  let n = 0;
  await assert.rejects(() => withRetry(() => { n++; throw new TypeError('Load failed'); }, {tries: 3, sleep: noSleep, ...steady}));
  assert.equal(n, 3);
  assert.equal(isOffline(new TypeError('Load failed')), true);
  assert.equal(isOffline(new Error('키가 거부되었습니다')), false);
});

test('a note is never sent twice, however the first attempt ended', async () => {
  let n = 0;
  const response = await withRetry(() => { n++; return Promise.resolve(answer(503)); }, {tries: 1, sleep: noSleep});
  assert.equal(n, 1, 'one try, because the server may have taken it already');
  assert.equal(response.status, 503);
});

test('changing a paper twice while offline leaves one change, and notes all of them', () => {
  let queue = [];
  queue = mergeQueue(queue, {kind: 'status', key: 'A', value: 'done'});
  queue = mergeQueue(queue, {kind: 'status', key: 'A', value: 'reading'});
  queue = mergeQueue(queue, {kind: 'rating', key: 'A', value: 4});
  queue = mergeQueue(queue, {kind: 'status', key: 'B', value: 'done'});
  queue = mergeQueue(queue, {kind: 'note', key: 'A', value: 'first'});
  queue = mergeQueue(queue, {kind: 'note', key: 'A', value: 'second'});
  assert.deepEqual(queue.map(w => `${w.kind}:${w.key}=${w.value}`),
    ['status:A=reading', 'rating:A=4', 'status:B=done', 'note:A=first', 'note:A=second'],
    'a change takes the place of the one it replaces at the moment it is made, so the queue stays in the order the reader worked');
  assert.equal(queue.filter(w => w.kind === 'status' && w.key === 'A').length, 1, 'one status for A');
  assert.equal(queue.find(w => w.kind === 'status' && w.key === 'A').value, 'reading', 'the last one wins');
  assert.equal(queue.filter(w => w.kind === 'note').length, 2, 'both notes are kept');
});
