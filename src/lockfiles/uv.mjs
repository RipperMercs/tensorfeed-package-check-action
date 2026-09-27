// uv.lock, parsed line by line. Only packages whose source is a registry on
// pypi.org are returned; editable, virtual, path, git, url, and private
// registries are skipped. name/version are read only at column 0 of the
// [[package]] table, so inline { name = ... } dependency tables are ignored.
import { EXACT_VERSION, isPublicPypiUrl } from './common.mjs';

export function parseUvLock(text) {
  const entries = [];
  let skipped = 0;
  let cur = null;
  let inTop = false;
  const flush = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (!c.name || !EXACT_VERSION.test(c.version || '') || !isPublicPypiUrl(c.registry)) {
      skipped++;
      return;
    }
    entries.push({ ecosystem: 'pypi', name: c.name, version: c.version });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\[\[package\]\]$/.test(line)) {
      flush();
      cur = { name: null, version: null, registry: null };
      inTop = true;
      continue;
    }
    if (/^\[/.test(line)) {
      inTop = false;
      if (!/^\[\[?package\./.test(line)) flush();
      continue;
    }
    if (!cur || !inTop) continue;
    const n = /^name = "([^"]+)"$/.exec(line);
    if (n) {
      cur.name = n[1];
      continue;
    }
    const v = /^version = "([^"]+)"$/.exec(line);
    if (v) {
      cur.version = v[1];
      continue;
    }
    const s = /^source = \{ registry = "([^"]+)" \}$/.exec(line);
    if (s) cur.registry = s[1];
  }
  flush();
  return { entries, skipped };
}
