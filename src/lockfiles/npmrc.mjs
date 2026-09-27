// npm registry settings for pnpm lockfiles, read from .npmrc text and
// npm_config_ environment variables with a small line parser (no ini
// dependency). pnpm-lock.yaml records only an integrity hash for a package
// that came from a scope's configured registry, so these settings decide
// whether a pnpm entry may be sent. Only `registry` and `@scope:registry`
// matter here, and anything the parser is unsure about counts as private.

// The public registry: registry.npmjs.org or registry.yarnpkg.com, http or
// https, with or without a trailing slash.
const DEFAULT_REGISTRY = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/?$/i;
const SCOPED_REGISTRY = /^(@[^:\s]+):registry$/;
const ENV_PREFIX = 'npm_config_';

export function emptyRegistryPolicy() {
  return { skipAll: false, privateScopes: new Set() };
}

/** A ${VAR} placeholder, an empty value, or any other host is not the default. */
export function isDefaultNpmRegistry(value) {
  return typeof value === 'string' && !value.includes('${') && DEFAULT_REGISTRY.test(value);
}

function unquote(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

// An ini value: quotes are removed; otherwise an unescaped ";" or "#" starts
// an inline comment.
function iniValue(raw) {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  let end = v.length;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\') {
      i++;
      continue;
    }
    if (v[i] === ';' || v[i] === '#') {
      end = i;
      break;
    }
  }
  return v.slice(0, end).trim();
}

/** Applies one setting to the policy. `value` is null when the line has no "=". */
export function applyNpmSetting(policy, rawKey, value) {
  const key = unquote(String(rawKey).trim());
  // "//host/:_authToken" and friends configure credentials for a registry;
  // they never choose one.
  if (key.startsWith('//')) return;
  // A placeholder in the key could expand to any setting, including a registry.
  if (key.includes('${')) {
    policy.skipAll = true;
    return;
  }
  const k = key.toLowerCase();
  if (!k.endsWith('registry')) return;
  const isDefault = isDefaultNpmRegistry(value);
  if (k === 'registry') {
    if (!isDefault) policy.skipAll = true;
    return;
  }
  const scoped = SCOPED_REGISTRY.exec(k);
  if (scoped) {
    if (!isDefault) policy.privateScopes.add(scoped[1]);
    return;
  }
  // Some other key ending in "registry" that this parser cannot place.
  policy.skipAll = true;
}

/** Applies every line of one .npmrc file. Lines starting with "#" or ";" are comments. */
export function applyNpmrc(policy, text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  // ini treats a bare CR as a line break too.
  for (const raw of t.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const eq = line.indexOf('=');
    if (eq === -1) applyNpmSetting(policy, line, null);
    else applyNpmSetting(policy, line.slice(0, eq), iniValue(line.slice(eq + 1)));
  }
}

/** Applies npm_config_* environment variables; the prefix and key match case-insensitively. */
export function applyNpmEnv(policy, env) {
  for (const [name, value] of Object.entries(env || {})) {
    if (name.length <= ENV_PREFIX.length || name.slice(0, ENV_PREFIX.length).toLowerCase() !== ENV_PREFIX) continue;
    applyNpmSetting(policy, name.slice(ENV_PREFIX.length), typeof value === 'string' ? value : '');
  }
}
