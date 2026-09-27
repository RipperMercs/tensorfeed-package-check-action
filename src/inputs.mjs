// GitHub passes inputs as INPUT_<NAME> env vars, uppercased, hyphens kept.
export function readInputs(env) {
  const get = (n) => String(env[`INPUT_${n.toUpperCase()}`] ?? '').trim();
  const list = get('lockfiles');
  return {
    mode: get('mode').toLowerCase() === 'warn' ? 'warn' : 'deny',
    failOnReview: /^(true|1|yes)$/i.test(get('fail-on-review')),
    token: get('tensorfeed-token') || null,
    lockfiles: list ? list.split(',').map((s) => s.trim()).filter(Boolean) : null,
    scan: get('scan').toLowerCase() === 'all' ? 'all' : 'changed',
    allowlist: get('allowlist'),
  };
}
