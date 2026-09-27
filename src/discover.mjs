import path from 'node:path';
import { lockfileKind } from './lockfiles/index.mjs';

export const MAX_LOCKFILES = 50;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'dist', 'build']);

export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).trim().replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Breadth-first walk. Only regular files are candidates: symlinks, FIFOs, and
 * devices are ignored, and symlinked directories are not followed (readdir
 * reports a link as neither a file nor a directory). `truncated` is true when
 * more than MAX_LOCKFILES candidates exist.
 */
export function findLockfiles(root, { readdir }, patterns = null) {
  const files = [];
  let truncated = false;
  const queue = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length && !truncated) {
    const { dir, rel, depth } = queue.shift();
    let items;
    try {
      items = readdir(dir);
    } catch {
      continue;
    }
    const sorted = [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const it of sorted) {
      const relPath = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDir) {
        if (!SKIP_DIRS.has(it.name) && depth < MAX_DEPTH) queue.push({ dir: path.join(dir, it.name), rel: relPath, depth: depth + 1 });
        continue;
      }
      if (it.isFile !== true) continue;
      if (lockfileKind(relPath) === null) continue;
      if (patterns && !patterns.some((re) => re.test(relPath))) continue;
      if (files.length >= MAX_LOCKFILES) {
        truncated = true;
        break;
      }
      files.push(relPath);
    }
  }
  return { files, truncated };
}
