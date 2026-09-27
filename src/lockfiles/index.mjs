import { parseNpmLock } from './npm.mjs';
import { parsePnpmLock } from './pnpm.mjs';
import { parseYarnLock } from './yarn.mjs';
import { parsePoetryLock } from './poetry.mjs';
import { parseUvLock } from './uv.mjs';
import { parseRequirements } from './requirements.mjs';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ENTRIES = 20000;

export function lockfileKind(relPath) {
  const base = String(relPath).split('/').pop() || '';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return 'npm';
  if (base === 'pnpm-lock.yaml') return 'pnpm';
  if (base === 'yarn.lock') return 'yarn';
  if (base === 'poetry.lock') return 'poetry';
  if (base === 'uv.lock') return 'uv';
  if (/^requirements.*\.txt$/i.test(base)) return 'requirements';
  return null;
}

export function parseLockfile(relPath, text, ctx = {}) {
  let cleanText = text;
  if (typeof cleanText === 'string' && cleanText.charCodeAt(0) === 0xFEFF) {
    cleanText = cleanText.slice(1);
  }
  if (ctx && typeof ctx.yarnrc === 'string' && ctx.yarnrc.charCodeAt(0) === 0xFEFF) {
    ctx = { ...ctx, yarnrc: ctx.yarnrc.slice(1) };
  }
  const kind = lockfileKind(relPath);
  let r;
  switch (kind) {
    case 'npm': r = parseNpmLock(cleanText); break;
    case 'pnpm': r = parsePnpmLock(cleanText, { npmPolicy: ctx.npmPolicy ?? null }); break;
    case 'yarn': r = parseYarnLock(cleanText, { yarnrc: ctx.yarnrc ?? null, policy: ctx.yarnPolicy ?? null }); break;
    case 'poetry': r = parsePoetryLock(cleanText); break;
    case 'uv': r = parseUvLock(cleanText); break;
    case 'requirements': r = parseRequirements(cleanText); break;
    default: return { kind: null, entries: [], skipped: 0 };
  }
  return {
    kind,
    ...r,
    entries: r.entries.slice(0, MAX_ENTRIES).map((e) => ({ ...e, lockfile: relPath })),
    truncated: r.entries.length > MAX_ENTRIES,
  };
}
