import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAll, batches, repoHash, BATCH_SIZE } from '../src/client.mjs';

const e = (i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0', lockfile: 'package-lock.json' });
const verdictFor = (p) => ({ ecosystem: 'npm', name: p.name, requested_version: p.version, verdict: p.name === 'p3' ? 'BLOCK' : 'GO', reasons: [], did_you_mean: null });
const base = { version: '1.0.0', freeUrl: 'https://free.test/check', premiumUrl: 'https://paid.test/check', timeoutMs: 1000 };

function server(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(url, init, calls.length);
  };
  return { fetchImpl, calls };
}
const ok = (_u, init) => Response.json({ ok: true, results: JSON.parse(init.body).packages.map(verdictFor) });

// Fake clock for pacing tests: now() reads a variable, sleep(ms) records the
// wait and advances that same variable. Neither ever really waits. This is
// fine for concurrency 1 (nothing else is racing the clock), but at
// concurrency 2 it advances time the instant sleep() is CALLED rather than
// when it would actually elapse, which can make two different reservations'
// dispatches read the same tied "now" even when pacing is implemented
// correctly. Use eventClock below for anything that asserts real spacing
// under concurrency.
function fakeClock(start = 0) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

// Event clock: sleep(ms) registers a timer at now()+ms and returns a promise
// that only resolves when the timer is explicitly fired. Time never moves on
// its own. Pair with runPaced() below, which drains pending microtasks
// (via setImmediate) before firing the single earliest pending timer, over
// and over, until the driven promise settles. This reproduces real
// wall-clock ordering (nothing can "jump the queue") without ever really
// waiting, so it is safe to use with any concurrency.
function eventClock(start = 0) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => timers.push({ at: t + ms, resolve })),
    // Fire the single earliest pending timer, advancing the clock to it.
    // Returns false if there was nothing to fire.
    advance() {
      if (timers.length === 0) return false;
      timers.sort((a, b) => a.at - b.at);
      const timer = timers.shift();
      t = timer.at;
      timer.resolve();
      return true;
    },
  };
}

async function runPaced(clock, fn) {
  const p = fn();
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  while (!settled) {
    // Let every currently queued microtask (fetch resolution, json parsing,
    // the next pace() reservation, and so on) fully drain before deciding
    // whether anything is left to advance.
    await new Promise((resolve) => { setImmediate(resolve); });
    if (settled) break;
    clock.advance();
  }
  return p;
}

test('repoHash is sha256 hex of the lowercased repo', async () => {
  const h = await repoHash('Owner/Repo');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await repoHash('owner/repo'));
});

test('batches of 20', () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(BATCH_SIZE, 20);
});

test('free route: repo header, UA, names and versions only', async () => {
  const s = server(ok);
  const r = await checkAll([e(1), e(2), e(3)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'https://free.test/check');
  assert.equal(s.calls[0].init.headers['X-TF-Repo'], 'f'.repeat(64));
  assert.equal(s.calls[0].init.headers['User-Agent'], 'tensorfeed-package-check-action/1.0.0');
  assert.equal(s.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(s.calls[0].body, { packages: [1, 2, 3].map((i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0' })) });
  assert.equal(r.checked.length, 3);
  assert.equal(r.checked[2].result.verdict, 'BLOCK');
  assert.deepEqual(r.unchecked, []);
});

test('paid route: bearer token, no repo header', async () => {
  const s = server(ok);
  await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, token: 'tf_live_x', repoHashHex: 'f'.repeat(64) });
  assert.equal(s.calls[0].url, 'https://paid.test/check');
  assert.equal(s.calls[0].init.headers.Authorization, 'Bearer tf_live_x');
  assert.equal(s.calls[0].init.headers['X-TF-Repo'], undefined);
});

test('45 entries become 3 batches; a free-cap 429 stops further batches and marks the rest unchecked', async () => {
  const s = server((u, init, n) => (n === 2 ? Response.json({ limit_scope: 'repo' }, { status: 429 }) : ok(u, init)));
  const entries = Array.from({ length: 45 }, (_, i) => e(i));
  const r = await checkAll(entries, { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64), concurrency: 1 });
  assert.equal(r.stop, 'free_cap');
  assert.equal(r.checked.length, 20);
  assert.equal(r.unchecked.length, 25);
  assert.equal(s.calls.length, 2);
});

test('402 stops with no_credits; 401 with bad_token', async () => {
  const r402 = await checkAll([e(1)], { ...base, fetchImpl: server(() => new Response('{}', { status: 402 })).fetchImpl, token: 't' });
  assert.equal(r402.stop, 'no_credits');
  const r401 = await checkAll([e(1)], { ...base, fetchImpl: server(() => new Response('{}', { status: 401 })).fetchImpl, token: 't' });
  assert.equal(r401.stop, 'bad_token');
});

test('one retry on a network error, then unchecked; 500 and bad bodies are errors', async () => {
  const flaky = server((u, init, n) => {
    if (n === 1) throw new Error('reset');
    return ok(u, init);
  });
  const r1 = await checkAll([e(1)], { ...base, fetchImpl: flaky.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(r1.checked.length, 1);
  assert.equal(flaky.calls.length, 2);
  const down = await checkAll([e(1)], { ...base, fetchImpl: server(() => { throw new Error('down'); }).fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([down.errors, down.unchecked.length, down.stop], [1, 1, null]);
  const bad = await checkAll([e(1), e(2)], { ...base, fetchImpl: server(() => Response.json({ results: [{}] })).fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([bad.errors, bad.unchecked.length], [1, 2]);
});

// A free-cap 429 is told apart from a plain rate limit.

test('paid route 429 without limit_scope stops with rate_limited, not free_cap', async () => {
  const s = server(() => Response.json({ error: 'too_many_requests' }, { status: 429 }));
  const entries = Array.from({ length: 5 }, (_, i) => e(i));
  const r = await checkAll(entries, { ...base, fetchImpl: s.fetchImpl, token: 't' });
  assert.equal(r.stop, 'rate_limited');
  assert.equal(r.checked.length, 0);
  assert.equal(r.unchecked.length, 5);
});

test('free route 429 with limit_scope repo or ip stops with free_cap', async () => {
  for (const scope of ['repo', 'ip']) {
    const s = server(() => Response.json({ limit_scope: scope }, { status: 429 }));
    const r = await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
    assert.equal(r.stop, 'free_cap');
  }
});

test('free route 429 without limit_scope stops with rate_limited', async () => {
  const s = server(() => Response.json({ error: 'rate_limited' }, { status: 429 }));
  const r = await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(r.stop, 'rate_limited');
});

test('a 429 with an unparseable body is treated as rate_limited, not a crash', async () => {
  const s = server(() => new Response('not json', { status: 429 }));
  const r = await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(r.stop, 'rate_limited');
});

// Paid requests are paced.

test('paid pacing: sequential requests are spaced minIntervalMs apart (concurrency 1)', async () => {
  const clock = fakeClock();
  const starts = [];
  const fetchImpl = async (url, init) => {
    starts.push(clock.now());
    return ok(url, init);
  };
  const entries = Array.from({ length: 45 }, (_, i) => e(i));
  await checkAll(entries, {
    ...base,
    fetchImpl,
    token: 't',
    minIntervalMs: 100,
    concurrency: 1,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(starts, [0, 100, 200]);
  assert.deepEqual(clock.sleeps, [100, 100]);
});

test('paid pacing: concurrency 2 still spaces every request start at least minIntervalMs apart', async () => {
  const clock = eventClock();
  const starts = [];
  const fetchImpl = async (url, init) => {
    starts.push(clock.now());
    return ok(url, init);
  };
  const entries = Array.from({ length: 80 }, (_, i) => e(i)); // 4 batches of 20
  const r = await runPaced(clock, () => checkAll(entries, {
    ...base,
    fetchImpl,
    token: 't',
    minIntervalMs: 100,
    concurrency: 2,
    now: clock.now,
    sleep: clock.sleep,
  }));
  assert.equal(r.checked.length, 80);
  assert.equal(starts.length, 4);
  const sorted = [...starts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 100, `starts ${sorted[i - 1]} and ${sorted[i]} are less than 100ms apart`);
  }
});

test('no token means no pacing at all, even across many batches', async () => {
  const clock = fakeClock();
  const s = server(ok);
  const entries = Array.from({ length: 45 }, (_, i) => e(i));
  await checkAll(entries, {
    ...base,
    fetchImpl: s.fetchImpl,
    repoHashHex: 'f'.repeat(64),
    concurrency: 2,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(clock.sleeps, []);
});

test('defaults to a 667ms interval when a token is set and minIntervalMs is not given', async () => {
  const clock = fakeClock();
  const starts = [];
  const fetchImpl = async (url, init) => {
    starts.push(clock.now());
    return ok(url, init);
  };
  const entries = Array.from({ length: 21 }, (_, i) => e(i));
  await checkAll(entries, {
    ...base,
    fetchImpl,
    token: 't',
    concurrency: 1,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.deepEqual(starts, [0, 667]);
  assert.deepEqual(clock.sleeps, [667]);
});

// A stop from one worker wins over a sibling that is waiting for its paced slot.

test('stop race: a 402 on the first request stops before a paced sibling batch is ever sent', async () => {
  const clock = eventClock();
  const s = server(() => new Response('{}', { status: 402 }));
  const entries = Array.from({ length: 60 }, (_, i) => e(i)); // 3 batches, concurrency 2 by default
  const r = await runPaced(clock, () => checkAll(entries, { ...base, fetchImpl: s.fetchImpl, token: 't', now: clock.now, sleep: clock.sleep }));
  assert.equal(r.stop, 'no_credits');
  assert.equal(s.calls.length, 1);
  assert.equal(r.checked.length, 0);
  assert.equal(r.unchecked.length, 60);
});

test('stop race: a paid-route rate-limit 429 on the first request stops before a paced sibling batch is ever sent', async () => {
  const clock = eventClock();
  const s = server(() => Response.json({ error: 'too_many_requests' }, { status: 429 }));
  const entries = Array.from({ length: 60 }, (_, i) => e(i)); // 3 batches, concurrency 2 by default
  const r = await runPaced(clock, () => checkAll(entries, { ...base, fetchImpl: s.fetchImpl, token: 't', now: clock.now, sleep: clock.sleep }));
  assert.equal(r.stop, 'rate_limited');
  assert.equal(s.calls.length, 1);
  assert.equal(r.checked.length, 0);
  assert.equal(r.unchecked.length, 60);
});

// A rejected token only means something on the paid route.

test('paid route 401 stops with bad_token; a paid 403 stops as refused, not as a rejected key', async () => {
  const r401 = await checkAll([e(1)], { ...base, fetchImpl: server(() => new Response('{}', { status: 401 })).fetchImpl, token: 't' });
  assert.equal(r401.stop, 'bad_token');
  assert.equal(r401.unchecked.length, 1);
  const r403 = await checkAll([e(1)], { ...base, fetchImpl: server(() => new Response('{}', { status: 403 })).fetchImpl, token: 't' });
  assert.equal(r403.stop, 'refused');
  assert.equal(r403.unchecked.length, 1);
});

test('free route 401 and 403 are errors, not bad_token, so remaining batches still get a chance', async () => {
  for (const status of [401, 403]) {
    const s = server(() => new Response('{}', { status }));
    const r = await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
    assert.equal(r.stop, null);
    assert.equal(r.errors, 1);
    assert.equal(r.unchecked.length, 1);
    assert.equal(r.checked.length, 0);
  }
});

// TensorFeed unreachable: stop after 3 failed batches in a row.

const timeoutError = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('a blackholed server with 60 batches gets at most 3 attempts, then stops as unreachable', async () => {
  const clock = eventClock();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    await clock.sleep(15000);
    throw timeoutError();
  };
  const entries = Array.from({ length: 1200 }, (_, i) => e(i));
  const r = await runPaced(clock, () => checkAll(entries, { ...base, fetchImpl, repoHashHex: 'f'.repeat(64), now: clock.now, sleep: clock.sleep }));
  assert.ok(attempts <= 3, `${attempts} attempts`);
  assert.equal(r.stop, 'unreachable');
  assert.equal(r.checked.length, 0);
  assert.equal(r.unchecked.length, 1200);
});

test('a timed-out request is not retried', async () => {
  const s = server(() => { throw timeoutError(); });
  const r = await checkAll([e(1)], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(s.calls.length, 1);
  assert.deepEqual([r.errors, r.unchecked.length, r.stop], [1, 1, null]);
});

test('the retry after a fast network error waits for its own paced slot', async () => {
  const clock = fakeClock();
  const starts = [];
  const fetchImpl = async (url, init) => {
    starts.push(clock.now());
    if (starts.length === 1) throw new TypeError('fetch failed');
    return ok(url, init);
  };
  const r = await checkAll([e(1)], { ...base, fetchImpl, token: 't', minIntervalMs: 100, concurrency: 1, now: clock.now, sleep: clock.sleep });
  assert.equal(r.checked.length, 1);
  assert.deepEqual(starts, [0, 100]);
});

test('the retry is dropped when another batch stopped the run while it waited', async () => {
  const clock = eventClock();
  const sent = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    const name = JSON.parse(init.body).packages[0].name;
    sent.push(name);
    if (name === 'p0' && first) {
      first = false;
      throw new TypeError('fetch failed');
    }
    return new Response('{}', { status: 402 });
  };
  const entries = Array.from({ length: 40 }, (_, i) => e(i));
  const r = await runPaced(clock, () => checkAll(entries, { ...base, fetchImpl, token: 't', minIntervalMs: 100, concurrency: 2, now: clock.now, sleep: clock.sleep }));
  assert.equal(r.stop, 'no_credits');
  assert.deepEqual(sent, ['p0', 'p20']);
  assert.equal(r.unchecked.length, 40);
});

test('three 5xx batches in a row stop the run as unreachable', async () => {
  const s = server(() => new Response('oops', { status: 503 }));
  const entries = Array.from({ length: 100 }, (_, i) => e(i));
  const r = await checkAll(entries, { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64), concurrency: 1 });
  assert.equal(r.stop, 'unreachable');
  assert.equal(s.calls.length, 3);
  assert.equal(r.unchecked.length, 100);
});

test('connection errors on 3 batches in a row stop the run, each batch retried once', async () => {
  const s = server(() => { throw new TypeError('fetch failed'); });
  const entries = Array.from({ length: 100 }, (_, i) => e(i));
  const r = await checkAll(entries, { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64), concurrency: 1 });
  assert.equal(r.stop, 'unreachable');
  assert.equal(s.calls.length, 6);
});

test('an answered batch resets the failure count', async () => {
  const pattern = [503, 503, 200, 503, 503, 200];
  const s = server((u, init, n) => (pattern[n - 1] === 200 ? ok(u, init) : new Response('oops', { status: 503 })));
  const entries = Array.from({ length: 120 }, (_, i) => e(i));
  const r = await checkAll(entries, { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64), concurrency: 1 });
  assert.equal(r.stop, null);
  assert.equal(r.errors, 4);
  assert.equal(r.checked.length, 40);
});

// Other answers from TensorFeed.

test('a 4xx other than 401, 402, 403, and 429 is a rejected request, not a missing answer', async () => {
  for (const status of [400, 413, 422]) {
    const s = server(() => Response.json({ error: 'bad_request' }, { status }));
    const r = await checkAll([e(1), ...Array.from({ length: 20 }, (_, i) => e(i + 10))], { ...base, fetchImpl: s.fetchImpl, repoHashHex: 'f'.repeat(64), concurrency: 1 });
    assert.deepEqual([r.stop, r.errors, r.rejected, r.unchecked.length, s.calls.length], [null, 0, 2, 21, 2], String(status));
  }
});

test('a result whose name does not match its entry makes the batch an error', async () => {
  const swapped = server((_u, init) => Response.json({ results: JSON.parse(init.body).packages.map((p, i, all) => verdictFor(all[all.length - 1 - i])) }));
  const r = await checkAll([e(1), e(2)], { ...base, fetchImpl: swapped.fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([r.errors, r.checked.length, r.unchecked.length], [1, 0, 2]);
});

test('result names match npm names exactly and PyPI names in PEP 503 form', async () => {
  const py = { ecosystem: 'pypi', name: 'Flask_Cors', version: '4.0.0', lockfile: 'uv.lock' };
  const echo = (rename) => server((_u, init) => Response.json({ results: JSON.parse(init.body).packages.map((p) => ({ ...verdictFor(p), name: rename(p) })) }));
  const pypiOk = await checkAll([py], { ...base, fetchImpl: echo(() => 'flask-cors').fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.equal(pypiOk.checked.length, 1);
  const npmCase = await checkAll([{ ...e(1), name: 'JSONStream' }], { ...base, fetchImpl: echo(() => 'jsonstream').fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([npmCase.errors, npmCase.checked.length], [1, 0]);
  const missing = await checkAll([e(1)], { ...base, fetchImpl: echo(() => undefined).fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([missing.errors, missing.checked.length], [1, 0]);
});

test('the 429 limit_scope and error are passed through for the summary', async () => {
  const ip = await checkAll([e(1)], { ...base, fetchImpl: server(() => Response.json({ limit_scope: 'ip' }, { status: 429 })).fetchImpl, repoHashHex: 'f'.repeat(64) });
  assert.deepEqual([ip.stop, ip.limitScope], ['free_cap', 'ip']);
  const cap = await checkAll([e(1)], { ...base, fetchImpl: server(() => Response.json({ error: 'daily_cap_exceeded' }, { status: 429 })).fetchImpl, token: 't' });
  assert.deepEqual([cap.stop, cap.stopError], ['rate_limited', 'daily_cap_exceeded']);
});
