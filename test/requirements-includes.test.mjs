import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { requirementsIncludeProblem, MAX_INCLUDE_DEPTH } from '../src/requirements-includes.mjs';

const ROOT = path.resolve('/ws');

// Fake fs keyed by workspace-relative path; `links` are symlinks (not regular files).
function fakeFs(files, links = []) {
  const map = new Map(Object.entries(files).map(([rel, t]) => [path.join(ROOT, ...rel.split('/')), t]));
  const linkSet = new Set(links.map((rel) => path.join(ROOT, ...rel.split('/'))));
  const reads = [];
  return {
    reads,
    lstat: (f) => {
      const p = path.resolve(f);
      if (linkSet.has(p)) return { isFile: false, isSymbolicLink: true, size: 0 };
      return map.has(p) ? { isFile: true, isSymbolicLink: false, size: map.get(p).length } : null;
    },
    readFile: (f) => {
      reads.push(path.relative(ROOT, path.resolve(f)).split(path.sep).join('/'));
      return map.has(path.resolve(f)) ? map.get(path.resolve(f)) : null;
    },
  };
}
const check = (files, rel = 'requirements.txt', links = []) => {
  const fs = fakeFs(files, links);
  return { problem: requirementsIncludeProblem(rel, files[rel], { cwd: ROOT, fs }), reads: fs.reads };
};
const INDEX = '--index-url https://pypi.corp.example/simple\nsecret==1.0.0\n';

test('a file without includes has no problem', () => {
  assert.equal(check({ 'requirements.txt': 'requests==2.32.3\n# -r nothing.txt\n' }).problem, null);
});

test('an index option in an included file skips the including file', () => {
  const forms = ['-r base.txt', '--requirement base.txt', '--requirement=base.txt', '-rbase.txt', '-r=base.txt', '-c base.txt', '--constraint base.txt', '--constraint=base.txt', '-cbase.txt', '-r "base.txt"', "-r 'base.txt'", '-r \\\n  base.txt', '  -r base.txt  # shared pins'];
  for (const line of forms) {
    const r = check({ 'requirements.txt': `${line}\nrequests==2.32.3\n`, 'base.txt': INDEX });
    assert.equal(r.problem, 'custom_index', JSON.stringify(line));
  }
});

test('includes resolve relative to the including file, through nested folders', () => {
  const files = {
    'svc/requirements.txt': '-r deps/a.txt\nrequests==2.32.3\n',
    'svc/deps/a.txt': '--requirement=b.txt\nflask==3.0.3\n',
    'svc/deps/b.txt': '-f ./wheels\n',
  };
  assert.equal(check(files, 'svc/requirements.txt').problem, 'custom_index');
});

test('every index option form in an included file counts', () => {
  for (const opt of ['-ihttps://corp/simple', '-i https://corp/simple', '--extra-index-url=https://corp', '--find-links ./wheels', '-f./wheels']) {
    assert.equal(check({ 'requirements.txt': '-r base.txt\n', 'base.txt': `${opt}\n` }).problem, 'custom_index', opt);
  }
});

test('an index option later on an option line counts too', () => {
  assert.equal(check({ 'requirements.txt': '-r base.txt -i https://corp/simple\n', 'base.txt': 'requests==2.32.3\n' }).problem, 'custom_index');
});

test('an include that cannot be read skips the including file', () => {
  const cases = [
    ['-r missing.txt\n', {}, []],
    ['-r ../outside.txt\n', {}, []],
    ['-r /etc/requirements.txt\n', {}, []],
    ['-r https://corp.example/requirements.txt\n', {}, []],
    ['-r file:///ws/base.txt\n', { 'base.txt': 'requests==2.32.3\n' }, []],
    ['-r ${REQS}/base.txt\n', {}, []],
    ['-r linked.txt\n', { 'linked.txt': 'requests==2.32.3\n' }, ['linked.txt']],
    ['requests==2.32.3\n-r\n', {}, []],
  ];
  for (const [text, extra, links] of cases) {
    assert.equal(check({ 'requirements.txt': text, ...extra }, 'requirements.txt', links).problem, 'unreadable_include', JSON.stringify(text));
  }
});

test(`includes up to depth ${MAX_INCLUDE_DEPTH} are followed; one more level is unreadable`, () => {
  const chain = (levels) => {
    const files = { 'requirements.txt': '-r d1.txt\n' };
    for (let i = 1; i <= levels; i++) files[`d${i}.txt`] = i < levels ? `-r d${i + 1}.txt\n` : 'requests==2.32.3\n';
    return files;
  };
  assert.equal(MAX_INCLUDE_DEPTH, 5);
  assert.equal(check(chain(5)).problem, null);
  assert.equal(check(chain(6)).problem, 'unreadable_include');
  const deepIndex = chain(5);
  deepIndex['d5.txt'] = INDEX;
  assert.equal(check(deepIndex).problem, 'custom_index');
});

test('a cycle is followed once per file', () => {
  const r = check({ 'requirements.txt': '-r a.txt\n', 'a.txt': '-r b.txt\n', 'b.txt': '-r a.txt\n-r requirements.txt\n' });
  assert.equal(r.problem, null);
  assert.deepEqual(r.reads.sort(), ['a.txt', 'b.txt']);
});

test('abbreviated long options count as includes and as index options', () => {
  for (const line of ['--req base.txt', '--req=base.txt', '--requir=base.txt', '--requirement=base.txt', '--cons base.txt', '--con=base.txt']) {
    assert.equal(check({ 'requirements.txt': `${line}\n`, 'base.txt': INDEX }).problem, 'custom_index', line);
  }
  for (const opt of ['--index https://corp/simple', '--extra=https://corp', '--fin ./wheels']) {
    assert.equal(check({ 'requirements.txt': '-r base.txt\n', 'base.txt': `${opt}\n` }).problem, 'custom_index', opt);
  }
  assert.equal(check({ 'requirements.txt': '--req\n' }).problem, 'unreadable_include');
  assert.equal(check({ 'requirements.txt': '--r base.txt\n', 'base.txt': INDEX }).problem, 'custom_index');
  assert.equal(check({ 'requirements.txt': '-- base.txt\n', 'base.txt': INDEX }).problem, null);
});
