// Shared helpers for lockfile parsing. Pure functions, no I/O.

export const EXACT_VERSION = /^v?\d[0-9A-Za-z.+!_-]{0,99}$/;

const PUBLIC_NPM_HOSTS = new Set(['registry.npmjs.org', 'registry.yarnpkg.com']);
const PUBLIC_PYPI_HOSTS = new Set(['pypi.org', 'files.pythonhosted.org']);

/**
 * Cuts a "#" comment that starts the line or follows whitespace (pip and
 * YAML both read comments this way). One linear search, then a slice, so a
 * long hostile line cannot trigger regex backtracking.
 */
export function stripHashComment(line) {
  const m = /(?:^|\s)#/.exec(line);
  return m ? line.slice(0, m.index) : line;
}

export function pep503(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function hostIn(u, hosts) {
  if (typeof u !== 'string' || !u) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && hosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isPublicNpmUrl(u) {
  return hostIn(u, PUBLIC_NPM_HOSTS);
}

export function isPublicPypiUrl(u) {
  return hostIn(u, PUBLIC_PYPI_HOSTS);
}

/** Identity of a package across base and head. npm names are case-sensitive; PyPI uses PEP 503. */
export function entryKey(e) {
  return e.ecosystem === 'pypi' ? `pypi|${pep503(e.name)}` : `npm|${e.name}`;
}
