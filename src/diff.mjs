import { entryKey } from './lockfiles/common.mjs';

const SHA_RE = /^[0-9a-f]{40,64}$/;

export function prBaseSha(eventName, event) {
  if (eventName !== 'pull_request' && eventName !== 'pull_request_target') return null;
  const sha = event && event.pull_request && event.pull_request.base && event.pull_request.base.sha;
  return typeof sha === 'string' && SHA_RE.test(sha) ? sha : null;
}

/**
 * Reads each lockfile at the base commit. The base is fetched only when it is
 * not already present, and with --depth=1 only when the clone is already
 * shallow, so a full clone is never made shallow. null when the fetch fails.
 */
export function readBaseFiles(baseSha, paths, exec) {
  const present = exec('git', ['cat-file', '-e', `${baseSha}^{commit}`]);
  if (present.status !== 0) {
    const shallow = exec('git', ['rev-parse', '--is-shallow-repository']);
    const depth = shallow.status === 0 && shallow.stdout.trim() === 'true' ? ['--depth=1'] : [];
    const f = exec('git', ['fetch', '--no-tags', ...depth, 'origin', baseSha]);
    if (f.status !== 0) return null;
  }
  const out = new Map();
  for (const p of paths) {
    const r = exec('git', ['show', `${baseSha}:${p}`]);
    out.set(p, r.status === 0 ? r.stdout : null);
  }
  return out;
}

/** Head entries whose exact version did not exist at base under the same package. */
export function changedEntries(head, base) {
  const baseVersions = new Map();
  for (const e of base) {
    const k = entryKey(e);
    if (!baseVersions.has(k)) baseVersions.set(k, new Set());
    baseVersions.get(k).add(e.version);
  }
  return head.filter((e) => {
    const vs = baseVersions.get(entryKey(e));
    return !vs || !vs.has(e.version);
  });
}

export function dedupeEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const k = `${entryKey(e)}|${e.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
