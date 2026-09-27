import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXACT_VERSION, pep503, isPublicNpmUrl, isPublicPypiUrl, entryKey } from '../src/lockfiles/common.mjs';

test('EXACT_VERSION matches exact versions only', () => {
  for (const v of ['1.2.3', 'v1.2.3', '1.0rc1', '2!1.0', '1.2.3-beta.1+build']) assert.ok(EXACT_VERSION.test(v), v);
  for (const v of ['^1.2.3', '~1.2', '>=2', '*', 'latest', '', 'file:../x']) assert.ok(!EXACT_VERSION.test(v), v);
});

test('pep503 normalizes PyPI names', () => {
  assert.equal(pep503('Flask_Cors'), 'flask-cors');
  assert.equal(pep503('Flask.Cors'), 'flask-cors');
  assert.equal(pep503('a--_b'), 'a-b');
});

test('public registry host checks', () => {
  assert.equal(isPublicNpmUrl('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'), true);
  assert.equal(isPublicNpmUrl('https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz'), true);
  assert.equal(isPublicNpmUrl('https://npm.pkg.github.com/@corp/x/-/x-1.0.0.tgz'), false);
  assert.equal(isPublicNpmUrl('http://registry.npmjs.org/x.tgz'), false);
  assert.equal(isPublicNpmUrl('https://registry.npmjs.org.evil.example/x.tgz'), false);
  assert.equal(isPublicNpmUrl(undefined), false);
  assert.equal(isPublicPypiUrl('https://pypi.org/simple'), true);
  assert.equal(isPublicPypiUrl('https://files.pythonhosted.org/packages/x.whl'), true);
  assert.equal(isPublicPypiUrl('https://corp.example/simple'), false);
});

test('entryKey keeps npm case and normalizes PyPI', () => {
  assert.equal(entryKey({ ecosystem: 'npm', name: 'JSONStream' }), 'npm|JSONStream');
  assert.equal(entryKey({ ecosystem: 'pypi', name: 'Flask_Cors' }), 'pypi|flask-cors');
});
