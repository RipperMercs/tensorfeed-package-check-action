# TensorFeed Package Check

A GitHub Action that checks the npm and PyPI packages your pull requests add or update, including transitive dependencies, before they merge.

- **BLOCK** (fails the check): known-malicious releases and likely typosquats.
- **REVIEW** (warning): a known critical or high vulnerability in that exact version, a name one typo away from a popular package, or a package first published in the last week.
- Everything else passes quietly. If the service is slow or unreachable, the check does not fail.

## Usage

```yaml
on: pull_request

jobs:
  package-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: RipperMercs/tensorfeed-package-check-action@v1
```

With a TensorFeed key, stored as a repository secret, to remove the free daily limit:

```yaml
on: pull_request

jobs:
  package-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: RipperMercs/tensorfeed-package-check-action@v1
        with:
          tensorfeed-token: ${{ secrets.TENSORFEED_TOKEN }}
```

Use `on: pull_request`, not `pull_request_target`. This action only reads lockfiles and never runs your code, and pull requests from forks automatically use the free tier.

Run the action on a clean checkout, before any install step, so it reads the lockfiles as they were committed.

On pull requests, only the packages the pull request adds or updates are checked. Push, schedule, and manual runs have nothing to compare against, so they check every package, and every one of those checks counts against the free daily limit.

## Inputs

| Input | Default | Meaning |
|:-|:-|:-|
| `mode` | `deny` | `deny` fails on BLOCK; `warn` does not, unless `fail-on-review` is `true` |
| `fail-on-review` | `false` | Also fail on REVIEW. When `true`, a BLOCK always fails the job, even in `warn` mode |
| `tensorfeed-token` | empty | TensorFeed credit token; removes the free daily cap |
| `lockfiles` | auto | Comma-separated paths or globs that filter the lockfiles found automatically. Only recognized lockfile names match, and folders such as `node_modules`, `.venv`, and `vendor` are still skipped |
| `scan` | `changed` | `changed` (pull request changes) or `all` |
| `allowlist` | empty | Names to never check, e.g. `left-pad, @acme/*, internal-*` |

Outputs: `blocked`, `review`, `checked`, `unchecked`.

## Supported lockfiles

`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (v1 and Berry), `poetry.lock`, `uv.lock`, and `requirements*.txt` (exact `==` pins only).

## Free tier and keys

Free: 1,000 package checks per repository per UTC day, and a free per-IP daily limit. When a limit is reached, the rest are listed as unchecked and the job does not fail. A TensorFeed key (`tensorfeed-token`, stored as a repository secret) removes the limit at 1 credit per request of up to 20 packages. Keys: https://tensorfeed.ai/developers/agent-payments

## What leaves the runner

Package names and versions recorded as coming from the public npm and PyPI registries, a SHA-256 hash of the repository name (free tier), the action version, and, if you set one, your TensorFeed key over HTTPS. Never lockfile contents, file paths, the repository name, commit data, or the GitHub token.

A package whose lockfile or registry configuration shows a private registry is skipped and never sent, and the job summary says why:

- `package-lock.json`, Yarn v1, Poetry, and uv lockfiles record where each package came from. Anything not from the public registry is skipped, and so are git and local dependencies and entries with no recorded source.
- pnpm and Yarn Berry lockfiles do not record the registry, so the action reads the registry settings those tools would use. For pnpm: every `.npmrc` from the lockfile's folder up to the repository root, your npm user config (the file named by `NPM_CONFIG_USERCONFIG`, or `~/.npmrc`), the file named by `NPM_CONFIG_GLOBALCONFIG`, pnpm's own `rc` file, and `npm_config_registry` or `npm_config_@scope:registry` in the job's environment. For Yarn Berry: every `.yarnrc.yml` from the lockfile's folder up to the repository root, `~/.yarnrc.yml`, and `YARN_NPM_REGISTRY_SERVER` or `YARN_NPM_SCOPES` in the job's environment; if `YARN_RC_FILENAME` is set, every Berry package is skipped. A scope with its own registry is skipped; any other registry for everything skips the whole lockfile. If a registry setting in one of these files cannot be read, the action treats it as private.
- A `requirements*.txt` file is skipped entirely when it, or any file it pulls in with `-r` or `-c`, sets its own index (`-i`, `--index-url`, `--extra-index-url`, `-f`, `--find-links`, `--pypi-url`, or any of these long options cut short to as little as one letter after the dashes, such as `--i` or `--in`); when an included file cannot be read (for example it is missing, outside the repository, a URL, or more than 5 levels deep); when a `uv.toml`, or a `pyproject.toml` with uv settings, in its folder or any parent folder up to the repository root sets an index; or when the job's environment sets `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, `PIP_FIND_LINKS`, `PIP_PYPI_URL`, `PIP_CONFIG_FILE`, `UV_INDEX_URL`, `UV_EXTRA_INDEX_URL`, `UV_INDEX`, `UV_DEFAULT_INDEX`, or `UV_FIND_LINKS`, or a pip config file (including one in the active virtualenv) sets `index-url`, `extra-index-url`, `find-links`, or `pypi-url`, or uv's user or system `uv.toml` sets an index.

In this version a registry mirror configured in `.npmrc` or `.yarnrc.yml` counts as private, so the packages it serves are skipped; a PyPI mirror set through pip or uv config is treated the same way.

The action can only see the configuration listed above, in the repository and in its own job's environment; a registry or index set anywhere else, such as a config file named by `UV_CONFIG_FILE` or a requirements line whose index or version uses a `${VARIABLE}` placeholder, is invisible to it. Private packages hosted on the public npm registry (for example a paid npm organization scope) cannot be told apart from public ones. In all these cases, add the names to `allowlist` so they are never sent:

```yaml
      - uses: RipperMercs/tensorfeed-package-check-action@v1
        with:
          allowlist: '@acme/*'
```

## Limits

It cannot catch a hijacked release of a popular package until OSV lists it. It is one layer of defense, not a guarantee.

It reads at most 50 lockfiles per run and 20,000 packages per lockfile; the summary says when either limit was reached.

API docs: https://tensorfeed.ai/developers#package-check

License: MIT
