import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { npmPolicyFor, yarnPolicyFor, pipIndexConfigured, pipConfigSetsIndex, uvConfigSetsIndex, uvProjectIndexConfigured, uvUserIndexConfigured } from '../src/registry-config.mjs';

const ROOT = path.resolve('/ws');
const HOME = path.resolve('/home/runner');

// Fake fs keyed by resolved path. `special` paths exist but are not regular
// files (a FIFO, a device, or a link to one).
function fakeFs(files, special = []) {
  const map = new Map(Object.entries(files).map(([p, t]) => [path.resolve(p), t]));
  const odd = new Set(special.map((p) => path.resolve(p)));
  const reads = [];
  return {
    reads,
    stat: (f) => {
      const p = path.resolve(f);
      if (odd.has(p)) return { isFile: false, size: 0 };
      return map.has(p) ? { isFile: true, size: map.get(p).length } : null;
    },
    readFile: (f) => {
      reads.push(path.resolve(f));
      return map.has(path.resolve(f)) ? map.get(path.resolve(f)) : null;
    },
  };
}
const at = (...parts) => path.join(ROOT, ...parts);
const scopes = (p) => [...p.privateScopes].sort();

test('npm policy reads every .npmrc from the lockfile folder up to the workspace root', () => {
  const fs = fakeFs({
    [at('apps', 'web', '.npmrc')]: '@web:registry=https://npm.corp.example/\n',
    [at('apps', '.npmrc')]: '@apps:registry=https://npm.corp.example/\n',
    [at('.npmrc')]: '@root:registry=https://npm.corp.example/\n',
    [at('other', '.npmrc')]: 'registry=https://npm.corp.example/\n',
  });
  const p = npmPolicyFor('apps/web/pnpm-lock.yaml', { cwd: ROOT, env: {}, fs });
  assert.equal(p.skipAll, false);
  assert.deepEqual(scopes(p), ['@apps', '@root', '@web']);
});

test('npm policy: a non-default setting anywhere in the chain counts, even if a closer file sets the default', () => {
  const fs = fakeFs({
    [at('apps', '.npmrc')]: 'registry=https://registry.npmjs.org/\n',
    [at('.npmrc')]: 'registry=https://npm.corp.example/\n',
  });
  assert.equal(npmPolicyFor('apps/pnpm-lock.yaml', { cwd: ROOT, env: {}, fs }).skipAll, true);
});

test('npm policy reads the NPM_CONFIG_USERCONFIG file, matched case-insensitively', () => {
  const user = path.resolve('/home/runner/work/_temp/.npmrc');
  const fs = fakeFs({ [user]: '@corp:registry=https://npm.pkg.github.com/\n', [path.join(HOME, '.npmrc')]: 'registry=https://npm.corp.example/\n' });
  for (const name of ['NPM_CONFIG_USERCONFIG', 'npm_config_userconfig']) {
    const p = npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { [name]: user, HOME }, fs });
    assert.deepEqual([p.skipAll, scopes(p)], [false, ['@corp']], name);
  }
});

test('npm policy falls back to the home .npmrc when no user config is named', () => {
  const fs = fakeFs({ [path.join(HOME, '.npmrc')]: '@corp:registry=https://npm.corp.example/\n' });
  assert.deepEqual(scopes(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { HOME }, fs })), ['@corp']);
  assert.deepEqual(scopes(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { USERPROFILE: HOME }, fs })), ['@corp']);
});

test('npm policy applies npm_config_ environment variables', () => {
  const fs = fakeFs({});
  assert.equal(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { npm_config_registry: 'https://npm.corp.example/' }, fs }).skipAll, true);
  assert.deepEqual(scopes(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { 'npm_config_@corp:registry': 'https://x.example/' }, fs })), ['@corp']);
});

test('npm policy: a config file that is not a regular file counts as private', () => {
  const fs = fakeFs({}, [at('.npmrc')]);
  assert.equal(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: {}, fs }).skipAll, true);
  assert.deepEqual(fs.reads, []);
});

test('npm policy with no config anywhere is open', () => {
  const p = npmPolicyFor('a/b/pnpm-lock.yaml', { cwd: ROOT, env: { HOME }, fs: fakeFs({}) });
  assert.deepEqual([p.skipAll, scopes(p)], [false, []]);
});

test('yarn policy merges .yarnrc.yml from the lockfile folder up to the root, plus the home one', () => {
  const fs = fakeFs({
    [at('apps', 'web', '.yarnrc.yml')]: 'npmScopes:\n  web:\n    npmRegistryServer: "https://npm.corp.example"\n',
    [at('.yarnrc.yml')]: 'npmScopes:\n  root:\n    npmRegistryServer: "https://npm.corp.example"\n',
    [path.join(HOME, '.yarnrc.yml')]: 'npmScopes:\n  home:\n    npmRegistryServer: "https://npm.corp.example"\n',
  });
  const p = yarnPolicyFor('apps/web/yarn.lock', { cwd: ROOT, env: { HOME }, fs });
  assert.deepEqual([p.skipAll, scopes(p)], [false, ['@home', '@root', '@web']]);
});

test('yarn policy: a non-default npmRegistryServer in any file skips everything', () => {
  const fs = fakeFs({ [path.join(HOME, '.yarnrc.yml')]: 'npmRegistryServer: "https://npm.corp.example"\n' });
  assert.equal(yarnPolicyFor('yarn.lock', { cwd: ROOT, env: { USERPROFILE: HOME }, fs }).skipAll, true);
});

test('yarn policy reads YARN_NPM_REGISTRY_SERVER and YARN_NPM_SCOPES', () => {
  const fs = fakeFs({});
  const run = (env) => yarnPolicyFor('yarn.lock', { cwd: ROOT, env, fs }).skipAll;
  assert.equal(run({ YARN_NPM_REGISTRY_SERVER: 'https://npm.corp.example' }), true);
  assert.equal(run({ yarn_npm_registry_server: 'https://npm.corp.example' }), true);
  assert.equal(run({ YARN_NPM_REGISTRY_SERVER: 'https://registry.yarnpkg.com' }), false);
  assert.equal(run({ YARN_NPM_SCOPES: '{"corp":{}}' }), true);
  assert.equal(run({ YARN_NPM_SCOPES: '' }), true);
  assert.equal(run({}), false);
});

test('yarn policy: an unreadable .yarnrc.yml counts as private', () => {
  assert.equal(yarnPolicyFor('yarn.lock', { cwd: ROOT, env: {}, fs: fakeFs({}, [at('.yarnrc.yml')]) }).skipAll, true);
});

test('pip index: any listed pip or uv environment variable with a value', () => {
  const fs = fakeFs({});
  for (const name of ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_PYPI_URL', 'PIP_CONFIG_FILE', 'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'UV_DEFAULT_INDEX', 'UV_FIND_LINKS']) {
    assert.equal(pipIndexConfigured({ env: { [name]: 'https://pypi.corp.example/simple' }, fs }), true, name);
    assert.equal(pipIndexConfigured({ env: { [name]: '' }, fs }), false, `${name} empty`);
  }
  assert.equal(pipIndexConfigured({ env: { PIP_NO_CACHE_DIR: '1' }, fs }), false);
});

test('pipConfigSetsIndex also recognizes the pypi-url key', () => {
  assert.equal(pipConfigSetsIndex('[global]\npypi-url = https://pypi.corp.example/simple\n'), true);
  assert.equal(pipConfigSetsIndex('[global]\npypi_url: https://pypi.corp.example/simple\n'), true);
});

test('pip index: the standard pip config files', () => {
  const idx = '[global]\nindex-url = https://pypi.corp.example/simple\n';
  const xdg = path.resolve('/xdg');
  const appdata = path.resolve('/appdata');
  const cases = [
    [{}, { '/etc/pip.conf': idx }],
    [{ HOME }, { [path.join(HOME, '.pip', 'pip.conf')]: idx }],
    [{ HOME }, { [path.join(HOME, '.config', 'pip', 'pip.conf')]: '[install]\nextra_index_url = https://x\n' }],
    [{ XDG_CONFIG_HOME: xdg }, { [path.join(xdg, 'pip', 'pip.conf')]: '[global]\nfind-links: /wheels\n' }],
    [{ APPDATA: appdata }, { [path.join(appdata, 'pip', 'pip.ini')]: '[global]\r\nIndex-Url=https://x\r\n' }],
  ];
  for (const [env, files] of cases) assert.equal(pipIndexConfigured({ env, fs: fakeFs(files) }), true, JSON.stringify(files));
  assert.equal(pipIndexConfigured({ env: { HOME }, fs: fakeFs({ '/etc/pip.conf': '[global]\ntimeout = 60\n' }) }), false);
  assert.equal(pipIndexConfigured({ env: {}, fs: fakeFs({}, ['/etc/pip.conf']) }), true);
});

test('pipConfigSetsIndex reads keys, not comments', () => {
  assert.equal(pipConfigSetsIndex('# index-url = https://x\n; find-links = /w\n[global]\ntimeout=5\n'), false);
  assert.equal(pipConfigSetsIndex('[global]\n--extra-index-url = https://x\n'), true);
});

test('pip index: /etc/xdg/pip/pip.conf and $VIRTUAL_ENV/pip.conf', () => {
  const idx = '[global]\nindex-url = https://pypi.corp.example/simple\n';
  const venv = path.resolve('/ws/.venv');
  assert.equal(pipIndexConfigured({ env: {}, fs: fakeFs({ '/etc/xdg/pip/pip.conf': idx }) }), true);
  assert.equal(pipIndexConfigured({ env: { VIRTUAL_ENV: venv }, fs: fakeFs({ [path.join(venv, 'pip.conf')]: idx }) }), true);
  assert.equal(pipIndexConfigured({ env: {}, fs: fakeFs({ [path.join(venv, 'pip.conf')]: idx }) }), false);
});

test('uv.toml: index settings and [[index]] tables count; other settings do not', () => {
  const yes = [
    'index-url = "https://pypi.corp.example/simple"\n',
    'extra-index-url = [\n  "https://pypi.corp.example/simple",\n]\n',
    'find-links = ["./wheels"]\n',
    '[[index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n',
    '[pip]\nindex-url = "https://pypi.corp.example/simple"\n',
    'index = [{ name = "corp", url = "https://pypi.corp.example/simple" }]\n',
    '[sources]\ncorp-lib = { index = "corp" }\n',
    'extra_index_url = ["https://x"]\n',
    '"index-url" = "https://x"\n',
  ];
  for (const text of yes) assert.equal(uvConfigSetsIndex(text, { pyproject: false }), true, text);
  const no = ['', '# index-url = "https://x"\n', 'index-strategy = "unsafe-best-match"\nnative-tls = true\n', '[pip]\ncompile-bytecode = true\n'];
  for (const text of no) assert.equal(uvConfigSetsIndex(text, { pyproject: false }), false, text);
});

test('pyproject.toml: only uv settings count', () => {
  const yes = [
    '[tool.uv]\nindex-url = "https://x"\n',
    '[[tool.uv.index]]\nname = "corp"\nurl = "https://x"\n',
    '[tool.uv.pip]\nextra-index-url = ["https://x"]\n',
    '[tool]\nuv = { index-url = "https://x" }\n',
    'tool.uv.find-links = ["./wheels"]\n',
    '[tool.uv.sources]\ntorch = { index = "pytorch" }\n',
    '[ tool.uv ]\n"extra-index-url" = ["https://x"]\n',
  ];
  for (const text of yes) assert.equal(uvConfigSetsIndex(text, { pyproject: true }), true, text);
  const no = [
    '[project]\nname = "app"\ndependencies = ["requests"]\n',
    '[tool.uv]\ndev-dependencies = ["pytest"]\n',
    '[[tool.poetry.source]]\nname = "corp"\nurl = "https://x"\n',
    '[tool.pip-tools]\nindex-url = "https://x"\n',
    '# [[tool.uv.index]]\n',
  ];
  for (const text of no) assert.equal(uvConfigSetsIndex(text, { pyproject: true }), false, text);
});

test('uv project config is read from the requirements folder up to the workspace root', () => {
  const idx = 'index-url = "https://pypi.corp.example/simple"\n';
  const run = (files, special = []) => uvProjectIndexConfigured('svc/api/requirements.txt', { cwd: ROOT, fs: fakeFs(files, special) });
  assert.equal(run({ [at('svc', 'api', 'uv.toml')]: idx }), true);
  assert.equal(run({ [at('svc', 'uv.toml')]: idx }), true);
  assert.equal(run({ [at('pyproject.toml')]: '[[tool.uv.index]]\nname = "corp"\nurl = "https://x"\n' }), true);
  assert.equal(run({ [at('pyproject.toml')]: '[project]\nname = "app"\n' }), false);
  assert.equal(run({ [at('other', 'uv.toml')]: idx }), false);
  assert.equal(run({ [path.resolve('/uv.toml')]: idx }), false);
  assert.equal(run({}, [at('svc', 'pyproject.toml')]), true);
  assert.equal(run({}), false);
});

test("npm policy reads pnpm's rc file: XDG_CONFIG_HOME, else ~/.config, plus LOCALAPPDATA on Windows", () => {
  const scope = '@corp:registry=https://npm.corp.example/\n';
  const xdg = path.resolve('/xdg');
  const local = path.resolve('/localappdata');
  const policy = (env, files) => scopes(npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env, fs: fakeFs(files) }));
  assert.deepEqual(policy({ XDG_CONFIG_HOME: xdg }, { [path.join(xdg, 'pnpm', 'rc')]: scope }), ['@corp']);
  assert.deepEqual(policy({ HOME }, { [path.join(HOME, '.config', 'pnpm', 'rc')]: scope }), ['@corp']);
  assert.deepEqual(policy({ XDG_CONFIG_HOME: xdg, HOME }, { [path.join(HOME, '.config', 'pnpm', 'rc')]: scope }), []);
  assert.deepEqual(policy({ LOCALAPPDATA: local }, { [path.join(local, 'pnpm', 'config', 'rc')]: scope }), ['@corp']);
});

test('npm policy reads the file named by NPM_CONFIG_GLOBALCONFIG, matched case-insensitively', () => {
  const global = path.resolve('/usr/local/etc/npmrc');
  for (const name of ['NPM_CONFIG_GLOBALCONFIG', 'npm_config_globalconfig']) {
    const p = npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: { [name]: global }, fs: fakeFs({ [global]: 'registry=https://npm.corp.example/\n' }) });
    assert.equal(p.skipAll, true, name);
  }
});

test('npm policy ignores .npmrc files below the lockfile folder', () => {
  const fs = fakeFs({ [at('packages', 'a', '.npmrc')]: 'registry=https://npm.corp.example/\n' });
  const p = npmPolicyFor('pnpm-lock.yaml', { cwd: ROOT, env: {}, fs });
  assert.deepEqual([p.skipAll, scopes(p)], [false, []]);
});

test('yarn policy: YARN_RC_FILENAME set and non-empty skips every Berry entry', () => {
  const fs = fakeFs({});
  const run = (env) => yarnPolicyFor('yarn.lock', { cwd: ROOT, env, fs }).skipAll;
  assert.equal(run({ YARN_RC_FILENAME: '.yarnrc-ci.yml' }), true);
  assert.equal(run({ yarn_rc_filename: '.yarnrc-ci.yml' }), true);
  assert.equal(run({ YARN_RC_FILENAME: '' }), false);
});

test('uv user and system config: XDG or ~/.config, /etc/uv, XDG_CONFIG_DIRS, and APPDATA on Windows', () => {
  const idx = 'index-url = "https://pypi.corp.example/simple"\n';
  const xdg = path.resolve('/xdg');
  const d1 = path.resolve('/etc/xdg-a');
  const d2 = path.resolve('/etc/xdg-b');
  const appdata = path.resolve('/appdata');
  const on = (env, files, special = []) => uvUserIndexConfigured({ env, fs: fakeFs(files, special) });
  assert.equal(on({ XDG_CONFIG_HOME: xdg }, { [path.join(xdg, 'uv', 'uv.toml')]: idx }), true);
  assert.equal(on({ HOME }, { [path.join(HOME, '.config', 'uv', 'uv.toml')]: idx }), true);
  assert.equal(on({ XDG_CONFIG_HOME: xdg, HOME }, { [path.join(HOME, '.config', 'uv', 'uv.toml')]: idx }), false);
  assert.equal(on({}, { '/etc/uv/uv.toml': idx }), true);
  assert.equal(on({ XDG_CONFIG_DIRS: [d1, d2].join(path.delimiter) }, { [path.join(d2, 'uv', 'uv.toml')]: '[[index]]\nname = "corp"\nurl = "https://x"\n' }), true);
  assert.equal(on({ APPDATA: appdata }, { [path.join(appdata, 'uv', 'uv.toml')]: idx }), true);
  assert.equal(on({ HOME }, { [path.join(HOME, '.config', 'uv', 'uv.toml')]: 'native-tls = true\n' }), false);
  assert.equal(on({ HOME }, {}, [path.join(HOME, '.config', 'uv', 'uv.toml')]), true);
  assert.equal(on({ HOME }, {}), false);
});
