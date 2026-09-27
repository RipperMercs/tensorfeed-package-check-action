// poetry.lock, parsed line by line. A package with a [package.source] table is
// kept only when that source URL is on pypi.org; git, directory, url, and
// private legacy sources are skipped.
import { EXACT_VERSION, isPublicPypiUrl } from './common.mjs';

export function parsePoetryLock(text) {
  const entries = [];
  let skipped = 0;
  let cur = null;
  let section = null;
  const flush = () => {
    if (!cur) return;
    const c = cur;
    cur = null;
    if (!c.name || !EXACT_VERSION.test(c.version || '')) {
      skipped++;
      return;
    }
    if (c.hasSource && !isPublicPypiUrl(c.sourceUrl)) {
      skipped++;
      return;
    }
    entries.push({ ecosystem: 'pypi', name: c.name, version: c.version });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\[\[package\]\]$/.test(line)) {
      flush();
      cur = { name: null, version: null, hasSource: false, sourceUrl: null };
      section = 'package';
      continue;
    }
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (!section.startsWith('package')) flush();
      else if (cur && section === 'package.source') cur.hasSource = true;
      continue;
    }
    if (!cur) continue;
    if (section === 'package') {
      const n = /^name = "([^"]+)"$/.exec(line);
      if (n) {
        cur.name = n[1];
        continue;
      }
      const v = /^version = "([^"]+)"$/.exec(line);
      if (v) cur.version = v[1];
    } else if (section === 'package.source') {
      const u = /^url = "([^"]+)"$/.exec(line);
      if (u) cur.sourceUrl = u[1];
    }
  }
  flush();
  return { entries, skipped };
}
