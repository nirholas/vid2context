# CI

GitHub Actions is unavailable on the owner's account (billing locked since 2026-09-15), so `.github/workflows/ci.yml` was removed on 2026-11-14: it could never run. CI now runs locally with one command, and the same command runs on Google Cloud Build.

## Local CI

```sh
npm run ci                     # every step, stops at the first failure
npm run ci -- --keep-going     # every step, reports all failures
npm run ci -- --only lint,test
npm run ci -- --skip build,smoke
npm run ci -- --list
```

The runner is [tooling/ci/run.mjs](../tooling/ci/run.mjs) (Node, no dependencies). It times each step and ends with a table:

| Step | What it runs |
|---|---|
| `gen` | `npm run gen` (provider registries) |
| `typecheck` | `tsc -p tsconfig.json` |
| `lint` | `biome check .` |
| `test` | `vitest run` (unit tests on recorded fixtures, no network) |
| `tooling-test` | `vitest run --config tooling/vitest.config.ts` (tests for this tooling) |
| `conformance` | `npm run conformance`, when that script exists |
| `hygiene` | the house-rule checks below |
| `build` | `npm run build:npm` (the publishable bundles) |
| `smoke` | runs the bundles: `vid2context --help`, and `initialize` over stdio against `vid2context-mcp` |
| `eval` | `npm run eval -- --check`, only with `LIVE=1` |

A step whose script does not exist is reported as `absent`, not as a pass. The exit code is nonzero when any step fails.

## Hygiene checks

```sh
npm run hygiene                    # all checks on tracked files
npm run hygiene -- --staged        # only staged files, reading their staged contents
npm run hygiene -- secrets no-todo # some checks
node tooling/checks/secrets.mjs --staged   # one check on its own
```

Findings are grouped by directory so each owner sees their own. Each check lives in [tooling/checks/](../tooling/checks/):

| Check | Rule | Scope and exceptions |
|---|---|---|
| `no-dashes` | no U+2013 or U+2014 | every tracked text file, except recorded third-party data under a `test/fixtures/` or `tests/fixtures/` directory (byte-exact recordings; their README files are still checked) |
| `no-todo` | no `TODO`, `FIXME` or `XXX` markers | markers after a comment opener or followed by `:` or `(`; prose like "no TODOs" passes. Skips fixtures, `docs/prompts/`, `AGENTS.md` and the check itself |
| `secrets` | no key shapes: `sk-`, `sk-ant-`, `gsk_`, `AIza`, `ghp_` and other GitHub tokens, `github_pat_`, `hf_`, AWS access key ids, private key headers | every tracked file. Documented samples go in [secrets-allowlist.txt](../tooling/checks/secrets-allowlist.txt) as `<path> <exact value>   # why` |
| `edge-safe` | no `node:` or bare Node built-in imports | `packages/core/src` and every provider declaring the `workers` or `browser` runtime. A file that `exports` maps only to a Node condition next to a `browser` or `workers` condition is the Node build and is exempt |
| `no-process-env` | no `process.env`, no global `fetch` | `providers/*/src` and `packages/core/src`. Entry points (files that call `createContext(...)`) may read `process.env` to build `ctx.env`; `createContext` itself binds the real fetch. Call `ctx.fetch(...)` directly, since a destructured `fetch` looks like the global |
| `no-console-log` | no `console.log`, `console.info` or `console.debug` | `packages/*/src` and `providers/*/src`. Use `ctx.log`, or `console.error` in entry points |

The code checks ignore comments and strings. The tests in [tooling/test/](../tooling/test/) feed each check the synthetic samples in [tooling/test/fixtures/](../tooling/test/fixtures/) and real repository files.

## Git hooks

[tooling/hooks/](../tooling/hooks/) has `pre-commit` (hygiene on staged files) and `pre-push` (`npm run ci`). Enable them in a clone with:

```sh
npm run hooks:install                          # git config core.hooksPath tooling/hooks
node tooling/hooks/install.mjs --uninstall     # back to .git/hooks
```

They are not enabled in the shared checkout during the parallel build wave: 50 agents commit there, and a hook would block each of them on the others' unfinished work. The owner enables them after the wave. Skip a hook once with `--no-verify`.

## Cloud Build

[tooling/cloudbuild/ci.yaml](../tooling/cloudbuild/ci.yaml) runs `npm ci` and `npm run ci -- --keep-going` on `node:24`. [tooling/cloudbuild/release.yaml](../tooling/cloudbuild/release.yaml) runs CI and publishes on a version tag (see [releasing.md](releasing.md)).

Cloud Build has no built-in cache. `ci.yaml` keeps the npm download cache as a tarball in a GCS bucket named by the `_CACHE_BUCKET` substitution; leave it empty to build without one. GitHub triggers may deliver the source without `.git`, so the first step indexes the snapshot for `git ls-files`.

### One-time setup

Connect the repository to Cloud Build first (Console, Cloud Build, Repositories, or `gcloud builds connections create github`). Then, with `PROJECT` set to your project id:

```sh
gcloud config set project "$PROJECT"
gcloud services enable cloudbuild.googleapis.com secretmanager.googleapis.com

# Optional cache bucket for ci.yaml, and a bucket for release SBOMs.
gcloud storage buckets create "gs://$PROJECT-vid2context-ci" --location=us-central1

# CI on every push to main and on pull requests.
gcloud builds triggers create github --name=vid2context-ci \
  --repo-owner=nirholas --repo-name=vid2context \
  --branch-pattern='^main$' --build-config=tooling/cloudbuild/ci.yaml \
  --substitutions=_CACHE_BUCKET="$PROJECT-vid2context-ci"
gcloud builds triggers create github --name=vid2context-pr \
  --repo-owner=nirholas --repo-name=vid2context \
  --pull-request-pattern='^main$' --build-config=tooling/cloudbuild/ci.yaml \
  --substitutions=_CACHE_BUCKET="$PROJECT-vid2context-ci"

# Release on version tags.
gcloud builds triggers create github --name=vid2context-release \
  --repo-owner=nirholas --repo-name=vid2context \
  --tag-pattern='^v[0-9]+\.[0-9]+\.[0-9]+$' --build-config=tooling/cloudbuild/release.yaml \
  --substitutions=_ARTIFACT_BUCKET="$PROJECT-vid2context-ci"
```

### Secret and permissions

Store an npm automation token (a granular token limited to the `vid2context` and `vid2context-mcp` packages) in Secret Manager as `npm-token`:

```sh
printf '%s' "$NPM_TOKEN" | gcloud secrets create npm-token --data-file=-
```

The service account the triggers run as (by default `PROJECT_NUMBER@cloudbuild.gserviceaccount.com`, or the one passed with `--service-account`) needs:

- `roles/secretmanager.secretAccessor` on the `npm-token` secret (release only):
  `gcloud secrets add-iam-policy-binding npm-token --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor`
- `roles/storage.objectAdmin` on the cache and artifact bucket:
  `gcloud storage buckets add-iam-policy-binding "gs://$PROJECT-vid2context-ci" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin`
- `roles/logging.logWriter`, since both configs log to Cloud Logging only.

Run a build by hand with `gcloud builds submit --config tooling/cloudbuild/ci.yaml .`.
