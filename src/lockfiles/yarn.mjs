// yarn.lock v1 and Berry (v2+), parsed line by line.
// v1: public registry decided by the "resolved" URL.
// Berry: only "name@npm:version" resolutions count; the registry is not in the
// lockfile, so .yarnrc.yml npmRegistryServer / npmScopes decide privacy.
import { EXACT_VERSION, isPublicNpmUrl, stripHashComment } from './common.mjs';

const DEFAULT_NPM = /^(?:https?:\/\/)?registry\.(npmjs\.org|yarnpkg\.com)\/?$/i;

export function isDefaultYarnRegistry(value) {
  return typeof value === 'string' && DEFAULT_NPM.test(value);
}

export function berryPolicy(yarnrc) {
  const out = { skipAll: false, privateScopes: new Set() };
  if (!yarnrc) return out;
  yarnrc = yarnrc.replace(/^\uFEFF/, '');
  const server = /^["']?npmRegistryServer["']?[ \t]*:[ \t]*["']?([^"'\s#]+)/m.exec(yarnrc);
  if (server) {
    if (!DEFAULT_NPM.test(server[1])) out.skipAll = true;
  } else {
    // A top-level npmRegistryServer this column-0 reader could not read a
    // value from (JSON-flow syntax, or a value on the next line) fails
    // closed, the same shape as the npmScopes fallback below. An indented
    // line (for example a per-scope npmRegistryServer nested under
    // npmScopes) is not top-level and does not trigger this.
    const unread = yarnrc.split(/\r\n|\r|\n/).some((l) => l === l.trimStart() && !l.startsWith('#') && l.includes('npmRegistryServer'));
    if (unread) out.skipAll = true;
  }
  const headerMatch = /^["']?npmScopes["']?[ \t]*:[ \t]*([^\r\n]*)$/m.exec(yarnrc);
  if (!headerMatch) {
    // npmScopes somewhere this parser cannot read fails closed, but a
    // comment line that merely mentions it does not.
    const mentioned = yarnrc.split(/\r\n|\r|\n/).some((l) => l.includes('npmScopes') && !l.trimStart().startsWith('#'));
    if (mentioned) out.skipAll = true;
    return out;
  }
  const rest = stripHashComment(headerMatch[1]).trim();
  if (rest) {
    out.skipAll = true;
    return out;
  }
  const headerEnd = headerMatch.index + headerMatch[0].length;
  const blockText = yarnrc.slice(headerEnd);
  const blockLines = blockText.split(/\r?\n/).slice(1);
  let minIndent = Infinity;
  const scopeLines = [];
  for (const line of blockLines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\S/.test(line)) break;
    const m = /^([ \t]+)/.exec(line);
    if (m) {
      minIndent = Math.min(minIndent, m[1].length);
      scopeLines.push(line);
    }
  }
  if (scopeLines.length === 0) {
    out.skipAll = true;
    return out;
  }
  for (const line of scopeLines) {
    const m = /^([ \t]+)["']?([A-Za-z0-9][\w.-]*)["']?[ \t]*:/.exec(line);
    if (m && m[1].length === minIndent) {
      if (m[2].toLowerCase() !== 'npmregistryserver') {
        out.privateScopes.add(`@${m[2].toLowerCase()}`);
      }
    }
  }
  return out;
}

function nameFromV1Key(line) {
  const first = line.replace(/:\s*$/, '').split(',')[0].trim().replace(/^"|"$/g, '');
  const scoped = first.startsWith('@');
  const at = first.indexOf('@', scoped ? 1 : 0);
  if (at <= 0) return null;
  const range = first.slice(at + 1);
  if (range.startsWith('npm:')) {
    const spec = range.slice(4);
    const s2 = spec.startsWith('@');
    const a2 = spec.indexOf('@', s2 ? 1 : 0);
    return a2 > 0 ? spec.slice(0, a2) : spec;
  }
  return first.slice(0, at);
}

function parseV1(text) {
  const entries = [];
  let skipped = 0;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (!c.name || !EXACT_VERSION.test(c.version || '') || !isPublicNpmUrl(c.resolved)) {
      skipped++;
      return;
    }
    entries.push({ ecosystem: 'npm', name: c.name, version: c.version.replace(/^v/, '') });
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      flush();
      cur = { name: nameFromV1Key(raw), version: null, resolved: null };
      continue;
    }
    if (!cur) continue;
    const v = /^ {2}version "?([^"\s]+)"?\s*$/.exec(raw);
    if (v) {
      cur.version = v[1];
      continue;
    }
    const r = /^ {2}resolved "?([^"\s]+)"?\s*$/.exec(raw);
    if (r) cur.resolved = r[1];
  }
  flush();
  return { entries, skipped };
}

function parseBerry(text, policy) {
  const entries = [];
  let skipped = 0;
  let registrySkipped = 0;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const res = cur.resolution;
    cur = null;
    const m = res ? /^(@[^/]+\/[^@]+|[^@]+)@npm:(.+)$/.exec(res) : null;
    if (!m || !EXACT_VERSION.test(m[2])) {
      skipped++;
      return;
    }
    const name = m[1];
    const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')).toLowerCase() : null;
    if (policy.skipAll || (scope && policy.privateScopes.has(scope))) {
      skipped++;
      registrySkipped++;
      return;
    }
    entries.push({ ecosystem: 'npm', name, version: m[2].replace(/^v/, '') });
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      flush();
      cur = raw.startsWith('__metadata') ? null : { resolution: null };
      continue;
    }
    if (!cur) continue;
    const r = berryResolution(raw);
    if (r !== null) cur.resolution = r;
  }
  flush();
  return { entries, skipped, registrySkipped };
}

const RESOLUTION = '  resolution: ';

// Reads the same value as /^ {2}resolution: "?([^"]+)"?\s*$/ without its
// quadratic backtracking: an optional opening quote, a non-empty value with
// no quote in it, then optionally a closing quote followed only by
// whitespace.
function berryResolution(raw) {
  if (!raw.startsWith(RESOLUTION)) return null;
  let s = raw.slice(RESOLUTION.length);
  if (s.startsWith('"')) s = s.slice(1);
  const q = s.indexOf('"');
  const value = q === -1 ? s : s.slice(0, q);
  if (!value) return null;
  if (q !== -1 && s.slice(q + 1).trim() !== '') return null;
  return value;
}

/**
 * Berry entries are checked against `policy` ({ skipAll, privateScopes },
 * merged from every .yarnrc.yml and the environment that Yarn would use)
 * when one is passed, otherwise against the single `yarnrc` text.
 */
export function parseYarnLock(text, { yarnrc = null, policy = null } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return /^__metadata:\s*$/m.test(text) ? parseBerry(text, policy || berryPolicy(yarnrc)) : parseV1(text);
}
