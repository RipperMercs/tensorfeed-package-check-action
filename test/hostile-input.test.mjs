import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePnpmLock } from '../src/lockfiles/pnpm.mjs';
import { parseYarnLock, berryPolicy } from '../src/lockfiles/yarn.mjs';
import { parseRequirements } from '../src/lockfiles/requirements.mjs';

// Each parser gets a single 1 MB line shaped to make a backtracking regex
// take quadratic time. Linear parsing finishes in milliseconds.
const MB = 1024 * 1024;
const LIMIT_MS = 1000;

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

test('pnpm: a 1 MB resolution line with a bare CR parses in under a second', () => {
  for (const tail of ['a\rb', '\r']) {
    const text = `packages:\n  a@1.0.0:\n    resolution: ${' '.repeat(MB)}${tail}\n`;
    const { result, ms } = timed(() => parsePnpmLock(text));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
    assert.deepEqual(result.entries, []);
  }
});

test('yarn berry: a 1 MB resolution line parses in under a second', () => {
  const text = `__metadata:\n  version: 8\n\n"a@npm:1":\n  resolution: a${' '.repeat(MB)}"x\n`;
  const { result, ms } = timed(() => parseYarnLock(text, { yarnrc: null }));
  assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
  assert.deepEqual(result.entries, []);
});

test('yarnrc: a 1 MB npmScopes header comment parses in under a second', () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const yarnrc = `npmScopes: ${' #'.repeat(MB / 2)}${lineSeparator}x\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n`;
  const { result, ms } = timed(() => berryPolicy(yarnrc));
  assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
  // The whole header remainder is a comment, so the scope block below it is read.
  assert.deepEqual(result.privateScopes, new Set(['@corp']));
});

test('requirements: a 1 MB comment line parses in under a second', () => {
  for (const line of [`${' #'.repeat(MB / 2)}\rx`, `${' '.repeat(MB)}#`]) {
    const { result, ms } = timed(() => parseRequirements(`${line}\nrequests==2.32.3\n`));
    assert.ok(ms < LIMIT_MS, `took ${ms.toFixed(0)} ms`);
    assert.deepEqual(result.entries, [{ ecosystem: 'pypi', name: 'requests', version: '2.32.3' }]);
  }
});

test('the linear rewrites read the same values as before', () => {
  const pnpm = parsePnpmLock('packages:\n  a@1.0.0:\n    resolution:  \r{integrity: sha512-x}\n  b@1.0.0:\n    resolution: {integrity: sha512-y}\rjunk\n');
  assert.deepEqual(pnpm.entries.map((e) => e.name), ['a']);
  const berry = (value) => parseYarnLock(`__metadata:\n  version: 8\n\n"x@npm:1":\n  resolution: ${value}\n`, { yarnrc: null }).entries;
  assert.deepEqual(berry('"lodash@npm:4.17.21"'), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }]);
  assert.deepEqual(berry('"lodash@npm:4.17.21"   '), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }]);
  assert.deepEqual(berry('lodash@npm:4.17.21'), [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }]);
  assert.deepEqual(berry('"lodash@npm:4.17.21"x'), []);
  assert.deepEqual(berry('""'), []);
  const req = parseRequirements('requests==2.32.3 # pinned\n# flask==3.0.3\nurllib3==2.2.2#not-a-comment\n');
  assert.deepEqual(req.entries.map((e) => e.name), ['requests']);
  assert.deepEqual(berryPolicy('npmScopes: # ours\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n').privateScopes, new Set(['@corp']));
});

test('config readers and the include scan read 1 MB lines in under a second', async () => {
  const path = await import('node:path');
  const { emptyRegistryPolicy, applyNpmrc } = await import('../src/lockfiles/npmrc.mjs');
  const { pipConfigSetsIndex, uvConfigSetsIndex } = await import('../src/registry-config.mjs');
  const { requirementsIncludeProblem } = await import('../src/requirements-includes.mjs');
  const noFs = { lstat: () => null, readFile: () => null };
  const cases = {
    npmrc: () => applyNpmrc(emptyRegistryPolicy(), `${' #'.repeat(MB / 2)}\r@corp:registry${' '.repeat(MB)}=x`),
    pip: () => pipConfigSetsIndex(`${' '.repeat(MB)}index-url${' '.repeat(MB)}=`),
    uv: () => uvConfigSetsIndex(`[tool.uv]\n${'.'.repeat(MB)}=\nx = {${' index'.repeat(MB / 8)}`, { pyproject: true }),
    includes: () => requirementsIncludeProblem('requirements.txt', `-r ${"'".repeat(MB)} ${'-rx '.repeat(MB / 8)}`, { cwd: path.resolve('/ws'), fs: noFs }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const { ms } = timed(fn);
    assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(0)} ms`);
  }
});
