# Configuration

Every vid2context behaviour is controlled by env vars ([providers.md](providers.md) lists them all). A config file lets you commit a reproducible setup on top of that: named profiles such as "free first", "nothing leaves this machine" or "best quality", per-stage policy (local speech-to-text with hosted LLMs), model overrides and limits, without touching code.

The design in one sentence: **a config profile compiles to env vars**. Providers keep reading `ctx.env` and need no changes, and anything a profile can do, an env var can also do (and override).

The package is [`@vid2context/config`](../packages/config/README.md): a runtime-neutral core (parse, validate, resolve, compile, explain) and a Node loader at `@vid2context/config/node` (find the file, load `.env`, merge).

## Where the file lives

The Node loader checks these paths in order and uses the first one that exists:

| Order | Path |
|---|---|
| 1 | `VID2CONTEXT_CONFIG` (a path, relative to the working directory). If it names a missing file, that is an error, not a silent fallback. |
| 2 | `./vid2context.config.json` |
| 3 | `./vid2context.config.jsonc` |
| 4 | `$XDG_CONFIG_HOME/vid2context/config.json` (default `~/.config/vid2context/config.json`) |

No config file is not an error: the environment is used unchanged.

The profile is chosen by, in order: an explicit argument (`--profile` on `vid2context config`, `profile` in `loadConfiguredEnv`), then `VID2CONTEXT_PROFILE`, then the file's `defaultProfile`, then `default`.

`VID2CONTEXT_CONFIG`, `VID2CONTEXT_PROFILE` and `VID2CONTEXT_ENV_FILE` are read before the file loads, so they belong in the shell or `.env`, never in a profile (the validator refuses them).

## File format

The file is JSON with comments (JSONC): `//` and `/* */` comments and trailing commas are allowed in both `.json` and `.jsonc` files. Comment markers inside strings are left alone. A parse error names the file, line and column.

The starting point is the committed example, [`packages/config/examples/vid2context.config.jsonc`](../packages/config/examples/vid2context.config.jsonc). Copy it to `./vid2context.config.jsonc` or `~/.config/vid2context/config.json`:

```jsonc
// vid2context config: copy to ./vid2context.config.jsonc or ~/.config/vid2context/config.json.
// Pick a profile with VID2CONTEXT_PROFILE=<name> (or --profile once the CLI supports it).
// Keys never go here: they stay in .env. Reference: docs/configuration.md
{
  "$schema": "../schema/config.schema.json",
  "version": 1,
  "defaultProfile": "default",
  "profiles": {
    // Free first: local rungs, then free tiers with your keys, then keyless hosts.
    // Paid rungs stay last and only run when their key is set.
    "default": {
      "description": "Free first: local, then free tiers with your keys, then keyless hosts, paid only as a keyed backstop.",
      "policy": "free",
      "keyless": true,
      "allowPaid": true
    },

    // Nothing leaves this machine: only local rungs (Ollama, LM Studio, a local
    // Whisper server). Keyless and paid hosts are switched off as well.
    "private": {
      "description": "Local only: nothing leaves this machine.",
      "policy": "local-only",
      "keyless": false,
      "allowPaid": false
    },

    // Best model first, tier as tie-breaker. Paid rungs with a key can win.
    "quality": {
      "description": "Best model first; paid rungs allowed when their key is set.",
      "policy": "quality",
      "keyless": true,
      "allowPaid": true
    },

    // Per-stage policy: audio stays on this machine, chat uses free hosted tiers.
    "hybrid": {
      "description": "Local speech-to-text, free hosted LLMs.",
      "extends": "private",
      "policy": { "default": "free", "stt": "local-only" },
      "prefer": { "llm": ["groq", "cerebras"] }
    }
  }
}
```

To start from one profile only, copy one of the single-profile files instead: [`default.config.jsonc`](../packages/config/examples/default.config.jsonc) (free first), [`private.config.jsonc`](../packages/config/examples/private.config.jsonc) (nothing leaves the machine) or [`quality.config.jsonc`](../packages/config/examples/quality.config.jsonc) (best model first, paid backstops). Each holds exactly the matching profile from the combined file above and sets it as `defaultProfile`; a test keeps them identical.

When you copy the file elsewhere, point `$schema` at `node_modules/@vid2context/config/schema/config.schema.json` or the absolute path of [`packages/config/schema/config.schema.json`](../packages/config/schema/config.schema.json), so editors (VS Code, JetBrains, Zed) offer autocomplete and inline errors. The schema is generated from the same definitions the validator uses (`npm run gen:schema -w @vid2context/config`), and a test fails when the committed file is stale.

## Schema reference (version 1)

Top level:

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | Required. Config format version. |
| `profiles` | object | Required. Profile name (letters, digits, `_ . -`) to profile. |
| `defaultProfile` | string | Profile used when none is chosen. Default `default`. Must name an existing profile. |
| `$schema` | string | Path or URL of the JSON Schema, for editors. Ignored otherwise. |

A profile:

| Field | Type | Compiles to | Meaning |
|---|---|---|---|
| `description` | string | | Shown by `explain`. |
| `extends` | string | | Another profile to start from. Cycles are refused. |
| `policy` | policy or per-stage | `VID2CONTEXT_POLICY` (default only) | `free`: local, free tiers, keyless, then paid. `local-only`: nothing leaves the machine. `quality`: best model first. |
| `allowPaid` | boolean | `VID2CONTEXT_ALLOW_PAID` (`1`/`0`) | Allow paid rungs. They still run only when their key is set, and only after every free rung. |
| `keyless` | boolean | `VID2CONTEXT_KEYLESS` (`1`/`0`) | Allow keyless hosted rungs (no account, but data goes to a third party). |
| `prefer` | list or per-stage | (chain option) | Rungs, services or providers to move to the front. A reordering hint only. |
| `skip` | list or per-stage | `VID2CONTEXT_SKIP` (default only, comma-joined) | Rungs, services or providers to drop. |
| `only` | list or per-stage | (chain option) | Restrict to these rungs, services or providers. |
| `models` | object | `<PROVIDER>_MODEL` and friends | Model overrides, see below. |
| `storage` | string | `VID2CONTEXT_STORAGE` | Storage backend id: `memory`, `sqlite`, `postgres`, `cloudflare`. |
| `defaults.format` | string | `VID2CONTEXT_FORMAT` | Default output format id. |
| `defaults.timestamps` | boolean | `VID2CONTEXT_TIMESTAMPS` | Timestamps in text output. |
| `defaults.mode` | `auto`, `captions`, `stt`, `video` | `VID2CONTEXT_MODE` | Transcript mode. |
| `defaults.language` | BCP-47 tag | `VID2CONTEXT_LANG` | Preferred transcript language. |
| `defaults.comments` | boolean or integer | `VID2CONTEXT_COMMENTS` | Fetch comments, or a maximum count. |
| `limits.maxPlaylistItems` | integer | `VID2CONTEXT_MAX_PLAYLIST_ITEMS` | Most videos taken from one playlist, channel or feed. |
| `limits.maxUploadMb` | integer | `VID2CONTEXT_MAX_UPLOAD_MB` | Largest upload accepted. |
| `limits.maxAudioMb` | integer | `VID2CONTEXT_MAX_AUDIO_MB` | Largest audio download. |
| `env` | object | the same names | Extra non-secret env values (names in `UPPER_SNAKE_CASE`). |

What reads the emitted variables today: the chain (`VID2CONTEXT_POLICY`, `VID2CONTEXT_ALLOW_PAID`, `VID2CONTEXT_KEYLESS`, `VID2CONTEXT_SKIP`), the storage providers (`VID2CONTEXT_STORAGE`) and the size limits in `packages/core/src/security/limits.ts` and the server (`VID2CONTEXT_MAX_*`). The `defaults.*` variables are emitted for surfaces and scripts that load a profile; no built-in surface reads them today.

Unknown fields are refused with their JSON path, so a typo never silently does nothing.

### Per-stage values

`policy`, `prefer`, `skip` and `only` take either one value for every stage, or an object with `default` and per-stage overrides. The stages are `stt`, `llm`, `embed`, `video` and `visual`:

```jsonc
"policy": { "default": "free", "stt": "local-only" },
"skip":   { "default": ["pollinations"], "llm": ["ovh"] },
"only":   { "embed": ["ollama"] }
```

Only the `default` value can become an env var (env controls are global). Per-stage values reach the chain through `chainOptionsFor(stage, profile)`: a stage value beats the default, `only` and `prefer` replace per stage, and a stage `skip` list adds to the default list. Entries match a rung id (`llm/groq/openai/gpt-oss-120b`), a service (`groq`) or a provider (`llm-openai-compatible`).

`prefer` never adds or removes a rung and never overrides `policy`, `only` or `skip`: surfaces call `applyPrefer(rankedRungs, prefer)` after `rankRungs`, which moves the named rungs to the front in the order listed.

### Model overrides

`models` maps a provider key to a model id, a comma-separated list, a list of ids in order of preference, or `"env:NAME"`. The provider alone sets its chat (LLM) models; `<provider>:<kind>` sets another kind:

| Key | Env var |
|---|---|
| `groq`, `cerebras`, `mistral`, `github`, `gemini`, `openrouter`, `ovh`, `pollinations`, `openai`, `anthropic`, `ollama`, `lmstudio`, `webllm` | `<PROVIDER>_MODEL` |
| `local` | `LOCAL_LLM_MODEL` |
| `groq:stt`, `gemini:stt`, `ovh:stt`, `openai:stt`, `deepgram:stt`, `assemblyai:stt`, `cloudflare:stt`, `local:stt`, `transformers:stt` | `<PROVIDER>_STT_MODEL` |
| `ollama:embed`, `lmstudio:embed`, `local:embed`, `transformers:embed`, `gemini:embed`, `cloudflare:embed`, `openai:embed` | `<PROVIDER>_EMBED_MODEL` |
| `gemini:video` | `GEMINI_VIDEO_MODEL` |
| `ollama:visual`, `gemini:visual` | `<PROVIDER>_VISION_MODEL` |

An unknown key is refused, and the error hint lists every known key. Model variables (`GROQ_MODEL` and so on) may not be set through `env`: use `models`, so each setting has one place in a profile.

### Secrets never live in config

A config file is meant to be committed, so it refuses anything that looks like a key:

- any string value starting with a known key prefix (`sk-`, `sk-ant-`, `gsk_`, `AIza`, `ghp_`, `github_pat_`, `hf_`);
- any literal value under `env` for a variable whose name ends in `_KEY`, `_KEYS`, `_TOKEN`, `_SECRET`, `_PASSWORD` (and plural forms).

Reference a secret by name instead. `"env:WORK_GROQ_KEY"` copies the value of `WORK_GROQ_KEY` from the real environment (shell or `.env`) at load time; an unset reference emits nothing and `explain` lists it as `(not set)`:

```jsonc
"env": { "GROQ_API_KEY": "env:WORK_GROQ_KEY" },
"models": { "cerebras": "env:WORK_CEREBRAS_MODEL" }
```

The structured env controls (`VID2CONTEXT_POLICY`, `VID2CONTEXT_STORAGE`, `VID2CONTEXT_MAX_UPLOAD_MB`, ...) may not be set through `env` either; the validator names the profile field to use instead.

## Profiles and `extends`

A profile can start from another with `extends`. Settings are deep-merged leaf by leaf: the child wins for every leaf it sets, everything else comes from the parent. Chains can be any depth; a cycle is refused with the loop spelled out (`extends cycle: a -> b -> a`).

In the example, `hybrid` extends `private`: it keeps `keyless: false` and `allowPaid: false` from `private`, sets the default policy back to `free` and keeps speech-to-text local. A longer chain from the test fixtures ([`packages/config/test/fixtures/extends.jsonc`](../packages/config/test/fixtures/extends.jsonc)):

```jsonc
"base": {
  "policy": "free",
  "keyless": false,
  "skip": ["pollinations"],
  "models": { "groq": ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"], "ollama": "qwen3:8b" },
  "defaults": { "format": "markdown", "timestamps": true },
  "limits": { "maxPlaylistItems": 50 },
  "env": { "OLLAMA_BASE_URL": "http://localhost:11434/v1" }
},
"work": {
  "extends": "base",
  "policy": { "stt": "local-only", "llm": "quality" },
  "allowPaid": false,
  "skip": { "llm": ["ovh"] },
  "only": { "embed": ["ollama"] },
  "prefer": ["cerebras", "groq"],
  "models": { "groq:stt": "whisper-large-v3", "cerebras": "env:WORK_CEREBRAS_MODEL" },
  "storage": "sqlite",
  "defaults": { "mode": "captions", "language": "en", "comments": 20 },
  "limits": { "maxAudioMb": 300 },
  "env": { "GROQ_API_KEY": "env:WORK_GROQ_KEY" }
}
```

## How config and env interact

Precedence, highest first:

1. **The real environment**: shell variables, then `.env` files (loaded by `loadEnvFiles()` from `@vid2context/registry/node`, where the shell already wins over `.env`).
2. **The config profile** (after `extends`).
3. **Built-in defaults** (policy `free`, paid and keyless allowed, and so on).

`mergeEnv(base, overlay)` implements this: a variable already set in the real environment (not undefined and not empty) is kept, and the profile fills in only what is unset. So `VID2CONTEXT_POLICY=quality vid2context ...` beats any profile, and a profile beats the defaults. `.env` is loaded before compiling, so `env:` references can point at keys kept there.

The same rule holds for per-stage chain options: when the real environment sets `VID2CONTEXT_POLICY`, `VID2CONTEXT_ALLOW_PAID` or `VID2CONTEXT_SKIP`, `chainOptionsFor` leaves out the profile default for that control. A stage-specific profile value (`policy.stt`) is more specific than a global env control and is always applied.

What each example profile compiles to (from `toEnv`, with an empty environment):

| Profile | Env overlay |
|---|---|
| `default` | `VID2CONTEXT_POLICY=free`, `VID2CONTEXT_ALLOW_PAID=1`, `VID2CONTEXT_KEYLESS=1` |
| `private` | `VID2CONTEXT_POLICY=local-only`, `VID2CONTEXT_ALLOW_PAID=0`, `VID2CONTEXT_KEYLESS=0` |
| `quality` | `VID2CONTEXT_POLICY=quality`, `VID2CONTEXT_ALLOW_PAID=1`, `VID2CONTEXT_KEYLESS=1` |
| `hybrid` | `VID2CONTEXT_POLICY=free`, `VID2CONTEXT_ALLOW_PAID=0`, `VID2CONTEXT_KEYLESS=0`, plus chain options `stt: { policy: local-only }` and `llm: { policy: free, prefer: [groq, cerebras] }` |

Under `private`, `rankRungs(registry.llmRungs(env), {}, env)` contains only local rungs (a test asserts this against the real registry).

## Seeing the effective settings: `vid2context config` and `explain()`

`vid2context config [--profile name] [--json]` prints every effective setting, its value and where it came from, with secret values masked, then the storage backend in use. `--json` returns the same as data. For the example file with `--profile hybrid`, `GROQ_MODEL` exported in the shell and `VID2CONTEXT_KEYLESS=1` in `.env`:

```text
Profile: hybrid (extends private)
  Local speech-to-text, free hosted LLMs.
Config: ./vid2context.config.jsonc
Precedence: environment, then config profile, then built-in default.

Setting                         Value                    Source
VID2CONTEXT_POLICY              free                     profile hybrid
VID2CONTEXT_ALLOW_PAID          0                        extends private
VID2CONTEXT_KEYLESS             1                        env VID2CONTEXT_KEYLESS (overrides extends private)
VID2CONTEXT_SKIP                (none)                   default
VID2CONTEXT_STORAGE             (first enabled backend)  default
VID2CONTEXT_FORMAT              (surface default)        default
VID2CONTEXT_TIMESTAMPS          (surface default)        default
VID2CONTEXT_MODE                (surface default)        default
VID2CONTEXT_LANG                (spoken language)        default
VID2CONTEXT_COMMENTS            (surface default)        default
VID2CONTEXT_MAX_PLAYLIST_ITEMS  (built-in limit)         default
VID2CONTEXT_MAX_UPLOAD_MB       (built-in limit)         default
VID2CONTEXT_MAX_AUDIO_MB        (built-in limit)         default
policy (stt)                    local-only               profile hybrid
prefer (llm)                    groq, cerebras           profile hybrid
GROQ_MODEL                      llama-3.3-70b-versatile  env GROQ_MODEL
```

Sources read as: `profile X` (set by the selected profile), `extends X` (inherited), `env NAME` (the real environment; `overrides ...` when it beat the profile), `via env NAME` (an `env:` reference) and `default`. The same text comes from `explain(config, profile, env)` in code, and the rows from `trace()`.

The `config` command explains a profile. The other CLI commands, the MCP server and the HTTP server read the environment directly and do not load the config file themselves: to run with a profile, use `loadConfiguredEnv()` in your own entry point (below), or export the variables `explain` lists.

## Using it from code

```ts
import { loadConfiguredEnv } from '@vid2context/config/node';
import { createNodeContext } from '@vid2context/registry/node';

const cfg = await loadConfiguredEnv({ profile: 'private' });
const ctx = createNodeContext({ env: cfg.env });
const sttOptions = cfg.chainOptionsFor('stt'); // per-stage policy, only, skip, prefer
console.error(cfg.explain); // stderr: stdout is for program output
```

`loadConfiguredEnv(opts)` loads `.env` (unless you pass `env`, in which case you own the environment), finds the file, compiles the selected profile and returns `{ env, profile, configPath, searched, envFiles, resolved, chainOptionsFor, explain }`. Asking for a profile when no file exists is an error with the searched paths in the hint.

The neutral core has no `node:` imports and works in Workers and browsers:

| Function | What it does |
|---|---|
| `parseConfig(text, { source })` | JSONC parse and validate. Throws `Vid2ContextError('bad-request')` listing every problem with its JSON path. |
| `validateConfig(value)` | Validate an already parsed value. |
| `resolveProfile(config, name)` | Apply `extends`; returns the flat profile plus which profile set each leaf. |
| `toEnv(config, name, env)` | The env overlay. Pass the real env so `env:` references resolve. |
| `mergeEnv(base, overlay)` | Real env wins over the overlay. |
| `chainOptionsFor(stage, resolved, realEnv)` | Per-stage `ChainOptions` plus `prefer`. |
| `applyPrefer(ranked, prefer)` | Move preferred rungs to the front of a ranked list. |
| `explain(config, name, env)` / `trace(...)` | The readable trace, or its rows. |
| `configJsonSchema()` | The JSON Schema as an object. |

## Errors

Every problem in a file is reported at once, each with its JSON path:

```text
vid2context.config.json: invalid vid2context config (1 problem):
  profiles.work.policy.stt: expected one of free, local-only, quality, got "cheap"
```

The hint points back to this page; for a secret it adds that keys belong in `.env`, and for an unknown `models` key it lists the known ones.
