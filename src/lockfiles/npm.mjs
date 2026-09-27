// package-lock.json / npm-shrinkwrap.json (lockfile v1, v2, v3).
// Only entries whose recorded download URL is the public npm registry are
// returned; everything else (private registries, git, links, entries with no
// recorded source) is counted as skipped and never sent.
import { EXACT_VERSION, isPublicNpmUrl } from './common.mjs';

export function parseNpmLock(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { entries: [], skipped: 0, error: 'invalid_json' };
  }
  const entries = [];
  let skipped = 0;
  const add = (name, meta) => {
    const version = typeof meta.version === 'string' ? meta.version : '';
    if (!name || !EXACT_VERSION.test(version) || !isPublicNpmUrl(meta.resolved)) {
      skipped++;
      return;
    }
    entries.push({ ecosystem: 'npm', name, version: version.replace(/^v/, '') });
  };

  if (doc && typeof doc === 'object' && doc.packages && typeof doc.packages === 'object') {
    for (const [path, meta] of Object.entries(doc.packages)) {
      if (!meta || typeof meta !== 'object') continue;
      const i = path.lastIndexOf('node_modules/');
      if (i === -1) continue; // the root "" entry and workspace folders
      if (meta.link === true) {
        skipped++;
        continue;
      }
      const dirName = path.slice(i + 'node_modules/'.length);
      add(typeof meta.name === 'string' ? meta.name : dirName, meta);
    }
  } else if (doc && typeof doc === 'object' && doc.dependencies && typeof doc.dependencies === 'object') {
    const walk = (deps, depth) => {
      if (depth > 64) return;
      for (const [name, meta] of Object.entries(deps)) {
        if (!meta || typeof meta !== 'object') continue;
        let real = name;
        let m = meta;
        if (typeof meta.version === 'string' && meta.version.startsWith('npm:')) {
          const spec = meta.version.slice(4);
          const at = spec.lastIndexOf('@');
          if (at > 0) {
            real = spec.slice(0, at);
            m = { ...meta, version: spec.slice(at + 1) };
          }
        }
        add(real, m);
        if (meta.dependencies && typeof meta.dependencies === 'object') walk(meta.dependencies, depth + 1);
      }
    };
    walk(doc.dependencies, 0);
  }
  return { entries, skipped };
}
