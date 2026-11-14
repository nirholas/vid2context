# 05. Config files, profiles and provider policy

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/config/` (new package `@vid2context/config`: a runtime-neutral core plus a `./node` subpath export for file loading) |
| Shared edits allowed | None |
| Commit scope | `config` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Today every behaviour is controlled by env vars (`VID2CONTEXT_POLICY`, `VID2CONTEXT_SKIP`, `<PROVIDER>_MODEL` and so on). Teams and careful users need reproducible setups they can commit and switch between: a private local-only profile, a free-first default, a quality profile with paid backstops, per-stage policy (local speech-to-text but hosted LLMs), all without touching code. The roadmap placed config in `packages/core/src/config`, but reading files and `.env` needs Node APIs and `packages/core` must stay runtime-neutral, so it lives in its own package with a neutral core and a Node-only subpath. The key design choice: a config compiles down to env vars, so providers keep reading `ctx.env` and need no changes at all.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (rung chain and env controls).
2. `packages/core/src/types.ts` (`Env`, `Policy`, `Tier`), `packages/core/src/provider.ts` (`ChainOptions`), `packages/core/src/chain.ts` (`resolveChainOptions`, env controls), `packages/core/src/keys.ts`.
3. `packages/registry/src/node.ts` (`loadEnvFiles()`: `.env` loading already exists; build on it, do not re-implement it).
4. `docs/providers.md` and `.env.example` (every env var, the naming rules).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 8 and 9 (naming conventions).

## Goal

`@vid2context/config` parses, validates and explains a versioned config file with profiles, and compiles the chosen profile into an `Env` overlay and per-stage `ChainOptions`. `@vid2context/config/node` finds and loads the file, applies `.env` loading through `loadEnvFiles()`, and returns the merged env, so a surface can do `createNodeContext({ env: await loadConfiguredEnv() })`.

## Requirements

### Schema (version 1)

- Top level: `{ version: 1, defaultProfile?: string, profiles: Record<string, Profile> }`.
- `Profile`:
  - `extends?: string` (another profile; detect cycles).
  - `policy?: Policy | { default?: Policy, stt?: Policy, llm?: Policy, embed?: Policy, video?: Policy, visual?: Policy }`.
  - `allowPaid?: boolean`, `keyless?: boolean`.
  - `prefer?: string[]` (rung ids, services or providers to move to the front), `skip?: string[]`, `only?: string[]` (global or per stage, same shape as `policy`).
  - `models?: Record<string, string | string[]>`: maps a provider to model overrides, compiled to the existing env names (`GROQ_MODEL`, `GROQ_STT_MODEL`, `OLLAMA_EMBED_MODEL`, ...). Read `docs/providers.md` and refuse unknown provider keys with a hint listing the known ones.
  - `storage?: string` (backend id), `defaults?: { format?, timestamps?, mode?, language?, comments? }`, `limits?: { maxPlaylistItems?, maxUploadMb?, maxAudioMb? }`.
  - `env?: Record<string, string>`: extra non-secret env values.
- Secrets never live in config. Values may reference env by name only (`"env:GROQ_API_KEY"`). Refuse literal values that look like keys (prefixes `sk-`, `gsk_`, `AIza`, `sk-ant-`, `ghp_`, `github_pat_`, `hf_`, or any value for a variable named `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) with an error naming the field and telling the user to put it in `.env`.

### Neutral core (`src/index.ts`, no `node:` imports)

- `parseConfig(text, { source })`: JSON with comments and trailing commas (JSONC; write a small tolerant parser or strip comments safely, no heavy dependency).
- `validateConfig(value)`: a small hand-written validator returning precise errors with JSON paths (`profiles.work.policy.stt: expected one of free, local-only, quality`). Throw `Vid2ContextError('bad-request')` with all errors in the message and a hint pointing to `docs/configuration.md`.
- `resolveProfile(config, name)`: applies `extends`, deep-merges, returns a flat resolved profile.
- `toEnv(config, profileName)`: produces the env overlay (`VID2CONTEXT_POLICY`, `VID2CONTEXT_ALLOW_PAID`, `VID2CONTEXT_KEYLESS`, `VID2CONTEXT_SKIP`, model overrides, storage choice, limits as `VID2CONTEXT_*` vars, `env` extras). Document every emitted variable.
- `mergeEnv(base, overlay)`: real environment wins over config (`base` values that are set are kept), and this precedence is documented and tested.
- `chainOptionsFor(stage, resolvedProfile)`: per-stage `ChainOptions` (`policy`, `allowPaid`, `only`, `skip`, ordering from `prefer`). Implement `prefer` as an `only`-free reordering hint: return the list and a small `applyPrefer(rankedRungs, prefer)` helper surfaces can call after `rankRungs`.
- `explain(config, profileName, env)`: a human-readable trace of every effective setting and where it came from (`profile work`, `extends base`, `env GROQ_MODEL`, `default`), with secret values masked. The CLI (prompt 43) will print this for `vid2context config`.
- A JSON Schema for editors at `packages/config/schema/config.schema.json`, generated by a script in the package from the same definitions the validator uses, and a test that the committed file is up to date.

### Node loader (`src/node.ts`, exported as `@vid2context/config/node`)

- Search order: `VID2CONTEXT_CONFIG` (path), `./vid2context.config.json`, `./vid2context.config.jsonc`, `$XDG_CONFIG_HOME/vid2context/config.json` (default `~/.config/vid2context/config.json`). The first found wins; report which one.
- Profile selection: explicit argument, then `VID2CONTEXT_PROFILE`, then `defaultProfile`, then `default`.
- `.env` loading through `loadEnvFiles()` from `@vid2context/registry/node` (shell variables win), done before compiling so `env:` references resolve.
- `loadConfiguredEnv(opts?)` returns `{ env, profile, configPath, explain }`.
- No config file is not an error: return the process env unchanged.

## Prefer free and local

The built-in example profiles must show the free-first philosophy: `default` (policy free, keyless on, paid allowed only when keys exist), `private` (policy local-only, keyless off: nothing leaves the machine), `quality` (policy quality, paid allowed). Ship them as real example files in `packages/config/examples/`.

## Out of scope

- CLI commands (`vid2context config`, `--profile`): prompt 43 wires them.
- Secret storage or encryption: secrets stay in `.env` or the platform's secret store.
- Changing `chain.ts` or providers: the env overlay is the whole integration.

## Tests

Put tests in `packages/config/test/` (the root vitest config picks up `packages/*/test/**/*.test.ts`).

- Real config files committed as fixtures in `packages/config/test/fixtures/`: the three examples, a profile with `extends`, a cycle, a file with comments and trailing commas, a file with a literal key (must fail), a file with an unknown provider in `models`.
- `toEnv` output for each example, asserted exactly.
- Precedence: real env value beats config; config beats default.
- `chainOptionsFor` per stage plus `applyPrefer` against real rungs from the generated node registry (`createRegistry()` from `@vid2context/registry/node`, with a test env).
- Node loader: temp directories with real files, `VID2CONTEXT_CONFIG`, XDG path, and no-file behaviour.
- End to end: a `private` profile produces an env under which `rankRungs(registry.llmRungs(env), {}, env)` contains only local rungs.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/config'` prints nothing.
- [ ] `npx vitest run packages/config` passes.
- [ ] `npx biome check packages/config` is clean.
- [ ] The neutral entry imports no `node:` module (a test scans `src/index.ts` and its imports).
- [ ] `explain` on the `default` example prints a readable trace with no secret values; paste it in your report.

## Docs

- Create `docs/configuration.md`: file locations, schema reference, profiles and `extends`, per-stage policy, how config compiles to env and why, precedence, the three examples in full, and editor autocomplete via the JSON Schema.
- Create `packages/config/README.md` (short, links to the doc).

## If credentials, tools or network are missing

Nothing here needs a key or the network. Tests use committed config files and the real generated registry.

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
