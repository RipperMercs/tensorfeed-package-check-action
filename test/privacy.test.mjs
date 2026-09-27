import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { run } from '../src/run.mjs';

// Each test puts a private package next to public ones, configures its
// registry outside the lockfile, and asserts the private name never reaches
// any request while the summary says why it was skipped.

const ROOT = path.resolve('/ws');

// `repo` maps workspace-relative paths to file text; `outside` maps absolute
// paths (home folder, runner temp) to file text.
function harness({ repo, outside = {}, env = {} }) {
  const files = new Map();
  for (const [rel, text] of Object.entries(repo)) files.set(path.join(ROOT, ...rel.split('/')), text);
  for (const [abs, text] of Object.entries(outside)) files.set(path.resolve(abs), text);
  const written = new Map();
  const calls = [];
  const fs = {
    readdir: (d) => {
      const dir = path.resolve(d);
      const out = new Map();
      for (const f of files.keys()) {
        if (!f.startsWith(dir + path.sep)) continue;
        const [first, ...rest] = f.slice(dir.length + 1).split(path.sep);
        out.set(first, rest.length > 0);
      }
      return [...out].map(([name, isDir]) => ({ name, isDir, isFile: !isDir }));
    },
    readFile: (f) => (files.has(path.resolve(f)) ? files.get(path.resolve(f)) : null),
    lstat: (f) => (files.has(path.resolve(f)) ? { isFile: true, isSymbolicLink: false, size: files.get(path.resolve(f)).length } : null),
    stat: (f) => (files.has(path.resolve(f)) ? { isFile: true, size: files.get(path.resolve(f)).length } : null),
    appendFile: (f, d) => written.set(f, (written.get(f) || '') + d),
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const { packages } = JSON.parse(init.body);
    return Response.json({ ok: true, results: packages.map((p) => ({ ecosystem: p.ecosystem, name: p.name, verdict: 'GO', reasons: [], did_you_mean: null })) });
  };
  const deps = {
    env: {
      GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_NAME: 'push', GITHUB_STEP_SUMMARY: '/summary', GITHUB_OUTPUT: '/output',
      INPUT_MODE: 'deny', 'INPUT_FAIL-ON-REVIEW': 'false', 'INPUT_TENSORFEED-TOKEN': '', INPUT_LOCKFILES: '', INPUT_SCAN: 'changed', INPUT_ALLOWLIST: '',
      ...env,
    },
    cwd: ROOT,
    fs,
    exec: () => ({ status: 1, stdout: '' }),
    fetchImpl,
    log: () => {},
  };
  return {
    deps,
    sentNames: () => calls.flatMap((c) => JSON.parse(c.body).packages.map((p) => p.name)).sort(),
    everything: () => JSON.stringify(calls),
    summary: () => written.get('/summary') || '',
  };
}

const PNPM = `lockfileVersion: '9.0'

packages:

  '@corp/billing-core@1.0.0':
    resolution: {integrity: sha512-aaaa}

  lodash@4.17.21:
    resolution: {integrity: sha512-bbbb}
`;

const BERRY = `__metadata:
  version: 8
  cacheKey: 10c0

"@corp/ui@npm:^2.0.0":
  version: 2.1.0
  resolution: "@corp/ui@npm:2.1.0"
  languageName: node
  linkType: hard

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"
  languageName: node
  linkType: hard
`;

const REQS = 'acme-internal-ledger==3.2.1\nrequests==2.32.3\n';
const SCOPE_NOTE = "1 package in pnpm-lock.yaml was skipped because the registry settings in `.npmrc` or this job's environment do not confirm it comes from the public npm registry.";

test('pnpm with a committed .npmrc scope registry never sends that scope', async () => {
  const h = harness({ repo: { 'pnpm-lock.yaml': PNPM, '.npmrc': '@corp:registry=https://npm.corp.example/\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes(SCOPE_NOTE));
});

test('pnpm with a non-default registry= never sends any of its packages', async () => {
  const h = harness({ repo: { 'pnpm-lock.yaml': PNPM, '.npmrc': 'registry=https://artifactory.corp.example/api/npm/npm/\n', 'requirements.txt': 'requests==2.32.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
  assert.ok(h.summary().includes("2 packages in pnpm-lock.yaml were skipped because the registry settings in `.npmrc` or this job's environment do not confirm they come from the public npm registry."));
});

test('pnpm with NPM_CONFIG_USERCONFIG naming a file with a scope registry never sends that scope', async () => {
  const userconfig = '/home/runner/work/_temp/.npmrc';
  const h = harness({
    repo: { 'pnpm-lock.yaml': PNPM },
    outside: { [userconfig]: '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n@corp:registry=https://npm.pkg.github.com/\n' },
    env: { NPM_CONFIG_USERCONFIG: userconfig },
  });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes(SCOPE_NOTE));
});

test('a Berry lockfile in a subfolder whose own .yarnrc.yml declares the scope never sends that scope', async () => {
  const h = harness({ repo: { 'apps/web/yarn.lock': BERRY, 'apps/web/.yarnrc.yml': 'npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes("1 package in apps/web/yarn.lock was skipped because the registry settings in `.yarnrc.yml` or this job's environment do not confirm it comes from the public npm registry."));
});

test('Berry with YARN_NPM_REGISTRY_SERVER set to another registry never sends its packages', async () => {
  const h = harness({ repo: { 'yarn.lock': BERRY, 'requirements.txt': 'requests==2.32.3\n' }, env: { YARN_NPM_REGISTRY_SERVER: 'https://npm.corp.example' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
  assert.ok(h.summary().includes('2 packages in yarn.lock were skipped because the registry settings in `.yarnrc.yml`'));
});

test('requirements with PIP_INDEX_URL set never sends any of its packages', async () => {
  const h = harness({ repo: { 'svc/requirements.txt': REQS, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }) }, env: { PIP_INDEX_URL: 'https://pypi.corp.example/simple' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes('Skipped svc/requirements.txt: pip or uv is configured to use a custom package index.'));
});

test('requirements with an attached -i option never sends any of its packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `-ihttps://pypi.corp.example/simple\n${REQS}`, 'requirements-dev.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('public packages in the same repo are still sent when every private path is configured', async () => {
  const h = harness({
    repo: {
      'pnpm-lock.yaml': PNPM,
      '.npmrc': '@corp:registry=https://npm.corp.example/\n',
      'apps/web/yarn.lock': BERRY,
      'apps/web/.yarnrc.yml': 'npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n',
      'svc/requirements.txt': '--index-url https://pypi.corp.example/simple\nacme-internal-ledger==3.2.1\n',
      'tools/requirements.txt': 'requests==2.32.3\n',
    },
  });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.ok(!h.everything().includes('acme-internal'));
  assert.deepEqual(h.sentNames(), ['lodash', 'requests']);
});

// requirements files that pull in other files with -r or -c.

test('requirements that include a file with --index-url never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `-r base.txt\n${REQS}`, 'base.txt': '--index-url https://pypi.corp.example/simple\n', 'tools/requirements.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('requirements with a constraints file that sets an extra index never send any of their packages', async () => {
  const h = harness({ repo: { 'svc/requirements.txt': `--constraint=pins/constraints.txt\n${REQS}`, 'svc/pins/constraints.txt': '--extra-index-url https://pypi.corp.example/simple\nrequests==2.32.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), []);
  assert.ok(h.summary().includes('Skipped svc/requirements.txt: it configures a custom package index.'));
});

test('requirements with an include that cannot be read never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `-r ../shared/base.txt\n${REQS}`, 'requirements-dev.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it includes another requirements file that could not be read.'));
});

test('an included requirements file is still checked on its own', async () => {
  const h = harness({ repo: { 'requirements.txt': '-r requirements-base.txt\nflask==3.0.3\n', 'requirements-base.txt': 'requests==2.32.3\n' } });
  await run(h.deps);
  assert.deepEqual(h.sentNames(), ['flask', 'requests']);
});

// uv project config and pip config next to the requirements file.

const UV_NOTE = 'pip or uv is configured to use a custom package index.';

test('requirements under a uv.toml that sets an index never send any of their packages', async () => {
  const h = harness({ repo: { 'svc/requirements.txt': REQS, 'svc/uv.toml': 'index-url = "https://pypi.corp.example/simple"\n', 'tools/requirements.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes(`Skipped svc/requirements.txt: ${UV_NOTE}`));
});

test('requirements below a pyproject.toml with [[tool.uv.index]] never send any of their packages', async () => {
  const h = harness({ repo: { 'svc/api/requirements.txt': REQS, 'pyproject.toml': '[project]\nname = "app"\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), []);
  assert.ok(h.summary().includes(`Skipped svc/api/requirements.txt: ${UV_NOTE}`));
});

test('requirements with a virtualenv pip.conf that sets an index never send any of their packages', async () => {
  const venv = '/home/runner/venv';
  const h = harness({ repo: { 'requirements.txt': REQS }, outside: { [`${venv}/pip.conf`]: '[global]\nextra-index-url = https://pypi.corp.example/simple\n' }, env: { VIRTUAL_ENV: venv } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), []);
  assert.ok(h.summary().includes(`Skipped requirements.txt: ${UV_NOTE}`));
});

test('a pyproject.toml without uv settings does not stop requirements from being checked', async () => {
  const h = harness({ repo: { 'requirements.txt': 'requests==2.32.3\n', 'pyproject.toml': '[project]\nname = "app"\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n' } });
  await run(h.deps);
  assert.deepEqual(h.sentNames(), ['requests']);
});

// pnpm's own rc file, the npm global config, and a renamed Yarn rc file.

test("pnpm with a scope registry in pnpm's rc file never sends that scope", async () => {
  const xdg = '/home/runner/.config';
  const h = harness({ repo: { 'pnpm-lock.yaml': PNPM }, outside: { [`${xdg}/pnpm/rc`]: '@corp:registry=https://npm.corp.example/\n' }, env: { XDG_CONFIG_HOME: xdg } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes(SCOPE_NOTE));
});

test('pnpm with a registry in the NPM_CONFIG_GLOBALCONFIG file never sends any of its packages', async () => {
  const global = '/usr/local/etc/npmrc';
  const h = harness({ repo: { 'pnpm-lock.yaml': PNPM, 'requirements.txt': 'requests==2.32.3\n' }, outside: { [global]: 'registry=https://npm.corp.example/\n' }, env: { NPM_CONFIG_GLOBALCONFIG: global } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
});

test('Berry with YARN_RC_FILENAME set never sends any of its packages', async () => {
  const h = harness({ repo: { 'yarn.lock': BERRY, '.yarnrc-ci.yml': 'npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n', 'requirements.txt': 'requests==2.32.3\n' }, env: { YARN_RC_FILENAME: '.yarnrc-ci.yml' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
  assert.ok(h.summary().includes('2 packages in yarn.lock were skipped because the registry settings in `.yarnrc.yml`'));
});

test('an .npmrc below the pnpm lockfile folder does not change what that lockfile sends', async () => {
  const h = harness({ repo: { 'pnpm-lock.yaml': PNPM, '.npmrc': '@corp:registry=https://npm.corp.example/\n', 'packages/a/.npmrc': 'registry=https://npm.corp.example/\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['lodash']);
});

// Abbreviated pip options and uv user config.

test('requirements with an abbreviated --index option never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `--index https://pypi.corp.example/simple\n${REQS}`, 'requirements-dev.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('requirements that include a file through --req never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `--req=base.txt\n${REQS}`, 'base.txt': '--index-url https://pypi.corp.example/simple\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), []);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('requirements with a user uv.toml that sets an index never send any of their packages', async () => {
  const xdg = '/home/runner/.config';
  const h = harness({ repo: { 'requirements.txt': REQS, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }) }, outside: { [`${xdg}/uv/uv.toml`]: 'index-url = "https://pypi.corp.example/simple"\n' }, env: { XDG_CONFIG_HOME: xdg } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes('Skipped requirements.txt: pip or uv is configured to use a custom package index.'));
});

test('requirements with a two-letter abbreviated --in option never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `--in https://pypi.corp.example/simple\n${REQS}`, 'requirements-dev.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('requirements with a --pypi-url option never send any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': `--pypi-url https://pypi.corp.example/simple\n${REQS}`, 'requirements-dev.txt': 'pytest==8.3.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['pytest']);
  assert.ok(h.summary().includes('Skipped requirements.txt: it configures a custom package index.'));
});

test('requirements with PIP_PYPI_URL set never sends any of their packages', async () => {
  const h = harness({ repo: { 'svc/requirements.txt': REQS, 'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } } }) }, env: { PIP_PYPI_URL: 'https://pypi.corp.example/simple' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), ['lodash']);
  assert.ok(h.summary().includes('Skipped svc/requirements.txt: pip or uv is configured to use a custom package index.'));
});

test('requirements with a pip.conf pypi-url key never sends any of their packages', async () => {
  const h = harness({ repo: { 'requirements.txt': REQS }, outside: { '/etc/pip.conf': '[global]\npypi-url = https://pypi.corp.example/simple\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('acme-internal-ledger'));
  assert.deepEqual(h.sentNames(), []);
  assert.ok(h.summary().includes('Skipped requirements.txt: pip or uv is configured to use a custom package index.'));
});

// Yarn Berry .yarnrc.yml shapes the column-0 reader cannot read a value from.

test('a top-level JSON-flow .yarnrc.yml never sends any Berry packages, scoped or public', async () => {
  const h = harness({ repo: { 'yarn.lock': BERRY, '.yarnrc.yml': '{"npmRegistryServer": "https://npm.corp.example"}\n', 'requirements.txt': 'requests==2.32.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
  assert.ok(h.summary().includes('2 packages in yarn.lock were skipped because the registry settings in `.yarnrc.yml`'));
});

test('an npmRegistryServer whose value sits on the next line never sends any Berry packages, scoped or public', async () => {
  const h = harness({ repo: { 'yarn.lock': BERRY, '.yarnrc.yml': 'npmRegistryServer:\n  "https://npm.corp.example"\n', 'requirements.txt': 'requests==2.32.3\n' } });
  await run(h.deps);
  assert.ok(!h.everything().includes('@corp'));
  assert.deepEqual(h.sentNames(), ['requests']);
  assert.ok(h.summary().includes('2 packages in yarn.lock were skipped because the registry settings in `.yarnrc.yml`'));
});
