// requirements*.txt: only exact pins (== or ===) count as locked entries.
// A file that points pip at another index or a local wheel directory is
// skipped entirely (its names may be private).
import { EXACT_VERSION, stripHashComment } from './common.mjs';

// A prefix match, so attached forms such as "-ihttps://corp/simple" or
// "-f./wheels" are caught as well.
export const INDEX_OPTION = /^(-i|-f|--index-url|--extra-index-url|--find-links|--pypi-url)/;
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*===?\s*([A-Za-z0-9._+!-]+)$/;

// pip also accepts a long option cut short, such as --index for --index-url.
// pip's own requirements-file parser accepts prefixes as short as one letter
// after "--" (--i, --in, --ex, --f, --fi are all real pip abbreviations), so
// here a name of at least one letter after "--" that starts a full option
// name counts as that option.
const LONG_INDEX_OPTIONS = ['--index-url', '--extra-index-url', '--find-links', '--pypi-url'];
const MIN_LONG_NAME = 3;

/** The long option name that starts `s` ("--index" in "--index=x" or "--index x"), or null. */
export function longOptionName(s) {
  const m = /^--[^=\s]*/.exec(s);
  return m ? m[0] : null;
}

/** True when `name` is `full` or a cut-short form of it with at least one letter after "--". */
export function namesOption(name, full) {
  return typeof name === 'string' && name.length >= MIN_LONG_NAME && full.startsWith(name);
}

/** True when a line or word starts with an option that points pip at another index. */
export function isIndexOption(s) {
  if (INDEX_OPTION.test(s)) return true;
  const name = longOptionName(s);
  return LONG_INDEX_OPTIONS.some((full) => namesOption(name, full));
}

export function parseRequirements(text) {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  if (lines.some((l) => isIndexOption(l.trim()))) return { entries: [], skipped: 0, skippedFile: 'custom_index' };
  const entries = [];
  let skipped = 0;
  for (const raw of lines) {
    let l = stripHashComment(raw).trim();
    if (!l || l.startsWith('-')) continue;
    if (/:\/\//.test(l) || /^[.~/\\]/.test(l)) {
      skipped++;
      continue;
    }
    l = l.split(';')[0].replace(/\s--hash=\S+/g, '').trim();
    const m = PIN.exec(l);
    if (!m) continue;
    if (!EXACT_VERSION.test(m[3])) {
      skipped++;
      continue;
    }
    entries.push({ ecosystem: 'pypi', name: m[1], version: m[3] });
  }
  return { entries, skipped };
}
