import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prBaseSha, readBaseFiles, changedEntries, dedupeEntries } from '../src/diff.mjs';

const npm = (name, version, lockfile = 'package-lock.json') => ({ ecosystem: 'npm', name, version, lockfile });
const py = (name, version) => ({ ecosystem: 'pypi', name, version, lockfile: 'uv.lock' });
const SHA = 'a'.repeat(40);

test('prBaseSha reads pull_request events only and validates the sha', () => {
  assert.equal(prBaseSha('pull_request', { pull_request: { base: { sha: SHA } } }), SHA);
  assert.equal(prBaseSha('push', { pull_request: { base: { sha: SHA } } }), null);
  assert.equal(prBaseSha('pull_request', { pull_request: { base: { sha: 'HEAD; rm -rf /' } } }), null);
  assert.equal(prBaseSha('pull_request', null), null);
});

test('changedEntries: new packages and changed versions only', () => {
  const base = [npm('lodash', '4.17.20'), npm('react', '18.2.0'), py('Flask_Cors', '4.0.0')];
  const head = [npm('lodash', '4.17.21'), npm('react', '18.2.0'), npm('left-pad', '1.3.0'), py('flask-cors', '4.0.0')];
  assert.deepEqual(changedEntries(head, base), [npm('lodash', '4.17.21'), npm('left-pad', '1.3.0')]);
});

test('changedEntries: several versions of one package, only the bumped copy', () => {
  const base = [npm('debug', '2.6.9'), npm('debug', '4.3.4')];
  const head = [npm('debug', '2.6.9'), npm('debug', '4.3.5')];
  assert.deepEqual(changedEntries(head, base), [npm('debug', '4.3.5')]);
});

test('a brand-new lockfile checks everything; a deleted one checks nothing', () => {
  assert.deepEqual(changedEntries([npm('a', '1.0.0'), npm('b', '2.0.0')], []), [npm('a', '1.0.0'), npm('b', '2.0.0')]);
  assert.deepEqual(changedEntries([], [npm('a', '1.0.0')]), []);
});

test('dedupeEntries keeps the first of identical name and version', () => {
  assert.deepEqual(dedupeEntries([npm('a', '1.0.0', 'x/package-lock.json'), npm('a', '1.0.0', 'y/package-lock.json'), npm('a', '1.0.1')]), [npm('a', '1.0.0', 'x/package-lock.json'), npm('a', '1.0.1')]);
});

// A fake git: `hasBase` says whether the base commit is already local,
// `shallow` is what `git rev-parse --is-shallow-repository` prints.
function fakeGit({ hasBase, shallow }) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'cat-file') return { status: hasBase ? 0 : 1, stdout: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${shallow}\n` };
    if (args[0] === 'fetch') return { status: 0, stdout: '' };
    if (args[1] === `${SHA}:package-lock.json`) return { status: 0, stdout: '{"packages":{}}' };
    return { status: 128, stdout: '' };
  };
  return { exec, calls };
}

test('readBaseFiles skips the fetch when the base commit is already present', () => {
  const g = fakeGit({ hasBase: true, shallow: false });
  const m = readBaseFiles(SHA, ['package-lock.json', 'new/uv.lock'], g.exec);
  assert.equal(m.get('package-lock.json'), '{"packages":{}}');
  assert.equal(m.get('new/uv.lock'), null);
  assert.equal(g.calls[0], `git cat-file -e ${SHA}^{commit}`);
  assert.ok(!g.calls.some((c) => c.startsWith('git fetch')));
});

test('readBaseFiles fetches only the base commit into a shallow clone', () => {
  const g = fakeGit({ hasBase: false, shallow: true });
  const m = readBaseFiles(SHA, ['package-lock.json'], g.exec);
  assert.equal(m.get('package-lock.json'), '{"packages":{}}');
  assert.deepEqual(g.calls.slice(0, 3), [`git cat-file -e ${SHA}^{commit}`, 'git rev-parse --is-shallow-repository', `git fetch --no-tags --depth=1 origin ${SHA}`]);
});

test('readBaseFiles never makes a full clone shallow', () => {
  const g = fakeGit({ hasBase: false, shallow: false });
  const m = readBaseFiles(SHA, ['package-lock.json'], g.exec);
  assert.equal(m.get('package-lock.json'), '{"packages":{}}');
  assert.ok(g.calls.includes(`git fetch --no-tags origin ${SHA}`));
  assert.ok(!g.calls.some((c) => c.includes('--depth')));
});

test('readBaseFiles returns null when the fetch fails', () => {
  assert.equal(readBaseFiles(SHA, ['package-lock.json'], () => ({ status: 1, stdout: '' })), null);
});
