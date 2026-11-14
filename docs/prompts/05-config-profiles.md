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

<!-- COMMON -->
