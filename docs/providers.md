# Providers and rungs

Every rung vid2context can use, the env var that enables it, its tier, and what the free tier allows. All keys are optional: with none set, vid2context uses YouTube captions plus the keyless speech-to-text and LLM lanes.

Tier order under the default `free` policy: **local** (this machine, private) then **free** (hosted free tier, your key) then **keyless** (hosted, no account) then **paid** (only when its key is set). See [ARCHITECTURE.md](ARCHITECTURE.md#the-rung-chain) for policies and cooldowns.

Check what is enabled right now: `GET /api/v1/health` (server) lists every provider and rung with `enabled` and the env vars it `requires`, never their values.

Limits below come from the providers' published free tiers or from live checks; the date says when. Free tiers change often; when a rung starts failing with `auth`, `rate-limited` or `not-found`, check the provider's console and override the model with env.

## Sources and captions

| Provider id | What | Enabled by | Notes |
|---|---|---|---|
| `youtube` | YouTube URLs and ids: metadata, description chapters | always | innertube ANDROID client, no key. `YOUTUBE_ANDROID_VERSION` overrides the client version if YouTube rejects the pinned one. Datacenter IPs may be blocked (`blocked` error); run locally or behind a tunnel. |
| `youtube-captions` | creator captions, auto-captions, YouTube translation (`tlang`) | always | translated tracks were rate-limited (HTTP 429) from a GCP VM on 2026-11-14 |
| `media-file` | local files and `file://` URLs (Node only) | always | metadata from the filesystem; audio bytes for speech-to-text |

## Speech-to-text (`stt-openai-compatible`)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `stt/local/<model>` | local | `LOCAL_STT_BASE_URL` + `LOCAL_STT_MODEL` (optional `LOCAL_STT_API_KEY`) | any OpenAI-compatible server: speaches, faster-whisper-server, LocalAI |
| `stt/groq/whisper-large-v3-turbo` | free | `GROQ_API_KEY` (+ `GROQ_FALLBACK_KEYS`) | 25 MB per file on the free tier; per-model limits at console.groq.com |
| `stt/ovh/whisper-large-v3-turbo` | keyless | none | about 2 requests per minute per IP (response headers, 2026-11-14). File needs a real audio extension. |
| `stt/openai/whisper-1` | paid | `OPENAI_API_KEY` (+ `OPENAI_FALLBACK_KEYS`, `OPENAI_BASE_URL`) | 25 MB per file |

Model overrides: `GROQ_STT_MODEL`, `OVH_STT_MODEL`, `OPENAI_STT_MODEL`. OVH also serves `whisper-large-v3`.

## LLMs (`llm-openai-compatible`)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `llm/ollama/<model>` | local | `OLLAMA_MODEL` (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`) | JSON mode |
| `llm/lmstudio/<model>` | local | `LMSTUDIO_MODEL` (`LMSTUDIO_BASE_URL`, default `http://localhost:1234/v1`) | JSON and JSON Schema |
| `llm/local/<model>` | local | `LOCAL_LLM_BASE_URL` + `LOCAL_LLM_MODEL` (optional `LOCAL_LLM_API_KEY`) | any OpenAI-compatible server (llama.cpp, vLLM, Jan) |
| `llm/groq/qwen/qwen3.8-27b` | free | `GROQ_API_KEY` | quota metered per model, so each model is its own rung |
| `llm/groq/openai/gpt-oss-120b` | free | `GROQ_API_KEY` | |
| `llm/cerebras/gpt-oss-120b` | free | `CEREBRAS_API_KEY` | JSON Schema |
| `llm/cerebras/llama-3.3-70b` | free | `CEREBRAS_API_KEY` | |
| `llm/mistral/mistral-small-latest` | free | `MISTRAL_API_KEY` | Experiment plan: large monthly token quota at about 1 request per second, in exchange for allowing training on your data |
| `llm/github/meta/Llama-3.3-70B-Instruct` | free | `GITHUB_TOKEN` | any GitHub account; small daily request caps and about 8k input tokens per request |
| `llm/gemini/gemini-2.5-flash-lite` | free | `GEMINI_API_KEY` | AI Studio free tier through the OpenAI-compatible endpoint; JSON Schema; 1M-token context |
| `llm/groq/openai/gpt-oss-20b` | free | `GROQ_API_KEY` | a capability step-down, tried after the other free rungs |
| `llm/ovh/Meta-Llama-3_3-70B-Instruct` | keyless | none | about 2 requests per minute per model per IP; JSON mode verified 2026-11-14 |
| `llm/ovh/gpt-oss-120b` | keyless | none | separate quota from the Llama rung; returns reasoning in a separate field |
| `llm/pollinations/openai-fast` | keyless | none | anonymous tier serving gpt-oss-20b; JSON mode verified 2026-11-14 |
| `llm/openai/gpt-5.4-nano` | paid | `OPENAI_API_KEY` | JSON Schema |

Every free and paid lane takes `<PROVIDER>_FALLBACK_KEYS` (one extra rung per key) and `<PROVIDER>_MODEL` (a comma-separated model list that replaces the defaults): `GROQ_MODEL`, `CEREBRAS_MODEL`, `MISTRAL_MODEL`, `GITHUB_MODEL`, `GEMINI_MODEL`, `OVH_MODEL`, `POLLINATIONS_MODEL`, `OPENAI_MODEL`.

## Chain controls

| Env var | Effect |
|---|---|
| `VID2CONTEXT_POLICY` | `free` (default), `local-only` (nothing leaves the machine) or `quality` |
| `VID2CONTEXT_ALLOW_PAID=0` | never use paid rungs, even with a key |
| `VID2CONTEXT_KEYLESS=0` | turn off keyless rungs (they send data to third parties without an account) |
| `VID2CONTEXT_SKIP=svc1,svc2` | drop rungs by id, service or provider, e.g. `pollinations,ovh` |
| `VID2CONTEXT_LOG_LEVEL` | `debug`, `info`, `warn` (default), `error`, `silent`; logs go to stderr |
| `VID2CONTEXT_ENV_FILE` | an env file to load before `./.env` (shell variables always win) |

## Exports

| Env var | Used by | Notes |
|---|---|---|
| `NOTION_TOKEN` | `@vid2context/exporters` (`export_notion`, `POST /exports/notion`) | secret of an internal integration (free) from https://www.notion.so/profile/integrations; share the parent page with it (page menu, Connections). Requests are paced to about 3 per second and use `Notion-Version: 2026-03-11` |
| `NOTION_PARENT_PAGE_ID` | `@vid2context/exporters` | id or link of the Notion page the video pages go under; a per-call `parentPageId` wins |

Obsidian exports need no variable: they are local files.

## Planned (see ROADMAP.md)

| Kind | Provider | Tier | Enabled by | Known limits |
|---|---|---|---|---|
| llm | Kilo Code gateway, Nemotron `:free` models | keyless | none (`KILO_API_KEY` optional) | about 200 requests per hour |
| llm | NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b` | free | `NVIDIA_API_KEY` | free, can queue under load |
| llm | SambaNova `Meta-Llama-3.3-70B-Instruct` | free | `SAMBANOVA_API_KEY` | about 20 requests per minute and 200k tokens per day per model |
| llm | Zhipu `glm-4.7-flash` | free | `ZHIPU_API_KEY` | permanently free Flash tier |
| llm | Cloudflare Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | free | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | 10,000 neurons per day |
| llm | OpenRouter, best live `:free` model | free | `OPENROUTER_API_KEY` | never pin a `:free` id |
| llm | Anthropic `claude-haiku-4-5-20251001`, native | paid | `ANTHROPIC_API_KEY` | |
| stt | whisper.cpp, Transformers.js, Workers AI Whisper, Gemini, Deepgram, AssemblyAI | local / free | per prompt | |
| embed | OVH `bge-m3` (keyless), Ollama, Transformers.js, Gemini, Cloudflare, paid | mixed | per prompt | |
| video | Gemini video understanding | free | `GEMINI_API_KEY` | |
