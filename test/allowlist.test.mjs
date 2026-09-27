import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, isAllowlisted } from '../src/allowlist.mjs';

test('allowlist: exact, scope glob, prefix glob, PEP 503 for pypi, object-internal names', () => {
  const pats = parseAllowlist(' Left-Pad , @acme/* , internal-* , acme_internal ,,');
  assert.equal(isAllowlisted('left-pad', pats, 'npm'), true);
  assert.equal(isAllowlisted('@acme/ui', pats, 'npm'), true);
  assert.equal(isAllowlisted('internal-tools', pats, 'npm'), true);
  assert.equal(isAllowlisted('Acme.Internal', pats, 'pypi'), true);
  assert.equal(isAllowlisted('acme-internal', pats, 'npm'), false);
  assert.equal(isAllowlisted('lodash', pats, 'npm'), false);
  assert.equal(isAllowlisted('__proto__', parseAllowlist('constructor'), 'npm'), false);
});
