import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tally, annotations, exitCode, buildSummary } from '../src/report.mjs';

const item = (name, verdict, extra = {}) => ({
  entry: { ecosystem: 'npm', name, version: '1.0.0', lockfile: 'apps/web/package-lock.json' },
  result: { verdict, reasons: verdict === 'GO' ? [] : [{ code: 'x', message: `${name} msg | with pipe`, source_url: 'https://osv.dev/vulnerability/X' }], did_you_mean: null, ...extra },
});
const checked = [item('good', 'GO'), item('bad', 'BLOCK'), item('meh', 'REVIEW'), item('gone', 'NOT_FOUND', { did_you_mean: 'good' }), item('down', 'UNKNOWN')];
const meta = { scanned: 'changed', fallbackAll: false, lockfiles: 1, sent: 5, skipped: 3, skippedFiles: [], paid: false };

test('tally counts every verdict and unchecked', () => {
  assert.deepEqual(tally(checked, [{}]), { blocked: 1, review: 1, notFound: 1, unknown: 1, go: 1, checked: 5, unchecked: 1 });
});

test('annotations: error per BLOCK, warning per REVIEW, escaped', () => {
  const a = annotations([item('bad', 'BLOCK'), item('meh', 'REVIEW'), item('good', 'GO')]);
  assert.equal(a.length, 2);
  assert.match(a[0], /^::error file=apps\/web\/package-lock\.json,title=TensorFeed%3A BLOCK::bad 1\.0\.0: /);
  assert.match(a[1], /^::warning /);
  const nl = annotations([{ entry: { name: 'x', version: '1', lockfile: 'a,b:c' }, result: { verdict: 'BLOCK', reasons: [{ message: 'line1\nline2 100%' }] } }]);
  assert.equal(nl[0], '::error file=a%2Cb%3Ac,title=TensorFeed%3A BLOCK::x 1: line1%0Aline2 100%25');
});

test('exitCode: deny fails on BLOCK, warn never, fail-on-review adds REVIEW', () => {
  assert.equal(exitCode(checked, { mode: 'deny', failOnReview: false }), 1);
  assert.equal(exitCode(checked, { mode: 'warn', failOnReview: false }), 0);
  assert.equal(exitCode([item('meh', 'REVIEW')], { mode: 'deny', failOnReview: true }), 1);
  assert.equal(exitCode([item('meh', 'REVIEW')], { mode: 'deny', failOnReview: false }), 0);
  assert.equal(exitCode([], { mode: 'deny', failOnReview: true }), 0);
});

test('summary: table with BLOCK first, escaped pipes, skipped and privacy lines', () => {
  const s = buildSummary({ checked, unchecked: [], stop: null, errors: 0, meta });
  assert.match(s, /^## TensorFeed Package Check/);
  assert.ok(s.indexOf('| BLOCK | bad') < s.indexOf('| REVIEW | meh'));
  assert.ok(s.includes('bad msg \\| with pipe'));
  assert.ok(s.includes('Did you mean good?'));
  assert.ok(s.includes('3 packages were skipped'));
  assert.ok(s.includes('hashed repository ID'));
  assert.ok(!/[\u2013\u2014]/.test(s));
});

test('summary explains the free cap, missing credits, errors, and fallback', () => {
  const unchecked = [{}, {}];
  assert.ok(buildSummary({ checked: [], unchecked, stop: 'free_cap', errors: 0, meta }).includes('Free daily limit reached for this repository'));
  assert.ok(buildSummary({ checked: [], unchecked, stop: 'no_credits', errors: 0, meta: { ...meta, paid: true } }).includes('out of credits'));
  assert.ok(buildSummary({ checked: [], unchecked, stop: 'bad_token', errors: 0, meta: { ...meta, paid: true } }).includes('rejected'));
  assert.ok(buildSummary({ checked: [], unchecked, stop: null, errors: 1, meta }).includes('did not answer'));
  assert.ok(buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, fallbackAll: true } }).includes('could not read the base commit'));
});

test('summary: rate_limited stop message', () => {
  const s = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'rate_limited', errors: 0, meta });
  assert.ok(s.includes('rate-limited this run'));
  assert.ok(!s.includes('Free daily limit'));
});

test('summary: invalid_json skipped file reason', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, skippedFiles: [{ file: 'package-lock.json', reason: 'invalid_json' }] } });
  assert.ok(s.includes('it is not valid JSON'));
});

test('summary: natural plural for 1 package skipped', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, skipped: 1, skippedFiles: [] } });
  assert.ok(s.includes('1 package was skipped because its source is not the public npm or PyPI registry (private registries, git, local paths, or no recorded source). It was not sent.'));
  assert.ok(!s.includes('1 packages'));
});

test('summary: natural plural for 3 packages skipped', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, skipped: 3, skippedFiles: [] } });
  assert.ok(s.includes('3 packages were skipped because their source is not the public npm or PyPI registry (private registries, git, local paths, or no recorded source). They were not sent.'));
});

test('summary: natural plural for stop messages', () => {
  const singleUnchecked = { checked: [], unchecked: [{}], stop: 'free_cap', errors: 0, meta };
  const s1 = buildSummary(singleUnchecked);
  assert.ok(s1.includes('1 package was not checked'));
  assert.ok(!s1.includes('1 packages'));
});

test('summary: safe source links reject javascript: scheme', () => {
  const itemWithBadLink = (name, verdict) => ({
    entry: { ecosystem: 'npm', name, version: '1.0.0', lockfile: 'apps/web/package-lock.json' },
    result: { verdict, reasons: [{ code: 'x', message: `${name} msg`, source_url: 'javascript:alert(1)' }], did_you_mean: null },
  });
  const s = buildSummary({ checked: [itemWithBadLink('bad', 'BLOCK')], unchecked: [], stop: null, errors: 0, meta });
  assert.ok(!s.includes('[source](javascript'));
});

test('summary: safe source links keep https://', () => {
  const itemWithGoodLink = (name, verdict) => ({
    entry: { ecosystem: 'npm', name, version: '1.0.0', lockfile: 'apps/web/package-lock.json' },
    result: { verdict, reasons: [{ code: 'x', message: `${name} msg`, source_url: 'https://osv.dev/vulnerability/X' }], did_you_mean: null },
  });
  const s = buildSummary({ checked: [itemWithGoodLink('bad', 'BLOCK')], unchecked: [], stop: null, errors: 0, meta });
  assert.ok(s.includes('[source](https://osv.dev/vulnerability/X)'));
});

test('summary: stop and errors together cite different counts', () => {
  const s = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'free_cap', errors: 1, meta });
  assert.ok(s.includes('2 packages were not checked'));
  assert.ok(s.includes('One request to TensorFeed did not answer, so its packages were not checked.'));
  const s2 = buildSummary({ checked: [], unchecked: [{}, {}, {}], stop: 'free_cap', errors: 3, meta });
  assert.ok(s2.includes('3 requests to TensorFeed did not answer, so their packages were not checked.'));
});

test('summary: says when the lockfile cap or the per-file entry cap cut the scan', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, tooManyLockfiles: true, truncatedFiles: ['apps/big/package-lock.json'] } });
  assert.ok(s.includes('More than 50 lockfiles were found, so only the first 50 were read. Use the `lockfiles` input to choose which lockfiles to check.'));
  assert.ok(s.includes('apps/big/package-lock.json has more than 20,000 packages, so only the first 20,000 were read. Use the `lockfiles` input to choose which lockfiles to check.'));
  const plain = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta });
  assert.ok(!plain.includes('More than 50 lockfiles'));
  assert.ok(!plain.includes('20,000'));
});

test('summary: pip or uv pointed at another index skips the requirements file with a reason', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, skippedFiles: [{ file: 'svc/requirements.txt', reason: 'custom_index_env' }] } });
  assert.ok(s.includes('Skipped svc/requirements.txt: pip or uv is configured to use a custom package index.'));
});

test('summary: explains packages skipped because of registry settings', () => {
  const notes = [{ file: 'pnpm-lock.yaml', count: 1, config: '.npmrc' }, { file: 'apps/web/yarn.lock', count: 4, config: '.yarnrc.yml' }];
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, registryNotes: notes } });
  assert.ok(s.includes("1 package in pnpm-lock.yaml was skipped because the registry settings in `.npmrc` or this job's environment do not confirm it comes from the public npm registry."));
  assert.ok(s.includes("4 packages in apps/web/yarn.lock were skipped because the registry settings in `.yarnrc.yml` or this job's environment do not confirm they come from the public npm registry."));
});

test('summary: the footer says only packages recorded as public were sent', () => {
  const free = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta });
  assert.ok(free.includes('Only package names and versions recorded as coming from the public npm and PyPI registries, a hashed repository ID, and the action version were sent to TensorFeed.'));
  const paid = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, paid: true } });
  assert.ok(paid.includes('Only package names and versions recorded as coming from the public npm and PyPI registries, the action version, and your TensorFeed key (over HTTPS) were sent to TensorFeed.'));
});

test('summary: unreachable stop line, singular and plural, without a second did-not-answer line', () => {
  const many = buildSummary({ checked: [], unchecked: [{}, {}, {}], stop: 'unreachable', errors: 3, meta });
  assert.ok(many.includes('TensorFeed could not be reached, so 3 packages were not checked. The job was not failed for this.'));
  assert.ok(!many.includes('did not answer'));
  const one = buildSummary({ checked: [], unchecked: [{}], stop: 'unreachable', errors: 3, meta });
  assert.ok(one.includes('TensorFeed could not be reached, so 1 package was not checked. The job was not failed for this.'));
});

test('summary: the free cap text follows limit_scope', () => {
  const repo = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'free_cap', limitScope: 'repo', errors: 0, meta });
  assert.ok(repo.includes('Free daily limit reached for this repository (1,000 package checks per UTC day). 2 packages were not checked.'));
  const ip = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'free_cap', limitScope: 'ip', errors: 0, meta });
  assert.ok(ip.includes('The free per-IP daily limit was reached. 2 packages were not checked.'));
  assert.ok(!ip.includes('for this repository'));
});

test('summary: a paid 429 for the daily cap says so instead of asking for a re-run', () => {
  for (const stopError of ['daily_cap_exceeded', 'key_cap_reached']) {
    const s = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'rate_limited', stopError, errors: 0, meta: { ...meta, paid: true } });
    assert.ok(s.includes("Your TensorFeed key reached its daily cap. 2 packages were not checked. The job was not failed for this."), stopError);
    assert.ok(!s.includes('re-run the job'));
  }
  const plain = buildSummary({ checked: [], unchecked: [{}], stop: 'rate_limited', stopError: 'too_many_requests', errors: 0, meta: { ...meta, paid: true } });
  assert.ok(plain.includes('re-run the job'));
});

test('summary: a paid 403 says TensorFeed refused the request', () => {
  const s = buildSummary({ checked: [], unchecked: [{}, {}], stop: 'refused', errors: 0, meta: { ...meta, paid: true } });
  assert.ok(s.includes('TensorFeed refused the request. 2 packages were not checked. The job was not failed for this.'));
  assert.ok(!s.includes('key was rejected'));
});

test('summary: rejected requests do not say "did not answer"', () => {
  const two = buildSummary({ checked: [], unchecked: [{}, {}], stop: null, errors: 0, rejected: 2, meta });
  assert.ok(two.includes('2 requests were rejected by TensorFeed, so their packages were not checked.'));
  assert.ok(!two.includes('did not answer'));
  const one = buildSummary({ checked: [], unchecked: [{}], stop: null, errors: 0, rejected: 1, meta });
  assert.ok(one.includes('One request was rejected by TensorFeed, so its packages were not checked.'));
});

test('exitCode: fail-on-review also fails on BLOCK in warn mode', () => {
  assert.equal(exitCode([item('bad', 'BLOCK')], { mode: 'warn', failOnReview: true }), 1);
  assert.equal(exitCode([item('bad', 'BLOCK')], { mode: 'warn', failOnReview: false }), 0);
  assert.equal(exitCode([item('good', 'GO')], { mode: 'warn', failOnReview: true }), 0);
});

test('summary: lockfile and package counts use natural singular and plural', () => {
  const one = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, lockfiles: 1, sent: 1 } });
  assert.ok(one.includes('across 1 lockfile; 1 package was queued for checking.'));
  const two = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, lockfiles: 2, sent: 2 } });
  assert.ok(two.includes('across 2 lockfiles; 2 packages were queued for checking.'));
  assert.ok(!one.includes('(s)') && !two.includes('(s)'));
});

test('summary: the footer does not claim anything was sent when nothing was', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, sent: 0 } });
  assert.ok(s.includes('No packages were sent to TensorFeed.'));
  assert.ok(!s.includes('Only package names'));
});

test('summary: the table stops at 200 rows and says how many more there are', () => {
  const many = Array.from({ length: 250 }, (_, i) => item(`bad${i}`, 'BLOCK'));
  const s = buildSummary({ checked: many, unchecked: [], stop: null, errors: 0, meta });
  assert.equal(s.split('\n').filter((l) => l.startsWith('| BLOCK |')).length, 200);
  assert.ok(s.includes('and 50 more'));
  const few = buildSummary({ checked: many.slice(0, 200), unchecked: [], stop: null, errors: 0, meta });
  assert.ok(!few.includes('more |'));
});

test('summary: counts packages skipped by the allowlist', () => {
  assert.ok(buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, allowlisted: 3 } }).includes('3 packages were skipped by the allowlist.'));
  assert.ok(buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, allowlisted: 1 } }).includes('1 package was skipped by the allowlist.'));
  assert.ok(!buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta }).includes('allowlist'));
});

test('summary: an include that could not be read has its own reason', () => {
  const s = buildSummary({ checked: [], unchecked: [], stop: null, errors: 0, meta: { ...meta, skippedFiles: [{ file: 'requirements.txt', reason: 'unreadable_include' }] } });
  assert.ok(s.includes('Skipped requirements.txt: it includes another requirements file that could not be read.'));
});
