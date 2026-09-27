import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockfileKind, parseLockfile, MAX_ENTRIES } from '../src/lockfiles/index.mjs';

test('lockfileKind recognizes every supported file', () => {
  assert.equal(lockfileKind('package-lock.json'), 'npm');
  assert.equal(lockfileKind('apps/web/npm-shrinkwrap.json'), 'npm');
  assert.equal(lockfileKind('pnpm-lock.yaml'), 'pnpm');
  assert.equal(lockfileKind('yarn.lock'), 'yarn');
  assert.equal(lockfileKind('svc/poetry.lock'), 'poetry');
  assert.equal(lockfileKind('uv.lock'), 'uv');
  assert.equal(lockfileKind('requirements.txt'), 'requirements');
  assert.equal(lockfileKind('requirements-dev.txt'), 'requirements');
  assert.equal(lockfileKind('package.json'), null);
  assert.equal(lockfileKind('notes.txt'), null);
});

test('parseLockfile tags entries with their lockfile and caps entries', () => {
  const r = parseLockfile('requirements.txt', 'requests==2.32.3' + String.fromCharCode(10));
  assert.deepEqual(r.entries, [{ ecosystem: 'pypi', name: 'requests', version: '2.32.3', lockfile: 'requirements.txt' }]);
  assert.equal(r.truncated, false);
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `p${i}==1.0.${i}`).join(String.fromCharCode(10));
  const capped = parseLockfile('requirements.txt', many);
  assert.equal(capped.entries.length, MAX_ENTRIES);
  assert.equal(capped.truncated, true);
});

test('parseLockfile strips BOM from npm JSON', () => {
  const lock = { packages: { '': { name: 'app', version: '1.0.0' }, 'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } }, lockfileVersion: 3 };
  const bom = String.fromCharCode(0xFEFF) + JSON.stringify(lock);
  const r = parseLockfile('package-lock.json', bom);
  assert.deepEqual(r.entries, [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21', lockfile: 'package-lock.json' }]);
});

test('parseLockfile strips BOM from requirements.txt', () => {
  const bom = String.fromCharCode(0xFEFF) + 'requests==2.32.3' + String.fromCharCode(10);
  const r = parseLockfile('requirements.txt', bom);
  assert.deepEqual(r.entries, [{ ecosystem: 'pypi', name: 'requests', version: '2.32.3', lockfile: 'requirements.txt' }]);
});
