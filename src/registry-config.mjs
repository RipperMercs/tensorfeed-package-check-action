// The registry settings a package manager would use for a lockfile, read
// from config files in the repository and the runner's home folder, and from
// this job's environment. When they point at anything other than the public
// registry, the affected packages are skipped and never sent. Files go
// through the injected fs. A config file that exists but is not a regular
// file, is too large, or cannot be read counts as private (fail closed).
import path from 'node:path';
import { MAX_FILE_BYTES } from './lockfiles/index.mjs';
import { emptyRegistryPolicy, applyNpmrc, applyNpmEnv } from './lockfiles/npmrc.mjs';
import { berryPolicy, isDefaultYarnRegistry } from './lockfiles/yarn.mjs';
import { stripHashComment } from './lockfiles/common.mjs';

const UNREADABLE = Symbol('unreadable');

// null when the file is not there, its text when it is a regular file
// (following symlinks), UNREADABLE otherwise.
function readConfig(fs, file) {
  const st = fs.stat(file);
  if (!st) return null;
  if (!st.isFile || st.size > MAX_FILE_BYTES) return UNREADABLE;
  const text = fs.readFile(file);
  return text === null ? UNREADABLE : text;
}

// The lockfile's folder, then each parent up to and including the workspace root.
function foldersUp(cwd, rel) {
  const parts = rel.split('/').slice(0, -1);
  const out = [];
  for (let i = parts.length; i >= 0; i--) out.push(path.join(cwd, ...parts.slice(0, i)));
  return out;
}

const homeDir = (env) => env.HOME || env.USERPROFILE || null;

function envValues(env, name) {
  const want = name.toLowerCase();
  return Object.keys(env).filter((k) => k.toLowerCase() === want).map((k) => env[k]);
}

/**
 * The npm registry policy for a pnpm lockfile: every .npmrc from the
 * lockfile's folder up to the workspace root (never one below it), the user
 * config (the file named by NPM_CONFIG_USERCONFIG, else $HOME/.npmrc), the
 * file named by NPM_CONFIG_GLOBALCONFIG, pnpm's own rc file
 * ($XDG_CONFIG_HOME/pnpm/rc, else $HOME/.config/pnpm/rc, and
 * %LOCALAPPDATA%\pnpm\config\rc on Windows), and npm_config_* variables.
 * Any non-default setting anywhere counts, even when a closer file sets the
 * default for the same key.
 */
export function npmPolicyFor(rel, { cwd, env, fs }) {
  const policy = emptyRegistryPolicy();
  const files = foldersUp(cwd, rel).map((d) => path.join(d, '.npmrc'));
  const userconfigs = envValues(env, 'npm_config_userconfig').filter(Boolean);
  if (userconfigs.length) files.push(...userconfigs.map((f) => path.resolve(cwd, f)));
  else if (homeDir(env)) files.push(path.join(homeDir(env), '.npmrc'));
  files.push(...envValues(env, 'npm_config_globalconfig').filter(Boolean).map((f) => path.resolve(cwd, f)));
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, 'pnpm', 'rc'));
  else if (homeDir(env)) files.push(path.join(homeDir(env), '.config', 'pnpm', 'rc'));
  if (env.LOCALAPPDATA) files.push(path.join(env.LOCALAPPDATA, 'pnpm', 'config', 'rc'));
  for (const f of files) {
    const text = readConfig(fs, f);
    if (text === UNREADABLE) policy.skipAll = true;
    else if (text !== null) applyNpmrc(policy, text);
  }
  applyNpmEnv(policy, env);
  return policy;
}

/**
 * The Yarn Berry registry policy for a yarn.lock: every .yarnrc.yml from the
 * lockfile's folder up to the workspace root plus $HOME/.yarnrc.yml, merged
 * (skipAll if any file sets it, scopes combined), then YARN_NPM_REGISTRY_SERVER
 * and YARN_NPM_SCOPES from the environment. YARN_RC_FILENAME makes Yarn read
 * a differently named rc file, so any non-empty value skips everything.
 */
export function yarnPolicyFor(rel, { cwd, env, fs }) {
  const policy = emptyRegistryPolicy();
  const files = foldersUp(cwd, rel).map((d) => path.join(d, '.yarnrc.yml'));
  if (homeDir(env)) files.push(path.join(homeDir(env), '.yarnrc.yml'));
  for (const f of files) {
    const text = readConfig(fs, f);
    if (text === UNREADABLE) {
      policy.skipAll = true;
      continue;
    }
    if (text === null) continue;
    const p = berryPolicy(text);
    if (p.skipAll) policy.skipAll = true;
    for (const s of p.privateScopes) policy.privateScopes.add(s);
  }
  for (const [name, value] of Object.entries(env)) {
    const k = name.toUpperCase();
    if (k === 'YARN_NPM_REGISTRY_SERVER' && !isDefaultYarnRegistry(value)) policy.skipAll = true;
    if (k === 'YARN_NPM_SCOPES') policy.skipAll = true;
    if (k === 'YARN_RC_FILENAME' && typeof value === 'string' && value !== '') policy.skipAll = true;
  }
  return policy;
}

const PIP_ENV = ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_PYPI_URL', 'PIP_CONFIG_FILE', 'UV_INDEX_URL', 'UV_EXTRA_INDEX_URL', 'UV_INDEX', 'UV_DEFAULT_INDEX', 'UV_FIND_LINKS'];
const PIP_INDEX_KEYS = new Set(['index-url', 'extra-index-url', 'find-links', 'pypi-url']);

/** True when pip config text sets index-url, extra-index-url, or find-links (any case, "_" or "-"). */
export function pipConfigSetsIndex(text) {
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';' || line[0] === '[') continue;
    const cut = line.search(/[=:]/);
    const key = (cut === -1 ? line : line.slice(0, cut)).trim().toLowerCase().replace(/_/g, '-').replace(/^-+/, '');
    if (PIP_INDEX_KEYS.has(key)) return true;
  }
  return false;
}

/**
 * True when pip or uv is pointed at a package index other than PyPI in this
 * job: one of the pip or uv index variables has a value, or a standard pip
 * config file sets an index.
 */
export function pipIndexConfigured({ env, fs }) {
  if (PIP_ENV.some((k) => typeof env[k] === 'string' && env[k] !== '')) return true;
  const files = ['/etc/pip.conf', '/etc/xdg/pip/pip.conf'];
  const home = homeDir(env);
  if (home) files.push(path.join(home, '.pip', 'pip.conf'), path.join(home, '.config', 'pip', 'pip.conf'));
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, 'pip', 'pip.conf'));
  if (env.APPDATA) files.push(path.join(env.APPDATA, 'pip', 'pip.ini'));
  if (env.VIRTUAL_ENV) files.push(path.join(env.VIRTUAL_ENV, 'pip.conf'));
  for (const f of files) {
    const text = readConfig(fs, f);
    if (text === UNREADABLE || (text !== null && pipConfigSetsIndex(text))) return true;
  }
  return false;
}

// uv keys that point it at another index. `index` is the inline form of
// [[index]] (`index = [{ ... }]`) and also names an index for one source.
const UV_INDEX_KEYS = new Set(['index-url', 'extra-index-url', 'find-links', 'index']);
const UV_INLINE_INDEX = /(?:^|[\s{,"'])(?:extra-index-url|index-url|find-links|index)["']?\s*=/;

// "tool . 'uv' . Index_URL" -> "tool.uv.index-url"
function keyPath(s) {
  return s.split('.').map((p) => p.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/_/g, '-')).join('.');
}

/**
 * True when uv config text sets index-url, extra-index-url, or find-links, or
 * declares an index ([[index]] in uv.toml, [[tool.uv.index]] in
 * pyproject.toml). In a pyproject.toml only settings under tool.uv count.
 * A small TOML line reader: table headers, then `key = value` lines.
 */
export function uvConfigSetsIndex(text, { pyproject }) {
  const indexTable = pyproject ? 'tool.uv.index' : 'index';
  let table = '';
  for (const raw of String(text).split(/\r\n|\r|\n/)) {
    const line = stripHashComment(raw).trim();
    if (!line) continue;
    if (line[0] === '[') {
      const array = line.startsWith('[[');
      const close = line.indexOf(array ? ']]' : ']');
      table = keyPath(line.slice(array ? 2 : 1, close === -1 ? line.length : close));
      if (array && table === indexTable) return true;
      continue;
    }
    const eq = line.indexOf('=');
    // No "=": the rest of a value that spans lines.
    if (eq === -1) continue;
    const full = table ? `${table}.${keyPath(line.slice(0, eq))}` : keyPath(line.slice(0, eq));
    if (pyproject && full !== 'tool.uv' && !full.startsWith('tool.uv.')) continue;
    if (UV_INDEX_KEYS.has(full.split('.').pop())) return true;
    // An inline table such as `uv = { index-url = "..." }` or `lib = { index = "corp" }`.
    if (UV_INLINE_INDEX.test(line.slice(eq + 1))) return true;
  }
  return false;
}

/**
 * True when a uv.toml, or a pyproject.toml with uv settings, in the
 * requirements file's folder or any parent up to the workspace root points
 * uv at another index. A config file that cannot be read counts as one that
 * does.
 */
export function uvProjectIndexConfigured(rel, { cwd, fs }) {
  for (const dir of foldersUp(cwd, rel)) {
    for (const [name, pyproject] of [['uv.toml', false], ['pyproject.toml', true]]) {
      const text = readConfig(fs, path.join(dir, name));
      if (text === null) continue;
      if (text === UNREADABLE || uvConfigSetsIndex(text, { pyproject })) return true;
    }
  }
  return false;
}

/**
 * True when uv's user or system config points it at another index: the user
 * file ($XDG_CONFIG_HOME/uv/uv.toml, else $HOME/.config/uv/uv.toml), the
 * system files (/etc/uv/uv.toml and uv/uv.toml under each $XDG_CONFIG_DIRS
 * entry), and %APPDATA%\uv\uv.toml on Windows. Same rule as a project
 * uv.toml; a file that cannot be read counts as one that does.
 */
export function uvUserIndexConfigured({ env, fs }) {
  const files = [];
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, 'uv', 'uv.toml'));
  else if (homeDir(env)) files.push(path.join(homeDir(env), '.config', 'uv', 'uv.toml'));
  files.push('/etc/uv/uv.toml');
  for (const dir of String(env.XDG_CONFIG_DIRS || '').split(path.delimiter)) {
    if (dir) files.push(path.join(dir, 'uv', 'uv.toml'));
  }
  if (env.APPDATA) files.push(path.join(env.APPDATA, 'uv', 'uv.toml'));
  for (const f of files) {
    const text = readConfig(fs, f);
    if (text === UNREADABLE || (text !== null && uvConfigSetsIndex(text, { pyproject: false }))) return true;
  }
  return false;
}
