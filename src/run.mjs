import path from 'node:path';
import { readdirSync, readFileSync, lstatSync, statSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readInputs } from './inputs.mjs';
import { findLockfiles, globToRegExp } from './discover.mjs';
import { parseLockfile, lockfileKind, MAX_FILE_BYTES } from './lockfiles/index.mjs';
import { npmPolicyFor, yarnPolicyFor, pipIndexConfigured, uvProjectIndexConfigured, uvUserIndexConfigured } from './registry-config.mjs';
import { requirementsIncludeProblem } from './requirements-includes.mjs';
import { prBaseSha, readBaseFiles, changedEntries, dedupeEntries } from './diff.mjs';
import { parseAllowlist, isAllowlisted } from './allowlist.mjs';
import { checkAll, repoHash, DEFAULT_FREE_URL, DEFAULT_PREMIUM_URL } from './client.mjs';
import { annotations, buildSummary, exitCode, tally } from './report.mjs';

export const VERSION = '1.0.0';

const count = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;

// What a package name and version must look like to be sent.
const SEND_NAME = /^[@A-Za-z0-9_./-]{1,200}$/;
const SEND_VERSION = /^v?\d[0-9A-Za-z.+!_-]{0,99}$/;

function readEvent(env, fs) {
  const text = env.GITHUB_EVENT_PATH ? fs.readFile(env.GITHUB_EVENT_PATH) : null;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// An unparseable URL counts as not HTTPS.
function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function run({ env, cwd, fs, exec, fetchImpl, log }) {
  const inputs = readInputs(env);
  if (inputs.token) log(`::add-mask::${inputs.token}`);

  // The token is only ever sent over HTTPS. A local
  // TENSORFEED_PACKAGE_CHECK_PREMIUM_URL override that is not https:// means
  // the token is dropped and the run falls back to the free tier, repo hash
  // header and all.
  const premiumUrl = env.TENSORFEED_PACKAGE_CHECK_PREMIUM_URL || DEFAULT_PREMIUM_URL;
  let token = inputs.token;
  if (token && !isHttps(premiumUrl)) {
    log('::warning::TensorFeed package check: the premium URL is not HTTPS, so the token was not used; checking on the free tier.');
    token = null;
  }

  const patterns = inputs.lockfiles ? inputs.lockfiles.map(globToRegExp) : null;
  const { files, truncated: tooManyLockfiles } = findLockfiles(cwd, { readdir: fs.readdir }, patterns);
  const config = { cwd, env, fs };
  let pipIndex = null;

  const head = [];
  const skippedFiles = [];
  const truncatedFiles = [];
  const registryNotes = [];
  let skipped = 0;
  const parsed = [];
  for (const rel of files) {
    const abs = path.join(cwd, ...rel.split('/'));
    // Regular files only: a symlink, FIFO, or device is never opened.
    const st = fs.lstat(abs);
    if (!st || !st.isFile) continue;
    if (st.size > MAX_FILE_BYTES) {
      skippedFiles.push({ file: rel, reason: 'too_large' });
      continue;
    }
    const kind = lockfileKind(rel);
    // requirements files do not record where a package came from, so any
    // pip or uv index setting in this job, or in uv config next to the file
    // or above it, means none of its packages can be sent.
    if (kind === 'requirements') {
      if (pipIndex === null) pipIndex = pipIndexConfigured(config) || uvUserIndexConfigured(config);
      if (pipIndex || uvProjectIndexConfigured(rel, config)) {
        skippedFiles.push({ file: rel, reason: 'custom_index_env' });
        continue;
      }
    }
    const text = fs.readFile(abs);
    if (text === null) continue;
    // An index option in any file a requirements file includes (-r, -c)
    // applies to the whole install, so the include chain is checked too.
    if (kind === 'requirements') {
      const problem = requirementsIncludeProblem(rel, text, config);
      if (problem) {
        skippedFiles.push({ file: rel, reason: problem });
        continue;
      }
    }
    // pnpm and Yarn Berry lockfiles do not record the registry either; the
    // registry settings they would be installed with decide what may be sent.
    const ctx = {};
    if (kind === 'pnpm') ctx.npmPolicy = npmPolicyFor(rel, config);
    if (kind === 'yarn') ctx.yarnPolicy = yarnPolicyFor(rel, config);
    const r = parseLockfile(rel, text, ctx);
    if (r.skippedFile) skippedFiles.push({ file: rel, reason: r.skippedFile });
    // A lockfile that cannot be parsed is reported, not silently ignored.
    if (r.error) skippedFiles.push({ file: rel, reason: r.error });
    if (r.truncated) truncatedFiles.push(rel);
    if (r.registrySkipped) registryNotes.push({ file: rel, count: r.registrySkipped, config: kind === 'pnpm' ? '.npmrc' : '.yarnrc.yml' });
    skipped += r.skipped || 0;
    head.push(...r.entries);
    parsed.push({ rel, ctx });
  }
  const parsedFiles = parsed.map((p) => p.rel);

  let selected = head;
  let scanned = 'all';
  let fallbackAll = false;
  // The base SHA reaching git is always the value prBaseSha() validated
  // (40 to 64 lowercase hex); nothing else is ever passed to readBaseFiles.
  const baseSha = inputs.scan === 'changed' ? prBaseSha(env.GITHUB_EVENT_NAME, readEvent(env, fs)) : null;
  if (baseSha && parsedFiles.length === 0) {
    // Nothing to compare, so git is never called.
    scanned = 'changed';
  } else if (baseSha) {
    const baseTexts = readBaseFiles(baseSha, parsedFiles, exec);
    if (baseTexts) {
      const base = [];
      for (const { rel, ctx } of parsed) {
        const t = baseTexts.get(rel);
        if (t) base.push(...parseLockfile(rel, t, ctx).entries);
      }
      selected = changedEntries(head, base);
      scanned = 'changed';
    } else {
      fallbackAll = true;
    }
  }

  const allow = parseAllowlist(inputs.allowlist);
  const toSend = [];
  let allowlisted = 0;
  let invalid = 0;
  for (const e of dedupeEntries(selected)) {
    if (isAllowlisted(e.name, allow, e.ecosystem)) allowlisted++;
    // Only a well-formed name and version ever leaves the runner.
    else if (SEND_NAME.test(e.name) && SEND_VERSION.test(e.version)) toSend.push(e);
    else invalid++;
  }
  skipped += invalid;
  const invalidNote = invalid ? `, including ${invalid} with an invalid name or version` : '';
  const allowNote = allowlisted ? `, ${allowlisted} allowlisted` : '';
  log(`TensorFeed package check: ${count(files.length, 'lockfile', 'lockfiles')}, ${count(toSend.length, 'package', 'packages')} to check, skipped ${skipped} (private or unrecognized source${invalidNote})${allowNote}.`);

  const outcome = toSend.length
    ? await checkAll(toSend, {
        token,
        repoHashHex: await repoHash(env.GITHUB_REPOSITORY || ''),
        version: VERSION,
        fetchImpl,
        freeUrl: env.TENSORFEED_PACKAGE_CHECK_URL || DEFAULT_FREE_URL,
        premiumUrl,
      })
    : { checked: [], unchecked: [], stop: null, errors: 0, rejected: 0 };

  for (const line of annotations(outcome.checked)) log(line);
  const summary = buildSummary({
    ...outcome,
    meta: { scanned, fallbackAll, lockfiles: files.length, sent: toSend.length, skipped, allowlisted, skippedFiles, registryNotes, tooManyLockfiles, truncatedFiles, paid: Boolean(token) },
  });
  // A summary or output file that cannot be written is only a warning: the
  // verdict still decides the exit code.
  const write = (file, text, what) => {
    try {
      fs.appendFile(file, text);
    } catch {
      log(`::warning::TensorFeed package check could not write the ${what}.`);
    }
  };
  if (env.GITHUB_STEP_SUMMARY) write(env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'job summary');
  const t = tally(outcome.checked, outcome.unchecked);
  if (env.GITHUB_OUTPUT) write(env.GITHUB_OUTPUT, `blocked=${t.blocked}\nreview=${t.review}\nchecked=${t.checked}\nunchecked=${t.unchecked}\n`, 'step outputs');
  return exitCode(outcome.checked, inputs);
}

export async function main() {
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const fsDeps = {
    readdir: (d) => readdirSync(d, { withFileTypes: true }).map((x) => ({ name: x.name, isDir: x.isDirectory(), isFile: x.isFile() })),
    readFile: (f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    },
    // The entry itself, without following a symlink.
    lstat: (f) => {
      try {
        const s = lstatSync(f);
        return { isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink(), size: s.size };
      } catch {
        return null;
      }
    },
    // The target, following symlinks (config files may be links).
    stat: (f) => {
      try {
        const s = statSync(f);
        return { isFile: s.isFile(), size: s.size };
      } catch {
        return null;
      }
    },
    appendFile: (f, d) => appendFileSync(f, d),
  };
  const exec = makeExec(cwd, process.env);
  return run({ env: process.env, cwd, fs: fsDeps, exec, fetchImpl: (input, init) => fetch(input, init), log: (l) => process.stdout.write(`${l}\n`) });
}

const GIT_TIMEOUT_MS = 60000;

/**
 * Runs a command (git) in the workspace. Each call is killed after 60 s, and
 * GIT_TERMINAL_PROMPT=0 makes git fail instead of waiting for credentials. A
 * command that times out or cannot start reports status 1.
 */
export function makeExec(cwd, env, spawn = spawnSync) {
  return (cmd, args) => {
    const r = spawn(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  };
}
