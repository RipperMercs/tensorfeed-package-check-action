// pnpm-lock.yaml v5, v6, v9, parsed line by line (no YAML dependency).
// Only entries under the top-level "packages:" key whose resolution is an
// integrity hash are returned; tarball, git, and directory resolutions are
// skipped. An integrity hash alone does not name the registry, so the npm
// registry policy passed in decides which of those entries may be sent.
import { EXACT_VERSION } from './common.mjs';

const RESOLUTION = '    resolution:';
// "." never matches a line break, so this is true only for a value without one.
const NO_LINE_BREAK = /^.*$/;

export function parsePnpmKey(rawKey) {
  let k = rawKey.trim();
  if ((k.startsWith("'") && k.endsWith("'")) || (k.startsWith('"') && k.endsWith('"'))) k = k.slice(1, -1);
  if (k.startsWith('/')) k = k.slice(1);
  const paren = k.indexOf('(');
  if (paren !== -1) k = k.slice(0, paren);
  // The name ends at the first '@' (v6, v9) or '/' (v5) after the scope, so a
  // v5 peer suffix like "18.2.0_react@18.2.0" never leaks into the name.
  const nameStart = k.startsWith('@') ? k.indexOf('/') + 1 : 0;
  if (k.startsWith('@') && nameStart === 0) return { name: null, version: null };
  const sep = k.slice(nameStart).search(/[@/]/);
  if (sep <= 0) return { name: null, version: null };
  const cut = nameStart + sep;
  return { name: k.slice(0, cut), version: k.slice(cut + 1).split('_')[0] };
}

/**
 * `npmPolicy` ({ skipAll, privateScopes }) comes from the .npmrc files and
 * environment that pnpm would use: the lockfile alone cannot show that an
 * integrity-only entry came from the public registry. Entries the policy
 * rules out are skipped and counted in `registrySkipped`.
 */
export function parsePnpmLock(text, { npmPolicy = null } = {}) {
  const entries = [];
  let skipped = 0;
  let registrySkipped = 0;
  let inPackages = false;
  let current = null;
  const privateByConfig = (name) => {
    if (!npmPolicy) return false;
    if (npmPolicy.skipAll) return true;
    return name.startsWith('@') && npmPolicy.privateScopes.has(name.slice(0, name.indexOf('/')).toLowerCase());
  };
  const flush = () => {
    if (!current) return;
    const { name, version, resolution } = current;
    current = null;
    if (!name || !version || !EXACT_VERSION.test(version)) {
      skipped++;
      return;
    }
    if (!resolution || !/\bintegrity:/.test(resolution) || /\b(tarball|directory|commit|repo|type):/.test(resolution)) {
      skipped++;
      return;
    }
    if (privateByConfig(name)) {
      skipped++;
      registrySkipped++;
      return;
    }
    entries.push({ ecosystem: 'npm', name, version: version.replace(/^v/, '') });
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) {
      flush();
      inPackages = /^packages:\s*$/.test(raw);
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(\S.*):\s*$/.exec(raw);
    if (key) {
      flush();
      current = { ...parsePnpmKey(key[1]), resolution: null };
      continue;
    }
    if (current && raw.startsWith(RESOLUTION)) {
      // Reads the same value as /^ {4}resolution:\s*(.*)$/ without its
      // quadratic backtracking: leading whitespace is dropped, and a value
      // that still holds a line break is not read at all.
      const value = raw.slice(RESOLUTION.length).trimStart();
      if (NO_LINE_BREAK.test(value)) current.resolution = value;
    }
  }
  flush();
  return { entries, skipped, registrySkipped };
}
