# 38. Local CI, Cloud Build and release engineering

| | |
|---|---|
| Track | I. Deploy and quality |
| You own | `tooling/`, `.changeset/` (if you choose Changesets) |
| Shared edits allowed | root `package.json`: `scripts` entries and your devDependencies only |
| Commit scope | `tooling` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Enterprise users judge a project by whether every commit is checked and every release is reproducible. GitHub Actions billing on the owner's account has been locked since 2026-09-15, so `.github/workflows/ci.yml` (typecheck, lint, tests on Node 22 and 24) exists but cannot run. CI therefore has to run locally with one command, optionally on Google Cloud Build, and releases (the `npx vid2context` CLI and the `npx vid2context-mcp` server) have to be built, versioned and published by scripts. This prompt builds that tooling, plus repo hygiene checks that enforce the house rules (no em-dashes, no TODOs, no secrets, no Node built-ins in edge code).

## Read first

1. `CLAUDE.md` and `AGENTS.md` (house style, commands, the note on GitHub Actions), then `docs/ARCHITECTURE.md`.
2. Root `package.json` (scripts, workspaces, devDependencies), `tsconfig.json`, `biome.json`, `vitest.config.ts`, `scripts/gen-registry.mjs`, `.github/workflows/ci.yml`, `CHANGELOG.md`, `CONTRIBUTING.md`.
3. `packages/cli/package.json` and `src/bin.ts`, `packages/mcp/package.json` and `src/bin.ts` (the entry points you bundle; do not edit them).
4. `docs/prompts/SHARED-CONTRACTS.md`, section 8 (shared files) and 9.

## Goal

`npm run ci` runs every check the repo has, fast and deterministically, and prints a summary. Hygiene checks live in `tooling/checks/`. Cloud Build configs run the same CI and a release pipeline. Release scripts produce bundled, publishable CLI and MCP packages under `dist/npm/` with an SBOM, a changelog entry and a dry-run publish, without editing other packages' manifests.

## Requirements

### `npm run ci`

- Steps in order, each timed: `npm run gen`, `tsc` typecheck, Biome lint, Vitest unit tests, `npm run --if-present conformance` (prompt 23 adds it), hygiene checks, the release build (`npm run build:npm`), and `npm run --if-present eval -- --check` only when `LIVE=1` (prompt 33).
- One runner script (`tooling/ci/run.mjs`, Node, no dependencies) that stops at the first failure by default, `--keep-going` to run all, exit code nonzero on any failure, and a final table (step, status, seconds).
- Root scripts: `ci`, `hygiene`, `build:npm`, `release:dry`, `hooks:install`. Add only these; do not change existing scripts.

### Hygiene checks (`tooling/checks/`, Node scripts, no dependencies)

- `no-dashes`: no U+2013 or U+2014 in tracked text files (use `git ls-files`), reporting file and line. Exclude only third-party fixtures that must be byte-exact, listed explicitly in the check.
- `no-todo`: no to-do markers (the words `TODO`, `FIXME`, `XXX` as code comments or standalone markers) in source and docs outside fixtures. Exclude `docs/prompts/`, `AGENTS.md` and the check's own source, which mention these words as rules, and match markers rather than every occurrence of the word.
- `secrets`: common key shapes (`sk-`, `sk-ant-`, `gsk_`, `AIza`, `ghp_`, `github_pat_`, `hf_`, AWS access key ids, private key headers) in tracked files, with an allowlist file for documented format samples.
- `edge-safe`: for every provider whose package.json declares `workers` or `browser` runtimes, and for `packages/core/src`, no `node:` imports or bare Node built-in imports in `src/`.
- `no-process-env`: no `process.env` and no bare global `fetch(` calls in `providers/*/src` and `packages/core/src`.
- `no-console-log`: no `console.log` in library code (entry points and scripts may use `console.error`).
- `--staged` mode for each check (only files in `git diff --cached --name-only`) for the pre-commit hook.

### Git hooks (`tooling/hooks/`)

- `pre-commit`: hygiene on staged files only. `pre-push`: `npm run ci`.
- `npm run hooks:install` sets `git config core.hooksPath tooling/hooks`. Do NOT run it in this checkout during the wave: 50 agents commit here and a hook would block them on each other's unfinished work. Document that the owner enables hooks after the wave.

### Cloud Build (`tooling/cloudbuild/`)

- `ci.yaml`: Node 24 image, `npm ci`, `npm run ci`, caching of the npm cache directory between builds where Cloud Build allows it.
- `release.yaml`: CI, then `npm run build:npm`, SBOM, and `npm publish` of the bundles using an npm token from Secret Manager (`availableSecrets`), gated on a tag.
- `docs/ci.md` explains creating the triggers with `gcloud builds triggers create github` (repository `nirholas/vid2context`), the service account permissions and the secret. Validate both YAML files parse; run `ci.yaml` locally only if `cloud-build-local` or an equivalent is available, otherwise report it.

### Bundled releases

- tsup (root devDependency) configs in `tooling/build/` bundling `packages/cli/src/bin.ts` and `packages/mcp/src/bin.ts` (and their workspace imports, including the generated node registry) into single ESM files with a `#!/usr/bin/env node` banner, Node 22 target, external native and heavy optional dependencies.
- `npm run build:npm` assembles `dist/npm/vid2context/` and `dist/npm/vid2context-mcp/` with generated `package.json` files (name, version from the root, `bin`, `engines: { node: ">=22" }`, `files`, `license: Apache-2.0`, repository, runtime dependencies that cannot be bundled), `README.md` and `LICENSE`. Never edit `packages/cli/package.json` or `packages/mcp/package.json`.
- Verify: `node dist/npm/vid2context/bin.js --help` prints help; the MCP bundle starts and answers an `initialize` request over stdio (send a real JSON-RPC message from a test script and read the response).

### Versioning and release

- Changesets (root devDependency, `.changeset/config.json`) for version bumps and `CHANGELOG.md` entries, or a documented equivalent if Changesets does not fit source-exporting private workspaces; explain the choice in `docs/releasing.md`.
- `npm run release:dry`: build, `npm sbom --sbom-format cyclonedx` into `dist/npm/<name>/sbom.cdx.json`, and `npm publish --dry-run` for each bundle, printing the tarball contents.
- npm provenance needs a supported CI (GitHub Actions or GitLab); Cloud Build releases publish without provenance. Say so in `docs/releasing.md`.
- Do not publish anything and do not push tags during the wave.

### The dead workflow

- Leave `.github/workflows/ci.yml` in place (you do not own `.github/`). State in your report that it cannot run while Actions billing is locked and that `npm run ci` replaces it.

## Out of scope

- Container images and cloud deploys: prompts 49 and 50.
- The conformance suites and evals themselves: prompts 23 and 33 (you only call their scripts if present).
- Fixing violations your hygiene checks find in other agents' directories: report them, grouped by directory.

## Tests

- Unit tests for each hygiene check (in `tooling/test/`, run with `npx vitest run tooling` by adding nothing to the root Vitest config: use a local `tooling/vitest.config.ts`), using real repository files as inputs where they demonstrate a case, and small committed sample files under `tooling/test/fixtures/` for violations (these are inputs to a linter, so they are legitimately synthetic text; label them as such in the fixtures README).
- An end-to-end test that runs `node tooling/ci/run.mjs --only hygiene` on the real repo.
- The bundle smoke tests described above.

## Acceptance criteria

- [ ] `npm run ci` runs every step and prints the summary table; failures from other agents' unfinished work are reported, not fixed.
- [ ] `npm run hygiene` runs all checks; `--staged` works.
- [ ] `npm run build:npm` produces both bundles; `node dist/npm/vid2context/bin.js --help` works; the MCP bundle answers `initialize`.
- [ ] `npm run release:dry` prints the dry-run tarballs and writes the SBOMs.
- [ ] `npx biome check tooling` is clean; hooks are not installed in this checkout.

## Docs

- `docs/ci.md` (local CI, hygiene checks, hooks, Cloud Build triggers) and `docs/releasing.md` (versioning, building, publishing, provenance note).

## If credentials, tools or network are missing

No keys are needed except the npm token for a real publish, which you must not do. If `gcloud` is unavailable, validate the Cloud Build YAML syntax only and report it. If npm's registry is unreachable, the dry run may fail at the network step: report it.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.
