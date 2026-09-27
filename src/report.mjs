// Job summary, annotations, outputs, and the exit code. No I/O here.
import { MAX_LOCKFILES } from './discover.mjs';
import { MAX_ENTRIES } from './lockfiles/index.mjs';

const ENTRY_CAP = MAX_ENTRIES.toLocaleString('en-US');
const MAX_ROWS = 200;
const ORDER = { BLOCK: 0, REVIEW: 1, NOT_FOUND: 2, UNKNOWN: 3, GO: 4 };
const DOCS = 'https://tensorfeed.ai/developers#package-check';
const KEYS = 'https://tensorfeed.ai/developers/agent-payments';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const cmdData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cmdProp = (s) => cmdData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const reasonText = (result) => (Array.isArray(result.reasons) ? result.reasons.map((r) => r && r.message).filter(Boolean).join(' ') : '');
const plural = (n, singular, plural) => n === 1 ? singular : plural;

export function tally(checked, unchecked) {
  const t = { blocked: 0, review: 0, notFound: 0, unknown: 0, go: 0, checked: checked.length, unchecked: unchecked.length };
  for (const { result } of checked) {
    const v = result && result.verdict;
    if (v === 'BLOCK') t.blocked++;
    else if (v === 'REVIEW') t.review++;
    else if (v === 'NOT_FOUND') t.notFound++;
    else if (v === 'GO') t.go++;
    else t.unknown++;
  }
  return t;
}

export function annotations(checked) {
  const out = [];
  for (const { entry, result } of checked) {
    const v = result && result.verdict;
    if (v !== 'BLOCK' && v !== 'REVIEW') continue;
    const level = v === 'BLOCK' ? 'error' : 'warning';
    out.push(`::${level} file=${cmdProp(entry.lockfile)},title=${cmdProp(`TensorFeed: ${v}`)}::${cmdData(`${entry.name} ${entry.version}: ${reasonText(result)}`)}`);
  }
  return out;
}

export function exitCode(checked, { mode, failOnReview }) {
  const t = tally(checked, []);
  // fail-on-review is the stricter setting, so it never lets a BLOCK pass,
  // even in warn mode.
  if (t.blocked > 0 && (mode !== 'warn' || failOnReview)) return 1;
  if (failOnReview && t.review > 0) return 1;
  return 0;
}

export function buildSummary({ checked, unchecked, stop, errors, rejected = 0, limitScope, stopError, meta }) {
  const t = tally(checked, unchecked);
  const lines = ['## TensorFeed Package Check', ''];
  lines.push(`**BLOCK ${t.blocked}, REVIEW ${t.review}, not found ${t.notFound}, unknown ${t.unknown}, GO ${t.go}, unchecked ${t.unchecked}**`, '');
  lines.push(`Scanned ${meta.scanned === 'changed' ? 'packages changed in this pull request' : 'every package'} across ${meta.lockfiles} ${plural(meta.lockfiles, 'lockfile', 'lockfiles')}; ${meta.sent} ${plural(meta.sent, 'package', 'packages')} ${plural(meta.sent, 'was', 'were')} queued for checking.`);
  if (meta.fallbackAll) lines.push('', 'Note: the check could not read the base commit, so every package was checked instead of only the changes.');
  if (meta.skipped > 0) lines.push('', `${meta.skipped} ${plural(meta.skipped, 'package was', 'packages were')} skipped because ${plural(meta.skipped, 'its', 'their')} source is not the public npm or PyPI registry (private registries, git, local paths, or no recorded source). ${plural(meta.skipped, 'It was', 'They were')} not sent.`);
  if (meta.allowlisted > 0) lines.push('', `${meta.allowlisted} ${plural(meta.allowlisted, 'package was', 'packages were')} skipped by the allowlist.`);
  for (const n of meta.registryNotes || []) {
    lines.push('', `${n.count} ${plural(n.count, 'package', 'packages')} in ${cell(n.file)} ${plural(n.count, 'was', 'were')} skipped because the registry settings in \`${n.config}\` or this job's environment do not confirm ${plural(n.count, 'it comes', 'they come')} from the public npm registry.`);
  }
  for (const f of meta.skippedFiles) {
    let reason = f.reason;
    if (f.reason === 'custom_index') reason = 'it configures a custom package index';
    else if (f.reason === 'custom_index_env') reason = 'pip or uv is configured to use a custom package index';
    else if (f.reason === 'unreadable_include') reason = 'it includes another requirements file that could not be read';
    else if (f.reason === 'too_large') reason = 'larger than 50 MB';
    else if (f.reason === 'invalid_json') reason = 'it is not valid JSON';
    else reason = cell(f.reason);
    lines.push('', `Skipped ${cell(f.file)}: ${reason}.`);
  }
  const chooseFiles = 'Use the `lockfiles` input to choose which lockfiles to check.';
  if (meta.tooManyLockfiles) lines.push('', `More than ${MAX_LOCKFILES} lockfiles were found, so only the first ${MAX_LOCKFILES} were read. ${chooseFiles}`);
  for (const f of meta.truncatedFiles || []) {
    lines.push('', `${cell(f)} has more than ${ENTRY_CAP} packages, so only the first ${ENTRY_CAP} were read. ${chooseFiles}`);
  }

  const rows = checked
    .filter(({ result }) => result && (result.verdict === 'BLOCK' || result.verdict === 'REVIEW' || (result.verdict === 'NOT_FOUND' && result.did_you_mean)))
    .sort((a, b) => (ORDER[a.result.verdict] ?? 9) - (ORDER[b.result.verdict] ?? 9));
  if (rows.length) {
    lines.push('', '| Verdict | Package | Version | Lockfile | Reason |', '|:-|:-|:-|:-|:-|');
    for (const { entry, result } of rows.slice(0, MAX_ROWS)) {
      let reason = reasonText(result);
      if (result.did_you_mean && !reason.includes('Did you mean')) reason += ` Did you mean ${result.did_you_mean}?`;
      const url = Array.isArray(result.reasons) && result.reasons[0] && result.reasons[0].source_url;
      const src = url && /^https?:\/\//i.test(url) ? ` [source](${url})` : '';
      lines.push(`| ${result.verdict} | ${cell(entry.name)} | ${cell(entry.version)} | ${cell(entry.lockfile)} | ${cell(reason.trim())}${src} |`);
    }
    if (rows.length > MAX_ROWS) lines.push(`|  | and ${rows.length - MAX_ROWS} more |  |  |  |`);
  }

  const notChecked = `${t.unchecked} ${plural(t.unchecked, 'package was', 'packages were')} not checked.`;
  const addKey = `Add a TensorFeed key as the \`tensorfeed-token\` input to check everything: ${KEYS}`;
  if (stop === 'free_cap') {
    lines.push('', limitScope === 'ip'
      ? `The free per-IP daily limit was reached. ${notChecked} ${addKey}`
      : `Free daily limit reached for this repository (1,000 package checks per UTC day). ${notChecked} ${addKey}`);
  }
  if (stop === 'no_credits') lines.push('', `Your TensorFeed key is out of credits. ${notChecked} Top up: ${KEYS}`);
  if (stop === 'bad_token') lines.push('', `The TensorFeed key was rejected. ${notChecked}`);
  if (stop === 'refused') lines.push('', `TensorFeed refused the request. ${notChecked} The job was not failed for this.`);
  if (stop === 'rate_limited') {
    lines.push('', meta.paid && typeof stopError === 'string' && /cap/i.test(stopError)
      ? `Your TensorFeed key reached its daily cap. ${notChecked} The job was not failed for this.`
      : `TensorFeed rate-limited this run (too many requests in a short time). ${notChecked} The job was not failed for this; re-run the job to check them.`);
  }
  if (stop === 'unreachable') lines.push('', `TensorFeed could not be reached, so ${t.unchecked} ${plural(t.unchecked, 'package was', 'packages were')} not checked. The job was not failed for this.`);
  // When TensorFeed could not be reached, the line above already covers
  // every request that did not answer.
  if (errors > 0 && stop !== 'unreachable') lines.push('', `${errors === 1 ? 'One' : errors} ${plural(errors, 'request to TensorFeed did', 'requests to TensorFeed did')} not answer, so ${errors === 1 ? 'its' : 'their'} packages were not checked. The job was not failed for this.`);
  if (rejected > 0) lines.push('', `${rejected === 1 ? 'One' : rejected} ${plural(rejected, 'request was', 'requests were')} rejected by TensorFeed, so ${rejected === 1 ? 'its' : 'their'} packages were not checked.`);

  if (!meta.sent) lines.push('', `No packages were sent to TensorFeed. Docs: ${DOCS}`);
  else lines.push('', meta.paid
    ? `Only package names and versions recorded as coming from the public npm and PyPI registries, the action version, and your TensorFeed key (over HTTPS) were sent to TensorFeed. Docs: ${DOCS}`
    : `Only package names and versions recorded as coming from the public npm and PyPI registries, a hashed repository ID, and the action version were sent to TensorFeed. Docs: ${DOCS}`);
  return lines.join('\n');
}
