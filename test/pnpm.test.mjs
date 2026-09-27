import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePnpmLock, parsePnpmKey } from '../src/lockfiles/pnpm.mjs';

const pk = (name, version) => ({ ecosystem: 'npm', name, version });

test('parsePnpmKey handles v5, v6, v9, scoped, peers, quotes', () => {
  assert.deepEqual(parsePnpmKey('/lodash/4.17.21'), { name: 'lodash', version: '4.17.21' });
  assert.deepEqual(parsePnpmKey('/@types/node/20.11.0'), { name: '@types/node', version: '20.11.0' });
  assert.deepEqual(parsePnpmKey('/react-dom/18.2.0_react@18.2.0'), { name: 'react-dom', version: '18.2.0' });
  assert.deepEqual(parsePnpmKey('/@testing-library/react/14.0.0_react@18.2.0'), { name: '@testing-library/react', version: '14.0.0' });
  assert.deepEqual(parsePnpmKey('nonsense'), { name: null, version: null });
  assert.deepEqual(parsePnpmKey('/lodash@4.17.21'), { name: 'lodash', version: '4.17.21' });
  assert.deepEqual(parsePnpmKey('/react-dom@18.2.0(react@18.2.0)'), { name: 'react-dom', version: '18.2.0' });
  assert.deepEqual(parsePnpmKey("'@babel/core@7.24.7'"), { name: '@babel/core', version: '7.24.7' });
  assert.deepEqual(parsePnpmKey('lodash@4.17.21'), { name: 'lodash', version: '4.17.21' });
});

const V9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      lodash:
        specifier: ^4.17.21
        version: 4.17.21

packages:

  '@babel/code-frame@7.24.7':
    resolution: {integrity: sha512-aaa}
    engines: {node: '>=6.9.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-bbb}

  corp-tool@1.0.0:
    resolution: {tarball: https://corp.example/corp-tool-1.0.0.tgz}
    version: 1.0.0

  gitdep@https://codeload.github.com/u/r/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/u/r/tar.gz/abc}

snapshots:

  lodash@4.17.21: {}
`;

test('v9 lockfile: registry entries only', () => {
  const r = parsePnpmLock(V9);
  assert.deepEqual(r.entries, [pk('@babel/code-frame', '7.24.7'), pk('lodash', '4.17.21')]);
  assert.equal(r.skipped, 2);
});

test('v6 lockfile with CRLF line endings', () => {
  const V6 = [
    "lockfileVersion: '6.0'",
    '',
    'packages:',
    '',
    '  /react-dom@18.2.0(react@18.2.0):',
    '    resolution: {integrity: sha512-ccc}',
    '',
    '  /react@18.2.0:',
    '    resolution: {integrity: sha512-ddd}',
    '',
  ].join('\r\n');
  assert.deepEqual(parsePnpmLock(V6).entries, [pk('react-dom', '18.2.0'), pk('react', '18.2.0')]);
});

const SCOPED = `lockfileVersion: '9.0'

packages:

  '@corp/billing-core@1.0.0':
    resolution: {integrity: sha512-aaaa}

  '@Corp/Other@2.0.0':
    resolution: {integrity: sha512-cccc}

  lodash@4.17.21:
    resolution: {integrity: sha512-bbbb}
`;

test('an npm registry policy skips private scopes and counts them', () => {
  const r = parsePnpmLock(SCOPED, { npmPolicy: { skipAll: false, privateScopes: new Set(['@corp']) } });
  assert.deepEqual(r.entries, [pk('lodash', '4.17.21')]);
  assert.equal(r.skipped, 2);
  assert.equal(r.registrySkipped, 2);
});

test('an npm registry policy with skipAll skips every entry', () => {
  const r = parsePnpmLock(SCOPED, { npmPolicy: { skipAll: true, privateScopes: new Set() } });
  assert.deepEqual(r.entries, []);
  assert.equal(r.skipped, 3);
  assert.equal(r.registrySkipped, 3);
});

test('no policy keeps the lockfile-only rule', () => {
  const r = parsePnpmLock(SCOPED);
  assert.equal(r.entries.length, 3);
  assert.equal(r.registrySkipped, 0);
});

const V5 = `lockfileVersion: 5.4

specifiers:
  lodash: ^4.17.21
  react-dom: ^18.2.0

dependencies:
  lodash: 4.17.21
  react-dom: 18.2.0_react@18.2.0

devDependencies:
  '@types/node': 20.11.0

packages:

  /@types/node/20.11.0:
    resolution: {integrity: sha512-a}
    dev: true

  /lodash/4.17.21:
    resolution: {integrity: sha512-b}
    dev: false

  /react-dom/18.2.0_react@18.2.0:
    resolution: {integrity: sha512-c}
    peerDependencies:
      react: ^18.2.0
    dependencies:
      loose-envify: 1.4.0
      react: 18.2.0
    dev: false

  registry.corp.example/@corp/x/1.0.0:
    resolution: {integrity: sha512-d, registry: https://registry.corp.example/, tarball: https://registry.corp.example/@corp/x/-/x-1.0.0.tgz}
    name: '@corp/x'
    version: 1.0.0
    dev: false

  github.com/u/r/abc123:
    resolution: {tarball: https://codeload.github.com/u/r/tar.gz/abc123}
    name: r
    version: 0.0.1
    dev: false
`;

test('v5 lockfile: registry entries only; custom-registry and git entries skipped', () => {
  const r = parsePnpmLock(V5);
  assert.deepEqual(r.entries, [pk('@types/node', '20.11.0'), pk('lodash', '4.17.21'), pk('react-dom', '18.2.0')]);
  assert.equal(r.skipped, 2);
  assert.deepEqual(parsePnpmLock(V5.replace(/\n/g, '\r\n')).entries, r.entries);
});
