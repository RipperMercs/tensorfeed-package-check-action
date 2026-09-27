import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findLockfiles, globToRegExp, MAX_LOCKFILES } from '../src/discover.mjs';

// Paths ending in "/" are directories; everything else is a regular file
// unless `special` names it (a symlink, FIFO, or device: neither a file nor
// a directory to readdir).
function fakeTree(files, special = []) {
  const root = path.resolve('/repo');
  const dirs = new Map();
  const add = (rel, kind) => {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = path.join(root, ...parts.slice(0, i));
      if (!dirs.has(dir)) dirs.set(dir, new Map());
      dirs.get(dir).set(parts[i], i < parts.length - 1 ? 'dir' : kind);
    }
  };
  for (const rel of files) add(rel, 'file');
  for (const rel of special) add(rel, 'other');
  return {
    root,
    readdir: (d) => [...(dirs.get(d) || new Map())].map(([name, kind]) => ({ name, isDir: kind === 'dir', isFile: kind === 'file' })),
  };
}

test('finds supported lockfiles and skips vendored folders', () => {
  const t = fakeTree(['package-lock.json', 'apps/web/pnpm-lock.yaml', 'node_modules/x/package-lock.json', '.venv/requirements.txt', 'svc/poetry.lock', 'README.md', 'svc/requirements-dev.txt']);
  assert.deepEqual(findLockfiles(t.root, t), { files: ['package-lock.json', 'svc/poetry.lock', 'svc/requirements-dev.txt', 'apps/web/pnpm-lock.yaml'], truncated: false });
});

test('globs restrict the set', () => {
  const t = fakeTree(['package-lock.json', 'apps/web/package-lock.json', 'apps/api/uv.lock']);
  assert.deepEqual(findLockfiles(t.root, t, [globToRegExp('apps/**/package-lock.json')]).files, ['apps/web/package-lock.json']);
  assert.ok(globToRegExp('*.lock').test('uv.lock'));
  assert.ok(!globToRegExp('*.lock').test('a/uv.lock'));
});

test('stops at MAX_LOCKFILES and says the list was cut', () => {
  const files = Array.from({ length: MAX_LOCKFILES + 10 }, (_, i) => `p${String(i).padStart(3, '0')}/package-lock.json`);
  const r = findLockfiles(fakeTree(files).root, fakeTree(files));
  assert.equal(r.files.length, MAX_LOCKFILES);
  assert.equal(r.truncated, true);
});

test('exactly MAX_LOCKFILES lockfiles is not a cut list', () => {
  const files = Array.from({ length: MAX_LOCKFILES }, (_, i) => `p${String(i).padStart(3, '0')}/package-lock.json`);
  const r = findLockfiles(fakeTree(files).root, fakeTree(files));
  assert.equal(r.files.length, MAX_LOCKFILES);
  assert.equal(r.truncated, false);
});

test('only regular files are lockfile candidates: symlinks, FIFOs, and devices are ignored', () => {
  const t = fakeTree(['svc/requirements.txt'], ['package-lock.json', 'apps/yarn.lock', 'svc/requirements-dev.txt']);
  assert.deepEqual(findLockfiles(t.root, t).files, ['svc/requirements.txt']);
});
