// Sends package names and versions to TensorFeed in batches of 20.
// Free route: X-TF-Repo (hashed repo id). Paid route: Bearer token.
// 402 stops with no_credits. On the paid route a 401 stops with bad_token
// and a 403 stops with refused; on the free route (no token to reject) both
// are reported as a plain error so remaining batches still get a chance.
// Any other 4xx is a rejected request. A 200 whose results do not line up
// with the batch, name by name, is an error. Everything unsent when a run
// stops is "unchecked".
//
// 429 handling: only a free-route 429 whose body has limit_scope 'repo' or
// 'ip' is the free daily limit. Any other 429 (a paid-route 429, or a
// free-route 429 without limit_scope) is a plain rate limit. The body's
// limit_scope and error are passed on so the summary can say which limit was
// hit. Never sleep on Retry-After here: stop and report.
//
// Paid-route pacing: when a token is set, request STARTS are spaced at least
// minIntervalMs apart across every concurrent worker (one shared schedule,
// not one per worker), so the action never sends a burst of paid requests.
//
// Unreachable: a timeout is never retried; a fast network error is retried
// once, in its own paced slot, and only if the run has not stopped. After 3
// failed batches in a row (network error, timeout, or 5xx) the run stops with
// 'unreachable'. While batches are failing, no more batches are in flight
// than failures remain before that stop, so a server that never answers gets
// at most 3 attempts.
import { pep503 } from './lockfiles/common.mjs';

export const BATCH_SIZE = 20;
export const DEFAULT_FREE_URL = 'https://tensorfeed.ai/api/security/package-check';
export const DEFAULT_PREMIUM_URL = 'https://tensorfeed.ai/api/premium/security/package-check';

// At most 90 requests per minute when a token is set; no pacing without one.
const DEFAULT_PAID_MIN_INTERVAL_MS = 667;
const DEFAULT_FREE_MIN_INTERVAL_MS = 0;
const MAX_FAILED_IN_A_ROW = 3;

export async function repoHash(repo) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(repo).toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function batches(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function isTimeout(err, signal) {
  return Boolean(signal.aborted || (err && (err.name === 'TimeoutError' || err.name === 'AbortError')));
}

// One request for one batch; checkAll decides about retries. `unreachable`
// marks a failure that counts toward the unreachable stop, `retry` a fast
// network error worth one more try.
async function sendOnce(group, o) {
  const paid = Boolean(o.token);
  const url = paid ? o.premiumUrl : o.freeUrl;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `tensorfeed-package-check-action/${o.version}` };
  if (paid) headers.Authorization = `Bearer ${o.token}`;
  else headers['X-TF-Repo'] = o.repoHashHex;
  const body = JSON.stringify({ packages: group.map((e) => ({ ecosystem: e.ecosystem, name: e.name, version: e.version })) });
  const fetchFn = o.fetchImpl;
  const signal = AbortSignal.timeout(o.timeoutMs);
  let resp;
  try {
    resp = await fetchFn(url, { method: 'POST', headers, body, signal });
  } catch (err) {
    const timedOut = isTimeout(err, signal);
    return { kind: 'error', unreachable: true, retry: !timedOut };
  }
  if (resp.status === 429) {
    let j = null;
    try {
      j = await resp.json();
    } catch {
      j = null;
    }
    const limitScope = j && typeof j.limit_scope === 'string' ? j.limit_scope : undefined;
    const error = j && typeof j.error === 'string' ? j.error : undefined;
    if (!paid && (limitScope === 'repo' || limitScope === 'ip')) return { kind: 'stop', reason: 'free_cap', limitScope };
    return { kind: 'stop', reason: 'rate_limited', error };
  }
  if (resp.status === 402) return { kind: 'stop', reason: 'no_credits' };
  if (resp.status === 401 || resp.status === 403) {
    // A rejected key only means something on the paid route. On the free
    // route a 401/403 is more likely an edge block; report it as a plain
    // error rather than telling a keyless user their (nonexistent) key was
    // rejected.
    if (!paid) return { kind: 'error' };
    return { kind: 'stop', reason: resp.status === 401 ? 'bad_token' : 'refused' };
  }
  if (resp.status >= 500) return { kind: 'error', unreachable: true };
  if (resp.status >= 400 && resp.status < 500) return { kind: 'rejected' };
  if (resp.status !== 200) return { kind: 'error' };
  let j;
  try {
    j = await resp.json();
  } catch (err) {
    // A body that stalls until the timeout is as good as no answer.
    return { kind: 'error', unreachable: isTimeout(err, signal) };
  }
  if (!j || !Array.isArray(j.results) || j.results.length !== group.length) return { kind: 'error' };
  if (!group.every((entry, i) => sameName(entry, j.results[i]))) return { kind: 'error' };
  return { kind: 'ok', results: j.results };
}

// Each result must be for the entry at the same index: npm names match
// exactly, PyPI names in PEP 503 form.
function sameName(entry, result) {
  if (!result || typeof result.name !== 'string') return false;
  return entry.ecosystem === 'pypi' ? pep503(result.name) === pep503(entry.name) : result.name === entry.name;
}

export async function checkAll(entries, opts) {
  const o = {
    timeoutMs: 15000,
    concurrency: 2,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...opts,
  };
  if (o.minIntervalMs === undefined) {
    o.minIntervalMs = o.token ? DEFAULT_PAID_MIN_INTERVAL_MS : DEFAULT_FREE_MIN_INTERVAL_MS;
  }
  const groups = batches(entries, BATCH_SIZE);
  const results = new Array(groups.length).fill(null);
  let stop = null;
  let stopDetail = {};
  let errors = 0;
  let rejected = 0;
  let next = 0;
  // One shared schedule for every worker: the next moment a request is
  // allowed to start. Reserving a slot (reading and bumping nextStartAt) is
  // synchronous, with no await in between, so concurrent workers never
  // double-book the same slot.
  let nextStartAt = 0;
  const pace = async () => {
    if (o.minIntervalMs <= 0) return;
    const wait = nextStartAt - o.now();
    nextStartAt = Math.max(o.now(), nextStartAt) + o.minIntervalMs;
    if (wait > 0) await o.sleep(wait);
  };
  // Failed batches in a row, and batches in flight. A worker waits while the
  // two together would reach the unreachable limit, so a server that never
  // answers sees at most MAX_FAILED_IN_A_ROW batches.
  let failedInARow = 0;
  let inFlight = 0;
  let waiting = [];
  const wake = () => {
    const w = waiting;
    waiting = [];
    for (const resolve of w) resolve();
  };
  const gate = async () => {
    while (!stop && failedInARow > 0 && failedInARow + inFlight >= MAX_FAILED_IN_A_ROW) {
      await new Promise((resolve) => waiting.push(resolve));
    }
  };
  const worker = async () => {
    while (next < groups.length && !stop) {
      await gate();
      if (stop || next >= groups.length) break;
      const i = next++;
      inFlight++;
      let r = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        await pace();
        // Another worker may have set stop while this one was paced-out
        // waiting for its slot (first try or retry). Check again before
        // actually sending: results[i] stays null, so this batch is
        // correctly reported as unchecked.
        if (stop) {
          r = null;
          break;
        }
        r = await sendOnce(groups[i], o);
        if (!(r.kind === 'error' && r.retry)) break;
      }
      inFlight--;
      if (r === null) {
        wake();
        break;
      }
      if (r.kind === 'ok') {
        results[i] = r.results;
        failedInARow = 0;
      } else if (r.kind === 'stop') {
        if (stop === null) {
          stop = r.reason;
          stopDetail = { limitScope: r.limitScope, stopError: r.error };
        }
      } else if (r.kind === 'rejected') {
        // TensorFeed answered, so it is reachable.
        rejected++;
        failedInARow = 0;
      } else {
        errors++;
        if (r.unreachable) {
          failedInARow++;
          if (failedInARow >= MAX_FAILED_IN_A_ROW) stop = stop ?? 'unreachable';
        } else {
          failedInARow = 0;
        }
      }
      wake();
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, groups.length) }, worker));
  const checked = [];
  const unchecked = [];
  groups.forEach((g, i) => {
    if (results[i]) g.forEach((entry, j) => checked.push({ entry, result: results[i][j] }));
    else unchecked.push(...g);
  });
  return { checked, unchecked, stop, errors, rejected, limitScope: stopDetail.limitScope, stopError: stopDetail.stopError };
}
