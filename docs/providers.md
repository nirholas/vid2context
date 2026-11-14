# Providers and rungs

Every rung vid2context can use, the env var that enables it, its tier, and what the free tier allows. All keys are optional: with none set, vid2context uses YouTube captions plus the keyless speech-to-text and LLM lanes.

Tier order under the default `free` policy: **local** (this machine, private) then **free** (hosted free tier, your key) then **keyless** (hosted, no account) then **paid** (only when its key is set). See [ARCHITECTURE.md](ARCHITECTURE.md#the-rung-chain) for policies and cooldowns.

Check what is enabled right now: `GET /api/v1/health` (server) lists every provider and rung with `enabled` and the env vars it `requires`, never their values.

Limits below come from the providers' published free tiers or from live checks; the date says when. Free tiers change often; when a rung starts failing with `auth`, `rate-limited` or `not-found`, check the provider's console and override the model with env.

## Sources and captions

| Provider id | What | Enabled by | Notes |
|---|---|---|---|
| `youtube` | YouTube URLs and ids: metadata, description chapters | always | innertube player API, no key: ANDROID, then IOS (`YOUTUBE_CLIENTS`, `YOUTUBE_ANDROID_VERSION`, `YOUTUBE_IOS_VERSION`). Datacenter IPs may be blocked (`blocked` error); run locally or behind a tunnel. See [guides/youtube.md](guides/youtube.md#captions-and-blocks). |
| `youtube` (comments) | top or newest comments with pinned and creator flags, likes, approximate dates and a few replies per thread | always, when comments are requested | innertube `next` with the WEB client, no key. `YOUTUBE_COMMENT_REPLIES` (default 5, 0 turns replies off), `YOUTUBE_COMMENTS_SORT` (`top` or `newest`), `YOUTUBE_WEB_VERSION` (WEB client version, shared with metadata and browse). See [guides/youtube.md](guides/youtube.md#comments). |
| `youtube` (lists) | playlists, channels (all uploads or a tab: videos, shorts, streams, playlists, featured) and `ytsearch:` searches expanded to video refs, plus list metadata | always, for `listItems` and list refs | innertube `browse`, `search` and `navigation/resolve_url` with the WEB client, no key. Search defaults to 20 results, max 200. `YOUTUBE_WEB_VERSION` (shared with comments). See [guides/youtube.md](guides/youtube.md#playlists-channels-and-search). |
| `youtube-captions` | creator captions, auto-captions, YouTube translation (`tlang`); srv3, srv1, json3 and WebVTT payloads | always | Same clients and fallback as `youtube`. Backoff on 429 and 5xx; after a block, YouTube calls pause for `YOUTUBE_BLOCK_COOLDOWN_SEC` (default 600). Optional `YOUTUBE_COOKIE`, `YOUTUBE_PO_TOKEN`, `YOUTUBE_VISITOR_DATA`. A GCP VM was blocked on timedtext (HTTP 429) on 2026-11-14 while the player API still answered. See [guides/youtube.md](guides/youtube.md#captions-and-blocks). |
| `media-file` | local files and `file://` URLs (Node only) | always | metadata from the filesystem; audio bytes for speech-to-text |
| `ytdlp` | catch-all for any http(s) URL (Vimeo, TikTok, X, Reddit, Twitch, TED, ...): metadata, playlists, comments, 16 kHz mono mp3 audio; also audio for YouTube refs (Node only) | always | yt-dlp is found (`YTDLP_PATH`, `PATH`) or installed into `.vid2context/bin/` from the official release with SHA-256 verification, updated weekly (`YTDLP_AUTO_UPDATE=0` disables). Audio needs ffmpeg (`FFMPEG_PATH`). Also `YTDLP_TIMEOUT_SEC`, `YTDLP_CONCURRENCY` (default 2), `YTDLP_COOKIES_FILE`, `YTDLP_COOKIES_FROM_BROWSER`. See [guides/ytdlp.md](guides/ytdlp.md). |
| `ytdlp-captions` | creator subtitles and automatic captions through yt-dlp (Node only) | always | runs after `youtube-captions` for YouTube. YouTube subtitle downloads through yt-dlp were rate-limited (HTTP 429) from a GCP VM on 2026-11-14; `vimeo.com/<id>` pages wanted a login there, so the provider retries through `player.vimeo.com`. |

## Speech-to-text (`stt-openai-compatible`)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `stt/local/<model>` | local | `LOCAL_STT_BASE_URL` + `LOCAL_STT_MODEL` (optional `LOCAL_STT_API_KEY`) | any OpenAI-compatible server: speaches or faster-whisper-server (`http://localhost:8000/v1`), LocalAI (`http://localhost:8080/v1`). See [guides/speech-to-text.md](guides/speech-to-text.md). |
| `stt/groq/whisper-large-v3-turbo` | free | `GROQ_API_KEY` (+ `GROQ_FALLBACK_KEYS`) | real free tier: 25 MB per file, 224-token prompt, word timestamps (docs checked 2026-11-14). Base limits 20 requests/min, 2,000/day, 7,200 audio seconds/hour; your plan's limits at console.groq.com/settings/limits. Verified: endpoint and error shape (no-key 401 recorded); no key was available for a live transcription. |
| `stt/mistral/voxtral-mini-transcribe-3` | free | `MISTRAL_API_KEY` (+ `MISTRAL_FALLBACK_KEYS`) | Experiment plan (free, rate limited, may train on your data). Segments only, no word timestamps; the prompt is sent as `context_bias`. **Unverified live**: request format from Mistral's docs 2026-11-14, endpoint confirmed by a recorded no-key 401. |
| `stt/ovh/whisper-large-v3-turbo` | keyless | none | about 2 requests per minute per IP (`x-ratelimit-limit-minute: 2`, 2026-11-14); a 429 cools the rung down for at least 30 s. Word timestamps verified live. File needs a real audio extension. |
| `stt/deepinfra/openai/whisper-large-v3-turbo` | paid | `DEEPINFRA_API_KEY` (+ `DEEPINFRA_FALLBACK_KEYS`, `DEEPINFRA_BASE_URL`) | about $0.0002 per audio minute (model list, 2026-11-14); no free tier. Upload limit not published. **Unverified live**: endpoint confirmed by a recorded no-key 401. |
| `stt/together/openai/whisper-large-v3` | paid | `TOGETHER_API_KEY` (+ `TOGETHER_FALLBACK_KEYS`, `TOGETHER_BASE_URL`) | 80 MB per direct upload, word timestamps (docs 2026-11-14); no free tier. **Unverified live**: endpoint confirmed by a recorded no-key 401. |
| `stt/openai/whisper-1` | paid | `OPENAI_API_KEY` (+ `OPENAI_FALLBACK_KEYS`, `OPENAI_BASE_URL`) | 25 MB per file, word timestamps |

Model overrides: `GROQ_STT_MODEL`, `MISTRAL_STT_MODEL`, `OVH_STT_MODEL`, `DEEPINFRA_STT_MODEL`, `TOGETHER_STT_MODEL`, `OPENAI_STT_MODEL`. OVH also serves `whisper-large-v3`. Not added (checked 2026-11-14): Fireworks (audio inference deprecated 2026-06-10; its turbo host answered 503), SambaNova (no Whisper model in its public model list).

## Speech-to-text (`stt-whisper-cpp`, Node only)

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `stt/whisper-cpp/<model>` | local | `WHISPER_CPP_MODEL` (a model name or a path to a ggml `.bin`) | Runs on this machine: no limits, nothing leaves it. `npx tsx providers/stt-whisper-cpp/src/setup.ts` installs whisper.cpp (official prebuilt binary, SHA-256 checked, or a CMake build with CUDA or Metal), downloads a model verified against Hugging Face's published SHA-256, and prints the env lines. Ordered before other local rungs when `WHISPER_CPP_GPU=1`, after them otherwise. Optional: `WHISPER_CPP_BIN`, `WHISPER_CPP_THREADS`, `WHISPER_CPP_SERVER=1` (managed whisper-server keeps the model loaded), `WHISPER_CPP_SERVER_URL` (existing server). Needs ffmpeg (`FFMPEG_PATH`). Measured 2026-11-14 on a 31-thread CPU VM (no GPU), 24 s clip: base.en about 25x realtime, small about 5x. See [guides/whisper-cpp.md](guides/whisper-cpp.md). |

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

## LLMs: free catalog (`llm-free-catalog`)

More free lanes on top of `llm-openai-compatible`. "Verified live" means a real request answered from this project's VM on that date; the other rows follow the service's docs and public model list but have not answered a real request with a key yet.

| Rung id | Tier | Enabled by | Free limits and notes | Verified |
|---|---|---|---|---|
| `llm/kilo/nvidia/nemotron-3-ultra-550b-a55b:free` | keyless | none | Kilo Code gateway, about 200 requests per hour; JSON mode. Runs before OVH and Pollinations | live, 2026-11-14 |
| `llm/kilo/nvidia/nemotron-3.5-super-vl:free` | keyless | none | separate model quota on the same gateway | live, 2026-11-14 |
| `llm/kilo/nvidia/nemotron-3.5-lightning:free` | keyless | none | smaller and faster; JSON mode | live, 2026-11-14 |
| `llm/nvidia/nvidia/nemotron-3-super-120b-a12b` | free | `NVIDIA_API_KEY` | free NIM tier, can queue under load (45 s lane timeout); thinking turned off | id in the public NIM list 2026-11-14; not verified live |
| `llm/sambanova/Meta-Llama-3.3-70B-Instruct` | free | `SAMBANOVA_API_KEY` | about 20 requests per minute and 200k tokens per day per model; output capped at 3072 tokens | id and cap in the public model list 2026-11-14; not verified live |
| `llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | free | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` | 10,000 neurons per day per account (a short answer costs about 2 to 5); 24k-token context; JSON and JSON Schema | live, 2026-11-14 |
| `llm/zhipu/glm-4.7-flash` | free | `ZHIPU_API_KEY` | permanently free Flash tier, rate limited; thinking turned off | not verified live |
| `llm/siliconflow/Qwen/Qwen3-8B` | free | `SILICONFLOW_API_KEY` | free model on SiliconFlow; an 8B step-down, tried late; thinking turned off | not verified live |

- Keys: every lane takes `<PROVIDER>_FALLBACK_KEYS` (`KILO_`, `NVIDIA_`, `SAMBANOVA_`, `ZHIPU_`, `SILICONFLOW_`). `CLOUDFLARE_FALLBACK_KEYS` entries are a token for the same account or `<account_id>:<token>` for another account (each account has its own neuron allocation).
- Models: `KILO_MODEL`, `NVIDIA_MODEL`, `SAMBANOVA_MODEL`, `CLOUDFLARE_MODEL`, `ZHIPU_MODEL`, `SILICONFLOW_MODEL` replace the defaults (comma-separated).
- Endpoints: `KILO_BASE_URL`, `NVIDIA_BASE_URL`, `SAMBANOVA_BASE_URL`, `ZHIPU_BASE_URL` (`https://open.bigmodel.cn/api/paas/v4` for the mainland endpoint), `SILICONFLOW_BASE_URL` (`https://api.siliconflow.cn/v1` for mainland).
- `KILO_API_KEY` is optional: with it Kilo becomes a free-tier rung (raised limits). A Kilo model id without `:free` used with a key is tier `paid`, since it could bill the account.
- Not added: extra Groq or Cerebras rungs. Groq's model list needs a key. Cerebras's public list (2026-11-14) shows `gpt-oss-120b` and `qwen-3.8-27b` but no longer `llama-3.3-70b`, and its free-tier coverage cannot be checked without a key.

## LLMs: OpenRouter (`llm-openrouter`)

| Rung id | Tier | Enabled by | Notes |
|---|---|---|---|
| `llm/openrouter/free-auto` | free | `OPENROUTER_API_KEY` (+ `OPENROUTER_FALLBACK_KEYS`) | picks the best live `:free` model from `GET /api/v1/models` (cached one hour) and tries up to 3 candidates when one is retired, rate limited or failing. 14 free models listed on 2026-11-14. The catalog was read live; chat not verified live (no key) |
| `llm/openrouter/<model>` | free if the id ends in `:free`, else paid | `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` | explicit model ids, comma-separated |

`OPENROUTER_BASE_URL` overrides `https://openrouter.ai/api/v1`. Free models allow about 20 requests per minute and a small daily cap (larger once the account has bought credits); see openrouter.ai/docs.

Check what answers today: `npm run check:llm` (see [guides/llm.md](guides/llm.md)).

## Chain controls
## Embeddings (`embed`, `embed-transformers`)

Guide, dimensions and the one-model-per-index rule: [guides/embeddings.md](guides/embeddings.md). "Live" means verified against the real service on 2026-11-14; "docs" means built from the provider's current documentation without a key.

| Rung id | Tier | Enabled by | Free limits and notes |
|---|---|---|---|
| `embed/ollama/<model>` | local | `OLLAMA_EMBED_MODEL` (`OLLAMA_BASE_URL`, default `http://localhost:11434/v1`) | `/v1/embeddings`; for example `bge-m3` or `nomic-embed-text`. Docs |
| `embed/lmstudio/<model>` | local | `LMSTUDIO_EMBED_MODEL` (`LMSTUDIO_BASE_URL`) | docs |
| `embed/local/<model>` | local | `LOCAL_EMBED_BASE_URL` + `LOCAL_EMBED_MODEL` (optional `LOCAL_EMBED_API_KEY`) | any OpenAI-compatible `/embeddings` server. Docs |
| `embed/transformers/<model>` | local | `TRANSFORMERS_EMBED_MODEL`, for example `Xenova/multilingual-e5-small` | Node and browser only; 384 dimensions; 118 MB download into `.vid2context/models`. Live (Node) |
| `embed/gemini/gemini-embedding-2` | free | `GEMINI_API_KEY` (+ `GEMINI_FALLBACK_KEYS`) | AI Studio free tier; 3072 dimensions. Not verified live (no key) |
| `embed/jina/jina-embeddings-v3` | free | `JINA_API_KEY` (+ `JINA_FALLBACK_KEYS`) | free key with a token allowance, 100 requests and 100K tokens per minute. Not verified live (no key) |
| `embed/cloudflare/@cf/baai/bge-m3` | free | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Workers AI REST, 10,000 neurons per day free (8 sentences cost 0.28 neurons). Tokens are not pooled. Live |
| `embed/mistral/mistral-embed` | free | `MISTRAL_API_KEY` (+ `MISTRAL_FALLBACK_KEYS`) | Experiment plan; 1024 dimensions. Not verified live (no key) |
| `embed/ovh/bge-m3` | keyless | none | 2 requests per minute per model per IP, 25 inputs per request, 8192 tokens per input. Live |
| `embed/ovh/Qwen3-Embedding-8B` | keyless | none | separate quota; 4096 dimensions. Live |
| `embed/openai/text-embedding-3-small` | paid | `OPENAI_API_KEY` (+ `OPENAI_FALLBACK_KEYS`, `OPENAI_BASE_URL`) | 1536 dimensions. Docs |

Model overrides: `OLLAMA_EMBED_MODEL`, `LMSTUDIO_EMBED_MODEL`, `LOCAL_EMBED_MODEL`, `TRANSFORMERS_EMBED_MODEL`, `GEMINI_EMBED_MODEL`, `JINA_EMBED_MODEL`, `CLOUDFLARE_EMBED_MODEL`, `MISTRAL_EMBED_MODEL`, `OVH_EMBED_MODEL`, `OPENAI_EMBED_MODEL`. `VID2CONTEXT_EMBED_MODEL` (a rung id such as `embed/ovh/bge-m3`) fixes the model new indexes use.


| Env var | Effect |
|---|---|
| `VID2CONTEXT_POLICY` | `free` (default), `local-only` (nothing leaves the machine) or `quality` |
| `VID2CONTEXT_ALLOW_PAID=0` | never use paid rungs, even with a key |
| `VID2CONTEXT_KEYLESS=0` | turn off keyless rungs (they send data to third parties without an account) |
| `VID2CONTEXT_SKIP=svc1,svc2` | drop rungs by id, service or provider, e.g. `pollinations,ovh` |
| `VID2CONTEXT_LOG_LEVEL` | `debug`, `info`, `warn` (default), `error`, `silent`; logs go to stderr |
| `VID2CONTEXT_LOG_FORMAT=json` | one JSON object per log line, with `trace_id` and `span_id` inside a span |
| `VID2CONTEXT_MAX_PAID_USD_PER_DAY` | per process and UTC day: skip paid rungs (reason `budget`) once estimated spend reaches it; needs telemetry ([observability.md](observability.md)) |
| `VID2CONTEXT_PRICE_<RUNG_ID>` | price used to estimate paid spend: `in,out` USD per million tokens, or USD per audio minute |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and other `OTEL_*` | OpenTelemetry export of traces and metrics; see [observability.md](observability.md) |
| `VID2CONTEXT_ENV_FILE` | an env file to load before `./.env` (shell variables always win) |
| `VID2CONTEXT_CONFIRM_STT_MINUTES` | MCP: ask the user (elicitation) before speech-to-text on audio at least this many minutes long; default 20, `0` always asks; clients without elicitation get no question (`@vid2context/mcp-agentic`) |

## Library storage

The library (saved contexts, collections, search, key-value state, vectors) uses the enabled storage backend with the lowest priority. Guide: [guides/library-sqlite.md](guides/library-sqlite.md).

| Priority | Backend | Runtime | Enabled when |
|---|---|---|---|
| lower than 50 | Postgres (`storage-postgres`) | node | a database URL is set (see that provider's rows) |
| 50 | SQLite (`storage-sqlite`), FTS5 search, one local file | node (22.13+) | by default, unless `VID2CONTEXT_STORAGE` names another backend |
| none | in-process `MemoryStorage`, lost on exit | any | no backend is enabled, or `VID2CONTEXT_STORAGE=memory` |

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_STORAGE` | storage providers | pick one backend: `sqlite`, `postgres`, `cloudflare`, or `memory` (no persistent backend). Unset: the priority order above |
| `VID2CONTEXT_DB` | `storage-sqlite` | path of the SQLite file, or `:memory:`; default `<VID2CONTEXT_HOME>/library.db` |
| `VID2CONTEXT_HOME` | `storage-sqlite` and other local data | data directory; default `.vid2context` in the working directory |
| `VID2CONTEXT_DB_BUSY_TIMEOUT_MS` | `storage-sqlite` | how long a write waits for another process holding the file; default 5000 |

## Security and limits

See [security/hardening.md](security/hardening.md) and [security/threat-model.md](security/threat-model.md).

| Env var | Effect |
|---|---|
| `VID2CONTEXT_PUBLIC=1` | public mode: refuse local file paths, `file://` and URLs pointing at private, loopback, link-local or cloud metadata addresses |
| `VID2CONTEXT_MAX_INPUT_CHARS` | longest input accepted in public mode (default 2048) |
| `VID2CONTEXT_MAX_PLAYLIST_ITEMS` | most videos expanded from one playlist, channel or feed (default 500) |
| `VID2CONTEXT_MAX_UPLOAD_MB` | largest upload to the HTTP API or web app (default 200) |
| `VID2CONTEXT_MAX_AUDIO_MB` | largest audio download or file read for speech-to-text (default 1024) |
| `VID2CONTEXT_MAX_SEGMENTS` | most transcript segments kept from one source (default 200000) |
| `VID2CONTEXT_FETCH_TIMEOUT_MS` | default timeout for one outbound request through `safeFetch` (default 30000) |

## Exports

| Env var | Used by | Notes |
|---|---|---|
| `NOTION_TOKEN` | `@vid2context/exporters` (`export_notion`, `POST /exports/notion`) | secret of an internal integration (free) from https://www.notion.so/profile/integrations; share the parent page with it (page menu, Connections). Requests are paced to about 3 per second and use `Notion-Version: 2026-03-11` |
| `NOTION_PARENT_PAGE_ID` | `@vid2context/exporters` | id or link of the Notion page the video pages go under; a per-call `parentPageId` wins |

Obsidian exports need no variable: they are local files.

## Client libraries

Read by the Python client in `clients/python` (and its LangChain and LlamaIndex loaders), not by the server. The LangChain.js loader in `packages/langchain` takes the same values as `baseUrl` and `apiKey` options instead of reading the environment.

| Env var | Effect |
|---|---|
| `VID2CONTEXT_API_URL` | vid2context server the client calls; default `http://127.0.0.1:8787` |
| `VID2CONTEXT_API_KEY` | sent as `Authorization: Bearer <key>` when the server sets `VID2CONTEXT_API_KEYS` |

## Content filters

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_SPONSORBLOCK` | `@vid2context/skips` (`get_skip_segments`, `GET /skips`, `skip=`) | `0` turns SponsorBlock lookups off. SponsorBlock is free and keyless; only a 4-character hash prefix of the video id is sent. Data is CC BY-NC-SA 4.0: non-commercial, with attribution |
| `SPONSORBLOCK_API_URL` | `@vid2context/skips` | base URL of a self-hosted SponsorBlock mirror, default `https://sponsor.ajay.app`. Lookups time out after 5 seconds |
| `VID2CONTEXT_SKIP_CATEGORIES` | `@vid2context/skips` | default categories, comma-separated; default `sponsor,selfpromo,interaction,intro,outro,preview,filler` |

## Hosted mode

Accounts, quotas, a shared transcript cache and abuse protection for a public instance, from `@vid2context/accounts`. Everything is off unless `VID2CONTEXT_HOSTED=1`. GitHub OAuth and Cloudflare Turnstile are free. See `packages/accounts/README.md`.

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_HOSTED` | `@vid2context/accounts` | `1` turns on sign-in, sessions, API keys, plans and the per-IP limiter for every route under `/api/v1` except `/health`, `/auth/*` and `/bots/*` |
| `VID2CONTEXT_SESSION_SECRET` | `@vid2context/accounts` | required in hosted mode, 32 characters or more: signs session cookies and keys the IP hashes. Changing it signs everyone out |
| `VID2CONTEXT_SESSION_TTL_DAYS` | `@vid2context/accounts` | session lifetime, default `30` |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | `@vid2context/accounts` | a GitHub OAuth app; the scope is empty, so only the numeric id, login and avatar are read, never an email |
| `GITHUB_OAUTH_REDIRECT_URI` | `@vid2context/accounts` | exact callback URL registered on the app, when a proxy changes the host or scheme; default `<request origin>/api/v1/auth/github/callback` |
| `VID2CONTEXT_PLANS` | `@vid2context/accounts` | JSON of daily limits per plan (`requestsPerDay`, `sttMinutesPerDay`, `llmCallsPerDay`, `maxCollectionSize`); defaults `free` 500, 60, 100, 200 and `anonymous` 50, 10, 10, 25 |
| `VID2CONTEXT_DEFAULT_PLAN` | `@vid2context/accounts` | plan for new accounts, default `free` |
| `VID2CONTEXT_ANONYMOUS` | `@vid2context/accounts` | `1` serves callers without a session or key on the `anonymous` plan, counted per IP |
| `TURNSTILE_SECRET` | `@vid2context/accounts` | Cloudflare Turnstile secret key; anonymous requests that can start speech-to-text must send a token in `X-Turnstile-Token`. Unset with anonymous on: those requests are refused |
| `VID2CONTEXT_SHARED_CACHE_TTL_DAYS` | `@vid2context/accounts` | how long a public video's transcript is shared across users, default `30` |
| `VID2CONTEXT_SHARED_CACHE_PLATFORMS` | `@vid2context/accounts` | platforms whose videos are shared, comma-separated, default `youtube`. Files and uploads are never shared |
| `VID2CONTEXT_IP_BURST`, `VID2CONTEXT_IP_PER_MINUTE` | `@vid2context/accounts` | per-IP token bucket in front of every guarded route, default `60` burst and `120` per minute. On Workers also a soft KV window (eventually consistent) |
| `VID2CONTEXT_IP_HEADER` | `@vid2context/accounts` | header with the client IP behind a trusted proxy, for example `x-forwarded-for` (its last address is used). Workers use `CF-Connecting-IP` |
| `VID2CONTEXT_POST_LOGIN_PATH` | `@vid2context/accounts` | where the browser lands after sign-in when no `return_to` is given, default `/app/` |

## Webhooks

Outbound, signed Standard Webhooks from `@vid2context/webhooks` (`GET/POST /webhooks`, `DELETE /webhooks/:id`, `POST /webhooks/:id/test`). No key or service needed. See `packages/webhooks/README.md`.

| Env var | Used by | Notes |
|---|---|---|
| `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL` | `@vid2context/webhooks` | `1` allows `http:` targets and hosts on loopback or private networks (self-hosted n8n). Default off: public `https:` only. Link-local and cloud metadata addresses are always refused |
| `VID2CONTEXT_WEBHOOKS_BASE_URL` | `@vid2context/webhooks` | public base URL of the API, so payload links are absolute; unset, links are `/api/v1/...` paths |

## Bots

Telegram, Discord and Slack bots from `@vid2context/bots` (`POST /bots/telegram`, `/bots/discord`, `/bots/slack/events`, `/bots/slack/commands`). All three platforms are free for bots; the summary uses the LLM chain above. A platform is on only when its secrets are set. Setup steps: `packages/bots/README.md`.

| Env var | Used by | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | `@vid2context/bots` | both turn the Telegram route on; the secret is checked against `X-Telegram-Bot-Api-Secret-Token` |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | `@vid2context/bots` | both turn the Discord route on; the public key verifies Ed25519 signatures |
| `DISCORD_BOT_TOKEN` | `packages/bots` setup script | registers the `/video` command; the server does not need it |
| `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` | `@vid2context/bots` | both turn the Slack routes on; `xoxb-` token with `commands`, `chat:write`, `files:write`, `app_mentions:read`, `im:history` |
| `BOTS_PUBLIC_BASE_URL` | `packages/bots` setup scripts | public HTTPS origin of the server; the scripts add `/api/v1/bots/...` |
| `BOTS_ALLOWED_CHATS`, `BOTS_ALLOWED_GUILDS`, `BOTS_ALLOWED_TEAMS` | `@vid2context/bots` | optional comma-separated Telegram chat, Discord server and Slack team ids; unset serves everyone |
| `BOTS_RATE_LIMIT_PER_HOUR` | `@vid2context/bots` | videos per hour per chat and per user, default `10`, held in memory per instance |

## Planned (see ROADMAP.md)

| Kind | Provider | Tier | Enabled by | Known limits |
|---|---|---|---|---|
| llm | Anthropic `claude-haiku-4-5-20251001`, native | paid | `ANTHROPIC_API_KEY` | |
| stt | whisper.cpp, Transformers.js, Workers AI Whisper, Gemini, Deepgram, AssemblyAI | local / free | per prompt | |
| video | Gemini video understanding | free | `GEMINI_API_KEY` | |
