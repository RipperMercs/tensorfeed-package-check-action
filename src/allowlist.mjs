import { pep503 } from './lockfiles/common.mjs';

export function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Exact or trailing-* prefix match; PyPI compares PEP 503 forms. Arrays only, no object lookups. */
export function isAllowlisted(name, patterns, ecosystem) {
  const norm = (s) => (ecosystem === 'pypi' ? pep503(s) : String(s).toLowerCase());
  const n = norm(name);
  return patterns.some((p) => (p.endsWith('*') ? n.startsWith(norm(p.slice(0, -1))) : n === norm(p)));
}
