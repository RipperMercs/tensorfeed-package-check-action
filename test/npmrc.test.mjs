import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistryPolicy, applyNpmrc, applyNpmEnv, isDefaultNpmRegistry } from '../src/lockfiles/npmrc.mjs';

const fromNpmrc = (text) => {
  const p = emptyRegistryPolicy();
  applyNpmrc(p, text);
  return { skipAll: p.skipAll, privateScopes: [...p.privateScopes].sort() };
};
const fromEnv = (env) => {
  const p = emptyRegistryPolicy();
  applyNpmEnv(p, env);
  return { skipAll: p.skipAll, privateScopes: [...p.privateScopes].sort() };
};
const OPEN = { skipAll: false, privateScopes: [] };

test('the public registry, in any of its spellings, is not private', () => {
  for (const v of ['https://registry.npmjs.org/', 'https://registry.npmjs.org', 'http://registry.npmjs.org/', 'https://registry.yarnpkg.com', 'HTTPS://Registry.NPMJS.org/']) {
    assert.equal(isDefaultNpmRegistry(v), true, v);
    assert.deepEqual(fromNpmrc(`registry=${v}\n`), OPEN, v);
  }
  for (const v of ['https://npm.corp.example/', 'registry.npmjs.org', 'https://registry.npmjs.org.evil.example/', 'https://registry.npmjs.org/${PATH}', '', null]) {
    assert.equal(isDefaultNpmRegistry(v), false, String(v));
  }
});

test('a non-default registry= line skips every pnpm entry', () => {
  assert.deepEqual(fromNpmrc('registry=https://artifactory.corp.example/api/npm/npm/\n'), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromNpmrc('registry = "https://npm.corp.example/"\r\n'), { skipAll: true, privateScopes: [] });
});

test('each non-default @scope:registry line makes that scope private', () => {
  const text = [
    '@corp:registry=https://npm.corp.example/',
    '@Acme:registry = https://npm.pkg.github.com',
    '@public:registry=https://registry.npmjs.org/',
    '//npm.corp.example/:_authToken=${NPM_TOKEN}',
    '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}',
  ].join('\n');
  assert.deepEqual(fromNpmrc(text), { skipAll: false, privateScopes: ['@acme', '@corp'] });
});

test('comment lines are ignored; inline comments are cut like ini does', () => {
  assert.deepEqual(fromNpmrc('# registry=https://npm.corp.example/\n; @corp:registry=https://npm.corp.example/\n'), OPEN);
  assert.deepEqual(fromNpmrc('registry=https://registry.npmjs.org/ # the default\n'), OPEN);
  assert.deepEqual(fromNpmrc("registry='https://registry.npmjs.org/'\n"), OPEN);
});

test('placeholders and lines the parser cannot read count as private', () => {
  assert.deepEqual(fromNpmrc('registry=${NPM_REGISTRY}\n'), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromNpmrc('@corp:registry=${CORP_REGISTRY}\n'), { skipAll: false, privateScopes: ['@corp'] });
  assert.deepEqual(fromNpmrc('${SCOPE}:registry=https://npm.corp.example/\n'), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromNpmrc('registry\n'), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromNpmrc('@corp:registry\n'), { skipAll: false, privateScopes: ['@corp'] });
  assert.deepEqual(fromNpmrc('"@corp:registry=https://npm.corp.example/\n'), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromNpmrc('@corp: registry=https://npm.corp.example/\n'), { skipAll: true, privateScopes: [] });
});

test('unrelated settings leave the policy open', () => {
  assert.deepEqual(fromNpmrc('save-exact=true\nauto-install-peers=true\nreplace-registry-host=never\n[section]\nstrict-ssl\n'), OPEN);
  assert.deepEqual(fromNpmrc(''), OPEN);
});

test('a bare CR ends a line, as it does for ini', () => {
  assert.deepEqual(fromNpmrc('save-exact=true\r@corp:registry=https://npm.corp.example/\r'), { skipAll: false, privateScopes: ['@corp'] });
});

test('environment variables match case-insensitively', () => {
  assert.deepEqual(fromEnv({ npm_config_registry: 'https://npm.corp.example/' }), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromEnv({ NPM_CONFIG_REGISTRY: 'https://npm.corp.example/' }), { skipAll: true, privateScopes: [] });
  assert.deepEqual(fromEnv({ 'npm_config_@corp:registry': 'https://npm.corp.example/' }), { skipAll: false, privateScopes: ['@corp'] });
  assert.deepEqual(fromEnv({ 'NPM_CONFIG_@CORP:REGISTRY': 'https://npm.corp.example/' }), { skipAll: false, privateScopes: ['@corp'] });
  assert.deepEqual(fromEnv({ NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_USERCONFIG: '/tmp/.npmrc', PATH: '/bin' }), OPEN);
});
