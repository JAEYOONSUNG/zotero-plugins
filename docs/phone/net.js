/* Talking to Zotero over a phone's signal.

   Three things go wrong on a train that never go wrong on a desk: the server asks to be left
   alone for a while (429, or a Backoff header on an ordinary answer), a request dies halfway,
   and there is no signal at all. The first two are waited out here. The third is the caller's
   business — a read can fail, but a change the reader made must not simply vanish, so app.js
   keeps those and sends them when the signal comes back.

   Nothing here touches the network itself: it is handed something to run, so the waiting and the
   giving up are checked in milliseconds. */

export const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/* How long to wait before trying again. Zotero says so itself in Retry-After or Backoff; without
   that it is doubled each time, with a little jitter so two phones do not come back in step. */
export function waitFor(response, attempt, {base = 700, cap = 20000, jitter = () => Math.random()} = {}) {
  const said = headerOf(response, 'Retry-After') ?? headerOf(response, 'Backoff');
  const seconds = Number(said);
  // A server saying "come back now" is believed as readily as one saying "come back in a minute".
  if (said !== null && said !== undefined && said !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(cap, Math.max(0, seconds) * 1000);
  }
  return Math.round(Math.min(cap, base * 2 ** attempt) + jitter() * 250);
}
const headerOf = (response, name) => {
  try { return response && response.headers && response.headers.get(name); } catch (_) { return null; }
};

/* A request that died on the way out, rather than one the server answered. */
export const isOffline = error =>
  error instanceof TypeError || /network|load failed|fetch/i.test(String(error && error.message || ''));

/* Runs it, waits out a server asking to be left alone, and gives up after so many tries.
   `tries` of 1 means no retrying at all, which is what a note being posted gets: the server may
   have taken it even though the answer never arrived, and a second one would be a second note. */
export async function withRetry(run, {
  tries = 3,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  onWait = () => {},
  ...rest
} = {}) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) { const ms = waitFor(last, attempt - 1, rest); onWait(ms, attempt); await sleep(ms); }
    try {
      const response = await run(attempt);
      if (!RETRYABLE.has(response.status) || attempt === tries - 1) return response;
      last = response;
    } catch (error) {
      if (!isOffline(error) || attempt === tries - 1) throw error;
      last = null;
    }
  }
  return last;
}

/* What a change the reader made is, kept so it can be sent later. Not the fields to write — the
   intention — because by the time there is signal again the paper may have moved on, and
   "mark it done" still means the same thing while a list of tags would not. */
export function queueKey(write) { return `${write.kind}:${write.key}`; }

/* One change per kind per paper: marking a paper read and then unread leaves one change, not two
   fighting each other. A note is different — every note written is its own. */
export function mergeQueue(queue, write) {
  const out = queue.filter(held => held.kind === 'note' || queueKey(held) !== queueKey(write));
  out.push(write);
  return out;
}
