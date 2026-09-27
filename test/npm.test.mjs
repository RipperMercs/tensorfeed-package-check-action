import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNpmLock } from '../src/lockfiles/npm.mjs';

const REG = (n, v) => `https://registry.npmjs.org/${n}/-/${n.split('/').pop()}-${v}.tgz`;
const pk = (name, version) => ({ ecosystem: 'npm', name, version });

test('v3 lockfile: packages map, nested copies, scoped, alias, link, private, missing resolved', () => {
  const lock = {
    name: 'app', lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/lodash': { version: '4.17.21', resolved: REG('lodash', '4.17.21') },
      'node_modules/a/node_modules/lodash': { version: '4.17.15', resolved: REG('lodash', '4.17.15') },
      'node_modules/@types/node': { version: '20.11.0', resolved: REG('@types/node', '20.11.0') },
      'node_modules/my-alias': { name: 'left-pad', version: '1.3.0', resolved: REG('left-pad', '1.3.0') },
      'node_modules/local-lib': { resolved: 'packages/local-lib', link: true },
      'packages/local-lib': { version: '0.0.1' },
      'node_modules/@corp/secret': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/download/@corp/secret/1.0.0/abc' },
      'node_modules/no-resolved': { version: '1.0.0', integrity: 'sha512-x' },
      'node_modules/git-dep': { version: '1.0.0', resolved: 'git+ssh://git@github.com/u/r.git#abc' },
    },
  };
  const r = parseNpmLock(JSON.stringify(lock));
  assert.deepEqual(r.entries, [pk('lodash', '4.17.21'), pk('lodash', '4.17.15'), pk('@types/node', '20.11.0'), pk('left-pad', '1.3.0')]);
  assert.equal(r.skipped, 4);
});

test('v1 lockfile: nested dependencies and npm: aliases', () => {
  const lock = {
    lockfileVersion: 1,
    dependencies: {
      express: { version: '4.19.2', resolved: REG('express', '4.19.2'), dependencies: { debug: { version: '2.6.9', resolved: REG('debug', '2.6.9') } } },
      aliased: { version: 'npm:chalk@5.3.0', resolved: REG('chalk', '5.3.0') },
      priv: { version: '1.0.0', resolved: 'https://corp.example/priv-1.0.0.tgz' },
    },
  };
  const r = parseNpmLock(JSON.stringify(lock));
  assert.deepEqual(r.entries, [pk('express', '4.19.2'), pk('debug', '2.6.9'), pk('chalk', '5.3.0')]);
  assert.equal(r.skipped, 1);
});

test('invalid JSON reports an error and no entries', () => {
  assert.deepEqual(parseNpmLock('{nope'), { entries: [], skipped: 0, error: 'invalid_json' });
});

test('v2 lockfile with both packages and dependencies counts each package once', () => {
  const lock = {
    lockfileVersion: 2,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/lodash': { version: '4.17.21', resolved: REG('lodash', '4.17.21') },
      'node_modules/@corp/secret': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/download/@corp/secret/1.0.0/abc' },
    },
    dependencies: {
      lodash: { version: '4.17.21', resolved: REG('lodash', '4.17.21') },
      '@corp/secret': { version: '1.0.0', resolved: 'https://npm.pkg.github.com/download/@corp/secret/1.0.0/abc' },
    },
  };
  const r = parseNpmLock(JSON.stringify(lock));
  assert.deepEqual(r.entries, [pk('lodash', '4.17.21')]);
  assert.equal(r.skipped, 1);
});
