// A requirements file can pull in other files with -r / --requirement and
// -c / --constraint, and pip applies an index option from any of them to the
// whole install. So before a requirements file's packages may be sent, every
// file it includes is read (through the injected fs) and checked too.
//
// Includes resolve relative to the including file's folder. Only regular
// files inside the workspace are followed, at most MAX_INCLUDE_DEPTH levels
// deep, each file once. The result for the including file is:
//   'custom_index'        some file in the chain sets an index option
//   'unreadable_include'  an include is missing, not a regular file, outside
//                         the workspace, a URL, holds a ${VAR}, or is too deep
//   null                  nothing found; the file is parsed as usual
import path from 'node:path';
import { isIndexOption, longOptionName, namesOption } from './lockfiles/requirements.mjs';
import { stripHashComment } from './lockfiles/common.mjs';
import { MAX_FILE_BYTES } from './lockfiles/index.mjs';

export const MAX_INCLUDE_DEPTH = 5;

// Long forms count when cut short too (--req, --cons), as pip allows.
const LONG_INCLUDE_OPTIONS = ['--requirement', '--constraint'];
const SHORT_INCLUDE_FLAGS = new Set(['-r', '-c']);
const INCLUDE_SHORT = /^-[rc]./;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Splits an option line into words; single or double quotes group a word.
function words(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let inWord = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

// The include paths of one file, whether it sets an index option, and
// whether an include option has no path after it.
function scan(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  const found = { index: false, dangling: false, includes: [] };
  for (const raw of t.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = stripHashComment(raw).trim();
    if (!line.startsWith('-')) continue;
    const w = words(line);
    for (let i = 0; i < w.length; i++) {
      const word = w[i];
      const name = longOptionName(word);
      const longInclude = name !== null && LONG_INCLUDE_OPTIONS.some((full) => namesOption(name, full));
      if (SHORT_INCLUDE_FLAGS.has(word) || (longInclude && word === name)) {
        // The path is the next word.
        if (i + 1 >= w.length) found.dangling = true;
        else found.includes.push(w[++i]);
      } else if (longInclude) {
        // --requirement=path (name, then "=", then the path)
        found.includes.push(word.slice(name.length + 1));
      } else if (INCLUDE_SHORT.test(word)) {
        found.includes.push(word.slice(2).replace(/^=/, ''));
      } else if (isIndexOption(word)) {
        found.index = true;
      }
    }
  }
  return found;
}

// The absolute path of an include, or null when it cannot be followed.
function resolveInclude(fromAbs, target, cwd) {
  // "C:\x" is a Windows path, not a URL; it is then outside the workspace.
  const drivePath = /^[A-Za-z]:[\\/]/.test(target);
  if (!target || target.includes('${') || (URL_LIKE.test(target) && !drivePath)) return null;
  const abs = path.resolve(path.dirname(fromAbs), target);
  const rel = path.relative(cwd, abs);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return abs;
}

/** Checks a requirements file's include chain. `rel` is workspace-relative with "/" separators. */
export function requirementsIncludeProblem(rel, text, { cwd, fs }) {
  const rootAbs = path.join(cwd, ...rel.split('/'));
  const seen = new Set([rootAbs]);
  const queue = [{ abs: rootAbs, text, depth: 0 }];
  while (queue.length) {
    const { abs, text: body, depth } = queue.shift();
    const found = scan(body);
    if (found.index) return 'custom_index';
    if (found.dangling) return 'unreadable_include';
    for (const target of found.includes) {
      if (depth + 1 > MAX_INCLUDE_DEPTH) return 'unreadable_include';
      const next = resolveInclude(abs, target, cwd);
      if (!next) return 'unreadable_include';
      if (seen.has(next)) continue;
      seen.add(next);
      const st = fs.lstat(next);
      if (!st || !st.isFile || st.size > MAX_FILE_BYTES) return 'unreadable_include';
      const included = fs.readFile(next);
      if (included === null) return 'unreadable_include';
      queue.push({ abs: next, text: included, depth: depth + 1 });
    }
  }
  return null;
}
