import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { run, VERSION, makeExec } from '../src/run.mjs';
import { readInputs } from '../src/inputs.mjs';
import { DEFAULT_FREE_URL } from '../src/client.mjs';

const ROOT = path.resolve('/work');
const REG = (n, v) => `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`;
const HEAD_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21', resolved: REG('lodash', '4.17.21') }, 'node_modules/lodahs': { version: '1.0.0', resolved: REG('lodahs', '1.0.0') }, 'node_modules/@corp/x': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/x' } } });
const BASE_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21', resolved: REG('lodash', '4.17.21') } } });
const BASE_SHA = 'b'.repeat(40);

// `links` names files that readdir reports as regular files but lstat reports
// as symlinks (for example a file swapped for a link after the walk).
function harness({ env = {}, files = { 'package-lock.json': HEAD_LOCK }, base = { 'package-lock.json': BASE_LOCK }, fetchImpl, links = [] } = {}) {
  const written = new Map();
  const logs = [];
  const calls = [];
  const reads = [];
  const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const fsDeps = {
    readdir: (d) => (d === ROOT ? Object.keys(files).map((name) => ({ name, isDir: false, isFile: true })) : []),
    readFile: (f) => {
      reads.push(relOf(f));
      const rel = relOf(f);
      if (files[rel] !== undefined) return files[rel];
      if (f.endsWith('event.json')) return JSON.stringify({ pull_request: { base: { sha: BASE_SHA } } });
      return null;
    },
    lstat: (f) => {
      const rel = relOf(f);
      if (files[rel] === undefined) return null;
      return links.includes(rel) ? { isFile: false, isSymbolicLink: true, size: 0 } : { isFile: true, isSymbolicLink: false, size: files[rel].length };
    },
    stat: (f) => {
      const rel = relOf(f);
      return files[rel] !== undefined ? { isFile: true, size: files[rel].length } : null;
    },
    appendFile: (f, d) => written.set(f, (written.get(f) || '') + d),
  };
  const exec = (cmd, args) => {
    if (args[0] === 'fetch') return { status: 0, stdout: '' };
    const rel = args[1].slice(BASE_SHA.length + 1);
    return base[rel] !== undefined ? { status: 0, stdout: base[rel] } : { status: 128, stdout: '' };
  };
  const defaultFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    return Response.json({ ok: true, results: body.packages.map((p) => ({ ecosystem: 'npm', name: p.name, verdict: p.name === 'lodahs' ? 'BLOCK' : 'GO', reasons: p.name === 'lodahs' ? [{ message: 'known malicious' }] : [], did_you_mean: null })) });
  };
  const fullEnv = {
    GITHUB_REPOSITORY: 'Acme/App', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path.join(ROOT, 'event.json'),
    GITHUB_STEP_SUMMARY: '/summary', GITHUB_OUTPUT: '/output',
    INPUT_MODE: 'deny', 'INPUT_FAIL-ON-REVIEW': 'false', 'INPUT_TENSORFEED-TOKEN': '', INPUT_LOCKFILES: '', INPUT_SCAN: 'changed', INPUT_ALLOWLIST: '',
    ...env,
  };
  return { deps: { env: fullEnv, cwd: ROOT, fs: fsDeps, exec, fetchImpl: fetchImpl || defaultFetch, log: (l) => logs.push(l) }, written, logs, calls, reads };
}

test('readInputs applies defaults and parses values', () => {
  assert.deepEqual(readInputs({}), { mode: 'deny', failOnReview: false, token: null, lockfiles: null, scan: 'changed', allowlist: '' });
  assert.deepEqual(readInputs({ INPUT_MODE: 'WARN', 'INPUT_FAIL-ON-REVIEW': 'true', 'INPUT_TENSORFEED-TOKEN': ' t ', INPUT_LOCKFILES: 'a, b', INPUT_SCAN: 'all', INPUT_ALLOWLIST: 'x' }), { mode: 'warn', failOnReview: true, token: 't', lockfiles: ['a', 'b'], scan: 'all', allowlist: 'x' });
});

test('PR run: sends only the changed public package, fails on BLOCK, writes summary and outputs', async () => {
  const h = harness();
  const code = await run(h.deps);
  assert.equal(code, 1);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { packages: [{ ecosystem: 'npm', name: 'lodahs', version: '1.0.0' }] });
  assert.match(h.calls[0].init.headers['X-TF-Repo'], /^[0-9a-f]{64}$/);
  assert.ok(h.written.get('/summary').includes('| BLOCK | lodahs'));
  assert.ok(h.written.get('/summary').includes('1 package was skipped'));
  assert.equal(h.written.get('/output'), 'blocked=1\nreview=0\nchecked=1\nunchecked=0\n');
  assert.ok(h.logs.some((l) => l.startsWith('::error file=package-lock.json')));
  assert.ok(h.logs.some((l) => l.includes('1 package to check')));
});

test('never sends anything but names, versions, repo hash, UA', async () => {
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push' } });
  await run(h.deps);
  for (const c of h.calls) {
    assert.deepEqual(Object.keys(c.body), ['packages']);
    for (const p of c.body.packages) assert.deepEqual(Object.keys(p).sort(), ['ecosystem', 'name', 'version']);
    assert.deepEqual(Object.keys(c.init.headers).sort(), ['Content-Type', 'User-Agent', 'X-TF-Repo']);
    assert.ok(!JSON.stringify(c).includes('Acme/App'));
    assert.ok(!JSON.stringify(c).includes('package-lock.json'));
    assert.ok(!JSON.stringify(c).includes('@corp'));
  }
});

test('warn mode and allowlist never fail; token is masked and used', async () => {
  const warn = harness({ env: { INPUT_MODE: 'warn' } });
  assert.equal(await run(warn.deps), 0);
  const allow = harness({ env: { INPUT_ALLOWLIST: 'lodahs' } });
  assert.equal(await run(allow.deps), 0);
  assert.equal(allow.calls.length, 0);
  const paid = harness({ env: { 'INPUT_TENSORFEED-TOKEN': 'tf_live_secret' } });
  await run(paid.deps);
  assert.equal(paid.logs[0], '::add-mask::tf_live_secret');
  assert.equal(paid.calls[0].init.headers.Authorization, 'Bearer tf_live_secret');
});

test('base fetch failure falls back to scanning everything', async () => {
  const h = harness();
  h.deps.exec = () => ({ status: 1, stdout: '' });
  await run(h.deps);
  assert.deepEqual(h.calls[0].body.packages.map((p) => p.name).sort(), ['lodahs', 'lodash']);
  assert.ok(h.written.get('/summary').includes('could not read the base commit'));
});

test('service down: exit 0, unchecked reported', async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await run(h.deps), 0);
  assert.ok(h.written.get('/output').includes('unchecked=1'));
});

test('insecure premium URL override falls back to the free tier with a warning', async () => {
  const h = harness({ env: { 'INPUT_TENSORFEED-TOKEN': 'tf_live_secret', TENSORFEED_PACKAGE_CHECK_PREMIUM_URL: 'http://example.test/x' } });
  const code = await run(h.deps);
  assert.equal(code, 1);
  assert.equal(h.logs[0], '::add-mask::tf_live_secret');
  assert.ok(h.logs.includes('::warning::TensorFeed package check: the premium URL is not HTTPS, so the token was not used; checking on the free tier.'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, DEFAULT_FREE_URL);
  assert.equal(h.calls[0].init.headers.Authorization, undefined);
  assert.match(h.calls[0].init.headers['X-TF-Repo'], /^[0-9a-f]{64}$/);
});

test('an unparseable lockfile is reported as skipped, not silently dropped', async () => {
  const h = harness({ files: { 'package-lock.json': '{nope' }, base: { 'package-lock.json': '{nope' } });
  const code = await run(h.deps);
  assert.equal(code, 0);
  assert.equal(h.calls.length, 0);
  assert.ok(h.written.get('/summary').includes('Skipped package-lock.json: it is not valid JSON.'));
});

test('the real entry runs end to end and exits 0 when there is nothing to check', () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.mjs');
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: path.join(path.dirname(fileURLToPath(import.meta.url)), 'no-such-dir'), GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'a/b', TENSORFEED_PACKAGE_CHECK_URL: 'http://127.0.0.1:9/' }, timeout: 20000 });
  assert.equal(r.status, 0);
});

test('the action version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.license, 'MIT');
});

test('a lockfile that lstat reports as a symlink is never read', async () => {
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push' }, files: { 'package-lock.json': HEAD_LOCK, 'requirements.txt': 'requests==2.32.3\n' }, links: ['package-lock.json'] });
  await run(h.deps);
  assert.ok(!h.reads.includes('package-lock.json'));
  assert.ok(h.reads.includes('requirements.txt'));
  assert.deepEqual(h.calls.flatMap((c) => c.body.packages.map((p) => p.name)), ['requests']);
});

test('the summary says when more than 50 lockfiles were found', async () => {
  const files = {};
  for (let i = 0; i < 51; i++) files[`requirements-${String(i).padStart(2, '0')}.txt`] = `pkg${i}==1.0.0\n`;
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push' }, files });
  await run(h.deps);
  assert.ok(h.written.get('/summary').includes('More than 50 lockfiles were found, so only the first 50 were read.'));
  assert.equal(h.calls.flatMap((c) => c.body.packages).length, 50);
});

test('the summary says when a lockfile has more than 20,000 packages', async () => {
  const many = Array.from({ length: 20001 }, (_, i) => `p${i}==1.0.0`).join('\n');
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push' }, files: { 'requirements.txt': many } });
  await run(h.deps);
  assert.ok(h.written.get('/summary').includes('requirements.txt has more than 20,000 packages, so only the first 20,000 were read.'));
});

test('git runs with a timeout and never prompts for credentials', () => {
  const seen = [];
  const spawn = (cmd, args, opts) => {
    seen.push({ cmd, args, opts });
    return { status: 0, stdout: 'ok' };
  };
  const exec = makeExec('/work', { PATH: '/bin' }, spawn);
  assert.deepEqual(exec('git', ['status']), { status: 0, stdout: 'ok' });
  assert.equal(seen[0].opts.timeout, 60000);
  assert.equal(seen[0].opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(seen[0].opts.env.PATH, '/bin');
  assert.equal(seen[0].opts.cwd, '/work');
  const timedOut = makeExec('/work', {}, () => ({ status: null, stdout: null, error: new Error('ETIMEDOUT') }));
  assert.deepEqual(timedOut('git', ['fetch']), { status: 1, stdout: '' });
});

function gitCalls(h) {
  const calls = [];
  const inner = h.deps.exec;
  h.deps.exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return inner(cmd, args);
  };
  return calls;
}

test('a pull request with no lockfiles never calls git', async () => {
  const h = harness({ files: {} });
  const calls = gitCalls(h);
  assert.equal(await run(h.deps), 0);
  assert.deepEqual(calls, []);
});

test('push runs and scan: all never call git', async () => {
  for (const env of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'schedule' }, { INPUT_SCAN: 'all' }]) {
    const h = harness({ env });
    const calls = gitCalls(h);
    await run(h.deps);
    assert.deepEqual(calls, [], JSON.stringify(env));
    assert.deepEqual(h.calls[0].body.packages.map((p) => p.name).sort(), ['lodahs', 'lodash']);
  }
});

test('entries with a malformed name or version are dropped before sending and counted as skipped', async () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/lodash': { version: '4.17.21', resolved: REG('lodash', '4.17.21') },
    'node_modules/evil name': { version: '1.0.0', resolved: REG('evil', '1.0.0') },
    [`node_modules/${'a'.repeat(201)}`]: { version: '1.0.0', resolved: REG('a', '1.0.0') },
  } });
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push' }, files: { 'package-lock.json': lock } });
  await run(h.deps);
  assert.deepEqual(h.calls.flatMap((c) => c.body.packages.map((p) => p.name)), ['lodash']);
  assert.ok(h.written.get('/summary').includes('2 packages were skipped'));
  assert.ok(h.logs.some((l) => l.includes('2 with an invalid name or version')));
  assert.ok(!h.written.get('/summary').includes('invalid name'));
});

test('a summary or output file that cannot be written is a warning, and the verdict still decides the exit code', async () => {
  for (const target of ['/summary', '/output']) {
    const h = harness();
    const append = h.deps.fs.appendFile;
    h.deps.fs.appendFile = (f, d) => {
      if (f === target) throw new Error('EROFS: read-only file system');
      return append(f, d);
    };
    assert.equal(await run(h.deps), 1, target);
    assert.ok(h.logs.some((l) => l.startsWith('::warning::TensorFeed package check could not write the')), target);
  }
});

test('the log line and summary count lockfiles and packages in natural words, and allowlisted packages', async () => {
  const h = harness({ env: { GITHUB_EVENT_NAME: 'push', INPUT_ALLOWLIST: 'lodahs' } });
  await run(h.deps);
  assert.ok(h.logs.some((l) => l.startsWith('TensorFeed package check: 1 lockfile, 1 package to check, skipped 1')), h.logs.join('\n'));
  assert.ok(h.written.get('/summary').includes('1 package was skipped by the allowlist.'));
  const none = harness({ env: { INPUT_ALLOWLIST: 'lodahs' } });
  await run(none.deps);
  assert.ok(none.written.get('/summary').includes('No packages were sent to TensorFeed.'));
});
